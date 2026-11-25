import { mkdir, open } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { cacheDir, readCache, writeCache } from './cache.mjs';
import { playSearchLink } from './google-play.mjs';
import { compactText, day, letters, request } from './triage-sources.mjs';

const sharedCache = new URL('google/', cacheDir);
const pending = new Map();
export const googleAutocomplete = 'https://www.google.com/complete/search?';
export const trendsAutocomplete = 'https://trends.google.com/trends/api/autocomplete/';
export const braveSearch = 'https://api.search.brave.com/res/v1/web/search?';
export const serperSearch = 'https://google.serper.dev/search';

export const googleSearchLink = input => 'https://www.google.com/search?' + new URLSearchParams({ q: '"' + input + '"' });
export const appStoreSearchLink = input => 'https://apps.apple.com/us/iphone/search?' + new URLSearchParams({ term: input });
export { playSearchLink };

function retryUntil(header, now) {
  const until = /^\d+$/.test(header ?? '') ? now + Number(header) * 1000 : Date.parse(header);
  return Number.isFinite(until) ? Math.max(until, now + 60_000) : now + 60 * 60_000;
}

function fresh(record, { now, cacheLifetime = day }) {
  const lifetime = record?.value != null ? cacheLifetime : day;
  return now - record?.at >= 0 && now - record.at < lifetime;
}

async function waitForClaim(directory, filename, { now, timeout, signal, cacheLifetime }) {
  const deadline = performance.now() + timeout + 100;
  while (!signal?.aborted && performance.now() < deadline) {
    const record = await readCache(directory, filename);
    if (fresh(record, { now, cacheLifetime })) {
      if (!record.pending) return record.value;
      if (record.pendingUntil < Date.now()) return null;
    }
    await delay(40);
  }
  return null;
}

// A per-name exclusive daily claim protects concurrent CLI processes. The attempt record
// is saved before the network request, so errors also count against the rolling 24-hour cache.
async function loadProvider(provider, name, options, query) {
  const { directory, now } = options;
  const filename = 'google-' + provider + '-' + name + '.json';
  const hold = 'google-cooldown-' + provider + '.json';
  const saved = await readCache(directory, filename);
  if (fresh(saved, options)) return saved.pending ? waitForClaim(directory, filename, options) : saved.value;
  if (options.live === false || options.signal?.aborted || !directory) return null;
  if ((await readCache(directory, hold))?.until > now) return null;
  const folder = new URL('google-claims/' + new Date(now).toISOString().slice(0, 10) + '/', directory);
  try {
    await mkdir(folder, { recursive: true });
    await (await open(new URL(provider + '-' + name, folder), 'wx', 0o600)).close();
  } catch (error) {
    return error?.code === 'EEXIST' ? waitForClaim(directory, filename, options) : null;
  }
  const current = await readCache(directory, filename);
  if (fresh(current, options)) return current.pending ? waitForClaim(directory, filename, options) : current.value;
  let value = null;
  try {
    if ((await readCache(directory, hold))?.until > now || options.signal?.aborted) return null;
    await writeCache(directory, filename, { at: now, pending: true, pendingUntil: Date.now() + options.timeout + 100 });
    const response = await query();
    if (!response.ok) {
      if (response.status === 429) {
        const until = retryUntil(response.headers.get('Retry-After'), now);
        const previous = (await readCache(directory, hold))?.until ?? 0;
        await writeCache(directory, hold, { until: Math.max(until, previous) });
      }
      await response.body?.cancel();
      return null;
    }
    value = await options.parse(response);
    return value;
  } catch {
    return null;
  } finally {
    await writeCache(directory, filename, { at: now, value }).catch(() => {});
  }
}

function provider(id, name, options, url, parse, init = {}) {
  const key = options.directory?.href + ':' + id + ':' + name;
  if (pending.has(key)) return pending.get(key);
  const job = loadProvider(id, name, { ...options, parse },
    () => request(url, options, { timeout: options.timeout, ...init })).finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

async function suggestions(response) {
  const data = await response.json();
  return Array.isArray(data?.[1]) && data[1].every(item => typeof item === 'string') ? data[1].slice(0, 20) : null;
}

async function topics(response) {
  const data = JSON.parse((await response.text()).replace(/^\)\]\}'\s*,?\s*/, ''));
  const rows = data?.default?.topics ?? data?.topics;
  return Array.isArray(rows) ? rows.slice(0, 20).flatMap(row => typeof row?.title === 'string'
    ? [{ name: compactText(row.title, 75), description: compactText(row.type, 120) }] : []) : null;
}

function prefixMatch(name) {
  const key = letters(name);
  return new RegExp('^(' + key.split('').join('[ ._-]*') + ')(?=$|[^a-z0-9])', 'i');
}

function ownHost(name, value) {
  if (!/^(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(value)) return false;
  try {
    const host = new URL(value.includes('://') ? value : 'https://' + value).hostname.replace(/^www\./, '');
    return host.split('.')[0] === name;
  } catch { return false; }
}

function exactBrandTitle(name, title) {
  return letters(title.split(/\s[-–—|:·•]\s|[|:–—]/, 1)[0]) === letters(name);
}

function webEvidence(name, search, sameBusiness) {
  const match = prefixMatch(name);
  const pages = search.flat().filter(row => match.test(row.title) || ownHost(name, row.url));
  const official = pages.find(row => ownHost(name, row.url) && match.test(row.title) || exactBrandTitle(name, row.title) &&
    sameBusiness(row.title + ' ' + row.description));
  if (official) return { result: 'owned by ' + (official.title.match(match)?.[1] ?? name),
    sameBusiness: sameBusiness(official.title + ' ' + official.description) };
  if (pages.length) return { result: 'crowded' };
  return null;
}

export function classifyGoogle(name, { suggestions, topics, entities, search = [] }, sameBusiness = () => false) {
  const key = letters(name);
  const match = prefixMatch(name);
  const exact = [
    ...(topics ?? []).filter(row => letters(row.name) === key),
    ...(entities ?? []).filter(row => row.brand && letters(row.name) === key),
  ];
  const withContext = exact.find(row => sameBusiness(row.name + ' ' + row.description));
  if (withContext) return { result: 'owned by ' + withContext.name, sameBusiness: true };

  const counts = new Set((suggestions ?? []).map(value => value.trim().toLowerCase())
    .filter(value => match.test(value) && /^\s+(?:app|login|pricing|ai)\b/.test(value.replace(match, ''))));
  const site = (suggestions ?? []).find(value => ownHost(name, value));
  const web = webEvidence(name, search, sameBusiness);
  if (web?.sameBusiness) return web;
  if (exact.length) return { result: 'owned by ' + exact[0].name };
  if (site || counts.size >= 3) return { result: 'owned by ' + name };
  if (web?.result.startsWith('owned by ')) return web;
  if (counts.size || topics?.some(row => match.test(row.name)) || web) return { result: 'crowded' };
  if (suggestions && topics && entities) return { result: 'open' };
  return null;
}

function searchItems(items, link, snippet) {
  return Array.isArray(items) ? items.slice(0, 10).flatMap(item =>
    typeof item?.[link] === 'string' && typeof item.title === 'string'
      ? [{ title: compactText(item.title, 120), url: compactText(item[link], 300), description: compactText(item[snippet], 200) }]
      : []) : null;
}

export async function searchGoogle(name, input, options = {}) {
  const { env = process.env, directory = sharedCache, now = new Date() } = options;
  const context = { ...options, directory, now: now.getTime(),
    timeout: Math.max(1, Math.floor(Math.min(2500, options.timeoutMs ?? 2500))) };
  const q = '"' + input + '"';
  const braveKey = env.DOMAIN_HOUND_BRAVE_SEARCH_KEY?.trim();
  const serperKey = env.DOMAIN_HOUND_SERPER_KEY?.trim();
  const [google, trends, entities, brave, serper] = await Promise.all([
    provider('autocomplete', name, context, googleAutocomplete + new URLSearchParams({ client: 'chrome', q: name }), suggestions),
    provider('trends', name, context, trendsAutocomplete + encodeURIComponent(name), topics),
    options.entities,
    braveKey ? provider('brave', name, context, braveSearch + new URLSearchParams({ q, count: '10' }), async response => {
      const data = await response.json();
      return searchItems(data?.web?.results, 'url', 'description');
    }, { headers: { Accept: 'application/json', 'X-Subscription-Token': braveKey } }) : null,
    serperKey ? provider('serper', name, context, serperSearch, async response => {
      const data = await response.json();
      return searchItems(data?.organic, 'link', 'snippet');
    }, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-API-KEY': serperKey },
      body: JSON.stringify({ q }) }) : null,
  ]);
  const result = classifyGoogle(name, { suggestions: google, topics: trends, entities, search: [brave ?? [], serper ?? []] },
    options.sameBusiness);
  // The raw suggestions and topics let triage find each same-name rival and judge its traction.
  // They stay non-enumerable, so they never reach the JSON output.
  return Object.defineProperty(result ? { google: result } : { unchecked: 'unavailable sources' }, 'raw', {
    value: { suggestions: google, topics: trends, web: Boolean(brave?.length || serper?.length) },
  });
}

const verdictRank = { 'No conflict found': 0, 'Check first': 1, Avoid: 2 };

// Google can only lower a verdict. Ownership in the same business is a reason to avoid the name.
export function googleFloor(google) {
  if (!google?.result || google.result === 'open' || google.result === 'not checked') return null;
  if (google.result === 'crowded') return 'Check first';
  return google.sameBusiness ? 'Avoid' : 'Check first';
}

export function lowerVerdict(row, google) {
  const floor = googleFloor(google);
  if (!floor || verdictRank[floor] <= (verdictRank[row.verdict] ?? 0)) return false;
  row.verdict = floor;
  row.reason = 'Google: ' + google.result + (google.sameBusiness ? ' (same business)' : '') + ' · ' + row.reason;
  return true;
}

function appText(match) {
  if (match === null || match === undefined) return 'not checked';
  if (Array.isArray(match)) {
    if (!match.length) return 'no exact-name app';
    return appText(match[0]) + (match.length > 1 ? ' (+' + (match.length - 1) + ' more)' : '');
  }
  if (match === true) return 'exact-name app found';
  if (typeof match === 'string') return 'taken: ' + compactText(match, 70);
  if (typeof match !== 'object') return 'not checked';
  const ratings = Number.isSafeInteger(match.ratings) ? ', ' + match.ratings + ' ratings' : '';
  return 'taken: ' + compactText(match.name, 70) + (match.developer ? ' by ' + compactText(match.developer, 50) : '') + ratings;
}

function googleText(google) {
  if (!google || typeof google !== 'object' || typeof google.result !== 'string' || google.result === 'not checked') {
    return 'not checked';
  }
  return compactText(google.result, 75);
}

// The three explicit name checks for one row. Older payloads without Google or app fields read as not checked.
export function nameCheckLines(row) {
  const input = typeof row?.name === 'string' ? row.name : '';
  const competition = row?.competition ?? {};
  return [
    { label: 'Google', text: googleText(row?.google), link: googleSearchLink(input) },
    { label: 'App Store (iOS)', text: appText(competition.AppStore), link: appStoreSearchLink(input) },
    { label: 'Google Play (Android)', text: appText(competition.GooglePlay), link: playSearchLink(input) },
  ];
}

// Only search pages rebuilt from the name, or exact store app pages, render as links.
export function isSearchLink(url, input) {
  return typeof url === 'string' && typeof input === 'string'
    && [googleSearchLink, appStoreSearchLink, playSearchLink].some(build => build(input) === url);
}
