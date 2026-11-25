// The person's confirmed domain list, kept only on this machine so a repeat call needs no input.
// DOMAIN_HOUND_PORTFOLIO_FILE moves it (tests use a temporary folder). Nothing here is sent anywhere.
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { asciiDomain } from '../domain-check/name-search.mjs';
import { safeUrl } from '../domain-check/safe-web.mjs';

export const maxSavedDomains = 100;
const writes = new Map();

export function portfolioFile(env = process.env) {
  return env.DOMAIN_HOUND_PORTFOLIO_FILE ? resolve(env.DOMAIN_HOUND_PORTFOLIO_FILE) : join(homedir(), '.domain-hound', 'portfolio.json');
}

export function portfolioDomain(value) {
  if (typeof value !== 'string' || value.length > 254) return null;
  const domain = asciiDomain(value.trim().replace(/\.$/, ''));
  if (!domain || !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(domain.split('.').at(-1))) return null;
  return safeUrl('https://' + domain)?.hostname === domain ? domain : null;
}

// { domains, state }: state is "missing" (no file yet), "ok", or "unreadable" (a file we must not overwrite blindly).
export async function readList(file = portfolioFile()) {
  let text;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 64 * 1024) return { domains: [], state: 'unreadable' };
    text = await readFile(file, 'utf8');
  } catch (error) {
    return { domains: [], state: error?.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  try {
    const data = JSON.parse(text);
    if (data && typeof data === 'object' && Array.isArray(data.domains) && data.domains.length <= maxSavedDomains
      && data.domains.every(domain => typeof domain === 'string' && portfolioDomain(domain) === domain)) {
      return { domains: [...new Set(data.domains)].slice(0, maxSavedDomains), state: 'ok', updatedAt: data.updatedAt ?? null };
    }
  } catch { /* fall through */ }
  return { domains: [], state: 'unreadable' };
}

export function updateList(file, change) {
  const next = (writes.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => change(await readList(file)));
  writes.set(file, next);
  return next.finally(() => {
    if (writes.get(file) === next) writes.delete(file);
  });
}

export async function writeList(domains, file = portfolioFile(), now = new Date()) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  const content = JSON.stringify({ version: 1, updatedAt: now.toISOString(), domains }, null, 2) + '\n';
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
