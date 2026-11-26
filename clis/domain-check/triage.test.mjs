import '../../test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { writeCache } from './cache.mjs';
import { withSocial } from '../../test-support/social-fixture.mjs';
import { resetHandleRuns } from './handles.mjs';
import { classifyComSite } from './com-site.mjs';
import { loadEdgarCompanies, matchEdgarCompanies, searchNorwegianCompanies } from './company-search.mjs';
import { readPlayCards, readPlayDetails, searchAndroidApps } from './google-play.mjs';
import { checkHandles, matchTier, searchApps, searchEntities, searchMarks } from './triage-sources.mjs';
import { memorability, namePresence, triageNames } from './triage.mjs';
import { qualityRank } from './name-search.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/triage.json', import.meta.url), 'utf8'));
const companies = JSON.parse(readFileSync(new URL('./fixtures/company-names.json', import.meta.url), 'utf8'));
const now = new Date('2026-11-24T12:00:00Z');
const noCompanies = { page: { totalPages: 0 } };
const wikiSoftware = { entities: { Q123456789: { claims: {
  P31: [{ mainsnak: { datavalue: { value: { id: 'Q7397' } } } }],
} } } };

function playBrowser(rows, onSearch = () => {}, details = '') {
  return async () => ({
    async newContext() {
      return { async newPage() {
        let url;
        return {
          context: () => ({}),
          goto: async value => {
            url = value;
            onSearch(new URL(value));
            return { ok: () => true };
          },
          url: () => url,
          waitForFunction: async () => ({ jsonValue: async () => rows }),
          request: { get: async () => ({
            ok: () => true, text: async () => details, dispose: async () => {},
          }) },
          close: async () => {},
        };
      } };
    },
    close: async () => {},
  });
}

async function directoryFor(t) {
  const path = await mkdtemp(join(tmpdir(), 'hound-triage-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return new URL('./', pathToFileURL(path + '/'));
}

test('searches glued and split phrases plus fuzzy marks, keeps live close matches and flags key classes', async () => {
  const marks = await searchMarks('cloudotter', 'CloudOtter', { fetcher: async (url, init) => {
    assert.equal(url, 'https://tmsearch.uspto.gov/prod-stage-v1-0-0/tmsearch');
    assert.equal(init.method, 'POST');
    const { query: { bool } } = JSON.parse(init.body);
    assert.deepEqual(bool.filter, [{ term: { alive: true } }]);
    const nameQueries = bool.must[0].bool.should;
    assert.ok(nameQueries.some(item => item.match_phrase?.wordmark.query === 'cloudotter'));
    assert.ok(nameQueries.some(item => item.match_phrase?.wordmark.query === 'cloud otter'));
    assert.equal(nameQueries.at(-1).fuzzy.wordmark.fuzziness, 1);
    return Response.json(fixture.marks);
  } });
  assert.deepEqual(marks.map(mark => [mark.name, mark.tier, mark.relevant]), [
    ['CLOUD OTTER', 'Exact', true], ['CLOUD OTTERS', 'Near-identical', false],
  ]);
  assert.equal(marks[0].owner, 'Example Tools Inc.');
  assert.deepEqual(marks[0].classes, ['009', '042']);
  assert.equal(await searchMarks('cloudotter', 'Cloud Otter', {
    fetcher: async () => Response.json({ hits: { hits: [] }, timedOut: true }),
  }), null);
});

test('maps every category and distinguishes the travel lookalikes from near-identical spellings', async () => {
  const categories = { travel: ['039', '043'], software: ['009', '035', '042'], finance: ['036'], retail: ['035'],
    health: ['044'], education: ['041'], food: ['043', '030'], media: ['038', '041'], other: ['009', '035', '042'] };
  for (const [category, classes] of Object.entries(categories)) {
    const [row] = await searchMarks('testbrand', 'TestBrand', { category, fetcher: async (_, { body }) => {
      const { query: { bool } } = JSON.parse(body);
      assert.deepEqual(bool.should[0].terms.internationalClass, classes.map(code => 'IC ' + code));
      return Response.json({ hits: { hits: [{ source: {
        alive: true, wordmark: 'Test Brand', ownerName: ['Example Inc.'], internationalClass: ['IC ' + classes[0]],
      } }] } });
    } });
    assert.equal(row.tier, 'Exact');
    assert.ok(row.relevant);
  }
  for (const [candidate, mark] of [
    ['framway', 'franway'], ['landwell', 'landbell'], ['pointsman', 'pointman'],
    ['farewise', 'farmwise'], ['seatwise', 'seawise'],
  ]) assert.equal(matchTier(candidate, mark), 'Fuzzy');
  for (const [candidate, mark] of [
    ['styrman', 'starman'], ['cloudoter', 'cloudotter'], ['cloudotter', 'cloudotters'], ['cherry', 'cherries'],
  ]) assert.equal(matchTier(candidate, mark), 'Near-identical');
});

test('finds exact App Store names and Wikidata labels without accepting similar names', async () => {
  const fetcher = async value => {
    const url = new URL(value);
    if (url.searchParams.get('action') === 'wbgetentities') {
      assert.equal(url.searchParams.get('ids'), 'Q123456789');
      return Response.json(wikiSoftware);
    }
    assert.equal(url.searchParams.get('term') ?? url.searchParams.get('search'), 'Cloud Otter');
    return Response.json(url.hostname === 'itunes.apple.com' ? fixture.apps : fixture.wikidata);
  };
  const apps = await searchApps('cloudotter', 'Cloud Otter', { fetcher });
  const entities = await searchEntities('cloudotter', 'Cloud Otter', { fetcher });
  assert.deepEqual(apps.map(app => app.name), ['Cloud Otter: Deployments']);
  assert.equal(apps[0].url, 'https://apps.apple.com/us/app/id1012345');
  assert.equal(apps[0].seller, 'Example Tools Incorporated');
  assert.equal(apps[0].ratings, 418);
  assert.equal(entities.length, 1);
  assert.equal(entities[0].url, 'https://www.wikidata.org/wiki/Q123456789');
  assert.equal(entities[0].brand, true);
  const subtyped = await searchEntities('cloudotter', 'Cloud Otter', { fetcher: async value => {
    const query = new URL(value).searchParams;
    const claim = id => [{ mainsnak: { datavalue: { value: { id } } } }];
    if (query.get('ids') === 'Q123456789') return Response.json({ entities: {
      Q123456789: { claims: { P31: claim('Q123456791') } },
    } });
    if (query.get('ids') === 'Q123456791') return Response.json({ entities: {
      Q123456791: { claims: { P279: claim('Q166142') } },
    } });
    return Response.json(fixture.wikidata);
  } });
  assert.equal(subtyped[0].brand, true);
});

test('applet presence returns all three checks and direct searches with no Google credentials', async t => {
  const result = await namePresence('cloudotter', {
    directory: await directoryFor(t), env: {}, launch: playBrowser([]), comSite: async () => ({ state: 'no-site' }),
    fetcher: async value => {
      const { hostname } = new URL(value);
      if (hostname === 'www.google.com') return Response.json(['cloudotter', ['cloudotter app']]);
      if (hostname === 'trends.google.com') return Response.json({ default: { topics: [] } });
      if (hostname === 'www.wikidata.org') return Response.json({ search: [] });
      assert.equal(hostname, 'itunes.apple.com');
      return Response.json(fixture.apps);
    },
  });
  assert.deepEqual(result.checks.map(({ label }) => label), ['Google', 'App Store (iOS)', 'Google Play (Android)']);
  assert.equal(result.checks[0].text, 'crowded');
  assert.match(result.checks[1].text, /Cloud Otter/);
  assert.equal(result.checks[2].text, 'Google Play has no public search');
  assert.equal(result.checks[2].linkLabel, 'Search Google Play');
  for (const row of result.checks) assert.match(row.link, /^https:/);
});

test('GitHub and npm same-name evidence comes from their public APIs; the repo search still adds repositories', async t => {
  const directory = await directoryFor(t);
  resetHandleRuns();
  const calls = [];
  let limited = false;
  const fetcher = withSocial(async url => {
    const { hostname: host, pathname, searchParams } = new URL(url);
    calls.push(host);
    assert.equal(host, 'api.github.com');
    assert.equal(pathname, '/search/repositories');
    assert.match(searchParams.get('q'), /^"[a-z]+" in:name$/);
    return Response.json(limited ? fixture.github.limited : fixture.github.taken, {
      status: limited ? 403 : 200, headers: { 'x-ratelimit-reset': String((+now + 180_000) / 1000) },
    });
  }, { taken: ['cloudotter'] });
  const options = { directory, now, fetcher };
  const { github, handles } = await checkHandles('cloudotter', options);
  assert.deepEqual(handles, { GitHub: 'taken', npm: 'taken' });
  assert.deepEqual(github, {
    status: 'taken', ownerType: 'Organization', count: 2,
    examples: ['cloudotter/CloudOtter', 'devstudio/cloudotter'], partial: false,
  });
  // The repository search is reused for a day.
  calls.length = 0;
  await checkHandles('cloudotter', { ...options, now: new Date(+now + 86_399_999) });
  assert.deepEqual(calls, []);
  await checkHandles('cloudotter', { ...options, now: new Date(+now + 86_400_000) });
  assert.equal(calls.filter(host => host === 'api.github.com').length, 1);
  // A rate-limited repository search keeps the account answer from the users API.
  calls.length = 0;
  limited = true;
  const [a, b] = await Promise.all([checkHandles('newotter', options), checkHandles('spareotter', options)]);
  assert.equal(a.handles.GitHub, 'not-found');
  assert.equal(b.handles.GitHub, 'not-found');
  assert.equal(calls.filter(host => host === 'api.github.com').length, 1);
});

test('triages live rivals, live trademarks and clear names with a low-price registry candidate', async t => {
  const directory = await directoryFor(t);
  const catalog = {
    checkedAt: now.toISOString(), catalogs: {
      dynadot: { checkedAt: now.toISOString(), prices: {
        com: { shop: 'Dynadot', firstYear: 9, renewal: 11 },
        me: { shop: 'Dynadot', firstYear: 9, renewal: 15 },
        io: { shop: 'Dynadot', firstYear: 30, renewal: 50 },
        dev: { shop: 'Dynadot', firstYear: 8, renewal: 16 },
        co: { shop: 'Dynadot', firstYear: 4, renewal: 30 },
        ai: { shop: 'Dynadot', firstYear: 80, renewal: 85 },
      } },
    },
  };
  await writeCache(directory, 'prices.json', catalog);
  const options = {
    // This catalog lists only some endings; the bundled snapshot stays out so the others have no price.
    directory, now, env: {}, cachedOnly: true, bundledCatalog: null, about: 'find and buy domains for AI builders',
    endings: ['com', 'ai', 'io', 'dev', 'co', 'me', 'no', 'app'],
    launch: playBrowser([]),
    resolveNs: async domain => (/\.(com|io|app)$/.test(domain) || domain === 'domainsparrow.dev') ? ['ns.example.test'] : [],
    comSite: async domain => domain === 'domainsparrow.dev'
      ? { state: 'live', title: 'Domain Sparrow: Domain Name Checker' }
      : domain === 'cloudotter.app' ? { state: 'live', title: 'Cloud Otter' }
        : domain.endsWith('.io') ? { state: 'parked' } : { state: 'no-site' },
    fetcher: withSocial(async (value, init) => {
      const url = new URL(value);
      if (url.hostname === 'data.iana.org') return Response.json({
        services: [[['com', 'ai', 'io', 'dev', 'app', 'co', 'si'], ['https://rdap.example.test/']]],
      });
      if (url.hostname === 'tmsearch.uspto.gov') return Response.json(init.body.includes('cloudotter')
        ? fixture.marks : { hits: { hits: [] } });
      if (url.hostname === 'itunes.apple.com') return Response.json(url.searchParams.get('term') === 'Cloud Otter'
        ? fixture.apps : { results: [] });
      if (url.hostname === 'www.wikidata.org') {
        if (url.searchParams.get('action') === 'wbgetentities') return Response.json(wikiSoftware);
        return Response.json(url.searchParams.get('search') === 'Cloud Otter' ? fixture.wikidata : { search: [] });
      }
      if (url.hostname === 'api.github.com') return Response.json(fixture.github.missing);
      if (url.hostname === 'data.brreg.no') return Response.json(noCompanies);
      if (url.hostname === 'www.sec.gov') return Response.json(companies.edgar);
      if (url.hostname === 'www.google.com') return Response.json([url.searchParams.get('q'), []]);
      if (url.hostname === 'trends.google.com') return Response.json({ default: { topics: [] } });
      return new Response(null, { status: 404 });
    }),
  };
  const report = await triageNames(['Domain Sparrow', 'Cloud Otter', 'DappleBear'], options);
  const [rival, brand, clear] = report.names;
  assert.equal(rival.verdict, 'Check first');
  assert.deepEqual(rival.competition.sameName.sites, [{
    domain: 'domainsparrow.dev', title: 'Domain Sparrow: Domain Name Checker', business: 'domains', sameBusiness: true,
  }]);
  assert.equal(rival.details.sites.io, 'Taken, parked');
  assert.equal(brand.verdict, 'Avoid');
  assert.match(brand.competition.US, /Example Tools Inc\.?.*009\/042/);
  assert.equal(brand.competition.sameName.level, 'crowded');
  assert.match(brand.competition.sameName.summary, /2 EDGAR-listed companies/);
  assert.equal(clear.verdict, 'No conflict found');
  assert.equal(clear.details.appName, 'App name: free on iOS');
  // Free endings follow the quality order (0.1.8): .ai first, but never the default pick.
  assert.equal(clear.free[0], 'ai');
  assert.match(report.eligibility.no, /Norwegian/);
  // Best value is the lowest three-year total: .me $9 + 2 × $15 = $39 beats .dev $8 + 2 × $16 = $40 and .co $64.
  assert.equal(clear.bestValue, 'me');
  assert.equal(rival.bestValue, 'me');
  // The pick is the best quality within $60 over 3 years: .dev ($40). .co renews at $30 ($64) and .ai is never the default.
  assert.deepEqual(report.top[0], { name: 'DappleBear', verdict: 'No conflict found', reason: clear.reason,
    domain: 'dapplebear.dev', ending: 'dev', now: 8, renew: 16, term: 1,
    bestValue: { domain: 'dapplebear.me', now: 9, renew: 15, term: 1, y3: 39 } });
  // Best value is always named, also when it is the cheapest ending itself.
  for (const [endings, value] of [[['co', 'si'], 'co'], [['dev', 'me'], 'me']]) {
    const single = await triageNames(['DappleBear'], { ...options, endings });
    assert.equal(single.names[0].bestValue, value);
    if (value === 'co') assert.deepEqual(single.top, []); // The known 3-year price is over $60.
    else assert.equal(single.top[0].bestValue.domain, 'dapplebear.' + value);
  }
  assert.equal(report.top.length, 1); // Domain Sparrow exceeds 12 letters.
  const withNorway = structuredClone(catalog);
  withNorway.catalogs.dynadot.prices.no = { shop: 'Dynadot', firstYear: 2, renewal: 2 };
  await writeCache(directory, 'prices.json', withNorway);
  const defaultBuyer = await triageNames(['DappleBear'], options);
  assert.equal(defaultBuyer.names[0].free[0], 'ai');
  assert.ok(defaultBuyer.names[0].free.includes('no'));
  assert.equal(defaultBuyer.top[0].domain, 'dapplebear.dev');
  assert.equal(defaultBuyer.names[0].bestValue, 'me');
  const onlyAi = await triageNames(['DappleBear'], { ...options, endings: ['ai'] });
  assert.deepEqual(onlyAi.names[0].free, ['ai']);
  assert.deepEqual(onlyAi.top, []);
  const budgetedAi = await triageNames(['DappleBear'], { ...options, endings: ['ai'], upfrontCap: 500 });
  assert.deepEqual(budgetedAi.top, []);
  assert.match(budgetedAi.names[0].score.filtered, /within \$60\.00 over 3 years/);
  // An eligibility opt-in puts .no right after .com, so it becomes the pick within $60.
  const eligible = await triageNames(['DappleBear'], { ...options, eligible: ['no'] });
  assert.equal(eligible.top[0].domain, 'dapplebear.no');
  assert.equal(eligible.names[0].bestValue, 'no');
  await writeCache(directory, 'prices.json', catalog);
  const withGoogle = await triageNames(['Domain Sparrow', 'Cloud Otter', 'DappleBear'], {
    ...options,
    env: { DOMAIN_HOUND_BRAVE_SEARCH_KEY: 'fixture-key' },
    fetcher: (value, init) => {
      const url = new URL(value);
      if (url.hostname !== 'api.search.brave.com') return options.fetcher(value, init);
      const results = url.searchParams.get('q').includes('DappleBear')
        ? [{ title: 'DappleBear – Find and buy domains', url: 'https://dapplebear.example/' }] : [];
      return Response.json({ web: { results } });
    },
  });
  assert.equal(withGoogle.names[2].google.result, 'owned by DappleBear');
  assert.equal(withGoogle.names[2].verdict, 'Avoid');
  assert.match(withGoogle.names[2].reason, /Google: owned by DappleBear/);
  assert.equal(withGoogle.names.filter(row => row.google.search).length, 3);
  assert.ok(withGoogle.top.every(row => row.name !== 'DappleBear'));
  assert.equal(withGoogle.sources.Google, 100);

  assert.equal(report.prices.ai.renew, 170);
  assert.deepEqual(Object.keys(report.trademarkSearches), ['US', 'EU', 'WIPO', 'Norway']);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < 6000, String(Buffer.byteLength(JSON.stringify(report))));
  assert.match(memorability('cloud-otter5', 'Cloud-Otter5'), /hyphen or digit/);
  assert.match(memorability('simple', 'Simple'), /6 letters \(short\), ~2 syllables/);
  const travel = await triageNames(['Seatwise', 'Tripdesk', 'Wanderbed'], {
    ...options, category: 'travel', about: 'AI travel assistant that books and manages trips',
    comSite: async domain => {
      if (domain === 'seatwise.com') return { state: 'live', title: 'Seatwise | Smarter Flight Decisions',
        description: 'Seatwise compares estimated total trip costs before booking.' };
      if (domain === 'tripdesk.com') return { state: 'live', title: 'Tripdesk | Travel Assistant',
        description: 'Book flights and manage your upcoming trips with Tripdesk.' };
      return { state: 'no-site' };
    },
    fetcher: async (value, init) => {
      if (new URL(value).hostname !== 'tmsearch.uspto.gov') return options.fetcher(value, init);
      const mark = (wordmark, classes) => ({ source: { alive: true, wordmark, ownerName: ['Example Tools Inc.'],
        internationalClass: classes.map(code => 'IC ' + code) } });
      const name = JSON.parse(init.body).query.bool.must[0].bool.should[0].match_phrase.wordmark.query;
      return Response.json({ hits: { hits: name === 'seatwise' ? [mark('SEAWISE', ['039', '042'])]
        : name === 'wanderbed' ? [mark('WANDERBAD', ['043'])] : [] } });
    },
  });
  assert.equal(travel.names[0].verdict, 'Check first');
  assert.match(travel.names[0].reason, /^Fuzzy: SEAWISE \(Example Tools Inc\., 039\/042\)/);
  assert.equal(travel.names[1].verdict, 'Avoid');
  assert.match(travel.names[1].reason, /live business in the same category/);
  assert.equal(travel.names[2].verdict, 'Avoid');
  assert.match(travel.names[2].reason, /^Near-identical: WANDERBAD .*043/);
  assert.deepEqual(travel.top.map(row => row.name), ['Seatwise']);
  const active = await triageNames(['Cloud Otter'], { ...options, about: 'deploy apps to cloud hosting' });
  assert.equal(active.names[0].verdict, 'Avoid');
  assert.match(active.names[0].reason, /^Same-business rival with traction: Cloud Otter \(418 iOS ratings\)/);
  const siteRisk = await triageNames(['Domain Sparrow'], {
    ...options, resolveNs: async domain => domain.endsWith('.ai') ? ['ns.example.test'] : [],
    comSite: async () => ({ state: 'live', title: 'Domain Sparrow', description: 'A domain name checker' }),
  });
  assert.equal(siteRisk.names[0].verdict, 'Avoid');
  assert.match(siteRisk.names[0].reason, /domainsparrow\.ai.*same category/);
  const some = await triageNames(['Cloud Otter'], {
    ...options,
    comSite: async () => ({ state: 'no-site' }),
    fetcher: async (value, init) => {
      const { hostname } = new URL(value);
      if (hostname === 'tmsearch.uspto.gov') return Response.json({ hits: { hits: [] } });
      if (hostname === 'itunes.apple.com') return Response.json({ results: [] });
      if (hostname === 'www.wikidata.org') return Response.json({ search: [] });
      return options.fetcher(value, init);
    },
  });
  assert.equal(some.names[0].competition.sameName.level, 'some');
  assert.equal(some.names[0].verdict, 'Check first');
  const withoutMarksOrApps = async (value, init) => {
    const { hostname } = new URL(value);
    if (hostname === 'tmsearch.uspto.gov') return Response.json({ hits: { hits: [] } });
    if (hostname === 'itunes.apple.com') return Response.json({ results: [] });
    return options.fetcher(value, init);
  };
  await rm(new URL('traction-ios-cloudotter.json', directory), { force: true });
  const known = await triageNames(['Cloud Otter'], { ...options, fetcher: withoutMarksOrApps });
  // A Wikidata company with no article, website, app or autocomplete depth is a small same-name use, not a blocker.
  assert.doesNotMatch(known.names[0].reason, /company or product in Wikidata/);
  assert.match(known.names[0].reason, / · Small same-name use: Cloud Otter \(no visible traction\)/);
  const crowded = await triageNames(['Cloud Otter'], {
    ...options, fetcher: async (value, init) => {
      const { hostname, searchParams } = new URL(value);
      if (hostname === 'www.wikidata.org' && searchParams.get('action') === 'wbgetentities') return Response.json({});
      if (hostname === 'api.github.com' && !value.includes('/users/')) return Response.json(fixture.github.taken);
      return withoutMarksOrApps(value, init);
    },
  });
  assert.equal(crowded.names[0].competition.sameName.level, 'crowded');
  assert.equal(crowded.names[0].verdict, 'Check first');
  const nearMark = await triageNames(['Cloud Otter'], {
    ...options, category: 'retail', fetcher: async (value, init) => new URL(value).hostname === 'tmsearch.uspto.gov'
      ? Response.json({ hits: { hits: [{ source: { ...fixture.marks.hits.hits[1].source, internationalClass: ['IC 035'] } }] } })
      : withoutMarksOrApps(value, init),
  });
  assert.equal(nearMark.names[0].verdict, 'Avoid');
  assert.match(nearMark.names[0].reason, /^Near-identical: CLOUD OTTERS .*035/);
  let playRequests = 0;
  const unchecked = await triageNames(['Moss Finch'], {
    ...options,
    fetcher: (value, init) => {
      if (new URL(value).hostname === 'play.google.com') playRequests++;
      return options.fetcher(value, init);
    },
  });
  assert.equal(playRequests, 0);
  assert.equal(unchecked.names[0].competition.GooglePlay, null);
  assert.equal(new URL(unchecked.names[0].details.AndroidSearch).searchParams.get('q'), 'Moss Finch');
  assert.equal(unchecked.sources['Google Play'], undefined);
  assert.deepEqual(unchecked.names[0].checks, [
    'Google: open · https://www.google.com/search?q=%22Moss+Finch%22',
    'App Store (iOS): no exact-name app · https://apps.apple.com/us/iphone/search?term=Moss+Finch',
    'Google Play has no public search · Search Google Play · https://play.google.com/store/search?q=Moss+Finch&c=apps&hl=en&gl=US',
  ]);
  assert.equal(unchecked.sources.Google, 100);
  assert.equal(unchecked.names[0].google.search, true);
  const invalid = await triageNames(Array(21).fill('DappleBear'), options);
  assert.match(invalid.error, /1 to 20/);

  const compact = await triageNames(['Domain Sparrow', 'Cloud Otter', 'DappleBear'], { ...options, compact: true });
  assert.deepEqual(Object.keys(compact), ['top', 'names', 'prices', 'sources', 'eligibility', 'handles']);
  assert.deepEqual(compact.prices.co, { now: 4, renew: 30, jump: true, shop: 'Dynadot' });
  assert.deepEqual(compact.prices.ai, { now: 160, renew: 170, term: 2, shop: 'Dynadot' });
  const [compactRival, compactBrand, compactClear] = compact.names;
  assert.equal(compactClear.name, 'DappleBear');
  assert.equal(compactClear.verdict, clear.verdict);
  assert.equal(compactClear.reason, clear.reason);
  // Free endings follow the quality order; the checkout link goes to the pick (.dev), not the cheapest first year (.co).
  assert.equal(compactClear.free[0], 'ai');
  const ranks = compactClear.free.map(ending => qualityRank('x.' + ending));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.equal(compactClear.buy, 'https://www.dynadot.com/domain/search?domain=dapplebear.dev');
  assert.ok(compactClear.taken.includes('com'));
  assert.equal(compact.prices.si, undefined);
  assert.equal(compactBrand.verdict, 'Avoid');
  assert.match(compactBrand.competition.US, /^Exact: CLOUD OTTER \(Example Tools Inc/);
  assert.equal(compactRival.competition.sameName.sites[0].domain, 'domainsparrow.dev');
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < 6000);
  const twenty = Array.from({ length: 20 }, (_, index) => 'Cloud Otter ' + 'x'.repeat(index));
  const five = await triageNames(twenty.slice(0, 5), { ...options, compact: true });
  const all = await triageNames(twenty, { ...options, compact: true });
  assert.equal(five.names.length, 5);
  assert.equal(all.names.length, 20);
  assert.ok(Buffer.byteLength(JSON.stringify(five)) <= 6000);
  assert.ok(Buffer.byteLength(JSON.stringify(all)) <= 12_000, String(Buffer.byteLength(JSON.stringify(all))));
  assert.ok(all.names.every(row => new URL(row.google.link).hostname === "www.google.com"));
  assert.ok(all.names.every(row => row.verdict && row.reason));
  for (const row of [...all.names, ...compact.names, ...unchecked.names]) {
    // traction is present only for a rival with traction or an agent GEO answer; meaning only for a rude word
    // ("Cloud Otter xxx"); score only for the first five names, and only while the size cap leaves room.
    const fields = value => Object.keys(value).filter(key => !['traction', 'meaning', 'score'].includes(key)).sort();
    assert.deepEqual(fields(row), fields(clear));
    assert.deepEqual(Object.keys(row.competition).sort(), Object.keys(clear.competition).sort());
    assert.ok(Array.isArray(row.free) && Array.isArray(row.taken));
  }
});

test('retries an unavailable triage source once and names it in the reason when it stays silent', async t => {
  const social = withSocial();
  const make = async (failures, calls) => ({
    directory: await directoryFor(t), now, cachedOnly: true, launch: playBrowser([]),
    resolveNs: async domain => domain.endsWith('.com') ? ['ns.example.test'] : [],
    comSite: async () => ({ state: 'no-site' }),
    fetcher: async (value, init) => {
      const url = new URL(value);
      calls[url.hostname] = (calls[url.hostname] ?? 0) + 1;
      if (url.hostname === 'data.iana.org') return Response.json({ services: [[['com', 'ai', 'io', 'dev', 'app', 'co', 'si'], ['https://rdap.example.test/']]] });
      if (url.hostname === 'tmsearch.uspto.gov') return calls[url.hostname] <= failures.uspto
        ? new Response(null, { status: 503 }) : Response.json({ hits: { hits: [] } });
      if (url.hostname === 'itunes.apple.com') return Response.json({ results: [] });
      if (url.hostname === 'www.wikidata.org') {
        assert.match(init.headers['User-Agent'], /DomainHound\/.*https:\/\/domainhound\.dev/);
        return calls[url.hostname] <= (failures.wikidata ?? 0)
          ? new Response(null, { status: 503 }) : Response.json({ search: [] });
      }
      // The GitHub users API fails the given number of times for this name, then answers.
      if (url.pathname === '/users/quietwren') {
        calls.users = (calls.users ?? 0) + 1;
        return calls.users <= failures.github ? new Response(null, { status: 500 })
          : Response.json({ message: 'Not Found' }, { status: 404 });
      }
      if (url.hostname === 'api.github.com' && url.pathname.startsWith('/users/')) return social(value, init);
      if (url.hostname === 'registry.npmjs.org') return social(value, init);
      if (url.hostname === 'api.github.com') return Response.json(fixture.github.missing);
      if (url.hostname === 'data.brreg.no') return Response.json(noCompanies);
      if (url.hostname === 'www.sec.gov') return Response.json(companies.edgar);
      return new Response(null, { status: 404 });
    },
  });
  const recoveredCalls = {};
  const recovered = await triageNames(['Quiet Wren'], await make({ uspto: 1, github: 1, wikidata: 1 }, recoveredCalls));
  assert.equal(recoveredCalls['tmsearch.uspto.gov'], 2);
  assert.equal(recoveredCalls.users, 2);
  assert.equal(recoveredCalls['www.wikidata.org'], 2);
  assert.equal(recovered.sources.Wikidata, 100);
  assert.equal(recovered.names[0].verdict, 'No conflict found');
  const silentCalls = {};
  const silent = await triageNames(['Quiet Wren'], { ...await make({ uspto: 0, github: Infinity }, silentCalls), compact: true });
  assert.equal(silentCalls.users, 2);
  assert.equal(silent.sources.GitHub, 0);
  assert.equal(silent.names[0].verdict, 'Check first');
  assert.equal(silent.names[0].reason, 'GitHub did not answer');
});

test('retries missing Google Play searches once in the same browser', async () => {
  const counts = new Map();
  let browsers = 0;
  const emptyBrowser = playBrowser([], url => {
    const name = url.searchParams.get('q');
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (name === 'cloudotter' && counts.get(name) === 1 || name === 'willowsail') throw Error('fixture timeout');
  });
  const names = new Map(['cloudotter', 'willowsail', 'softsparrow'].map(name => [name, name]));
  const results = await searchAndroidApps(names, {
    directory: null, playBudgetMs: 500, launch: async () => { browsers++; return emptyBrowser(); },
  });
  assert.equal(browsers, 1);
  assert.deepEqual(Object.fromEntries(counts), { cloudotter: 2, willowsail: 2, softsparrow: 1 });
  assert.deepEqual([...results.keys()].sort(), ['cloudotter', 'softsparrow']);
});

test('counts Google Play rating evidence only for the matched package', async () => {
  const id = 'test.example.cloudotter';
  const url = 'https://play.google.com/store/apps/details?id=' + id;
  const html = '<script type="application/ld+json">' + JSON.stringify({
    '@type': 'SoftwareApplication', url, aggregateRating: { ratingCount: '120' },
    applicationCategory: 'PRODUCTIVITY', description: 'Cloud hosting and deployments',
  }) + '</script>';
  assert.deepEqual(readPlayDetails(html, url), {
    ratings: 120, category: 'PRODUCTIVITY', description: 'Cloud hosting and deployments',
  });
  assert.deepEqual(readPlayDetails(html, url + '.other'), { ratings: null });
  const names = new Map([['cloudotter', 'Cloud Otter']]);
  const matches = await searchAndroidApps(names, {
    directory: null, launch: playBrowser([{ id, name: 'Cloud Otter: Deployments', seller: 'Example Tools' }], undefined, html),
  });
  assert.equal(matches.get('cloudotter')[0].ratings, 120);
});

test('filters closed companies, keeps near matches, and caches the shared EDGAR list', async t => {
  const directory = await directoryFor(t);
  let edgarCalls = 0;
  const options = { directory, now, fetcher: async value => {
    const url = new URL(value);
    if (url.hostname === 'www.sec.gov') {
      edgarCalls++;
      return Response.json(companies.edgar);
    }
    assert.equal(url.searchParams.get('navn'), 'Cloud Otter');
    assert.equal(url.searchParams.get('konkurs'), 'false');
    return Response.json(companies.brreg);
  } };
  const norway = await searchNorwegianCompanies('cloudotter', 'Cloud Otter', options);
  assert.deepEqual(norway.matches.map(row => [row.name, row.match]), [
    ['CLOUD OTTER AS', 'exact'], ['CLOUD OTTERS AS', 'near'],
  ]);
  assert.equal(norway.matches[0].url, 'https://virksomhet.brreg.no/nb/oppslag/enheter/900000001');
  const listed = await loadEdgarCompanies(options);
  assert.deepEqual(matchEdgarCompanies('cloudotter', listed).matches.map(row => [row.name, row.match]), [
    ['CloudOtter, Inc.', 'exact'], ['CLOUD OTTER LABS CORP', 'near'],
  ]);
  assert.deepEqual(await loadEdgarCompanies(options), listed);
  assert.equal(edgarCalls, 1);
});

test('reads Google Play card titles and developers from HTML and recognizes an empty search', async t => {
  let chromium;
  try { ({ chromium } = await import(process.env.DOMAIN_HOUND_PLAYWRIGHT || 'playwright')); }
  catch { return t.skip('Install optional Playwright to run the HTML fixture in Chromium'); }
  const browser = await chromium.launch({ headless: true }).catch(() => null);
  if (!browser) return t.skip('Install the Playwright Chromium browser to run the HTML fixture');
  t.after(() => browser.close());
  const page = await browser.newPage();
  const html = readFileSync(new URL('./fixtures/google-play.html', import.meta.url), 'utf8')
    .replace('<body>', '<head><base href="https://play.google.com/"></head><body>');
  await page.setContent(html);
  const expected = [
    { name: 'Cloud Otter: Deployments', seller: 'Example Tools Inc.', id: 'test.example.cloudotter' },
    { name: 'Cloud Otter', seller: 'Example Studio', id: 'test.example.cloudotter.second' },
    { name: 'Cloud Otter School', seller: 'Example School', id: 'test.example.cloudotter.school' },
  ];
  assert.deepEqual(await page.evaluate(readPlayCards, 'Cloud Otter'), expected);
  await page.setContent(html.replace('<body>', '<body><div><span>No results for <b>Cloud Otter</b></span></div>'));
  assert.deepEqual(await page.evaluate(readPlayCards, 'Cloud Otter'), []);
  await page.setContent('<h1>Something went wrong</h1>');
  assert.equal(await page.evaluate(readPlayCards, 'Cloud Otter'), null);

  const directory = await directoryFor(t);
  let searches = 0;
  const options = { directory, now, launch: playBrowser(expected, url => {
    assert.equal(url.searchParams.get('q'), 'Cloud Otter');
    assert.equal(url.searchParams.get('c'), 'apps');
    searches++;
  }) };
  const names = new Map([['cloudotter', 'Cloud Otter']]);
  const apps = (await searchAndroidApps(names, options)).get('cloudotter');
  assert.deepEqual(apps.map(app => app.name), expected.map(app => app.name));
  await searchAndroidApps(names, { ...options, now: new Date(+now + 86_399_999) });
  assert.equal(searches, 1);
  await searchAndroidApps(names, { ...options, now: new Date(+now + 86_400_000) });
  assert.equal(searches, 2);
});

test('collects site metadata in triage and recognizes titled parking pages', () => {
  const page = { url: 'https://example.dev/', status: 200, contentType: 'text/html' };
  assert.deepEqual(classifyComSite({ ...page,
    body: '<title>Example</title><meta content="Developer tools &amp; deployment" name="description">' }, true), {
    state: 'live', title: 'Example', description: 'Developer tools & deployment', host: 'example.dev',
  });
  assert.deepEqual(classifyComSite({ ...page, body: '<title>Parking Page</title>' }, true), { state: 'parked' });
});

test('reuses only recent conclusive registration evidence for the rate-limited endings', async t => {
  const directory = await directoryFor(t);
  const { lookupRegistrations } = await import('./registry.mjs');
  const names = [{ domain: 'cloudotter.io', tld: 'io' }];
  let calls = 0;
  const options = {
    directory, now, resolveNs: async () => [],
    fetcher: async () => new Response(null, { status: ++calls === 1 ? 404 : 200 }),
  };
  assert.equal((await lookupRegistrations(names, options))[0].status, 'free');
  const cached = (await lookupRegistrations(names, { ...options, now: new Date(+now + 2000) }))[0];
  assert.deepEqual(cached, { status: 'free', source: 'rdap', checkedAt: now.toISOString() });
  assert.equal(calls, 1);
  assert.equal((await lookupRegistrations(names, { ...options, dnsFirst: false }))[0].status, 'taken');
  // A free answer is reused for an hour; then the registry is asked again.
  assert.equal((await lookupRegistrations(names, { ...options, now: new Date(+now + 3_000_000) }))[0].status, 'free');
  assert.equal((await lookupRegistrations(names, { ...options, now: new Date(+now + 3_601_000) }))[0].status, 'taken');
  assert.equal(calls, 3);
});

test('slow sources screen the first five names; handle rows go to the top three, the own name first', async t => {
  const directory = await directoryFor(t);
  resetHandleRuns();
  const inputs = ['Alpha Wren', 'Bravo Wren', 'Charlie Wren', 'Delta Wren', 'Echo Wren', 'Foxtrot Wren', 'Golf Wren'];
  const marks = [];
  const apps = [];
  const social = [];
  const report = await triageNames(inputs, {
    directory, now, cachedOnly: true, receipt: true, launch: playBrowser([]),
    // Bravo and Charlie have no free ending, so Delta and Echo join Alpha for the handle rows.
    resolveNs: async domain => /^(?:bravo|charlie)wren\./.test(domain) ? ['ns.example.test'] : [],
    comSite: async () => ({ state: 'no-site' }),
    fetcher: withSocial(async (value, init) => {
      const url = new URL(value);
      if (url.hostname === 'data.iana.org') return Response.json({ services: [[['com', 'ai', 'io', 'dev', 'app', 'co', 'si', 'net', 'org', 'xyz', 'tech'], ['https://rdap.example.test/']]] });
      if (url.hostname === 'tmsearch.uspto.gov') {
        marks.push(JSON.parse(init.body).query.bool.must[0].bool.should[0].match_phrase.wordmark.query);
        return Response.json({ hits: { hits: [] } });
      }
      if (url.hostname === 'itunes.apple.com') {
        apps.push(url.searchParams.get('term'));
        return Response.json({ results: [] });
      }
      if (url.hostname === 'api.github.com') return Response.json(fixture.github.missing);
      if (url.hostname === 'www.wikidata.org') return Response.json({ search: [] });
      if (url.hostname === 'data.brreg.no') return Response.json(noCompanies);
      if (url.hostname === 'www.sec.gov') return Response.json(companies.edgar);
      return new Response(null, { status: 404 });
    }, { calls: social }),
  });
  const screened = ['alphawren', 'bravowren', 'charliewren', 'deltawren', 'echowren'];
  assert.ok(marks.every(name => screened.includes(name.replace(/\s/g, '').toLowerCase())), marks.join());
  assert.ok(!apps.some(term => /Foxtrot|Golf/.test(term)), apps.join());
  for (const row of report.names.slice(5)) {
    assert.equal(row.verdict, 'Check first');
    assert.match(row.reason, /^Not screened/);
    assert.equal(row.competition.US, null);
    // Registry answers and prices still cover every name.
    assert.ok(row.free.length > 0);
  }
  // GitHub and npm accounts are evidence for the five screened names only.
  const asked = platform => [...new Set(social.filter(([name]) => name === platform).map(([, handle]) => handle)
    .filter(handle => !/^zq|^(?:github|npm|bsky\.app)$/.test(handle)))].sort();
  assert.deepEqual(asked('npm').filter(handle => screened.includes(handle)), screened);
  assert.ok(!asked('npm').some(handle => /foxtrot|golf/.test(handle)));
  // Bluesky is part of the handle row only: the own name, then the cheapest free names.
  assert.deepEqual(asked('Bluesky'), ['alphawren.bsky.social', 'deltawren.bsky.social', 'echowren.bsky.social']);
  assert.deepEqual(Object.keys(report.handles), ['Alpha Wren', 'Delta Wren', 'Echo Wren']);
  assert.deepEqual(report.handles['Alpha Wren'].not_found, ['GitHub', 'npm', 'Bluesky']);
  const rows = report.receiptDetails[0].handles;
  assert.deepEqual(rows.map(row => row.platform), ['YouTube', 'X', 'Instagram', 'TikTok', 'Threads', 'Facebook', 'LinkedIn', 'GitHub', 'npm', 'PyPI', 'Bluesky']);
  assert.equal(report.receiptDetails[1].handles, null);
  assert.doesNotMatch(JSON.stringify(report.handles), /free/);
});
