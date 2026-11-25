import './test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { searchCandidates, defaultEndings } from './clis/domain-check/name-search.mjs';
import { backgroundCommand, resultPages } from './results.mjs';
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
  assert.match(lines[0], /^\.com first.*\$20\.00 today.*cedarheron\.com \$12\.00, then \$14\.00/);
  assert.match(result.say, /Keep Paper Heron\? Avoid\./);
  assert.match(result.say, /iOS: no app with this name \| Android: check incomplete/);
  assert.match(result.say, /Best free rename: Cedar Heron/);
  assert.match(result.say, /Want it anyway\? \[Watch paperheron\.com\]/);
  assert.doesNotMatch(result.say, /[—–]|paperheron\.io|cedarheron\.no/);
  assert.equal(lines.at(-1), 'All endings: [Results page](' + result.resultPage + ')');

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
  assert.match(html, /likely free by DNS/);
  assert.match(html, /needs|eligibility required/);
  assert.match(html, /https:\/\/www\.spaceship\.com\/domain-search\/\?query=cedarheron\.com/);
  assert.doesNotMatch(html, /<script\b|query=cedarheron\.no|query=paperheron\.com/);
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
  assert.match(exact.say, /Over budget\.\nDomain Hound cannot buy or complete checkout\.\nNext: try a cheaper domain\./);
  assert.doesNotMatch(exact.say, /https:\/\//);
});

test('desktop opener skips headless environments and requests platform background behavior', async () => {
  const windowsPath = 'C:\\Temp\\receipt test (1).html';
  assert.equal(await backgroundCommand(windowsPath, {}, 'win32'), null);
  assert.equal(await backgroundCommand(windowsPath, { CI: 'true', SESSIONNAME: 'Console' }, 'win32'), null);
  assert.equal(await backgroundCommand(windowsPath, { DOMAIN_HOUND_OPEN: 'off', SESSIONNAME: 'Console' }, 'win32'), null);
  const [shell, flags] = await backgroundCommand(windowsPath, { SESSIONNAME: 'Console' }, 'win32');
  assert.equal(shell, 'powershell.exe');
  const script = Buffer.from(flags.at(-1), 'base64').toString('utf16le');
  assert.match(script, /ShellExecuteW\(\[IntPtr\]::Zero, 'open', \$file, \$null, \$null, 4\)/);
  assert.ok(script.includes(Buffer.from(windowsPath).toString('base64')));
  const localPath = join(tmpdir(), 'receipt test.html');
  const [gio, args, env] = await backgroundCommand(localPath, {
    WAYLAND_DISPLAY: 'wayland-0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/test',
    XDG_ACTIVATION_TOKEN: 'unused', DESKTOP_STARTUP_ID: 'unused',
  }, 'linux');
  assert.deepEqual([gio, args], ['gio', ['open', pathToFileURL(localPath).href]]);
  assert.equal(env.XDG_ACTIVATION_TOKEN, undefined);
  assert.equal(env.DESKTOP_STARTUP_ID, undefined);
  assert.equal(await backgroundCommand('/tmp/result.html', { DISPLAY: ':0' }, 'linux'), null);
});

test('a live website overrides the reported free registry status before progress or final output', async () => {
  const progress = [];
  const domain = 'paperheron.com';
  const results = await searchCandidates([{ name: 'paperheron', candidates: [{ domain, tld: 'com', exact: true }] }], {
    directory: null, cachedOnly: true, bundledCatalog: null, fetcher: async url => new URL(url).hostname === 'data.iana.org'
      ? Response.json({ services: [[['com'], ['https://rdap.example.test/']]] }) : new Response(null, { status: 404 }),
    resolveNs: async () => [], verifyFreeSite: async () => ({ state: 'live', host: 'www.example.com' }),
    onProgress: row => progress.push(row),
  });
  assert.equal(results.groups[0].results[0].status, 'taken');
  assert.equal(results.groups[0].results[0].source, 'web');
  assert.deepEqual(progress, [{ domain, status: 'taken' }]);
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
