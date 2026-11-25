import { Resolver } from 'node:dns/promises';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { saleSignal } from './parking.mjs';
import { cacheDir, mapLimit, readCache, writeCache } from './cache.mjs';

export const bootstrapUrl = 'https://data.iana.org/rdap/dns.json';
// A conclusive registry answer is reused: a registration for a day, an absence for an hour. DNS still runs first,
// so a name registered since then shows up through its name servers.
export const takenLifetime = 24 * 3_600_000;
export const freeLifetime = 3_600_000;
const identityDigital = 'https://rdap.identitydigital.services';
const rdapRateLimit = 'Registry RDAP returned HTTP 429';
// A rate-limited registry host is left alone for its Retry-After in this process and the next.
const legacyIdentityCooldown = 'rdap-identity-digital-cooldown.json';
const cooldownFile = origin => 'rdap-cooldown-' + new URL(origin).hostname + '.json';

export async function registryCooldown(origin, directory) {
  const current = await readCache(directory, cooldownFile(origin));
  const legacy = new URL(origin).origin === identityDigital ? await readCache(directory, legacyIdentityCooldown) : null;
  return Math.max(current?.until || 0, legacy?.until || 0);
}
// The fallback steps (registry WHOIS, then DNS) keep this much of the lookup time.
const fallbackReserve = 800;

// Registry WHOIS servers as listed in the IANA Root Zone Database, so the fallback needs no whois.iana.org referral:
// https://www.iana.org/domains/root/db/ai.html, https://www.iana.org/domains/root/db/io.html and
// https://www.iana.org/domains/root/db/me.html (Identity Digital runs all three; checked 2026-11-25).
export const documentedWhois = new Map([
  ['ai', 'whois.nic.ai'],
  ['io', 'whois.nic.io'],
  ['me', 'whois.nic.me'],
]);
// Queries to one WHOIS host start at least this far apart. Identity Digital's hosts get the wider gap: they stand in
// for an RDAP service that is already rate limiting this machine.
export const whoisSpacing = { identity: 400, other: 150 };
// A WHOIS host that answers with a rate-limit notice is left alone this long, in this process and the next.
export const whoisCooldownMs = 15 * 60_000;
const whoisCooldownFile = host => 'whois-cooldown-' + host + '.json';
const whoisLimitWords = /\b(?:rate limit|limit exceeded|exceeded (?:the |your )?(?:query |request )?(?:limit|quota)|too many (?:queries|requests))\b/i;
const whoisTurns = new Map();

function whoisPacer(host) {
  if (!whoisTurns.has(host)) whoisTurns.set(host, { next: 0, limitedUntil: 0 });
  return whoisTurns.get(host);
}

// One query at a time per host, each start at least the spacing after the previous one. Resolves to a release
// function, or null when the slot comes too late or the host is cooling down.
async function whoisTurn(host, timeLeft, pause, directory) {
  const pacer = whoisPacer(host);
  if (!pacer.loaded) {
    pacer.loaded = readCache(directory, whoisCooldownFile(host)).then(saved => {
      pacer.limitedUntil = Math.max(pacer.limitedUntil, saved?.until || 0);
    });
  }
  const previous = pacer.tail ?? Promise.resolve();
  let release;
  pacer.tail = new Promise(resolve => { release = resolve; });
  await Promise.all([pacer.loaded, previous]);
  const now = Date.now();
  const spacing = [...documentedWhois.values()].includes(host) ? whoisSpacing.identity : whoisSpacing.other;
  const start = Math.max(now, pacer.next);
  // Leave at least 300 ms for the query itself.
  if (pacer.limitedUntil > now || start - now + 300 > timeLeft()) {
    release();
    return null;
  }
  pacer.next = start + spacing;
  if (start > now) await pause(start - now);
  if (pacer.limitedUntil > Date.now()) {
    release();
    return null;
  }
  return release;
}

async function whoisLimited(host, reply, directory) {
  if (!whoisLimitWords.test(reply.split(/^\s*Terms of Use:/im, 1)[0])) return false;
  const pacer = whoisPacer(host);
  pacer.limitedUntil = Math.max(pacer.limitedUntil, Date.now() + whoisCooldownMs);
  await writeCache(directory, whoisCooldownFile(host), { until: pacer.limitedUntil }).catch(() => {});
  return true;
}

// For tests: forget the pacing state of earlier lookups in this process.
export function resetWhoisPacing() {
  whoisTurns.clear();
}

const overrides = new Map([
  ['co', 'https://rdap.registry.co/co/'],
  ['io', identityDigital + '/rdap/'],
  ['me', identityDigital + '/rdap/'],
  ['no', 'https://rdap.norid.no/'],
  ['so', 'https://rdap.nic.so/'],
]);

export function rdapBase(tld, services) {
  if (tld === 'co.uk') tld = 'uk';
  const urls = services?.find(([tlds]) => tlds.includes(tld))?.[1];
  return overrides.get(tld) ?? urls?.find(url => url.startsWith('https://')) ?? urls?.[0];
}

export function rdapDomainUrl(base, domain) {
  return base.replace(/\/?$/, '/') + 'domain/' + encodeURIComponent(domain);
}

async function bootstrap(directory, fetcher, now, timeLeft) {
  const saved = await readCache(directory, 'iana.json');
  const day = 86_400_000;
  const age = now - saved?.savedAt;
  if (Array.isArray(saved?.value) && age >= 0 && age < day) return saved.value;
  try {
    const wait = Math.min(1800, timeLeft());
    if (wait <= 0) return Array.isArray(saved?.value) ? saved.value : null;
    const reply = await fetcher(bootstrapUrl, { signal: AbortSignal.timeout(wait) });
    if (reply.ok) {
      const { services } = await reply.json();
      if (Array.isArray(services)) {
        await writeCache(directory, 'iana.json', { savedAt: now.getTime(), value: services }).catch(() => {});
        return services;
      }
    }
  } catch { /* A previously fetched IANA bootstrap can still route lookups. */ }
  return Array.isArray(saved?.value) ? saved.value : null;
}

export function systemResolveNs(domain) {
  // A dedicated resolver uses the machine's DNS servers and lets us cancel just this query.
  const resolver = new Resolver({ timeout: 1500, tries: 1 });
  const timer = setTimeout(() => resolver.cancel(), 1500);
  return resolver.resolveNs(domain).finally(() => clearTimeout(timer));
}

function unknown(source, reason) {
  return { status: 'unknown', source, reason };
}

// A registry that exposes premium or reserved status says so in plain words. "All rights reserved" never counts.
const reservedWords = /\b(?:(?:domain|name) (?:is |has been )?reserved|reserved (?:domain|name)|reserved (?:by|for) (?:the )?registry|not available for registration)\b/i;
const premiumWords = /\bregistry premium\b|\bpremium (?:domain|name|price|pricing|tier)\b|\b(?:domain|name) is premium\b/i;

export function registrySignal(text) {
  const value = String(text ?? '');
  if (reservedWords.test(value)) return 'reserved';
  return value.split('\n').some(line => premiumWords.test(line) && !/\b(?:not|non[- ]|no)\s*(?:an?\s+)?premium\b/i.test(line))
    ? 'premium' : null;
}

// Only the human-readable fields of an RDAP error document are read.
export function rdapSignal(body) {
  let data;
  try { data = JSON.parse(body); } catch { return null; }
  const text = [data?.title, data?.description, ...(Array.isArray(data?.notices) ? data.notices : [])
    .flatMap(notice => [notice?.title, notice?.description])].flat().filter(value => typeof value === 'string');
  return registrySignal(text.join('\n'));
}

function signalled(source, signal) {
  if (signal === 'reserved') return { status: 'unknown', source, signal, reason: 'Registry lists it as reserved' };
  return { status: 'free', source, ...(signal && { signal }) };
}

// The recursive DNS answer: name servers mean registered; otherwise a reason and the DNS error code.
async function dnsStatus(domain, resolveNs) {
  try {
    const nameservers = await resolveNs(domain);
    if (nameservers.length) return { status: 'taken', source: 'dns', nameservers, ...saleSignal(nameservers) };
    return { reason: 'DNS returned no name servers', code: null };
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : null;
    if (['ENOTFOUND', 'ENODATA'].includes(code)) return { reason: 'DNS returned no name servers', code };
    if (['ETIMEOUT', 'ECANCELLED'].includes(code)) return { reason: 'DNS timed out', code };
    return { reason: 'DNS query failed', code };
  }
}

// Ask the ending's own authoritative name servers whether they delegate the name. NXDOMAIN means it is not in the
// zone (likely free, though a registered name without name servers looks the same); a referral or an answer means it
// is delegated (likely taken). Only a likelihood: a registry or shop still settles it.
const tldServers = new Map();
export async function systemAuthoritativeNs(domain, timeout) {
  if (!(timeout >= 150)) return null;
  const deadline = Date.now() + timeout;
  const left = () => Math.max(1, deadline - Date.now());
  const tld = domain.split('.').at(-1);
  const lookup = new Resolver({ timeout: Math.min(800, timeout), tries: 1 });
  const stop = setTimeout(() => lookup.cancel(), timeout);
  let direct;
  let stopDirect;
  try {
    if (!tldServers.has(tld)) {
      tldServers.set(tld, lookup.resolveNs(tld).then(async hosts => (await Promise.all(hosts.slice(0, 3)
        .map(host => lookup.resolve4(host).catch(() => [])))).flat().slice(0, 4)).catch(() => []));
    }
    const servers = await tldServers.get(tld);
    if (!servers.length) {
      tldServers.delete(tld);
      return null;
    }
    direct = new Resolver({ timeout: left(), tries: 1 });
    direct.setServers(servers);
    stopDirect = setTimeout(() => direct.cancel(), left());
    await direct.resolveSoa(domain);
    return 'taken';
  } catch (error) {
    if (!direct) return null;
    if (error?.code === 'ENOTFOUND') return 'free';
    if (error?.code === 'ENODATA') return 'taken';
    return null;
  } finally {
    clearTimeout(stop);
    clearTimeout(stopDirect);
  }
}

// The recursive answer as a likelihood, used when the authoritative check is not available.
function recursiveLikely(code) {
  return code === 'ENOTFOUND' ? 'free' : null;
}

export function systemQueryWhois(host, query, timeout) {
  if (timeout <= 0) return Promise.resolve('');
  return new Promise(resolve => {
    const socket = createConnection({ host, port: 43 });
    let reply = '';
    function finish(value) {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    }
    const timer = setTimeout(() => finish(''), timeout);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(query + '\r\n'));
    socket.on('data', chunk => {
      reply += chunk;
      if (reply.length > 128 * 1024) finish('');
    });
    socket.on('end', () => finish(reply));
    socket.on('error', () => finish(''));
  });
}

async function lookupWhois(domain, tld, query, timeLeft, referrals, { pause = delay, directory } = {}) {
  if (tld === 'co.uk') tld = 'uk';
  let host = documentedWhois.get(tld);
  if (!host) {
    if (!referrals.has(tld)) referrals.set(tld, query('whois.iana.org', tld, Math.min(1150, timeLeft())));
    const iana = await referrals.get(tld);
    host = iana.match(/^(?:refer|whois):[ \t]*([a-z\d.-]+)[ \t\r]*$/im)?.[1];
  }
  if (!host) return unknown('whois', 'IANA WHOIS has no registry referral');
  const release = await whoisTurn(host, timeLeft, pause, directory);
  if (!release) {
    return unknown('whois', whoisPacer(host).limitedUntil > Date.now() ? 'Registry WHOIS rate limit' : 'Registry WHOIS timed out');
  }
  let result;
  try {
    const timeout = Math.min(1500, timeLeft());
    if (timeout <= 0) return unknown('whois', 'Registry WHOIS timed out');
    result = String(await query(host, domain, timeout) ?? '');
    if (await whoisLimited(host, result, directory)) return unknown('whois', 'Registry WHOIS rate limit');
  } finally {
    release();
  }
  const name = result.match(/^\s*Domain(?: Name)?:[ \t]*(\S+)/im)?.[1];
  // DENIC and EURid echo the queried name on negative answers.
  const statusFree = /^\s*Status:[ \t]*free\s*$/im.test(result)
    || tld === 'eu' && name?.toLowerCase() === domain && /^\s*Status:[ \t]*available\s*$/im.test(result);
  if (name?.toLowerCase() === domain && !statusFree) {
    const expiry = result.match(/^Registry Expiry Date:[ \t]*(\S+)/im)?.[1];
    const expires = Number.isFinite(Date.parse(expiry)) ? new Date(expiry).toISOString() : null;
    return { status: 'taken', source: 'whois', ...(expires && { expires }) };
  }
  const signal = registrySignal(result);
  if (signal) return signalled('whois', signal);
  if (statusFree || /^\s*(?:(?:%|>>>|#)\s*)?(?:no (?:match|entries found|data found|object found)|(?:domain\s+)?not found|no such domain|the queried object does not exist|domain "[^"\s]+" not found)/im.test(result)) {
    return { status: 'free', source: 'whois' };
  }
  return unknown('whois', 'Registry WHOIS returned no definitive answer');
}

// Retry-After as milliseconds from now: delta seconds ("120") or an HTTP date. Null when absent or unreadable.
export function retryAfterMs(value, now = Date.now()) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const duration = Number(text) * 1000;
    return Number.isSafeInteger(now + duration) ? duration : null;
  }
  if (!/[a-z]/i.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function retryWait(value, attempt, limited = false) {
  const backoff = (limited ? 650 : 150) * 2 ** attempt;
  return Math.max(backoff, retryAfterMs(value) ?? 0);
}

async function lookupRdap(base, domain, fetcher, timeLeft, readExpiry, pause, registry, attempts, directory) {
  let last = unknown('rdap', 'Registry lookup timed out');
  for (let attempt = 0; attempt < attempts && timeLeft() > 0; attempt++) {
    const now = Date.now();
    // A queued request never goes to a host that is cooling down.
    if (registry.limitedUntil > now) return unknown('rdap', rdapRateLimit);
    const startsAt = Math.max(registry.retryAt, registry.nextStart, now);
    if (startsAt - now >= timeLeft()) return last;
    registry.nextStart = startsAt + registry.spacing;
    if (startsAt > now) await pause(startsAt - now);
    if (registry.retryAt > startsAt) {
      const wait = registry.retryAt - Date.now();
      if (wait >= timeLeft()) return last;
      if (wait > 0) await pause(wait);
    }
    if (registry.limitedUntil > Date.now()) return unknown('rdap', rdapRateLimit);
    if (timeLeft() <= 0) return last;
    let wait = retryWait(null, attempt);
    try {
      const response = await fetcher(rdapDomainUrl(base, domain), {
        headers: { Accept: 'application/rdap+json, application/json' },
        signal: AbortSignal.timeout(Math.min(1900, timeLeft() || 1)),
      });
      const { status } = response;
      if (status === 200) {
        const data = await response.json().catch(() => null);
        const expires = readExpiry && Array.isArray(data?.events)
          ? data.events.find(event => event?.eventAction === 'expiration')?.eventDate : null;
        const nameservers = Array.isArray(data?.nameservers)
          ? data.nameservers.map(row => row?.ldhName).filter(value => typeof value === 'string') : [];
        return { status: 'taken', source: 'rdap', ...saleSignal(nameservers),
          ...(Number.isFinite(Date.parse(expires)) && { expires }) };
      }
      if (status === 404) {
        // A 404 says only that the name is not registered. It is not a standard-price signal; a registry
        // that exposes premium or reserved status in the error document is read here.
        const body = await response.text().catch(() => '');
        return signalled('rdap', rdapSignal(body.slice(0, 16_384)));
      }
      await response.body?.cancel().catch(() => {});
      last = unknown('rdap', 'Registry RDAP returned HTTP ' + status);
      if (status !== 429 && status < 500) return last;
      const header = response.headers?.get('retry-after');
      wait = retryWait(header, attempt, status === 429);
      if (status === 429 || status === 503) registry.retryAt = Math.max(registry.retryAt, Date.now() + wait);
      // The host's cooldown holds for this process and, through the cache, for the next lookups too.
      if (status === 429 || (status === 503 && retryAfterMs(header) != null)) {
        const outlasts = wait >= timeLeft();
        // Queued requests see the cooldown before the cache write finishes.
        if (outlasts) registry.limitedUntil = Math.max(registry.limitedUntil, registry.retryAt);
        await writeCache(directory, cooldownFile(base), { until: registry.retryAt }).catch(() => {});
        if (outlasts) return last;
      }
    } catch {
      last = unknown('rdap', 'Registry RDAP did not respond');
    }
    if (attempt + 1 === attempts || wait + 50 >= timeLeft()) break;
    await pause(wait);
  }
  return last;
}

export async function lookupRegistrations(candidates, {
  directory = cacheDir, fetcher = globalThis.fetch, resolveNs = systemResolveNs, queryWhois, authoritativeNs,
  now = new Date(), timeLeft = () => 8500, dnsFirst = true, readExpiry = false, pause = delay,
  onResult = () => {}, concurrency = 4, rdapAttempts = 3,
} = {}) {
  const whois = queryWhois ?? systemQueryWhois;
  // The fallbacks use the system network only in live use: a caller that injects its own network gets no other.
  const fallbackWhois = queryWhois ?? (fetcher === globalThis.fetch ? systemQueryWhois : null);
  const dnsSignal = authoritativeNs ?? (resolveNs === systemResolveNs ? systemAuthoritativeNs : null);
  const reserve = Math.min(fallbackReserve, Math.max(0, timeLeft() - 1500));
  const rdapLeft = () => timeLeft() - reserve;
  const services = candidates.some(({ tld }) => !rdapBase(tld))
    ? bootstrap(directory, fetcher, now, timeLeft) : null;
  const referrals = new Map();
  const pending = candidates.map(async (candidate, index) => {
    const dns = dnsFirst ? await dnsStatus(candidate.domain, resolveNs) : null;
    return { candidate, index, dns };
  });
  const results = [];
  function record({ candidate, index, dns }, registry) {
    if (registry.status === 'unknown' && dns?.reason) registry.reason = dns.reason + '; ' + registry.reason;
    results[index] = registry;
    onResult(candidate, registry);
  }
  async function finish(row, result, filename) {
    record(row, result);
    if (filename && ['taken', 'free'].includes(result.status)) {
      await writeCache(directory, filename, { at: now.getTime(), result }).catch(() => {});
    }
  }
  // DNS as a likelihood when the registry stays silent: the ending's authoritative servers when available, else the
  // recursive answer from the first DNS step. Never a free result.
  async function dnsLikely(row) {
    const wait = Math.min(900, Math.floor(timeLeft()));
    if (dnsSignal && wait >= 150) {
      // The deadline holds even if a resolver never answers.
      let timer;
      const answer = await Promise.race([
        Promise.resolve().then(() => dnsSignal(row.candidate.domain, wait)).catch(() => null),
        new Promise(resolve => { timer = setTimeout(resolve, wait + 50, null); }),
      ]);
      clearTimeout(timer);
      if (answer === 'free' || answer === 'taken') return answer;
    }
    return recursiveLikely(row.dns?.code);
  }
  const records = pending.map(entry => entry.then(row => {
    if (row.dns?.status === 'taken') {
      record(row, row.dns);
      return null;
    }
    return row;
  }));
  // Start other registries independently, while .app and .dev share Google's limit.
  const registries = new Map();
  await Promise.all(candidates.map(async ({ tld }, index) => {
    const base = rdapBase(tld) ?? rdapBase(tld, await services);
    const origin = base ? new URL(base).origin : 'whois:' + tld;
    if (!registries.has(origin)) {
      // Google shares a burst limit across .app and .dev, even on healthy responses.
      const google = origin === 'https://pubapi.registry.google';
      const identity = origin === identityDigital;
      registries.set(origin, { jobs: [], retryAt: 0, nextStart: 0, limitedUntil: 0, identity,
        spacing: google ? 425 : 0, limit: google ? 1 : Math.min(concurrency, identity ? 2 : 4) });
    }
    registries.get(origin).jobs.push({ base, entry: records[index] });
  }));
  // Rows the registry left open, for the WHOIS and DNS fallbacks once every host has had its turn.
  const unsettled = [];
  await Promise.all([...registries].map(async ([origin, registry]) => {
    if (origin.startsWith('https:')) {
      registry.limitedUntil = await registryCooldown(origin, directory);
    }
    return mapLimit(registry.jobs, registry.limit, async ({ base, entry }) => {
      const row = await entry;
      if (!row) return;
      const { domain, tld } = row.candidate;
      const filename = dnsFirst ? 'rdap-' + domain + '.json' : null;
      const cached = filename && await readCache(directory, filename);
      const age = now - cached?.at;
      const lifetime = { taken: takenLifetime, free: freeLifetime }[cached?.result?.status] ?? 0;
      if (age >= 0 && age < lifetime) {
        record(row, { ...cached.result, checkedAt: new Date(cached.at).toISOString() });
        return;
      }
      const coolingDown = registry.identity && registry.limitedUntil > Date.now() && documentedWhois.has(tld) && fallbackWhois;
      const result = coolingDown || !base && await services
        ? await lookupWhois(domain, tld, coolingDown ? fallbackWhois : whois, timeLeft, referrals, { pause, directory })
          .catch(() => unknown('whois', 'Registry WHOIS did not respond'))
        : base ? await lookupRdap(base, domain, fetcher, rdapLeft, readExpiry, pause, registry, rdapAttempts, directory)
          : unknown('rdap', 'IANA RDAP bootstrap is unavailable');
      if (result.status === 'unknown' && !result.signal) unsettled.push({ row, result, filename, viaWhois: !base || coolingDown });
      else await finish(row, result, filename);
    });
  }));
  // Registry WHOIS (where IANA documents one for the ending) and the DNS likelihood run side by side per row, so a
  // slow WHOIS server never uses up the time of the DNS step. A WHOIS answer settles the row; DNS only suggests.
  await mapLimit(unsettled, 6, async ({ row, result, filename, viaWhois }) => {
    const { domain, tld } = row.candidate;
    // IANA lists RDAP as the sole registration service for Google's .app and .dev.
    const query = ['app', 'dev'].includes(tld) ? null : fallbackWhois;
    const [answer, likely] = await Promise.all([
      query && !viaWhois && timeLeft() > 600
        ? lookupWhois(domain, tld, query, () => timeLeft() - 300, referrals, { pause, directory })
          .catch(() => unknown('whois', 'Registry WHOIS did not respond')) : null,
      dnsLikely(row),
    ]);
    const settled = answer && (answer.status !== 'unknown' || answer.signal) ? answer
      : likely ? { ...result, likely, likelySource: 'dns' } : result;
    await finish(row, settled, filename);
  });
  return results;
}
