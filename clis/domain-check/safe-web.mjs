// Outbound HTTP for untrusted websites (a taken domain's own site and wherever it redirects). Every hop is checked
// before it is fetched: http or https on the default port, a public DNS name (never an IP literal, credentials or a
// local suffix), and an address that resolves to the public internet. Bodies are capped and only read as HTML.
// Nothing read here is passed on as text: callers keep only classifications, hosts and sanitized URLs.
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { isIP } from 'node:net';
import { lookupPublic } from './com-site.mjs';

export const maxPageBytes = 200_000;
export const maxHops = 5;
const hostLabel = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const localSuffixes = ['localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'corp', 'home.arpa', 'onion',
  'test', 'invalid', 'arpa'];

// A URL safe to request, or null. Relative values resolve against base (a redirect Location).
export function safeUrl(value, base) {
  if (typeof value !== 'string' && !(value instanceof URL)) return null;
  const text = String(value);
  if (text.length > 2048 || /[\u0000-\u001f\u007f\s\\]/.test(text.trim())) return null;
  let url;
  try { url = new URL(text.trim(), base); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (!host || host.length > 253 || isIP(host) || host.startsWith('[')) return null;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every(part => hostLabel.test(part)) || /^\d+$/.test(labels.at(-1))) return null;
  if (localSuffixes.some(suffix => host === suffix || host.endsWith('.' + suffix))) return null;
  url.hash = '';
  return url;
}

// Leave tracking parameters and other private values out of evidence.
export function evidenceUrl(value) {
  const url = safeUrl(value);
  if (!url) return null;
  const text = url.origin + url.pathname;
  return text.length <= 300 ? text : url.origin + '/';
}

export const hostMatches = (host, suffixes) => Boolean(host) && suffixes.some(suffix => host === suffix || host.endsWith('.' + suffix));

const userAgent = 'DomainHound (+https://domainhound.dev; read-only domain dossier)';

// One request without following redirects. Keep only bounded HTML or crawl rules.
function requestPage(url, signal, robots = false) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('timed out'));
    const get = url.protocol === 'https:' ? httpsGet : httpGet;
    const request = get(url, {
      lookup: lookupPublic(signal), signal, agent: false,
      headers: { accept: robots ? 'text/plain' : 'text/html, application/xhtml+xml',
        'user-agent': userAgent, 'accept-encoding': 'identity' },
    }, response => {
      const status = response.statusCode;
      const contentType = String(response.headers['content-type'] ?? '');
      const location = [301, 302, 303, 307, 308].includes(status) && typeof response.headers.location === 'string'
        ? response.headers.location : null;
      const encoded = !/^(?:identity)?$/i.test(String(response.headers['content-encoding'] ?? '').trim());
      if (location || !(status >= 200 && status < 300) || encoded
        || (!robots && !/^(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType))) {
        response.destroy();
        resolve({ status, contentType, location });
        return;
      }
      const chunks = [];
      let size = 0;
      let done = false;
      const finish = (truncated = false) => {
        if (done) return;
        done = true;
        const body = robots && truncated ? undefined : Buffer.concat(chunks).toString('utf8');
        resolve({ status, contentType, body, truncated });
      };
      response.on('data', chunk => {
        const part = chunk.subarray(0, maxPageBytes - size);
        chunks.push(part);
        size += part.length;
        if (size >= maxPageBytes) {
          finish(true);
          response.destroy();
        }
      });
      response.on('end', () => finish());
      response.on('error', error => done ? undefined : reject(error));
    });
    request.on('error', reject);
  });
}

function ruleMatches(pattern, path) {
  const anchored = pattern.endsWith('$');
  const [prefix, ...rest] = (anchored ? pattern.slice(0, -1) : pattern).split('*');
  if (!path.startsWith(prefix)) return false;
  if (!rest.length) return !anchored || path === prefix;
  const suffix = anchored ? rest.pop() : '';
  if (anchored && !path.endsWith(suffix)) return false;
  let position = prefix.length;
  for (const part of rest) {
    const next = path.indexOf(part, position);
    if (next === -1) return false;
    position = next + part.length;
  }
  return position + suffix.length <= path.length;
}

export function robotsAllow(body, path) {
  const groups = [];
  let group = { agents: [], rules: [] };
  for (const line of body.split('\n')) {
    const [key, value] = line.split('#', 1)[0].split(/:(.*)/s, 2).map(part => part.trim());
    const field = key.toLowerCase();
    if (field === 'user-agent' && value) {
      if (group.rules.length) group = { agents: [], rules: [] };
      if (!group.agents.length) groups.push(group);
      group.agents.push(value.toLowerCase());
    } else if (group.agents.length && ['allow', 'disallow'].includes(field)) {
      group.rules.push({ allow: field === 'allow', pattern: value ?? '' });
    }
  }
  const agent = groups.some(row => row.agents.includes('domainhound')) ? 'domainhound' : '*';
  let best = { length: -1, allow: true };
  for (const { agents, rules } of groups) {
    if (!agents.includes(agent)) continue;
    for (const { allow, pattern } of rules) {
      if (!pattern.startsWith('/') || !ruleMatches(pattern, path)) continue;
      const length = pattern.replace(/[\*$]/g, '').length;
      if (length > best.length || (length === best.length && allow)) best = { length, allow };
    }
  }
  return best.allow;
}

async function crawlAllowed(url, signal, stopAt) {
  let rules = new URL('/robots.txt', url);
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await requestPage(rules, signal, true);
    if ([404, 410].includes(response.status)) return true;
    if (typeof response.body === 'string') return robotsAllow(response.body, url.pathname + url.search);
    const next = safeUrl(response.location, rules);
    if (!next || stopAt(next)) return false;
    rules = next.pathname.endsWith('.txt') ? next : new URL('/robots.txt', next);
  }
  return false;
}

export async function loadPage(url, signal = AbortSignal.timeout(5000), stopAt = () => null) {
  if (!await crawlAllowed(url, signal, stopAt)) return { blocked: true };
  return requestPage(url, signal);
}

// A <meta http-equiv="refresh"> target that fires within ten seconds, or null.
export function metaRefresh(body) {
  const tags = String(body ?? '').slice(0, 50_000).match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (!/http-equiv\s*=\s*["']?refresh\b/i.test(tag)) continue;
    const content = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const value = content?.[1] ?? content?.[2] ?? '';
    const match = value.match(/^\s*(\d+)\s*[;,]\s*url\s*=\s*['"]?([^'"]+)['"]?\s*$/i);
    if (match && Number(match[1]) <= 10) return match[2].trim();
  }
  return null;
}

// Follow a site from start, hop by hop. stopAt(url) names a reason not to fetch a hop (such as a marketplace whose
// terms do not permit automated reads); the chain then ends there without a request to that host.
export async function followSite(start, { signal, stopAt = () => null, load = loadPage } = {}) {
  const hops = [];
  let url = safeUrl(start);
  if (!url) return { hops, failed: { url: null, reason: 'unsafe address' } };
  for (let hop = 0; hop <= maxHops; hop++) {
    const stop = stopAt(url);
    if (stop) return { hops, stopped: { url, reason: stop } };
    let response;
    try {
      response = await load(url, signal, stopAt);
    } catch {
      return { hops, failed: { url, reason: signal?.aborted ? 'timed out' : 'no response' } };
    }
    if (response?.blocked) return { hops, stopped: { url, reason: 'crawl rules unavailable or disallow this page' } };
    const status = Number.isInteger(response?.status) ? response.status : null;
    hops.push({ url, status });
    let target = response?.location ?? null;
    if (!target && typeof response?.body === 'string') target = metaRefresh(response.body);
    if (!target) return { hops, final: { url, status, contentType: String(response?.contentType ?? ''),
      body: response?.body ?? '', truncated: response?.truncated === true } };
    const next = safeUrl(target, url);
    if (!next) return { hops, stopped: { url: null, reason: 'unsafe redirect' } };
    url = next;
  }
  return { hops, stopped: { url, reason: 'too many redirects' } };
}

// Visible text of an HTML page for local pattern checks only. It is never returned to the caller of a tool.
export function pageText(body) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(body ?? '').slice(0, maxPageBytes)
    .replace(/<!--[\s\S]*?(?:-->|$)|<(script|style|noscript|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
      if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? match;
      const point = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
    })
    .replace(/[\s ​-‏‪-‮⁦-⁩]+/g, ' ')
    .trim();
}
