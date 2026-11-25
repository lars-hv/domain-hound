// Candidate domains for the person to confirm: from project files the agent points at, and from the person's own
// Spaceship account when a key is configured. Only a fixed list of public project files is opened (never .env or any
// other secret file), nothing is stored, and the Spaceship call is the read-only domain list.
import { lstat, open, readdir } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { safeUrl } from '../domain-check/safe-web.mjs';
import { isLoopback, spaceshipBase, spaceshipCredentials } from '../spaceship/client.mjs';
import { portfolioDomain } from './store.mjs';

// The only files discovery reads. Matching is on the exact name, so .env, .env.local, keys and configs with secrets
// are never opened.
export const projectFiles = ['CNAME', 'package.json', 'wrangler.toml', 'wrangler.json', 'wrangler.jsonc', 'vercel.json',
  'netlify.toml', 'README.md', 'readme.md', 'Readme.md', 'README'];
const strongFiles = new Set(['CNAME', 'package.json', 'wrangler.toml', 'wrangler.json', 'wrangler.jsonc', 'vercel.json', 'netlify.toml']);
const skipDirs = new Set(['node_modules', 'dist', 'build', 'out', 'vendor', 'coverage', 'target', 'tmp', 'cache']);
const maxFileBytes = 256 * 1024;
const maxDirsPerPath = 60;
export const maxPaths = 10;
export const maxCandidates = 40;

// Hosted subdomains and well-known third-party sites are not the person's own domains.
const hostedSuffixes = ['github.io', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app', 'herokuapp.com', 'web.app',
  'firebaseapp.com', 'fly.dev', 'onrender.com', 'azurewebsites.net', 'cloudfront.net', 'amazonaws.com', 'appspot.com',
  'glitch.me', 'replit.app', 'surge.sh', 'gitlab.io', 'readthedocs.io', 'blogspot.com', 'wordpress.com', 'substack.com'];
const thirdParty = new Set(['github.com', 'githubusercontent.com', 'npmjs.com', 'npmjs.org', 'shields.io', 'badgen.net',
  'twitter.com', 'x.com', 'linkedin.com', 'youtube.com', 'youtu.be', 'google.com', 'apple.com', 'microsoft.com',
  'mozilla.org', 'wikipedia.org', 'stackoverflow.com', 'anthropic.com', 'claude.ai', 'claude.com', 'openai.com',
  'vercel.com', 'netlify.com', 'cloudflare.com', 'nodejs.org', 'modelcontextprotocol.io', 'example.com', 'example.org',
  'example.net', 'w3.org', 'json-schema.org', 'schema.org', 'opensource.org', 'creativecommons.org', 'gitlab.com',
  'bitbucket.org', 'discord.gg', 'discord.com', 'medium.com', 'docker.com', 'python.org', 'pypi.org', 'unpkg.com',
  'jsdelivr.net', 'reddit.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'spaceship.com', 'spaceship.dev',
  'godaddy.com', 'namecheap.com', 'porkbun.com', 'dynadot.com', 'gandi.net', 'iana.org', 'icann.org', 'ietf.org',
  'rfc-editor.org', 'mit-license.org', 'chromewebstore.google.com', 'gstatic.com', 'googleapis.com', 'readme.com']);
const twoLevel = new Set(['co.uk', 'org.uk', 'ac.uk', 'com.au', 'net.au', 'co.nz', 'co.jp', 'com.br', 'co.za', 'com.mx']);

// The registrable domain of a host, if it can be the person's own.
export function ownDomain(host) {
  const value = portfolioDomain(host);
  if (!value) return null;
  const labels = value.split('.');
  const keep = twoLevel.has(labels.slice(-2).join('.')) ? 3 : 2;
  const domain = labels.slice(-keep).join('.');
  if (hostedSuffixes.some(suffix => value === suffix || value.endsWith('.' + suffix)) || thirdParty.has(domain)) return null;
  return portfolioDomain(domain);
}

const urlHosts = text => [...String(text).matchAll(/\bhttps?:\/\/[^\s<>"'`\])},]+/gi)]
  .map(([url]) => safeUrl(url)?.hostname).filter(Boolean);

// Domains named in one project file, by its kind.
export function domainsInFile(name, text) {
  if (name === 'CNAME') return String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 1);
  if (name === 'package.json') {
    try {
      const data = JSON.parse(text);
      return typeof data?.homepage === 'string' ? urlHosts(data.homepage) : [];
    } catch {
      return [];
    }
  }
  if (name.startsWith('wrangler.')) {
    // Routes and custom domains only: other strings in the file (main = "src/index.ts") look like hosts too.
    return String(text).split(/\r?\n/).filter(line => /\b(?:pattern|zone_name|routes?|custom_domain|domains?)\b/i.test(line))
      .flatMap(line => [...line.matchAll(/["']([a-z0-9*.-]+\.[a-z]{2,63})(?:\/[^"']*)?["']/gi)].map(match => match[1].replace(/^\*\.?/, '')));
  }
  if (name === 'vercel.json') {
    let aliases = [];
    try {
      const data = JSON.parse(text);
      aliases = (Array.isArray(data?.alias) ? data.alias : [data?.alias]).filter(value => typeof value === 'string');
    } catch { /* URLs below still count */ }
    return [...aliases, ...urlHosts(text)];
  }
  return urlHosts(text);
}

async function readSmallFile(path) {
  const info = await lstat(path).catch(() => null);
  // Regular files only: a symlink could point anywhere on the machine.
  if (!info?.isFile() || info.size > maxFileBytes) return null;
  const handle = await open(path, 'r');
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function projectDirs(root) {
  const dirs = [root];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (dirs.length >= maxDirsPerPath) break;
    if (entry.isDirectory() && !entry.name.startsWith('.') && !skipDirs.has(entry.name)) dirs.push(join(root, entry.name));
  }
  return dirs;
}

// Candidates from the project folders the agent points at (the server's working folder when none are given).
export async function projectCandidates(paths = [process.cwd()]) {
  const found = new Map();
  for (const path of paths.slice(0, maxPaths)) {
    const root = resolve(path);
    const info = await lstat(root).catch(() => null);
    if (!info?.isDirectory()) continue;
    for (const dir of await projectDirs(root)) {
      // Names as the folder lists them, so a case-insensitive disk never reads one file twice.
      const names = (await readdir(dir).catch(() => [])).filter(name => projectFiles.includes(name));
      for (const name of names) {
        const text = await readSmallFile(join(dir, name)).catch(() => null);
        if (text == null) continue;
        // Shown as the project folder's name and the file inside it, never as an absolute path.
        const where = [basename(root), relative(root, join(dir, name))].join('/').replaceAll('\\', '/');
        for (const host of domainsInFile(name, text)) {
          const domain = ownDomain(host);
          if (!domain) continue;
          if (!found.has(domain)) found.set(domain, { domain, sources: [], strong: false });
          const row = found.get(domain);
          if (row.sources.length < 3 && !row.sources.includes(where)) row.sources.push(where);
          row.strong ||= strongFiles.has(name);
        }
      }
    }
  }
  // Deployment files first, then README links.
  return [...found.values()].sort((a, b) => Number(b.strong) - Number(a.strong) || a.domain.localeCompare(b.domain))
    .slice(0, maxCandidates);
}

// The person's domains at Spaceship (listDomains, read-only, needs only domains:read). The key never leaves this
// function except in the request headers to Spaceship.
export async function spaceshipDomains({ credentials = () => spaceshipCredentials(), fetcher = globalThis.fetch,
  baseUrl = spaceshipBase, timeout = 6000 } = {}) {
  const base = baseUrl.replace(/\/+$/, '');
  if (base !== spaceshipBase && !isLoopback(base)) return { state: 'unknown', reason: 'Spaceship API base must be ' + spaceshipBase };
  let keys;
  try {
    keys = await credentials();
  } catch {
    keys = null;
  }
  if (!keys?.key || !keys?.secret) return { state: 'not-connected' };
  const domains = [];
  let read = 0;
  for (let page = 0; page < 10; page++) {
    let response;
    try {
      response = await fetcher(base + '/v1/domains?' + new URLSearchParams({ take: '100', skip: String(read) }), {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeout),
        headers: { 'X-API-Key': keys.key, 'X-API-Secret': keys.secret, Accept: 'application/json' },
      });
    } catch {
      return { state: 'unknown', reason: 'Spaceship did not answer in time', domains };
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel?.().catch(() => {});
      return { state: 'unknown', reason: 'Spaceship refused the API key or its scope (the list needs domains:read)', domains };
    }
    if (response.status !== 200) {
      await response.body?.cancel?.().catch(() => {});
      return { state: 'unknown', reason: 'Spaceship answered HTTP ' + response.status, domains };
    }
    const json = await response.json().catch(() => null);
    const items = Array.isArray(json?.items) ? json.items : null;
    if (!items || !Number.isInteger(json.total) || items.length > 100 || json.total < read + items.length
      || (!items.length && read < json.total)) return { state: 'unknown', reason: 'Spaceship returned an incomplete list', domains };
    read += items.length;
    for (const item of items) {
      const domain = portfolioDomain(item?.name);
      if (domain && !domains.includes(domain)) domains.push(domain);
    }
    if (read === json.total) return { state: 'ok', domains };
  }
  return { state: 'unknown', reason: 'Only the first 1,000 Spaceship entries were checked', domains };
}
