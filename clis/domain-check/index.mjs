import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { confirmDomain, confirmingShops } from './confirm.mjs';
import { appStoreSearchLink, googleSearchLink, nameCheckLines, playSearchLink } from './google-search.mjs';
import { eligibilityNotes, mergeQuote, nameCandidates, normalizeName, pickName, rankName, registrationStatus,
  searchCandidates, searchName, termCosts, validEligibility, validEndings } from './name-search.mjs';
import { catalogOffers, isListPriceUsable, loadCachedCatalog, refreshPrices } from './price-catalog.mjs';
import { lookupRegistrations } from './registry.mjs';
import { namingRecipe } from './naming-method.mjs';
import { namePresence, triageNames } from './triage.mjs';
import { refreshTranco } from './traction.mjs';
import {
  catalogPrice, dynadotOffer, money, offer, porkbunOffer, rankedFirstYear, shops, shopSearchUrl, threeYearCost, transferStrategy, vatNorway,
} from './prices.mjs';

const runFile = promisify(execFile);
const maxTimeout = 8000;
const totalTimeout = 19000;
const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const porkbun = 'https://api.porkbun.com/api/json/v3/';
const nokUrl = 'https://data.norges-bank.no/api/data/EXR/B.USD.NOK.SP?lastNObservations=1&format=sdmx-json';
const shopHosts = new Set([
  'spaceship.com', 'www.spaceship.com', 'porkbun.com', 'namecheap.com', 'www.namecheap.com',
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
  const domain = typeof input === 'string' ? input.trim().toLowerCase()
    .replace(/^[a-z][a-z\d+.-]*:\/\//, '')
    .split(/[/?#]/, 1)[0]
    .replace(/^www\.(?=[^.]+\.)/, '') : '';
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
  fetcher = globalThis.fetch, directory, queryWhois, env = process.env, now = new Date(),
} = {}) {
  const domain = normalize(input);
  if (!domain) return { error: 'Enter a domain such as example.com.' };
  const tld = domain.split('.').at(-1);
  const deadline = performance.now() + totalTimeout;
  const timeout = () => Math.max(0, Math.min(maxTimeout, Math.floor(deadline - performance.now())));
  const [registrations, catalog, pricing, dynadot, confirmed, nok] = await Promise.all([
    lookupRegistrations([{ domain, tld }], { fetcher, directory, queryWhois, now,
      timeLeft: timeout, dnsFirst: false, readExpiry: true }),
    loadCachedCatalog(directory),
    loadPricing(tld, fetcher, timeout()),
    loadDynadot(tld, fetcher, timeout()),
    liveConfirmation(domain, env, fetcher, timeout()),
    loadNok(fetcher, timeout()),
  ]);
  const registry = registrations[0];
  const verdict = confirmed ? 'confirmed' : registry.status;
  const offers = [];
  if (verdict !== 'taken') {
    const priced = [...catalogOffers(catalog, tld, domain).filter(row => isListPriceUsable(row.checkedAt, now)), porkbunOffer(pricing, tld, domain, now),
      dynadotOffer(dynadot, tld, domain, now)].filter(Boolean);
    const byShop = new Map(priced.map(row => [row.shop, row]));
    for (const [id, { name }] of Object.entries(shops)) {
      const row = byShop.get(name) ?? offer(id, domain, {
        firstYear: null, regularFirstYear: null, renewal: null, checkedAt: null, source: null,
      });
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
  }
  const best = offers.find(row => rankedFirstYear(row) != null) ?? null;
  const today = offers.reduce((lowest, row) => cost(rankedFirstYear(row)) < cost(rankedFirstYear(lowest ?? {})) ? row : lowest, best);
  const priceDate = best?.checkedAt?.slice(0, 10) ?? null;
  const stale = !best || !isListPriceUsable(best.checkedAt, now);
  const transfer = !stale && !confirmed?.premium && oneYearTransfer.has(tld)
    ? transferStrategy(offers.filter(row => isListPriceUsable(row.checkedAt, now))) : null;
  const confirmingOffer = offers.find(row => rankedFirstYear(row) != null && confirmingShops.includes(shopIds.get(row.shop)));
  const confirmShop = shopIds.get(confirmingOffer?.shop)
    ?? (tld === 'no' ? 'dynadot' : tld === 'so' ? 'namecheap' : 'spaceship');
  return {
    domain, confirmShop, confirmShopName: shops[confirmShop].name, checkedAt: now.toISOString(), verdict, registry, confirmed, best,
    cheapestToday: today === best ? null : today,
    ...(transfer && { transfer }),
    offers, stale, priceDate, nok, vatNorway,
    notes: [registry.reason, verdict !== 'taken' && !best ? 'Price at the shop' : null].filter(Boolean),
  };
}

const shopIds = new Map(Object.entries(shops).map(([id, { name }]) => [name, id]));

const agentLegend = {
  nc: 'Free, not confirmed',
  ok: 'Free, confirmed by a shop',
  resale: 'Taken, possible resale',
  shop_check: 'Registry did not settle; check at a shop',
  d: 'Ending, or full domain for a name variant',
  now: 'First payment, USD ex. VAT',
  renew: 'Renewal payment, USD ex. VAT',
  y3: 'Payments due in three years, USD ex. VAT',
  term: 'Years per payment when more than one',
  jump: 'Renewal over twice the first annual price',
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

function compactAgentResult(groups, names, complete, checkedAt, batch, rateLimited = false, liveCheck = null) {
  const buyUrlTemplate = {};
  const shopCheckWhy = {};
  const listPrices = {};
  const checkedEndings = new Set();
  const byName = new Map();
  let priceListDate;
  let best;
  for (const { name, results } of groups) {
    const taken = [], resale = [], free = [], shop_check = [];
    for (const row of results) {
      checkedEndings.add(row.tld);
      const d = row.exact ? row.tld : row.domain;
      const shop = row.shop ?? shops[row.confirmShop]?.name;
      const confirmed = row.status === 'confirmed';
      const price = agentPrice({ ...row, shop });
      if (batch && !confirmed && row.status !== 'premium' && listPrices[d]?.now == null) {
        const listed = row.listPrice ? agentPrice(row.listPrice) : price;
        if (Object.keys(listed).length) listPrices[d] = listed;
      }
      const date = (row.priceCheckedAt ?? (batch ? row.listPrice?.checkedAt : null))?.slice(0, 10);
      // Use the oldest list date among the displayed estimates.
      if (date && (priceListDate === undefined || date < priceListDate)) priceListDate = date;
      if (row.status === 'taken') {
        (row.forSale ? resale : taken).push(d);
        continue;
      }
      const shopId = shopIds.get(shop);
      if (shopId) {
        const { url, suffix = '' } = shops[shopId];
        buyUrlTemplate[shop] = url + '{domain}' + suffix;
      }
      if (!confirmed && row.status !== 'probably-free') {
        shop_check.push(d);
        shopCheckWhy[d] ??= shopCheckReason(row, rateLimited);
        continue;
      }
      // A batch row repeats its ending's standard price only when it differs.
      const standard = batch && !confirmed && listPrices[d] && JSON.stringify(listPrices[d]) === JSON.stringify(price);
      free.push({ d, s: confirmed ? 'ok' : 'nc', ...(!standard && price) });
      if (confirmed) {
        const { now, renew, y3, term, jump } = price;
        const buyUrl = row.buyUrl ?? shopSearchUrl(shopId, row.domain);
        best = { domain: row.domain, status: 'free-confirmed', ...(now != null && { priceNow: now }),
          ...(renew != null && { renewal: renew }), ...(y3 != null && { threeYear: y3 }),
          ...(term && { term }),
          ...(jump && { renewalNote: 'Renews at $' + renew.toFixed(2) }),
          ...(shop && { shop }), ...(buyUrl && { buyUrl }) };
      }
    }
    byName.set(name, { name, ...(taken.length && { taken }), ...(resale.length && { resale }),
      ...(free.length && { free }), ...(shop_check.length && { shop_check }) });
  }
  const result = {
    complete, checkedAt, ...(priceListDate && { priceListDate }), ...(best && { best }),
    eligibility: eligibilityNotes([...checkedEndings]),
    names: names.map(name => byName.get(name)),
    ...(!batch && names[0].includes('.') && {
      purchaseAdvice: 'If the person asked to buy, say Domain Hound cannot buy domains, even if the domain is taken.',
    }),
    legend: agentLegend,
    ...(Object.keys(buyUrlTemplate).length && { buyUrlTemplate }),
    ...(Object.keys(shopCheckWhy).length && { shopCheckWhy }),
    // The registry and list-price evidence above stays; this only says the shop quote could not be checked.
    ...(liveCheck && !best && { liveCheck }),
  };
  if (batch && Object.keys(listPrices).length) {
    result.listPrices = listPrices;
    result.legend = { ...agentLegend, listPrices: 'Standard price by ending; use when a free row has no inline price' };
  }
  if (batch && Buffer.byteLength(JSON.stringify(result)) >= 7900) {
    for (const row of byName.values()) {
      if (row.free) row.free = row.free.map(({ d, s, ...price }) =>
        s === 'nc' ? { d, s } : { d, s, ...price });
    }
  }
  return result;
}

export async function agentResult(input, options = {}) {
  // Leave room under the 15-second wall clock limit for Node startup and browser cleanup.
  const deadline = performance.now() + (options.budgetMs ?? 13_900);
  const remaining = () => Math.max(0, Math.floor(deadline - performance.now()));
  const batch = Array.isArray(input);
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
  const searchOptions = { ...options, budgetMs: Math.min(remaining(), batch ? 10_700 : 2700),
    skipComSite: batch || options.skipComSite };
  const fast = await searchCandidates(groups, searchOptions);
  let rateLimited = fast.groups.some(group => group.results.some(row =>
    googleEndings.has(row.tld) && /HTTP 429/.test(row.registryReason ?? '')));
  if (batch) rateLimited = await retryGoogle(fast, remaining, options) || rateLimited;
  const rows = fast.groups.flatMap(group => group.results);
  const candidate = domain ? rows.find(row => row.status === 'probably-free' || row.status === 'check-at-shop')
    : pickName(rankName(rows), options.eligible);
  // A Google retry can settle every row that the first pass left waiting.
  let complete = fast.complete || !rows.some(row => row.registryReason === 'Registry lookup timed out');
  let quote;
  if (candidate && remaining() >= 1000) {
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
  } else if (candidate) {
    complete = false;
  }
  const apply = row => row.domain === candidate?.domain ? mergeQuote(row, quote) : row;
  const rankedGroups = fast.groups.map(({ name, results }) => ({ name, results: rankName(results.map(apply)) }));
  const checkedAt = options.now?.toISOString() ?? new Date().toISOString();
  return compactAgentResult(rankedGroups, names, complete, checkedAt, batch, rateLimited, liveCheckFor(candidate, quote));
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
  let timer;
  await Promise.race([
    lookupRegistrations([...pending.values()].map(({ domain, tld, exact }) => ({ domain, tld, exact })), {
      directory: options.directory, fetcher: options.fetcher, pause: options.pause, now: options.now,
      // DNS already showed no name servers for these rows.
      resolveNs: async () => [], timeLeft, rdapAttempts: 1,
      onResult: (candidate, registry) => { if (timeLeft() > 0) answers.set(candidate.domain, registry); },
    }).catch(() => {}),
    new Promise(resolve => { timer = setTimeout(resolve, budget + 100); }),
  ]);
  clearTimeout(timer);
  let limited = false;
  for (const group of fast.groups) {
    group.results = rankName(group.results.map(row => {
      const answer = pending.has(row.domain) && answers.get(row.domain);
      if (!answer) return row;
      const status = registrationStatus(answer);
      if (status === 'check-at-shop') {
        if (/HTTP 429/.test(answer.reason ?? '')) limited = true;
        return { ...row, registryReason: answer.reason ?? row.registryReason };
      }
      const settled = { ...row, status, source: answer.source, registryReason: undefined, forSale: Boolean(answer.forSale),
        checkedAt: answer.checkedAt ?? (options.now ?? new Date()).toISOString() };
      if (status !== 'taken') return settled;
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
      Object.keys(value).some(key => !['query', 'names', 'endings', 'ai', 'eligible'].includes(key)) ||
      Object.hasOwn(value, 'query') === Object.hasOwn(value, 'names') ||
      !(typeof value.query === 'string' || Array.isArray(value.names)) ||
      (Object.hasOwn(value, 'ai') && typeof value.ai !== 'boolean') ||
      (Object.hasOwn(value, 'endings') && !validEndings(value.endings))) {
    return { error: 'Provide either a query or a list of names.' };
  }
  return agentResult(value.query ?? value.names, value);
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
  const refreshDir = process.env.DOMAIN_HOUND_PRICE_CACHE;
  if (args[0] === '--naming-method' && !positional.length) {
    console.log(namingRecipe(options.about));
  } else {
    const result = args[0] === '--open' ? await openShop(args.slice(1))
      : args[0] === '--agent' ? await agentArgs(positional, options)
      : args[0] === '--agent-input' && args.length === 2 ? await workflowAgent(args[1])
      : args[0] === '--confirm' ? await runConfirmation(args[1], args.length === 3 ? normalize(args[2]) : null)
      : args[0] === '--refresh-prices' && args.length === 1
        ? await refreshPrices({ directory: refreshDir ? pathToFileURL(refreshDir) : undefined })
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
