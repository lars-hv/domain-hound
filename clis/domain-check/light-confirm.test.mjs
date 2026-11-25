import '../../test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { attribution, checkText, purchaseLine, triageText } from '../../display.mjs';
import { writeCache } from './cache.mjs';
import { apiShops, cachedSignals, lightConfirm, parseDynadotSearch, parseSpaceshipApi } from './confirm.mjs';
import { agentResult, checkDomain, lightTargets } from './index.mjs';
import { mergeQuote, rankName, searchCandidates } from './name-search.mjs';
import { lookupRegistrations, rdapSignal, registrySignal } from './registry.mjs';

const api = JSON.parse(await readFile(new URL('./fixtures/shop-api.json', import.meta.url), 'utf8'));
const now = new Date('2026-11-24T12:04:00Z');
const spaceshipKeys = { DOMAIN_HOUND_SPACESHIP_KEY: 'example-key', DOMAIN_HOUND_SPACESHIP_SECRET: 'example-secret' };
const dynadotKey = { DOMAIN_HOUND_DYNADOT_KEY: 'example-dynadot-key' };

async function cache(t) {
  const folder = await mkdtemp(join(tmpdir(), 'hound-light-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return pathToFileURL(folder + '/');
}

const noNetwork = async url => assert.fail('No request without a key: ' + url);

test('reads explicit Spaceship price classes, yearly prices and premium markers even without a price', () => {
  const domains = ['quietfern.com', 'quietfern.ai', 'quietfern.io', 'quietfern.co', 'quietfern.me', 'quietfern.dev'];
  const quotes = parseSpaceshipApi(api.spaceshipAvailable, api.spaceshipPricing, domains, now);
  assert.deepEqual(quotes.get('quietfern.com'), { shop: 'spaceship', shopName: 'Spaceship', domain: 'quietfern.com',
    buyUrl: 'https://www.spaceship.com/domain-search/?query=quietfern.com', checkedAt: now.toISOString(), source: 'api',
    price: 9.48, renewal: 10.68, status: 'confirmed', available: true, premium: false, standard: true });
  // A two-year period is a yearly price of half the payment.
  assert.equal(quotes.get('quietfern.ai').price, 79.98);
  assert.equal(quotes.get('quietfern.ai').renewal, 79.98);
  // premiumPricing marks premium; its register price is used when the price query has none.
  assert.equal(quotes.get('quietfern.io').status, 'premium');
  assert.equal(quotes.get('quietfern.io').price, 2499);
  // A supported answer without an explicit standard class never confirms a price.
  assert.equal(quotes.get('quietfern.co').status, 'could-not-confirm');
  assert.equal(quotes.get('quietfern.co').price, null);
  assert.equal(quotes.get('quietfern.me').status, 'could-not-confirm');
  const blocked = parseSpaceshipApi({ domains: [{ domain: 'quietfern.com', result: 'reserved' },
    { domain: 'quietfern.me', result: 'taken' }] }, null, ['quietfern.com', 'quietfern.me'], now);
  assert.deepEqual([...blocked.values()].map(quote => quote.status), ['reserved', 'taken']);
  assert.equal(quotes.has('quietfern.dev'), false);
  const premium = parseSpaceshipApi({ domains: [{ domain: 'quietfern.com', result: 'available' }] }, api.spaceshipPremiumPricing,
    ['quietfern.com'], now).get('quietfern.com');
  assert.deepEqual([premium.status, premium.premium, premium.price, premium.renewal], ['premium', true, 999.99, 999.99]);
  const marked = parseSpaceshipApi({ domains: [{ domain: 'quietfern.com', result: 'available',
    premiumPricing: [{ operation: 'register' }] }] }, null, ['quietfern.com'], now).get('quietfern.com');
  assert.deepEqual([marked.status, marked.price], ['premium', null]);
});

test('reads Dynadot search prices with an explicit premium marker and compares unmarked prices with its own list price', () => {
  const list = { firstYear: 10.88, renewal: 12.88 };
  const standard = parseDynadotSearch(api.dynadotNotPremium, 'quietfern.com', list, now);
  assert.deepEqual([standard.status, standard.price, standard.renewal, standard.standard], ['confirmed', 10.88, null, true]);
  const premium = parseDynadotSearch(api.dynadotPremium, 'quietfern.com', list, now);
  assert.deepEqual([premium.status, premium.premium, premium.price], ['premium', true, 1250]);
  assert.equal(parseDynadotSearch(api.dynadotNoMarker, 'quietfern.com', list, now).status, 'confirmed');
  const differing = parseDynadotSearch(api.dynadotNoMarker, 'quietfern.com', { firstYear: 8.99, renewal: 12 }, now);
  assert.deepEqual([differing.status, differing.premium, differing.price], ['premium', 'possible', 10.88]);
  assert.equal(parseDynadotSearch(api.dynadotNoMarker, 'quietfern.com', null, now).premium, 'possible');
  assert.equal(parseDynadotSearch(api.dynadotNoMarker, 'quietfern.com', { firstYear: 5.44 }, now).premium, 'possible');
  assert.equal(parseDynadotSearch(api.dynadotTaken, 'quietfern.com', list, now).status, 'could-not-confirm');
  assert.equal(parseDynadotSearch(api.dynadotError, 'quietfern.com', list, now), null);
  assert.equal(parseDynadotSearch(api.dynadotNotPremium, 'other.com', list, now), null);
});

test('without a key the light confirm sends nothing; with keys it calls only the documented endpoints without redirects', async t => {
  assert.deepEqual(apiShops({}), []);
  assert.deepEqual(apiShops({ DOMAIN_HOUND_SPACESHIP_KEY: 'k' }), []);
  assert.deepEqual(apiShops({ ...spaceshipKeys, ...dynadotKey }), ['spaceship', 'dynadot']);
  assert.equal((await lightConfirm(['quietfern.com'], { env: {}, fetcher: noNetwork, directory: null, now })).size, 0);

  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    assert.equal(init.redirect, 'error');
    if (url === 'https://spaceship.dev/api/v1/domains/available') return Response.json(api.spaceshipAvailable);
    if (url === 'https://spaceship.dev/api/v1/domains/pricing/query') return Response.json(api.spaceshipPricing);
    assert.match(url, /^https:\/\/api\.dynadot\.com\/api3\.json\?/);
    return Response.json(api.dynadotNotPremium);
  };
  const directory = await cache(t);
  const quotes = await lightConfirm(['quietfern.com', 'quietfern.io'], { env: { ...spaceshipKeys, ...dynadotKey }, fetcher, directory, now,
    listFor: (_domain, shop) => shop === 'dynadot' ? { firstYear: 10.88, renewal: 12.88 } : null });
  const spaceship = requests.filter(({ url }) => url.startsWith('https://spaceship.dev/'));
  assert.equal(spaceship.length, 2);
  for (const { init } of spaceship) {
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { domains: ['quietfern.com', 'quietfern.io'] });
    assert.equal(init.headers['X-API-Key'], 'example-key');
    assert.equal(init.headers['X-API-Secret'], 'example-secret');
  }
  const dynadot = requests.filter(({ url }) => url.startsWith('https://api.dynadot.com/')).map(({ url }) => new URL(url));
  assert.deepEqual(dynadot.map(url => Object.fromEntries(url.searchParams)), ['quietfern.com', 'quietfern.io'].map(domain0 => ({
    key: 'example-dynadot-key', command: 'search', domain0, show_price: '1', currency: 'USD' })));
  // The cheapest explicit standard quote wins; any premium answer wins over a standard one.
  assert.equal(quotes.get('quietfern.com').status, 'confirmed');
  assert.equal(quotes.get('quietfern.com').shopName, 'Spaceship');
  assert.equal(quotes.get('quietfern.io').status, 'premium');
  // Quotes are cached without keys; premium signals stay for a day.
  const cached = await lightConfirm(['quietfern.com'], { env: { ...spaceshipKeys }, fetcher: noNetwork, directory, now });
  assert.equal(cached.get('quietfern.com').cached, true);
  assert.ok(!JSON.stringify(cached.get('quietfern.com')).includes('example-key'));
  const signals = await cachedSignals(['quietfern.com', 'quietfern.io'], { directory, now: new Date(+now + 23 * 3_600_000) });
  assert.deepEqual([...signals.keys()], ['quietfern.io']);
  // A failed or redirected shop call leaves the list price; it never throws.
  const failing = await lightConfirm(['quietfern.dev'], { env: spaceshipKeys, directory: null, now,
    fetcher: async () => { throw new TypeError('fetch failed: redirect mode is set to error'); } });
  assert.equal(failing.size, 0);
});

test('registry premium and reserved signals are read only from plain words in RDAP and WHOIS answers', async () => {
  assert.equal(registrySignal('This name is reserved by the registry'), 'reserved');
  assert.equal(registrySignal('Premium domain: price on request'), 'premium');
  assert.equal(registrySignal('Copyright 2026. All rights reserved.'), null);
  assert.equal(registrySignal('This is not a premium domain.'), null);
  assert.equal(rdapSignal(JSON.stringify({ errorCode: 404, title: 'Not Found', description: ['Object not found'] })), null);
  assert.equal(rdapSignal(JSON.stringify({ errorCode: 404, notices: [{ title: 'Premium name', description: ['This is a premium domain'] }] })), 'premium');
  assert.equal(rdapSignal('not json premium domain'), null);
  const answers = await lookupRegistrations(['quietfern.com', 'quietfern.co', 'quietfern.ai'].map(domain =>
    ({ domain, tld: domain.split('.').at(-1) })), {
    directory: null, resolveNs: async () => [], queryWhois: async () => '',
    fetcher: async url => {
      if (url === 'https://data.iana.org/rdap/dns.json') return Response.json({ services: [[['com', 'ai'], ['https://rdap.example/']]] });
      if (url.endsWith('quietfern.com')) return new Response(JSON.stringify({ errorCode: 404, description: ['This domain is reserved'] }), { status: 404 });
      if (url.endsWith('quietfern.ai')) return new Response(JSON.stringify({ errorCode: 404, description: ['Premium domain'] }), { status: 404 });
      return new Response(JSON.stringify({ errorCode: 404, title: 'Not Found' }), { status: 404 });
    },
  });
  assert.deepEqual(answers.map(row => [row.status, row.signal]), [['unknown', 'reserved'], ['free', undefined], ['free', 'premium']]);
});

test('a premium or reserved answer never keeps a list price, and a same-shop quote above the list may be premium', () => {
  const row = { domain: 'quietfern.com', tld: 'com', exact: true, status: 'probably-free', price: 9.48, renewal: 10.68, shop: 'Spaceship',
    buyUrl: 'https://www.spaceship.com/domain-search/?query=quietfern.com', priceCheckedAt: '2026-11-24T00:00:00.000Z' };
  const premium = mergeQuote(row, { status: 'premium', premium: true, price: null, shopName: 'Spaceship', buyUrl: row.buyUrl });
  assert.deepEqual([premium.status, premium.price, premium.renewal, premium.priceCheckedAt], ['premium', null, null, null]);
  const reserved = mergeQuote(row, { status: 'reserved', reason: 'Not offered for registration at Dynadot' });
  assert.deepEqual([reserved.status, reserved.price, reserved.registryReason], ['reserved', null, 'Not offered for registration at Dynadot']);
  const above = mergeQuote(row, { status: 'confirmed', premium: false, price: 49, renewal: 49, shopName: 'Spaceship', buyUrl: row.buyUrl });
  assert.deepEqual([above.status, above.premium, above.price], ['premium', 'possible', 49]);
  const explicit = mergeQuote(row, { status: 'confirmed', standard: true, price: 49, renewal: 49, shopName: 'Spaceship', buyUrl: row.buyUrl });
  assert.equal(explicit.status, 'confirmed');
  const conflicting = mergeQuote(premium, { status: 'confirmed', standard: true, price: 49, shopName: 'Spaceship' });
  assert.deepEqual([conflicting.status, conflicting.price], ['premium', 49]);
  const otherShop = mergeQuote(row, { status: 'confirmed', premium: false, price: 49, renewal: 49, shopName: 'Dynadot' });
  assert.equal(otherShop.status, 'confirmed');
});

function registry(free) {
  return {
    directory: null, skipComSite: true, bundledCatalog: null, queryWhois: async () => '',
    resolveNs: async domain => free.includes(domain) ? [] : ['ns.example.net'],
  };
}

test('by default a keyed shop API is asked about the pick only, and the receipt names what it asked', async t => {
  const directory = await cache(t);
  const free = ['quietfern.com', 'quietfern.me', 'quietfern.co'];
  const asked = [];
  const result = await agentResult(['quietfern'], { ...registry(free), directory, now, cachedOnly: true, env: spaceshipKeys,
    endings: ['com', 'me', 'co'], preferredEndings: ['me'],
    fetcher: async (url, init) => {
      if (url.startsWith('https://spaceship.dev/')) {
        asked.push(...JSON.parse(init.body).domains);
        return Response.json(url.endsWith('/available')
          ? { domains: JSON.parse(init.body).domains.map(domain => ({ domain, result: 'available' })) } : api.spaceshipPricing);
      }
      if (url === 'https://data.iana.org/rdap/dns.json') return Response.json({ services: [[['com'], ['https://rdap.example/']]] });
      return new Response(null, { status: 404 });
    },
    confirm: async () => assert.fail('The browser runs only on the explicit confirm flag'),
  });
  assert.deepEqual([...new Set(asked)], ['quietfern.me']);
  assert.deepEqual(result.shopAsked, ['quietfern.me']);
  // Without a key no shop is asked at all.
  const keyless = await agentResult(['quietfern'], { ...registry(free), directory: await cache(t), now, cachedOnly: true, env: {},
    endings: ['com', 'me', 'co'], fetcher: async url => url === 'https://data.iana.org/rdap/dns.json'
      ? Response.json({ services: [[['com'], ['https://rdap.example/']]] }) : new Response(null, { status: 404 }) });
  assert.equal(keyless.shopAsked, undefined);
});

test('with DOMAIN_HOUND_SHOP_QUOTES=top4 the check confirms the top pick and up to three runners-up through a keyed shop API, never a browser', async t => {
  const directory = await cache(t);
  const checkedAt = now.toISOString();
  await writeCache(directory, 'prices.json', { checkedAt, catalogs: { spaceship: { checkedAt, prices: {
    com: { shop: 'Spaceship', firstYear: 9.48, renewal: 10.68 }, io: { shop: 'Spaceship', firstYear: 31.98, renewal: 51.75 },
    me: { shop: 'Spaceship', firstYear: 8.7, renewal: 15.53 }, co: { shop: 'Spaceship', firstYear: 3.11, renewal: 31.05 },
    ai: { shop: 'Spaceship', firstYear: 79.98, renewal: 79.98 }, app: { shop: 'Spaceship', firstYear: 8.28, renewal: 14.49 },
    dev: { shop: 'Spaceship', firstYear: 8.28, renewal: 12.42 }, si: { shop: 'Spaceship', firstYear: 10.98, renewal: 11.98 },
  } } } });
  const free = ['quietfern.com', 'quietfern.io', 'quietfern.me', 'quietfern.co', 'quietfern.ai', 'quietfern.app'];
  const asked = [];
  const result = await agentResult(['quietfern'], { ...registry(free), directory, now, cachedOnly: true,
    env: { ...spaceshipKeys, DOMAIN_HOUND_SHOP_QUOTES: 'top4' }, endings: ['com', 'io', 'me', 'co', 'ai', 'app'],
    fetcher: async (url, init) => {
      if (url.startsWith('https://spaceship.dev/')) {
        asked.push(...JSON.parse(init.body).domains);
        return Response.json(url.endsWith('/available')
          ? { domains: JSON.parse(init.body).domains.map(domain => ({ domain, result: 'available',
            premiumPricing: domain === 'quietfern.io' ? [{ operation: 'register' }] : [] })) }
          : api.spaceshipPricing);
      }
      if (url === 'https://data.iana.org/rdap/dns.json') return Response.json({ services: [[['com', 'ai', 'app'], ['https://rdap.example/']]] });
      return new Response(null, { status: 404 });
    },
    confirm: async () => assert.fail('The browser runs only on the explicit confirm flag'),
  });
  // Top pick .com, then the next picks the same rule makes: .app and .me within $60, then .co, the least over 3 years
  // of the rest. The more expensive .io and .ai (never a default pick) stay list prices.
  assert.deepEqual([...new Set(asked)], ['quietfern.com', 'quietfern.app', 'quietfern.me', 'quietfern.co']);
  const options = Object.fromEntries(result.names[0].free.map(option => [option.d, option]));
  assert.deepEqual(options.com, { d: 'com', s: 'ok', now: 9.48, renew: 10.68, y3: 30.84, shop: 'Spaceship', at: '12:04' });
  assert.equal(options.co.s, 'nc');
  assert.equal(result.best.domain, 'quietfern.com');
  const { display } = JSON.parse(checkText(result));
  assert.match(display, /^- quietfern\.com \$9\.48\/\$10\.68 ✓ confirmed at Spaceship 12:04 UTC$/m);
  // The renewal jump is said on the price line itself, with both figures.
  assert.match(display, /^- quietfern\.co \$3\.11, then \$31\.05\/yr, 10x jump \(list price\)$/m);
  assert.match(display, /^Pick: quietfern\.com\nCheapest now: quietfern\.co$/m);
  assert.doesNotMatch(display, /^Best value:/m, 'the best 3-year value is the pick');
  assert.match(display, /^Confirmed at Spaceship 12:04 UTC: \[quietfern\.com\]/m);
  assert.equal(result.liveCheck, undefined);
  assert.ok(Buffer.byteLength(checkText(result)) < 8000);
  assert.deepEqual(lightTargets(rankName([
    { domain: 'a.com', tld: 'com', exact: true, status: 'probably-free', price: 1, renewal: 1 },
    { domain: 'a.no', tld: 'no', exact: true, status: 'probably-free', price: 0.5, renewal: 1 },
  ])).map(row => row.domain), ['a.com']);
});

test('a premium answer shows the confirmed premium price or "premium, price at shop", never the list price', async t => {
  const directory = await cache(t);
  const free = ['quietfern.com'];
  const base = { ...registry(free), directory, now, env: spaceshipKeys, endings: ['com'] };
  const priced = await agentResult('quietfern.com', { ...base, fetcher: async url => url.startsWith('https://spaceship.dev/')
    ? Response.json(url.endsWith('/available') ? { domains: [{ domain: 'quietfern.com', result: 'available' }] } : api.spaceshipPremiumPricing)
    : new Response(null, { status: 404 }) });
  assert.deepEqual(priced.names[0].free, [{ d: 'com', s: 'ok', now: 999.99, renew: 999.99, y3: 2999.97, shop: 'Spaceship', prem: true, at: '12:04' }]);
  const shown = JSON.parse(checkText(priced)).display;
  assert.match(shown, /^\*\*quietfern\.com is free, at a premium price\.\*\* Price premium, confirmed at Spaceship 12:04 UTC\./);
  assert.doesNotMatch(shown, /\$9\.48|list price/);
  assert.ok(shown.endsWith('\n\n' + attribution + '\n\n' + purchaseLine));

  // The marker alone, without a price: no number at all, and the answer is remembered for the day.
  const other = await cache(t);
  const marked = await agentResult('quietfern.com', { ...base, directory: other, fetcher: async url => url.startsWith('https://spaceship.dev/')
    ? Response.json(url.endsWith('/available')
      ? { domains: [{ domain: 'quietfern.com', result: 'available', premiumPricing: [{ operation: 'register' }] }] } : { domains: [] })
    : new Response(null, { status: 404 }) });
  assert.equal(marked.names[0].free[0].s, 'prem');
  const display = JSON.parse(checkText(marked)).display;
  assert.match(display, /^\*\*quietfern\.com is free at the registry, but premium\.\*\* Premium, price at shop: \[quietfern\.com\]\(https:\/\/www\.spaceship\.com\/domain-search\/\?query=quietfern\.com\)\. No list price applies\./);
  assert.doesNotMatch(display, /\$/);
  // Later checks without a key, including the name screen, keep the premium answer and drop the list price.
  const later = await searchCandidates([{ name: 'quietfern', candidates: [{ domain: 'quietfern.com', tld: 'com', exact: true }] }],
    { ...registry(free), directory: other, now, cachedOnly: true, fetcher: async () => new Response(null, { status: 404 }) });
  const row = later.groups[0].results[0];
  assert.deepEqual([row.status, row.price], ['premium', null]);
  const exact = await checkDomain('quietfern.com', { directory: other, now, env: {}, bundled: null, queryWhois: async () => '',
    fetcher: async url => url === 'https://data.iana.org/rdap/dns.json' ? Response.json({ services: [[['com'], ['https://rdap.example/']]] })
      : new Response(null, { status: url.includes('rdap.example') ? 404 : 503 }) });
  assert.equal(exact.verdict, 'premium');
  assert.deepEqual(exact.offers, []);
  assert.ok(exact.notes.includes('Premium, price at shop'));
});

test('the name screen after a shortlist shows an earlier premium answer instead of the list price', () => {
  const prices = { com: { now: 9.48, renew: 10.68, shop: 'Spaceship' }, me: { now: 8.7, renew: 15.53, shop: 'Spaceship' },
    co: { now: 3.11, renew: 31.05, shop: 'Spaceship' } };
  const triage = { prices, names: [{ name: 'Quiet Fern', verdict: 'No conflict found', reason: 'No close mark',
    free: ['co', 'me', 'com'], own: {}, taken: [], shop_check: [], google: { result: 'open' } }] };
  const prior = { names: [{ name: 'quietfern', free: [{ d: 'co', s: 'prem' }, { d: 'me', s: 'ok', now: 30, renew: 30 },
    { d: 'com', now: 9.48, renew: 10.68 }] }], listPrices: prices };
  const display = JSON.parse(triageText(triage, prior)).display;
  const row = display.split('\n').find(line => line.startsWith('| Quiet Fern |'));
  assert.ok(row.includes('.co premium, price at shop<br>.me $30.00/$30.00 possible premium shop quote<br>.com $9.48/$10.68'), row);
  assert.doesNotMatch(row, /\$3\.11|\$8\.70/);
  // A name screen with a premium ending from the registry lists it as premium, price at shop.
  const marked = JSON.parse(triageText({ prices, names: [{ ...triage.names[0], free: ['com'], premium: ['co'] }] })).display;
  assert.match(marked, /\.com \$9\.48\/\$10\.68<br>premium, price at shop: \.co/);
});
