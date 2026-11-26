import '../../test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cloudflareSettlement, parseCloudflare, parseDynadot, parseNamecheap, parseSpaceship } from './confirm.mjs';
import { checkDomain, normalize, parseConfirmation } from './index.mjs';
import { offer, porkbunOffer, rankedFirstYear, threeYearCost } from './prices.mjs';

const porkbun = JSON.parse(await readFile(new URL('./fixtures/porkbun.json', import.meta.url), 'utf8'));
const dynadotHtml = await readFile(new URL('./fixtures/dynadot.html', import.meta.url), 'utf8');
const spaceshipQuotes = (await readFile(new URL('./fixtures/spaceship.txt', import.meta.url), 'utf8')).trim().split(/\r?\n===\r?\n/);
const now = new Date('2026-11-24T04:00:00Z');
const nokRate = { rate: 9.8076, date: '2026-11-23' };
const nokResponse = {
  data: {
    dataSets: [{ series: { '0:0:0:0': { observations: { 0: ['9.8076'] } } } }],
    structure: { dimensions: { observation: [{ id: 'TIME_PERIOD', values: [{ id: '2026-11-23' }] }] } },
  },
};
const expires = '2034-04-29T17:53:02.072Z';
const available = { status: 'SUCCESS', response: { avail: 'yes', type: 'registration', price: '640.22', premium: 'yes' } };

function response(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

function mock({
  status = 404, pricing = porkbun, confirm, dynadot = dynadotHtml, nok = nokResponse,
  services = [[['io'], ['https://example.com/rdap']]], queryWhois,
} = {}) {
  const fetcher = async (url, options) => {
    const { hostname, pathname } = new URL(url);
    if (hostname === 'data.iana.org') return response(200, { services });
    if (hostname === 'data.norges-bank.no') return response(nok ? 200 : 503, nok);
    if (hostname === 'www.dynadot.com') return new Response(dynadot, { status: dynadot ? 200 : 503 });
    if (pathname.endsWith('/pricing/get')) {
      if (options.method === 'POST') assert.deepEqual(JSON.parse(options.body), {});
      return response(pricing ? 200 : 503, pricing);
    }
    if (pathname.includes('/checkDomain/')) {
      assert.deepEqual(JSON.parse(options.body), { apikey: 'example-key', secretapikey: 'example-secret' });
      assert.equal(options.redirect, 'error');
      return response(200, confirm);
    }
    assert.ok(pathname.includes('/domain/'));
    return response(status, { events: [{ eventAction: 'expiration', eventDate: expires }] });
  };
  return {
    now, fetcher, directory: null, queryWhois, bundled: null,
    env: confirm ? { DOMAIN_HOUND_PORKBUN_API_KEY: 'example-key', DOMAIN_HOUND_PORKBUN_SECRET_KEY: 'example-secret' } : {},
  };
}

test('normalizes a pasted URL and validates the label and TLD', () => {
  assert.equal(normalize('  https://www.OakenRoom.me/path?q=x#here  '), 'oakenroom.me');
  assert.equal(normalize('a-b.io'), 'a-b.io');
  assert.equal(normalize('https://www.example.co.uk/path'), 'example.co.uk');
  assert.equal(normalize('example.xn--p1ai'), 'example.xn--p1ai');
  assert.equal(normalize('a'.repeat(63) + '.me'), 'a'.repeat(63) + '.me');
  for (const invalid of ['bad_name', 'a..me', 'blog.example.me', '-a.me', 'a-.me', 'a.m', 'a.123', 'a.m-e',
    'a b.me', 'a.me:443', 'example.com@bad.me', 'a'.repeat(64) + '.me', '']) {
    assert.equal(normalize(invalid), null, invalid);
  }
});

test('the command sends one JSON error to stdout and exits 1 for bad input', () => {
  const entry = fileURLToPath(new URL('./index.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [entry, 'bad_name'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.match(JSON.parse(result.stdout).error, /Enter a domain/);
});

test('unpriced trusted offers preserve terms and direct URLs', () => {
  const spaceship = offer('spaceship', 'example.me', { firstYear: null, renewal: null });
  assert.equal(spaceship.threeYear, null);
  assert.ok(spaceship.terms.lines.includes('Built by Namecheap'));
  assert.deepEqual(spaceship.terms.payWithoutCard, ['PayPal', 'Apple Pay', 'Google Pay']);
  assert.equal(spaceship.buyUrl, 'https://www.spaceship.com/domain-search/?query=example.me');
  assert.equal(offer('cloudflare', 'example.me', {}).note, 'Must use Cloudflare DNS');
});

test('reads first-party fixed and percentage coupons and keeps regular renewal', () => {
  const firstParty = porkbunOffer(porkbun, 'me', 'example.me', now);
  assert.equal(firstParty.firstYear, 16.27);
  assert.equal(firstParty.code, 'AWESOMENESS');
  assert.equal(firstParty.codeNote, '1 per customer · first year only');
  assert.equal(firstParty.threeYear, 51.81);
  const alternate = structuredClone(porkbun);
  alternate.pricing.me.coupons.registration = { code: 'HALF', amount: 50, type: 'percent' };
  assert.equal(porkbunOffer(alternate, 'me', 'example.me', now).firstYear, 8.64);
  alternate.pricing.me.coupons.registration.type = 'unknown';
  assert.equal(porkbunOffer(alternate, 'me', 'example.me', now).firstYear, 17.27);
});

test('ranks offers by the first payment and keeps registry free separate from shop confirmation', async () => {
  const result = await checkDomain('https://www.Example.me/', mock());
  assert.deepEqual(result.registry, { status: 'free', source: 'rdap' });
  assert.equal(result.verdict, 'free');
  assert.equal(result.confirmed, null);
  assert.equal(result.offers.length, 9);
  assert.deepEqual(result.offers.slice(0, 2).map(item => item.shop), ['Dynadot', 'Porkbun']);
  assert.equal(result.offers.find(row => row.shop === 'Namecheap').threeYear, null);
  assert.equal(result.best, result.offers[0]);
  assert.equal(result.stale, false);
  assert.equal(result.cheapestToday, null);
  assert.deepEqual(result.nok, nokRate);
  assert.equal(result.vatNorway, 'unknown');
  assert.equal(result.offers.find(item => item.shop === 'Porkbun').code, 'AWESOMENESS');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 50_000);
});

test('returns taken with expiration and no prices; unhandled RDAP statuses stay unknown', async () => {
  const taken = await checkDomain('example.me', mock({ status: 200 }));
  assert.deepEqual(taken.registry, { status: 'taken', source: 'rdap', forSale: false, expires });
  assert.equal(taken.verdict, 'taken');
  assert.deepEqual(taken.offers, []);
  assert.equal(taken.best, null);
  const unknown = await checkDomain('example.io', mock({ status: 429, queryWhois: async () => '' }));
  assert.equal(unknown.verdict, 'unknown');
});

test('only explicit successful registration checks can confirm an offer', async () => {
  const result = await checkDomain('example.me', mock({ confirm: available }));
  // A premium answer is never shown at list price: no list offers, only "premium, price at shop".
  assert.equal(result.verdict, 'premium');
  assert.deepEqual(result.confirmed, { by: 'Porkbun', price: 640.22, premium: true });
  assert.deepEqual(result.offers, []);
  assert.equal(result.best, null);
  assert.ok(result.notes.includes('Premium, price at shop'));
  assert.equal(result.buyUrl, 'https://www.spaceship.com/domain-search/?query=example.me');
  // Porkbun's own standard-looking quote above its list price is a possible premium, never a list price.
  const above = { ...available, response: { ...available.response, premium: 'no', price: '30.00' } };
  const possible = await checkDomain('example.me', mock({ confirm: above }));
  assert.equal(possible.verdict, 'premium');
  assert.equal(possible.confirmed.possible, true);
  assert.deepEqual(possible.offers, []);
  assert.equal((await checkDomain('example.me', mock({ confirm: { ...available, sandbox: true } }))).verdict, 'free');
  for (const fields of [{ avail: 'no' }, { avail: 'blocked' }, { price: '' }, { type: 'aftermarket' }]) {
    assert.equal(parseConfirmation({ ...available, response: { ...available.response, ...fields } }), null);
  }
});

test('queries IANA WHOIS then the registry when the bootstrap has no RDAP', async () => {
  for (const [reply, status] of [
    ['No match for example.test', 'free'],
    ['Domain Name: EXAMPLE.TEST', 'taken'],
    ['WHOIS Rate Limit Exceeded', 'unknown'],
  ]) {
    const queryWhois = async (host, term, timeout) => {
      assert.ok(timeout > 0 && timeout <= 8000);
      if (host === 'whois.iana.org') {
        assert.equal(term, 'test');
        return status === 'taken' ? 'whois: whois.example.com\n' : 'refer: whois.example.com\n';
      }
      assert.equal(host, 'whois.example.com');
      assert.equal(term, 'example.test');
      return reply;
    };
    const result = await checkDomain('example.test', mock({ services: [], queryWhois }));
    assert.equal(result.registry.status, status);
    assert.equal(result.registry.source, 'whois');
    // A rate-limit notice is reported as such, and the host is then left alone (see registry.test.mjs).
    if (status === 'unknown') assert.match(result.registry.reason, /Registry WHOIS rate limit/);
  }
});

test('shows shop links with unknown prices when first-party price sources fail', async () => {
  const result = await checkDomain('example.me', mock({ pricing: null, dynadot: null, nok: null }));
  assert.equal(result.offers.length, 9);
  assert.equal(result.stale, true);
  assert.equal(result.priceDate, null);
  assert.equal(result.nok, null);
  assert.equal(result.transfer, undefined);
  assert.ok(result.offers.every(row => row.firstYear === null && row.renewal === null && row.threeYear === null));
});

test('a plain domain check falls back to the dated bundled snapshot and live shop prices win over it', async () => {
  const snapshotAt = '2026-10-01T00:00:00.000Z';
  const bundled = { checkedAt: snapshotAt, catalogs: { dynadot: { checkedAt: snapshotAt, prices: {
    com: { shop: 'Dynadot', firstYear: 1.5, renewal: 2, transfer: 2 },
    io: { shop: 'Dynadot', firstYear: 1.5, renewal: 2, transfer: 2 },
    me: { shop: 'Dynadot', firstYear: 1.5, renewal: 2, transfer: 2 },
  } } } };
  const offline = await checkDomain('example.me', { ...mock({ pricing: null, dynadot: null, nok: null }), bundled });
  assert.equal(offline.best.shop, 'Dynadot');
  assert.equal(offline.best.firstYear, 1.5);
  assert.equal(offline.best.source, 'bundled');
  assert.equal(offline.priceDate, '2026-10-01');
  assert.equal(offline.stale, true);
  assert.equal(offline.transfer, undefined);
  const live = await checkDomain('example.me', { ...mock(), bundled });
  const dynadot = live.offers.find(row => row.shop === 'Dynadot');
  assert.equal(dynadot.source, 'live');
  assert.notEqual(dynadot.firstYear, 1.5);
  assert.equal(live.offers.filter(row => row.source === 'bundled').length, 0);
});

test('chooses the cheaper first payment even when its renewal costs more', async () => {
  const pricing = structuredClone(porkbun);
  pricing.pricing.me.registration = '1.99';
  pricing.pricing.me.renewal = '26.00';
  pricing.pricing.me.coupons.registration = null;
  const result = await checkDomain('example.me', mock({ pricing, dynadot: dynadotHtml.replace('$9.16', '$2.99') }));
  assert.equal(result.best.shop, 'Dynadot');
  assert.equal(result.best.firstYear, 2.99);
  assert.ok(result.best.renewal > result.offers.find(row => row.shop === 'Spaceship').renewal);
  assert.equal(result.cheapestToday, null);
  // Porkbun's cheaper list price stays as data only: never the pick, a transfer route or a link.
  const bun = result.offers.find(row => row.shop === 'Porkbun');
  assert.equal(bun.firstYear, 1.99);
  assert.equal(bun.dataOnly, true);
  assert.equal(bun.buyUrl, null);
  assert.notEqual(result.transfer?.from, 'Porkbun');
  assert.notEqual(result.transfer?.to, 'Porkbun');
});

test('unverified coupon prices stay visible without changing the rank or today’s winner', async () => {
  const pricing = structuredClone(porkbun);
  pricing.pricing.me.coupons.registration.amount = 16;
  const result = await checkDomain('example.me', mock({ pricing }));
  const row = result.offers.find(offer => offer.shop === 'Porkbun');
  assert.equal(row.firstYear, 1.27);
  assert.equal(rankedFirstYear(row), 17.27);
  assert.equal(result.best.shop, 'Dynadot');
  assert.equal(result.cheapestToday, null);
  assert.equal(threeYearCost({ ...row, codeVerified: true }), 35.81);
});

test('Spaceship only reads the exact domain and ignores the page’s Premium filter', () => {
  const [available, taken, premium, registered] = spaceshipQuotes;
  const takenQuote = { available: false, premium: false, price: null, renewal: null };
  assert.deepEqual(parseSpaceship(available, 'example.me'), {
    available: true, premium: false, price: 8.70, renewal: 15.53,
  });
  assert.deepEqual(parseSpaceship(taken, 'example.io'), takenQuote);
  assert.deepEqual(parseSpaceship(registered, 'example.io'), takenQuote);
  assert.deepEqual(parseSpaceship(premium, 'example.me'), {
    available: true, premium: true, price: 1299, renewal: 99,
  });
  assert.equal(parseSpaceship(available, 'other.me'), null);
  assert.equal(parseSpaceship('example\n.me\nAdd to cart\nSearching...\nPremium', 'example.me'), null);
});

test('other shop parsers use exact rows with explicit prices and availability', () => {
  const taken = { available: false, premium: false, price: null, renewal: null };
  assert.deepEqual(parseDynadot('example.me\n is available\nRenewal $16.80\n$18.33$9.16', 'example.me'), {
    available: true, premium: false, price: 9.16, renewal: 16.8,
  });
  assert.deepEqual(parseDynadot('example.io\nHire a Broker\nWhois\nTaken', 'example.io'), taken);
  assert.equal(parseDynadot('example.io\nTaken', 'example.me'), null);
  assert.deepEqual(parseNamecheap('example.me\n45% OFF\n$10.98/yr\nRetail $19.98/yr\nAdd to cart', 'example.me'), {
    available: true, premium: false, price: 10.98, renewal: null,
  });
  assert.deepEqual(parseNamecheap('example.io\nREGISTERED IN 2025\nMake offer', 'example.io'), taken);
  const buyLabel = 'Buy now: example.me for $16.56. Renews at $16.56 per year.';
  assert.deepEqual(parseCloudflare('exam\nple\n.me\nTop pick', 'example.me', false, buyLabel), {
    available: true, premium: false, price: 16.56, renewal: 16.56,
  });
  assert.deepEqual(parseCloudflare('exam\nple\n.io\nUnavailable', 'example.io'), taken);
  assert.equal(parseCloudflare('example.net', 'example.net', false, buyLabel), null);
});

test('Cloudflare provisional results and other domains never settle the exact quote', () => {
  const settlement = cloudflareSettlement('example.io');
  settlement.receive({ type: 'results.snapshot', searchId: 2, complete: true, items: [
    { id: 'io', fqdn: 'example.io', status: 'unknown', premium: null },
    { id: 'com', fqdn: 'example.com', status: 'available', premium: false },
  ] });
  const delta = (searchId, ...patches) => settlement.receive({ type: 'results.delta', searchId, patches });
  delta(2, { id: 'com', status: 'available', premium: false }, { id: 'io', status: 'available' });
  delta(1, { id: 'io', status: 'available', premium: false });
  assert.equal(settlement.read(), null);
  delta(2, { id: 'io', status: 'taken' });
  assert.deepEqual(settlement.read(), { available: false, premium: false });
});

test('missing Playwright returns one JSON fallback and exits successfully', () => {
  const entry = fileURLToPath(new URL('./index.mjs', import.meta.url));
  const path = fileURLToPath(new URL('./fixtures/absent-playwright.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [entry, '--confirm', 'spaceship', 'example.me'], {
    env: { ...process.env, DOMAIN_HOUND_OPEN: 'off', DOMAIN_HOUND_PLAYWRIGHT: path }, encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  const { checkedAt, ms, ...reply } = JSON.parse(result.stdout);
  assert.ok(Number.isFinite(Date.parse(checkedAt)));
  assert.ok(ms >= 0 && ms < 22_000);
  assert.deepEqual(reply, { shop: 'spaceship', shopName: 'Spaceship', requestedShop: 'spaceship',
    domain: 'example.me', status: 'could-not-confirm', available: null, premium: false,
    price: null, renewal: null, buyUrl: 'https://www.spaceship.com/domain-search/?query=example.me',
    reason: 'Playwright is unavailable.' });
});

test('keeps the additional trusted registrar search links direct and allowlisted', () => {
  const entry = fileURLToPath(new URL('./index.mjs', import.meta.url));
  for (const [id, host] of [['ionos', 'www.ionos.com'], ['gandi', 'shop.gandi.net'],
    ['hover', 'www.hover.com'], ['namesilo', 'www.namesilo.com']]) {
    const row = offer(id, 'example.me', {});
    assert.match(row.terms.lines.join(' '), /ICANN accredited registrar/);
    const url = new URL(row.buyUrl);
    assert.equal(url.host, host);
    assert.equal(url.protocol, 'https:');
    assert.ok([...url.searchParams.values()].includes('example.me'));
    const accepted = spawnSync(process.execPath, [entry, '--open', '--dry-run', row.buyUrl], { encoding: 'utf8' });
    assert.equal(accepted.status, 0);
    assert.equal(JSON.parse(accepted.stdout).url, row.buyUrl);
    const rejected = spawnSync(process.execPath, [entry, '--open', '--dry-run',
      row.buyUrl.replace(host, host + '.evil.test')], { encoding: 'utf8' });
    assert.equal(rejected.status, 1);
  }
});

test('every live and saved buy URL uses a direct, allowlisted shop page', async () => {
  const hosts = new Set(['www.spaceship.com', 'www.cloudflare.com', 'www.namecheap.com', 'www.dynadot.com', 'www.namesilo.com', 'www.ionos.com', 'shop.gandi.net', 'www.hover.com']);
  const entry = fileURLToPath(new URL('./index.mjs', import.meta.url));
  for (const options of [mock(), mock({ pricing: null, dynadot: null })]) {
    const { offers } = await checkDomain('example.me', options);
    assert.equal(offers.length, 9);
    for (const { buyUrl, dataOnly } of offers) {
      if (dataOnly) {
        assert.equal(buyUrl, null);
        continue;
      }
      const url = new URL(buyUrl);
      assert.equal(url.protocol, 'https:');
      assert.ok(hosts.has(url.host), buyUrl);
      assert.doesNotMatch(url.pathname, /(?:^|\/)go(?:\/|$)/);
      const result = spawnSync(process.execPath, [entry, '--open', '--dry-run', buyUrl], { encoding: 'utf8' });
      assert.equal(result.status, 0, buyUrl);
      assert.deepEqual(JSON.parse(result.stdout), { opened: false, url: buyUrl });
    }
  }
});

test('uses first-party prices and leaves other registrars unpriced', async () => {
  const pricing = structuredClone(porkbun);
  pricing.pricing.me.renewal = '18.00';
  const result = await checkDomain('example.me', mock({ pricing, dynadot: dynadotHtml.replace('$9.16', '$10.00') }));
  const dynadot = result.offers.find(row => row.shop === 'Dynadot');
  assert.equal(dynadot.firstYear, 10);
  assert.equal(dynadot.renewal, 16.8);
  assert.equal(dynadot.evidence, 'shop');
  const bun = result.offers.find(row => row.shop === 'Porkbun');
  assert.equal(bun.renewal, 18);
  assert.equal(bun.evidence, 'shop');
  assert.equal(result.offers.find(row => row.shop === 'Cloudflare').firstYear, null);
});

test('drops an expired first-party code and uses the regular first-year price', () => {
  const pricing = structuredClone(porkbun);
  pricing.pricing.me.coupons.registration.until = 'Nov 23, 2026 03:59 UTC';
  const row = porkbunOffer(pricing, 'me', 'example.me', now);
  assert.equal(row.firstYear, row.regularFirstYear);
  assert.equal(row.code, null);
});

test('the open dry run accepts only the exact HTTPS shop authorities', () => {
  const entry = fileURLToPath(new URL('./index.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [entry, '--open', '--dry-run', ...args], { encoding: 'utf8' });
  for (const host of ['spaceship.com', 'www.spaceship.com', 'namecheap.com', 'www.namecheap.com',
    'dynadot.com', 'www.dynadot.com', 'domains.cloudflare.com', 'dash.cloudflare.com']) {
    const url = 'https://' + host + '/?query=example.me';
    const result = run(url);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { opened: false, url });
  }
  for (const url of ['http://spaceship.com', 'https://spaceship.com.evil.test', 'https://www.porkbun.com', 'https://porkbun.com/?query=example.me',
    'https://spaceship.com@evil.test', 'https://evil.test@spaceship.com', 'https://@spaceship.com',
    'https://spaceship.com:444', 'https://%73paceship.com', 'https://spaceship.com\\@evil.test',
    'https://space\tship.com', 'https://www.cloudflare.com/redirect/?url=https://example.com', '--help']) {
    const result = run(url);
    assert.equal(result.status, 1, url);
    assert.match(JSON.parse(result.stdout).error, /trusted domain shop/i);
  }
  assert.equal(run().status, 1);
  assert.equal(run('https://porkbun.com', 'extra').status, 1);
});

test('recovers first-party pricing through the filtered GET when the POST stalls', async () => {
  const options = mock();
  const reads = [];
  const fetcher = async (url, request) => {
    const endpoint = new URL(url);
    if (endpoint.pathname !== '/api/json/v3/pricing/get') return options.fetcher(url, request);
    reads.push([request.method ?? 'GET', endpoint.search, request.signal]);
    if (request.method === 'POST') {
      return new Promise((_, reject) => request.signal.addEventListener('abort', reject, { once: true }));
    }
    return response(200, porkbun);
  };
  const result = await checkDomain('example.me', { ...options, fetcher });
  assert.deepEqual(reads.map(([method, query]) => [method, query]), [['POST', ''], ['GET', '?tld=me']]);
  assert.equal(reads[0][2].aborted, true);
  assert.equal(result.offers.find(item => item.shop === 'Porkbun').code, 'AWESOMENESS');
});
