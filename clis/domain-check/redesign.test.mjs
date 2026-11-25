import '../../test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { agentResult } from './index.mjs';
import { checkDisplay } from '../../display.mjs';
import { listQuote } from './name-search.mjs';
import { confirmDomain } from './confirm.mjs';
import { bundledCatalog, dynadotPrices, gandiPrice, getNameCatalog, listedPrices, loadCachedCatalog, refreshPrices, spaceshipPrice, targetEndings, validCatalog } from './price-catalog.mjs';
import { spaceshipFeedQuote, watchSpaceshipFeed } from './spaceship-feed.mjs';

const checkedAt = '2026-11-24T12:00:00.000Z';
const now = new Date(checkedAt);
const amount = { firstYear: 8.7, renewal: 15.53, transfer: 15.53 };
const spaceship = Object.fromEntries(targetEndings.filter(tld => !['so', 'no'].includes(tld))
  .map(tld => [tld, { ...amount, shop: 'Spaceship' }]));
const gandi = { ...amount, shop: 'Gandi' };
const accepted = {
  type: 'result', name: 'example.me', state: 'available', verified: true, isPrimary: true,
  price: { price: '8.70', renewal: '15.53', currency: 'USD' },
};

async function testCache(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hound-redesign-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return pathToFileURL(dir + '/');
}

test('validates all target endings and refuses prices outside the USD bounds', () => {
  const prices = { ...spaceship, no: gandi, so: gandi };
  const valid = { checkedAt, prices };
  assert.equal(validCatalog(valid), true);
  assert.equal(validCatalog({ ...valid, prices: { ...prices, so: undefined } }), false);
  for (const invalid of [0.49, 500.01, '8.70', NaN]) {
    assert.equal(validCatalog({ ...valid, prices: { ...prices, dev: { ...prices.dev, renewal: invalid } } }), false);
  }
  assert.equal(validCatalog({ ...valid, checkedAt: 'invalid' }), false);
});

test('reads Spaceship displayed annual prices and the exact Gandi USD offer', () => {
  assert.deepEqual(spaceshipPrice({ register: 'Register $15.53/yr $8.70/yr', renew: 'Renew $15.53/yr', transfer: '—' }),
    { ...amount, shop: 'Spaceship', transfer: null });
  assert.equal(spaceshipPrice({ register: 'US $6.00/yr', renew: 'Renew €15.53/yr' }), null);
  const data = { offers: [
    { sku: 'so_create', price: 8.7, priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
    { sku: 'so_renew', price: 15.53, priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
    { sku: 'so_transfer', price: 15.53, priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
  ] };
  const html = '<script type="application/ld+json">' + JSON.stringify(data) + '</script>';
  assert.deepEqual(gandiPrice(html, 'so'), gandi);
  assert.equal(gandiPrice(html.replaceAll('USD', 'EUR'), 'so'), null);
  assert.equal(gandiPrice(html, 'no'), null);
});

test('reads Dynadot USD prices for every ending in its own paginated table data', () => {
  const values = [
    { name: 1, reg_price: 2, renew_price: 3, tr_price: 4 }, 'so', '$57.50', '$57.50', '$57.50',
    { name: 6, reg_price: 7, renew_price: 7 }, 'no', '€7.91',
  ];
  const html = '<script type="application/json" id="__NUXT_DATA__">' + JSON.stringify(values) + '</script>';
  assert.deepEqual(dynadotPrices(html), { so: { shop: 'Dynadot', firstYear: 57.5, renewal: 57.5, transfer: 57.5 } });
  assert.deepEqual(dynadotPrices('<script id="__NUXT_DATA__">garbage</script>'), {});
});

function vendorPrices(shop, trial) {
  return Object.fromEntries(['com', 'io', 'me'].map(tld => [tld, { ...amount, ...trial, shop }]));
}

test('retains each last-good catalog and lazily schedules stale prices without blocking the answer', async t => {
  const directory = await testCache(t);
  const porkbun = () => vendorPrices('Porkbun', { firstYear: 12, renewal: 11 });
  const dynadot = () => vendorPrices('Dynadot', { firstYear: 1, renewal: 25 });
  const written = await refreshPrices({ directory, now, spaceship: () => spaceship, gandi: () => gandi, porkbun, dynadot });
  assert.equal(written.refreshed, true);
  assert.equal(written.catalogs.spaceship.checkedAt, checkedAt);
  let scheduled = 0;
  const scheduleRefresh = () => { scheduled++; return new Promise(() => {}); };
  const warm = await getNameCatalog({ directory, now: new Date(now.getTime() + 86_399_999), scheduleRefresh });
  assert.equal(warm.checkedAt, checkedAt);
  assert.equal(scheduled, 0);
  const next = new Date(now.getTime() + 86_400_000);
  const stale = await getNameCatalog({ directory, now: next, scheduleRefresh });
  assert.deepEqual(stale, warm);
  assert.equal(scheduled, 1);
  const raw = await readFile(new URL('prices.json', directory), 'utf8');
  const fail = () => Promise.reject(new Error('storefront unavailable'));
  const failed = await refreshPrices({ directory, now: next, spaceship: fail, gandi: fail, porkbun: fail, dynadot: fail });
  assert.equal(failed.refreshed, false);
  assert.equal(failed.checkedAt, checkedAt);
  assert.equal(await readFile(new URL('prices.json', directory), 'utf8'), raw);
  assert.deepEqual(await loadCachedCatalog(directory), warm);
  const partial = await refreshPrices({ directory, now: next, spaceship: fail, gandi: fail, porkbun, dynadot: fail });
  assert.deepEqual(partial.refreshedShops, ['porkbun']);
  assert.equal(partial.catalogs.porkbun.checkedAt, next.toISOString());
  assert.equal(partial.catalogs.spaceship.checkedAt, checkedAt);
});

test('ranks posted prices by first payment and picks the cheapest shop that can confirm', async t => {
  const directory = await testCache(t);
  const value = await refreshPrices({ directory, now, spaceship: () => spaceship, gandi: () => gandi,
    porkbun: () => vendorPrices('Porkbun', { firstYear: 12, renewal: 11 }),
    dynadot: () => vendorPrices('Dynadot', { firstYear: 1, renewal: 25 }),
  });
  const quote = listQuote(value, { tld: 'me', domain: 'example.me' }, now);
  assert.equal(quote.price, 1);
  assert.equal(quote.shop, 'Dynadot');
  assert.equal(quote.confirmShop, 'dynadot');
  assert.equal(listQuote(value, { tld: 'so', domain: 'example.so' }, now).shop, 'Gandi');
});

test('without a bundled snapshot uses only cached list prices at most eight days old, including in a batch', async t => {
  const directory = await testCache(t);
  const day = 86_400_000;
  const value = await refreshPrices({ directory, now, spaceship: () => spaceship, gandi: () => gandi,
    porkbun: () => vendorPrices('Porkbun', { firstYear: 12, renewal: 11 }),
    dynadot: () => vendorPrices('Dynadot', { firstYear: 1, renewal: 25 }),
  });
  const row = { tld: 'me', domain: 'example.me' };
  assert.equal(listQuote(value, row, new Date(+now + 8 * day), null).price, 1);
  assert.equal(listQuote(value, row, new Date(+now + 8 * day + 1), null).price, undefined);
  assert.equal(listQuote(null, row, now, null).price, undefined);
  const recentlyRefreshed = {
    ...value, catalogs: { ...value.catalogs, dynadot: { ...value.catalogs.dynadot, checkedAt: new Date(+now + day).toISOString() } },
  };
  assert.equal(listQuote(recentlyRefreshed, row, new Date(+now + 9 * day), null).shop, 'Dynadot');

  const options = {
    directory, resolveNs: async domain => domain === row.domain ? [] : ['ns.example.net'],
    fetcher: async () => new Response(null, { status: 404 }),
    confirm: async () => ({ status: 'could-not-confirm' }),
    cachedOnly: true, bundledCatalog: null,
  };
  const fresh = await agentResult(['example'], { ...options, now });
  assert.deepEqual(fresh.names[0].free, [{ d: 'me', s: 'nc' }]);
  assert.deepEqual(fresh.listPrices.me, { now: 1, renew: 25, y3: 51, jump: true, shop: 'Dynadot' });
  assert.equal(fresh.priceListDate, '2026-11-24');
  assert.equal(fresh.buyUrlTemplate.Dynadot, 'https://www.dynadot.com/domain/search?domain={domain}');
  const stale = await agentResult(['example'], { ...options, now: new Date(+now + 9 * day) });
  assert.deepEqual(stale.names[0].free, [{ d: 'me', s: 'nc' }]);
  assert.deepEqual(stale.listPrices.me, { shop: 'Spaceship' });
  assert.equal(stale.priceListDate, undefined);
});

test('the shipped snapshot is a valid dated first-party list price for every ending', () => {
  assert.equal(validCatalog(bundledCatalog), true);
  assert.ok(Number.isFinite(Date.parse(bundledCatalog.checkedAt)));
  for (const tld of targetEndings) {
    const rows = listedPrices(bundledCatalog, tld);
    assert.ok(rows.length, 'no bundled price for .' + tld);
    for (const row of rows) assert.ok(Number.isFinite(Date.parse(row.checkedAt)) && row.firstYear > 0 && row.renewal > 0);
  }
});

test('a fresh install with an empty cache shows a dated list price for all fourteen endings and still refreshes', async t => {
  const directory = await testCache(t);
  // The shown date is the oldest shop list in the snapshot.
  const date = Object.values(bundledCatalog.catalogs).map(source => source.checkedAt).sort()[0].slice(0, 10);
  // Weeks after the snapshot, past the eight-day window for cached prices.
  const later = new Date(Date.parse(bundledCatalog.checkedAt) + 40 * 86_400_000);
  let scheduled = 0;
  assert.equal(await getNameCatalog({ directory, now: later, coldWaitMs: 0, scheduleRefresh: () => { scheduled++; } }), null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scheduled, 1);
  const options = {
    directory, now: later, cachedOnly: true, skipComSite: true, queryWhois: async () => '',
    resolveNs: async () => [], fetcher: async () => new Response(null, { status: 404 }),
    confirm: async () => ({ status: 'could-not-confirm' }),
  };
  const batch = await agentResult(['example'], options);
  assert.equal(batch.priceListDate, date);
  assert.deepEqual(Object.keys(batch.listPrices).sort(), [...targetEndings].sort());
  for (const tld of targetEndings) {
    assert.ok(batch.listPrices[tld].now > 0 && batch.listPrices[tld].renew > 0, '.' + tld + ' has no list price');
  }
  assert.match(checkDisplay(batch), new RegExp('list prices from ' + date));
  const exact = await agentResult('example.me', options);
  const me = exact.names[0].free?.find(row => row.d === 'me');
  assert.ok(me?.now > 0);
  assert.equal(exact.priceListDate, date);
  assert.match(checkDisplay(exact), new RegExp('the price is a list price from ' + date + ', not a shop quote'));
  const unsettled = await agentResult('example.dev', {
    ...options, fetcher: async () => new Response(null, { status: 403 }),
  });
  assert.deepEqual(unsettled.names[0].shop_check, ['dev']);
  assert.ok(unsettled.listPrices.dev.now > 0);
  // Each shown price carries its own shop list date.
  const dates = Object.values(bundledCatalog.catalogs).map(source => source.checkedAt.slice(0, 10));
  assert.match(checkDisplay(unsettled), new RegExp('list price from (?:' + dates.join('|') + ')'));
  // The snapshot is read from the package and never copied into the user's cache.
  assert.equal((await readdir(directory)).includes('prices.json'), false);
  assert.equal(await loadCachedCatalog(directory), null);
});

test('fresh cached prices win over the bundled snapshot, which fills in only as the newest dated estimate', async t => {
  const directory = await testCache(t);
  const day = 86_400_000;
  const value = await refreshPrices({ directory, now, spaceship: () => spaceship, gandi: () => gandi,
    porkbun: () => vendorPrices('Porkbun', { firstYear: 12, renewal: 11 }),
    dynadot: () => vendorPrices('Dynadot', { firstYear: 1, renewal: 25 }),
  });
  const snapshot = at => ({ checkedAt: at, catalogs: { dynadot: { checkedAt: at, prices: {
    com: { shop: 'Dynadot', firstYear: 5, renewal: 6 }, io: { shop: 'Dynadot', firstYear: 5, renewal: 6 },
    me: { shop: 'Dynadot', firstYear: 5, renewal: 6 },
  } } } });
  const older = snapshot(new Date(+now - 30 * day).toISOString());
  const newer = snapshot(new Date(+now + 2 * day).toISOString());
  const row = { tld: 'me', domain: 'example.me' };
  // Inside the window the cache wins, even over a newer snapshot.
  assert.equal(listQuote(value, row, now, newer).price, 1);
  assert.equal(listQuote(value, row, now, newer).priceCheckedAt, checkedAt);
  const late = new Date(+now + 9 * day);
  // Past the window a newer snapshot replaces the old cache; a cache newer than the snapshot stays.
  assert.equal(listQuote(value, row, late, newer).price, 5);
  assert.equal(listQuote(value, row, late, newer).priceCheckedAt, newer.checkedAt);
  assert.equal(listQuote(value, row, late, older).price, 1);
  // An ending the snapshot does not cover keeps the old rule: no stale number.
  assert.equal(listQuote(value, { tld: 'dev', domain: 'example.dev' }, late, newer).price, undefined);
  // Porkbun is data only: its cheaper list price never becomes the pick or its link.
  const porkbunOnly = { checkedAt, catalogs: { porkbun: { checkedAt, prices: { me: { shop: 'Porkbun', firstYear: 0.99, renewal: 6 } } },
    dynadot: { checkedAt, prices: { me: { shop: 'Dynadot', firstYear: 4, renewal: 6 } } } } };
  assert.equal(listQuote(porkbunOnly, row, now, null).shop, 'Dynadot');
  assert.equal(listQuote(porkbunOnly, row, now, null).buyUrl, 'https://www.dynadot.com/domain/search?domain=example.me');
  // An explicit browser check's shop quote still replaces the list estimate.
  const options = {
    directory, now: late, cachedOnly: true, bundledCatalog: newer, skipComSite: true, browser: true,
    resolveNs: async domain => domain === row.domain ? [] : ['ns.example.net'],
    fetcher: async () => new Response(null, { status: 404 }),
    confirm: async () => ({ status: 'confirmed', shopName: 'Spaceship', price: 8.7, renewal: 15.53,
      buyUrl: 'https://www.spaceship.com/domain-search/?query=example.me', checkedAt: late.toISOString() }),
  };
  const confirmed = await agentResult(['example'], options);
  assert.deepEqual(confirmed.names[0].free, [{ d: 'me', s: 'ok', now: 8.7, renew: 15.53, y3: 39.76, shop: 'Spaceship', at: '12:00' }]);
  assert.equal(confirmed.best.priceNow, 8.7);
});

test('retains an exact confirmed price for 15 minutes and never caches an inconclusive result', async t => {
  const directory = await testCache(t);
  const domain = 'example.me';
  let count = 0;
  const usePage = async (name, run) => {
    assert.equal(name, domain);
    return run(async () => {
      count++;
      return count === 1 ? { available: true, price: 8.7, renewal: 15.53, premium: false }
        : { available: null, price: null, renewal: null, premium: false, reason: 'Shop blocked the check.' };
    });
  };
  const first = await confirmDomain('spaceship', domain, { directory, now, usePage });
  assert.equal(first.status, 'confirmed');
  const warm = await confirmDomain('spaceship', domain, { directory, now: new Date(+now + 899_999), usePage });
  assert.equal(warm.cached, true);
  assert.equal(warm.checkedAt, checkedAt);
  assert.equal(count, 1);
  const expired = { directory, now: new Date(+now + 900_000), usePage };
  const failure = await confirmDomain('spaceship', domain, expired);
  assert.equal(failure.status, 'could-not-confirm');
  await confirmDomain('spaceship', domain, expired);
  assert.equal(count, 5);
});

test('imports the optional Playwright from the capability when it is installed', {
  skip: process.env.DOMAIN_HOUND_PLAYWRIGHT ? 'Using DOMAIN_HOUND_PLAYWRIGHT fixture' : false,
}, async t => {
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { return t.skip('Optional Playwright is not installed'); }
  assert.equal(typeof chromium.launch, 'function');
});

test('names the requested shop and the shop that actually confirmed the domain', async () => {
  const quote = { available: true, price: 8.7, renewal: 15.53, premium: false };
  const unknown = { available: null, premium: false, price: null, renewal: null };
  const confirm = (shop, check) => confirmDomain(shop, 'example.me', {
    directory: null, now, usePage: (_, run) => run(check),
  });
  const fallback = await confirm('Dynadot', shop => shop === 'spaceship' ? quote : unknown);
  assert.equal(fallback.requestedShop, 'dynadot');
  assert.equal(fallback.shop, 'spaceship');
  assert.equal(fallback.status, 'confirmed');
  assert.equal(fallback.note, 'Requested Dynadot; confirmed at Spaceship');
  assert.equal((await confirm('dynadot', () => quote)).note, undefined);
  assert.equal((await confirm('dynadot', () => unknown)).note, undefined);
});

test('reads only the exact verified primary Spaceship price from its browser response', () => {
  assert.deepEqual(spaceshipFeedQuote(accepted, 'example.me'), { available: true, premium: false, price: 8.7, renewal: 15.53 });
  assert.equal(spaceshipFeedQuote({ ...accepted, verified: false }, 'example.me'), null);
  assert.equal(spaceshipFeedQuote({ ...accepted, isPrimary: false }, 'example.me'), null);
  assert.equal(spaceshipFeedQuote(accepted, 'other.me'), null);
  assert.equal(spaceshipFeedQuote({ ...accepted, price: { ...accepted.price, currency: 'EUR' } }, 'example.me'), null);
  assert.equal(spaceshipFeedQuote({ ...accepted, state: 'taken' }, 'example.me').available, false);
  assert.equal(spaceshipFeedQuote({ ...accepted, isPremium: true }, 'example.me').premium, true);
});

test('checks static runtime sources for aggregator and external resolver dependencies', async () => {
  const directory = new URL('./', import.meta.url);
  const files = (await readdir(directory)).filter(name => name.endsWith('.mjs') &&
    name !== 'test.mjs' && !name.endsWith('.test.mjs'));
  for (const name of files) {
    const source = await readFile(new URL(name, directory), 'utf8');
    assert.doesNotMatch(source, /tldes|cloudflare-dns\.com|quad9|\bdoh\b/i, name);
  }
});

test('processes an exact feed record split across buffered and live browser chunks', async () => {
  let subscribed;
  const handlers = new Map();
  const wire = JSON.stringify(accepted);
  const bytes = (str) => Buffer.from(str).toString('base64');
  const client = {
    on: (name, handler) => handlers.set(name, handler),
    send: method => method === 'Network.enable' ? Promise.resolve() : new Promise(resolve => { subscribed = resolve; }),
    detach: async () => {},
  };
  const watcher = await watchSpaceshipFeed({ context: () => ({ newCDPSession: async () => client }) }, 'example.me');
  const pending = handlers.get('Network.responseReceived')({
    requestId: 'search', response: {
      url: 'https://www.spaceship.com/gateway/api/v1/instantsearch-api/search', mimeType: 'application/x-ndjson', status: 200,
    },
  });
  handlers.get('Network.dataReceived')({ requestId: 'search', data: bytes(wire.slice(40)) });
  handlers.get('Network.loadingFinished')({ requestId: 'search' });
  subscribed({ bufferedData: bytes(wire.slice(0, 40)) });
  await pending;
  assert.equal(watcher.read()?.price, 8.7);
  await watcher.close();
});
