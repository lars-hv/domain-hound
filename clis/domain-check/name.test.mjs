import '../../test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { classifyComSite } from './com-site.mjs';
import { confirmAtShops, confirmDomain, parseSpaceshipRows } from './confirm.mjs';
import { nameCandidates, normalizeName, pickName, rankName, searchName, termCosts } from './name-search.mjs';

import { agentResult } from './index.mjs';
import { saleMarketplace } from './parking.mjs';
import { writeCache } from './cache.mjs';

const command = fileURLToPath(new URL('./index.mjs', import.meta.url));
const nameFixture = JSON.parse(readFileSync(new URL('./fixtures/spaceship-name.json', import.meta.url)));
const domains = nameCandidates('example').map(row => row.domain);

test('normalizes a name into a valid single label', () => {
  assert.equal(normalizeName(' Oaken Room '), 'oakenroom');
  // Letters are never stripped: a name with non-ASCII letters becomes its punycode label.
  assert.equal(normalizeName('  CAFÉ-Room 2 '), 'xn--caf-room2-d4a');
  assert.equal(normalizeName('Fjord Grønnstue'), 'xn--fjordgrnnstue-hnb');
  for (const value of ['...', 'example.com', 'https://example', ' - ', 'ending-', 'a'.repeat(64), undefined]) {
    assert.equal(normalizeName(value), null);
  }
});

test('checks all fourteen default endings and adds valid .com variants', () => {
  assert.deepEqual(domains, [
    'example.com', 'example.ai', 'example.io', 'example.me', 'example.co',
    'example.dev', 'example.app', 'example.si', 'example.so', 'example.no',
    'example.net', 'example.org', 'example.xyz', 'example.tech',
    'getexample.com', 'tryexample.com', 'useexample.com', 'examplehq.com',
  ]);
  assert.deepEqual(nameCandidates('example', { endings: ['ai'] }).map(row => row.domain), ['example.ai']);
  assert.equal(nameCandidates('a'.repeat(63)).length, 14);
  assert.equal(nameCandidates('a'.repeat(61)).length, 15);
  // Endings on request are checked only when asked for.
  assert.deepEqual(nameCandidates('example', { endings: ['com', 'de', 'uk'], variants: false }).map(row => row.domain),
    ['example.com', 'example.de', 'example.uk']);
});

test('uses system NS evidence and falls back to the authoritative registry for absence or timeout', async () => {
  const lookedUp = [];
  const result = await searchName('example', {
    directory: null, comSite: async () => ({ state: 'parked' }),
    resolveNs: async domain => {
      if (domain === 'example.com') return ['ns.example.net'];
      throw Object.assign(new Error(), { code: domain.endsWith('.me') ? 'ETIMEOUT' : 'ENOTFOUND' });
    },
    fetcher: async value => {
      const url = new URL(value);
      if (url.hostname === 'data.iana.org') return Response.json({ services: [[['com', 'io'], ['https://rdap.example/']]] });
      lookedUp.push(url.pathname);
      if (url.pathname.endsWith('.io')) throw new Error();
      return new Response(null, { status: url.pathname.endsWith('.no') ? 200 : 404 });
    },
    queryWhois: async () => '',
  });
  const byDomain = new Map(result.results.map(row => [row.domain, row]));
  assert.equal(byDomain.get('example.com').source, 'dns');
  assert.ok(!lookedUp.includes('/domain/example.com'));
  assert.equal(byDomain.get('example.me').status, 'probably-free');
  assert.equal(byDomain.get('example.no').status, 'taken');
  assert.equal(byDomain.get('example.io').status, 'check-at-shop');
  assert.equal(byDomain.get('example.so').status, 'probably-free');
  assert.equal(byDomain.get('example.so').source, 'rdap');
  assert.match(byDomain.get('example.io').registryReason, /DNS .*; Registry RDAP did not respond/);
  assert.deepEqual(result.comSite, { state: 'parked' });
});

test('retries transport failures, 429 and 5xx with at most four concurrent requests per RDAP host', async () => {
  const active = new Map();
  const peak = new Map();
  const attempts = new Map();
  const result = await searchName('example', {
    directory: null, resolveNs: async () => [], pause: async () => {},
    fetcher: async value => {
      const url = new URL(value);
      if (url.hostname === 'data.iana.org') {
        return Response.json({ services: [[['com', 'ai', 'io', 'co', 'dev', 'app', 'si', 'so'], ['https://rdap.example/']]] });
      }
      const host = url.host;
      active.set(host, (active.get(host) ?? 0) + 1);
      peak.set(host, Math.max(peak.get(host) ?? 0, active.get(host)));
      const domain = url.pathname.split('/').at(-1);
      const count = (attempts.get(domain) ?? 0) + 1;
      attempts.set(domain, count);
      await delay(4);
      active.set(host, active.get(host) - 1);
      if (domain.endsWith('.io') && count === 1) throw new Error('Temporary network error');
      const status = domain.endsWith('.dev') ? 503 : count === 1 ? 429 : 404;
      return new Response(null, { status, headers: { 'Retry-After': '0' } });
    },
  });
  assert.equal(peak.get('rdap.example'), 4);
  assert.ok([...peak.values()].every(count => count <= 4));
  assert.equal(attempts.size, 14);
  assert.equal(attempts.get('example.dev'), 3);
  assert.equal(attempts.get('example.io'), 2);
  assert.equal(result.results.find(row => row.tld === 'io').status, 'probably-free');
  assert.equal(result.results.find(row => row.tld === 'me').status, 'probably-free');
  const dev = result.results.find(row => row.tld === 'dev');
  assert.equal(dev.status, 'check-at-shop');
  assert.match(dev.registryReason, /503/);
});

test('reads all exact Spaceship cards, including icon-only cart, premium, and taken', () => {
  const parsed = parseSpaceshipRows(nameFixture, domains);
  assert.deepEqual([...parsed.keys()], ['example.com', 'example.co', 'example.me', 'example.io', 'example.ai', 'example.net']);
  assert.deepEqual(parsed.get('example.me'), { available: true, premium: false, price: 8.7, renewal: 15.53 });
  assert.deepEqual(parsed.get('example.io'), { available: true, premium: true, price: 1200, renewal: 52 });
  assert.equal(parsed.get('example.ai').premium, true);
  assert.equal(parsed.get('example.com').available, false);
  assert.equal(parsed.get('example.co').available, false);
  assert.equal(parseSpaceshipRows([{
    domain: 'example.me', text: 'example\n.me\n$15.53\n$8.70\nRenews $15.53\nAdd to cart', canBuy: true,
  }], domains).get('example.me').price, 8.7);
});

test('ranks cheapest first within exact and variant groups and retains high-priced free endings', () => {
  const pricing = { com: [140, 150], dev: [8, 20], app: [10, 11], me: [8.7, 15.53], co: [3, 30], ai: [80, 80] };
  const rows = nameCandidates('example').filter(row => !row.exact || pricing[row.tld]).map(row => {
    const [price, renewal] = row.exact ? pricing[row.tld] : [5, 11];
    return { ...row, price, renewal, status: 'probably-free' };
  });
  const ranked = rankName(rows.reverse());
  assert.deepEqual(ranked.map(row => row.domain), [
    'example.co', 'example.dev', 'example.me', 'example.app', 'example.com', 'example.ai',
    'examplehq.com', 'getexample.com', 'tryexample.com', 'useexample.com',
  ]);
  assert.equal(ranked[0].renewalJump, true);
  assert.equal(pickName(ranked)?.domain, 'example.co');
  assert.equal(pickName(ranked.filter(row => row.firstPayment >= 100)).domain, 'example.com');
  assert.equal(pickName(ranked.filter(row => row.tld === 'ai'))?.firstPayment, 160);
  assert.equal(pickName(ranked.map(row => row.tld === 'co' ? { ...row, status: 'premium' } : row)).domain, 'examplehq.com');
});

test('requires an eligibility opt-in before picking a restricted ending', () => {
  const rows = rankName(nameCandidates('example', { endings: ['no', 'co'] }).map(row => ({
    ...row, status: 'probably-free', price: row.tld === 'no' ? 2 : 4, renewal: 6,
  })));
  assert.equal(rows[0].terms.eligibility.includes('Norwegian'), true);
  assert.equal(pickName(rows).domain, 'example.co');
  assert.equal(pickName(rows, ['no']).domain, 'example.no');
  assert.equal(pickName(rows.slice(0, 1)), undefined);
});

test('serializes concurrent Spaceship confirmations and allows the next shop after a failed check', async () => {
  let inSpaceship = 0;
  const calls = [];
  const deadline = performance.now() + 1000;
  const check = (domain, available) => async shop => {
    calls.push([domain, shop]);
    if (shop !== 'spaceship') return { available: true };
    assert.equal(inSpaceship++, 0);
    await delay(8);
    inSpaceship--;
    return { available };
  };
  const [first, second] = await Promise.all([
    confirmAtShops('example.dev', check('example.dev', true), deadline, ['spaceship']),
    confirmAtShops('sample.dev', check('sample.dev', null), deadline, ['spaceship', 'dynadot']),
  ]);
  assert.equal(first.shop, 'spaceship');
  assert.equal(second.shop, 'dynadot');
  assert.deepEqual(calls, [['example.dev', 'spaceship'], ['sample.dev', 'spaceship'], ['sample.dev', 'dynadot']]);
});

test('counts both .ai payment blocks due in the first three years', () => {
  assert.deepEqual(termCosts('ai', 70, 80), {
    minimumYears: 2, renewalYears: 2, firstPayment: 140, renewalPayment: 160, threeYear: 300,
  });
  assert.deepEqual(termCosts('com', 9, 10), {
    minimumYears: 1, renewalYears: 1, firstPayment: 9, renewalPayment: 10, threeYear: 29,
  });
});

function pages(read, openings = []) {
  let open = 0;
  let peak = 0;
  let closed = false;
  const launch = async () => ({
    close: async () => { closed = true; },
    newContext: async () => ({
      route: async () => {},
      newPage: async () => {
        let url;
        open++;
        peak = Math.max(peak, open);
        return {
          on() {},
          url: () => url.href,
          goto: async value => {
            url = new URL(value);
            openings.push(url);
            return { status: () => 200, ok: () => true };
          },
          close: async () => { open--; },
          locator: () => ({ evaluate: async () => read(url) }),
        };
      },
    }),
  });
  return { launch, peak: () => peak, closed: () => closed };
}

test('confirms only the requested candidate and returns its premium or taken state', async () => {
  for (const [domain, status, price] of [['example.me', 'confirmed', 8.7],
    ['example.io', 'premium', 1200], ['example.co', 'taken', null]]) {
    const openings = [];
    const browser = pages(() => ({ rows: nameFixture }), openings);
    const result = await confirmDomain('spaceship', domain, { directory: null, launch: browser.launch });
    assert.equal(result.status, status);
    assert.equal(result.price, price);
    assert.equal(openings.length, 1);
    assert.equal(openings[0].searchParams.get('query'), domain);
    assert.ok(browser.closed());
  }
});

test('uses exactly one fallback for the same candidate and preserves an inconclusive response', async () => {
  const failed = { rows: [], pageStatus: 'Access denied' };
  const openings = [];
  const browser = pages(url => url.hostname === 'www.spaceship.com' ? failed
    : { rows: [{ text: 'example.me\n$8.70/yr\nRenews at $15.53/yr.\nAdd to cart' }] }, openings);
  const result = await confirmDomain('spaceship', 'example.me', { directory: null, launch: browser.launch });
  assert.deepEqual(openings.map(url => [url.hostname, [...url.searchParams.values()][0]]),
    [['www.spaceship.com', 'example.me'], ['www.namecheap.com', 'example.me']]);
  assert.equal(result.shopName, 'Namecheap');
  assert.equal(result.renewal, 15.53);
  const rejected = [];
  const failure = await confirmDomain('spaceship', 'example.me', {
    directory: null, launch: pages(() => failed, rejected).launch,
  });
  assert.equal(rejected.length, 2);
  assert.equal(failure.status, 'could-not-confirm');
  assert.equal(failure.available, null);
  assert.match(failure.reason, /blocked/);

  const soOpenings = [];
  await confirmDomain('dynadot', 'example.so', {
    directory: null, launch: pages(() => failed, soOpenings).launch, unsupported: ['so', 'no'],
  });
  assert.deepEqual(soOpenings.map(url => url.hostname), ['www.dynadot.com', 'www.namecheap.com']);
});

const registryOptions = {
  directory: null, skipComSite: true, bundledCatalog: null,
  fetcher: async url => url === 'https://data.iana.org/rdap/dns.json'
    ? Response.json({ services: [[['com', 'ai', 'co', 'dev', 'app', 'si'], ['https://rdap.example/']]] })
    : new Response(null, { status: 404 }),
  queryWhois: async () => '',
};

test('the batch shop check stops after one storefront when that shop cannot confirm', async () => {
  const openings = [];
  const browser = pages(() => ({ rows: [], pageStatus: 'Access denied' }), openings);
  const result = await confirmDomain('spaceship', 'example.me', {
    directory: null, launch: browser.launch, fresh: true, oneShop: true,
  });
  assert.equal(result.status, 'could-not-confirm');
  assert.deepEqual(openings.map(url => url.hostname), ['www.spaceship.com']);
});

test('agent returns partial rows at the registry deadline and preserves completed checks', async () => {
  const result = await agentResult(['example', 'sample'], {
    ...registryOptions, budgetMs: 80,
    resolveNs: async domain => domain === 'example.com' ? new Promise(() => {}) : ['ns.example.net'],
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.names.map(row => row.name), ['example', 'sample']);
  assert.ok(result.names[0].shop_check.includes('com'));
  assert.ok(result.names[1].taken.includes('com'));
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
});

test('agent returns the registry result when the one live shop check runs out of time', async () => {
  const seen = [];
  const result = await agentResult(['example'], {
    ...registryOptions, budgetMs: 1200, browser: true,
    resolveNs: async domain => domain.endsWith('.me') ? [] : ['ns.example.net'],
    confirm: async (_shop, domain) => {
      seen.push(domain);
      return new Promise(() => {});
    },
  });
  assert.deepEqual(seen, ['example.me']);
  assert.equal(result.complete, false);
  assert.equal(result.best, undefined);
  assert.deepEqual(result.names[0].free.find(row => row.d === 'me'), { d: 'me', s: 'nc' });
  assert.deepEqual(result.listPrices.me, { shop: 'Spaceship' });
});

test('agent batch accepts bare names and exact domains together in one native call', async () => {
  const attempted = [];
  const result = await agentResult(['Example', 'oakenroom.me', 'Sample.IO'], {
    ...registryOptions,
    resolveNs: async domain => {
      attempted.push(domain);
      return domain === 'example.me' ? [] : ['ns.example.net'];
    },
    confirm: async () => ({ status: 'could-not-confirm' }),
  });
  assert.deepEqual(result.names.map(row => row.name), ['example', 'oakenroom.me', 'sample.io']);
  assert.deepEqual(result.names[1], { name: 'oakenroom.me', taken: ['me'] });
  assert.deepEqual(result.names[2], { name: 'sample.io', taken: ['io'] });
  assert.equal(attempted.filter(domain => domain.startsWith('example.')).length, 14);
  assert.deepEqual(attempted.filter(domain => !domain.startsWith('example.')).sort(), ['oakenroom.me', 'sample.io']);
  for (const names of [['a', 'x..com'], ['a', 'x.example.co.uk'], ['a', '.com']]) {
    assert.equal(typeof (await agentResult(names, registryOptions)).error, 'string', names.join());
  }
});

test('agent batch retries Google endings once and names an evidenced registry rate limit', async () => {
  const calls = new Map();
  const google = (limitFirst) => async url => {
    if (url === 'https://data.iana.org/rdap/dns.json') return registryOptions.fetcher(url);
    const domain = decodeURIComponent(url.split('/').at(-1));
    calls.set(domain, (calls.get(domain) ?? 0) + 1);
    if (/\.(app|dev)$/.test(domain) && calls.get(domain) <= limitFirst) return new Response(null, { status: 429 });
    return new Response(null, { status: 404 });
  };
  const options = {
    ...registryOptions, pause: async () => {}, endings: ['com', 'app', 'dev'],
    resolveNs: async () => [], confirm: async () => ({ status: 'could-not-confirm' }),
  };
  const recovered = await agentResult(['example'], { ...options, fetcher: google(3) });
  assert.deepEqual(recovered.names[0].free.map(row => row.d).sort(), ['app', 'com', 'dev']);
  assert.equal(recovered.shopCheckWhy, undefined);
  assert.equal(calls.get('example.app'), 4);
  calls.clear();
  const limited = await agentResult(['example', 'sample'], { ...options, fetcher: google(Infinity) });
  for (const row of limited.names) assert.deepEqual(row.shop_check.sort(), ['app', 'dev']);
  assert.deepEqual(limited.shopCheckWhy, {
    app: 'Google Registry rate limit (HTTP 429)', dev: 'Google Registry rate limit (HTTP 429)',
  });
  assert.equal(calls.get('example.app'), 4);
});

test('agent returns a confirmed row, single-query variants and exact-domain support', async () => {
  const checkedAt = '2026-11-24T10:00:00.000Z';
  const payload = await agentResult('Example', {
    ...registryOptions, now: new Date(checkedAt), browser: true,
    resolveNs: async domain => /\.(me|so)$/.test(domain) ? [] : ['ns.example.net'],
    confirm: async () => ({ status: 'confirmed', shopName: 'Spaceship', price: 8.701, renewal: 15.531, checkedAt }),
  });
  const json = JSON.parse(JSON.stringify(payload));
  assert.equal(json.checkedAt, checkedAt);
  assert.equal(json.complete, true);
  assert.equal(json.priceListDate, undefined);
  assert.equal(json.results, undefined);
  assert.equal(json.options, undefined);
  assert.equal(json.legend.nc, 'Free at the registry; list price, not confirmed');
  assert.equal(json.legend.ok, 'Free, price confirmed at the shop (at = quote time)');
  assert.deepEqual(json.best, {
    domain: 'example.me', status: 'free-confirmed', priceNow: 8.7, at: '10:00', renewal: 15.53, threeYear: 39.76, shop: 'Spaceship',
    buyUrl: 'https://www.spaceship.com/domain-search/?query=example.me',
  });
  assert.deepEqual(json.names, [{
    name: 'example',
    taken: ['com', 'ai', 'io', 'co', 'dev', 'app', 'si', 'no', 'net', 'org', 'xyz', 'tech', 'examplehq.com', 'getexample.com', 'tryexample.com', 'useexample.com'],
    free: [{ d: 'me', s: 'ok', now: 8.7, renew: 15.53, y3: 39.76, shop: 'Spaceship', at: '10:00' },
      { d: 'so', s: 'nc', shop: 'Namecheap' }],
  }]);
  assert.equal(json.buyUrlTemplate.Spaceship.replace('{domain}', json.best.domain), json.best.buyUrl);
  assert.ok(Buffer.byteLength(JSON.stringify(json)) < 3000);
  const exact = await agentResult('https://www.Example.com/', {
    ...registryOptions, resolveNs: async () => ['ns.example.net'],
  });
  assert.equal(exact.best, undefined);
  assert.equal(exact.buyUrlTemplate, undefined);
  assert.deepEqual(exact.names, [{ name: 'example.com', taken: ['com'] }]);
  const rejected = spawnSync(process.execPath, [command, '--agent', '...'], { encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.equal(typeof JSON.parse(rejected.stdout).error, 'string');
});

test('classifies marketplace NS from the existing DNS reply, including on non-.com endings', async () => {
  const nameservers = [
    ['NS1.AFTERNIC.COM.', 'GoDaddy / Afternic'], ['ns01.cashparking.com', 'GoDaddy / Afternic'],
    ['ns1.dan.com', 'Dan.com / Undeveloped'], ['ns2.undeveloped.com', 'Dan.com / Undeveloped'],
    ['ns1.sedoparking.com', 'Sedo'], ['nsg2.namebrightdns.com', 'HugeDomains'],
    ['ns1.bodis.com', 'Bodis'], ['ns2.parkingcrew.net', 'ParkingCrew'],
    ['ns1.atom.com', 'Atom / Squadhelp'], ['ns2.squadhelp.com', 'Atom / Squadhelp'],
  ];
  for (const [host, marketplace] of nameservers) assert.equal(saleMarketplace([host]), marketplace, host);
  for (const host of ['ns1.fakeafternic.com', 'ns1.afternic.com.example.test', 'ns1.domaincontrol.com', 'ns1.namebrightdns.com']) {
    assert.equal(saleMarketplace([host]), null, host);
  }
  const result = await searchName('example', {
    directory: null, skipComSite: true,
    resolveNs: async domain => [domain === 'example.me' ? 'ns2.undeveloped.com' : 'ns1.domaincontrol.com'],
    fetcher: async () => assert.fail('DNS already returned registration'),
  });
  assert.deepEqual(result.results.filter(row => row.forSale).map(row => row.domain), ['example.me']);
});

test('agent checks all fourteen endings for 20 names and keeps the priced output under 8 KB', async t => {
  const cache = await mkdtemp(join(tmpdir(), 'hound-batch-'));
  t.after(() => rm(cache, { recursive: true, force: true }));
  const directory = pathToFileURL(cache + '/');
  const now = new Date('2026-11-24T12:00:00Z');
  const checkedAt = now.toISOString();
  await writeCache(directory, 'prices.json', { checkedAt, catalogs: {
    dynadot: { checkedAt, prices: Object.fromEntries(nameCandidates('example', { variants: false }).map(({ tld }, index) =>
      [tld, { shop: 'Dynadot', firstYear: index + 7, renewal: index + 18 }])) },
  } });
  const queries = [' Example One ', ...Array.from({ length: 19 }, (_, index) => 'a'.repeat(61) + index)];
  const attempted = [];
  const started = [];
  const start = performance.now();
  const result = await agentResult(queries, {
    ...registryOptions, directory, now, cachedOnly: true, browser: true,
    comSite: async () => assert.fail('Batch mode checks registry and shops only'),
    resolveNs: async domain => {
      attempted.push(domain);
      await delay(5);
      return domain.startsWith('exampleone.') && domain.endsWith('.io') ? ['ns1.atom.com'] : [];
    },
    confirm: async (shop, domain, options) => {
      started.push([shop, domain]);
      assert.equal(options.oneShop, true);
      assert.equal(options.fresh, true);
      return { status: 'confirmed', shopName: 'Spaceship', price: 9.48, renewal: 10.68 };
    },
  });
  assert.ok(performance.now() - start < 15_000);
  assert.equal(result.complete, true);
  assert.deepEqual(result.names.map(row => row.name), queries.map(normalizeName));
  assert.equal(attempted.length, 280);
  assert.equal(started.length, 1);
  assert.equal(result.best.domain, started[0][1]);
  assert.equal(result.names.flatMap(row => row.free ?? []).filter(row => row.s === 'ok').length, 1);
  const domains = result.names.flatMap(({ name, taken = [], resale = [], free = [], shop_check = [] }) =>
    [...taken, ...resale, ...free.map(row => row.d), ...shop_check].map(ending => `${name}.${ending}`));
  assert.equal(domains.length, 280);
  assert.deepEqual(new Set(domains), new Set(attempted));
  assert.deepEqual(result.names[0].resale, ['io']);
  assert.ok(result.names[0].free.some(row => row.d === 'so'));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) + 1 < 8000);
  assert.deepEqual(result.listPrices.ai, { now: 16, renew: 38, y3: 54, term: 2, jump: true, shop: 'Dynadot' });
  for (const { free } of result.names) {
    const prices = free.map(row => row.now ?? result.listPrices[row.d].now);
    assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  }
  for (const names of [[], ['a', 'x..com'], Array(21).fill('example')]) {
    assert.equal(typeof (await agentResult(names)).error, 'string');
  }
});

test('agent preserves duplicate input positions while looking up each candidate only once', async () => {
  const attempted = [];
  const result = await agentResult(['Example', 'Another', 'example'], {
    ...registryOptions,
    resolveNs: async domain => {
      attempted.push(domain);
      return ['ns.example.net'];
    },
  });
  assert.deepEqual(result.names.map(row => row.name), ['example', 'another', 'example']);
  assert.deepEqual(result.names[0], result.names[2]);
  assert.equal(attempted.length, 28);
});

test('existing direct shop hosts remain exact HTTPS allowlist entries', () => {
  const run = url => spawnSync(process.execPath, [command, '--open', '--dry-run', url], { encoding: 'utf8' });
  for (const link of [
    'https://www.godaddy.com/domainsearch/find?domainToCheck=example.me',
    'https://www.namecheap.com/domains/registration/results/?domain=example.me',
    'https://domains.squarespace.com/domain-search?query=example.me',
    'https://www.ionos.com/domainshop/search?domains=example.me',
    'https://www.hostinger.com/domain-name-results?domain=example.me',
    'https://www.hover.com/domains/results?q=example.me',
    'https://www.cloudflare.com/domains/search/?q=example.me',
  ]) {
    const url = new URL(link);
    assert.equal(run(link).status, 0, link);
    assert.equal(run(link.replace(url.host, url.host + '.example.test')).status, 1, link);
  }
  // Porkbun prices are data only; Domain Hound never opens or links Porkbun.
  assert.equal(run('https://porkbun.com/checkout/search?q=example.me').status, 1);
});

test('classifies taken .com pages as for sale, parked, live or no site', () => {
  const page = { url: 'https://example.com/', status: 200, contentType: 'text/html; charset=utf-8' };
  assert.deepEqual(classifyComSite({ ...page, url: 'https://sedo.com/search/details/' }), { state: 'for-sale' });
  assert.deepEqual(classifyComSite({ ...page, body: '<h1>This domain may be for sale</h1><p>GoDaddy</p>' }), { state: 'for-sale' });
  assert.deepEqual(classifyComSite({ ...page, body: '<p>This domain is parked.</p>' }), { state: 'parked' });
  assert.deepEqual(classifyComSite({ ...page, body: '<title>Guide &amp; Tools</title><script>"Buy this domain"</script>' }), {
    state: 'live', title: 'Guide & Tools',
  });
  assert.deepEqual(classifyComSite({ ...page, status: 404 }), { state: 'no-site' });
  assert.deepEqual(classifyComSite({ ...page, body: '<title>Site Not Found</title>' }), { state: 'no-site' });
  assert.deepEqual(classifyComSite({ ...page, url: 'https://sedo.com.example.com/' }), { state: 'no-site' });
});

test('permits both exact HTTPS trademark search hosts in the open dry run', () => {
  for (const url of ['https://euipo.europa.eu/eSearch/', 'https://tmsearch.uspto.gov/']) {
    const result = spawnSync(process.execPath, [command, '--open', '--dry-run', url], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { opened: false, url });
  }
  for (const url of ['https://euipo.europa.eu.example.com/', 'https://tmsearch.uspto.gov@example.com/', 'http://tmsearch.uspto.gov/']) {
    assert.equal(spawnSync(process.execPath, [command, '--open', '--dry-run', url]).status, 1);
  }
});
