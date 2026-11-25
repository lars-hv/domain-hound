import { Resolver } from 'node:dns/promises';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { saleSignal } from './parking.mjs';
import { cacheDir, mapLimit, readCache, writeCache } from './cache.mjs';

export const bootstrapUrl = 'https://data.iana.org/rdap/dns.json';
const cachedEndings = new Set(['co', 'me', 'io', 'app', 'dev']);
const registrationLifetime = 5 * 60_000;
const identityDigital = 'https://rdap.identitydigital.services';
const identityDigitalCooldown = 'rdap-identity-digital-cooldown.json';
const rdapRateLimit = 'Registry RDAP returned HTTP 429';

const overrides = new Map([
  ['co', 'https://rdap.registry.co/co/'],
  ['io', identityDigital + '/rdap/'],
  ['me', identityDigital + '/rdap/'],
  ['no', 'https://rdap.norid.no/'],
  ['so', 'https://rdap.nic.so/'],
]);

export function rdapBase(tld, services) {
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

async function dnsStatus(domain, resolveNs) {
  try {
    const nameservers = await resolveNs(domain);
    if (nameservers.length) return { status: 'taken', source: 'dns', nameservers, ...saleSignal(nameservers) };
    return 'DNS returned no name servers';
  } catch (error) {
    if (['ENOTFOUND', 'ENODATA'].includes(error?.code)) return 'DNS returned no name servers';
    if (['ETIMEOUT', 'ECANCELLED'].includes(error?.code)) return 'DNS timed out';
    return 'DNS query failed';
  }
}

function whois(host, query, timeout) {
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

async function lookupWhois(domain, tld, query, timeLeft, referrals) {
  if (!referrals.has(tld)) referrals.set(tld, query('whois.iana.org', tld, Math.min(1150, timeLeft())));
  const iana = await referrals.get(tld);
  const host = iana.match(/^(?:refer|whois):[ \t]*([a-z\d.-]+)[ \t\r]*$/im)?.[1];
  if (!host) return unknown('whois', 'IANA WHOIS has no registry referral');
  const timeout = Math.min(1500, timeLeft());
  if (timeout <= 0) return unknown('whois', 'Registry WHOIS timed out');
  const result = await query(host, domain, timeout);
  const name = result.match(/^\s*Domain Name:[ \t]*(\S+)/im)?.[1];
  if (name?.toLowerCase() === domain) {
    const expiry = result.match(/^Registry Expiry Date:[ \t]*(\S+)/im)?.[1];
    const expires = Number.isFinite(Date.parse(expiry)) ? new Date(expiry).toISOString() : null;
    return { status: 'taken', source: 'whois', ...(expires && { expires }) };
  }
  if (/^\s*(?:(?:%|>>>|#)\s*)?(?:no (?:match|entries found|data found|object found)|(?:domain\s+)?not found|no such domain|the queried object does not exist)/im.test(result)) {
    return { status: 'free', source: 'whois' };
  }
  return unknown('whois', 'Registry WHOIS returned no definitive answer');
}

function retryWait(value, attempt, limited = false) {
  const backoff = (limited ? 650 : 150) * 2 ** attempt;
  return Math.max(backoff, /^\d+$/.test(value ?? '') ? Number(value) * 1000 : Date.parse(value) - Date.now() || 0);
}

async function lookupRdap(base, domain, fetcher, timeLeft, readExpiry, pause, registry, attempts, directory) {
  let last = unknown('rdap', 'Registry lookup timed out');
  for (let attempt = 0; attempt < attempts && timeLeft() > 0; attempt++) {
    const now = Date.now();
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
        // Drain the small RDAP error document so the connection can be reused.
        await response.text();
        return { status: 'free', source: 'rdap' };
      }
      await response.body?.cancel().catch(() => {});
      last = unknown('rdap', 'Registry RDAP returned HTTP ' + status);
      if (status !== 429 && status < 500) return last;
      wait = retryWait(response.headers?.get('retry-after'), attempt, status === 429);
      if (status === 429 || status === 503) registry.retryAt = Math.max(registry.retryAt, Date.now() + wait);
      if (status === 429 && registry.identity && wait >= timeLeft()) {
        registry.limitedUntil = registry.retryAt;
        await writeCache(directory, identityDigitalCooldown, { until: registry.limitedUntil }).catch(() => {});
        return last;
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
  directory = cacheDir, fetcher = globalThis.fetch, resolveNs = systemResolveNs, queryWhois = whois,
  now = new Date(), timeLeft = () => 8500, dnsFirst = true, readExpiry = false, pause = delay,
  onResult = () => {}, concurrency = 4, rdapAttempts = 3,
} = {}) {
  const services = candidates.some(({ tld }) => !rdapBase(tld))
    ? bootstrap(directory, fetcher, now, timeLeft) : null;
  const referrals = new Map();
  const pending = candidates.map(async (candidate, index) => {
    const dns = dnsFirst ? await dnsStatus(candidate.domain, resolveNs) : '';
    return { candidate, index, dns };
  });
  const results = [];
  function record({ candidate, index, dns }, registry) {
    if (registry.status === 'unknown' && dns) registry.reason = dns + '; ' + registry.reason;
    results[index] = registry;
    onResult(candidate, registry);
  }
  const records = pending.map(entry => entry.then(row => {
    if (typeof row.dns !== 'string') {
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
  await Promise.all([...registries.values()].map(async registry => {
    if (registry.identity) {
      const saved = await readCache(directory, identityDigitalCooldown);
      if (Number.isFinite(saved?.until) && saved.until > Date.now()) registry.limitedUntil = saved.until;
    }
    return mapLimit(registry.jobs, registry.limit, async ({ base, entry }) => {
      const row = await entry;
      if (!row) return;
      const { domain, tld } = row.candidate;
      const filename = dnsFirst && cachedEndings.has(tld) ? 'rdap-' + domain + '.json' : null;
      const cached = filename && await readCache(directory, filename);
      const age = now - cached?.at;
      if (age >= 0 && age < registrationLifetime && ['taken', 'free'].includes(cached.result?.status)) {
        record(row, { ...cached.result, checkedAt: new Date(cached.at).toISOString() });
        return;
      }
      const fromWhois = () => lookupWhois(domain, tld, queryWhois, timeLeft, referrals)
        .catch(() => unknown('whois', 'Registry WHOIS did not respond'));
      let result = base ? await lookupRdap(base, domain, fetcher, timeLeft, readExpiry, pause, registry, rdapAttempts, directory)
        : await services ? await fromWhois() : unknown('rdap', 'IANA RDAP bootstrap is unavailable');
      if ((tld === 'me' || tld === 'io') && result.reason === rdapRateLimit && timeLeft() > 0) {
        const fallback = await fromWhois();
        if (fallback.status !== 'unknown') result = fallback;
      }
      record(row, result);
      if (filename && result.status !== 'unknown') {
        await writeCache(directory, filename, { at: now.getTime(), result }).catch(() => {});
      }
    });
  }));
  return results;
}
