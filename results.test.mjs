import './test-support/isolated-cache.mjs';
import { shopSearchUrl } from './clis/domain-check/prices.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { searchCandidates, defaultEndings } from './clis/domain-check/name-search.mjs';
import { resultPages, resultsLine } from './results.mjs';
import { newsQuestion, watchDomain } from './watch.mjs';

const at = '2026-11-24T12:00:00.000Z';
const fixtures = {
  checkedAt: at, priceListDate: at.slice(0, 10),
  prices: { com: { now: 12, renew: 14, shop: 'Spaceship' }, no: { now: 7, renew: 8, shop: 'Dynadot' },
    ai: { now: 170, renew: 180, term: 2, shop: 'Spaceship' }, io: { now: 18, renew: 42, jump: true, shop: 'Spaceship' } },
  names: [{ name: 'Paper Heron', verdict: 'Avoid', reason: 'Same-name rival <script>alert(1)</script>',
    taken: ['com'], shop_check: ['app'], likely_free: ['app'], free: ['no', 'ai', 'io'], premium: ['me'],
    competition: { AppStore: [], GooglePlay: null, US: 'Exact: Paper Heron (Example Inc., 009)' } },
  { name: 'Cedar Heron', verdict: 'No conflict found', reason: 'No US mark, same-name app or active company found',
    free: ['no', 'com', 'ai', 'io'], taken: ['me'], competition: { AppStore: [], GooglePlay: [], US: [] } }],
};

async function tempPages(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hound-results-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  return { directory, pages: resultPages({ directory, env: { DOMAIN_HOUND_OPEN: 'off' } }) };
}

test('the short recommendation obeys scope while both receipts retain every ending and its evidence', async t => {
  const { pages } = await tempPages(t);
  const result = await pages(fixtures, { budget: 20, endings: ['com'] }, { triage: true });
  const lines = result.say.split('\n');
  assert.ok(lines.length <= 8);
  assert.match(lines[1], /^\.com first.*\$20\.00 today.*cedarheron\.com \$12\.00, then \$14\.00/);
  assert.match(result.say, /Keep Paper Heron\? Avoid\./);
  assert.match(result.say, /iOS: no app with this name/);
  assert.match(result.say, /Google Play has no public search · \[Search Google Play\]/);
  assert.match(result.say, /Best available alternative: Cedar Heron/);
  assert.match(result.say, /Want it anyway\? \[Watch paperheron\.com\]/);
  assert.doesNotMatch(result.say, /[—–]|paperheron\.io|cedarheron\.no/);
  assert.equal(lines[0], resultsLine(result.resultPage));

  const path = fileURLToPath(result.resultPage);
  const [html, md] = await Promise.all([readFile(path, 'utf8'), readFile(path.replace(/\.html$/, '.md'), 'utf8')]);
  for (const ending of defaultEndings) {
    for (const resultFile of [html, md]) {
      assert.ok(resultFile.includes('paperheron.' + ending));
      assert.ok(resultFile.includes('cedarheron.' + ending));
    }
  }
  assert.match(html, /<td>\$170\.00<\/td><td>\$180\.00<\/td>/);
  assert.match(html, /2 years per payment/);
  assert.match(html, /possibly available by DNS/);
  assert.match(html, /needs|eligibility required/);
  assert.match(html, /https:\/\/www\.spaceship\.com\/domain-search\/\?query=cedarheron\.com/);
  assert.equal([...html.matchAll(/<script\b/g)].length, 1, 'only the fixed reader clock runs');
  assert.doesNotMatch(html, /<script>alert|query=cedarheron\.no|query=paperheron\.com/);
  assert.match(md, /cedarheron\.com \| \$12\.00 \| \$14\.00/);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('retention bounds receipt storage and preserves both files for the newest requests', async t => {
  const { directory, pages } = await tempPages(t);
  const last = await Promise.all(Array.from({ length: 12 }, () =>
    pages({ names: [{ name: 'example.com', taken: ['com'] }] }, {})));
  const files = await readdir(directory);
  assert.equal(files.length, 20);
  for (const result of last.slice(-5)) {
    const path = fileURLToPath(result.resultPage);
    assert.match(await readFile(path, 'utf8'), /example\.com/);
    assert.match(await readFile(path.replace(/\.html$/, '.md'), 'utf8'), /example\.com/);
  }
});

test('a local check uses the hosted pick cap and wording while keeping expensive offers visible', async t => {
  const { pages } = await tempPages(t);
  const name = { name: 'exampleheron', free: [{ d: 'co', s: 'nc', now: 10, renew: 30, y3: 70, shop: 'Cloudflare' }] };
  const data = { source: 'local', names: [name] };
  const expensive = await pages(data, {});
  assert.match(expensive.say, /Available · exampleheron\.co\n.*\$70\.00 over three years · requires Cloudflare DNS/);
  assert.doesNotMatch(expensive.say, /The Hound’s pick/);

  const withinCap = await pages({ ...data, names: [{ ...name, free: [
    ...name.free, { d: 'dev', s: 'nc', now: 8, renew: 12.5, y3: 33, shop: 'Spaceship' },
  ] }] }, {});
  assert.match(withinCap.say, /The Hound’s pick is exampleheron\.dev at Spaceship for \$33\.00 over three years\./);
});

test('a partial shop quote keeps renewal unknown and an exact offer above budget is not recommended', async t => {
  const { pages } = await tempPages(t);
  const quote = { d: 'com', s: 'ok', now: 18, shop: 'Dynadot' };
  const data = { names: [{ name: 'example.com', free: [quote] }, { name: 'example.net', taken: ['net'] },
    { name: 'reserved.com', shop_check: ['com'], reserved: ['com'] }],
    listPrices: { com: { now: 9.48, renew: 10.68, y3: 30.84, shop: 'Spaceship' } } };
  const batch = await pages(data, {});
  const html = await readFile(new URL(batch.resultPage), 'utf8');
  assert.match(html, /example\.com[\s\S]*?<td>\$18\.00<\/td><td>No price/);
  assert.doesNotMatch(batch.say, /\$10\.68|\$30\.84/);
  assert.match(batch.say, /renewal at shop/);
  assert.match(html, /reserved\.com<\/code><small>Not offered for registration[^<]*<\/small><\/th><td>No price<\/td><td>No price/);
  assert.doesNotMatch(html, /query=reserved\.com/);

  const exact = await pages({ ...data, names: [data.names[0]] }, { budget: 10, purchase: true });
  assert.match(exact.say, /Over budget\.\nThis check leaves checkout to you\.\nNext: try a cheaper domain\./);
  assert.doesNotMatch(exact.say, /https:\/\//);
});

test('a live website overrides the reported free registry status before progress or final output', async () => {
  const progress = [];
  const candidates = ['com', 'dev'].map(tld => ({ domain: 'paperheron.' + tld, tld, exact: true }));
  const results = await searchCandidates([{ name: 'paperheron', candidates }], {
    directory: null, cachedOnly: true, bundledCatalog: null, fetcher: async url => new URL(url).hostname === 'data.iana.org'
      ? Response.json({ services: [[['com', 'dev'], ['https://rdap.example.test/']]] }) : new Response(null, { status: 404 }),
    resolveNs: async () => [], verifyFreeSite: async () => ({ state: 'live', host: 'www.example.com' }),
    onProgress: row => progress.push(row),
  });
  assert.equal(results.groups[0].results.length, 2);
  assert.ok(results.groups[0].results.every(row => row.status === 'taken' && row.source === 'web'));
  assert.deepEqual(new Map(progress.map(row => [row.domain, row.status])),
    new Map(candidates.map(row => [row.domain, 'taken'])));
});

test('watch sends only an explicit news pre-flag and never puts contact details into the receipt', async t => {
  const sent = [];
  const options = { now: new Date(at), registry: async () => [{ status: 'taken', expires: '2027-11-24', source: 'rdap' }],
    siteCheck: async () => ({ state: 'live' }),
    fetcher: async (url, opts) => {
      sent.push({ url, opts });
      return Response.json({ ok: true }, { status: 202 });
    } };
  const preview = await watchDomain({ domain: 'Example.COM' }, options);
  assert.equal(sent.length, 0);
  assert.equal(preview.submission, 'needs-email');
  assert.match(preview.say, /expiry|expires 2027-11-24/);
  assert.ok(preview.say.includes(newsQuestion));
  assert.match(preview.say, /watch\/\?domain=example\.com/);
  const ask = await watchDomain({ domain: 'example.com', email: 'rowan@example.com' }, options);
  assert.equal(ask.submission, 'needs-news-choice');
  assert.ok(ask.say.includes(newsQuestion));
  assert.equal(sent.length, 0);
  await assert.rejects(watchDomain({ domain: 'sub.example.com', email: 'rowan@example.com' }, options), /supported domain/);
  await watchDomain({ domain: 'example.com', email: 'rowan@example.com', name: 'Rowan Example', news: false }, options);
  const signed = await watchDomain({ domain: 'example.com', email: 'rowan@example.com', name: 'Rowan Example', news: true }, options);
  const [withoutNews, withNews] = sent.map(({ opts }) => JSON.parse(opts.body));
  assert.equal(withoutNews.news, undefined);
  assert.deepEqual(withNews, { domain: 'example.com', email: 'rowan@example.com', name: 'Rowan Example',
    news: 'yes', source: 'agent', consentTextVersion: 'news-v1' });
  assert.equal(sent[1].url, 'https://domainhound-alerts.domainhound.workers.dev/watch');
  assert.equal(sent[1].opts.method, 'POST');
  assert.equal(new Headers(sent[1].opts.headers).has('origin'), false);
  assert.match(signed.say, /Check your inbox to start watching\. Choose “Confirm watch only” or “Confirm watch \+ news”\./);
  const { pages } = await tempPages(t);
  const result = await pages(signed, {}, { watch: true });
  const html = await readFile(new URL(result.resultPage), 'utf8');
  assert.match(html, /Check your inbox to start watching/);
  assert.doesNotMatch(JSON.stringify(result) + html, /rowan@example\.com|Rowan Example/);
});

test('say names the handles of the person’s own name in three states and the page lists every platform with its link', async t => {
  const { pages } = await tempPages(t);
  const handles = [
    ['YouTube', 'check', 'https://www.youtube.com/@paperheron'], ['X', 'check', 'https://x.com/paperheron'],
    ['GitHub', 'taken', 'https://github.com/paperheron'], ['npm', 'not-found', 'https://www.npmjs.com/package/paperheron'],
    ['PyPI', 'check', 'https://pypi.org/project/paperheron/'], ['Bluesky', 'check', 'https://bsky.app/profile/paperheron.bsky.social'],
  ].map(([platform, state, link]) => ({ platform, handle: 'paperheron', state, link,
    ...(platform === 'GitHub' && { variants: [{ handle: 'getpaperheron', state: 'not-found', link: 'https://github.com/getpaperheron' }] }) }));
  const data = { ...fixtures, names: [{ ...fixtures.names[0], free: ['no', 'ai', 'io', 'de'] }, fixtures.names[1]],
    receiptDetails: [{ handles }, { handles: null }] };
  const result = await pages(data, {}, { triage: true });
  const line = result.say.split('\n').find(text => text.startsWith('Handles for Paper Heron:'));
  assert.equal(line, "Handles for Paper Heron: YouTube · Couldn't check, X · Couldn't check, GitHub · Taken, npm · No profile found (2 more on the page).");
  assert.doesNotMatch(line, /free|available/i);
  const path = fileURLToPath(result.resultPage);
  const [html, md] = await Promise.all([readFile(path, 'utf8'), readFile(path.replace(/\.html$/, '.md'), 'utf8')]);
  assert.match(html, /<summary>Name checks<\/summary>[\s\S]*?<h4>Handles<\/h4>/);
  assert.match(html, /<a href="https:\/\/github\.com\/paperheron">GitHub @paperheron · Taken<\/a>/);
  assert.match(html, /GitHub alternative @getpaperheron · No profile found/);
  assert.match(html, /YouTube @paperheron · Couldn&#39;t check/);
  assert.match(md, /### Handles/);
  assert.match(html, /Handles: checked for the top three names\./);
  // An ending on request (.de) that the lookup returned is on the page beside the default endings.
  assert.match(html, /paperheron\.de(?![a-z])/);
  assert.match(md, /paperheron\.de(?![a-z])/);
  assert.doesNotMatch(html, /cedarheron\.de(?![a-z])/);
});

test('the progress frame names the handle stage while the top names are checked', async () => {
  const { progressText } = await import('./display.mjs');
  const text = JSON.parse(progressText({ answers: new Map([['quietotter.com', 'taken']]), stage: 'handles' },
    { rows: [{ name: 'Quiet Otter', domains: ['quietotter.com', 'quietotter.de'] }], elapsedMs: 14000, budgetMs: 14000, triage: true }));
  assert.equal(text.stage, 'handles');
  assert.equal(text.pending, true);
  assert.match(text.display, /handles for the top three names are being checked/);
  assert.match(text.display, /still checking \.de, ask again/);
});

test('hosted receipts put the pick, app stores and trademark before shop comparisons', async t => {
  const { pages } = await tempPages(t);
  const domain = 'example.dev';
  const prices = ['Spaceship', 'Dynadot', 'Namecheap', 'Cloudflare'].map((shop, index) => ({
    shop, firstYearUsd: 2, renewalUsd: 10 - index, threeYearUsd: 22 - 2 * index, minimumYears: 1,
    firstPaymentUsd: 2, buyUrl: shopSearchUrl(shop.toLowerCase(), domain),
  }));
  const check = { query: { name: 'example' }, choice: { pick: { domain, ...prices.at(-1) }, capUsd: 60 },
    domains: [{ domain, status: 'available', prices }], nameChecks: {
      trademarks: { us: { status: 'exact_match_found', marks: [
        { mark: '', owner: 'Example Labs', url: 'https://tsdr.uspto.gov/#caseNumber=12345678' },
      ] } }, appStore: {}, googlePlay: {}, handles: [] } };
  const lines = ['Agent text stays intact.'];
  const result = await pages({ hosted: true, checks: [check], names: [{ name: 'example' }], lines, checkedAt: at }, {});
  assert.equal(result.say, resultsLine(result.resultPage) + '\n' + lines[0]);
  const html = await readFile(new URL(result.resultPage), 'utf8');
  const body = html.split('<body>')[1];
  assert.ok(body.includes('class="trademark-warning"'));
  assert.match(body, /has an exact live US trademark match \(Example Labs\)/);
  assert.match(body, /https:\/\/tsdr\.uspto\.gov\/#caseNumber=12345678">example/);
  const order = ['Hound’s pick', 'App Store (iOS)', 'Google Play (Android)', 'class="trademark-warning"', 'Buy at Cloudflare'];
  const positions = order.map(value => body.indexOf(value));
  assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])));
  assert.match(body, /Search aid, not legal advice\./);
  assert.match(body, /Buy at Cloudflare/);
  assert.match(body, /Renewal at Cloudflare costs more than 3 times the first year/);
  assert.match(body, /<details[^>]*><summary[^>]*>\+1 more shop<\/summary>/);
  assert.ok(body.indexOf('Buy at Cloudflare') < body.indexOf('+1 more shop'));
  assert.match(body, /<time datetime="/);
  assert.doesNotMatch(body, /Agent text stays intact/);
});

test('an exact taken check keeps its agent answer and adds verified alternatives to the receipt', async t => {
  const { hostedClient } = await import('./hosted.mjs');
  const { hostedResult } = await import('./hosted-results.mjs');
  const { pages } = await tempPages(t);
  const exact = 'example.ai';
  const row = (domain, status) => ({ domain, ending: domain.split('.')[1], status, prices: [] });
  const checks = {
    [exact]: [row(exact, 'taken')],
    example: [row(exact, 'available'), row('example.dev', 'available')],
  };
  let comparisonFailed = false;
  const client = hostedClient('test', { env: { DOMAIN_HOUND_API_URL: 'https://api.example.test' }, fetchFn: async url => {
    const name = url.searchParams.get('name');
    if (comparisonFailed && name === 'example') return new Response(null, { status: 429 });
    return Response.json({ version: 1, query: { name: 'example', ascii: 'example', exactDomain: name === exact ? exact : null },
      complete: true, domains: checks[name], choice: { pick: null } });
  } });
  async function receipt() {
    const check = await client.check(exact, [], AbortSignal.timeout(2000));
    const data = hostedResult([check], {});
    const result = await pages(data, {});
    assert.doesNotMatch(result.say + JSON.stringify(result.checks), /example\.dev/);
    return (await readFile(new URL(result.resultPage), 'utf8')).split('<body>')[1];
  }
  const first = await receipt();
  assert.match(first, /example\.ai is taken\./);
  assert.match(first, /Available instead/);
  assert.match(first, /data-domain="example\.dev"/);
  assert.doesNotMatch(first, /data-domain="example\.ai"/);
  comparisonFailed = true;
  const failed = await receipt();
  assert.match(failed, /Couldn’t check other endings/);
  assert.doesNotMatch(failed, /All checked endings are taken/);
});

test('scored ideas keep page order and the same saved page updates in place', async t => {
  const { directory, pages } = await tempPages(t);
  const { generatedChecks, hostedResult } = await import('./hosted-results.mjs');
  const entries = ['heron', 'otter'].map((name, index) => {
    const domain = name + '.dev';
    return { name, domains: [{ domain, status: 'available', prices: [] }],
      domain: { domain, shop: 'Dynadot', minimumYears: 1, firstPaymentUsd: 8, renewalUsd: 12,
        threeYearUsd: 32, buyUrl: shopSearchUrl('dynadot', domain) },
      score: { total: 60 + index, band: 'Workable', reasons: ['Available .dev'] } };
  });
  const output = (stage, pending) => {
    const generation = { names: entries, stage, checkedAt: at, complete: !pending, priceSnapshot: { checkedAt: at } };
    return hostedResult(generatedChecks(generation), {}, generation, { pending });
  };
  const initial = await pages(output('initial', true), {}, { refresh: true });
  const first = await readFile(new URL(initial.resultPage), 'utf8');
  assert.ok(first.indexOf('<h2>heron') < first.indexOf('<h2>otter'));
  const final = await pages(output('final', false), {}, { reuse: initial.resultPage });
  assert.equal(final.resultPage, initial.resultPage);
  assert.ok(!(await readdir(directory)).some(file => file.startsWith('session-')));
  const html = await readFile(new URL(final.resultPage), 'utf8');
  assert.ok(html.indexOf('<h2>otter') < html.indexOf('<h2>heron'));
  assert.match(html, /Name score 61\/100/);
  assert.match(html, /Why this name\?/);
  assert.match(html, /Price list dated 24 Nov 2026/);
  assert.match(html, /Buy at Dynadot/);
  assert.doesNotMatch(html, /http-equiv="refresh"/);
  assert.deepEqual(final.checks.map(check => check.query.name), ['heron', 'otter']);
});
