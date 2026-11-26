import '../../test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { writeCache } from './cache.mjs';
import { withSocial } from '../../test-support/social-fixture.mjs';
import { deadlineClock } from '../../test-support/deadline-clock.mjs';
import { screenMeaning } from './meaning.mjs';
import { checkOffice, euipoQuery, officeAnswered, patentstyretCases, resetOffices, searchTool, trademarkKeys } from './trademarks.mjs';
import { triageNames } from './triage.mjs';
import { resultPages } from '../../results.mjs';

// Synthetic names, owners and numbers only. Keys are fixture strings, never real credentials.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/triage.json', import.meta.url), 'utf8'));
const companies = JSON.parse(readFileSync(new URL('./fixtures/company-names.json', import.meta.url), 'utf8'));
const now = new Date('2026-11-25T12:00:00Z');
const euEnv = { DOMAIN_HOUND_EUIPO_CLIENT_ID: 'fixture-client-id', DOMAIN_HOUND_EUIPO_CLIENT_SECRET: 'fixture-client-secret' };
const noEnv = { DOMAIN_HOUND_PATENTSTYRET_KEY: 'fixture-subscription-key-0001' };
const euHosts = new Set(['euipo.europa.eu', 'api.euipo.europa.eu']);

async function directoryFor(t) {
  const path = await mkdtemp(join(tmpdir(), 'hound-marks-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return new URL('./', pathToFileURL(path + '/'));
}

const euMark = (applicationNumber, verbalElement, status, niceClasses, name = 'Example Holdings Ltd') => ({
  applicationNumber, markFeature: 'WORD', niceClasses, status, wordMarkSpecification: { verbalElement },
  applicants: [{ office: 'EM', name }],
});

const noCase = (number, text, status, classes) => ({ trademarkApplication: {
  trademarkBag: { trademark: [{
    trademarkTypeChoice1: { applicationNumber: [{ ipOfficeCode: 'NO', applicationNumberText: number }] },
    markCurrentStatusCode: status,
    markRepresentation: { markReproduction: { wordMarkSpecification: { markVerbalElementText: { $: text } } } },
    goodsServicesBag: { goodsServices: classes.map(classNumber => ({ classDescriptionBag: { classDescription: [{ classNumber }] } })) },
  }] },
  caseUrl: 'https://services.patentstyret.no/search-details/trademark/' + number,
  holderBag: { holder: [{ contact: { contactTypeChoiceSequence: { name: { entityName: { transliterationName: [{ $: 'Eksempel AS' }] } } } } }] },
} });

// The EUIPO token endpoint and search, answering with the given search bodies or statuses in turn.
function euipo(answers, calls) {
  return async (value, init) => {
    const url = new URL(value);
    assert.ok(euHosts.has(url.hostname), 'EUIPO credentials go only to EUIPO: ' + url.hostname);
    if (url.pathname === '/cas-server-webapp/oidc/accessToken') {
      calls.push('token');
      const form = new URLSearchParams(String(init.body));
      assert.equal(init.method, 'POST');
      assert.equal(form.get('client_id'), euEnv.DOMAIN_HOUND_EUIPO_CLIENT_ID);
      assert.equal(form.get('client_secret'), euEnv.DOMAIN_HOUND_EUIPO_CLIENT_SECRET);
      assert.equal(form.get('grant_type'), 'client_credentials');
      assert.equal(form.get('scope'), 'uid');
      return answers.token ?? Response.json({ access_token: 'fixture-token', token_type: 'Bearer', expires_in: 3600 });
    }
    assert.equal(url.pathname, '/trademark-search/trademarks');
    assert.equal(init.headers.Authorization, 'Bearer fixture-token');
    assert.equal(init.headers['X-IBM-Client-Id'], euEnv.DOMAIN_HOUND_EUIPO_CLIENT_ID);
    calls.push(url.searchParams.get('query'));
    const answer = answers.search.length > 1 ? answers.search.shift() : answers.search[0];
    return answer instanceof Response ? answer : Response.json(answer);
  };
}

// The Patentstyret MCP endpoint: initialize, initialized, tools/list and tools/call, optionally as an event stream.
function patentstyret({ cases = [], total, sse = false, schema, response }, calls) {
  return async (value, init) => {
    assert.equal(new URL(value).href, 'https://api.patentstyret.no/external/open-data/mcp');
    assert.equal(init.headers['Ocp-Apim-Subscription-Key'], noEnv.DOMAIN_HOUND_PATENTSTYRET_KEY);
    const body = JSON.parse(init.body);
    calls.push(body.method === 'tools/call' ? body.params.arguments : body.method);
    const reply = result => {
      const message = { jsonrpc: '2.0', id: body.id, result };
      return sse ? new Response('event: message\ndata: ' + JSON.stringify(message) + '\n\n', {
        headers: { 'Content-Type': 'text/event-stream' } }) : Response.json(message);
    };
    if (body.method === 'initialize') {
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } },
        { headers: { 'Mcp-Session-Id': 'fixture-session' } });
    }
    assert.equal(init.headers['Mcp-Session-Id'], 'fixture-session');
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'tools/list') return reply({ tools: [{ name: 'search_trademarks', inputSchema: schema ?? {
      type: 'object', properties: { searchText: { type: 'string' }, maxResults: { type: 'integer', maximum: 100 } }, required: ['searchText'],
    } }] });
    return reply({ content: [{ type: 'text', text: JSON.stringify(response ?? { totalHits: total ?? cases.length, results: cases }) }] });
  };
}

test('an office without its key is off and sends nothing', async () => {
  resetOffices();
  const fetcher = async () => assert.fail('no request without a key');
  assert.deepEqual(trademarkKeys({}), { EU: null, NO: null });
  assert.deepEqual(trademarkKeys({ DOMAIN_HOUND_EUIPO_CLIENT_ID: 'only-the-id' }).EU, null);
  assert.deepEqual(await checkOffice('EU', 'quietwren', 'Quiet Wren', { env: {}, fetcher }), { office: 'EU', state: 'off' });
  assert.deepEqual(await checkOffice('NO', 'quietwren', 'Quiet Wren', { env: {}, fetcher }), { office: 'NO', state: 'off' });
});

test('EUIPO: exact, spaced and plural spellings in one query; live hits keep office, status, classes and record', async t => {
  resetOffices();
  const directory = await directoryFor(t);
  const calls = [];
  const fetcher = euipo({ search: [{ trademarks: [
    euMark('019000001', 'QUIET WREN', 'REGISTERED', [9, 42]),
    euMark('019000002', 'Quiet Wrens', 'APPLICATION_PUBLISHED', [25]),
    euMark('019000003', 'QUIETWREN', 'EXPIRED', [9]),
    euMark('019000004', 'Quiet Wrenly', 'REGISTERED', [9]),
  ], totalElements: 4, totalPages: 1, page: 0, size: 100 }] }, calls);
  const result = await checkOffice('EU', 'quietwren', 'Quiet Wren', { env: euEnv, fetcher, directory, now });
  assert.equal(result.state, 'ok');
  assert.equal(officeAnswered(result), true);
  assert.deepEqual(result.marks.map(mark => [mark.name, mark.tier, mark.relevant, mark.status]), [
    ['QUIET WREN', 'Exact', true, 'registered'], ['Quiet Wrens', 'Near-identical', false, 'application published'],
  ]);
  assert.deepEqual(result.marks[0].classes, ['009', '042']);
  assert.equal(result.marks[0].owner, 'Example Holdings Ltd');
  assert.equal(result.marks[0].url, 'https://euipo.europa.eu/eSearch/#details/trademarks/019000001');
  const query = calls[1];
  for (const form of ['"quietwren"', '"QUIETWREN"', '"quiet wren"', '"Quiet Wren"', '"QUIET WREN"', '"quietwrens"']) {
    assert.ok(query.includes('wordMarkSpecification.verbalElement==' + form), form);
  }
  assert.match(query, / and status=in=\(RECEIVED,.*REGISTERED.*\)$/);
  assert.ok(query.includes('wordMarkSpecification.verbalElement==quietwr*n'));
  assert.ok(query.includes('wordMarkSpecification.verbalElement==quietw*ren'));
  assert.doesNotMatch(query, /EXPIRED|REFUSED|WITHDRAWN/);
  // The answer is cached for a day, and the token is reused by the next name in the run.
  assert.deepEqual(await checkOffice('EU', 'quietwren', 'Quiet Wren', { env: euEnv, fetcher, directory, now }), result);
  await checkOffice('EU', 'amberfinch', 'Amber Finch', { env: euEnv, fetcher, directory, now });
  assert.deepEqual(calls.filter(call => call === 'token'), ['token']);
  // Very long names keep the query under the API limit and say the screen was incomplete.
  const long = euipoQuery('a'.repeat(99), 'a'.repeat(99));
  assert.ok(long.query.length <= 4800);
  assert.equal(long.complete, false);
});

test('EUIPO outages, cut-short pages and refused keys never read as clear and keep earlier marks', async t => {
  resetOffices();
  const directory = await directoryFor(t);
  const calls = [];
  // A cut-short page with no hit is not "no mark": the office stays unknown, and nothing is cached.
  const partial = await checkOffice('EU', 'quietwren', 'Quiet Wren', { env: euEnv, directory, now,
    fetcher: euipo({ search: [{ trademarks: [], totalElements: 140, totalPages: 2, page: 0, size: 100 }] }, calls) });
  assert.equal(partial.state, 'ok');
  assert.equal(partial.partial, true);
  assert.equal(officeAnswered(partial), false);
  // A transient outage is retried once, then fails; marks from an earlier answer stay, with their date.
  await writeCache(directory, 'trademark-eu-quietwren.json', { at: now.getTime() - 3 * 86_400_000, rows: [{
    office: 'EU', name: 'QUIET WREN', owner: '', classes: ['042'], tier: 'Exact', status: 'registered', live: true,
    registered: true, url: 'https://euipo.europa.eu/eSearch/#details/trademarks/019000001' }] });
  calls.length = 0;
  const down = await checkOffice('EU', 'quietwren', 'Quiet Wren', { env: euEnv, directory, now,
    fetcher: euipo({ search: [new Response(null, { status: 503 })] }, calls) });
  assert.equal(calls.filter(call => call !== 'token').length, 2);
  assert.equal(down.state, 'failed');
  assert.equal(down.marks[0].relevant, true);
  assert.equal(down.marks[0].checkedAt, '2026-11-22');
  // A refused key or a rate limit is not retried, and the next name in the run does not ask again.
  resetOffices();
  calls.length = 0;
  const refused = await checkOffice('EU', 'amberfinch', 'Amber Finch', { env: euEnv, directory, now,
    fetcher: euipo({ token: new Response('{"error":"invalid_client"}', { status: 400 }), search: [] }, calls) });
  assert.deepEqual([refused.state, refused.why, calls], ['failed', 'key refused', ['token']]);
  const held = await checkOffice('EU', 'velvetlark', 'Velvet Lark', { env: euEnv, directory, now, fetcher: async () => assert.fail('held') });
  assert.equal(held.state, 'failed');
  resetOffices();
  calls.length = 0;
  const limited = await checkOffice('EU', 'amberfinch', 'Amber Finch', { env: euEnv, directory, now,
    fetcher: euipo({ search: [new Response(null, { status: 429, headers: { 'Retry-After': '30' } })] }, calls) });
  assert.deepEqual([limited.why, calls.length], ['rate limited', 2]);
  // Out of shared time: no request at all.
  resetOffices();
  const late = await checkOffice('EU', 'amberfinch', 'Amber Finch', { env: euEnv, directory, now, timeLeft: () => 500,
    fetcher: async () => assert.fail('no time') });
  assert.deepEqual([late.state, late.why], ['failed', 'out of time']);
});

test('Patentstyret: MCP session, schema-named arguments, live ST.96 cases, event streams and cut-short lists', async t => {
  resetOffices();
  const directory = await directoryFor(t);
  const calls = [];
  const cases = [noCase('202500001', 'VELVET LARK', 'Registered', [9, 42]), noCase('202500002', 'Velvet Lark', 'Withdrawn', [42]),
    noCase('202500003', 'VELVETLARKS', 'Pending', [35])];
  const result = await checkOffice('NO', 'velvetlark', 'Velvet Lark', { env: noEnv, directory, now,
    fetcher: patentstyret({ cases, sse: true }, calls) });
  assert.deepEqual(calls.slice(0, 3), ['initialize', 'notifications/initialized', 'tools/list']);
  assert.deepEqual(calls.slice(3), [{ searchText: 'velvetlark', maxResults: 50 }, { searchText: 'velvet lark', maxResults: 50 }]);
  assert.equal(result.state, 'ok');
  assert.equal(officeAnswered(result), true);
  assert.deepEqual(result.marks.map(mark => [mark.name, mark.tier, mark.status, mark.relevant, mark.owner]), [
    ['VELVET LARK', 'Exact', 'registered', true, 'Eksempel AS'], ['VELVETLARKS', 'Near-identical', 'pending', true, 'Eksempel AS'],
  ]);
  assert.equal(result.marks[0].url, 'https://services.patentstyret.no/search-details/trademark/202500001');
  // More hits than the page holds: incomplete, so never "no mark".
  resetOffices();
  const cut = await checkOffice('NO', 'amberfinch', 'Amber Finch', { env: noEnv, directory, now,
    fetcher: patentstyret({ cases: [], total: 300 }, []) });
  assert.equal(officeAnswered(cut), false);
  // A search tool without a text argument is a failure, not an empty answer.
  resetOffices();
  const odd = await checkOffice('NO', 'amberfinch', 'Amber Finch', { env: noEnv, directory, now,
    fetcher: patentstyret({ schema: { type: 'object', properties: { classes: { type: 'array' } } } }, []) });
  assert.deepEqual([odd.state, odd.why], ['failed', 'search tool not found']);
  assert.deepEqual(searchTool([{ name: 'search_trademarks', inputSchema: { properties: { q: { type: 'string' } } } }]), { text: 'q' });
  assert.equal(patentstyretCases({ hits: [{ trademarkApplication: {} }], total: 7 }).total, 7);
});

test('sandbox results cannot answer a production check', async t => {
  resetOffices();
  const directory = await directoryFor(t);
  const search = { trademarks: [], totalElements: 0 };
  const sandbox = await checkOffice('EU', 'copperfern', 'Copper Fern', {
    directory, now, env: { ...euEnv, DOMAIN_HOUND_EUIPO_SANDBOX: '1' },
    fetcher: async value => Response.json(new URL(value).pathname.endsWith('/accessToken')
      ? { access_token: 'fixture-token' } : search),
  });
  assert.equal(officeAnswered(sandbox), true);
  const calls = [];
  const production = await checkOffice('EU', 'copperfern', 'Copper Fern', {
    directory, now, env: euEnv, fetcher: euipo({ search: [{
      trademarks: [euMark('019000001', 'Copper Fern', 'REGISTERED', [42])], totalElements: 1,
    }] }, calls),
  });
  assert.equal(calls.length, 2);
  assert.equal(production.marks[0].relevant, true);
});

test('unrecognized provider responses cannot produce a complete trademark check', async t => {
  resetOffices();
  const directory = await directoryFor(t);
  const eu = await checkOffice('EU', 'copperfern', 'Copper Fern', {
    directory, now, env: euEnv, fetcher: euipo({ search: [{
      trademarks: [euMark('019000001', 'Copper Fern', 'UNRECOGNIZED_STATUS', [42])], totalElements: 1,
    }] }, []),
  });
  assert.equal(officeAnswered(eu), false);
  assert.equal(eu.marks[0].relevant, false);
  const no = await checkOffice('NO', 'copperfern', 'Copper Fern', { directory, now, env: noEnv,
    fetcher: patentstyret({ response: {} }, []),
  });
  assert.equal(officeAnswered(no), false);
  assert.equal(no.state, 'failed');
});

test('Patentstyret setup and search share one deadline', async t => {
  resetOffices();
  const clock = deadlineClock(t);
  const directory = await directoryFor(t);
  const calls = [];
  const fetcher = patentstyret({}, calls);
  const result = await checkOffice('NO', 'copperfern', 'Copper Fern', { directory, now, env: noEnv, timeLeft: () => 1550,
    fetcher: async (value, init) => {
      clock.tick(400);
      init.signal.throwIfAborted();
      return fetcher(value, init);
    },
  });
  assert.equal(officeAnswered(result), false);
  assert.deepEqual(calls, ['initialize', 'notifications/initialized']);
});

// A browser whose Google Play search finds no app.
const emptyPlay = async () => ({
  async newContext() {
    return { async newPage() {
      let url;
      return { context: () => ({}), goto: async value => { url = value; return { ok: () => true }; }, url: () => url,
        waitForFunction: async () => ({ jsonValue: async () => [] }),
        request: { get: async () => ({ ok: () => true, text: async () => '', dispose: async () => {} }) }, close: async () => {} };
    } };
  },
  close: async () => {},
});

// One triage run with fixture sources; offices and their keys come from env.
function triageOptions(directory, env, offices) {
  return {
    directory, now, env, cachedOnly: true, launch: emptyPlay,
    resolveNs: async domain => domain.endsWith('.com') ? ['ns.example.test'] : [],
    comSite: async () => ({ state: 'no-site' }),
    fetcher: withSocial(async (value, init) => {
      const url = new URL(value);
      if (url.hostname === 'data.iana.org') return Response.json({ services: [[['com', 'ai', 'io', 'dev', 'app', 'co', 'si'], ['https://rdap.example.test/']]] });
      if (url.hostname === 'tmsearch.uspto.gov') return Response.json({ hits: { hits: [] } });
      if (url.hostname === 'itunes.apple.com') return Response.json({ results: [] });
      if (url.hostname === 'www.wikidata.org') return Response.json({ search: [] });
      if (url.hostname === 'api.github.com') return Response.json(fixture.github.missing);
      if (url.hostname === 'data.brreg.no') return Response.json({ page: { totalPages: 0 } });
      if (url.hostname === 'www.sec.gov') return Response.json(companies.edgar);
      if (euHosts.has(url.hostname)) return offices.EU(value, init);
      if (url.hostname === 'api.patentstyret.no') return offices.NO(value, init);
      return new Response(null, { status: 404 });
    }),
  };
}

test('EU and Norwegian hits set the verdict and show office, mark, status, classes and record in the answer and receipt', async t => {
  resetOffices();
  const directory = await directoryFor(t);
  const env = { ...euEnv, ...noEnv };
  const offices = {
    EU: euipo({ search: [{ trademarks: [euMark('019000001', 'QUIET WREN', 'REGISTERED', [9, 42]),
      euMark('019000005', 'Velvet Larks', 'REGISTERED', [41])], totalElements: 2 }] }, []),
    NO: patentstyret({ cases: [noCase('202500001', 'VELVET LARK', 'Registered', [42])] }, []),
  };
  // The fixture offices answer every name with the same list; only matching spellings count.
  const report = await triageNames(['Quiet Wren', 'Velvet Lark', 'Amber Finch'], { ...triageOptions(directory, env, offices), receipt: true });
  const [eu, no, clear] = report.names;
  assert.equal(eu.verdict, 'Avoid');
  assert.equal(eu.reason.split(' · ')[0], 'Exact: QUIET WREN (EUIPO registered, Example Holdings Ltd, 009/042)');
  assert.deepEqual(eu.competition.marks[0], { office: 'EUIPO', mark: 'QUIET WREN', tier: 'Exact', status: 'registered',
    classes: ['009', '042'], url: 'https://euipo.europa.eu/eSearch/#details/trademarks/019000001' });
  assert.deepEqual(eu.competition.US, []);
  assert.equal(no.verdict, 'Avoid');
  assert.match(no.reason, /^Exact: VELVET LARK \(Patentstyret registered, Eksempel AS, 042\)/);
  assert.equal(no.competition.NO, no.reason.split(' · ')[0]);
  assert.equal(no.competition.marks[0].url, 'https://services.patentstyret.no/search-details/trademark/202500001');
  // A plural EU mark outside the relevant classes is named but does not force Avoid on its own.
  assert.ok(no.competition.marks.some(mark => mark.office === 'EUIPO' && mark.tier === 'Near-identical'));
  assert.equal(clear.verdict, 'No conflict found');
  assert.equal(clear.reason, 'No US, EU or Norwegian mark, same-name app or active company found in the sources checked');
  assert.deepEqual([clear.competition.EU, clear.competition.NO], [[], []]);
  assert.equal(report.sources.EUIPO, 100);
  assert.equal(report.sources.Patentstyret, 100);
  const pages = resultPages({ directory: fileURLToPath(new URL('results/', directory)), env: { DOMAIN_HOUND_OPEN: 'off' } });
  const page = await pages(report, { names: ['Quiet Wren', 'Velvet Lark', 'Amber Finch'] }, { triage: true });
  assert.match(page.say, /Keep Quiet Wren\? Avoid\. Exact: QUIET WREN \(EUIPO registered, Example Holdings Ltd, 009\/042\)\..* EU trademark screen\./);
  assert.ok(page.say.includes('[EUIPO record](https://euipo.europa.eu/eSearch/#details/trademarks/019000001)'));
  const md = await readFile(fileURLToPath(page.resultPage).replace(/\.html$/, '.md'), 'utf8');
  assert.ok(md.includes('[EUIPO mark: Exact QUIET WREN, registered, classes 009/042](https://euipo.europa.eu/eSearch/#details/trademarks/019000001)'));
  assert.ok(md.includes('[Patentstyret mark: Exact VELVET LARK, registered, classes 042](https://services.patentstyret.no/search-details/trademark/202500001)'));
  assert.match(md, /Trademark match found/);
  assert.match(md, /\[Search WIPO\]\(https:\/\/branddb\.wipo\.int\/\)/);
  const html = await readFile(fileURLToPath(page.resultPage), 'utf8');
  assert.ok(html.includes('<a href="https://services.patentstyret.no/search-details/trademark/202500001">Patentstyret mark: Exact VELVET LARK'));
});

test('an office that fails or answers in part blocks No conflict found and reads couldn\'t check', async t => {
  resetOffices();
  const directory = await directoryFor(t);
  const env = { ...euEnv, ...noEnv };
  const offices = {
    EU: euipo({ search: [new Response(null, { status: 503 })] }, []),
    NO: patentstyret({ cases: [], total: 120 }, []),
  };
  const report = await triageNames(['Amber Finch'], { ...triageOptions(directory, env, offices), receipt: true });
  const [row] = report.names;
  assert.equal(row.verdict, 'Check first');
  assert.equal(row.reason, 'EUIPO, Patentstyret did not answer');
  assert.deepEqual([row.competition.EU, row.competition.NO], [null, null]);
  assert.deepEqual([report.sources.EUIPO, report.sources.Patentstyret], [0, 0]);
  const pages = resultPages({ directory: fileURLToPath(new URL('results/', directory)), env: { DOMAIN_HOUND_OPEN: 'off' } });
  const page = await pages(report, { names: ['Amber Finch'] }, { triage: true });
  assert.match(page.say, /\[EUIPO\]\([^)]+\): couldn't check.*\[Patentstyret\]\([^)]+\): couldn't check/);
  const md = await readFile(fileURLToPath(page.resultPage).replace(/\.html$/, '.md'), 'utf8');
  assert.match(md, /EU marks: couldn't check, EUIPO did not answer in full\]\(https:\/\/www\.euipo\.europa\.eu\/en\/search-ip\)/);
  assert.match(md, /Trademark check incomplete/);
  // Without keys nothing changes for the verdict, and the receipt still links the EU and Norway searches.
  resetOffices();
  const keyless = await triageNames(['Amber Finch'], { ...triageOptions(directory, {}, offices), receipt: true });
  assert.equal(keyless.names[0].verdict, 'No conflict found');
  assert.equal(keyless.names[0].reason, 'No US mark, same-name app or active company found in the sources checked');
  assert.equal('EU' in keyless.names[0].competition, false);
  const keylessPage = await pages(keyless, { names: ['Amber Finch'] }, { triage: true });
  assert.match(keylessPage.say, /\[EUIPO\]\([^)]+\): couldn't check.*\[Patentstyret\]\([^)]+\): couldn't check/);
  const keylessMd = await readFile(fileURLToPath(keylessPage.resultPage).replace(/\.html$/, '.md'), 'utf8');
  assert.match(keylessMd, /\[Norway marks: couldn't check\]\(https:\/\/search\.patentstyret\.no\/\)/);
});

test('meaning screen flags known rude words in all 14 languages, sounds-alikes and glued words', () => {
  for (const [name, how, language] of [
    ['KickAss', 'contains', 'English'], ['Pendejo', 'is', 'Spanish'], ['Caralho', 'is', 'Portuguese'], ['Merde', 'is', 'French'],
    ['Fotze', 'is', 'German'], ['Cazzo', 'is', 'Italian'], ['Faen', 'is', 'Norwegian'], ['Fitta', 'is', 'Swedish'],
    ['Fisse', 'is', 'Danish'], ['Klootzak', 'is', 'Dutch'], ['Kurwa', 'is', 'Polish'], ['Orospu', 'is', 'Turkish'],
    ['Kuso', 'is', 'Japanese'], ['Shabi', 'is', 'Chinese'], ['Göt', 'is', 'Turkish'], ['Phuck', 'sounds', 'English'],
    ['Fuk', 'sounds', 'English'], ['Bullshit Labs', 'contains', 'English'], ['Hentaihub', 'contains', 'Japanese'],
    ['Cazzoapp', 'contains', 'Italian'],
  ]) {
    const hit = screenMeaning(name);
    assert.ok(hit, name);
    assert.equal(hit.how, how, name);
    assert.ok(hit.languages.includes(language), name + ': ' + hit.languages);
  }
});

test('meaning screen leaves ordinary names alone, including classic inside-a-word cases', () => {
  // Ordinary words that happen to contain a rude word.
  const names = ['Scunthorpe', 'Analytics', 'Therapist', 'Grape', 'Cockpit', 'Peacock', 'Hancock', 'Shiitake', 'Assist',
    'Passport', 'Sussex', 'Essex', 'Dickens', 'Cumulus', 'Titan', 'Sexton', 'Fukuoka'];
  assert.deepEqual(names.filter(name => screenMeaning(name)), []);
  assert.equal(screenMeaning(''), null);
});

test('a rude meaning lowers a clear name to Check first with a note in the answer and the receipt, never Avoid', async t => {
  resetOffices();
  const directory = await directoryFor(t);
  const report = await triageNames(['Merde Labs', 'Amber Finch'], { ...triageOptions(directory, {}, {}), receipt: true });
  const [rude, clear] = report.names;
  assert.equal(rude.verdict, 'Check first');
  assert.equal(rude.meaning, 'Contains “merde”, a rude word in French');
  assert.match(rude.reason, /^Meaning: Contains “merde”, a rude word in French · No US mark/);
  assert.equal(clear.verdict, 'No conflict found');
  assert.equal(clear.meaning, undefined);
  const pages = resultPages({ directory: fileURLToPath(new URL('results/', directory)), env: { DOMAIN_HOUND_OPEN: 'off' } });
  const page = await pages(report, { names: ['Merde Labs', 'Amber Finch'] }, { triage: true });
  assert.match(page.say, /Keep Merde Labs\? Check first\. Meaning: Contains “merde”, a rude word in French\./);
  const md = await readFile(fileURLToPath(page.resultPage).replace(/\.html$/, '.md'), 'utf8');
  assert.match(md, /- Meaning: Contains “merde”, a rude word in French/);
  assert.match(md, /Meaning: check first/);
});
