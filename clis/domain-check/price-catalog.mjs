import { spawn } from 'node:child_process';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { cacheDir, readCache, writeCache } from './cache.mjs';
import { withShopPages } from './confirm.mjs';
import { catalogPrice, dynadotOffer, offer, shops } from './prices.mjs';

export const targetEndings = ['com', 'ai', 'io', 'me', 'co', 'dev', 'app', 'si', 'so', 'no'];
const otherEndings = ['so', 'no'];
const spaceshipEndings = targetEndings.filter(tld => !otherEndings.includes(tld));
const filename = 'prices.json';
const day = 86_400_000;
const primaryShops = ['spaceship', 'porkbun', 'dynadot'];
const refreshMarker = 'price-refresh.attempt';
const pricingPage = 'https://www.spaceship.com/domain-search/pricing/';

function validPrice(row, shop) {
  return row?.shop === shop && typeof row.firstYear === 'number' && typeof row.renewal === 'number' &&
    catalogPrice(row.firstYear) !== null && catalogPrice(row.renewal) !== null;
}

function validSource(id, prices) {
  const entries = Object.entries(prices ?? {});
  const required = id === 'spaceship' ? spaceshipEndings : id === 'gandi' ? [] : ['com', 'io', 'me'];
  return entries.length > 0 && required.every(tld => Object.hasOwn(prices, tld)) &&
    entries.every(([tld, row]) => targetEndings.includes(tld) && validPrice(row, shops[id].name));
}

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function validCatalog(value) {
  if (!validDate(value?.checkedAt)) return false;
  if (!value.catalogs) {
    return targetEndings.every(tld => validPrice(value.prices?.[tld], otherEndings.includes(tld) ? 'Gandi' : 'Spaceship'));
  }
  return Object.keys(value.catalogs).length > 0 && Object.entries(value.catalogs).every(([id, source]) =>
    [...primaryShops, 'gandi'].includes(id) && validDate(source.checkedAt) && validSource(id, source.prices));
}

export async function loadCachedCatalog(directory = cacheDir) {
  const value = await readCache(directory, filename);
  return validCatalog(value) ? value : null;
}

function sourcesOf(catalog) {
  if (!catalog) return {};
  if (catalog.catalogs) return catalog.catalogs;
  return Object.fromEntries(['spaceship', 'gandi'].map(id => [id, {
    checkedAt: catalog.checkedAt,
    prices: Object.fromEntries(Object.entries(catalog.prices).filter(([, row]) => row.shop === shops[id].name)),
  }]));
}

export function isCatalogStale(checkedAt, now) {
  const age = now - Date.parse(checkedAt);
  return !Number.isFinite(age) || age < 0 || age >= day;
}

export function isListPriceUsable(checkedAt, now = new Date()) {
  const age = now - Date.parse(checkedAt);
  return age >= 0 && age <= 8 * day;
}

async function startRefresh(directory) {
  const marker = new URL(refreshMarker, directory);
  await mkdir(directory, { recursive: true });
  try {
    const info = await stat(marker);
    // Coalesce overlapping searches and pause retries if a storefront is down.
    if (Date.now() - info.mtimeMs < 15 * 60_000) return;
    await unlink(marker);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let lock;
  try { lock = await open(marker, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return; throw error; }
  await lock.close();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./index.mjs', import.meta.url)), '--refresh-prices'], {
    detached: true, stdio: 'ignore',
    env: { ...process.env, DOMAIN_HOUND_PRICE_CACHE: fileURLToPath(directory) },
  });
  child.on('error', () => {});
  child.unref();
}

export async function getNameCatalog({ directory = cacheDir, now = new Date(), scheduleRefresh = startRefresh,
  coldWaitMs = 1900 } = {}) {
  const saved = await loadCachedCatalog(directory);
  const sources = sourcesOf(saved);
  const refresh = !saved || primaryShops.some(id => isCatalogStale(sources[id]?.checkedAt, now)) ||
    targetEndings.some(tld => !primaryShops.some(id => sources[id]?.prices[tld]) &&
      (!sources.gandi?.prices[tld] || isCatalogStale(sources.gandi.checkedAt, now)));
  if (directory && refresh) {
    void Promise.resolve().then(() => scheduleRefresh(directory)).catch(() => {});
    // A stale catalog is usable immediately. Only an empty cache can wait for a first snapshot.
    if (!saved) {
      const deadline = performance.now() + Math.min(1900, coldWaitMs);
      while (performance.now() < deadline) {
        await delay(Math.min(100, Math.max(0, deadline - performance.now())));
        const catalog = await loadCachedCatalog(directory);
        if (catalog) return catalog;
      }
    }
  }
  return saved;
}

export function listedPrices(catalog, tld) {
  const sources = sourcesOf(catalog);
  const listed = primaryShops.flatMap(id => sources[id]?.prices[tld] ? [{
    ...sources[id].prices[tld], id, checkedAt: sources[id].checkedAt,
  }] : []);
  if (!listed.length && sources.gandi?.prices[tld]) {
    listed.push({ ...sources.gandi.prices[tld], id: 'gandi', checkedAt: sources.gandi.checkedAt });
  }
  return listed;
}

function cellPrice(text) {
  const amounts = [...(text ?? '').matchAll(/\$(\d[\d,]*(?:\.\d{2})?)(?=\s*\/yr)/g)];
  return catalogPrice(amounts.at(-1)?.[1]);
}

export function spaceshipPrice(row) {
  const firstYear = cellPrice(row.register);
  const renewal = cellPrice(row.renew);
  if (!firstYear || !renewal) return null;
  return { shop: 'Spaceship', firstYear, renewal, transfer: cellPrice(row.transfer) };
}

async function loadSpaceshipPrices() {
  const deadline = performance.now() + 16_000;
  return withShopPages(deadline, async (_usePage, openPage) => {
    const page = await openPage();
    const response = await page.goto(pricingPage, { waitUntil: 'domcontentloaded', timeout: 8000 });
    if (!response?.ok() || new URL(page.url()).origin !== new URL(pricingPage).origin) return {};
    const table = page.locator('[data-zid="instantSearchPricingCatalogRow"]');
    const filter = page.locator('[data-zid="instantSearchTldSearchField"]');
    function row(tld) {
      return table.filter({ has: page.locator('[data-zid="instantSearchPricingCatalogTld"]', {
        hasText: new RegExp('^\\.' + tld + '$'),
      }) }).first();
    }
    function read(rows) {
      return rows.evaluateAll(elements => elements.map(element => {
        const text = name => element.querySelector('[data-zid="' + name + '"]')?.innerText;
        return [text('instantSearchPricingCatalogTld')?.trim().slice(1), {
          register: text('instantSearchTldPriceRegister'), renew: text('instantSearchTldPriceRenew'),
          transfer: text('instantSearchTldPriceTransfer'),
        }];
      }));
    }
    async function ready(tld, timeout) {
      await row(tld).locator('[data-zid="instantSearchTldPriceRenew"]').getByText(/\$[\d.,]+/).first()
        .waitFor({ timeout });
    }
    await ready('com', 5500);
    const prices = new Map((await read(table)).map(([tld, cells]) => [tld, spaceshipPrice(cells)]));
    for (const tld of spaceshipEndings.filter(tld => !prices.get(tld))) {
      await filter.fill(tld, { timeout: 2000 });
      await ready(tld, 3700);
      const [[, cells]] = await read(row(tld));
      prices.set(tld, spaceshipPrice(cells));
    }
    return Object.fromEntries(spaceshipEndings.map(tld => [tld, prices.get(tld)]));
  }, { onFailure: () => ({}) });
}

export function gandiPrice(html, tld) {
  for (const [, text] of html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(text); } catch { continue; }
    if (!Array.isArray(data?.offers)) continue;
    const amount = sku => catalogPrice(data.offers.find(row => row?.sku === tld + '_' + sku &&
      row.priceCurrency === 'USD' && row.availability === 'https://schema.org/InStock')?.price);
    const firstYear = amount('create_golive') ?? amount('create');
    const renewal = amount('renew');
    if (firstYear && renewal) return { shop: 'Gandi', firstYear, renewal, transfer: amount('transfer') };
  }
  return null;
}

async function loadGandiPrice(tld) {
  const response = await fetch('https://www.gandi.net/en/domain/tld/' + tld + '?currency=USD', {
    signal: AbortSignal.timeout(5500),
  });
  return response.ok ? gandiPrice(await response.text(), tld) : null;
}

const porkbunPricing = 'https://api.porkbun.com/api/json/v3/pricing/get';
const dynadotPricing = 'https://www.dynadot.com/domain/prices?currency=USD';

export async function loadPorkbunPrices(fetcher = globalThis.fetch) {
  const controller = new AbortController();
  const { signal } = controller;
  const timer = setTimeout(() => controller.abort(), 12_000);
  async function load(options) {
    const response = await fetcher(porkbunPricing, { ...options, signal });
    const catalog = response.ok ? await response.json() : null;
    if (catalog?.status !== 'SUCCESS' || !catalog.pricing) throw new Error('Porkbun catalog unavailable');
    return Object.fromEntries(targetEndings.flatMap(tld => {
      const row = catalog.pricing[tld];
      if (!row) return [];
      return [[tld, { shop: 'Porkbun', firstYear: catalogPrice(row.registration),
        renewal: catalogPrice(row.renewal), transfer: catalogPrice(row.transfer) }]];
    }));
  }
  try {
    return await Promise.any([
      load({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
      delay(350, undefined, { signal }).then(() => load()),
    ]);
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

export function dynadotPrices(html) {
  // Dynadot server-renders the first page of its table and embeds the full
  // table as Nuxt state. Each named field points at a value in the same array.
  const state = html.match(/<script\b[^>]*\bid="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)?.[1];
  let values;
  try { values = JSON.parse(state); } catch { /* The visible rows still work. */ }
  const prices = {};
  const usd = value => /^\$[\d,.]+$/.test(value ?? '') ? catalogPrice(value) : null;
  if (Array.isArray(values)) {
    for (const row of values) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const tld = values[row.name];
      if (!targetEndings.includes(tld)) continue;
      const firstYear = usd(values[row.reg_price]);
      const renewal = usd(values[row.renew_price]);
      if (firstYear && renewal) prices[tld] = {
        shop: 'Dynadot', firstYear, renewal, transfer: usd(values[row.tr_price]),
      };
    }
  }
  for (const tld of targetEndings.filter(tld => !prices[tld])) {
    const row = dynadotOffer(html, tld, 'example.' + tld, new Date());
    if (row) prices[tld] = { shop: 'Dynadot', firstYear: row.regularFirstYear,
      renewal: row.renewal, transfer: row.regularTransferPrice };
  }
  return prices;
}

export async function loadDynadotPrices(fetcher = globalThis.fetch) {
  const response = await fetcher(dynadotPricing, {
    headers: { 'Accept-Language': 'en-US', Cookie: 'currency=USD' },
    signal: AbortSignal.timeout(6500),
  });
  return response.ok ? dynadotPrices(await response.text()) : {};
}

export async function refreshPrices({
  directory = cacheDir, now = new Date(), spaceship = loadSpaceshipPrices, gandi = loadGandiPrice,
  porkbun = loadPorkbunPrices, dynadot = loadDynadotPrices,
} = {}) {
  const checkedAt = now.toISOString();
  const results = await Promise.allSettled([spaceship, porkbun, dynadot].map(load => Promise.resolve().then(() => load())));
  const saved = await loadCachedCatalog(directory);
  const catalogs = { ...sourcesOf(saved) };
  const refreshedShops = [];
  for (const [index, id] of primaryShops.entries()) {
    const prices = results[index].value;
    const last = catalogs[id];
    if (!validSource(id, prices) || checkedAt < (last?.checkedAt ?? '') ||
        Object.keys(last?.prices ?? {}).some(tld => !Object.hasOwn(prices, tld))) continue;
    catalogs[id] = { checkedAt, prices };
    refreshedShops.push(id);
  }

  const gaps = targetEndings.filter(tld => !primaryShops.some(id => catalogs[id]?.prices[tld]));
  if (gaps.length) {
    const rows = await Promise.allSettled(gaps.map(tld => Promise.resolve().then(() => gandi(tld))));
    const prices = {};
    for (const [index, tld] of gaps.entries()) {
      if (validPrice(rows[index].value, 'Gandi')) prices[tld] = rows[index].value;
      else if (catalogs.gandi?.prices[tld]) prices[tld] = catalogs.gandi.prices[tld];
    }
    if (Object.keys(prices).length) {
      const complete = gaps.every((_, index) => validPrice(rows[index].value, 'Gandi'));
      catalogs.gandi = { checkedAt: complete ? checkedAt : catalogs.gandi?.checkedAt ?? checkedAt, prices };
      if (rows.some(row => validPrice(row.value, 'Gandi'))) refreshedShops.push('gandi');
    }
  } else {
    delete catalogs.gandi;
  }

  const value = { checkedAt, catalogs };
  if (refreshedShops.length && validCatalog(value)) {
    try {
      await writeCache(directory, filename, value);
      return { refreshed: true, refreshedShops, ...value };
    } catch { /* The old file survives a failed write. */ }
  }
  return { refreshed: false, refreshedShops: [], checkedAt: saved?.checkedAt ?? null, catalogs: sourcesOf(saved),
    reason: refreshedShops.length ? 'Price cache could not be written.' : 'The shops did not return a valid price catalog.' };
}

export function catalogOffers(catalog, tld, domain) {
  return listedPrices(catalog, tld).map(row => offer(row.id, domain, {
    firstYear: row.firstYear, regularFirstYear: row.firstYear, renewal: row.renewal,
    transferPrice: row.transfer, regularTransferPrice: row.transfer,
    evidence: 'shop', source: 'saved', checkedAt: row.checkedAt,
  }));
}
