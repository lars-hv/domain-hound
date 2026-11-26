import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { anySignal, cacheDir, readCache, writeCache } from './cache.mjs';
import { classifyYouTubeHandle, validYouTubeHandle, youtubeHandleUrl } from './youtube-handle.mjs';

// Social handles. Three states only, never "free": a missing public profile does not mean the handle can be had.
export const handleStates = {
  taken: 'Taken',
  'not-found': 'No profile found',
  unknown: "Couldn't check",
};
const hour = 3_600_000;
// Default lifetimes for confirmed results. YouTube results of either kind last an hour.
export const handleLifetime = { taken: 7 * 24 * hour, 'not-found': hour };
// One platform's whole run (its two controls, the exact handles and any variants) shares this budget.
export const platformBudgetMs = 2000;
export const handleVariants = name => ['get' + name, name + 'app', name + 'hq'];
const userAgent = 'DomainHound/0.1 (https://domainhound.dev)';
const githubHoldFile = 'handles-github-hold.json';

const label = value => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
const syntheticLabel = (length, pick = randomInt) => 'zq' + Array.from({ length }, () => String.fromCharCode(97 + pick(26))).join('');

async function readStrictJson(response) {
  if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const text = await response.text();
  if (text.length > 512 * 1024) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// Anything the parser does not recognise is unknown.
const apis = {
  YouTube: {
    valid: validYouTubeHandle,
    url: youtubeHandleUrl,
    headers: { Accept: 'application/json' },
    read: async response => classifyYouTubeHandle(response.status, await readStrictJson(response)),
  },
  // GitHub REST "Get a user" (users and organizations): https://docs.github.com/en/rest/users/users#get-a-user
  GitHub: {
    valid: handle => /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(handle),
    url: handle => 'https://api.github.com/users/' + handle,
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    read: async (response, handle) => {
      const data = await readStrictJson(response);
      if (response.status === 200) {
        return typeof data?.login === 'string' && data.login.toLowerCase() === handle
          && ['User', 'Organization'].includes(data.type) ? 'taken' : 'unknown';
      }
      if (response.status === 404) return data?.message === 'Not Found' ? 'not-found' : 'unknown';
      return 'unknown';
    },
    controls: () => ({ taken: 'github', missing: syntheticLabel(28) }),
  },
  // npm registry package document: https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md#getpackage
  npm: {
    valid: handle => handle.length <= 214,
    url: handle => 'https://registry.npmjs.org/' + handle,
    headers: { Accept: 'application/vnd.npm.install-v1+json' },
    read: async (response, handle) => {
      const data = await readStrictJson(response);
      if (response.status === 200) return data?.name === handle ? 'taken' : 'unknown';
      if (response.status === 404) return typeof data?.error === 'string' && /^not found$/i.test(data.error) ? 'not-found' : 'unknown';
      return 'unknown';
    },
    controls: () => ({ taken: 'lodash', missing: syntheticLabel(24) }),
  },
  // Bluesky public AppView, com.atproto.identity.resolveHandle:
  // https://docs.bsky.app/docs/api/com-atproto-identity-resolve-handle
  Bluesky: {
    valid: handle => handle.length >= 3 && handle.length <= 18,
    identifier: handle => handle + '.bsky.social',
    url: identifier => 'https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=' + encodeURIComponent(identifier),
    headers: { Accept: 'application/json' },
    read: async response => {
      const data = await readStrictJson(response);
      if (response.status === 200) return typeof data?.did === 'string' && /^did:(?:plc|web):[a-z0-9._:%-]+$/i.test(data.did) ? 'taken' : 'unknown';
      if (response.status === 400) {
        return data?.error === 'InvalidRequest' && /^unable to resolve handle$/i.test(String(data.message ?? '').trim()) ? 'not-found' : 'unknown';
      }
      return 'unknown';
    },
    // bsky.app is Bluesky's own account.
    controls: () => ({ taken: 'bsky.app', missing: syntheticLabel(14) + '.bsky.social' }),
  },
};

// Display order (Lars, 2026-11-25): YouTube, X, Instagram, TikTok, Facebook, LinkedIn, then GitHub, npm, PyPI, Bluesky.
export const linkedInLabel = "LinkedIn doesn't allow checks";
export const linkedInSearch = name => 'https://www.linkedin.com/search/results/companies/?' + new URLSearchParams({ keywords: name });
export const handleLabel = row => row?.platform === 'LinkedIn' ? linkedInLabel : handleStates[row?.state] ?? handleStates.unknown;

export const handlePlatforms = [
  { id: 'YouTube', link: handle => 'https://www.youtube.com/@' + handle, auto: true },
  { id: 'X', link: handle => 'https://x.com/' + handle, why: 'lookup requires approved API access' },
  { id: 'Instagram', link: handle => 'https://www.instagram.com/' + handle + '/', why: 'embed only' },
  { id: 'TikTok', link: handle => 'https://www.tiktok.com/@' + handle, why: 'embed only' },
  { id: 'Facebook', link: handle => 'https://www.facebook.com/' + handle },
  { id: 'LinkedIn', link: linkedInSearch, linkLabel: 'Search LinkedIn' },
  { id: 'GitHub', link: handle => 'https://github.com/' + handle, auto: true },
  { id: 'npm', link: handle => 'https://www.npmjs.com/package/' + handle, auto: true },
  { id: 'PyPI', link: handle => 'https://pypi.org/project/' + handle + '/' },
  { id: 'Bluesky', link: handle => 'https://bsky.app/profile/' + handle + '.bsky.social', auto: true },
];
// Shown only when the person asks for them; always check links.
export const requestPlatforms = [
  { id: 'Snapchat', link: handle => 'https://www.snapchat.com/add/' + handle },
  { id: 'Reddit', link: handle => 'https://www.reddit.com/user/' + handle + '/' },
  { id: 'Twitch', link: handle => 'https://www.twitch.tv/' + handle },
  { id: 'Threads', link: handle => 'https://www.threads.com/@' + handle },
  { id: 'Pinterest', link: handle => 'https://www.pinterest.com/' + handle + '/' },
  { id: 'Discord', link: () => 'https://support.discord.com/hc/en-us/articles/12620128861463-New-Usernames-Display-Names' },
];
export const autoPlatforms = handlePlatforms.filter(platform => platform.auto).map(platform => platform.id);

// In-flight lookups and control batches are shared inside one run (one process).
const inFlight = new Map();
const controlRuns = new Map();
// Reused by the registry sources when lookup stages overlap.
const runAnswers = new Map();
export function resetHandleRuns() {
  inFlight.clear();
  controlRuns.clear();
  runAnswers.clear();
}

async function githubHeld(directory, now) {
  const hold = await readCache(directory, githubHoldFile);
  return hold?.until > now.getTime();
}

// One request, and one retry inside the same budget when the platform fails (5xx or no response).
async function request(platform, identifier, options, retry = true) {
  const { fetcher, signal, githubToken, youtubeApiKey } = options;
  const api = apis[platform];
  // An optional token lifts GitHub's 60 requests an hour for anonymous callers. It is sent only to api.github.com.
  const auth = platform === 'YouTube' ? { 'x-goog-api-key': youtubeApiKey }
    : platform === 'GitHub' && githubToken ? { Authorization: 'Bearer ' + githubToken } : {};
  const attemptSignal = platform === 'YouTube' ? anySignal([signal, AbortSignal.timeout(1400)]) : signal;
  if (attemptSignal?.aborted) return { state: 'unknown', why: 'timeout' };
  let why = 'upstream-error';
  try {
    const response = await fetcher(api.url(identifier), {
      redirect: 'error', signal: attemptSignal, headers: { 'User-Agent': userAgent, ...api.headers, ...auth },
    });
    const state = await api.read(response, identifier);
    const limited = platform === 'GitHub' && [403, 429].includes(response.status);
    if (response.status < 500) {
      return { state, ...(state === 'unknown' && { why: response.status === 429 ? 'rate-limited' : 'no clear answer' }),
        ...(limited && { limited: Number(response.headers.get('x-ratelimit-reset')) * 1000 || null }) };
    }
  } catch {
    if (attemptSignal?.aborted) why = 'timeout';
  }
  if (retry && !signal?.aborted) {
    if (platform !== 'YouTube') return request(platform, identifier, options, false);
    const waited = await delay(randomInt(80, 161), true, { signal }).catch(() => false);
    if (waited) return request(platform, identifier, options, false);
  }
  return { state: 'unknown', why };
}

// The run's two controls for one platform: a handle known to exist and a random one that cannot. When either comes
// back wrong, the platform's live results are unknown for this run.
function controlsFor(platform, options) {
  const key = platform + '|' + (options.directory?.href ?? '');
  const runs = options.controlRuns ?? controlRuns;
  if (!runs.has(key)) {
    const { taken, missing } = options.controls?.[platform] ?? apis[platform].controls();
    runs.set(key, Promise.all([request(platform, taken, options), request(platform, missing, options)])
      .then(([known, absent]) => ({ ok: known.state === 'taken' && absent.state === 'not-found',
        limited: known.limited ?? absent.limited })));
  }
  return runs.get(key);
}

function lookup(platform, identifier, options) {
  const key = platform + '|' + identifier + '|' + (options.directory?.href ?? '');
  if (!inFlight.has(key)) inFlight.set(key, request(platform, identifier, options).finally(() => inFlight.delete(key)));
  return inFlight.get(key);
}

const cacheFile = (platform, identifier) => 'handle-' + platform.toLowerCase() + '-' + identifier + '.json';

async function cached(directory, platform, identifier, now) {
  const saved = await readCache(directory, cacheFile(platform, identifier));
  const age = now.getTime() - saved?.at;
  const lifetime = handleLifetime[saved?.state] ?? 0;
  return age >= 0 && age < (platform === 'YouTube' ? Math.min(lifetime, hour) : lifetime) ? saved : null;
}

// Answer a list of handles on one platform inside one shared time budget. Cached answers need no request; any live
// request runs beside the platform's control batch, and only a passing control lets a live answer through.
async function platformBatch(platform, handles, options, deadline) {
  const { directory, now } = options;
  const api = apis[platform];
  if (platform === 'YouTube' && !options.youtubeApiKey) {
    return new Map(handles.map(handle => [handle, { state: 'unknown', why: 'not connected' }]));
  }
  const runCache = platform === 'YouTube' ? null : options.runAnswers ?? runAnswers;
  const answers = new Map();
  const live = [];
  for (const handle of new Set(handles)) {
    if (!label(handle) || !api.valid(handle)) {
      answers.set(handle, { state: 'unknown', why: 'cannot check this handle form' });
      continue;
    }
    const identifier = api.identifier?.(handle) ?? handle;
    const earlier = runCache?.get(platform + '|' + identifier + '|' + (directory?.href ?? ''));
    if (earlier) {
      answers.set(handle, earlier);
      continue;
    }
    const saved = await cached(directory, platform, identifier, now);
    if (saved) answers.set(handle, { state: saved.state, checkedAt: new Date(saved.at).toISOString(), via: 'cache' });
    else live.push([handle, identifier]);
  }
  if (!live.length && (!options.controlRuns || !answers.size)) return answers;
  if (platform === 'GitHub' && await githubHeld(directory, now)) {
    for (const handle of [...answers.keys(), ...live.map(([handle]) => handle)]) answers.set(handle, { state: 'unknown', why: 'rate limited' });
    return answers;
  }
  const signal = options.signal ? anySignal([options.signal, deadline]) : deadline;
  const run = { ...options, signal };
  const [control, results] = await Promise.all([
    api.controls ? controlsFor(platform, run) : { ok: true },
    Promise.all(live.map(([, identifier]) => lookup(platform, identifier, run))),
  ]);
  const limited = control.limited ?? results.find(result => result.limited !== undefined)?.limited;
  if (limited !== undefined) {
    const until = limited > now.getTime() ? limited : now.getTime() + hour;
    await writeCache(directory, githubHoldFile, { until }).catch(() => {});
  }
  if (!control.ok) {
    for (const handle of [...answers.keys(), ...live.map(([handle]) => handle)]) {
      answers.set(handle, { state: 'unknown', why: 'control check failed' });
    }
    return answers;
  }
  const checkedAt = now.toISOString();
  for (const [index, [handle, identifier]] of live.entries()) {
    const { state, why } = results[index];
    const key = platform + '|' + identifier + '|' + (directory?.href ?? '');
    if (state === 'unknown') {
      const answer = { state: 'unknown', why: why ?? 'no clear answer in time' };
      answers.set(handle, answer);
      runCache?.set(key, answer);
      continue;
    }
    answers.set(handle, { state, checkedAt, via: 'api' });
    runCache?.set(key, { state, checkedAt, via: 'api' });
    await writeCache(directory, cacheFile(platform, identifier), { at: now.getTime(), state }).catch(() => {});
  }
  return answers;
}

function linkRow(platform, handle, why = platform.why ?? 'link only') {
  return { platform: platform.id, handle, state: 'unknown', link: platform.link(handle), why,
    ...(platform.linkLabel && { linkLabel: platform.linkLabel }) };
}

function selectedPlatforms(extra) {
  return [...handlePlatforms, ...requestPlatforms.filter(platform => extra === true || Array.isArray(extra) && extra.includes(platform.id))];
}

export function pendingHandleRows(name, extra) {
  return selectedPlatforms(extra).map(platform => linkRow(platform, name, platform.id === 'YouTube' && !process.env.YOUTUBE_API_KEY?.trim()
    ? 'not connected' : platform.auto ? 'still checking' : undefined));
}

export const handlePriorities = {
  developer: ['GitHub', 'npm', 'X'],
  consumer: ['Instagram', 'TikTok'],
  b2b: ['LinkedIn', 'X'],
  media: ['YouTube', 'TikTok'],
};

// rows: [{ name, platforms?: ['GitHub', 'npm', 'Bluesky'], variants?: boolean, links?: boolean }]
// Returns a Map from name to its handle rows in display order. Exact handle first; getNAME, NAMEapp and NAMEhq only
// when the exact handle is taken, inside the same per-platform budget.
export async function checkSocialHandles(rows, {
  directory = cacheDir, now = new Date(), fetcher = globalThis.fetch, signal, budgetMs,
  controls, extraPlatforms = false, env = process.env, freshRun = false,
} = {}) {
  const githubToken = typeof env?.DOMAIN_HOUND_GITHUB_TOKEN === 'string' && /^[\w-]{20,255}$/.test(env.DOMAIN_HOUND_GITHUB_TOKEN)
    ? env.DOMAIN_HOUND_GITHUB_TOKEN : null;
  const youtubeApiKey = typeof env?.YOUTUBE_API_KEY === 'string' ? env.YOUTUBE_API_KEY.trim() : '';
  const options = { directory, now, fetcher, signal, controls, githubToken, youtubeApiKey,
    ...(freshRun && { controlRuns: new Map(), runAnswers: new Map() }) };
  const wanted = platform => rows.filter(row => (row.platforms ?? autoPlatforms).includes(platform));
  const perPlatform = new Map(await Promise.all(autoPlatforms.map(async platform => {
    const names = wanted(platform);
    if (!names.length) return [platform, new Map()];
    const platformBudget = platform === 'YouTube' ? Math.min(budgetMs ?? 3000, 3000) : budgetMs ?? platformBudgetMs;
    const started = performance.now();
    const deadline = new AbortController();
    // Keep Node alive until the platform answers or the deadline aborts its requests.
    const timer = setTimeout(() => {
      deadline.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    }, platformBudget);
    try {
      const exact = await platformBatch(platform, names.map(row => row.name), options, deadline.signal);
      const taken = names.filter(row => row.variants && exact.get(row.name)?.state === 'taken');
      const left = platformBudget - (performance.now() - started);
      const variants = taken.length && left >= 300
        ? await platformBatch(platform, taken.flatMap(row => handleVariants(row.name)), options, deadline.signal)
        : new Map();
      return [platform, { exact, variants, skipped: taken.length > 0 && left < 300 }];
    } finally {
      clearTimeout(timer);
    }
  })));
  const result = new Map();
  for (const row of rows) {
    const platforms = selectedPlatforms(extraPlatforms);
    const entries = [];
    for (const platform of platforms) {
      const checked = (row.platforms ?? autoPlatforms).includes(platform.id) ? perPlatform.get(platform.id) : null;
      if (!platform.auto || !checked?.exact) {
        if (row.links === false) continue;
        entries.push(linkRow(platform, row.name, platform.auto ? 'not checked for this name' : undefined));
        continue;
      }
      const answer = checked.exact.get(row.name) ?? { state: 'unknown', why: 'no clear answer in time' };
      const entry = { platform: platform.id, handle: row.name, state: answer.state, link: platform.link(row.name),
        ...(answer.checkedAt && { checkedAt: answer.checkedAt }), ...(answer.why && { why: answer.why }) };
      if (row.variants && answer.state === 'taken') {
        entry.variants = handleVariants(row.name).map(handle => {
          const variant = checked.variants.get(handle) ?? { state: 'unknown', why: 'no clear answer in time' };
          return { handle, state: variant.state, link: platform.link(handle),
            ...(variant.checkedAt && { checkedAt: variant.checkedAt }), ...(variant.why && { why: variant.why }) };
        });
      }
      entries.push(entry);
    }
    result.set(row.name, entries);
  }
  return result;
}

export function handleSummary(entries, { limit = Infinity, manualLimit = Infinity, ordered = false } = {}) {
  if (!Array.isArray(entries) || !entries.length) return null;
  const checked = entries.filter(entry => ['taken', 'not-found'].includes(entry.state));
  const open = entries.filter(entry => !checked.includes(entry));
  const describe = entry => entry.platform === 'LinkedIn' ? linkedInLabel : entry.platform + ' · ' + handleLabel(entry);
  if (ordered) {
    const shown = new Set([...entries.slice(0, 2), ...checked.slice(0, 2)]);
    for (const entry of entries) {
      if (shown.size === 4) break;
      shown.add(entry);
    }
    const states = entries.filter(entry => shown.has(entry))
      .map(describe).join(', ');
    const more = entries.length - shown.size;
    return states + (more ? ' (' + more + ' more on the page)' : '');
  }
  const shown = checked.slice(0, limit).map(describe);
  const manual = open.slice(0, manualLimit);
  const more = checked.length - shown.length + open.length - manual.length;
  const unchecked = manual.filter(entry => entry.platform !== 'LinkedIn').map(entry => entry.platform);
  return [shown.join(', '), unchecked.length ? handleStates.unknown + ' (' + unchecked.join(', ') + ')' : '',
    manual.some(entry => entry.platform === 'LinkedIn') ? linkedInLabel : '',
    more > 0 ? '(' + more + ' more on the page)' : ''].filter(Boolean).join(' · ');
}
