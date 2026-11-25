import '../../test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { writeCache } from './cache.mjs';
import { classifyComSite } from './com-site.mjs';
import {
  assessRival, autocompleteWords, collectRivals, crawlPages, judgeRivals, parseGeo, refreshTranco, siteDomain,
  tractionNotes, tractionSummary, tractionThresholds, tractionVerdict, trancoRank,
} from './traction.mjs';
import { namePresence, triageNames } from './triage.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/traction.json', import.meta.url), 'utf8'));
const triageFixture = JSON.parse(readFileSync(new URL('./fixtures/triage.json', import.meta.url), 'utf8'));
const companies = JSON.parse(readFileSync(new URL('./fixtures/company-names.json', import.meta.url), 'utf8'));
const now = new Date('2026-11-24T12:00:00Z');
const day = 86_400_000;

async function directoryFor(t) {
  const path = await mkdtemp(join(tmpdir(), 'hound-traction-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return pathToFileURL(path + '/');
}

const emptyPlay = async () => ({
  async newContext() {
    return { async newPage() {
      let url;
      return {
        context: () => ({}), goto: async value => { url = value; return { ok: () => true }; }, url: () => url,
        waitForFunction: async () => ({ jsonValue: async () => [] }), request: { get: async () => ({}) }, close: async () => {},
      };
    } };
  },
  close: async () => {},
});

function crawlResponse(domain) {
  const value = fixture.crawl[domain];
  if (value === undefined) return new Response('{"message": "server busy"}', { status: 503 });
  if (value === 0) return Response.json({ message: 'No Captures found for: ' + domain }, { status: 404 });
  const count = value === 'limit' ? 1000 : value;
  // http, https and www copies of one page count once.
  const lines = Array.from({ length: count }, (_, index) => JSON.stringify({
    url: (index % 2 ? 'http://www.' : 'https://') + domain + '/page-' + Math.floor(index / (value === 'limit' ? 1 : 1)) + '/',
  }));
  return new Response(lines.join('\n') + '\n');
}

// Free public sources answer from the fixture; every request is counted per host.
function fetcherFor(calls) {
  return async value => {
    const url = new URL(value);
    calls[url.hostname] = (calls[url.hostname] ?? 0) + 1;
    const q = url.searchParams;
    switch (url.hostname) {
      case 'data.iana.org':
        return Response.json({ services: [[['com', 'ai', 'io', 'dev', 'app', 'co', 'si', 'so', 'me'], ['https://rdap.example.test/']]] });
      case 'rdap.example.test': {
        const domain = decodeURIComponent(url.pathname.split('/').at(-1));
        const date = fixture.rdap[domain];
        return date ? Response.json({ events: [{ eventAction: 'registration', eventDate: date }] })
          : new Response(null, { status: 404 });
      }
      case 'index.commoncrawl.org':
        if (url.pathname === '/collinfo.json') return Response.json(fixture.collinfo);
        assert.equal(url.pathname, '/CC-MAIN-2026-47-index');
        assert.equal(q.get('matchType'), 'domain');
        assert.equal(q.get('output'), 'json');
        assert.equal(q.get('limit'), '1000');
        assert.equal(q.get('showNumPages'), null);
        return crawlResponse(q.get('url'));
      case 'tmsearch.uspto.gov': return Response.json({ hits: { hits: [] } });
      case 'itunes.apple.com': return Response.json({ results: fixture.apps[q.get('term')] ?? [] });
      case 'www.wikidata.org': {
        if (q.get('action') === 'wbgetentities') {
          assert.equal(q.get('props'), 'claims|sitelinks');
          return Response.json({ entities: Object.fromEntries(q.get('ids').split('|').map(id => [id, fixture.wikidata.entities[id]])) });
        }
        return Response.json({ search: fixture.wikidata.search[q.get('search')] ?? [] });
      }
      case 'www.google.com': return Response.json([q.get('q'), fixture.google[q.get('q')]?.suggestions ?? []]);
      case 'trends.google.com': {
        const name = url.pathname.split('/').at(-1);
        return new Response(")]}',\n" + JSON.stringify({ default: { topics: fixture.google[name]?.topics ?? [] } }));
      }
      case 'api.github.com': return Response.json(triageFixture.github.missing);
      case 'data.brreg.no': return Response.json({ page: { totalPages: 0 } });
      case 'www.sec.gov': return Response.json(companies.edgar);
      default: return new Response(null, { status: 404 });
    }
  };
}

async function setUp(t, { tranco = true } = {}) {
  const directory = await directoryFor(t);
  await writeCache(directory, 'prices.json', { checkedAt: now.toISOString(), catalogs: { dynadot: {
    checkedAt: now.toISOString(),
    prices: { co: { shop: 'Dynadot', firstYear: 4, renewal: 30 }, dev: { shop: 'Dynadot', firstYear: 8, renewal: 16 } },
  } } });
  if (tranco) {
    await writeFile(new URL('tranco-top-1m.csv', directory), fixture.tranco);
    await writeCache(directory, 'tranco.json', { at: now.getTime(), rows: 5 });
  }
  const calls = {};
  return {
    calls,
    options: {
      directory, now, env: {}, cachedOnly: true, launch: emptyPlay, about: 'book quiet meeting rooms',
      resolveNs: async domain => fixture.sites[domain]?.state && fixture.sites[domain].state !== 'no-site' ? ['ns.example.test'] : [],
      comSite: async domain => fixture.sites[domain] ?? { state: 'no-site' },
      fetcher: fetcherFor(calls),
    },
  };
}

test('one table holds every traction threshold', () => {
  assert.deepEqual(tractionThresholds, {
    strong: { trancoRank: 100_000, appRatings: 1_000, wikipediaArticle: true, agentKnows: true },
    some: { trancoRank: 1_000_000, crawlPages: 200, domainYears: 3, appRatings: 100, autocompleteWords: 2 },
    dormant: { crawlPagesBelow: 20, staleYears: 3 },
  });
});

test('levels each signal at its threshold and separates silent sources from zeros', () => {
  const rival = (extra = {}) => ({ name: 'Example', domains: ['example.com'], apps: [], refs: [], sources: ['site'],
    site: { domain: 'example.com', state: 'live' }, ...extra });
  const at = (facts, extra) => assessRival(rival(extra), new Map([['example.com', facts]]), { now: now.getTime() });
  assert.equal(at({ tranco: 100_000 }).level, 'strong');
  assert.equal(at({ tranco: 100_001 }).level, 'some');
  assert.equal(at({ tranco: null, crawl: { pages: 199 } }).level, 'none');
  assert.equal(at({ tranco: null, crawl: { pages: 200 } }).level, 'some');
  assert.equal(at({ tranco: null, crawl: { pages: 1000, limited: true } }).signals[0].text, '1,000+ crawled pages');
  assert.equal(at({ tranco: null, registered: '2023-11-25' }).level, 'none');
  assert.deepEqual(at({ tranco: null, registered: '2023-11-24' }).signals, [{ text: 'domain since 2023', level: 'some' }]);
  // Domain age counts only with a live site.
  assert.equal(at({ tranco: null, registered: '2001-01-01' }, { site: { domain: 'example.com', state: 'no-site' } }).level, 'none');
  // Unavailable providers are unknown, never zero.
  assert.equal(at({}).level, 'unknown');
  assert.equal(at({ tranco: undefined, crawl: undefined }).level, 'unknown');
  const app = ratings => assessRival({ name: 'Example', domains: [], apps: [{ store: 'iOS', ratings }], refs: [], sources: ['app'] },
    new Map(), { now: now.getTime() });
  assert.equal(app(999).level, 'some');
  assert.equal(app(1000).level, 'strong');
  assert.equal(app(99).level, 'none');
  assert.equal(app(null).level, 'unknown');
  const bare = { name: 'Example', domains: [], apps: [], refs: [], sources: ['trends'] };
  assert.equal(assessRival(bare, new Map(), { answered: { wikidata: true, apps: true } }).level, 'none');
  assert.equal(assessRival(bare, new Map(), { answered: { wikidata: false, apps: true } }).level, 'unknown');
  assert.equal(assessRival({ ...bare, autocomplete: 2 }, new Map(), { answered: { wikidata: true } }).level, 'some');
  assert.equal(assessRival({ ...bare, wikipedia: 'Example (company)' }, new Map(), {}).level, 'strong');
  assert.equal(assessRival({ ...bare, geo: 'an example company' }, new Map(), {}).level, 'strong');
});

test("applies the traction verdict rules: Goliath, same business, other business and small use", () => {
  const judge = (rivals, evidence = new Map()) => judgeRivals(rivals, evidence,
    { now: now.getTime(), answered: { wikidata: true, apps: true }, entities: [] });
  const rival = (name, extra) => ({ name, domains: [], apps: [], refs: [], sources: ['trends'], sameBusiness: false, ...extra });
  const goliath = judge([rival('Bigco', { wikipedia: 'Bigco', sameBusiness: false })]);
  assert.deepEqual(tractionVerdict(goliath), ['Avoid', 'David vs Goliath: Bigco (Wikipedia article)']);
  const close = judge([rival('Midco', { apps: [{ store: 'iOS', ratings: 450 }], sameBusiness: true })]);
  assert.deepEqual(tractionVerdict(close), ['Avoid', 'Same-business rival with traction: Midco (450 iOS ratings)']);
  const other = judge([rival('Midco', { apps: [{ store: 'Android', ratings: 450 }] })]);
  assert.deepEqual(tractionVerdict(other), ['Check first', 'Same-name use with some traction: Midco (450 Android ratings)']);
  const small = judge([rival('RouteMender AI', { qualifier: 'ai' })]);
  assert.equal(tractionVerdict(small), null);
  assert.deepEqual(tractionNotes(small), ['Small same-name use: RouteMender AI (no visible traction)']);
  assert.equal(tractionSummary(small), null);
  const dormant = judge([rival('example.com', { domains: ['example.com'], sources: ['site'],
    site: { domain: 'example.com', state: 'for-sale' } })], new Map([['example.com', { tranco: null }]]));
  assert.equal(tractionVerdict(dormant), null);
  assert.deepEqual(tractionNotes(dormant), ['Dormant: example.com (for-sale)']);
  // A stale live site with a tiny crawl and no Tranco rank is dormant too, and its old domain does not count.
  const stale = judge([rival('Oldco', { domains: ['oldco.com'], sources: ['site'],
    site: { domain: 'oldco.com', state: 'live', copyright: 2019 } })],
  new Map([['oldco.com', { tranco: null, crawl: { pages: 4 }, registered: '2009-01-01' }]]));
  assert.equal(tractionVerdict(stale), null);
  assert.deepEqual(tractionNotes(stale), ['Dormant: oldco.com (stale site)']);
  // A parked domain that still ranks in Tranco is not called dormant.
  const ranked = judge([rival('Parkco', { domains: ['parkco.com'], sources: ['site'], site: { domain: 'parkco.com', state: 'parked' } })],
    new Map([['parkco.com', { tranco: 50_000 }]]));
  assert.equal(tractionVerdict(ranked)[0], 'Avoid');
});

test('finds rival homes without borrowing traction from sellers, platforms or encyclopedia homonyms', () => {
  assert.equal(siteDomain('https://www.notion.so/product?x=1'), 'notion.so');
  assert.equal(siteDomain('https://shop.example.co.uk/'), 'example.co.uk');
  assert.equal(siteDomain('not a url'), null);
  const entities = [
    { name: 'Notion', description: 'productivity software', brand: true, wikipedia: 'Notion (productivity software)', website: ['https://www.notion.so'] },
    { name: 'notion', description: 'reflection in the mind', wikipedia: null, website: [] },
    { name: 'Notion', description: 'music notation software', brand: true, wikipedia: 'Notion (music software)', website: ['http://www.presonus.com/products/notion-5'] },
  ];
  const apps = [
    { name: 'Notion: Notes, Tasks, AI', sellerUrl: 'https://www.notion.so', ratings: 84000, store: 'iOS' },
    { name: 'Notion', sellerUrl: 'https://sites.google.com/view/exampleindie', ratings: 3, store: 'iOS' },
  ];
  const rivals = collectRivals({ name: 'notion', entities, apps, suggestions: ['notion login', 'notion app', 'notion pricing'],
    topics: [{ name: 'Notion', description: 'Productivity software' }] });
  // The generic encyclopedia entry is not a rival; the music product keeps no home it does not own.
  assert.deepEqual(rivals.map(row => [row.name, row.domains]), [['Notion', ['notion.so']], ['Notion', []], ['Notion', []]]);
  assert.equal(rivals[0].apps[0].ratings, 84000);
  assert.deepEqual(rivals[2].apps, [{ store: 'iOS', ratings: 3 }]);
  assert.ok(rivals[0].sources.includes('trends'));
  // Name-level autocomplete depth belongs to a rival only when Google ties it to that rival's home.
  assert.equal(autocompleteWords('notion', ['notion login', 'notion app', 'notion pricing', 'notional value']), 3);
  assert.deepEqual(rivals.map(row => row.autocomplete), [0, 0, 0]);
  const tied = collectRivals({ name: 'notion', entities, suggestions: ['notion login', 'notion app', 'notion.so'] });
  assert.equal(tied[0].autocomplete, 2);
  assert.equal(tied[1].autocomplete, 0);
  // A site that redirects to another home of the name is the same rival.
  const redirected = collectRivals({ name: 'notion', sites: {
    com: { state: 'live', title: 'Notion – The all-in-one workspace', host: 'www.notion.com' },
    ai: { state: 'live', title: 'Your AI everything app', description: 'Notion AI', host: 'www.notion.com' },
    io: { state: 'live', title: 'Example portfolio', host: 'portfolio.example' },
  } });
  assert.deepEqual(redirected.map(row => [row.name, row.domains]), [['Notion', ['notion.com', 'notion.ai']]]);
  // A Wikipedia title must be the name itself, with at most a bracketed qualifier.
  assert.equal(collectRivals({ name: 'notion', entities: [{ name: 'Notion', brand: true, wikipedia: null }] })[0].wikipedia, null);
});

test('reads agent GEO per name and keeps it off unrelated homonyms', () => {
  assert.deepEqual(parseGeo('known: all-in-one notes workspace'), { known: true, text: 'all-in-one notes workspace' });
  assert.deepEqual(parseGeo('Known (travel booking startup)'), { known: true, text: 'travel booking startup' });
  assert.deepEqual(parseGeo('unknown'), { known: false });
  assert.equal(parseGeo('known'), null);
  assert.equal(parseGeo('maybe'), null);
  const entities = [{ name: 'Harbor', description: 'shipping logistics company', brand: true, wikipedia: null, website: [] }];
  const geo = parseGeo('known: payroll software for restaurants');
  const rivals = collectRivals({ name: 'harbor', input: 'Harbor', entities, geo });
  assert.deepEqual(rivals.map(row => [row.name, row.geo ?? null]), [['Harbor', null], ['Harbor', 'payroll software for restaurants']]);
  const judged = judgeRivals(rivals, new Map(), { now: now.getTime(), answered: { wikidata: true, apps: true }, geo, entities });
  assert.equal(judged.main.rival.geo, 'payroll software for restaurants');
  assert.equal(judged.geo, 'agent knows it: payroll software for restaurants');
  const matched = collectRivals({ name: 'harbor', entities, geo: parseGeo('known: logistics and shipping company') });
  assert.equal(matched.length, 1);
  assert.equal(matched[0].geo, 'logistics and shipping company');
  const unknown = judgeRivals(collectRivals({ name: 'harbor', entities }), new Map(),
    { now: now.getTime(), answered: { wikidata: true, apps: true }, geo: { known: false }, entities });
  assert.deepEqual(tractionSummary(unknown), { geo: 'agent: unknown' });
});

test('samples Common Crawl distinct URLs as a lower bound and keeps provider errors apart from zero', async t => {
  const directory = await directoryFor(t);
  const calls = {};
  const options = { directory, now: now.getTime(), fetcher: fetcherFor(calls), timeLeft: () => 8000 };
  assert.deepEqual(await crawlPages('notion.so', options), { pages: 1000, limited: true, crawl: 'CC-MAIN-2026-47' });
  assert.deepEqual(await crawlPages('seatfrog.example', options), { pages: 340, crawl: 'CC-MAIN-2026-47' });
  assert.deepEqual(await crawlPages('oakenroom.com', options), { pages: 0, crawl: 'CC-MAIN-2026-47' });
  assert.equal(await crawlPages('busy.example', options), undefined);
  // The crawl list is cached for seven days.
  assert.equal(calls['index.commoncrawl.org'], 5);
  const dupes = await crawlPages('dupes.example', { ...options, fetcher: async value => new URL(value).pathname === '/collinfo.json'
    ? Response.json(fixture.collinfo)
    : new Response(['https://dupes.example/a', 'http://www.dupes.example/a/', 'https://dupes.example/b']
      .map(url => JSON.stringify({ url })).join('\n')) });
  assert.equal(dupes.pages, 2);
});

test('downloads the Tranco list once, unzips it and looks up exact domains', async t => {
  const directory = await directoryFor(t);
  const csv = Buffer.from(fixture.tranco.replaceAll('\n', '\r\n'));
  const data = deflateRawSync(csv);
  const name = Buffer.from('top-1m.csv');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(csv.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(csv.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const centralOffset = local.length + name.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  const zip = Buffer.concat([local, name, data, central, name, end]);
  const urls = [];
  // Fewer than 1,000 rows is not a valid top list.
  const small = await refreshTranco({ directory, now, fetcher: async () => new Response(zip) });
  assert.equal(small.refreshed, false);
  const many = fixture.tranco + Array.from({ length: 1200 }, (_, index) => (index + 10_000) + ',filler' + index + '.example').join('\n') + '\n';
  const bigCsv = Buffer.from(many);
  const bigData = deflateRawSync(bigCsv);
  local.writeUInt32LE(bigData.length, 18);
  central.writeUInt32LE(bigData.length, 20);
  end.writeUInt32LE(local.length + name.length + bigData.length, 16);
  const bigZip = Buffer.concat([local, name, bigData, central, name, end]);
  const result = await refreshTranco({ directory, now, fetcher: async (value, init) => {
    urls.push(value);
    assert.equal(init.redirect, 'manual');
    return urls.length === 1 ? new Response(null, { status: 307, headers: { location: '/download/daily/top-1m.csv.zip?x=1' } })
      : new Response(bigZip);
  } });
  assert.equal(result.refreshed, true);
  assert.equal(urls[1], 'https://tranco-list.eu/download/daily/top-1m.csv.zip?x=1');
  const list = { text: '\n' + await readFile(new URL('tranco-top-1m.csv', directory), 'latin1') };
  assert.equal(trancoRank(list, 'notion.so'), 2097);
  assert.equal(trancoRank(list, 'google.com'), 1);
  assert.equal(trancoRank(list, 'otion.so'), null);
  assert.equal(trancoRank(list, 'oakenroom.com'), null);
  assert.equal(trancoRank(null, 'notion.so'), undefined);
  assert.equal(trancoRank({ text: '\n' + fixture.tranco.replaceAll('\n', '\r\n') }, 'notion.com'), 1309);
  const offHost = await refreshTranco({ directory, now, fetcher: async () =>
    new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/list.zip' } }) });
  assert.equal(offHost.refreshed, false);
});

test('recognizes registrar lander pages as parked and reads the copyright year', () => {
  const lander = '<!DOCTYPE html><html><head><script>window.onload=function(){window.location.href="/lander"}</script></head></html>';
  assert.deepEqual(classifyComSite({ url: 'https://routemender.com/', status: 200, contentType: 'text/html', body: lander }, true),
    { state: 'parked' });
  const page = '<html><head><title>Oldco</title></head><body><p>Welcome</p><footer>© 2015–2019 Oldco Ltd</footer></body></html>';
  assert.equal(classifyComSite({ url: 'https://oldco.com/', status: 200, contentType: 'text/html', body: page }, true).copyright, 2019);
});

test('fixtures: Notion is a Goliath, RouteMender AI stays clear with a note, OakenRoom needs a check', async t => {
  const { options, calls } = await setUp(t);
  const report = await triageNames(['Notion', 'RouteMender', 'OakenRoom'], options);
  const [notion, routemender, oakenroom] = report.names;

  assert.equal(notion.verdict, 'Avoid');
  assert.match(notion.reason, /^David vs Goliath: Notion at notion\.com \(Tranco #1,309, Wikipedia article\)/);
  assert.equal(notion.traction.level, 'strong');
  assert.deepEqual(notion.traction.signals, ['Tranco #1,309', 'Wikipedia article']);
  assert.equal(notion.traction.geo, 'stand-in Wikipedia/Wikidata: article Notion (productivity software)');
  assert.match(notion.reason, /Dormant: notion\.io \(parked\)/);
  assert.doesNotMatch(notion.reason, /Small same-name use: Notion\b/);

  // A same-name business with no visible traction never lowers the verdict.
  assert.equal(routemender.verdict, 'No conflict found');
  assert.equal(routemender.google.result, 'crowded');
  assert.equal(routemender.reason, 'No close US mark, app or site overlap · Small same-name use: RouteMender AI (no visible traction)'
    + ' · Dormant: routemender.com (parked)');
  assert.equal(routemender.traction, undefined);
  assert.ok(report.top.some(row => row.name === 'RouteMender'));

  assert.equal(oakenroom.verdict, 'Check first');
  assert.match(oakenroom.reason, /^Same-name use with some traction: OakenRoom at oakenroom\.com \(domain since 2012\)/);
  assert.deepEqual(oakenroom.traction, { rival: 'OakenRoom at oakenroom.com', level: 'some', signals: ['domain since 2012'],
    geo: 'stand-in Wikipedia/Wikidata: none' });
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 7200);

  // Same business with some traction is Avoid.
  const close = await triageNames(['OakenRoom'], { ...options, about: 'home renovation costs and improvement guides' });
  assert.equal(close.names[0].verdict, 'Avoid');
  assert.match(close.names[0].reason, /^Same-business rival with traction: OakenRoom at oakenroom\.com/);

  // Evidence is cached for seven days: no new Common Crawl or RDAP requests until then.
  const before = { crawl: calls['index.commoncrawl.org'], rdap: calls['rdap.example.test'] };
  await triageNames(['Notion', 'OakenRoom'], options);
  assert.equal(calls['index.commoncrawl.org'], before.crawl);
  const later = await triageNames(['OakenRoom'], { ...options, now: new Date(+now + 7 * day + 1) });
  assert.equal(calls['index.commoncrawl.org'], before.crawl + 2);
  assert.equal(later.names[0].verdict, 'Check first');

  // The agent's own recollection is per name; "unknown" keeps RouteMender clear.
  const withGeo = await triageNames(['Notion', 'RouteMender'], { ...options, compact: true,
    geo: { Notion: 'known: all-in-one notes and docs workspace', RouteMender: 'unknown' } });
  assert.equal(withGeo.names[0].traction.geo, 'agent knows it: all-in-one notes and docs workspace');
  assert.equal(withGeo.names[1].verdict, 'No conflict found');
  assert.deepEqual(withGeo.names[1].traction, { geo: 'agent: unknown' });
  assert.ok(Buffer.byteLength(JSON.stringify(withGeo)) < 6000);
});

test('without the Tranco list or Common Crawl, a live same-name site keeps the earlier check instead of reading as zero', async t => {
  const { options } = await setUp(t, { tranco: false });
  const fetcher = options.fetcher;
  const report = await triageNames(['OakenRoom'], { ...options, fetcher: async (value, init) => {
    const { hostname, pathname } = new URL(value);
    return hostname === 'index.commoncrawl.org' || pathname.endsWith('/oakenroom.com')
      ? new Response(null, { status: 503 }) : fetcher(value, init);
  } });
  assert.equal(report.names[0].verdict, 'Check first');
  assert.equal(report.names[0].reason, 'oakenroom.com has a live site under this name');
  assert.equal(report.names[0].traction, undefined);
});

test('keeps the 20-name compact output under its cap with traction evidence', async t => {
  const { options } = await setUp(t);
  const names = ['Notion', 'RouteMender', 'OakenRoom', ...Array.from({ length: 17 }, (_, index) => 'Quiet Wren ' + 'x'.repeat(index))];
  const report = await triageNames(names, { ...options, compact: true });
  assert.equal(report.names.length, 20);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 12_000, String(Buffer.byteLength(JSON.stringify(report))));
  assert.equal(report.names[0].verdict, 'Avoid');
  assert.equal(report.names[1].verdict, 'No conflict found');
});

test('the applet presence check labels the Wikipedia/Wikidata GEO stand-in', async t => {
  const { options } = await setUp(t);
  const result = await namePresence('Notion', options);
  assert.equal(result.traction.level, 'strong');
  assert.match(result.traction.rival, /^Notion at notion\.com$/);
  assert.equal(result.traction.geo, 'stand-in Wikipedia/Wikidata: article Notion (productivity software)');
  assert.equal(result.checks.length, 3);
  const clear = await namePresence('RouteMender', options);
  assert.equal(clear.traction, undefined);
  assert.deepEqual(clear.notes, ['Small same-name use: RouteMender AI (no visible traction)', 'Dormant: routemender.com (parked)']);
  const some = await namePresence('OakenRoom', options);
  assert.equal(some.traction.level, 'some');
  assert.match(some.traction.rival, /oakenroom\.com$/);
});
