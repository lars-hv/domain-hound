import '../../test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { writeCache } from './cache.mjs';
import { searchAndroidApps } from './google-play.mjs';
import { triageWithFollowUp } from './index.mjs';
import { listSavings } from './name-search.mjs';
import { searchEntities } from './triage-sources.mjs';
import { withSocial } from '../../test-support/social-fixture.mjs';
import { resultPages, savingsLine } from '../../results.mjs';

const now = new Date('2026-11-24T12:00:00Z');
const day = (offset = 0) => new Date(+now - offset * 86_400_000).toISOString();
const catalog = shops => ({ checkedAt: day(), catalogs: Object.fromEntries(shops.map(([id, shop, firstYear, renewal, tld = 'com', at = day()]) =>
  [id, { checkedAt: at, prices: { [tld]: { shop, firstYear, renewal } } }])) });

async function directoryFor(t) {
  const path = await mkdtemp(join(tmpdir(), 'hound-speed-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return new URL('./', pathToFileURL(path + '/'));
}

test('savings compare the pick with the lower median of at least three shops over three years, only when positive', () => {
  const pick = { tld: 'com', price: 9, renewal: 10, shop: 'Dynadot', priceCheckedAt: day() };
  const three = catalog([['dynadot', 'Dynadot', 9, 10], ['spaceship', 'Spaceship', 9.48, 10.68], ['porkbun', 'Porkbun', 11.81, 11.81]]);
  // Dynadot $29.00 over three years; Spaceship $30.84 is the median, Porkbun $35.43 the highest and never used.
  assert.deepEqual(listSavings(three, pick, now, null), { years: 3, here: 29, shop: 'Dynadot', median: 30.84,
    medianShop: 'Spaceship', saved: 1.84, shops: 3, checkedFrom: '2026-11-24', checkedTo: '2026-11-24' });
  // Two shops are not a median.
  assert.equal(listSavings(catalog([['dynadot', 'Dynadot', 9, 10], ['porkbun', 'Porkbun', 20, 20]]), pick, now, null), null);
  // The median shop itself saves nothing.
  assert.equal(listSavings(three, { ...pick, price: 9.48, renewal: 10.68, shop: 'Spaceship' }, now, null), null);
  // A price that is not the listed one, or a two-year minimum term, is not comparable.
  assert.equal(listSavings(three, { ...pick, price: 8 }, now, null), null);
  const ai = catalog([['dynadot', 'Dynadot', 80, 80, 'ai'], ['spaceship', 'Spaceship', 90, 90, 'ai'], ['porkbun', 'Porkbun', 95, 95, 'ai']]);
  assert.equal(listSavings(ai, { ...pick, tld: 'ai', price: 80, renewal: 80 }, now, null), null);
  // Undated or stale prices drop out of the comparison.
  const stale = catalog([['dynadot', 'Dynadot', 9, 10], ['spaceship', 'Spaceship', 9.48, 10.68, 'com', day(30)],
    ['porkbun', 'Porkbun', 11.81, 11.81]]);
  assert.equal(listSavings(stale, pick, now, null), null);
  // A third shop's bundled list price counts while it is inside its date window, never twice for one shop.
  const two = catalog([['dynadot', 'Dynadot', 9, 10], ['porkbun', 'Porkbun', 11.81, 11.81]]);
  const bundled = catalog([['spaceship', 'Spaceship', 9.48, 10.68, 'com', day(2)], ['dynadot', 'Dynadot', 1, 1]]);
  assert.deepEqual(listSavings(two, pick, now, bundled), { years: 3, here: 29, shop: 'Dynadot', median: 30.84,
    medianShop: 'Spaceship', saved: 1.84, shops: 3, checkedFrom: '2026-11-22', checkedTo: '2026-11-24' });
  assert.equal(listSavings(two, pick, now, catalog([['spaceship', 'Spaceship', 9.48, 10.68, 'com', day(9)]])), null);
});

test('the results page shows the savings line per pick, and only for a matching list price', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hound-results-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pages = resultPages({ directory, env: { DOMAIN_HOUND_OPEN: 'off' } });
  const savings = { years: 3, here: 29, shop: 'Dynadot', median: 30.84, medianShop: 'Spaceship', saved: 1.84, shops: 3,
    checkedFrom: '2026-11-24', checkedTo: '2026-11-24' };
  const data = { checkedAt: now.toISOString(), priceListDate: '2026-11-24', prices: { com: { now: 9, renew: 10, shop: 'Dynadot' } },
    names: [{ name: 'quietfern', free: [{ d: 'com', s: 'nc' }] }],
    receiptDetails: [{ endings: [{ domain: 'quietfern.com', source: 'rdap', checkedAt: now.toISOString(), priceAt: '2026-11-24', shop: 'Dynadot', savings }] }] };
  const result = await pages(data, {});
  const html = await readFile(new URL(result.resultPage), 'utf8');
  assert.match(html, /quietfern\.com at Dynadot\. 3 years here: \$29\.00 vs \$30\.84 at Spaceship, the median of 3 shops&#39; list prices from 2026-11-24\./);
  // Page only: the chat answer stays short.
  assert.doesNotMatch(result.say, /3 years here/);
  // Check-domains answers never claim app checks they did not run.
  assert.doesNotMatch(result.say, /iOS|Android/);
  const record = { domain: 'quietfern.com', state: 'free', priceLabel: 'List price', now: 9, renew: 10, shop: 'Dynadot', savings };
  assert.match(savingsLine(record), /\$29\.00 vs \$30\.84/);
  for (const changed of [{ priceLabel: 'Shop quote' }, { now: 8 }, { shop: 'Spaceship' }, { term: 2 },
    { savings: { ...savings, saved: 0, median: 29 } }, { savings: { ...savings, shops: 2 } }]) {
    assert.equal(savingsLine({ ...record, ...changed }), null, JSON.stringify(changed));
  }
});

test('Wikidata searches go one at a time and a busy answer is asked again', async () => {
  let active = 0;
  let most = 0;
  const seen = new Map();
  const fetcher = async value => {
    const search = new URL(value).searchParams.get('search');
    seen.set(search, (seen.get(search) ?? 0) + 1);
    active++;
    most = Math.max(most, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active--;
    // The first search per name meets the HTTP 200 busy answer Wikidata gives to parallel searches.
    return Response.json(seen.get(search) === 1
      ? { error: { code: 'cirrussearch-too-busy-error', info: 'Search is currently too busy. Please try again later.' } }
      : { search: [] });
  };
  const rows = await Promise.all(['Quiet Fern', 'Moss Harbor'].map(input =>
    searchEntities(input.replace(' ', '').toLowerCase(), input, { fetcher, cacheLifetime: 1, directory: null })));
  assert.deepEqual(rows, [[], []]);
  assert.equal(most, 1);
  assert.deepEqual([...seen.values()], [2, 2]);
});

test('a slow Google Play search gets the time left instead of a 2.8 second attempt', async () => {
  const launch = async () => ({
    async newContext() {
      return { async newPage() {
        let url;
        return {
          goto: async value => { url = value; return { ok: () => true }; },
          url: () => url,
          waitForFunction: async () => {
            await new Promise(resolve => setTimeout(resolve, 2900));
            return { jsonValue: async () => [] };
          },
          close: async () => {},
        };
      } };
    },
    close: async () => {},
  });
  const seen = [];
  const results = await searchAndroidApps(new Map([['quietfern', 'Quiet Fern']]),
    { directory: null, playBudgetMs: 6000, launch, onResult: name => seen.push(name) });
  assert.deepEqual(results.get('quietfern'), []);
  assert.deepEqual(seen, ['quietfern']);
});

test('Wikidata entity details get more than 1.2 seconds', async () => {
  const fetcher = async (value, init) => {
    const url = new URL(value);
    if (url.searchParams.get('action') === 'wbsearchentities') {
      return Response.json({ search: [{ id: 'Q1', label: 'Quiet Fern', description: 'software' }] });
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 1500);
      init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
    });
    return Response.json({ entities: { Q1: { claims: { P31: [{ mainsnak: { datavalue: { value: { id: 'Q7397' } } } }] }, sitelinks: {} } } });
  };
  const rows = await searchEntities('quietfern', 'Quiet Fern', { fetcher, cacheLifetime: 1, directory: null });
  assert.equal(rows?.[0]?.brand, true);
});

test('a name screen reports slow app and EUIPO checks as pending, then reuses their answers', async t => {
  const directory = await directoryFor(t);
  await writeCache(directory, 'prices.json', catalog([['dynadot', 'Dynadot', 9, 11]]));
  const calls = new Map();
  const count = host => calls.set(host, (calls.get(host) ?? 0) + 1);
  const options = {
    directory, now, env: { DOMAIN_HOUND_EUIPO_CLIENT_ID: 'fixture-id', DOMAIN_HOUND_EUIPO_CLIENT_SECRET: 'fixture-secret' },
    cachedOnly: true, bundledCatalog: null, receipt: true, compact: true, deferHandles: true, endings: ['com'],
    launch: async () => { throw new Error('No browser in this test'); },
    resolveNs: async () => [],
    comSite: async () => ({ state: 'no-site' }),
    fetcher: withSocial(async value => {
      const url = new URL(value);
      count(url.hostname);
      if (url.hostname === 'data.iana.org') return Response.json({ services: [[['com'], ['https://rdap.example.test/']]] });
      if (url.hostname === 'itunes.apple.com') {
        // The App Store answers after the first answer is due.
        await new Promise(resolve => setTimeout(resolve, 600));
        return Response.json({ results: [] });
      }
      if (url.hostname === 'tmsearch.uspto.gov') return Response.json({ hits: { hits: [] } });
      if (url.hostname === 'euipo.europa.eu') return Response.json({ access_token: 'fixture-token' });
      if (url.hostname === 'api.euipo.europa.eu') {
        await new Promise(resolve => setTimeout(resolve, 600));
        return Response.json({ trademarks: [], totalElements: 0 });
      }
      if (url.hostname === 'www.wikidata.org') return Response.json({ search: [] });
      if (url.hostname === 'play.google.com') return new Response('<html><h1>No results for Quiet Fern</h1></html>', { headers: { 'content-type': 'text/html' } });
      if (url.hostname === 'api.github.com') return Response.json({ total_count: 0, incomplete_results: false, items: [] });
      if (url.hostname === 'data.brreg.no') return Response.json({ page: { totalPages: 0 } });
      if (url.hostname === 'www.sec.gov') return Response.json({ fields: ['cik', 'name', 'ticker', 'exchange'], data: [] });
      if (url.hostname === 'www.google.com') return Response.json([url.searchParams.get('q'), []]);
      if (url.hostname === 'trends.google.com') return Response.json({ default: { topics: [] } });
      return new Response(null, { status: 404 });
    }),
  };
  let first;
  const final = await triageWithFollowUp(['Quiet Fern'], options, { followUp: true, answerMs: 150, print: value => { first = value; } });
  assert.equal(first.followUp, true);
  assert.equal(first.names[0].verdict, 'Check first');
  assert.match(first.names[0].reason, /still checking App Store/);
  assert.doesNotMatch(first.names[0].reason, /did not answer/);
  assert.ok(first.receiptDetails[0].waiting.includes('App Store'));
  assert.ok(first.receiptDetails[0].waiting.includes('EUIPO'));
  assert.equal(first.names[0].competition.AppStore, null);
  assert.equal(first.names[0].competition.EU, null);
  // The second pass re-assesses with the late answer and says nothing is pending.
  assert.equal(final.followUp, undefined);
  assert.deepEqual(final.names[0].competition.AppStore, []);
  assert.deepEqual(final.names[0].competition.EU, []);
  assert.equal(final.receiptDetails[0].waiting, undefined);
  assert.doesNotMatch(final.names[0].reason, /still checking/);
  // Every source ran once across both passes.
  assert.equal(calls.get('itunes.apple.com'), 1);
  assert.equal(calls.get('tmsearch.uspto.gov'), 1);
  assert.equal(calls.get('api.euipo.europa.eu'), 1);
});
