import '../../test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { attribution, checkText, purchaseLine } from '../../display.mjs';
import { cacheDir, userCacheDir, writeCache } from './cache.mjs';
import { confirmDomain } from './confirm.mjs';
import { agentResult, liveCheckFor } from './index.mjs';

const now = new Date('2026-11-24T12:00:00Z');
const checkedAt = now.toISOString();
const absentPlaywright = fileURLToPath(new URL('./fixtures/absent-playwright.mjs', import.meta.url));

test('keeps the runtime cache in a package-independent user cache folder', () => {
  const home = join(sep, 'home', 'example');
  assert.equal(userCacheDir({ DOMAIN_HOUND_CACHE_DIR: 'relative/cache' }, 'linux', home), resolve('relative/cache'));
  assert.equal(userCacheDir({}, 'darwin', home), join(home, 'Library', 'Caches', 'domain-hound'));
  assert.equal(userCacheDir({}, 'linux', home), join(home, '.cache', 'domain-hound'));
  assert.equal(userCacheDir({ XDG_CACHE_HOME: join(sep, 'xdg') }, 'linux', home), join(sep, 'xdg', 'domain-hound'));
  assert.equal(userCacheDir({ LOCALAPPDATA: join(sep, 'local') }, 'win32', home), join(sep, 'local', 'domain-hound', 'Cache'));
  // Tests run against a throwaway folder; the package itself never holds a cache.
  assert.equal(cacheDir.href, pathToFileURL(process.env.DOMAIN_HOUND_CACHE_DIR + sep).href);
  assert.ok(cacheDir.href.endsWith('/'));
  assert.notEqual(cacheDir.href, new URL('./cache/', import.meta.url).href);
  assert.equal(existsSync(new URL('./cache/', import.meta.url)), false);
});

async function pricedRegistry(t) {
  const folder = await mkdtemp(join(tmpdir(), 'hound-fallback-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const directory = pathToFileURL(folder + sep);
  await writeCache(directory, 'prices.json', { checkedAt, catalogs: { dynadot: { checkedAt, prices: {
    com: { shop: 'Dynadot', firstYear: 10.5, renewal: 12 },
    me: { shop: 'Dynadot', firstYear: 3.5, renewal: 6 },
    io: { shop: 'Dynadot', firstYear: 30, renewal: 50 },
  } } } });
  return {
    directory, now, cachedOnly: true, queryWhois: async () => '',
    // example.com is registered; every other candidate is free at the registry.
    resolveNs: async domain => domain === 'example.com' ? ['ns.example.net'] : [],
    fetcher: async url => url === 'https://data.iana.org/rdap/dns.json'
      ? Response.json({ services: [[['com', 'io', 'me'], ['https://rdap.example.test/']]] })
      : new Response(null, { status: 404 }),
  };
}

function withoutPlaywright(t) {
  const previous = process.env.DOMAIN_HOUND_PLAYWRIGHT;
  process.env.DOMAIN_HOUND_PLAYWRIGHT = absentPlaywright;
  t.after(() => {
    if (previous === undefined) delete process.env.DOMAIN_HOUND_PLAYWRIGHT;
    else process.env.DOMAIN_HOUND_PLAYWRIGHT = previous;
  });
}

test('by default an exact free domain needs no browser and labels its list price', async t => {
  withoutPlaywright(t);
  const options = await pricedRegistry(t);
  const started = performance.now();
  const result = await agentResult('example.me', { ...options, env: {} });
  assert.ok(performance.now() - started < 2000);
  assert.equal(result.complete, true);
  assert.equal(result.best, undefined);
  assert.equal(result.liveCheck, undefined);
  assert.deepEqual(result.names, [{ name: 'example.me',
    free: [{ d: 'me', s: 'nc', now: 3.5, renew: 6, y3: 15.5, shop: 'Dynadot' }] }]);
  const lines = JSON.parse(checkText(result)).display.split('\n');
  assert.equal(lines[0], '**example.me is free.** The registry shows it free; the price is a list price from 2026-11-24, not a shop quote.'
    + ' Checked 2026-11-24 12:00 UTC.');
  assert.ok(!lines.some(line => /Live shop check|Playwright/.test(line)));
  assert.deepEqual(lines.slice(-3), [attribution, '', purchaseLine]);
});

test('with the explicit confirm flag and no Playwright, an exact free domain keeps its list price and asks for a shop check', async t => {
  withoutPlaywright(t);
  const options = { ...await pricedRegistry(t), browser: true };
  const started = performance.now();
  const result = await agentResult('example.me', options);
  assert.ok(performance.now() - started < 5000);
  assert.equal(result.complete, true);
  assert.equal(result.best, undefined);
  assert.deepEqual(result.names, [{ name: 'example.me',
    free: [{ d: 'me', s: 'nc', now: 3.5, renew: 6, y3: 15.5, shop: 'Dynadot' }] }]);
  assert.deepEqual(result.liveCheck, { domain: 'example.me', status: 'check-at-shop', reason: 'Playwright is not installed',
    checkUrl: 'https://www.dynadot.com/domain/search?domain=example.me' });
  const { display } = JSON.parse(checkText(result));
  const lines = display.split('\n');
  assert.match(lines[0], /^\*\*example\.me is free\.\*\* The registry shows it free; the price is a list price from 2026-11-24, not a shop quote\./);
  assert.ok(lines.includes('| example.me | $3.50 | $6.00/yr | $15.50 | '
    + '[example.me](https://www.dynadot.com/domain/search?domain=example.me) at Dynadot |'), display);
  assert.ok(lines.includes('Check at shop: [example.me](https://www.dynadot.com/domain/search?domain=example.me). '
    + 'Live shop check unavailable (Playwright is not installed). Any prices shown are list estimates.'), display);
  assert.doesNotMatch(display, /confirmed at|^Confirmed|✓/m);
  assert.deepEqual(lines.slice(-3), [attribution, '', purchaseLine]);
});

test('with the explicit confirm flag and no Playwright, a batch keeps taken rows and list prices and links the domain to check', async t => {
  withoutPlaywright(t);
  const options = { ...await pricedRegistry(t), endings: ['com', 'me', 'io'], browser: true };
  const result = await agentResult(['example'], options);
  assert.equal(result.best, undefined);
  assert.deepEqual(result.names, [{ name: 'example', taken: ['com'], free: [{ d: 'me', s: 'nc' }, { d: 'io', s: 'nc' }] }]);
  assert.deepEqual(result.listPrices.me, { now: 3.5, renew: 6, y3: 15.5, shop: 'Dynadot' });
  assert.deepEqual(result.listPrices.io, { now: 30, renew: 50, y3: 130, shop: 'Dynadot' });
  assert.equal(result.liveCheck.domain, 'example.me');
  assert.equal(result.liveCheck.reason, 'Playwright is not installed');
  const { display } = JSON.parse(checkText(result));
  assert.match(display, /^Standard prices: \.me \$3\.50\/\$6\.00 · \.io \$30\.00\/\$50\.00$/m);
  assert.match(display, /^- example\.me \$3\.50\/\$6\.00 list price\n- example\.io \$30\.00\/\$50\.00 list price$/m);
  assert.match(display, /^Taken: example \.com$/m);
  assert.match(display, /\nCheck at shop: \[example\.me\]\(https:\/\/www\.dynadot\.com\/domain\/search\?domain=example\.me\)\. Live shop check unavailable/);
  assert.doesNotMatch(display, /^Confirmed|^- .*✓/m);
  assert.ok(display.endsWith('\n\n' + attribution));
  // Without the flag the browser never starts and no shop-check notice appears.
  const plain = await agentResult(['example'], { ...options, browser: false, env: {},
    confirm: async () => assert.fail('The browser runs only on the explicit confirm flag') });
  assert.equal(plain.liveCheck, undefined);
  assert.deepEqual(plain.names, result.names);
});

test('a browser that cannot start is named, while other inconclusive shop checks keep the earlier result', async t => {
  const options = { ...await pricedRegistry(t), endings: ['com', 'me'], browser: true };
  const noBrowser = await agentResult(['example'], { ...options,
    confirm: (shop, domain, settings) => confirmDomain(shop, domain, { ...settings, launch: async () => { throw new Error('no browser'); } }) });
  assert.equal(noBrowser.liveCheck.reason, 'the Playwright browser could not start');
  assert.equal(noBrowser.liveCheck.checkUrl, 'https://www.dynadot.com/domain/search?domain=example.me');
  const blocked = await agentResult(['example'], { ...options,
    confirm: async () => ({ status: 'could-not-confirm', reason: 'Shop blocked the check.' }) });
  assert.equal(blocked.liveCheck, undefined);
  assert.deepEqual(blocked.names[0], { name: 'example', taken: ['com'], free: [{ d: 'me', s: 'nc' }] });
  assert.equal(liveCheckFor({ domain: 'example.me', confirmShop: 'spaceship' }, { status: 'confirmed' }), null);
  assert.deepEqual(liveCheckFor({ domain: 'example.me', confirmShop: 'spaceship' },
    { status: 'could-not-confirm', reason: 'Playwright is unavailable.' }), {
    domain: 'example.me', status: 'check-at-shop', reason: 'Playwright is not installed',
    checkUrl: 'https://www.spaceship.com/domain-search/?query=example.me',
  });
});
