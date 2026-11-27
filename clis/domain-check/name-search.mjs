import { domainTier } from '../../name-context.mjs';
import { domainToASCII, domainToUnicode } from 'node:url';
import { checkDomainSite } from './com-site.mjs';
import { cachedSignals, confirmingShops } from './confirm.mjs';
import { bundledCatalog, datedListPrices, getNameCatalog, isListPriceUsable, listedPrices, loadCachedCatalog, requestEndings,
  supportedEndings, targetEndings } from './price-catalog.mjs';
import { linkable, shopSearchUrl } from './prices.mjs';
import { lookupRegistrations } from './registry.mjs';
import { foldLatin } from './triage-sources.mjs';

const checked = '2026-11-23';
const facts = {
  ai: {
    minimumYears: 2, renewalYears: 2, note: 'Two year minimum',
    source: 'https://www.namecheap.com/domains/registration/cctld/ai/', checked,
  },
  no: {
    need: 'Norwegian org/ID',
    note: 'Norwegian address plus organization number or personal ID required',
    eligibility: 'Norwegian organization or eligible individual, with a Norwegian postal address',
    source: 'https://www.norid.no/en/om-domenenavn/regelverk-for-no/', checked,
  },
  eu: {
    need: 'EU or EEA eligibility',
    eligibility: 'EU, Icelandic, Liechtenstein or Norwegian citizenship, residence or establishment',
    note: 'Registration requires citizenship, residence or establishment in the EU, Iceland, Liechtenstein or Norway',
    source: 'https://eurid.eu/en/knowledge-centre/rules-for-eu-domains/', checked: '2026-11-25',
  },
  io: {
    note: 'Long-term registry uncertainty',
    source: 'https://www.icann.org/en/blogs/details/the-chagos-archipelago-and-the-io-domain-14-11-2024-en', checked,
  },
  app: {
    note: 'HTTPS only, fine for a product',
    source: 'https://www.registry.google/domains/app/', checked,
  },
  dev: {
    note: 'HTTPS only, fine for a product',
    source: 'https://www.registry.google/domains/dev/', checked,
  },
};

const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const domainEnding = domain => domain.endsWith('.co.uk') ? 'co.uk' : domain.split('.').at(-1);
export const defaultEndings = targetEndings;
export { requestEndings, supportedEndings };
export const restrictedEndings = Object.keys(facts).filter(tld => facts[tld].eligibility);
const firstCost = row => row.firstPayment ?? Infinity;

// The local fallback keeps the hosted checker's order. Explicit requests can override it.
export const qualityEndings = defaultEndings;
// The default pick stays within this many dollars of payments due in 3 years; a budget the person gave replaces it.
export const pickCapUsd = 60;

const asked = (domain, requested) => requested.findIndex(value => value === domain || value === domainEnding(domain));

// Lower is better. Requested endings and exact domains the person typed come first, in the person's order. A restricted
// ending the buyer said they qualify for (.no) comes right after .com. Then the quality order, then everything else.
export function qualityRank(domain, requested = [], eligible = []) {
  const position = asked(domain, requested);
  if (position >= 0) return position - requested.length;
  const order = ['com', ...eligible.filter(tld => restrictedEndings.includes(tld)), ...qualityEndings.slice(1)];
  const tld = domainEnding(domain);
  const index = order.indexOf(tld);
  if (index >= 0) return index;
  const other = supportedEndings.indexOf(tld);
  return order.length + (other < 0 ? supportedEndings.length : other);
}

const cents = value => Math.round(value * 100);
const known = value => typeof value === 'number' && Number.isFinite(value);

function fitsCap(option, { budget } = {}) {
  return known(option.total) && cents(option.total) <= cents(budget ?? pickCapUsd);
}

// The one pick rule. options are free, eligible, in-scope rows shaped { domain, now, total } (total = payments due in
// 3 years). The pick is the highest-quality option within the cap; when none fits, the least paid over 3 years.
// .ai is never the default: only when the person asked for it or its 3-year total fits the budget they gave.
export function choosePick(options, { requested = [], eligible = [], budget, allowOverCap = true, exactLabel, upfrontCap } = {}) {
  const allowed = options.filter(option => (upfrontCap == null || (known(option.now) && cents(option.now) <= cents(upfrontCap))) &&
    (exactLabel || domainEnding(option.domain) !== 'ai' || asked(option.domain, requested) >= 0
      || (budget != null && known(option.total) && cents(option.total) <= cents(budget))));
  const rank = option => qualityRank(option.domain, requested, eligible);
  const byQuality = (a, b) => (exactLabel ? domainTier(a.domain, exactLabel) - domainTier(b.domain, exactLabel)
    : Number(a.exact === false) - Number(b.exact === false)) || rank(a) - rank(b)
    || (a.total ?? Infinity) - (b.total ?? Infinity)
    || (a.now ?? Infinity) - (b.now ?? Infinity) || a.domain.localeCompare(b.domain);
  return allowed.filter(option => upfrontCap != null ? known(option.total) : fitsCap(option, { budget })).sort(byQuality)[0]
    ?? (allowOverCap ? lowestTotal(allowed, rank) : undefined);
}

// The least paid over 3 years; the cheaper first payment, then quality, breaks a tie.
export function lowestTotal(options, rank = option => qualityRank(option.domain)) {
  return options.filter(option => known(option.total)).sort((a, b) => cents(a.total) - cents(b.total)
    || (a.now ?? Infinity) - (b.now ?? Infinity) || rank(a) - rank(b) || a.domain.localeCompare(b.domain))[0];
}

// The cheapest upfront payment; quality breaks a tie.
export function lowestUpfront(options, rank = option => qualityRank(option.domain)) {
  return options.filter(option => known(option.now)).sort((a, b) => cents(a.now) - cents(b.now) || rank(a) - rank(b)
    || a.domain.localeCompare(b.domain))[0];
}

// Across names, prefer quality inside the cap and the lowest three-year total above it.
export function comparePicks(a, b, context = {}) {
  const aFits = fitsCap(a, context);
  const bFits = fitsCap(b, context);
  const rank = qualityRank(a.domain, context.requested, context.eligible) - qualityRank(b.domain, context.requested, context.eligible);
  const total = (a.total ?? Infinity) - (b.total ?? Infinity);
  return Number(bFits) - Number(aFits) || (aFits ? rank || total : total || rank)
    || (a.now ?? Infinity) - (b.now ?? Infinity);
}

export function validEligibility(eligible) {
  return Array.isArray(eligible) && new Set(eligible).size === eligible.length
    && eligible.every(tld => restrictedEndings.includes(tld));
}

export function canRecommend(tld, eligible = []) {
  return !facts[tld]?.eligibility || eligible.includes(tld);
}

// What a buyer needs for a restricted ending, in a few words: "Norwegian org/ID".
export function eligibilityNeed(tld) {
  return facts[tld]?.eligibility ? facts[tld].need ?? 'eligibility' : null;
}

export function eligibilityNotes(endings) {
  const notes = Object.fromEntries(restrictedEndings.filter(tld => endings.includes(tld))
    .map(tld => [tld, facts[tld].note]));
  return Object.keys(notes).length ? notes : undefined;
}

export function validEndings(endings) {
  return Array.isArray(endings) && endings.length > 0 && endings.length <= supportedEndings.length
    && new Set(endings).size === endings.length && endings.every(ending => supportedEndings.includes(ending));
}

// One DNS label for a name. Spaces and punctuation go; letters never do. A name with non-ASCII letters (æ, ø, å, é)
// becomes its punycode label (xn--...), the form registries and shops use for that exact spelling.
export function normalizeName(input) {
  if (typeof input !== 'string' || /[./\\]/.test(input)) return null;
  const name = input.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}-]/gu, '');
  if (/^[a-z0-9-]*$/.test(name)) return label.test(name) ? name : null;
  const ascii = domainToASCII(name);
  return label.test(ascii) ? ascii : null;
}

// An exact domain in its DNS form: a Unicode domain becomes its punycode form; anything else returns null.
export function asciiDomain(input) {
  if (typeof input !== 'string') return null;
  const value = input.normalize('NFC').toLowerCase();
  if (!/^[\p{L}\p{N}\p{M}.-]+$/u.test(value)) return null;
  return /^[\x00-\x7f]+$/.test(value) ? value : domainToASCII(value) || null;
}

// The Unicode spelling of an ASCII label or domain, or null when it has no punycode part.
export function unicodeName(value) {
  if (typeof value !== 'string' || !/(?:^|\.)xn--/.test(value)) return null;
  const shown = domainToUnicode(value);
  return shown && shown !== value ? shown : null;
}

// A Latin-letter key for name matching in rival, app, mark and handle sources: Grønnstue -> gronnstue.
// ASCII names keep their DNS label as the key.
export function searchKey(input) {
  const dns = normalizeName(input);
  if (!dns?.startsWith('xn--')) return dns;
  const key = foldLatin(input).replace(/[^a-z0-9-]/g, '');
  return label.test(key) ? key : dns;
}

// Short labels (four characters or fewer, counted in Unicode) are often premium at the registry or the shop.
// Their list price is withheld until a shop quote settles it.
export const premiumRiskLength = 4;
export function premiumRisk(domain) {
  const first = String(domain ?? '').split('.')[0];
  if (!first) return false;
  return [...(unicodeName(first) ?? first)].length <= premiumRiskLength;
}

// A free row for a short label: the registry says free, but the price may be premium. No list price stays on it.
export function withPremiumRisk(row) {
  if (!row || row.status !== 'probably-free' || !premiumRisk(row.domain)) {
    if (row?.status === 'check-at-shop' && premiumRisk(row.domain) && row.price != null) {
      return { ...withoutListPrice(row, 'check-at-shop'), premiumRisk: true };
    }
    return row;
  }
  return { ...withoutListPrice(row, 'premium'), premium: 'risk' };
}

export function nameCandidates(name, { variants: includeVariants = true, endings = defaultEndings } = {}) {
  const selected = endings;
  const exact = [...new Set(selected)].map(tld => ({ domain: name + '.' + tld, tld, exact: true }));
  // A punycode label takes no prefix or suffix: "get" + "xn--..." is not that spelling.
  if (!includeVariants || !selected.includes('com') || name.startsWith('xn--')) return exact;
  const variants = ['get' + name, 'try' + name, 'use' + name, name + 'hq'];
  return [...exact, ...variants.filter(value => label.test(value)).map(value => ({
    domain: value + '.com', tld: 'com', exact: false,
  }))];
}

export function termCosts(tld, price, renewal) {
  const { minimumYears = 1, renewalYears = 1 } = facts[tld] ?? {};
  const renewals = Math.ceil((3 - minimumYears) / renewalYears);
  const round = value => Math.round(value * 100) / 100;
  return {
    minimumYears, renewalYears,
    firstPayment: price == null ? null : round(minimumYears * price),
    renewalPayment: renewal == null ? null : round(renewalYears * renewal),
    // Include every payment due before the third anniversary, even if it buys year four.
    threeYear: price == null || renewal == null ? null : round(minimumYears * price + renewals * renewalYears * renewal),
  };
}

// Exact names first, then by the quality order, then by upfront payment (including any minimum term).
export function rankName(rows, requested = [], eligible = []) {
  return rows.map(row => {
    const { tld, exact, status, price = null, renewal = null } = row;
    const reason = status === 'premium' ? row.premium === 'risk' ? 'May be premium' : 'Premium price' : status === 'reserved' ? 'Not offered for registration'
      : status === 'taken' ? 'Already registered'
      : status === 'check-at-shop' ? 'Check at shop'
      : exact ? 'Exact name' : 'Name variation';
    return { ...row, ...termCosts(tld, price, renewal), reason, terms: facts[tld] ?? null,
      renewalJump: price != null && renewal > 2 * price };
  }).sort((a, b) => Number(b.exact) - Number(a.exact)
    || qualityRank(a.domain, requested, eligible) - qualityRank(b.domain, requested, eligible) || firstCost(a) - firstCost(b)
    || supportedEndings.indexOf(a.tld) - supportedEndings.indexOf(b.tld) || a.domain.localeCompare(b.domain));
}

// The pick among recommendable free rows: the shared pick rule over upfront payment and payments due in 3 years.
// budget is the person's explicit cap, when given.
export function pickName(rows, eligible, requested = [], budget) {
  const options = rows.filter(row => canRecommend(row.tld, eligible) && !premiumRisk(row.domain)
    && ['probably-free', 'confirmed'].includes(row.status))
    .map(row => ({ domain: row.domain, exact: row.exact !== false, now: row.firstPayment ?? null, total: row.threeYear ?? null, row }));
  return choosePick(options, { requested, eligible, budget })?.row;
}

export function registrationStatus(registry) {
  if (registry.signal === 'reserved') return 'reserved';
  if (registry.status === 'free') return registry.signal === 'premium' ? 'premium' : 'probably-free';
  return registry.status === 'taken' ? 'taken' : 'check-at-shop';
}

export function applyLiveSite(registry, site) {
  if (registry.status !== 'free' || !['live', 'parked', 'for-sale'].includes(site?.state)) return registry;
  return { status: 'taken', source: 'web', checkedAt: registry.checkedAt, forSale: site.state === 'for-sale' };
}

export function listQuote(catalog, { domain, tld }, now, bundled = bundledCatalog) {
  // Data-only shops never become the listed pick or its checkout link.
  const prices = datedListPrices(catalog, tld, now, bundled).filter(row => linkable(row.id)).sort((a, b) =>
    a.firstYear - b.firstYear || a.renewal - b.renewal);
  const best = prices[0];
  const confirmShop = prices.find(row => confirmingShops.includes(row.id))?.id ??
    (tld === 'no' ? 'dynadot' : tld === 'so' ? 'namecheap' : 'spaceship');
  return {
    confirmShop,
    ...(best && { price: best.firstYear, renewal: best.renewal, shop: best.shop, priceSource: best.shop,
      priceCheckedAt: best.checkedAt, buyUrl: shopSearchUrl(best.id, domain) }),
  };
}

// Savings are proof, never a pitch: the pick's three-year list cost against the median of at least three distinct shops'
// dated list prices for the same ending, all over a common three-year term. The lower median is used, so the comparison
// is never the highest price. Only a strictly positive difference counts; anything else returns null.
export function listSavings(catalog, { tld, price, renewal, shop, priceCheckedAt }, now, bundled = bundledCatalog) {
  if (!(price > 0) || !(renewal > 0) || !shop || !priceCheckedAt) return null;
  const own = termCosts(tld, price, renewal);
  if (own.minimumYears !== 1 || own.renewalYears !== 1 || own.threeYear == null) return null;
  const byShop = new Map();
  for (const row of [...datedListPrices(catalog, tld, now, bundled), ...listedPrices(bundled, tld)]) {
    if (!byShop.has(row.shop) && row.firstYear > 0 && row.renewal > 0 && isListPriceUsable(row.checkedAt, now)) {
      byShop.set(row.shop, row);
    }
  }
  const listed = byShop.get(shop);
  // The pick must be one of the compared list prices, unchanged.
  if (listed?.firstYear !== price || listed.renewal !== renewal || listed.checkedAt !== priceCheckedAt) return null;
  const totals = [...byShop.values()].map(row => ({ shop: row.shop, checkedAt: row.checkedAt,
    total: termCosts(tld, row.firstYear, row.renewal).threeYear })).sort((a, b) => a.total - b.total || a.shop.localeCompare(b.shop));
  if (totals.length < 3) return null;
  const median = totals[Math.floor((totals.length - 1) / 2)];
  const saved = Math.round((median.total - own.threeYear) * 100) / 100;
  if (!(saved > 0) || median.shop === shop) return null;
  const dates = totals.map(row => new Date(row.checkedAt).toISOString().slice(0, 10)).sort();
  return { years: 3, here: own.threeYear, shop, median: median.total, medianShop: median.shop, saved, shops: totals.length,
    checkedFrom: dates[0], checkedTo: dates.at(-1) };
}

// A premium, reserved or possible-premium signal never leaves a list price on the row.
export function withoutListPrice(row, status, reason) {
  return { ...row, status, price: null, renewal: null, priceSource: null, priceCheckedAt: null, savings: null,
    ...(reason && { registryReason: reason }) };
}

// A quote above the same shop's list price without a standard-price marker may be premium.
export function possiblePremium(row, quote) {
  return quote?.status === 'confirmed' && quote.standard !== true && row?.shop != null && quote.shopName === row.shop
    && row.price != null && money(quote.price) > row.price + 0.01;
}

const money = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

export function mergeQuote(row, quote) {
  if (!quote || quote.status === 'could-not-confirm' || quote.error) {
    return row;
  }
  if (quote.status === 'taken') {
    return { ...row, status: 'taken', price: null, renewal: null, shop: null, buyUrl: null,
      priceCheckedAt: null, checkedAt: quote.checkedAt ?? row.checkedAt, source: 'shop' };
  }
  if (quote.status === 'reserved') {
    return { ...withoutListPrice(row, 'reserved', quote.reason ?? 'Not offered for registration'),
      checkedAt: quote.checkedAt ?? row.checkedAt };
  }
  // A short name stays a possible premium unless the shop marks its quote as standard.
  const premium = row.status === 'premium' && row.premium === true ? true
    : quote.status === 'premium' ? quote.premium ?? true : possiblePremium(row, quote) ? 'possible'
      : (row.premium === 'risk' || row.premiumRisk) && quote.standard !== true ? 'possible' : false;
  const price = money(quote.price) > 0 ? quote.price : null;
  // A shop quote replaces the list price, so a list-price comparison no longer applies.
  return { ...row, savings: null, status: premium ? 'premium' : quote.status, price, renewal: price == null ? null : quote.renewal ?? null,
    ...(premium && { premium }), shop: quote.shopName, buyUrl: quote.buyUrl, priceCheckedAt: null, priceSource: null,
    quotedAt: quote.checkedAt ?? null, checkedAt: quote.checkedAt ?? row.checkedAt, source: 'shop' };
}

export async function searchCandidates(groups, options = {}) {
  const start = performance.now();
  const budgetMs = options.budgetMs ?? 2700;
  const timeLeft = () => Math.max(0, Math.floor(start + budgetMs - performance.now()));
  const now = options.now ?? new Date();
  // Tests may inject another snapshot; null turns the bundled fallback off.
  const bundled = options.bundledCatalog === undefined ? bundledCatalog : options.bundledCatalog;
  const candidates = new Map(groups.flatMap(({ candidates }) => candidates.map(row => [row.domain, row])));
  const sites = new Map();
  const siteEndings = options.siteEndings ?? (options.skipComSite ? [] : ['com']);
  const lookedUp = new Map();
  const checks = [];
  const lateChecks = [];
  let catalog = null;
  let timer;
  let complete = false;
  const onResult = ({ domain, tld, exact }, registry, dnsCode) => {
    if (timeLeft() <= 0) return;
    const publish = (result) => {
      lookedUp.set(domain, result);
      const status = registrationStatus(result);
      options.onProgress?.({ domain, status: status === 'probably-free' && premiumRisk(domain) ? 'premium' : status });
    };
    // A negative registry answer can be wrong. A real response on the domain beats a free claim.
    // Replay and unit callers that inject registry traffic can inject the site check as well.
    const checkNegative = registry.status === 'free' && (options.fetcher === undefined || options.verifyFreeSite);
    const checkTaken = registry.status === 'taken' && exact && siteEndings.includes(tld) && (options.siteFilter?.(domain) ?? true);
    if (!checkNegative) publish(registry);
    if (!checkNegative && !checkTaken) return;
    if (dnsCode === 'ENOTFOUND' && !options.verifyFreeSite && !options.comSite) {
      // NXDOMAIN for the hostname also rules out its web address. Reuse the DNS answer.
      sites.set(domain, { result: { state: 'no-site', why: 'DNS NXDOMAIN' } });
      if (checkNegative) publish(registry);
      return;
    }
    // A taken site may get a longer, final check that outlives the first answer (settleSites collects it).
    const late = checkTaken && options.lateSiteMs > 0;
    const timeout = late ? options.lateSiteMs : Math.min(options.siteTimeout ?? 1200, timeLeft());
    const visit = checkNegative ? options.verifyFreeSite ?? options.comSite ?? checkDomainSite
      : options.comSite ?? checkDomainSite;
    const pending = Promise.resolve().then(() => visit(domain, timeout, options.siteDetails || checkNegative))
      .then(site => {
      sites.get(domain).result = site;
      options.onSite?.(domain, site);
      if (checkNegative) publish(applyLiveSite(registry, site));
    }, () => { if (checkNegative) publish(registry); });
    sites.set(domain, { pending });
    if (!late) checks.push(pending);
    else {
      // The first answer still waits as long as for any site check; the late check keeps running after that.
      lateChecks.push(pending);
      checks.push(Promise.race([pending, new Promise(resolve => {
        setTimeout(resolve, Math.min(options.siteTimeout ?? 1200, timeLeft())).unref?.();
      })]));
    }
  };
  const loadCatalog = options.cachedOnly ? loadCachedCatalog(options.directory)
    : getNameCatalog({ ...options, now, coldWaitMs: bundled ? 0 : Math.min(1900, budgetMs) });
  const work = Promise.all([
    lookupRegistrations([...candidates.values()], { ...options, now, timeLeft, onResult }),
    loadCatalog.then(value => { catalog = value; }),
  ]).then(async () => {
    await Promise.all(checks);
    complete = lookedUp.size === candidates.size;
  });
  try {
    await Promise.race([work, new Promise(resolve => { timer = setTimeout(resolve, timeLeft()); })]);
  } finally {
    clearTimeout(timer);
  }
  const checkedAt = (options.now ?? new Date()).toISOString();
  // Premium and reserved answers from earlier shop checks also hold here, so a list price never covers them.
  const signals = await cachedSignals([...candidates.keys()], { directory: options.directory, now });
  const results = groups.map(group => {
    const rows = rankName(group.candidates.map(row => {
      const lookup = lookedUp.get(row.domain);
      if (!lookup) {
        const waiting = withPremiumRisk({ ...row, status: 'check-at-shop', registryReason: 'Registry lookup timed out',
          ...listQuote(catalog, row, now, bundled) });
        const signal = signals.get(row.domain);
        return ['premium', 'reserved'].includes(signal?.status) ? mergeQuote(waiting, signal) : waiting;
      }
      const status = registrationStatus(lookup);
      const quote = listQuote(catalog, row, now, bundled);
      const listPrice = status === 'taken' && quote.price != null
        ? { shop: quote.shop, checkedAt: quote.priceCheckedAt, ...termCosts(row.tld, quote.price, quote.renewal),
          renewalJump: quote.renewal > 2 * quote.price }
        : null;
      const savings = status === 'probably-free' ? listSavings(catalog, { ...row, ...quote }, now, bundled) : null;
      const settled = withPremiumRisk({ ...row, status, checkedAt: lookup.checkedAt ?? checkedAt, source: lookup.source,
        registryReason: lookup.reason, forSale: Boolean(lookup.forSale), ...(lookup.marketplace && { marketplace: lookup.marketplace }),
        ...(status === 'check-at-shop' && lookup.likely && { likely: lookup.likely }),
        ...(status !== 'taken' ? quote : listPrice && { listPrice }), ...(savings && { savings }) });
      if (status === 'premium') return { ...withoutListPrice(settled, 'premium'), premium: true };
      if (status === 'reserved') return withoutListPrice(settled, 'reserved', lookup.reason);
      const signal = status === 'taken' ? null : signals.get(row.domain);
      return signal ? mergeQuote(settled, signal) : settled;
    }), options.preferredEndings, options.eligible);
    const checkedSites = {};
    for (const row of rows) {
      const site = sites.get(row.domain)?.result;
      if (!site) continue;
      checkedSites[row.tld] = site;
      if (site.state === 'for-sale') row.forSale = true;
    }
    return { ...group, results: rows, comSite: checkedSites.com ?? null, sites: checkedSites };
  });
  // Site checks that outlived the first answer fill in their group's sites when they finish.
  const settleSites = async () => {
    await Promise.all([...checks, ...lateChecks]);
    for (const group of results) {
      for (const row of group.results) {
        const site = sites.get(row.domain)?.result;
        if (!site || group.sites[row.tld]) continue;
        group.sites[row.tld] = site;
        if (row.tld === 'com') group.comSite = site;
        if (site.state === 'for-sale') row.forSale = true;
      }
    }
    return results;
  };
  return { groups: results, complete, priceDate: catalog?.checkedAt ?? bundled?.checkedAt ?? null, ms: Math.round(performance.now() - start),
    settleSites };
}

export async function searchName(input, options = {}) {
  const name = normalizeName(input);
  if (!name) return { error: 'Enter a name, such as Example Studio.' };
  if (options.endings && !validEndings(options.endings)) return { error: 'Choose supported domain endings.' };
  if (options.eligible !== undefined && !validEligibility(options.eligible)) return { error: 'Eligible endings must list supported restricted endings, such as no.' };
  const { groups: [{ results, comSite }], priceDate, ms } = await searchCandidates(
    [{ name, candidates: nameCandidates(name, options) }], options);
  return { name, hero: pickName(results, options.eligible, options.preferredEndings)?.domain ?? null,
    ...(options.eligible?.length && { eligible: options.eligible }), results, priceDate, comSite,
    checkedAt: options.now?.toISOString() ?? new Date().toISOString(), ms };
}
