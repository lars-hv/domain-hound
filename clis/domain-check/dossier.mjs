// Broker dossier for a taken domain (read only). Registry facts, what the site does, public listing evidence, a
// likely owner type from public signals, the track, a price range only from shown evidence, up to three free
// alternatives from the name engine with the triage name screen, and drafted (never sent) notes to the owner. Nothing is sent, submitted or
// bought, no shop credentials are used, and no background refresh starts. Every part shares one total deadline.
import { classifyComSite } from './com-site.mjs';
import { anySignal, cacheDir, readCache } from './cache.mjs';
import { asciiDomain, canRecommend, defaultEndings, domainEnding, listQuote, nameCandidates, premiumRisk, searchCandidates,
  supportedEndings, unicodeName } from './name-search.mjs';
import { bundledCatalog, loadCachedCatalog } from './price-catalog.mjs';
import { bestValue, triageNames } from './triage.mjs';
import { bootstrap, bootstrapUrl, documentedWhois, lookupRegistrations, rdapBase, rdapDomainUrl, systemResolveNs } from './registry.mjs';
import { saleMarketplace } from './parking.mjs';
import { checkListings, marketplaceFor, providers, stopReason, urlBindsDomain } from './marketplaces.mjs';
import { evidenceUrl, followSite, loadPage, pageText, safeUrl } from './safe-web.mjs';

const day = 86_400_000;
export const totalBudgetMs = 11_500;
export const expiringDays = 45;
const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const registrarPriceUrls = {
  Spaceship: 'https://www.spaceship.com/domain-search/pricing/',
  Dynadot: 'https://www.dynadot.com/domain/prices?currency=USD',
};
const priceSourceUrl = (quote, tld) => quote.shop === 'Gandi'
  ? 'https://www.gandi.net/en/domain/tld/' + encodeURIComponent(tld) + '?currency=USD'
  : registrarPriceUrls[quote.shop] ?? quote.buyUrl ?? null;

// The exact domain in DNS form: one label plus an ending, or a label under co.uk. Null for anything else.
export function dossierDomain(value) {
  if (typeof value !== 'string' || value.length > 127) return null;
  const domain = asciiDomain(value.trim().replace(/\.$/, ''));
  if (!domain) return null;
  const parts = domain.split('.');
  const ok = (parts.length === 2 || (parts.length === 3 && parts.slice(1).join('.') === 'co.uk'))
    && label.test(parts[0]) && /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(parts.at(-1));
  return ok && safeUrl('https://' + domain) ? domain : null;
}

const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const hostname = value => typeof value === 'string' && /^[a-z0-9.-]{3,253}$/i.test(value.replace(/\.$/, ''))
  ? value.toLowerCase().replace(/\.$/, '') : null;
// Registry text fields (a registrar's name) keep plain characters only.
const plainField = value => typeof value === 'string'
  ? value.replace(/[^\p{L}\p{N} .,&()'/-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || null : null;

const normalizeStatus = value => value.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

// Facts from one RDAP domain object, bound to the exact domain.
export function readRdap(data, domain) {
  if (String(data?.ldhName ?? '').toLowerCase().replace(/\.$/, '') !== domain) return null;
  const events = Array.isArray(data.events) ? data.events : [];
  const event = action => iso(events.find(row => row?.eventAction === action)?.eventDate);
  const registrar = (Array.isArray(data.entities) ? data.entities : [])
    .find(entity => Array.isArray(entity?.roles) && entity.roles.includes('registrar'));
  const card = Array.isArray(registrar?.vcardArray?.[1]) ? registrar.vcardArray[1] : [];
  const name = plainField(card.find(row => Array.isArray(row) && row[0] === 'fn')?.[3]);
  const ianaId = (Array.isArray(registrar?.publicIds) ? registrar.publicIds : [])
    .find(row => /iana/i.test(String(row?.type)))?.identifier;
  return {
    created: event('registration'), expires: event('expiration'), changed: event('last changed'),
    registrar: name, registrarIanaId: /^\d{1,6}$/.test(String(ianaId ?? '')) ? String(ianaId) : null,
    status: (Array.isArray(data.status) ? data.status : [])
      .filter(value => typeof value === 'string' && /^[a-z ]{3,40}$/i.test(value)).map(normalizeStatus).slice(0, 24),
    nameservers: (Array.isArray(data.nameservers) ? data.nameservers : [])
      .map(row => hostname(row?.ldhName)).filter(Boolean).slice(0, 8),
  };
}

async function rdapLookup(domain, { fetcher, signal, services }) {
  const tld = domainEnding(domain);
  const base = rdapBase(tld) ?? rdapBase(tld, await services);
  if (!base?.startsWith('https://')) return { state: 'unknown', reason: 'no HTTPS RDAP service for this ending' };
  const url = rdapDomainUrl(base, domain);
  try {
    const response = await fetcher(url, { headers: { Accept: 'application/rdap+json, application/json' },
      credentials: 'omit', redirect: 'error', signal });
    if (response.status === 404) {
      await response.body?.cancel?.().catch(() => {});
      return { state: 'free', url };
    }
    if (response.status !== 200) {
      await response.body?.cancel?.().catch(() => {});
      return { state: 'unknown', url, reason: 'RDAP returned HTTP ' + response.status };
    }
    const text = await response.text();
    if (text.length > 1_000_000) return { state: 'unknown', url, reason: 'RDAP answer too large' };
    const facts = readRdap(JSON.parse(text), domain);
    return facts ? { state: 'taken', url, facts } : { state: 'unknown', url, reason: 'RDAP answer is for another name' };
  } catch {
    return { state: 'unknown', url, reason: signal?.aborted ? 'RDAP timed out' : 'RDAP did not respond' };
  }
}

// Registry facts: RDAP for the details, with the existing DNS-and-WHOIS lookup alongside for the basic answer.
export async function registryFacts(domain, { fetcher = globalThis.fetch, resolveNs = systemResolveNs, queryWhois,
  directory = cacheDir, signal, deadline = performance.now() + 5500, clock = () => new Date() } = {}) {
  const tld = domainEnding(domain);
  const timeLeft = () => Math.max(0, Math.floor(deadline - performance.now()));
  const services = rdapBase(tld) ? null : bootstrap(directory, fetcher, clock(), () => Math.min(1800, timeLeft()));
  const rdapSignal = anySignal([signal ?? new AbortController().signal, AbortSignal.timeout(Math.max(1, Math.min(3500, timeLeft())))]);
  const [rdap, [basic]] = await Promise.all([
    rdapLookup(domain, { fetcher, signal: rdapSignal, services }),
    lookupRegistrations([{ domain, tld }], { directory, fetcher, resolveNs, queryWhois, timeLeft, now: clock(),
      dnsFirst: true, readExpiry: true, rdapAttempts: 1 }).catch(() => [null]),
  ]);
  const checkedAt = clock().toISOString();
  const facts = rdap.facts ?? {};
  const registered = rdap.state === 'taken' || basic?.status === 'taken' ? 'taken'
    : rdap.state === 'free' || basic?.status === 'free' ? 'free' : 'unknown';
  const nameservers = facts.nameservers?.length ? facts.nameservers
    : (basic?.nameservers ?? []).map(hostname).filter(Boolean).slice(0, 8);
  const source = rdap.state === registered ? { method: 'rdap', url: rdap.url }
    : basic?.source ? { method: basic.source,
      url: basic.source === 'dns' ? 'dns:NS ' + domain : rdap.url ?? bootstrapUrl } : null;
  return {
    registered, checkedAt, source,
    created: facts.created ?? null,
    expires: facts.expires ?? iso(basic?.expires) ?? null,
    changed: facts.changed ?? null,
    registrar: facts.registrar ?? null, registrarIanaId: facts.registrarIanaId ?? null,
    status: facts.status ?? [], nameservers,
    marketplaceNameservers: saleMarketplace(nameservers),
    ...(registered === 'unknown' && { reason: [rdap.reason, basic?.reason].filter(Boolean).join('; ') || 'no registry answer' }),
  };
}

const escapeDomain = domain => domain.replace(/[.]/g, '\\.');

const saleStatement = /\b(?:(?:this )?domain(?: name)? is (?:for sale|available for (?:purchase|sale))|is for sale|buy this domain|purchase this domain|domain for sale)\b/i;
const notForSale = /\bnot (?:for sale|available for (?:purchase|sale))\b/i;
const priceCue = /\b(?:price|asking|buy (?:it )?now|for sale (?:for|at)|listed (?:for|at)|purchase (?:for|at))\b/i;
const offerCue = /\b(?:offer|minimum|bid|lease|rent|monthly|per month|\/mo|installments?|down payment|financing|from)\b/i;
const pricePattern = /(?:(US\$|\$|USD|€|EUR|£|GBP)\s?((?:\d{1,3}(?:,\d{3})+|\d{1,9})(?:\.\d{2})?)(?![\d,]|\.\d)|(?<![\d,.])((?:\d{1,3}(?:,\d{3})+|\d{1,9})(?:\.\d{2})?)\s?(USD|EUR|GBP)\b)/g;
const currencyOf = symbol => ({ 'US$': 'USD', $: 'unspecified', USD: 'USD', '€': 'EUR', EUR: 'EUR', '£': 'GBP', GBP: 'GBP' })[symbol];

// The owner's own sale statement and asking price on the domain's own page. A price counts only when the page names
// the exact domain, says it is for sale, and shows one unambiguous price next to a price cue (not an offer floor,
// lease or instalment). Anything else is no price.
export function readOwnSale(text, domain) {
  if (!text || notForSale.test(text) || !saleStatement.test(text)) return { sale: false };
  const mentions = new RegExp('(?:^|[^a-z0-9.-])' + escapeDomain(domain) + '(?![a-z0-9-]|\\.[a-z0-9])', 'gi');
  const saleContext = [...text.matchAll(mentions)].find(match => {
    const context = text.slice(Math.max(0, match.index - 60), match.index + domain.length + 75);
    const names = context.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,63}\b/gi) ?? [];
    return saleStatement.test(context) && names.every(name => name.toLowerCase() === domain);
  });
  if (!saleContext) return { sale: true, bound: false };
  const amounts = new Map();
  let offerNearby = false;
  for (const match of text.matchAll(pricePattern)) {
    if (Math.abs(match.index - saleContext.index) > 250) continue;
    const before = text.slice(Math.max(0, match.index - 60), match.index);
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 20);
    if (!priceCue.test(before)) continue;
    if (offerCue.test(before.slice(-25)) || /^\s*(?:\/|per\b|a month|monthly)/i.test(after)) { offerNearby = true; continue; }
    const amount = Number((match[2] ?? match[3]).replace(/,/g, ''));
    const currency = currencyOf(match[1] ?? match[4]);
    if (!(amount >= 1 && amount <= 100_000_000) || !currency) continue;
    amounts.set(currency + amount, { amount, currency });
  }
  if (amounts.size === 1) return { sale: true, bound: true, price: [...amounts.values()][0] };
  return { sale: true, bound: true, ...(amounts.size > 1 ? { note: 'several prices on the page; none read' }
    : offerNearby ? { note: 'only an offer floor or instalment on the page; not an asking price' } : {}) };
}

const investorCue = /\b(?:domain (?:portfolio|investor|investments?|holdings?)|premium domains?|we (?:buy|sell|acquire|invest in) domains|domains? (?:we own|in our portfolio))\b/i;
const individualCue = /\b(?:my personal (?:site|website|blog|homepage)|personal (?:site|website|blog|homepage) of)\b/i;
const businessCue = /\b(?:our (?:products|customers|services|company)|pricing|shop now|book a demo|customer support|terms of service|all rights reserved)\b/i;

// What the site does now, from a followed chain. Only states, hosts and sanitized URLs leave this function.
export function readSite(domain, visit, checkedAt) {
  const own = host => host === domain || host === 'www.' + domain;
  const chain = visit.hops.map(hop => evidenceUrl(hop.url)).filter(Boolean);
  const base = { checkedAt, url: chain[0] ?? 'https://' + domain + '/', chain };
  if (visit.stopped) {
    const target = visit.stopped.url;
    const host = target?.hostname ?? null;
    if (!host) return { ...base, state: 'unknown', reason: visit.stopped.reason };
    const provider = marketplaceFor(host);
    const finalUrl = evidenceUrl(target);
    if (!visit.hops.length) return { ...base, state: 'unknown', host, finalUrl,
      reason: ['marketplace', 'parking'].includes(visit.stopped.reason) ? 'site access limited by provider policy' : visit.stopped.reason };
    if (visit.stopped.reason === 'parking') return { ...base, state: 'parked', host, finalUrl };
    if (visit.stopped.reason === 'marketplace') {
      // The marketplace page is not fetched; a URL that names this exact domain is a sale signal, not a listing.
      if (urlBindsDomain(target, domain)) return { ...base, state: 'for-sale-lander', host, finalUrl,
        marketplace: provider?.name ?? host, boundToDomain: true, fetched: false };
      return { ...base, state: 'redirect', host, finalUrl, finalState: 'destination not opened' };
    }
    return { ...base, state: 'unknown', host, finalUrl, reason: visit.stopped.reason };
  }
  if (visit.failed || !visit.final) return { ...base, state: 'no-site', reason: visit.failed?.reason ?? 'no response' };
  const { url, status, contentType, body, truncated } = visit.final;
  const host = url.hostname;
  const finalUrl = evidenceUrl(url);
  const kind = classifyComSite({ url: url.href, status, contentType, body }).state;
  const text = kind === 'no-site' ? '' : pageText(body);
  const signals = { investorSignals: investorCue.test(text), individualSignals: individualCue.test(text),
    businessSignals: businessCue.test(text) };
  if (!own(host)) {
    return { ...base, state: 'redirect', host, finalUrl, finalState: kind === 'for-sale' ? 'for-sale' : kind,
      ...signals };
  }
  if (kind === 'no-site') return { ...base, state: 'no-site', host, finalUrl, reason: status ? 'HTTP ' + status : 'no page' };
  const sale = readOwnSale(text, domain);
  if (sale.sale || kind === 'for-sale') {
    return { ...base, state: 'for-sale-lander', host, finalUrl, fetched: true, boundToDomain: Boolean(sale.bound && !truncated),
      ...(sale.price && !truncated && { price: sale.price }), ...(sale.note && { priceNote: sale.note }) };
  }
  if (kind === 'parked') return { ...base, state: 'parked', host, finalUrl };
  return { ...base, state: 'live', host, finalUrl, ...signals };
}

export const hopTimeoutMs = 3500;

// The site over https and http side by side, each hop with its own timeout. https wins when it answered at all.
export async function siteFacts(domain, { signal, load = loadPage, clock = () => new Date(), hopMs = hopTimeoutMs } = {}) {
  const outer = signal ?? new AbortController().signal;
  const runs = ['https', 'http'].map(scheme => {
    const controller = new AbortController();
    const own = anySignal([outer, controller.signal]);
    const hop = (url, hopSignal, stopAt) => load(url, anySignal([hopSignal ?? own, AbortSignal.timeout(hopMs)]), stopAt);
    return { controller, done: followSite(scheme + '://' + domain + '/', { signal: own, stopAt: stopReason, load: hop }) };
  });
  try {
    const secure = readSite(domain, await runs[0].done, clock().toISOString());
    if (!['no-site', 'unknown'].includes(secure.state)) return secure;
    const plain = readSite(domain, await runs[1].done, clock().toISOString());
    return ['no-site', 'unknown'].includes(plain.state) ? secure : plain;
  } finally {
    for (const run of runs) run.controller.abort();
  }
}

// Positive listings: the owner's own bound sale page, and enabled marketplace adapters that answered "listed".
export function listingEvidence(site, listings) {
  const listed = [];
  const signals = [];
  if (site?.state === 'for-sale-lander' && site.fetched && site.boundToDomain) {
    listed.push({ source: 'own site', url: site.finalUrl, checkedAt: site.checkedAt, ...(site.price && { price: site.price }) });
  } else if (site?.state === 'for-sale-lander') {
    signals.push({ signal: site.fetched ? 'sale page that does not name this exact domain' : 'redirects to ' + site.marketplace
      + (site.boundToDomain ? ' page for this exact domain (not opened)' : ' (not opened)'), url: site.finalUrl, checkedAt: site.checkedAt });
  }
  if (site?.state === 'redirect' && site.finalState === 'for-sale') {
    signals.push({ signal: 'redirects to a sale page at ' + site.host, url: site.finalUrl, checkedAt: site.checkedAt });
  }
  for (const row of listings ?? []) {
    if (row.state === 'listed') listed.push({ source: row.name, url: row.url, checkedAt: row.checkedAt,
      ...(row.sourceUrl && { sourceUrl: row.sourceUrl }), ...(row.price && { price: row.price }) });
  }
  return { listed, signals };
}

// A range only from asking prices that were shown, in one currency. Never from renewal cost or appraisal.
export function fairRange(listed) {
  const prices = listed.filter(row => row.price).map(row => ({ ...row.price, url: row.url, checkedAt: row.checkedAt }));
  if (!prices.length) return null;
  const currencies = new Set(prices.map(row => row.currency));
  if (currencies.size > 1) return { low: null, high: null, note: 'asking prices in several currencies; not combined', evidence: prices };
  const amounts = prices.map(row => row.amount);
  return { currency: prices[0].currency, low: Math.min(...amounts), high: Math.max(...amounts), evidence: prices };
}

export function ownerSignal(registry, site, listing) {
  const result = (type, confidence, basis, evidence) => ({
    type, confidence, basis, url: evidence?.url ?? null, checkedAt: evidence?.checkedAt ?? null,
  });
  const siteEvidence = { url: site?.finalUrl ?? site?.url, checkedAt: site?.checkedAt };
  if (site?.investorSignals) {
    return result('investor', 'medium', 'the destination describes a domain portfolio', siteEvidence);
  }
  if (site?.individualSignals) {
    return result('individual', 'medium', 'the site describes itself as a personal site', siteEvidence);
  }
  if (site?.businessSignals) {
    return result('business', site.state === 'live' ? 'medium' : 'low', 'the live site has business signals', siteEvidence);
  }
  if (listing.listed.length) {
    return result('investor', 'low', 'the domain has a public sale listing', listing.listed[0]);
  }
  const market = registry?.marketplaceNameservers;
  if (market && !['Bodis', 'ParkingCrew'].includes(market)) {
    return result('investor', 'low', 'name servers at ' + market,
      { url: registry.source?.url, checkedAt: registry.checkedAt });
  }
  return result('unknown', 'none', 'no reliable public owner signal', siteEvidence);
}

export function expiryOutlook(registry, now) {
  const pendingDelete = registry.status.includes('pending delete');
  const redemption = registry.status.includes('redemption period');
  const at = Date.parse(registry.expires);
  const days = Number.isFinite(at) ? Math.floor((at - now) / day) : null;
  return { pendingDelete, redemption, days, soon: days != null && days <= expiringDays };
}

export function chooseTrack(registry, listing, outlook) {
  if (registry.registered === 'free') return 'available';
  if (registry.registered !== 'taken') return 'unknown';
  if (outlook.pendingDelete || outlook.redemption) return 'expiring';
  if (listing.listed.length) return 'listed';
  if (outlook.soon) return 'expiring';
  return 'not-listed';
}

// Broker ending order: the anchors, then established mainstream endings. .xyz and .tech are a fallback tier, ranked
// after every mainstream ending however cheap their first year is. Other supported endings follow in catalog order.
const brokerEndings = ['com', 'ai', 'si', 'io', 'app', 'dev', 'me', 'co', 'net', 'org'];
const brokerEndingOrder = [...new Set([...brokerEndings, 'xyz', 'tech', ...supportedEndings])];
const labelOf = domain => domain.slice(0, domain.indexOf('.'));
const threeYearOf = row => Number.isFinite(row?.threeYear) ? row.threeYear : Infinity;

// No renewal jump sits above an option without one whose three-year total is the same or lower, whatever slot put it
// there. Each move takes one jump-above-non-jump pair away, so the loop ends.
export function orderByValue(options) {
  const ordered = [...options];
  for (let moved = true; moved;) {
    moved = false;
    search: for (let i = 0; i < ordered.length; i++) {
      if (!ordered[i].renewalJump) continue;
      for (let j = i + 1; j < ordered.length; j++) {
        if (!ordered[j].renewalJump && threeYearOf(ordered[j]) <= threeYearOf(ordered[i])) {
          ordered.splice(i, 0, ...ordered.splice(j, 1));
          moved = true;
          break search;
        }
      }
    }
  }
  return ordered;
}

function variantForms(name) {
  return nameCandidates(name, { endings: ['com'] }).filter(row => !row.exact).map(row => row.domain).filter(domain => {
    const label = labelOf(domain);
    return label.endsWith(name) ? !name.startsWith(label.slice(0, -name.length)) : !name.endsWith(label.slice(name.length));
  });
}

// Pick the best value for the exact name, a natural .com variant, and the strongest remaining exact ending.
// Fill open slots in ending order, then with additional variants.
export function pickAlternatives(rows, domain) {
  const name = labelOf(domain);
  const forms = variantForms(name);
  const pool = rows.filter(row => row.domain !== domain && ['probably-free', 'confirmed'].includes(row.status)
    && row.price != null && canRecommend(row.tld) && !premiumRisk(row.domain)
    && (row.exact ? labelOf(row.domain) === name : forms.includes(row.domain)));
  const exact = pool.filter(row => row.exact)
    .sort((a, b) => brokerEndingOrder.indexOf(a.tld) - brokerEndingOrder.indexOf(b.tld));
  const variants = pool.filter(row => !row.exact)
    .sort((a, b) => threeYearOf(a) - threeYearOf(b) || a.domain.length - b.domain.length
      || forms.indexOf(a.domain) - forms.indexOf(b.domain));
  const picks = [];
  const open = list => list.filter(row => !picks.some(pick => pick.row === row));
  const take = (row, role) => { if (row && open([row]).length) picks.push({ row, role }); };
  const attractive = exact.filter(row => brokerEndings.includes(row.tld));
  take(bestValue(attractive) ?? bestValue(exact), 'best-value');
  take(variants[0], 'variant');
  for (const row of [...open(exact), ...open(variants)]) {
    if (picks.length >= 3) break;
    take(row, !row.exact ? 'variant' : row.tld === 'com' ? 'exact-com' : 'exact-ending');
  }
  const chosen = orderByValue(picks.map(({ row, role }) => ({ ...row, role })));
  const cheapest = pool.reduce((best, row) => !best || (row.firstPayment ?? Infinity) < (best.firstPayment ?? Infinity)
    || (row.firstPayment === best.firstPayment && threeYearOf(row) < threeYearOf(best)) ? row : best, undefined);
  const covered = cheapest && chosen.some(row => (row.firstPayment ?? Infinity) <= (cheapest.firstPayment ?? Infinity));
  return { picks: chosen, priceContext: cheapest && !covered ? cheapest : null };
}

function alternativeRow(row, services) {
  const rdap = row.source === 'rdap' && rdapBase(row.tld, services);
  return {
    domain: row.domain, label: labelOf(row.domain), exact: Boolean(row.exact), ...(row.role && { role: row.role }),
    status: row.status, registryCheckedAt: row.checkedAt ?? null,
    registrySource: row.source ? { method: row.source, url: rdap ? rdapDomainUrl(rdap, row.domain) : bootstrapUrl,
      ...(row.source === 'whois' && documentedWhois.has(row.tld) && { host: documentedWhois.get(row.tld) }) } : null,
    price: row.price, renewal: row.renewal ?? null, firstPayment: row.firstPayment ?? null,
    renewalPayment: row.renewalPayment ?? null, minimumYears: row.minimumYears ?? 1, threeYear: row.threeYear ?? null,
    renewalJump: Boolean(row.renewalJump),
    shop: row.shop ?? null, priceCheckedAt: row.priceCheckedAt ?? null, priceUrl: priceSourceUrl(row, row.tld),
  };
}

// The existing name engine for free alternatives: list prices from the local cache or the bundled snapshot only,
// so no refresh starts and no shop credentials are read. The checked rows come back too, so the name screen reuses
// the registry answers instead of asking again.
export async function findAlternatives(domain, { search = searchCandidates, budgetMs = 6500, clock = () => new Date(),
  directory = cacheDir } = {}) {
  const name = labelOf(domain);
  const tld = domainEnding(domain);
  const endings = [...new Set([tld, ...defaultEndings])].filter(ending => supportedEndings.includes(ending));
  const candidates = nameCandidates(name, { endings }).filter(row => row.domain !== domain);
  const { groups: [group] = [] } = await search([{ name, candidates }], {
    budgetMs, now: clock(), cachedOnly: true, skipComSite: true, directory,
    verifyFreeSite: async (name, timeout) => {
      const site = await siteFacts(name, { signal: AbortSignal.timeout(Math.max(1, Math.floor(timeout))) });
      if (['live', 'redirect', 'parked', 'for-sale-lander'].includes(site.state)) return { state: 'live' };
      return null;
    } });
  const services = (await readCache(directory, 'iana.json'))?.value;
  const results = group?.results ?? [];
  const { picks, priceContext } = pickAlternatives(results, domain);
  return { rows: picks.map(row => alternativeRow(row, services)),
    priceContext: priceContext ? alternativeRow(priceContext, services) : null, results, endings };
}

const screenTrim = (value, limit) => value && value.length > limit ? value.slice(0, limit - 1).trimEnd() + '…' : value ?? null;

// The same trademark, iOS and Android app and rival judgement as triageNames, run on one name label. Registry
// answers and site evidence come in from the dossier, handle rows stay off and no search key is read.
export async function screenName(label, { endings, domains, budgetMs, clock = () => new Date(), directory = cacheDir,
  triage = triageNames } = {}) {
  const report = await triage([unicodeName(label) ?? label], { endings, budgetMs: Math.max(1, Math.floor(budgetMs)), now: clock(), directory,
    domainSearch: () => domains, deferHandles: true, handleRows: false, env: {} });
  const row = report?.names?.[0];
  if (!row || report.error) return null;
  const competition = row.competition ?? {};
  const app = value => Array.isArray(value) ? value[0] ?? null : value ?? null;
  const ios = app(competition.AppStore);
  const android = app(competition.GooglePlay);
  return {
    state: 'settled', verdict: row.verdict,
    // The first two reasons, short: the verdict's cause and the strongest supporting fact.
    reason: screenTrim(String(row.reason ?? '').split(' · ').slice(0, 2).join(' · '), 180),
    trademark: typeof competition.US === 'string' ? competition.US : null,
    trademarkUrl: competition.mark ?? null,
    apps: row.details?.appName ?? null,
    appEvidence: [ios && { store: 'iOS', name: ios.name, url: ios.url ?? null },
      android && { store: 'Android', name: android.name, url: android.url ?? null }].filter(Boolean),
    sameName: competition.sameName?.summary ?? null,
    ...(row.traction && { traction: row.traction }),
    google: row.google?.link ?? null,
  };
}

// The registry rows the alternatives search already holds for one label, plus the taken domain and its site.
function screenGroup(label, domain, alternatives, registry, site) {
  const results = (alternatives?.results ?? []).filter(row => labelOf(row.domain) === label);
  const sites = {};
  if (label === labelOf(domain)) {
    const tld = domainEnding(domain);
    const state = { live: 'live', parked: 'parked', 'for-sale-lander': 'for-sale' }[site?.state];
    if (state) sites[tld] = { state, host: site.host ?? domain };
    if (registry?.registered === 'taken' || state) {
      results.push({ domain, tld, exact: true, status: 'taken', checkedAt: registry?.checkedAt ?? null,
        source: registry?.source?.method ?? 'web' });
    }
  }
  return { groups: [{ name: label, candidates: [], results, sites, comSite: sites.com ?? null }], complete: true, priceDate: null };
}

// What the owner pays to renew at a list price, as one cost fact (never a value estimate).
export async function renewalFact(domain, { directory = cacheDir, clock = () => new Date() } = {}) {
  const tld = domainEnding(domain);
  if (!supportedEndings.includes(tld)) return null;
  const quote = listQuote(await loadCachedCatalog(directory), { domain, tld }, clock(), bundledCatalog);
  return quote.renewal != null ? { renewal: quote.renewal, shop: quote.shop, checkedAt: quote.priceCheckedAt,
    url: priceSourceUrl(quote, tld) } : null;
}

const symbols = { USD: '$', EUR: '€', GBP: '£' };
export const formatMoney = ({ amount, currency }) => {
  const value = amount.toLocaleString('en-US');
  if (currency === 'unspecified') return '$' + value + ' (currency unspecified)';
  return (symbols[currency] ?? currency + ' ') + value;
};

// The opening note and up to two follow-ups. One ask each, an AI agent disclosed, no budget, dates, legal language
// or personal details: the requester signs and sends it themselves.
export function draftNotes(domain, { asking, maxBudget, throughMarketplace = false } = {}) {
  const sign = '\n\nThanks,\n[your name]';
  const disclosure = 'An AI agent helped me look into the domain.';
  let kind = 'ask-price';
  let ask = 'What price would you consider for it?';
  if (asking) {
    const price = formatMoney(asking);
    if (asking.currency === 'USD' && maxBudget != null && asking.amount < maxBudget) {
      kind = 'offer-listed-price';
      ask = 'Would you sell it to me for the listed ' + price + '?';
    } else if (asking.currency === 'USD' && maxBudget != null && asking.amount > maxBudget) {
      kind = 'ask-flexibility';
      ask = 'I saw it offered at ' + price + '. Is there any room on that price?';
    } else {
      kind = 'confirm-price';
      ask = 'I saw it offered at ' + price + '. Is that price still current?';
    }
  }
  const opening = 'Subject: Question about ' + domain + '\n\nHi,\n\nI’m interested in buying ' + domain
    + '. ' + disclosure + '\n\n' + ask + sign;
  const followUps = [
    { after: '7 days without a reply', text: 'Subject: Re: Question about ' + domain + '\n\nHi again,\n\nA short follow-up on '
      + domain + '. ' + (asking ? 'Is it still available?' : 'Would you be open to selling it? A rough price is fine.') + sign },
    { after: '14 days without a reply', text: 'Subject: Re: Question about ' + domain + '\n\nHi,\n\nThis is my last note about '
      + domain + '. If you ever want to sell it, could you reply with a price? If not, no problem, and thanks for reading.' + sign },
  ];
  const channel = throughMarketplace ? 'marketplace' : 'public owner inquiry';
  return { kind, channel, opening, followUps };
}

function bounded(promise, ms, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, ms), fallback); }),
  ]).finally(() => clearTimeout(timer));
}

// The screen stops this long before the dossier deadline, so its own partial answer arrives before the cut.
export const screenReserveMs = 400;
const pendingScreen = { state: 'pending', verdict: null,
  reason: 'Name screen still running at the deadline: no trademark, app or rival result yet' };

// Older alternatives callers return a plain list; the engine returns rows, price context and the checked rows.
const alternativesOf = value => Array.isArray(value) ? { rows: value, priceContext: null, results: [], endings: [] }
  : value && typeof value === 'object' ? { rows: value.rows ?? [], priceContext: value.priceContext ?? null,
    results: value.results ?? [], endings: value.endings ?? [] } : null;

export async function buildDossier(domain, { maxBudget, budgetMs = totalBudgetMs, clock = () => new Date(),
  registry = registryFacts, site = siteFacts, listings = checkListings, alternatives = findAlternatives,
  renewal = renewalFact, providerList = providers, screen = screenName, ...deps } = {}) {
  const started = performance.now();
  const deadline = started + budgetMs;
  const controller = new AbortController();
  const stop = setTimeout(() => controller.abort(), budgetMs);
  const { signal } = controller;
  const left = share => Math.max(0, Math.min(budgetMs * share, deadline - performance.now()));
  const screenLeft = () => Math.max(0, deadline - performance.now() - screenReserveMs);
  try {
    const registryRun = bounded(registry(domain, { ...deps, signal, deadline: started + left(0.5), clock }), left(0.55), null);
    const siteRun = bounded(site(domain, { ...deps, signal, clock }), left(0.6), null);
    const alternativesRun = bounded(alternatives(domain, { ...deps, budgetMs: Math.floor(left(0.55)), clock }), left(0.7), null)
      .then(alternativesOf);
    // One screen per name label: two exact endings share one. The taken name's own label starts at once, alongside
    // the registry and price work, and gets the reused answers when they land; a variant label starts once picked.
    const screens = new Map();
    const name = labelOf(domain);
    const startScreen = (label, endings, domains) => {
      if (screens.has(label)) return;
      screens.set(label, Promise.resolve().then(() => screen(label, { endings, domains, budgetMs: screenLeft(), clock,
        directory: deps.directory })).catch(() => null));
    };
    const exactEndings = [...new Set([domainEnding(domain), ...defaultEndings])].filter(ending => supportedEndings.includes(ending));
    startScreen(name, exactEndings, Promise.all([alternativesRun, registryRun, siteRun])
      .then(([found, facts, siteNow]) => screenGroup(name, domain, found, facts, siteNow)));
    const screened = alternativesRun.then(async found => {
      if (!found?.rows.length) return new Map();
      const labels = [...new Set([name, ...found.rows.map(row => row.label ?? labelOf(row.domain))])];
      for (const label of labels.slice(1)) startScreen(label, ['com'], screenGroup(label, domain, found, null, null));
      const settled = await Promise.all(labels.map(label =>
        bounded(screens.get(label), Math.max(0, deadline - performance.now() - 50), undefined)));
      return new Map(labels.map((label, index) => [label, settled[index] === undefined ? pendingScreen
        : settled[index] ?? { state: 'unavailable', verdict: null, reason: 'Name screen could not run' }]));
    });
    const [registryResult, siteResult, listingRows, alternativeData, renewalResult, screenResults] = await Promise.all([
      registryRun, siteRun,
      bounded(listings(domain, { list: providerList, signal, clock }), left(0.8), null),
      alternativesRun,
      bounded(renewal(domain, { ...deps, clock }), left(0.2), null),
      screened,
    ]);
    const now = clock();
    const registryData = registryResult ?? { registered: 'unknown', checkedAt: now.toISOString(), source: null, created: null,
      expires: null, changed: null, registrar: null, registrarIanaId: null, status: [], nameservers: [], marketplaceNameservers: null,
      reason: 'registry check ran out of time' };
    const siteData = siteResult ?? { state: 'unknown', checkedAt: now.toISOString(), url: 'https://' + domain + '/', chain: [], reason: 'site check ran out of time' };
    const listingData = listingRows ?? providerList.map(provider => ({ id: provider.id, name: provider.name,
      manualUrl: provider.manualUrl(domain) ?? null, state: 'unavailable', reason: 'ran out of time' }));
    const listing = listingEvidence(siteData, listingData);
    const outlook = expiryOutlook(registryData, now.getTime());
    const track = chooseTrack(registryData, listing, outlook);
    const range = fairRange(listing.listed);
    const asking = range && range.low != null && range.low === range.high ? { amount: range.low, currency: range.currency } : null;
    const baseScreen = screenResults.get(name);
    return {
      domain, checkedAt: now.toISOString(), elapsedMs: Math.round(performance.now() - started),
      track, registry: registryData, expiry: outlook, site: siteData,
      listings: {
        found: listing.listed, signals: listing.signals,
        checked: listingData.filter(row => ['listed', 'not-listed', 'unknown'].includes(row.state)),
        unavailable: listingData.filter(row => row.state === 'unavailable'),
        unchecked: listingData.filter(row => row.state === 'unchecked'),
        absence: listingData.length && listingData.every(row => row.state === 'not-listed') ? 'confirmed' : 'unknown',
      },
      owner: ownerSignal(registryData, siteData, listing),
      fairRange: range, renewalCost: renewalResult,
      alternatives: (alternativeData?.rows ?? []).map(row => {
        const label = row.label ?? labelOf(row.domain);
        return { ...row, screen: screenResults.get(label) ?? pendingScreen,
          ...(label !== name && baseScreen && baseScreen.verdict !== 'No conflict found' && { baseScreen }) };
      }),
      priceContext: alternativeData?.priceContext ?? null,
      // One entry per screened name label, shared by every alternative with that label.
      screens: Object.fromEntries(screenResults),
      drafts: ['available', 'unknown', 'expiring'].includes(track) ? null
        : draftNotes(domain, { asking, maxBudget, throughMarketplace: listing.listed.some(row => row.source !== 'own site') }),
      private: { maxBudget: maxBudget ?? null, note: 'Private: never in drafts or messages to the owner.' },
    };
  } finally {
    clearTimeout(stop);
    controller.abort();
  }
}
