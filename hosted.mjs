import { setTimeout as wait } from 'node:timers/promises';
import { checkGooglePlayNames, checkSocialHandles, embedChecksEnabled, handleLabel, handleStates, publicProfiles } from './clis/domain-check/handles.mjs';
import { googlePlayLabel, googlePlayLinkLabel, playSearchLink } from './clis/domain-check/google-play.mjs';
import { normalizeName } from './clis/domain-check/name-search.mjs';
import { searchApps } from './clis/domain-check/triage-sources.mjs';

export const hostedBase = 'https://domainhound-mcp.domainhound.workers.dev';
export class HostedRateLimit extends Error {}

const validCheck = body => body?.version === 1 && typeof body.query?.ascii === 'string' &&
  Array.isArray(body.domains) && body.domains.every(row => typeof row.domain === 'string' &&
    ['available', 'taken', 'unknown'].includes(row.status) && Array.isArray(row.prices)) && body.choice;
const validDetails = body => body?.version === 1 && body.appStore && body.googlePlay &&
  Array.isArray(body.trademarks?.us?.marks) && Array.isArray(body.handles);
const validGeneration = body => body?.version === 2 && ['initial', 'final'].includes(body.stage) && Array.isArray(body.names);

export function hostedClient(version, { env = process.env, fetchFn = fetch, apple = searchApps } = {}) {
  if (env.DOMAIN_HOUND_LOCAL === '1') return null;
  let base;
  try {
    base = new URL(env.DOMAIN_HOUND_API_URL || hostedBase);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    if (base.username || base.password || (base.protocol !== 'https:' && !(loopback && base.protocol === 'http:'))) return null;
  } catch {
    return null;
  }

  async function read(path, { body, params, timeout, signal } = {}) {
    const url = new URL(path, base);
    if (params) url.search = new URLSearchParams(params).toString();
    const res = await fetchFn(url, {
      redirect: 'error',
      headers: { 'X-Domain-Hound-Client': 'mcp/' + version, ...(body && { 'Content-Type': 'application/json' }) },
      ...(body && { method: 'POST', body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      if (res.status === 429) throw new HostedRateLimit();
      throw new Error('Hosted check unavailable');
    }
    return res.json();
  }

  const get = async (name, signal) => {
    const body = await read('/v1/check', { params: { name }, timeout: 5600, signal });
    if (!validCheck(body)) throw new Error('Invalid hosted check');
    return body;
  };

  async function recoverApple(app, name, signal) {
    if (app?.status !== 'unknown' || app.reason !== 'rate-limited') return app;
    const label = normalizeName(name);
    if (!label) return app;
    const checked = await apple(label, name, { signal: AbortSignal.any([signal, AbortSignal.timeout(2800)]), fetcher: fetchFn })
      .catch(() => null);
    if (!Array.isArray(checked)) return app;
    return { ...app, status: checked.length ? 'taken' : 'no_match_found', reason: null,
      matches: checked.map(({ name, url }) => ({ name, url })), checkedAt: new Date().toISOString(), source: 'local' };
  }

  async function recoverNameChecks(entries, signal) {
    const enabled = embedChecksEnabled(env);
    const definite = value => ['taken', 'not-found', 'not-seen'].includes(value);
    const checked = entries.filter(entry => Array.isArray(entry.nameChecks?.handles));
    const instagramAnswers = new Map(checked.flatMap(({ name, nameChecks }) => {
      const instagram = nameChecks.handles.find(row => row.platform === 'Instagram');
      return definite(instagram?.state) ? [[instagram.handle ?? normalizeName(name), instagram]] : [];
    }));
    const profiles = checked.flatMap(({ name, nameChecks }) => Object.keys(publicProfiles).flatMap(platform => {
      const row = nameChecks.handles.find(row => row.platform === platform);
      const oldThreadsMissing = platform === 'Threads' && row?.state === 'not-found' && row.why !== 'no Instagram account';
      if ((enabled || platform === 'YouTube') && definite(row?.state) && !oldThreadsMissing) return [];
      const handle = row?.handle ?? normalizeName(name);
      return handle ? [{ platform, handle, row, nameChecks }] : [];
    }));
    const wanted = new Map();
    for (const { handle, platform } of profiles) {
      if (!wanted.has(handle)) wanted.set(handle, new Set());
      wanted.get(handle).add(platform);
    }
    const rows = [...wanted].map(([name, platforms]) => ({ name, platforms: [...platforms], links: false }));
    const play = checked.filter(({ nameChecks }) => !enabled || !definite(nameChecks.googlePlay?.status));
    const options = { fetcher: fetchFn, env, signal };
    const [handles, playResults] = await Promise.all([
      checkSocialHandles(rows, { ...options, instagramAnswers, extraPlatforms: ['Reddit', 'Twitch'] }).catch(() => null),
      checkGooglePlayNames(play.map(({ name }) => name), options).catch(() => null),
    ]);
    for (const { platform, handle, row, nameChecks } of profiles) {
      const result = handles?.get(handle)?.find(result => result.platform === platform);
      if (!result) continue;
      const { linkLabel, seenYear, source, ...prior } = row ?? {};
      const profile = { ...prior, ...result, label: handleLabel(result), checkedAt: result.checkedAt ?? null,
        why: result.why ?? null, ...(definite(result.state) && { source: 'local' }) };
      nameChecks.handles = row ? nameChecks.handles.map(entry => entry === row ? profile : entry)
        : [...nameChecks.handles, profile];
    }
    for (const { name, nameChecks } of play) {
      const result = playResults?.get(name);
      const status = result?.state ?? 'unknown';
      nameChecks.googlePlay = {
        ...nameChecks.googlePlay, status, checkedAt: result?.checkedAt ?? null,
        label: enabled ? handleStates[status] : googlePlayLabel,
        link: nameChecks.googlePlay?.link ?? playSearchLink(name), linkLabel: googlePlayLinkLabel,
        why: enabled ? result?.why ?? (status === 'unknown' ? 'no clear answer in time' : null) : 'no public search',
        ...(definite(status) && { source: 'local' }),
      };
    }
  }

  return {
    async check(name, extraEndings, signal) {
      const [main, ...extras] = await Promise.all([get(name, signal),
        ...extraEndings.map(ending => get(normalizeName(name) + '.' + ending, signal))]);
      let nameChecks = null;
      if (typeof main.details?.id === 'string') {
        nameChecks = await read('/v1/check/details', {
          params: { id: main.details.id }, timeout: 6600, signal,
        }).then(body => validDetails(body) ? body : null, () => null);
      }
      if (nameChecks) {
        await Promise.all([
          recoverApple(nameChecks.appStore, main.query.name, signal).then(app => { nameChecks.appStore = app; }),
          recoverNameChecks([{ name: main.query.name, nameChecks }], signal),
        ]);
      }
      const { details, ...answer } = main;
      return { ...answer, domains: [...main.domains, ...extras.flatMap(extra => extra.domains)], nameChecks,
        complete: main.complete && extras.every(extra => extra.complete) };
    },

    async generate(args, signal) {
      const generation = await read('/v1/generate', { body: args, timeout: 9400, signal });
      if (!validGeneration(generation)) throw new Error('Invalid hosted generation');
      if (generation.stage === 'final') await recoverNameChecks(generation.names, signal);
      return generation;
    },

    async finishGeneration(initial) {
      const { id, pollAfterMs } = initial.details;
      const signal = AbortSignal.timeout(34_000);
      let delay = pollAfterMs;
      while (!signal.aborted) {
        await wait(Math.max(500, Math.min(3000, Number(delay) || 1500)), undefined, { signal });
        const body = await read('/v1/generate/details', { body: { id }, timeout: 4500, signal });
        if (body?.stage === 'pending') {
          delay = body.retryAfterMs;
          continue;
        }
        if (!validGeneration(body) || body.stage !== 'final') throw new Error('Invalid hosted generation details');
        await Promise.all([
          recoverNameChecks(body.names, signal),
          ...body.names.map(async entry => {
            const app = await recoverApple(entry.nameChecks?.appStore ?? entry.appStore, entry.name, signal);
            if (entry.nameChecks) entry.nameChecks.appStore = app;
            if (app) entry.appStore = app;
          }),
        ]);
        return body;
      }
      throw new Error('Hosted generation expired');
    },
  };
}
