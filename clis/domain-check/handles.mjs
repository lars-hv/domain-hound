import { randomInt } from 'node:crypto';
import { anySignal, cacheDir, readCache, writeCache } from './cache.mjs';

// Social handles. Three states only, never "free": a missing public profile does not mean the handle can be had.
export const handleStates = {
  taken: 'Taken',
  'not-found': 'No public profile found',
  check: 'Check yourself',
};
const hour = 3_600_000;
// A taken handle is reused for a week, a missing one for an hour. "Check yourself" is never cached.
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

// Each automatic check uses a documented public API that needs no login. Anything the parser does not recognise is
// "check yourself".
const apis = {
  // GitHub REST "Get a user" (users and organizations): https://docs.github.com/en/rest/users/users#get-a-user
  GitHub: {
    valid: handle => /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(handle),
    url: handle => 'https://api.github.com/users/' + handle,
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    read: async (response, handle) => {
      const data = await readStrictJson(response);
      if (response.status === 200) {
        return typeof data?.login === 'string' && data.login.toLowerCase() === handle
          && ['User', 'Organization'].includes(data.type) ? 'taken' : 'check';
      }
      if (response.status === 404) return data?.message === 'Not Found' ? 'not-found' : 'check';
      return 'check';
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
      if (response.status === 200) return data?.name === handle ? 'taken' : 'check';
      if (response.status === 404) return typeof data?.error === 'string' && /^not found$/i.test(data.error) ? 'not-found' : 'check';
      return 'check';
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
      if (response.status === 200) return typeof data?.did === 'string' && /^did:(?:plc|web):[a-z0-9._:%-]+$/i.test(data.did) ? 'taken' : 'check';
      if (response.status === 400) {
        return data?.error === 'InvalidRequest' && /^unable to resolve handle$/i.test(String(data.message ?? '').trim()) ? 'not-found' : 'check';
      }
      return 'check';
    },
    // bsky.app is Bluesky's own account.
    controls: () => ({ taken: 'bsky.app', missing: syntheticLabel(14) + '.bsky.social' }),
  },
};

// Display order (Lars, 2026-11-25): YouTube, X, Instagram, TikTok, Facebook, LinkedIn, then GitHub, npm, PyPI, Bluesky.
// YouTube, X, Instagram, TikTok, Facebook and LinkedIn have no public no-login lookup their terms allow: link only.
// PyPI is link only by decision.
export const handlePlatforms = [
  { id: 'YouTube', link: handle => 'https://www.youtube.com/@' + handle },
  { id: 'X', link: handle => 'https://x.com/' + handle },
  { id: 'Instagram', link: handle => 'https://www.instagram.com/' + handle + '/' },
  { id: 'TikTok', link: handle => 'https://www.tiktok.com/@' + handle },
  { id: 'Facebook', link: handle => 'https://www.facebook.com/' + handle },
  { id: 'LinkedIn', link: handle => 'https://www.linkedin.com/company/' + handle + '/' },
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
// Every answer this run already has, "check yourself" included, so a later step never asks again.
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
async function request(platform, identifier, { fetcher, signal, githubToken }, retry = true) {
  const api = apis[platform];
  let failed;
  // An optional token lifts GitHub's 60 requests an hour for anonymous callers. It is sent only to api.github.com.
  const auth = platform === 'GitHub' && githubToken ? { Authorization: 'Bearer ' + githubToken } : {};
  try {
    const response = await fetcher(api.url(identifier), {
      redirect: 'error', signal, headers: { 'User-Agent': userAgent, ...api.headers, ...auth },
    });
    failed = response.status >= 500;
    const state = await api.read(response, identifier);
    const limited = platform === 'GitHub' && [403, 429].includes(response.status);
    if (!failed) return { state, ...(limited && { limited: Number(response.headers.get('x-ratelimit-reset')) * 1000 || null }) };
  } catch {
    failed = true;
  }
  return retry && failed && !signal?.aborted ? request(platform, identifier, { fetcher, signal, githubToken }, false) : { state: 'check' };
}

// The run's two controls for one platform: a handle known to exist and a random one that cannot. When either comes
// back wrong, every answer from that platform in this run becomes "check yourself".
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
  return age >= 0 && age < (handleLifetime[saved?.state] ?? 0) ? saved : null;
}

// Answer a list of handles on one platform inside one shared time budget. Cached answers need no request; any live
// request runs beside the platform's control batch, and only a passing control lets a live answer through.
async function platformBatch(platform, handles, options, deadline) {
  const { directory, now } = options;
  const api = apis[platform];
  const runCache = options.runAnswers ?? runAnswers;
  const answers = new Map();
  const live = [];
  for (const handle of new Set(handles)) {
    if (!label(handle) || !api.valid(handle)) {
      answers.set(handle, { state: 'check', why: 'cannot check this handle form' });
      continue;
    }
    const identifier = api.identifier?.(handle) ?? handle;
    const earlier = runCache.get(platform + '|' + identifier + '|' + (directory?.href ?? ''));
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
    for (const handle of [...answers.keys(), ...live.map(([handle]) => handle)]) answers.set(handle, { state: 'check', why: 'rate limited' });
    return answers;
  }
  const signal = options.signal ? anySignal([options.signal, deadline]) : deadline;
  const run = { ...options, signal };
  const [control, results] = await Promise.all([
    controlsFor(platform, run),
    Promise.all(live.map(([, identifier]) => lookup(platform, identifier, run))),
  ]);
  const limited = control.limited ?? results.find(result => result.limited !== undefined)?.limited;
  if (limited !== undefined) {
    const until = limited > now.getTime() ? limited : now.getTime() + hour;
    await writeCache(directory, githubHoldFile, { until }).catch(() => {});
  }
  if (!control.ok) {
    for (const handle of [...answers.keys(), ...live.map(([handle]) => handle)]) {
      answers.set(handle, { state: 'check', why: 'control check failed' });
    }
    return answers;
  }
  const checkedAt = now.toISOString();
  for (const [index, [handle, identifier]] of live.entries()) {
    const { state } = results[index];
    const key = platform + '|' + identifier + '|' + (directory?.href ?? '');
    if (state === 'check') {
      const answer = { state: 'check', why: 'no clear answer in time' };
      answers.set(handle, answer);
      runCache.set(key, answer);
      continue;
    }
    answers.set(handle, { state, checkedAt, via: 'api' });
    runCache.set(key, { state, checkedAt, via: 'api' });
    await writeCache(directory, cacheFile(platform, identifier), { at: now.getTime(), state }).catch(() => {});
  }
  return answers;
}

function linkRow(platform, handle, why = 'link only') {
  return { platform: platform.id, handle, state: 'check', link: platform.link(handle), why };
}

function selectedPlatforms(extra) {
  return [...handlePlatforms, ...requestPlatforms.filter(platform => extra === true || Array.isArray(extra) && extra.includes(platform.id))];
}

export function pendingHandleRows(name, extra) {
  return selectedPlatforms(extra).map(platform => linkRow(platform, name, platform.auto ? 'still checking' : 'link only'));
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
  directory = cacheDir, now = new Date(), fetcher = globalThis.fetch, signal, budgetMs = platformBudgetMs,
  controls, extraPlatforms = false, env = process.env, freshRun = false,
} = {}) {
  const githubToken = typeof env?.DOMAIN_HOUND_GITHUB_TOKEN === 'string' && /^[\w-]{20,255}$/.test(env.DOMAIN_HOUND_GITHUB_TOKEN)
    ? env.DOMAIN_HOUND_GITHUB_TOKEN : null;
  const options = { directory, now, fetcher, signal, controls, githubToken,
    ...(freshRun && { controlRuns: new Map(), runAnswers: new Map() }) };
  const wanted = platform => rows.filter(row => (row.platforms ?? autoPlatforms).includes(platform));
  const perPlatform = new Map(await Promise.all(autoPlatforms.map(async platform => {
    const names = wanted(platform);
    if (!names.length) return [platform, new Map()];
    const started = performance.now();
    const deadline = AbortSignal.timeout(budgetMs);
    const exact = await platformBatch(platform, names.map(row => row.name), options, deadline);
    const taken = names.filter(row => row.variants && exact.get(row.name)?.state === 'taken');
    const left = budgetMs - (performance.now() - started);
    const variants = taken.length && left >= 300
      ? await platformBatch(platform, taken.flatMap(row => handleVariants(row.name)), options, deadline)
      : new Map();
    return [platform, { exact, variants, skipped: taken.length > 0 && left < 300 }];
  })));
  const result = new Map();
  for (const row of rows) {
    const platforms = selectedPlatforms(extraPlatforms);
    const entries = [];
    for (const platform of platforms) {
      const checked = (row.platforms ?? autoPlatforms).includes(platform.id) ? perPlatform.get(platform.id) : null;
      if (!platform.auto || !checked?.exact) {
        if (row.links === false) continue;
        entries.push(linkRow(platform, row.name, platform.auto ? 'not checked for this name' : 'link only'));
        continue;
      }
      const answer = checked.exact.get(row.name) ?? { state: 'check', why: 'no clear answer in time' };
      const entry = { platform: platform.id, handle: row.name, state: answer.state, link: platform.link(row.name),
        ...(answer.checkedAt && { checkedAt: answer.checkedAt }), ...(answer.why && { why: answer.why }) };
      if (row.variants && answer.state === 'taken') {
        entry.variants = handleVariants(row.name).map(handle => {
          const variant = checked.variants.get(handle) ?? { state: 'check', why: 'no clear answer in time' };
          return { handle, state: variant.state, link: platform.link(handle),
            ...(variant.checkedAt && { checkedAt: variant.checkedAt }) };
        });
      }
      entries.push(entry);
    }
    result.set(row.name, entries);
  }
  return result;
}

// "GitHub taken · npm no public profile found · Bluesky taken; check yourself: YouTube, X, …".
export function handleSummary(entries, { limit = Infinity, manualLimit = Infinity, ordered = false } = {}) {
  if (!Array.isArray(entries) || !entries.length) return null;
  const checked = entries.filter(entry => entry.state !== 'check');
  const open = entries.filter(entry => entry.state === 'check');
  if (ordered) {
    const shown = new Set([...entries.slice(0, 2), ...checked.slice(0, 2)]);
    for (const entry of entries) {
      if (shown.size === 4) break;
      shown.add(entry);
    }
    const states = entries.filter(entry => shown.has(entry))
      .map(entry => entry.platform + ' ' + handleStates[entry.state].toLowerCase()).join(', ');
    const more = entries.length - shown.size;
    return states + (more ? ' (' + more + ' more on the page)' : '');
  }
  const shown = checked.slice(0, limit).map(entry => entry.platform + ' ' + handleStates[entry.state].toLowerCase());
  const manual = open.slice(0, manualLimit);
  const more = checked.length - shown.length + open.length - manual.length;
  return [shown.join(' · '), manual.length ? 'check yourself: ' + manual.map(entry => entry.platform).join(', ') : '',
    more > 0 ? '(' + more + ' more on the page)' : ''].filter(Boolean).join('; ');
}
