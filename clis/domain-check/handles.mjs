import { createHash, randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { anySignal, cacheDir, readCache, writeCache } from './cache.mjs';
import { classifyYouTubeHandle, validYouTubeHandle, youtubeHandleUrl } from './youtube-handle.mjs';
import { archiveKinds, archiveLabel, checkPublicArchives, classifyPublicCheck, fetchPublicCheck, findCommonCrawlIndex, playCacheName,
  publicBodyComplete, publicCacheKind, publicCheckTiming, publicHeaders, publicHtmlLimit, publicPageKinds, publicUrls,
  readsArchiveBody, readsPublicBody, threadsFromInstagram, validPlayName } from './public-name-checks.mjs';

export const handleStates = {
  taken: 'Taken',
  'not-found': 'No profile found',
  'not-seen': 'No page found in public archives',
  unknown: "Couldn't check",
};
const hour = 3_600_000;
// All definite public profile states expire after one hour.
export const handleLifetime = { taken: hour, 'not-found': hour, 'not-seen': hour };
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

export const publicProfiles = Object.freeze({ YouTube: 'youtube', X: 'x', Instagram: 'instagram', TikTok: 'tiktok', Threads: 'threads',
  Facebook: 'facebook', LinkedIn: 'linkedin', Reddit: 'reddit', Twitch: 'twitch' });
const publicKinds = { ...publicProfiles, 'Google Play': 'googlePlay' };
export const embedChecksEnabled = (env = process.env) => env.DOMAIN_HOUND_EMBED_CHECKS !== 'off';
const disabledReason = { Instagram: 'embed only', TikTok: 'embed only', X: 'lookup requires approved API access' };
const disabled = (platform, env) => !embedChecksEnabled(env) && platform !== 'YouTube' && Object.hasOwn(publicKinds, platform);

async function readPublicBody(response, maxBytes, read, complete) {
  const { status } = response;
  const contentType = response.headers.get('content-type') ?? '';
  const meta = { status, contentType };
  if (!read(status, contentType)) {
    void response.body?.cancel().catch(() => {});
    return meta;
  }
  if (Number(response.headers.get('content-length')) > maxBytes) {
    void response.body?.cancel().catch(() => {});
    return { ...meta, error: 'too-large' };
  }
  let size = 0;
  let body = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > maxBytes) return { ...meta, error: 'too-large' };
    body += decoder.decode(chunk, { stream: true });
    if (complete?.(status, contentType, body)) break;
  }
  return { ...meta, body: body + decoder.decode() };
}

// Anything the parser does not recognise is unknown.
const apis = {
  ...Object.fromEntries(Object.entries(publicKinds).map(([platform, kind]) => [platform, {
    valid: kind === 'googlePlay' ? validPlayName : kind === 'youtube' ? validYouTubeHandle
      : archiveKinds.includes(kind) ? label : handle => /^[a-z0-9]+$/.test(handle),
    url: publicUrls[kind],
    archive: archiveKinds.includes(kind),
    read: async (response, name) => classifyPublicCheck(kind, await readPublicBody(response,
      publicPageKinds.includes(kind) ? publicHtmlLimit : 512 * 1024,
      (status, type) => readsPublicBody(kind, status, type),
      (status, type, body) => publicBodyComplete(kind, status, type, body, name)), name),
    public: true,
  }])),
  youtubeApi: {
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
export const linkedInSearch = name => 'https://www.linkedin.com/search/results/companies/?' + new URLSearchParams({ keywords: name });
const redditSearch = name => 'https://www.reddit.com/search/?' + new URLSearchParams({ q: name, type: 'users' });
export const handleLabel = row => row?.state === 'taken' && row.seenYear ? archiveLabel(row.seenYear) : handleStates[row?.state] ?? handleStates.unknown;
export const linkedInSearchHint = row => row?.platform === 'LinkedIn' && row.state === 'not-seen' && label(row.handle)
  ? 'You can confirm with a web search for `site:linkedin.com/company/' + row.handle + '`.' : null;

export const handlePlatforms = [
  { id: 'YouTube', link: handle => 'https://www.youtube.com/@' + handle, auto: true },
  { id: 'X', link: handle => 'https://x.com/' + handle, auto: true },
  { id: 'Instagram', link: handle => 'https://www.instagram.com/' + handle + '/', auto: true },
  { id: 'TikTok', link: handle => 'https://www.tiktok.com/@' + handle, auto: true },
  { id: 'Threads', link: handle => 'https://www.threads.com/@' + handle, auto: true },
  { id: 'Facebook', link: handle => 'https://www.facebook.com/' + handle, auto: true },
  { id: 'LinkedIn', link: handle => 'https://www.linkedin.com/company/' + handle, search: linkedInSearch, linkLabel: 'Search LinkedIn', auto: true },
  { id: 'GitHub', link: handle => 'https://github.com/' + handle, auto: true },
  { id: 'npm', link: handle => 'https://www.npmjs.com/package/' + handle, auto: true },
  { id: 'PyPI', link: handle => 'https://pypi.org/project/' + handle + '/' },
  { id: 'Bluesky', link: handle => 'https://bsky.app/profile/' + handle + '.bsky.social', auto: true },
];
// Shown when the person asks for them in a local name screen.
export const requestPlatforms = [
  { id: 'Snapchat', link: handle => 'https://www.snapchat.com/add/' + handle },
  { id: 'Reddit', link: handle => 'https://www.reddit.com/user/' + handle + '/', search: redditSearch, linkLabel: 'Search Reddit', auto: true },
  { id: 'Twitch', link: handle => 'https://www.twitch.tv/' + handle, auto: true },
  handlePlatforms.find(platform => platform.id === 'Threads'),
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
async function requestWithRetry(platform, options, url, api, read, retry = true) {
  const { fetcher, signal, githubToken, youtubeApiKey } = options;
  const youtubeApi = platform === 'YouTube' && Boolean(youtubeApiKey);
  // An optional token lifts GitHub's 60 requests an hour for anonymous callers. It is sent only to api.github.com.
  const auth = youtubeApi ? { 'x-goog-api-key': youtubeApiKey }
    : platform === 'GitHub' && githubToken ? { Authorization: 'Bearer ' + githubToken } : {};
  const bounded = Object.hasOwn(publicKinds, platform);
  const page = api.public && publicPageKinds.includes(publicKinds[platform]);
  const timeout = page ? publicCheckTiming.pageTimeoutMs : api.archive ? publicCheckTiming.archiveTimeoutMs : publicCheckTiming.timeoutMs;
  const attemptSignal = bounded ? anySignal([signal, AbortSignal.timeout(timeout)]) : signal;
  if (attemptSignal?.aborted) return { error: 'timeout' };
  let error = 'network';
  try {
    const init = { redirect: api.archive ? 'manual' : 'error', signal: attemptSignal,
      headers: { 'User-Agent': userAgent, ...api.headers, ...auth, ...(api.public && !api.archive && publicHeaders) } };
    const response = api.public ? await fetchPublicCheck(fetcher, url, init) : await fetcher(url, init);
    if (response.status < 500) return await read(response);
    void response.body?.cancel().catch(() => {});
  } catch {
    if (attemptSignal?.aborted) error = 'timeout';
  }
  if (retry && !signal?.aborted) {
    if (!bounded) return requestWithRetry(platform, options, url, api, read, false);
    const waited = await delay(randomInt(80, 161), true, { signal }).catch(() => false);
    if (waited) return requestWithRetry(platform, options, url, api, read, false);
  }
  return { error: signal?.aborted ? 'timeout' : error };
}

async function request(platform, identifier, options) {
  const api = apis[platform === 'YouTube' && options.youtubeApiKey ? 'youtubeApi' : platform];
  if (api.archive) {
    const read = url => requestWithRetry(platform, options, url, api,
      response => readPublicBody(response, 512 * 1024, readsArchiveBody));
    return checkPublicArchives(publicKinds[platform], identifier, read, () => options.commonIndex ??= findCommonCrawlIndex(read));
  }
  const result = await requestWithRetry(platform, options, api.url(identifier), api, async response => {
    const limited = platform === 'GitHub' && [403, 429].includes(response.status);
    const why = response.status === 429 ? 'rate-limited' : 'no clear answer';
    if (response.status === 429) void response.body?.cancel().catch(() => {});
    const state = response.status === 429 ? 'unknown' : await api.read(response, identifier);
    return { state, ...(state === 'unknown' && { why }),
      ...(limited && { limited: Number(response.headers.get('x-ratelimit-reset')) * 1000 || null }) };
  });
  return result.error ? { state: 'unknown', why: result.error === 'timeout' ? 'timeout' : 'upstream-error' } : result;
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

const cachePlatform = (platform, options) => {
  if (platform === 'YouTube' && !options.youtubeApiKey) return 'youtube-page';
  return publicCacheKind(publicKinds[platform] ?? platform).toLowerCase().replace(' ', '-');
};

function lookup(platform, identifier, options) {
  const key = cachePlatform(platform, options) + '|' + identifier + '|' + (options.directory?.href ?? '');
  if (!inFlight.has(key)) inFlight.set(key, request(platform, identifier, options).finally(() => inFlight.delete(key)));
  return inFlight.get(key);
}

function cacheFile(platform, identifier, options) {
  const name = platform === 'Google Play' ? createHash('sha256').update(playCacheName(identifier)).digest('hex') : identifier;
  return 'handle-' + cachePlatform(platform, options) + '-' + name + '.json';
}

async function cached(platform, identifier, options) {
  const saved = await readCache(options.directory, cacheFile(platform, identifier, options));
  const age = options.now.getTime() - saved?.at;
  const lifetime = handleLifetime[saved?.state] ?? 0;
  return age >= 0 && age < (Object.hasOwn(publicKinds, platform) ? Math.min(lifetime, publicCheckTiming.ttlMs) : lifetime)
    ? saved : null;
}

// Answer a list of handles on one platform inside one shared time budget. Cached answers need no request; any live
// request runs beside the platform's control batch, and only a passing control lets a live answer through.
async function platformBatch(platform, handles, options, deadline) {
  const { directory, now } = options;
  const api = apis[platform];
  const runCache = Object.hasOwn(publicKinds, platform) ? null : options.runAnswers ?? runAnswers;
  const answers = new Map();
  const live = [];
  for (const handle of new Set(handles)) {
    if ((platform !== 'Google Play' && !label(handle)) || !api.valid(handle)) {
      answers.set(handle, { state: 'unknown', why: platform === 'Google Play' ? 'cannot check this name form' : 'cannot check this handle form' });
      continue;
    }
    const identifier = api.identifier?.(handle) ?? handle;
    const earlier = runCache?.get(platform + '|' + identifier + '|' + (directory?.href ?? ''));
    if (earlier) {
      answers.set(handle, earlier);
      continue;
    }
    const saved = await cached(platform, identifier, options);
    if (saved) answers.set(handle, { state: saved.state, checkedAt: new Date(saved.at).toISOString(), via: 'cache',
      ...(saved.seenYear && { seenYear: saved.seenYear }) });
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
    const { state, why, seenYear } = results[index];
    const key = platform + '|' + identifier + '|' + (directory?.href ?? '');
    if (state === 'unknown') {
      const answer = { state: 'unknown', why: why ?? 'no clear answer in time' };
      answers.set(handle, answer);
      runCache?.set(key, answer);
      continue;
    }
    const archive = seenYear ? { seenYear } : {};
    answers.set(handle, { state, checkedAt, via: 'api', ...archive });
    runCache?.set(key, { state, checkedAt, via: 'api', ...archive });
    await writeCache(directory, cacheFile(platform, identifier, options), { at: now.getTime(), state, ...archive }).catch(() => {});
  }
  return answers;
}

function linkRow(platform, handle, why = platform.why ?? 'link only') {
  const search = platform.id === 'LinkedIn';
  return { platform: platform.id, handle, state: 'unknown', link: (search ? platform.search : platform.link)(handle), why,
    ...(search && { linkLabel: platform.linkLabel }) };
}

function selectedPlatforms(extra) {
  return [...handlePlatforms, ...requestPlatforms.filter(platform => !handlePlatforms.includes(platform) &&
    (extra === true || Array.isArray(extra) && extra.includes(platform.id)))];
}

export function pendingHandleRows(name, extra) {
  return selectedPlatforms(extra).map(platform => linkRow(platform, name, disabled(platform.id, process.env)
    ? disabledReason[platform.id] : platform.auto ? 'still checking' : undefined));
}

export const handlePriorities = {
  developer: ['GitHub', 'npm', 'X'],
  consumer: ['Instagram', 'TikTok'],
  b2b: ['LinkedIn', 'X'],
  media: ['YouTube', 'TikTok'],
};

async function withinPlatformBudget(budget, run) {
  const deadline = new AbortController();
  // Keep Node alive until the platform answers or the deadline aborts its requests.
  const timer = setTimeout(() => deadline.abort(new DOMException('The operation timed out', 'TimeoutError')), budget);
  try {
    return await run(deadline.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function checkGooglePlayNames(names, {
  directory = cacheDir, now = new Date(), fetcher = globalThis.fetch, signal, env = process.env,
} = {}) {
  if (!embedChecksEnabled(env) || !names.length) return new Map();
  return withinPlatformBudget(publicCheckTiming.budgetMs,
    deadline => platformBatch('Google Play', names, { directory, now, fetcher, signal }, deadline));
}

// rows: [{ name, platforms?: ['GitHub', 'npm', 'Bluesky'], variants?: boolean, links?: boolean }]
// Returns a Map from name to its handle rows in display order. Exact handle first; getNAME, NAMEapp and NAMEhq only
// when the exact handle is taken, inside the same per-platform budget.
export async function checkSocialHandles(rows, {
  directory = cacheDir, now = new Date(), fetcher = globalThis.fetch, signal, budgetMs,
  controls, extraPlatforms = false, env = process.env, freshRun = false, instagramAnswers = new Map(),
} = {}) {
  const githubToken = typeof env?.DOMAIN_HOUND_GITHUB_TOKEN === 'string' && /^[\w-]{20,255}$/.test(env.DOMAIN_HOUND_GITHUB_TOKEN)
    ? env.DOMAIN_HOUND_GITHUB_TOKEN : null;
  const youtubeApiKey = typeof env?.YOUTUBE_API_KEY === 'string' ? env.YOUTUBE_API_KEY.trim() : '';
  const options = { directory, now, fetcher, signal, controls, githubToken, youtubeApiKey,
    ...(freshRun && { controlRuns: new Map(), runAnswers: new Map() }) };
  const platforms = selectedPlatforms(extraPlatforms);
  const automatic = platforms.filter(platform => platform.auto).map(platform => platform.id);
  const requested = (row, platform) => (row.platforms ?? automatic).includes(platform);
  const perPlatform = new Map(await Promise.all(automatic.map(async platform => {
    const names = rows.filter(row => requested(row, platform) ||
      (platform === 'Instagram' && requested(row, 'Threads') && !instagramAnswers.has(row.name)));
    if (!names.length || disabled(platform, env)) return [platform, null];
    const platformBudget = Object.hasOwn(publicKinds, platform)
      ? Math.min(budgetMs ?? publicCheckTiming.budgetMs, publicCheckTiming.budgetMs) : budgetMs ?? platformBudgetMs;
    const started = performance.now();
    return withinPlatformBudget(platformBudget, async deadline => {
      const exact = await platformBatch(platform, names.map(row => row.name), options, deadline);
      const taken = archiveKinds.includes(publicKinds[platform]) ? []
        : names.filter(row => row.variants && requested(row, platform) && exact.get(row.name)?.state === 'taken');
      const left = platformBudget - (performance.now() - started);
      const variants = taken.length && left >= 300
        ? await platformBatch(platform, taken.flatMap(row => handleVariants(row.name)), options, deadline)
        : new Map();
      return [platform, { exact, variants }];
    });
  })));
  const result = new Map();
  for (const row of rows) {
    const entries = [];
    for (const platform of platforms) {
      const wanted = requested(row, platform.id);
      if (wanted && disabled(platform.id, env)) {
        entries.push(linkRow(platform, row.name, disabledReason[platform.id]));
        continue;
      }
      const checked = wanted ? perPlatform.get(platform.id) : null;
      if (!platform.auto || !checked?.exact) {
        if (row.links === false) continue;
        entries.push(linkRow(platform, row.name, platform.auto ? 'not checked for this name' : undefined));
        continue;
      }
      const raw = checked.exact.get(row.name) ?? { state: 'unknown', why: 'no clear answer in time' };
      const instagram = instagramAnswers.get(row.name) ?? perPlatform.get('Instagram')?.exact.get(row.name);
      const answer = platform.id === 'Threads' ? threadsFromInstagram(raw, instagram) : raw;
      const search = (answer.state === 'not-seen' || (answer.state === 'unknown' && platform.id === 'LinkedIn')) && platform.search;
      const entry = { platform: platform.id, handle: row.name, state: answer.state, link: (search || platform.link)(row.name),
        ...(search && { linkLabel: platform.linkLabel }), ...(answer.seenYear && { seenYear: answer.seenYear }),
        ...(answer.checkedAt && { checkedAt: answer.checkedAt }), ...(answer.why && { why: answer.why }) };
      if (row.variants && answer.state === 'taken' && !platform.search) {
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
  const checked = entries.filter(entry => ['taken', 'not-found', 'not-seen'].includes(entry.state));
  const open = entries.filter(entry => !checked.includes(entry));
  const describe = entry => entry.platform + ' · ' + handleLabel(entry);
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
  const unchecked = manual.map(entry => entry.platform);
  return [shown.join(', '), unchecked.length ? handleStates.unknown + ' (' + unchecked.join(', ') + ')' : '',
    more > 0 ? '(' + more + ' more on the page)' : ''].filter(Boolean).join(' · ');
}
