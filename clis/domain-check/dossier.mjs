// Broker dossier for a taken domain (read only). Registry facts, what the site does, public listing evidence, a
// likely owner type from public signals, the track, a price range only from shown evidence, three free
// alternatives from the name engine, and drafted (never sent) notes to the owner. Nothing is sent, submitted or
// bought, no shop credentials are used, and no background refresh starts. Every part shares one total deadline.
import { classifyComSite } from './com-site.mjs';
import { anySignal, cacheDir, readCache } from './cache.mjs';
import { asciiDomain, canRecommend, defaultEndings, domainEnding, listQuote, nameCandidates, premiumRisk, searchCandidates,
  supportedEndings } from './name-search.mjs';
import { bundledCatalog, loadCachedCatalog } from './price-catalog.mjs';
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

// The existing name engine for free alternatives: list prices from the local cache or the bundled snapshot only,
// so no refresh starts and no shop credentials are read.
export async function findAlternatives(domain, { search = searchCandidates, budgetMs = 6500, clock = () => new Date(),
  directory = cacheDir } = {}) {
  const name = domain.split('.')[0];
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
  return (group?.results ?? [])
    .filter(row => ['probably-free', 'confirmed'].includes(row.status) && row.price != null && canRecommend(row.tld)
      && !premiumRisk(row.domain))
    .sort((a, b) => (a.firstPayment ?? Infinity) - (b.firstPayment ?? Infinity) || (a.threeYear ?? Infinity) - (b.threeYear ?? Infinity))
    .slice(0, 3)
    .map(row => {
      const rdap = row.source === 'rdap' && rdapBase(row.tld, services);
      return {
        domain: row.domain, status: row.status, registryCheckedAt: row.checkedAt ?? null,
        registrySource: row.source ? { method: row.source, url: rdap ? rdapDomainUrl(rdap, row.domain) : bootstrapUrl,
          ...(row.source === 'whois' && documentedWhois.has(row.tld) && { host: documentedWhois.get(row.tld) }) } : null,
        price: row.price, renewal: row.renewal ?? null, firstPayment: row.firstPayment ?? null, threeYear: row.threeYear ?? null,
        shop: row.shop ?? null, priceCheckedAt: row.priceCheckedAt ?? null, priceUrl: priceSourceUrl(row, row.tld),
      };
    });
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

export async function buildDossier(domain, { maxBudget, budgetMs = totalBudgetMs, clock = () => new Date(),
  registry = registryFacts, site = siteFacts, listings = checkListings, alternatives = findAlternatives,
  renewal = renewalFact, providerList = providers, ...deps } = {}) {
  const started = performance.now();
  const deadline = started + budgetMs;
  const controller = new AbortController();
  const stop = setTimeout(() => controller.abort(), budgetMs);
  const { signal } = controller;
  const left = share => Math.max(0, Math.min(budgetMs * share, deadline - performance.now()));
  try {
    const [registryResult, siteResult, listingRows, alternativeRows, renewalResult] = await Promise.all([
      bounded(registry(domain, { ...deps, signal, deadline: started + left(0.5), clock }), left(0.55), null),
      bounded(site(domain, { ...deps, signal, clock }), left(0.6), null),
      bounded(listings(domain, { list: providerList, signal, clock }), left(0.8), null),
      bounded(alternatives(domain, { ...deps, budgetMs: Math.floor(left(0.55)), clock }), left(0.7), null),
      bounded(renewal(domain, { ...deps, clock }), left(0.2), null),
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
      alternatives: alternativeRows ?? [],
      drafts: ['available', 'unknown', 'expiring'].includes(track) ? null
        : draftNotes(domain, { asking, maxBudget, throughMarketplace: listing.listed.some(row => row.source !== 'own site') }),
      private: { maxBudget: maxBudget ?? null, note: 'Private: never in drafts or messages to the owner.' },
    };
  } finally {
    clearTimeout(stop);
    controller.abort();
  }
}
