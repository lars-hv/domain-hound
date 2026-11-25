// Public facts about one domain the person owns: registry record, DNS host, website, TLS certificate, email setup and
// list-price money. Every check is read-only and shares one deadline. Each check answers ok, problem, none or unknown:
// "unknown" means the check did not get an answer (a timeout, a resolver failure, an address we refuse to visit), and
// is never reported as a failure.
import { Resolver } from 'node:dns/promises';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { anySignal, cacheDir } from '../domain-check/cache.mjs';
import { lookupPublic } from '../domain-check/com-site.mjs';
import { registryFacts } from '../domain-check/dossier.mjs';
import { domainEnding } from '../domain-check/name-search.mjs';
import { datedListPrices, isListPriceUsable, loadCachedCatalog } from '../domain-check/price-catalog.mjs';
import { linkable, shops } from '../domain-check/prices.mjs';
import { documentedWhois, systemQueryWhois, systemResolveNs } from '../domain-check/registry.mjs';
import { evidenceUrl, followSite } from '../domain-check/safe-web.mjs';

const day = 86_400_000;
export const expiringSoonDays = 30;
export const certificateSoonDays = 14;
// A move is offered only when it saves more than this per year at list prices.
export const minimumYearlySaving = 5;
const timeoutCodes = new Set(['ETIMEOUT', 'ETIMEDOUT', 'ECANCELLED', 'ABORT_ERR', 'ESERVFAIL', 'EAI_AGAIN']);
const userAgent = 'DomainHound (+https://domainhound.dev; read-only domain check)';

const daysUntil = (iso, now) => {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.floor((at - now.getTime()) / day) : null;
};
const isTimeout = (error, signal) => Boolean(signal?.aborted) || error?.name === 'AbortError' || timeoutCodes.has(error?.code)
  || /timed out/i.test(String(error?.message ?? ''));

// ---- Registry ----------------------------------------------------------------------------------------------------

// Registry status words (RDAP/EPP, normalized to lower case with spaces) that need the owner's attention.
const statusProblems = [
  ['redemption period', 'in redemption: the registration lapsed and must be restored'],
  ['pending restore', 'restore pending at the registry'],
  ['pending delete', 'pending delete: the registry will release it'],
  ['server hold', 'on registry hold: it does not resolve'],
  ['client hold', 'on registrar hold: it does not resolve'],
];

export function readWhois(reply, domain) {
  const values = /^Domain(?: Name)?:[ \t]*(\S+)/im.exec(reply);
  if (values?.[1].toLowerCase().replace(/\.$/, '') !== domain || /^Status:\s*(?:free|available)\s*$/im.test(reply)) return null;
  const field = keys => new RegExp('^(?:' + keys + '):[ \\t]*([^\\r\\n]+)', 'im').exec(reply)?.[1]?.trim();
  const date = keys => {
    const at = Date.parse(field(keys));
    return Number.isFinite(at) ? new Date(at).toISOString() : null;
  };
  const registrar = field('Registrar|Sponsoring Registrar')?.replace(/[^\p{L}\p{N} .,&()'/-]/gu, ' ').slice(0, 80) ?? null;
  const status = [...reply.matchAll(/^Domain Status:[ \t]*([a-z][a-zA-Z ]{1,38})(?=\s*(?:https?:|$))/gim)]
    .map(([, value]) => value.trim().replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()).slice(0, 24);
  const nameservers = [...reply.matchAll(/^Name Server:[ \t]*([a-z0-9.-]{3,253})/gim)]
    .map(([, value]) => value.toLowerCase().replace(/\.$/, '')).slice(0, 8);
  return { registered: 'taken', registrar, created: date('Creation Date|Created on|Registered on'),
    expires: date('Registry Expiry Date|Registrar Registration Expiration Date|Expiry Date|Expiration Date'),
    status, nameservers };
}

export async function portfolioRegistry(domain, { deadline = performance.now() + 6000, signal, query = systemQueryWhois,
  rdap = registryFacts } = {}) {
  const facts = await rdap(domain, { signal, deadline });
  const tld = domain.split('.').at(-1);
  const left = () => Math.floor(deadline - performance.now());
  if (facts.source?.method === 'rdap' || ['app', 'dev'].includes(tld) || left() < 500 || signal?.aborted) return facts;
  let host = documentedWhois.get(tld);
  if (!host) {
    const iana = await query('whois.iana.org', tld, Math.min(950, left()));
    host = /^(?:refer|whois):[ \t]*([a-z\d.-]+)[ \t\r]*$/im.exec(iana)?.[1];
  }
  if (!host || left() < 300 || signal?.aborted) return facts;
  const whois = readWhois(await query(host, domain, Math.min(1500, left())), domain);
  return whois ? { ...facts, ...whois, expires: whois.expires ?? facts.expires,
    nameservers: whois.nameservers.length ? whois.nameservers : facts.nameservers,
    checkedAt: new Date().toISOString(), source: { method: 'whois', url: 'whois://' + host } } : facts;
}

export function readRegistry(facts, now) {
  if (!facts || facts.registered !== 'taken') {
    return { state: facts?.registered === 'free' ? 'problem' : 'unknown',
      reason: facts?.registered === 'free' ? 'the registry has no record: not registered' : facts?.reason ?? 'no registry answer',
      registrar: null, created: null, expires: null, daysLeft: null, status: [], nameservers: facts?.nameservers ?? [],
      source: facts?.source ?? null };
  }
  const status = Array.isArray(facts.status) ? facts.status : [];
  const daysLeft = facts.expires ? daysUntil(facts.expires, now) : null;
  const problems = statusProblems.filter(([word]) => status.includes(word)).map(([, text]) => text);
  if (daysLeft !== null && daysLeft < 0) problems.unshift('expired ' + -daysLeft + (daysLeft === -1 ? ' day ago' : ' days ago'));
  return {
    state: problems.length ? 'problem' : 'ok',
    problems,
    registrar: facts.registrar ?? null,
    created: facts.created ?? null,
    // The registry's own transfer event, when it publishes one. Never inferred from "last changed".
    transferred: facts.transferred ?? null,
    expires: facts.expires ?? null,
    daysLeft,
    status,
    // Only the registry's own status word counts as evidence of auto-renew; nothing else is claimed.
    autoRenewGrace: status.includes('auto renew period'),
    transferLock: status.length ? status.includes('client transfer prohibited') : null,
    nameservers: facts.nameservers ?? [],
    source: facts.source ?? null,
    checkedAt: facts.checkedAt ?? null,
  };
}

// ---- DNS host ----------------------------------------------------------------------------------------------------

const dnsHosts = [
  ['Cloudflare', ['ns.cloudflare.com', 'cloudflare.com']],
  ['AWS Route 53', ['awsdns-', 'awsdns']],
  ['Google Cloud DNS', ['googledomains.com']],
  ['Azure DNS', ['azure-dns.com', 'azure-dns.net', 'azure-dns.org', 'azure-dns.info']],
  ['Vercel', ['vercel-dns.com']],
  ['NS1 (often Netlify)', ['nsone.net']],
  ['Spaceship', ['spaceship.net']],
  ['GoDaddy', ['domaincontrol.com']],
  ['Namecheap', ['registrar-servers.com']],
  ['Porkbun', ['porkbun.com']],
  ['Dynadot', ['dynadot.com']],
  ['Gandi', ['gandi.net']],
  ['Squarespace', ['squarespacedns.com']],
  ['DigitalOcean', ['digitalocean.com']],
  ['Hetzner', ['hetzner.com', 'hetzner.de', 'first-ns.de', 'second-ns.de', 'second-ns.com']],
  ['DNSimple', ['dnsimple.com', 'dnsimple-edge.net']],
  ['Akamai', ['akam.net']],
  ['UltraDNS', ['ultradns.com', 'ultradns.net', 'ultradns.org', 'ultradns.biz', 'ultradns.info']],
  ['IONOS', ['ui-dns.com', 'ui-dns.de', 'ui-dns.org', 'ui-dns.biz']],
  ['Wix', ['wixdns.net']],
];

export function dnsHost(nameservers = []) {
  const hosts = nameservers.map(value => String(value).toLowerCase().replace(/\.$/, '')).filter(Boolean);
  if (!hosts.length) return null;
  for (const [name, suffixes] of dnsHosts) {
    if (hosts.some(host => suffixes.some(suffix => suffix.endsWith('-') || suffix === 'awsdns'
      ? host.includes(suffix) : host === suffix || host.endsWith('.' + suffix)))) return name;
  }
  // Unknown provider: show the name servers' own domain (three labels under a country's second level, like co.uk).
  const labels = hosts[0].split('.');
  return labels.slice(/^(?:co|com|net|org|ac|gov|ne|or)\.[a-z]{2}$/.test(labels.slice(-2).join('.')) ? -3 : -2).join('.');
}

// ---- Website -----------------------------------------------------------------------------------------------------

// One request, no body: the status and any redirect. Every hop goes through safe-web's followSite, which refuses
// IP literals, credentials, ports and local names, and lookupPublic, which refuses addresses outside the public internet.
export function statusOnly(url, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
    const get = url.protocol === 'https:' ? httpsGet : httpGet;
    const request = get(url, { lookup: lookupPublic(signal), signal, agent: false,
      headers: { accept: 'text/html, */*;q=0.5', 'user-agent': userAgent, 'accept-encoding': 'identity' } }, response => {
      const status = response.statusCode;
      const location = [301, 302, 303, 307, 308].includes(status) && typeof response.headers.location === 'string'
        ? response.headers.location : null;
      response.destroy();
      resolve({ status, location, contentType: String(response.headers['content-type'] ?? '') });
    });
    request.on('error', reject);
  });
}

function failureText(error) {
  const code = String(error?.code ?? '');
  if (/^(?:CERT_|ERR_TLS_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED)/.test(code)) return 'certificate rejected (' + code + ')';
  if (/No public address/i.test(String(error?.message))) return 'no public address';
  if (code === 'ENOTFOUND') return 'no address in DNS';
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ECONNRESET') return 'connection reset';
  return 'no response';
}

// The site's answer at https and http, following redirects. https wins when it answered at all.
export async function siteCheck(domain, { signal, load = statusOnly, hopMs = 3500 } = {}) {
  const outer = signal ?? new AbortController().signal;
  const run = async scheme => {
    let lastError = null;
    const hop = async (url, hopSignal) => {
      const own = anySignal([hopSignal ?? outer, AbortSignal.timeout(hopMs)]);
      try {
        return await load(url, own);
      } catch (error) {
        lastError = { error, timedOut: isTimeout(error, own) };
        throw error;
      }
    };
    const visit = await followSite(scheme + '://' + domain + '/', { signal: outer, load: hop });
    return readVisit(visit, lastError);
  };
  const [secure, plain] = await Promise.all([run('https'), run('http')]);
  // An https answer settles it, even an error status. Without one, a working http site still counts as up, except on
  // endings browsers open over HTTPS only: there the answering http server proves the host is up and https is not.
  if (secure.state === 'ok' || (secure.state === 'problem' && secure.httpStatus)) return secure;
  if (plain.state === 'ok') {
    const ending = domain.split('.').at(-1);
    if (httpsOnlyEndings.has(ending)) {
      return { ...plain, state: secure.state, reason: 'HTTPS ' + (secure.reason ?? 'failed') + '. Browsers require HTTPS on .' + ending,
        note: 'HTTP answered. HTTPS ' + (secure.reason ?? 'failed') + '.', httpOnly: true };
    }
    return { ...plain, note: 'http only' + (secure.reason ? '; https: ' + secure.reason : '') };
  }
  return secure;
}

// Endings on the browsers' HSTS preload list as a whole (Google Registry): a plain-http site there cannot be opened.
export const httpsOnlyEndings = new Set(['app', 'dev', 'page', 'new', 'day', 'foo', 'boo', 'esq', 'ing', 'meme', 'mov', 'nexus',
  'phd', 'prof', 'rsvp', 'soy', 'zip']);

export function readVisit(visit, lastError) {
  if (visit.stopped) {
    // followSite stops on an unsafe redirect (private, local or IP target) without requesting it.
    return { state: 'unknown', reason: visit.stopped.reason === 'unsafe redirect'
      ? 'redirects to a private or unsafe address; not followed' : visit.stopped.reason };
  }
  if (visit.failed || !visit.final) {
    if (lastError?.timedOut) return { state: 'unknown', reason: 'no answer in time' };
    return { state: 'problem', reason: failureText(lastError?.error) };
  }
  const { url, status } = visit.final;
  const redirect = (visit.hops?.length ?? 0) > 1 ? evidenceUrl(url) : null;
  const base = { httpStatus: status, finalUrl: evidenceUrl(url), ...(redirect && { redirect }) };
  if (status >= 200 && status < 400) return { state: 'ok', ...base };
  // Bot walls and sign-in pages still prove a server answers for the domain.
  if ([401, 403, 429].includes(status)) return { state: 'ok', ...base, note: 'answers HTTP ' + status + ' to automated checks' };
  return { state: 'problem', ...base, reason: 'HTTP ' + status };
}

// ---- TLS certificate ---------------------------------------------------------------------------------------------

// The certificate the apex serves on port 443, read even when it is invalid so the reason can be named.
export function readCertificate(domain, { signal, timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const own = anySignal([signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)]);
    if (own.aborted) return reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
    const socket = tlsConnect({ host: domain, port: 443, servername: domain, rejectUnauthorized: false,
      lookup: lookupPublic(own), ALPNProtocols: ['http/1.1'] });
    const stop = () => {
      socket.destroy();
      reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
    };
    own.addEventListener('abort', stop, { once: true });
    socket.once('secureConnect', () => {
      own.removeEventListener('abort', stop);
      const certificate = socket.getPeerCertificate();
      const answer = { authorized: socket.authorized, error: socket.authorizationError ? String(socket.authorizationError) : null,
        validTo: certificate?.valid_to ?? null, issuer: certificate?.issuer?.O ?? null };
      socket.destroy();
      resolve(answer);
    });
    socket.once('error', error => {
      own.removeEventListener('abort', stop);
      socket.destroy();
      reject(error);
    });
  });
}

export async function tlsCheck(domain, { signal, read = readCertificate, now = new Date() } = {}) {
  let answer;
  try {
    answer = await read(domain, { signal });
  } catch (error) {
    if (isTimeout(error, signal)) return { state: 'unknown', reason: 'no answer in time' };
    const text = failureText(error);
    // Nothing listening for HTTPS is a missing certificate, not an invalid one.
    return { state: ['connection refused', 'no address in DNS', 'no public address'].includes(text) ? 'none' : 'problem',
      reason: text };
  }
  const expires = Number.isFinite(Date.parse(answer?.validTo)) ? new Date(answer.validTo).toISOString() : null;
  const daysLeft = expires ? daysUntil(expires, now) : null;
  const issuer = typeof answer?.issuer === 'string' ? answer.issuer.replace(/[^\p{L}\p{N} .,&()'-]/gu, '').slice(0, 60) : null;
  const base = { expires, daysLeft, ...(issuer && { issuer }) };
  if (!answer?.authorized) {
    const code = String(answer?.error ?? 'unknown error').replace(/[^A-Z0-9_]/gi, '').slice(0, 60);
    return { state: 'problem', ...base, reason: code === 'CERT_HAS_EXPIRED' ? 'certificate expired' : 'certificate invalid (' + code + ')' };
  }
  if (daysLeft !== null && daysLeft <= certificateSoonDays) {
    return { state: 'problem', ...base, reason: 'certificate expires in ' + Math.max(0, daysLeft) + ' days' };
  }
  return { state: 'ok', ...base };
}

// ---- Email -------------------------------------------------------------------------------------------------------

export function systemResolver() {
  const resolver = new Resolver({ timeout: 2000, tries: 2 });
  return {
    resolveMx: name => resolver.resolveMx(name),
    resolveTxt: name => resolver.resolveTxt(name),
    cancel: () => resolver.cancel(),
  };
}

// One DNS question: the answer, null for a definite "nothing there", or "unknown" when the resolver did not answer.
async function ask(question) {
  try {
    return await question();
  } catch (error) {
    if (['ENODATA', 'ENOTFOUND'].includes(error?.code)) return null;
    return 'unknown';
  }
}

export async function mailCheck(domain, { resolver = systemResolver(), signal } = {}) {
  const cancel = () => resolver.cancel?.();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const [mx, txt, dmarcTxt] = await Promise.all([
      ask(() => resolver.resolveMx(domain)),
      ask(() => resolver.resolveTxt(domain)),
      ask(() => resolver.resolveTxt('_dmarc.' + domain)),
    ]);
    const joined = rows => Array.isArray(rows) ? rows.map(parts => Array.isArray(parts) ? parts.join('') : String(parts)) : [];
    const mxRows = Array.isArray(mx) ? mx : [];
    // RFC 7505: a single MX of "." declares that the domain accepts no incoming mail.
    const nullMx = mxRows.length === 1 && ['', '.'].includes(String(mxRows[0]?.exchange ?? '').trim());
    const spf = txt === 'unknown' ? 'unknown' : joined(txt).some(value => /^v=spf1(?:\s|$)/i.test(value.trim()));
    const dmarc = dmarcTxt === 'unknown' ? 'unknown' : joined(dmarcTxt).some(value => /^v=DMARC1\s*(?:;|$)/i.test(value.trim()));
    const facts = { mx: mx === 'unknown' ? 'unknown' : nullMx ? 'null' : mxRows.length > 0, spf, dmarc,
      mxHosts: nullMx ? [] : mxRows.map(row => String(row?.exchange ?? '').toLowerCase()).filter(Boolean).slice(0, 4) };
    if (mx === 'unknown') return { state: 'unknown', ...facts, reason: 'MX lookup did not answer' };
    if (nullMx || !mxRows.length) {
      return { state: 'none', ...facts, reason: nullMx ? 'declares no incoming mail (null MX)' : 'no MX record found' };
    }
    const missing = [spf === false && 'SPF', dmarc === false && 'DMARC'].filter(Boolean);
    if (missing.length) return { state: 'problem', ...facts, reason: 'mail without ' + missing.join(' and ') };
    if (spf === 'unknown' || dmarc === 'unknown') return { state: 'unknown', ...facts, reason: 'SPF or DMARC lookup did not answer' };
    return { state: 'ok', ...facts };
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

// ---- Money -------------------------------------------------------------------------------------------------------

// Registrar names in RDAP mapped to the shops whose dated list prices we read.
const registrarShops = [
  [/\bspaceship\b/i, 'spaceship'], [/\bporkbun\b/i, 'porkbun'], [/\bdynadot\b/i, 'dynadot'], [/\bgandi\b/i, 'gandi'],
  [/\bcloudflare\b/i, 'cloudflare'], [/\bnamecheap\b/i, 'namecheap'], [/\bnamesilo\b/i, 'namesilo'],
];
export const registrarShop = registrar => registrarShops.find(([pattern]) => pattern.test(String(registrar ?? '')))?.[1] ?? null;

const priceSources = {
  spaceship: () => 'https://www.spaceship.com/domain-search/pricing/',
  dynadot: () => 'https://www.dynadot.com/domain/prices?currency=USD',
  porkbun: () => 'https://porkbun.com/products/domains',
  gandi: tld => 'https://www.gandi.net/en/domain/tld/' + encodeURIComponent(tld) + '?currency=USD',
  cloudflare: () => 'https://www.cloudflare.com/products/registrar/',
};
// Each shop's own transfer-in page. Only linkable shops (not data-only ones) can be a move target.
export const transferPages = {
  spaceship: 'https://www.spaceship.com/domains/transfer/',
  dynadot: 'https://www.dynadot.com/domain/transfer',
  gandi: 'https://shop.gandi.net/en/domain/transfer',
};

const cents = value => Math.round((value + Number.EPSILON) * 100) / 100;
// These catalog endings normally add one year on transfer. Other terms (for example .ai and .uk)
// need different calculations to compare the same coverage.
const oneYearTransfers = new Set(['com', 'net', 'org', 'app', 'dev', 'io', 'me', 'co', 'xyz', 'tech', 'sh', 'gg', 'inc', 'studio']);

export async function loadCatalog(directory = cacheDir) {
  return loadCachedCatalog(directory).catch(() => null);
}

// Dated list prices only. A saving is offered when it is real (both prices known, a transfer price listed) and more
// than minimumYearlySaving per year over three years. Premium names renew higher than these list prices.
export function moneyFacts(domain, registrar, catalog, now = new Date()) {
  const tld = domainEnding(domain);
  const byShop = new Map();
  for (const row of [...datedListPrices(catalog, tld, now), ...datedListPrices(null, tld, now)]) {
    if (!Number.isFinite(row.renewal) || Date.parse(row.checkedAt) > now.getTime()) continue;
    if (!byShop.has(row.id) || row.checkedAt > byShop.get(row.id).checkedAt) byShop.set(row.id, row);
  }
  const rows = [...byShop.values()];
  const shop = registrarShop(registrar);
  const dated = row => ({ shop: row.shop, renewal: row.renewal, checkedAt: row.checkedAt, estimate: Boolean(row.bundled),
    source: priceSources[row.id]?.(tld) ?? null });
  const current = shop ? rows.find(row => row.id === shop) : null;
  const cheapest = rows.reduce((best, row) => (
    !best || row.renewal < best.renewal || (row.renewal === best.renewal && row.id === shop)
  ) ? row : best, null);
  let move = null;
  if (current && oneYearTransfers.has(tld) && isListPriceUsable(current.checkedAt, now)) {
    for (const row of rows) {
      if (row.renewal >= current.renewal || !linkable(row.id) || !transferPages[row.id]
        || !Number.isFinite(row.transfer) || !isListPriceUsable(row.checkedAt, now)) continue;
      // Staying: three renewals. Moving: the transfer (which adds a year) and two renewals at the new shop.
      const saving = cents(3 * current.renewal - (row.transfer + 2 * row.renewal));
      if (saving / 3 > minimumYearlySaving && (!move || saving > move.saving)) {
        move = { to: row.shop, saving, transfer: row.transfer, renewal: row.renewal, checkedAt: row.checkedAt,
          estimate: Boolean(row.bundled), url: transferPages[row.id], source: priceSources[row.id]?.(tld) ?? null };
      }
    }
  }
  return {
    currentShop: shop ? shops[shop]?.name ?? null : null,
    current: current ? dated(current) : null,
    cheapest: cheapest ? dated(cheapest) : null,
    move,
  };
}

// ---- One domain --------------------------------------------------------------------------------------------------

export async function checkDomain(domain, { signal, now = new Date(), catalog = null, deadline,
  registry = portfolioRegistry, site = siteCheck, tls = tlsCheck, mail = mailCheck, resolveNs = systemResolveNs } = {}) {
  const end = deadline ?? performance.now() + 9000;
  const guard = async (work, fallback) => {
    try { return await work(); } catch { return fallback; }
  };
  const [facts, web, certificate, email, nameservers] = await Promise.all([
    guard(() => registry(domain, { signal, deadline: Math.min(end, performance.now() + 6000) }), null),
    guard(() => site(domain, { signal }), { state: 'unknown', reason: 'site check failed to run' }),
    guard(() => tls(domain, { signal, now }), { state: 'unknown', reason: 'certificate check failed to run' }),
    guard(() => mail(domain, { signal }), { state: 'unknown', reason: 'mail check failed to run' }),
    guard(() => resolveNs(domain), []),
  ]);
  const record = readRegistry(facts, now);
  const activeNameservers = Array.isArray(nameservers) && nameservers.length ? nameservers : record.nameservers;
  const money = moneyFacts(domain, record.registrar, catalog, now);
  if (record.state !== 'ok' || record.autoRenewGrace || record.status.includes('pending transfer')
    || now.getTime() - Date.parse(record.created) < 60 * day || now.getTime() - Date.parse(record.transferred) < 60 * day) money.move = null;
  return {
    domain,
    checkedAt: now.toISOString(),
    registry: record,
    nameservers: activeNameservers,
    dnsHost: dnsHost(activeNameservers),
    site: web,
    tls: certificate,
    email,
    money,
  };
}

// The urgency order the say and the page share: lower is more urgent.
export function urgency(row) {
  const days = row.registry.daysLeft;
  if (row.registry.state === 'problem') return 0;
  if (days !== null && days <= expiringSoonDays) return 1;
  if (row.site.state === 'problem' || row.tls.state === 'problem' || row.email.state === 'problem') return 2;
  if (row.money.move) return 3;
  if ([row.registry, row.site, row.tls, row.email].some(check => check.state === 'unknown')) return 4;
  return 5;
}

export function sortByUrgency(rows) {
  return rows.map((row, index) => ({ row, index, rank: urgency(row) }))
    .sort((a, b) => a.rank - b.rank || (a.row.registry.daysLeft ?? Infinity) - (b.row.registry.daysLeft ?? Infinity) || a.index - b.index)
    .map(({ row }) => row);
}
