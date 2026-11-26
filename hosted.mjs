import { setTimeout as wait } from 'node:timers/promises';
import { checkGooglePlayNames, checkSocialHandles, embedChecksEnabled, handleLabel, handleStates, publicProfiles } from './clis/domain-check/handles.mjs';
import { googlePlayLabel, googlePlayLinkLabel, playSearchLink } from './clis/domain-check/google-play.mjs';
import { normalizeName } from './clis/domain-check/name-search.mjs';
import { rdapSignal } from './clis/domain-check/registry.mjs';
import { searchApps } from './clis/domain-check/triage-sources.mjs';

export const hostedBase = 'https://domainhound-mcp.domainhound.workers.dev';
// Page-only evidence. Symbols survive the internal object spreads and stay out of MCP JSON.
export const alternativeEndings = Symbol('alternative endings');
export class HostedRateLimit extends Error {}

export function hostedDebug(message, env = process.env) {
  if (env.DOMAIN_HOUND_DEBUG === '1') process.stderr.write('Domain Hound: ' + message + '\n');
}

class HostedRequestError extends Error {
  constructor(message, transient = false) {
    super(message);
    this.transient = transient;
  }
}

const validCheck = body => body?.version === 1 && typeof body.query?.ascii === 'string' &&
  Array.isArray(body.domains) && body.domains.every(row => typeof row.domain === 'string' &&
    ['available', 'taken', 'unknown'].includes(row.status) && Array.isArray(row.prices)) && body.choice;
const validDetails = body => body?.version === 1 && body.appStore && body.googlePlay &&
  Array.isArray(body.trademarks?.us?.marks) && Array.isArray(body.handles);
const validGeneration = body => body?.version === 2 && ['initial', 'final'].includes(body.stage) && Array.isArray(body.names);

// Only the IANA-listed Google Registry route for the returned .app or .dev domain is eligible.
async function observeRdap(row, ascii, fetchFn, signal) {
  if (row.status !== 'unknown' || !['dev', 'app'].includes(row.ending) ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(ascii) ||
      row.domain !== ascii + '.' + row.ending ||
      row.rdapUrl !== 'https://pubapi.registry.google/rdap/domain/' + row.domain) return null;
  try {
    const timeout = AbortSignal.timeout(1600);
    const response = await fetchFn(row.rdapUrl, { redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { Accept: 'application/rdap+json, application/json' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const age = Number(response.headers.get('age') ?? 0);
    const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (![200, 404].includes(response.status) || !Number.isFinite(age) || age > 0 ||
        !['application/rdap+json', 'application/json'].includes(type)) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const json = await response.text();
    const body = JSON.parse(json);
    if (response.status === 200) {
      return body?.objectClassName === 'domain' && typeof body.ldhName === 'string' &&
        body.ldhName.toLowerCase().replace(/\.$/, '') === row.domain &&
        !body.status?.some?.(value => /^(reserved|not available)$/i.test(value)) ? row.ending + ':taken' : null;
    }
    const hint = rdapSignal(json);
    return body?.errorCode === 404 && hint !== 'reserved'
      ? row.ending + ':' + (hint ?? 'available') : null;
  } catch {
    return null;
  }
}

export function hostedClient(version, { env = process.env, fetchFn = fetch, apple = searchApps } = {}) {
  if (env.DOMAIN_HOUND_LOCAL === '1') return null;
  let base;
  try {
    base = new URL(env.DOMAIN_HOUND_API_URL || hostedBase);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    if (base.username || base.password || (base.protocol !== 'https:' && !(loopback && base.protocol === 'http:'))) {
      throw new Error('Invalid hosted API origin');
    }
  } catch {
    hostedDebug('Hosted API origin is invalid; using the local check.', env);
    return null;
  }

  async function request(path, { body, params, timeout, signal, valid } = {}) {
    const url = new URL(path, base);
    if (params) url.search = new URLSearchParams(params).toString();
    const deadline = AbortSignal.timeout(timeout);
    let res;
    try {
      res = await fetchFn(url, {
        redirect: 'error',
        headers: { 'X-Domain-Hound-Client': 'mcp/' + version, ...(body && { 'Content-Type': 'application/json' }) },
        ...(body && { method: 'POST', body: JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
    } catch (error) {
      const code = error?.cause?.code;
      const reason = signal?.aborted ? 'lookup stopped' : deadline.aborted ? 'request timed out'
        : 'connection failed' + (/^(?:E[A-Z_0-9]+|UND_ERR_[A-Z_0-9]+)$/.test(code ?? '') ? ' (' + code + ')' : '');
      throw new HostedRequestError(reason, true);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      if (res.status === 429) throw new HostedRateLimit('HTTP 429');
      throw new HostedRequestError('HTTP ' + res.status, res.status === 408 || res.status >= 500);
    }
    const answer = await res.json().catch(() => {
      throw new HostedRequestError(signal?.aborted ? 'lookup stopped' : deadline.aborted
        ? 'response timed out' : 'invalid or incomplete JSON response', true);
    });
    if (valid && !valid(answer)) throw new HostedRequestError('response did not match the API format', true);
    return answer;
  }

  async function read(path, options, retry = false) {
    for (let attempt = 1; ; attempt++) {
      const started = performance.now();
      try {
        return await request(path, options);
      } catch (error) {
        const retrying = retry && attempt === 1 && error.transient && !options.signal?.aborted;
        hostedDebug(path + ' attempt ' + attempt + ' failed after ' + Math.round(performance.now() - started)
          + ' ms (' + (error instanceof HostedRequestError || error instanceof HostedRateLimit ? error.message : 'unexpected error')
          + ')' + (retrying ? '; retrying' : ''), env);
        if (!retrying) throw error;
        await wait(200, undefined, { signal: options.signal });
      }
    }
  }

  async function get(name, signal) {
    const params = new URLSearchParams({ name });
    const options = { params, timeout: 4200, signal, valid: validCheck };
    const initial = await read('/v1/check', options, true);
    const seen = (await Promise.all(initial.domains.map(row => observeRdap(row, initial.query.ascii, fetchFn, signal)))).filter(Boolean);
    if (!seen.length) return initial;
    seen.forEach(observation => params.append('seen', observation));
    return read('/v1/check', options).catch(() => initial);
  }

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
    async check(name, extraEndings, signal, onDomains) {
      const [main, ...extras] = await Promise.all([get(name, signal),
        ...extraEndings.map(ending => get(normalizeName(name) + '.' + ending, signal))]);
      const { details, ...answer } = main;
      answer.domains = [...main.domains, ...extras.flatMap(extra => extra.domains)];
      answer.complete = main.complete && extras.every(extra => extra.complete);
      const exact = main.query.exactDomain;
      const needsAlternatives = exact && main.domains.length === 1 && main.domains[0].domain === exact && main.domains[0].status === 'taken';
      // Run alongside the name checks. An unavailable comparison must not discard the exact answer.
      const alternatives = needsAlternatives ? get(main.query.ascii, signal).then(comparison =>
        comparison.query.ascii === main.query.ascii ? {
          domains: comparison.domains, choice: comparison.choice, priceSnapshot: comparison.priceSnapshot,
          share: comparison.share, complete: comparison.complete,
        } : null).catch(() => null) : null;
      let nameChecks = null;
      if (typeof details?.id === 'string') {
        onDomains?.(answer);
        nameChecks = await read('/v1/check/details', {
          params: { id: details.id }, timeout: 5300, signal: AbortSignal.any([signal, AbortSignal.timeout(5700)]), valid: validDetails,
        }, true).catch(() => null);
      } else {
        hostedDebug('/v1/check did not provide a name-check token', env);
      }
      if (nameChecks) {
        const recovered = await Promise.allSettled([
          recoverApple(nameChecks.appStore, main.query.name, signal).then(app => { nameChecks.appStore = app; }),
          recoverNameChecks([{ name: main.query.name, nameChecks }], signal),
        ]);
        for (const [index, result] of recovered.entries()) {
          if (result.status === 'rejected') hostedDebug('Optional ' + (index ? 'handle' : 'App Store') + ' recovery failed', env);
        }
      }
      return { ...answer, ...(needsAlternatives && { [alternativeEndings]: await alternatives }), nameChecks };
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
