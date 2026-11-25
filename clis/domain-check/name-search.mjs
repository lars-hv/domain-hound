import { checkDomainSite } from './com-site.mjs';
import { cachedSignals, confirmingShops } from './confirm.mjs';
import { bundledCatalog, datedListPrices, getNameCatalog, loadCachedCatalog, targetEndings } from './price-catalog.mjs';
import { linkable, shopSearchUrl } from './prices.mjs';
import { lookupRegistrations } from './registry.mjs';

const checked = '2026-11-23';
const facts = {
  ai: {
    minimumYears: 2, renewalYears: 2, note: 'Two year minimum',
    source: 'https://www.namecheap.com/domains/registration/cctld/ai/', checked,
  },
  no: {
    note: 'Norwegian address plus organization number or personal ID required',
    eligibility: 'Norwegian organization or eligible individual, with a Norwegian postal address',
    source: 'https://www.norid.no/en/om-domenenavn/regelverk-for-no/', checked,
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
export const defaultEndings = targetEndings;
export const restrictedEndings = Object.keys(facts).filter(tld => facts[tld].eligibility);
const firstCost = row => row.firstPayment ?? Infinity;

export function validEligibility(eligible) {
  return Array.isArray(eligible) && new Set(eligible).size === eligible.length
    && eligible.every(tld => restrictedEndings.includes(tld));
}

export function canRecommend(tld, eligible = []) {
  return !facts[tld]?.eligibility || eligible.includes(tld);
}

export function eligibilityNotes(endings) {
  const notes = Object.fromEntries(restrictedEndings.filter(tld => endings.includes(tld))
    .map(tld => [tld, facts[tld].note]));
  return Object.keys(notes).length ? notes : undefined;
}

export function validEndings(endings) {
  return Array.isArray(endings) && endings.length > 0 && endings.length <= targetEndings.length
    && endings.every(ending => targetEndings.includes(ending));
}

export function normalizeName(input) {
  if (typeof input !== 'string' || /[./\\]/.test(input)) return null;
  const name = input.normalize('NFKD').toLowerCase().replace(/[^a-z0-9-]/g, '');
  return label.test(name) ? name : null;
}

export function nameCandidates(name, { variants: includeVariants = true, endings = defaultEndings } = {}) {
  const selected = endings;
  const exact = [...new Set(selected)].map(tld => ({ domain: name + '.' + tld, tld, exact: true }));
  if (!includeVariants || !selected.includes('com')) return exact;
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

export function rankName(rows) {
  return rows.map(row => {
    const { tld, exact, status, price = null, renewal = null } = row;
    const reason = status === 'premium' ? 'Premium price' : status === 'reserved' ? 'Not offered for registration'
      : status === 'taken' ? 'Already registered'
      : status === 'check-at-shop' ? 'Check at shop'
      : exact ? 'Exact name' : 'Name variation';
    return { ...row, ...termCosts(tld, price, renewal), reason, terms: facts[tld] ?? null,
      renewalJump: price != null && renewal > 2 * price };
  }).sort((a, b) => Number(b.exact) - Number(a.exact) || firstCost(a) - firstCost(b)
    || defaultEndings.indexOf(a.tld) - defaultEndings.indexOf(b.tld) || a.domain.localeCompare(b.domain));
}

export function pickName(rows, eligible) {
  return rows.reduce((best, row) => {
    if (!canRecommend(row.tld, eligible) || !['probably-free', 'confirmed'].includes(row.status)) return best;
    return !best || firstCost(row) < firstCost(best) ||
      (firstCost(row) === firstCost(best) && row.exact && !best.exact) ? row : best;
  }, undefined);
}

export function registrationStatus(registry) {
  if (registry.signal === 'reserved') return 'reserved';
  if (registry.status === 'free') return registry.signal === 'premium' ? 'premium' : 'probably-free';
  return registry.status === 'taken' ? 'taken' : 'check-at-shop';
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

// A premium, reserved or possible-premium signal never leaves a list price on the row.
export function withoutListPrice(row, status, reason) {
  return { ...row, status, price: null, renewal: null, priceSource: null, priceCheckedAt: null,
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
  const premium = row.status === 'premium' && row.premium === true ? true
    : quote.status === 'premium' ? quote.premium ?? true : possiblePremium(row, quote) ? 'possible' : false;
  const price = money(quote.price) > 0 ? quote.price : null;
  return { ...row, status: premium ? 'premium' : quote.status, price, renewal: price == null ? null : quote.renewal ?? null,
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
  let catalog = null;
  let timer;
  let complete = false;
  const onResult = ({ domain, tld, exact }, registry) => {
    if (timeLeft() <= 0) return;
    lookedUp.set(domain, registry);
    if (registry.status !== 'taken' || !exact || !siteEndings.includes(tld)) return;
    const timeout = Math.min(options.siteTimeout ?? 1200, timeLeft());
    sites.set(domain, { pending: (options.comSite ?? checkDomainSite)(domain, timeout, options.siteDetails).then(site => {
      sites.get(domain).result = site;
      options.onSite?.(domain, site);
    }).catch(() => {}) });
  };
  const loadCatalog = options.cachedOnly ? loadCachedCatalog(options.directory)
    : getNameCatalog({ ...options, now, coldWaitMs: bundled ? 0 : Math.min(1900, budgetMs) });
  const work = Promise.all([
    lookupRegistrations([...candidates.values()], { ...options, now, timeLeft, onResult }),
    loadCatalog.then(value => { catalog = value; }),
  ]).then(async () => {
    await Promise.all([...sites.values()].map(site => site.pending));
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
        const waiting = { ...row, status: 'check-at-shop', registryReason: 'Registry lookup timed out',
          ...listQuote(catalog, row, now, bundled) };
        const signal = signals.get(row.domain);
        return ['premium', 'reserved'].includes(signal?.status) ? mergeQuote(waiting, signal) : waiting;
      }
      const status = registrationStatus(lookup);
      const quote = listQuote(catalog, row, now, bundled);
      const listPrice = status === 'taken' && quote.price != null
        ? { shop: quote.shop, checkedAt: quote.priceCheckedAt, ...termCosts(row.tld, quote.price, quote.renewal),
          renewalJump: quote.renewal > 2 * quote.price }
        : null;
      const settled = { ...row, status, checkedAt: lookup.checkedAt ?? checkedAt, source: lookup.source, registryReason: lookup.reason,
        forSale: Boolean(lookup.forSale), ...(lookup.marketplace && { marketplace: lookup.marketplace }),
        ...(status !== 'taken' ? quote : listPrice && { listPrice }) };
      if (status === 'premium') return { ...withoutListPrice(settled, 'premium'), premium: true };
      if (status === 'reserved') return withoutListPrice(settled, 'reserved', lookup.reason);
      const signal = status === 'taken' ? null : signals.get(row.domain);
      return signal ? mergeQuote(settled, signal) : settled;
    }));
    const checkedSites = {};
    for (const row of rows) {
      const site = sites.get(row.domain)?.result;
      if (!site) continue;
      checkedSites[row.tld] = site;
      if (site.state === 'for-sale') row.forSale = true;
    }
    return { ...group, results: rows, comSite: checkedSites.com ?? null, sites: checkedSites };
  });
  return { groups: results, complete, priceDate: catalog?.checkedAt ?? bundled?.checkedAt ?? null, ms: Math.round(performance.now() - start) };
}

export async function searchName(input, options = {}) {
  const name = normalizeName(input);
  if (!name) return { error: 'Enter a name, such as Example Studio.' };
  if (options.endings && !validEndings(options.endings)) return { error: 'Choose supported domain endings.' };
  if (options.eligible !== undefined && !validEligibility(options.eligible)) return { error: 'Eligible endings must list supported restricted endings, such as no.' };
  const { groups: [{ results, comSite }], priceDate, ms } = await searchCandidates(
    [{ name, candidates: nameCandidates(name, options) }], options);
  return { name, hero: pickName(results, options.eligible)?.domain ?? null,
    ...(options.eligible?.length && { eligible: options.eligible }), results, priceDate, comSite,
    checkedAt: options.now?.toISOString() ?? new Date().toISOString(), ms };
}
