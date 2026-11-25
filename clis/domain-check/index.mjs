import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { apiShops, cachedSignals, confirmDomain, confirmingShops, lightConfirm } from './confirm.mjs';
import { checkDomainSite } from './com-site.mjs';
import { appStoreSearchLink, googleSearchLink, nameCheckLines, playSearchLink } from './google-search.mjs';
import { applyLiveSite, asciiDomain, canRecommend, defaultEndings, eligibilityNotes, listQuote, mergeQuote, nameCandidates, normalizeName, pickName,
  premiumRisk, rankName, registrationStatus, searchCandidates, searchName, termCosts, unicodeName, validEligibility, validEndings,
  withPremiumRisk, withoutListPrice } from './name-search.mjs';
import { bundledCatalog, catalogOffers, datedListPrices, isListPriceUsable, loadCachedCatalog, refreshPrices } from './price-catalog.mjs';
import { lookupRegistrations } from './registry.mjs';
import { namingRecipe, purchaseLine } from './naming-method.mjs';
import { progressReporter } from './progress.mjs';
import { namePresence, triageNames } from './triage.mjs';
import { refreshTranco } from './traction.mjs';
import {
  catalogPrice, dynadotOffer, linkable, money, offer, porkbunOffer, rankedFirstYear, shops, shopSearchUrl, threeYearCost, transferStrategy, vatNorway,
} from './prices.mjs';

const runFile = promisify(execFile);
const maxTimeout = 8000;
const totalTimeout = 19000;
const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const porkbun = 'https://api.porkbun.com/api/json/v3/';
const nokUrl = 'https://data.norges-bank.no/api/data/EXR/B.USD.NOK.SP?lastNObservations=1&format=sdmx-json';
const shopHosts = new Set([
  'spaceship.com', 'www.spaceship.com', 'namecheap.com', 'www.namecheap.com',
  'dynadot.com', 'www.dynadot.com', 'domains.cloudflare.com', 'dash.cloudflare.com', 'www.cloudflare.com',
  'www.namesilo.com', 'shop.gandi.net', 'www.ionos.com', 'www.hover.com',
  'euipo.europa.eu', 'tmsearch.uspto.gov', 'www.godaddy.com', 'domains.squarespace.com', 'www.hostinger.com',
]);
// These TLDs add exactly one registration year when transferred.
const oneYearTransfer = new Set(['me', 'com', 'net', 'org']);
const searchHosts = new Set(['www.google.com', 'apps.apple.com', 'play.google.com']);

function trustedNameSearch(url) {
  const query = url.searchParams.get('q') ?? '';
  if (url.host === 'www.google.com') {
    return query.startsWith('"') && query.endsWith('"') && url.href === googleSearchLink(query.slice(1, -1));
  }
  if (url.host === 'apps.apple.com') {
    const term = url.searchParams.get('term');
    return Boolean(term) && url.href === appStoreSearchLink(term);
  }
  return url.host === 'play.google.com' && Boolean(query) && url.href === playSearchLink(query);
}

async function openShop(args) {
  const dryRun = args[0] === '--dry-run';
  const [value] = dryRun ? args.slice(1) : args;
  const error = { error: 'Use an HTTPS link to a trusted domain shop or search page.' };
  if (args.length !== (dryRun ? 2 : 1) || /[\s\\\u0000-\u001f\u007f]/u.test(value ?? '')) return error;
  const authority = value?.match(/^https:\/\/([^/?#]+)/i)?.[1]?.toLowerCase();
  if (!shopHosts.has(authority) && !searchHosts.has(authority)) return error;
  let url;
  try { url = new URL(value); } catch { return error; }
  if (url.protocol !== 'https:' || (!shopHosts.has(url.host) && !trustedNameSearch(url))
    || (url.hostname === 'www.cloudflare.com' && url.pathname !== '/domains/search/')) return error;
  if (dryRun) return { opened: false, url: url.href };
  try {
    await runFile('/usr/bin/open', [url.href], { timeout: maxTimeout });
    return { opened: true };
  } catch {
    return { error: 'Couldn’t open the link in the browser.' };
  }
}

export function normalize(input) {
  const typed = typeof input === 'string' ? input.trim().toLowerCase()
    .replace(/^[a-z][a-z\d+.-]*:\/\//, '')
    .split(/[/?#]/, 1)[0]
    .replace(/^www\.(?=[^.]+\.)/, '') : '';
  // A Unicode domain is checked as its punycode form, never with letters removed.
  const domain = asciiDomain(typed) ?? '';
  const labels = domain.split('.');
  const label = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/;
  const tld = /^(?:[a-z]{2,63}|xn--[a-z\d](?:[a-z\d-]{0,57}[a-z\d])?)$/;
  return labels.length === 2 && labels.every(part => label.test(part))
    && tld.test(labels.at(-1)) ? domain : null;
}

async function request(url, options, read, fetcher, timeout) {
  if (timeout <= 0) return null;
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(timeout), ...options });
    const data = response.ok ? await read(response).catch(() => null) : null;
    return { status: response.status, data };
  } catch {
    return null;
  }
}

function loadJson(url, fetcher, timeout, body, signal) {
  const options = body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
  };
  return request(url, signal ? { ...options, signal } : options, response => response.json(), fetcher, timeout);
}

async function loadPricing(tld, fetcher, timeout) {
  if (timeout <= 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const { signal } = controller;
  const url = porkbun + 'pricing/get';
  async function read(query, body) {
    const result = await loadJson(url + query, fetcher, timeout, body, signal);
    if (result?.data?.status !== 'SUCCESS' || !result.data.pricing) throw new Error('No pricing');
    return result.data;
  }
  try {
    // The unfiltered POST can stall. Porkbun also documents a TLD-filtered GET.
    return await Promise.any([
      read('', {}),
      delay(350, undefined, { signal }).then(() => read('?tld=' + tld)),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function loadDynadot(tld, fetcher, timeout) {
  const result = await request('https://www.dynadot.com/domain/tld/' + tld,
    { headers: { 'User-Agent': userAgent, 'Accept-Language': 'en-US' } },
    response => response.text(), fetcher, timeout);
  return result?.data ?? '';
}

async function loadNok(fetcher, timeout) {
  const result = await loadJson(nokUrl, fetcher, timeout);
  const data = result?.data?.data;
  const periods = data?.structure?.dimensions?.observation?.find(dimension => dimension.id === 'TIME_PERIOD')?.values;
  const observations = data?.dataSets?.[0]?.series?.['0:0:0:0']?.observations;
  if (!observations || !Array.isArray(periods)) return null;
  return Object.entries(observations).map(([index, values]) => ({
    rate: Number(values?.[0]),
    date: periods[index]?.id,
  })).filter(({ rate, date }) => Number.isFinite(rate) && rate > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
}

function yes(value) {
  return [true, 1, '1', 'yes', 'true'].includes(value);
}

export function parseConfirmation(response) {
  const data = response?.response ?? response;
  if (response?.status !== 'SUCCESS' || response.sandbox === true
    || !yes(data?.avail ?? data?.available) || (data.type && data.type !== 'registration')) return null;
  const premium = yes(data.premium);
  const price = premium ? money(data.price) : catalogPrice(data.price);
  if (price === null || price <= 0) return null;
  return { by: 'Porkbun', price, premium };
}

async function liveConfirmation(domain, env, fetcher, timeout) {
  const apikey = env.DOMAIN_HOUND_PORKBUN_API_KEY;
  const secretapikey = env.DOMAIN_HOUND_PORKBUN_SECRET_KEY;
  if (!apikey || !secretapikey) return null;
  const result = await loadJson(porkbun + 'domain/checkDomain/' + encodeURIComponent(domain),
    fetcher, timeout, { apikey, secretapikey });
  return parseConfirmation(result?.data);
}

const cost = value => value ?? Infinity;

export async function checkDomain(input, {
  fetcher = globalThis.fetch, directory, queryWhois, env = process.env, now = new Date(), bundled = bundledCatalog,
} = {}) {
  const domain = normalize(input);
  if (!domain) return { error: 'Enter a domain such as example.com.' };
  const tld = domain.split('.').at(-1);
  const deadline = performance.now() + totalTimeout;
  const timeout = () => Math.max(0, Math.min(maxTimeout, Math.floor(deadline - performance.now())));
  const [registrations, catalog, pricing, dynadot, confirmed, nok, signals] = await Promise.all([
    lookupRegistrations([{ domain, tld }], { fetcher, directory, queryWhois, now,
      timeLeft: timeout, dnsFirst: false, readExpiry: true }),
    loadCachedCatalog(directory),
    loadPricing(tld, fetcher, timeout()),
    loadDynadot(tld, fetcher, timeout()),
    liveConfirmation(domain, env, fetcher, timeout()),
    loadNok(fetcher, timeout()),
    cachedSignals([domain], { directory, now }),
  ]);
  const registry = registrations[0];
  const listFor = (_domain, shop) => datedListPrices(catalog, tld, now, bundled).find(row => row.id === shop) ?? null;
  const shopQuote = registry.status === 'taken' ? null : signals.get(domain)
    ?? (await lightConfirm([domain], { env, fetcher, directory, now, deadline: performance.now() + timeout(), listFor })).get(domain) ?? null;
  // Porkbun's own quote above its list price, without a premium flag, may still be premium.
  const porkbunList = pricing?.pricing?.[tld] ? catalogPrice(pricing.pricing[tld].registration) : null;
  const porkbunPremium = confirmed && (confirmed.premium || (porkbunList != null && confirmed.price > porkbunList + 0.01));
  // A short name may be premium: no list price unless a shop marks its quote as standard.
  const risk = registry.status === 'free' && premiumRisk(domain) && shopQuote?.standard !== true && !porkbunPremium;
  const premium = registry.signal === 'premium' || shopQuote?.status === 'premium' || porkbunPremium || risk;
  const reserved = registry.signal === 'reserved' || shopQuote?.status === 'reserved';
  const verdict = shopQuote?.status === 'taken' || registry.status === 'taken' ? 'taken'
    : reserved ? 'reserved' : premium ? 'premium' : confirmed || shopQuote?.status === 'confirmed' ? 'confirmed' : registry.status;
  const offers = [];
  if (verdict === 'premium' || verdict === 'reserved') {
    // A premium or reserved name is never shown at list price.
    const quoted = shopQuote?.price != null && shopQuote.status === 'premium' ? shopQuote : null;
    const shopId = quoted?.shop ?? (tld === 'no' ? 'dynadot' : 'spaceship');
    const best = quoted ? { ...offer(shopId, domain, { firstYear: quoted.price, regularFirstYear: quoted.price,
      renewal: quoted.renewal, evidence: 'shop', source: 'api', checkedAt: quoted.checkedAt }),
    premium: quoted.premium, label: 'confirmed at ' + shops[shopId].name + ' ' + quoteTime(quoted.checkedAt) } : null;
    return {
      domain, confirmShop: shopId, confirmShopName: shops[shopId].name, checkedAt: now.toISOString(), verdict, registry,
      confirmed: confirmed ? { ...confirmed, ...(!confirmed.premium && { possible: true }) } : null,
      ...(shopQuote && { shopQuote }), best, cheapestToday: null, offers: best ? [best] : [], stale: false,
      priceDate: null, nok, vatNorway,
      ...(risk && !quoted && { premiumRisk: true }),
      notes: [registry.reason, reserved ? 'Not offered for registration; check at the shop'
        : best ? null : risk && !registry.signal ? 'May be premium, price at shop' : 'Premium, price at shop'].filter(Boolean),
      buyUrl: shopSearchUrl(shopId, domain),
    };
  }
  if (verdict !== 'taken') {
    // Live shop prices replace a saved or bundled list price from the same shop.
    const priced = [...catalogOffers(catalog, tld, domain, datedListPrices(catalog, tld, now, bundled)),
      porkbunOffer(pricing, tld, domain, now), dynadotOffer(dynadot, tld, domain, now)].filter(Boolean);
    const byShop = new Map(priced.map(row => [row.shop, row]));
    for (const [id, { name }] of Object.entries(shops)) {
      const row = byShop.get(name) ?? offer(id, domain, {
        firstYear: null, regularFirstYear: null, renewal: null, checkedAt: null, source: null,
      });
      if (shopQuote?.status === 'confirmed' && name === shopQuote.shopName) {
        Object.assign(row, { firstYear: shopQuote.price, regularFirstYear: shopQuote.price, code: null, codeNote: null,
          renewal: shopQuote.renewal, source: 'api', checkedAt: shopQuote.checkedAt,
          label: 'confirmed at ' + name + ' ' + quoteTime(shopQuote.checkedAt) });
        row.threeYear = threeYearCost(row);
      }
      if (name === confirmed?.by && !confirmed.premium) {
        row.regularFirstYear = confirmed.price;
        if (!row.code || row.firstYear >= confirmed.price) {
          Object.assign(row, { firstYear: confirmed.price, code: null, codeNote: null });
        }
        row.threeYear = threeYearCost(row);
      }
      offers.push(row);
    }
    offers.sort((a, b) => cost(rankedFirstYear(a)) - cost(rankedFirstYear(b)) || cost(a.renewal) - cost(b.renewal));
    for (const row of offers) row.label ??= row.firstYear == null ? null : 'list price';
  }
  // Data-only shops stay in offers as evidence but are never the pick or the cheapest link.
  const picks = offers.filter(row => !row.dataOnly);
  const best = picks.find(row => rankedFirstYear(row) != null) ?? null;
  const today = picks.reduce((lowest, row) => cost(rankedFirstYear(row)) < cost(rankedFirstYear(lowest ?? {})) ? row : lowest, best);
  const priceDate = best?.checkedAt?.slice(0, 10) ?? null;
  const stale = !best || !isListPriceUsable(best.checkedAt, now);
  const transfer = !stale && !confirmed?.premium && oneYearTransfer.has(tld)
    ? transferStrategy(picks.filter(row => isListPriceUsable(row.checkedAt, now))) : null;
  const confirmingOffer = picks.find(row => rankedFirstYear(row) != null && confirmingShops.includes(shopIds.get(row.shop)));
  const confirmShop = shopIds.get(confirmingOffer?.shop)
    ?? (tld === 'no' ? 'dynadot' : tld === 'so' ? 'namecheap' : 'spaceship');
  return {
    domain, confirmShop, confirmShopName: shops[confirmShop].name, checkedAt: now.toISOString(), verdict, registry, confirmed,
    ...(shopQuote && { shopQuote }), best,
    cheapestToday: today === best ? null : today,
    ...(transfer && { transfer }),
    offers, stale, priceDate, nok, vatNorway,
    notes: [registry.reason, verdict !== 'taken' && !best ? 'Price at the shop' : null].filter(Boolean),
  };
}

const shopIds = new Map(Object.entries(shops).map(([id, { name }]) => [name, id]));

// "12:04 UTC" for a shop quote.
function quoteTime(value) {
  const time = typeof value === 'string' ? value.match(/T(\d{2}:\d{2})/)?.[1] : null;
  return time ? time + ' UTC' : '';
}

const agentLegend = {
  nc: 'Free at the registry; list price, not confirmed',
  ok: 'Free, price confirmed at the shop (at = quote time)',
  prem: 'Premium: price at the shop, never a list price',
  resale: 'Taken, possible resale',
  shop_check: 'Registry did not settle; check at a shop',
  d: 'Ending, or full domain for a name variant',
  now: 'First payment, USD ex. VAT',
  renew: 'Renewal payment, USD ex. VAT',
  y3: 'Payments due in three years, USD ex. VAT',
  term: 'Years per payment when more than one',
  jump: 'Renewal over twice the first annual price',
  risk: 'Short name: may be premium, price at the shop',
  likely_free: 'Registry silent, DNS has no delegation: likely free, confirm at a shop',
  likely_taken: 'Registry silent, DNS has a delegation: likely taken',
};
const googleEndings = new Set(['app', 'dev']);
// Playwright is optional. Without it (or its browser) the live shop check cannot run at all.
const missingBrowser = new Map([
  ['Playwright is unavailable.', 'Playwright is not installed'],
  ['Headless Chromium is unavailable.', 'the Playwright browser could not start'],
]);

export function liveCheckFor(candidate, quote) {
  const reason = quote?.status === 'could-not-confirm' ? missingBrowser.get(quote.reason) : undefined;
  if (!candidate || !reason) return null;
  const checkUrl = typeof quote.buyUrl === 'string' && quote.buyUrl ? quote.buyUrl
    : shopSearchUrl(candidate.confirmShop, candidate.domain);
  return { domain: candidate.domain, status: 'check-at-shop', reason, ...(checkUrl && { checkUrl }) };
}

// A short human reason for each ending that still needs a shop check.
function shopCheckReason(row, rateLimited) {
  if (googleEndings.has(row.tld) && rateLimited) return 'Google Registry rate limit (HTTP 429)';
  const reason = String(row.registryReason ?? '');
  if (/HTTP 429/.test(reason)) return 'Registry rate limit (HTTP 429)';
  if (/timed out|did not respond/i.test(reason)) return 'Registry did not answer in time';
  return reason.split('; ').at(-1).slice(0, 80) || 'Registry did not answer in time';
}

function agentPrice({ firstPayment: now, renewalPayment: renew, threeYear: y3, minimumYears, renewalJump, shop }) {
  return { ...(now != null && { now }), ...(renew != null && { renew }), ...(y3 != null && { y3 }),
    ...(minimumYears > 1 && { term: minimumYears }), ...(renewalJump && { jump: true }), ...(shop && { shop }) };
}

// The shop quote time as HH:MM UTC.
const quoteClock = value => typeof value === 'string' ? value.match(/T(\d{2}:\d{2})/)?.[1] ?? null : null;

function compactAgentResult(groups, names, complete, checkedAt, batch, rateLimited = false, liveCheck = null,
  { eligible, otherEndings } = {}) {
  const buyUrlTemplate = {};
  const shopCheckWhy = {};
  const listPrices = {};
  const checkedEndings = new Set();
  const byName = new Map();
  let priceListDate;
  let best;
  for (const { name, results } of groups) {
    const taken = [], resale = [], free = [], shop_check = [], reserved = [], likelyFree = [], likelyTaken = [];
    for (const row of results) {
      checkedEndings.add(row.tld);
      const d = row.exact ? row.tld : row.domain;
      const shop = row.shop ?? shops[row.confirmShop]?.name;
      const premium = row.status === 'premium';
      const confirmed = row.status === 'confirmed' || (premium && row.price != null && row.source === 'shop');
      const price = agentPrice({ ...row, shop });
      // A taken exact domain can show a standard ending benchmark. For .ai this explains its two-year renewal.
      const benchmark = !batch && row.exact && row.status === 'taken' && row.listPrice
        && (row.tld === 'ai' || !premiumRisk(row.domain));
      if ((batch || benchmark) && !confirmed && !premium && row.status !== 'reserved' && listPrices[d]?.now == null) {
        const listed = row.listPrice ? agentPrice(row.listPrice) : price;
        if (Object.keys(listed).length) listPrices[d] = listed;
      }
      const date = (row.priceCheckedAt ?? (batch || benchmark ? row.listPrice?.checkedAt : null))?.slice(0, 10);
      // Use the oldest list date among the displayed estimates.
      if (date && (priceListDate === undefined || date < priceListDate)) priceListDate = date;
      if (row.status === 'taken') {
        (row.forSale ? resale : taken).push(d);
        continue;
      }
      const shopId = shopIds.get(shop);
      if (shopId && linkable(shopId)) {
        const { url, suffix = '' } = shops[shopId];
        buyUrlTemplate[shop] = url + '{domain}' + suffix;
      }
      if (premium && !confirmed) {
        // Premium without a price: free to register, but only the shop shows the price. A short name may be premium.
        free.push({ d, s: 'prem', ...(shop && { shop }), ...(row.premium === 'risk' && { risk: true }) });
        continue;
      }
      if (row.status === 'reserved') {
        shop_check.push(d);
        reserved.push(d);
        shopCheckWhy[row.domain] = String(row.registryReason ?? 'Not offered for registration').slice(0, 80);
        continue;
      }
      if (!confirmed && row.status !== 'probably-free') {
        if (!batch && row.status === 'check-at-shop' && price.now != null) listPrices[d] = price;
        shop_check.push(d);
        shopCheckWhy[d] ??= shopCheckReason(row, rateLimited);
        if (row.likely === 'free') likelyFree.push(d);
        if (row.likely === 'taken') likelyTaken.push(d);
        continue;
      }
      // A batch row repeats its ending's standard price only when it differs.
      const standard = batch && !confirmed && listPrices[d] && JSON.stringify(listPrices[d]) === JSON.stringify(price);
      const at = confirmed ? quoteClock(row.quotedAt ?? row.checkedAt) : null;
      free.push({ d, s: confirmed ? 'ok' : 'nc', ...(!standard && price), ...(premium && { prem: row.premium ?? true }),
        ...(at && { at }) });
      if (confirmed && !premium && canRecommend(row.tld, eligible) && !premiumRisk(row.domain)) {
        const { now, renew, y3, term, jump } = price;
        const buyUrl = row.buyUrl ?? shopSearchUrl(shopId, row.domain);
        // The cheapest confirmed quote is the pick; rows are already sorted by first payment within a name.
        if (best && (best.priceNow ?? Infinity) <= (now ?? Infinity)) continue;
        best = { domain: row.domain, status: 'free-confirmed', ...(now != null && { priceNow: now }), ...(at && { at }),
          ...(renew != null && { renewal: renew }), ...(y3 != null && { threeYear: y3 }),
          ...(term && { term }),
          ...(jump && { renewalNote: 'Renews at $' + renew.toFixed(2) }),
          ...(shop && { shop }), ...(buyUrl && { buyUrl }) };
      }
    }
    const unicode = unicodeName(name);
    byName.set(name, { name, ...(unicode && { unicode }), ...(taken.length && { taken }), ...(resale.length && { resale }),
      ...(free.length && { free }), ...(shop_check.length && { shop_check }),
      ...(reserved.length && { reserved }),
      // Subsets of shop_check with a DNS likelihood; only a registry or shop settles them.
      ...(likelyFree.length && { likely_free: likelyFree }), ...(likelyTaken.length && { likely_taken: likelyTaken }) });
  }
  const result = {
    ...(!batch && names[0].includes('.') && {
      purchaseAdvice: 'For a purchase request, include this sentence even when the domain is taken: ' + purchaseLine,
    }),
    complete, checkedAt, ...(priceListDate && { priceListDate }), ...(best && { best }),
    eligibility: eligibilityNotes([...checkedEndings]),
    ...(eligible?.length && { eligible }),
    names: names.map(name => byName.get(name)),
    legend: agentLegend,
    ...(Object.keys(buyUrlTemplate).length && { buyUrlTemplate }),
    ...(Object.keys(shopCheckWhy).length && { shopCheckWhy }),
    // The registry and list-price evidence above stays; this only says the shop quote could not be checked.
    ...(liveCheck && !best && { liveCheck }),
    ...(otherEndings && Object.keys(otherEndings).length && { otherEndings }),
  };
  if (Object.keys(listPrices).length) {
    result.listPrices = listPrices;
    result.legend = { ...agentLegend, listPrices: 'List estimate by ending when no shop quote is shown' };
  }
  if (batch && Buffer.byteLength(JSON.stringify(result)) >= 7900) {
    for (const row of byName.values()) {
      if (row.free) row.free = row.free.map(({ d, s, ...price }) =>
        s === 'nc' ? { d, s } : { d, s, ...price });
    }
  }
  return result;
}

// The top pick and up to three runners-up get a light confirm: registry signals first, then a keyed shop API.
export function lightTargets(rows, eligible, count = 4) {
  const top = pickName(rows, eligible);
  const others = rankName(rows.filter(row => row !== top && ['probably-free', 'premium'].includes(row.status)
    && canRecommend(row.tld, eligible)));
  return [top, ...others].filter(Boolean).slice(0, count);
}

export async function agentResult(input, options = {}) {
  const batch = Array.isArray(input);
  // The default path has no browser and answers a single name or a small batch within 8 seconds.
  // Larger batches and the explicit browser check keep room under the 15-second wall clock limit.
  const small = !batch || input.length <= 3;
  const deadline = performance.now() + (options.budgetMs ?? (options.browser || !small ? 13_900 : 7_400));
  const remaining = () => Math.max(0, Math.floor(deadline - performance.now()));
  if (batch && (!input.length || input.length > 20)) return { error: 'Provide 1 to 20 names.' };
  if (options.endings && !validEndings(options.endings)) return { error: 'Choose supported domain endings.' };
  if (options.eligible !== undefined && !validEligibility(options.eligible)) return { error: 'Eligible endings must list supported restricted endings, such as no.' };
  const domain = !batch && normalize(input);
  // In a batch, an entry with a dot is an exact domain and any other entry is a bare name.
  const exactDomain = value => typeof value === 'string' && value.includes('.');
  const names = domain ? [domain] : (batch ? input : [input])
    .map(value => batch && exactDomain(value) ? normalize(value) : normalizeName(value));
  if (names.includes(null)) return { error: 'Enter a valid name or exact domain.' };
  const exact = new Set(domain ? [domain] : names.filter((name, index) => batch && exactDomain(input[index])));
  const groups = [...new Set(names)].map(name => ({ name, candidates: exact.has(name)
    ? [{ domain: name, tld: name.split('.').at(-1), exact: true }] : nameCandidates(name, { ...options, variants: !batch }) }));
  const keyed = apiShops(options.env ?? process.env).length > 0;
  const reserve = keyed ? 1800 : 0;
  const searchOptions = { ...options, budgetMs: Math.max(0, Math.min(remaining() - reserve, batch ? 10_700 : 2700)),
    skipComSite: batch || options.skipComSite };
  const fast = await searchCandidates(groups, searchOptions);
  let rateLimited = fast.groups.some(group => group.results.some(row =>
    googleEndings.has(row.tld) && /HTTP 429/.test(row.registryReason ?? '')));
  if (batch) rateLimited = await retryGoogle(fast, remaining, options) || rateLimited;
  const rows = fast.groups.flatMap(group => group.results);
  const targets = domain ? rows.filter(row => canRecommend(row.tld, options.eligible)
    && ['probably-free', 'check-at-shop', 'premium'].includes(row.status))
    : lightTargets(rows, options.eligible);
  const [candidate] = targets;
  // A Google retry can settle every row that the first pass left waiting.
  let complete = fast.complete || !rows.some(row => row.registryReason === 'Registry lookup timed out');
  const quotes = new Map();
  if (targets.length) {
    options.onProgress?.({ stage: 'quotes' });
    const catalog = await loadCachedCatalog(options.directory);
    const listFor = (target, shop) => datedListPrices(catalog, target.split('.').at(-1), options.now ?? new Date(),
      options.bundledCatalog === undefined ? bundledCatalog : options.bundledCatalog).find(row => row.id === shop) ?? null;
    const light = options.lightConfirm ?? lightConfirm;
    const found = await light(targets.map(row => row.domain), { env: options.env, fetcher: options.fetcher,
      directory: options.directory, now: options.now, deadline: performance.now() + Math.max(0, remaining() - 150), listFor })
      .catch(() => new Map());
    for (const [key, value] of found) quotes.set(key, value);
  }
  let quote;
  const firstQuote = candidate && quotes.get(candidate.domain);
  const fallback = options.browser && candidate && (!firstQuote || firstQuote.status === 'could-not-confirm'
    || firstQuote.status === 'premium' && firstQuote.price == null);
  if (fallback && remaining() >= 1000) {
    // The headless browser runs only when the person explicitly asks for it.
    options.onProgress?.({ stage: 'browser' });
    const confirm = options.confirm ?? confirmDomain;
    let timer;
    try {
      quote = await Promise.race([
        confirm(candidate.confirmShop, candidate.domain, { deadline, directory: options.directory,
          unsupported: ['so', 'no'], fresh: true, oneShop: batch }).catch(() => null),
        new Promise(resolve => { timer = setTimeout(resolve, remaining()); }),
      ]);
      if (!remaining() || quote === undefined) complete = false;
    } finally {
      clearTimeout(timer);
    }
    if (quote && quote.status !== 'could-not-confirm') {
      quotes.set(candidate.domain, firstQuote?.status === 'premium' && quote.available === true
        ? { ...quote, status: 'premium', premium: firstQuote.premium } : quote);
    }
  } else if (fallback) {
    complete = false;
  }
  const apply = row => quotes.has(row.domain) ? mergeQuote(row, quotes.get(row.domain)) : row;
  const rankedGroups = fast.groups.map(group => ({ ...group, results: rankName(group.results.map(apply)) }));
  const checkedAt = options.now?.toISOString() ?? new Date().toISOString();
  // An exact .com gets the standard list prices of the other endings as one benchmark line, with no extra lookups.
  const exactCom = names.length === 1 && names[0].endsWith('.com') ? names[0] : null;
  const otherEndings = exactCom ? await endingBenchmarks(exactCom, options) : null;
  const result = compactAgentResult(rankedGroups, names, complete, checkedAt, batch, rateLimited,
    options.browser ? liveCheckFor(candidate, quote) : null, { eligible: options.eligible, otherEndings });
  if (options.receipt) result.receiptDetails = rankedGroups.map(({ results, sites }) => ({ endings: results.map(row => ({
    domain: row.domain, source: row.source, checkedAt: row.checkedAt, priceAt: row.priceCheckedAt,
    shop: row.shop, checkout: row.buyUrl, site: sites?.[row.tld], risk: row.premium === 'risk' || row.premiumRisk,
  })) }));
  return result;
}

// The cheapest standard list price of each other ending for this label, from the saved or bundled price list.
// A short label may be premium, so it gets no benchmark.
async function endingBenchmarks(domain, options) {
  const label = domain.slice(0, domain.indexOf('.'));
  if (premiumRisk(label)) return null;
  const now = options.now ?? new Date();
  const bundled = options.bundledCatalog === undefined ? bundledCatalog : options.bundledCatalog;
  const catalog = await loadCachedCatalog(options.directory).catch(() => null);
  const prices = {};
  for (const tld of defaultEndings.filter(ending => ending !== 'com' && canRecommend(ending, options.eligible))) {
    const quote = listQuote(catalog, { domain: label + '.' + tld, tld }, now, bundled);
    if (quote.price == null) continue;
    const costs = termCosts(tld, quote.price, quote.renewal);
    prices[tld] = agentPrice({ ...costs, renewalJump: quote.renewal > 2 * quote.price, shop: quote.shop });
  }
  return prices;
}

// Give unresolved .app and .dev rows one bounded registry retry with the batch time that is left.
async function retryGoogle(fast, remaining, options) {
  const pending = new Map();
  for (const group of fast.groups) {
    for (const row of group.results) {
      if (row.status === 'check-at-shop' && googleEndings.has(row.tld)) pending.set(row.domain, row);
    }
  }
  const budget = Math.min(3000, remaining() - 2500);
  if (!pending.size || budget < 400) return false;
  const until = performance.now() + budget;
  const timeLeft = () => Math.max(0, Math.floor(until - performance.now()));
  const answers = new Map();
  const siteChecks = [];
  const sites = new Map();
  const verify = options.verifyFreeSite ?? options.comSite ?? checkDomainSite;
  const checkNegative = options.fetcher === undefined || options.verifyFreeSite;
  let timer;
  await Promise.race([
    lookupRegistrations([...pending.values()].map(({ domain, tld, exact }) => ({ domain, tld, exact })), {
      directory: options.directory, fetcher: options.fetcher, pause: options.pause, now: options.now,
      // DNS already showed no name servers for these rows.
      resolveNs: async () => [], timeLeft, rdapAttempts: 1,
      onResult: ({ domain }, registry) => {
        if (!timeLeft()) return;
        if (registry.status !== 'free' || !checkNegative) {
          answers.set(domain, registry);
          return;
        }
        const wait = Math.min(1_200, timeLeft());
        siteChecks.push(Promise.resolve().then(() => verify(domain, wait, true)).then(site => {
          sites.set(domain, site);
          answers.set(domain, applyLiveSite(registry, site));
        }, () => { answers.set(domain, registry); }));
      },
    }).then(() => Promise.all(siteChecks)).catch(() => {}),
    new Promise(resolve => { timer = setTimeout(resolve, budget + 100); }),
  ]);
  clearTimeout(timer);
  let limited = false;
  for (const group of fast.groups) {
    group.results = rankName(group.results.map(row => {
      const answer = pending.has(row.domain) && answers.get(row.domain);
      if (!answer) return row;
      if (sites.has(row.domain)) group.sites[row.tld] = sites.get(row.domain);
      const status = registrationStatus(answer);
      if (status === 'check-at-shop') {
        if (/HTTP 429/.test(answer.reason ?? '')) limited = true;
        return { ...row, registryReason: answer.reason ?? row.registryReason, ...(answer.likely && { likely: answer.likely }) };
      }
      const { likely, ...open } = row;
      const settled = { ...open, status, source: answer.source, registryReason: undefined, forSale: Boolean(answer.forSale),
        checkedAt: answer.checkedAt ?? (options.now ?? new Date()).toISOString() };
      if (status === 'premium') return { ...withoutListPrice(settled, status), premium: true };
      if (status === 'reserved') return withoutListPrice(settled, status, answer.reason);
      if (status !== 'taken') return withPremiumRisk(settled);
      const { price, renewal, shop, priceCheckedAt } = row;
      for (const key of ['price', 'renewal', 'shop', 'priceSource', 'priceCheckedAt', 'buyUrl']) delete settled[key];
      return price == null ? settled : { ...settled, listPrice: { shop, checkedAt: priceCheckedAt,
        ...termCosts(row.tld, price, renewal), renewalJump: renewal > 2 * price } };
    }));
  }
  return limited;
}

function agentArgs(args, options) {
  if (args.length === 2 && args[0] === '--names') return agentResult(args[1].split(','), options);
  if (args.length === 1 && !args[0].startsWith('-')) return agentResult(args[0], options);
  return { error: 'Use --agent <query> or --agent --names a,b,c.' };
}

function workflowAgent(input) {
  let value;
  try { value = JSON.parse(input); } catch { return { error: 'Provide a query or a list of names.' }; }
  if (!value || typeof value !== 'object' ||
      Object.keys(value).some(key => !['query', 'names', 'endings', 'ai', 'eligible', 'confirm'].includes(key)) ||
      (Object.hasOwn(value, 'confirm') && typeof value.confirm !== 'boolean') ||
      Object.hasOwn(value, 'query') === Object.hasOwn(value, 'names') ||
      !(typeof value.query === 'string' || Array.isArray(value.names)) ||
      (Object.hasOwn(value, 'ai') && typeof value.ai !== 'boolean') ||
      (Object.hasOwn(value, 'endings') && !validEndings(value.endings))) {
    return { error: 'Provide either a query or a list of names.' };
  }
  const { confirm, ...rest } = value;
  return agentResult(value.query ?? value.names, { ...rest, browser: confirm === true });
}

// Per-name GEO from the calling agent's own recollection: {"Name":"known: what it is"|"unknown"}.
function readGeo(value) {
  try {
    const geo = JSON.parse(value ?? '');
    if (geo && typeof geo === 'object' && !Array.isArray(geo) && Object.keys(geo).length <= 20 &&
        Object.entries(geo).every(([key, text]) => key.length <= 100 && typeof text === 'string' && text.length <= 160)) return geo;
  } catch { /* Invalid GEO input is ignored; the Wikipedia/Wikidata stand-in applies. */ }
  return null;
}

function lookupArgs(args) {
  const options = {};
  const positional = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--ai') options.ai = true;
    else if (arg === '--endings' && !options.endings) options.endings = (args[++index] ?? '').split(',');
    else if (arg === '--eligible' && !options.eligible) options.eligible = (args[++index] ?? '').split(',');
    else if (arg === '--category' && !options.category) options.category = (args[++index] ?? '').slice(0, 100);
    else if (arg === '--compact') options.compact = true;
    else if (arg === '--receipt') options.receipt = true;
    // The headless browser shop check runs only on this explicit flag.
    else if (arg === '--confirm') options.browser = true;
    else if (arg === '--geo' && options.geo === undefined) options.geo = readGeo(args[++index]);
    else if (arg === '--about' && options.about === undefined) options.about = (args[++index] ?? '').slice(0, 160);
    else positional.push(arg);
  }
  return { options, positional };
}

function runConfirmation(shop, domain) {
  return confirmDomain(shop, domain, { unsupported: ['so', 'no'], fresh: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const { options, positional } = lookupArgs(args.slice(1));
  // The MCP server reads these to answer with progress when a lookup outlasts its budget.
  const onProgress = progressReporter();
  if (onProgress) options.onProgress = onProgress;
  const refreshDir = process.env.DOMAIN_HOUND_PRICE_CACHE;
  if (args[0] === '--naming-method' && !positional.length) {
    console.log(namingRecipe(options.about));
  } else {
    const result = args[0] === '--open' ? await openShop(args.slice(1))
      : args[0] === '--agent' ? await agentArgs(positional, options)
      : args[0] === '--agent-input' && args.length === 2 ? await workflowAgent(args[1])
      : args[0] === '--confirm' ? await runConfirmation(args[1], args.length === 3 ? normalize(args[2]) : null)
      : args[0] === '--refresh-prices' && (args.length === 1 || args.length === 2 && args[1] === '--confirm')
        ? await refreshPrices({ directory: refreshDir ? pathToFileURL(refreshDir) : undefined, browser: args.length === 2 })
      : args[0] === '--naming-method' ? { error: 'Use --naming-method with an optional --about "product description".' }
      : args[0] === '--name' ? positional.length > 1 || /\s/.test(positional[0] ?? '')
        ? { error: 'Use --name with one domain label. For a multiword product name, run --naming-method.' }
        : await searchName(positional[0], options)
      : args[0] === '--refresh-tranco' && args.length === 1
        ? await refreshTranco({ directory: process.env.DOMAIN_HOUND_TRANCO_CACHE ? pathToFileURL(process.env.DOMAIN_HOUND_TRANCO_CACHE.replace(/\/?$/, '/')) : undefined })
      : args[0] === '--presence' && args.length === 2 ? await namePresence(args[1], { refreshTranco: true })
      : args[0] === '--triage' ? await triageNames(positional.length === 1 ? positional[0].split(',') : null,
        { ...options, refreshTranco: true })
      : await checkDomain(args.length === 1 ? args[0] : undefined);
    if (result.error) process.exitCode = 1;
    if (args[0] === '--triage' && options.compact) {
      for (const row of result.names ?? []) {
        row.checks = nameCheckLines(row).map(({ label, text, link }) => label + ': ' + text + ' · ' + link);
      }
    }
    console.log(JSON.stringify(result));
  }
}
