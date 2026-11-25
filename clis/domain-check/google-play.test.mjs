import '../../test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, test } from 'node:test';
import 'parse5'; // Fail at startup if the fallback's parser is missing.
import { searchAndroidApps } from './google-play.mjs';

const now = new Date('2026-11-24T12:00:00Z');
// The shared fixture plus an encoded entity and a repeated card, as Google serves them.
const searchHtml = readFileSync(new URL('./fixtures/google-play.html', import.meta.url), 'utf8')
  .replace('Example Studio', 'Example &amp; Studio')
  .replace('</section>', '<a href="/store/apps/details?id=test.example.cloudotter.second">' +
    '<span class="DdYX5">Cloud Otter</span><span class="wMUdtb">Example &amp; Studio</span></a></section>');
const detailsHtml = id => '<script type="application/ld+json">' + JSON.stringify({
  '@type': 'SoftwareApplication', url: 'https://play.google.com/store/apps/details?id=' + id,
  aggregateRating: { ratingCount: '120' }, applicationCategory: 'PRODUCTIVITY',
}) + '</script>';
const noBrowser = async () => { throw new Error('Fixture has no browser'); };

async function cache(t) {
  const path = await mkdtemp(join(tmpdir(), 'hound-play-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return pathToFileURL(path + '/');
}

function unexpectedFetch() {
  throw new Error('Unexpected live network request');
}

beforeEach(t => {
  const fetch = t.mock.method(globalThis, 'fetch', unexpectedFetch);
  t.after(() => assert.equal(fetch.mock.callCount(), 0, 'Google Play fixtures must use the injected fetcher'));
});

function playFetcher(searchBody, calls = []) {
  return async (value, init) => {
    const url = new URL(value);
    calls.push({ url, init });
    assert.equal(url.origin, 'https://play.google.com');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    if (url.pathname === '/store/search') return new Response(searchBody(url), { headers: { 'content-type': 'text/html' } });
    if (url.pathname === '/store/apps/details') return new Response(detailsHtml(url.searchParams.get('id')));
    return new Response(null, { status: 404 });
  };
}

function quietConsole(t) {
  const lines = [];
  for (const method of ['log', 'warn', 'error', 'info', 'debug']) {
    t.mock.method(console, method, (...values) => lines.push(values.join(' ')));
  }
  // Node prints its own process warnings through console.error.
  return () => assert.deepEqual(lines.filter(line => !line.startsWith('(node:')), []);
}

test('reads server-rendered Google Play cards without a browser and caches them', async t => {
  const consoleStaysQuiet = quietConsole(t);
  const directory = await cache(t);
  const calls = [];
  const options = { directory, now, launch: noBrowser, fetcher: playFetcher(() => searchHtml, calls) };
  const names = new Map([['cloudotter', 'Cloud Otter']]);
  const apps = (await searchAndroidApps(names, options)).get('cloudotter');
  assert.deepEqual(apps, [
    { name: 'Cloud Otter: Deployments', seller: 'Example Tools Inc.', ratings: 120, category: 'PRODUCTIVITY', description: '',
      url: 'https://play.google.com/store/apps/details?id=test.example.cloudotter' },
    { name: 'Cloud Otter', seller: 'Example & Studio', ratings: 120, category: 'PRODUCTIVITY', description: '',
      url: 'https://play.google.com/store/apps/details?id=test.example.cloudotter.second' },
  ]);
  const search = calls.find(call => call.url.pathname === '/store/search').url;
  assert.deepEqual(Object.fromEntries(search.searchParams), { q: 'Cloud Otter', c: 'apps', hl: 'en', gl: 'US' });
  assert.equal(calls.filter(call => call.url.pathname === '/store/apps/details').length, 2);
  const cachedFetch = t.mock.fn(unexpectedFetch);
  assert.deepEqual(await searchAndroidApps(names, { ...options, fetcher: cachedFetch }), new Map([['cloudotter', apps]]));
  assert.equal(cachedFetch.mock.callCount(), 0);
  consoleStaysQuiet();
});

test('keeps known empty Play searches and drops unknown pages or providers', async t => {
  const consoleStaysQuiet = quietConsole(t);
  const directory = await cache(t);
  const searches = new Map();
  const fetcher = playFetcher(url => {
    const query = url.searchParams.get('q');
    searches.set(query, (searches.get(query) ?? 0) + 1);
    if (query === 'Moss Finch') return '<section><div><span>No results for <b>Moss Finch</b></span></div>' +
      '<a href="/store/apps/details?id=test.example.suggested"><span class="DdYX5">Moss Finch</span>' +
      '<span class="wMUdtb">Example</span></a></section>';
    return '<h1>Something went wrong</h1>';
  });
  const names = new Map([['mossfinch', 'Moss Finch'], ['willowsail', 'Willow Sail']]);
  const results = await searchAndroidApps(names, { directory, now, launch: noBrowser, fetcher });
  assert.deepEqual(results, new Map([['mossfinch', []]]));
  assert.deepEqual(Object.fromEntries(searches), { 'Moss Finch': 1, 'Willow Sail': 2 });
  const unavailable = await searchAndroidApps(new Map([['softsparrow', 'Soft Sparrow']]),
    { directory, now, launch: noBrowser, fetcher: async () => new Response('busy', { status: 503 }) });
  assert.deepEqual(unavailable, new Map());
  consoleStaysQuiet();
});

test('uses the server-rendered fallback only when the browser cannot start', async t => {
  const consoleStaysQuiet = quietConsole(t);
  const directory = await cache(t);
  const page = {
    context: () => ({}), goto: async () => ({ ok: () => true }),
    url: () => 'https://play.google.com/store/search?q=Cloud+Otter',
    waitForFunction: async () => ({ jsonValue: async () => [] }), close: async () => {},
  };
  const launch = async () => ({ newContext: async () => ({ newPage: async () => page }), close: async () => {} });
  const fetcher = t.mock.fn(unexpectedFetch);
  const results = await searchAndroidApps(new Map([['cloudotter', 'Cloud Otter']]), {
    directory, now, launch, fetcher,
  });
  assert.deepEqual(results, new Map([['cloudotter', []]]));
  assert.equal(fetcher.mock.callCount(), 0);
  consoleStaysQuiet();
});
