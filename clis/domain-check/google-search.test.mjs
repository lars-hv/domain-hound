import '../../test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  appStoreSearchLink, braveSearch, classifyGoogle, googleSearchLink, lowerVerdict,
  playSearchLink, searchGoogle, serperSearch,
} from './google-search.mjs';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/google-autocomplete.json', import.meta.url)));
const now = new Date('2026-11-24T12:00:00Z');
const day = 86_400_000;

async function cache(t) {
  const path = await mkdtemp(join(tmpdir(), 'hound-google-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return pathToFileURL(path + '/');
}

function autocompleteFixture(value) {
  const url = new URL(value);
  if (url.hostname === 'www.google.com') {
    assert.equal(url.pathname, '/complete/search');
    assert.equal(url.searchParams.get('client'), 'chrome');
    const name = url.searchParams.get('q');
    return Response.json([name, fixtures[name]?.suggestions ?? []]);
  }
  assert.equal(url.hostname, 'trends.google.com');
  assert.match(url.pathname, /^\/trends\/api\/autocomplete\/[a-z]+$/);
  const name = url.pathname.split('/').at(-1);
  return new Response(")]}',\n" + JSON.stringify({ default: { topics: fixtures[name]?.topics ?? [] } }));
}

test('no-key fixtures identify Notion, RouteMender AI and open Zarquelt with exact matching', async t => {
  const options = { directory: await cache(t), env: {}, now,
    fetcher: async (value, init) => {
      assert.match(init.headers['User-Agent'], /^DomainHound\//);
      assert.equal(init.redirect, 'error');
      return autocompleteFixture(value);
    } };
  const get = (name, sameBusiness) =>
    searchGoogle(name, name, { ...options, entities: fixtures[name].entities, sameBusiness });
  assert.deepEqual(await get('notion', description => description.includes('team productivity')),
    { google: { result: 'owned by Notion', sameBusiness: true } });
  assert.deepEqual(await get('notion'), { google: { result: 'owned by Notion' } });
  assert.deepEqual(await get('routemender'), { google: { result: 'crowded' } });
  assert.deepEqual(await get('zarquelt'), { google: { result: 'open' } });
  assert.deepEqual(classifyGoogle('zarquelt', { suggestions: ['zarquelt.com'], topics: [], entities: [] }),
    { result: 'owned by zarquelt' });
  assert.deepEqual(classifyGoogle('zarquelt', { suggestions: ['zarquelt app', 'zarquelt login', 'zarquelt pricing'] }),
    { result: 'owned by zarquelt' });
  const row = { verdict: 'No conflict found', reason: 'No competing app found' };
  assert.ok(lowerVerdict(row, { result: 'owned by Notion' }));
  assert.equal(row.verdict, 'Check first');
  assert.ok(lowerVerdict(row, { result: 'owned by Notion', sameBusiness: true }));
  assert.equal(row.verdict, 'Avoid');
  assert.equal(lowerVerdict(row, { result: 'crowded' }), false);
});

test('shares endpoint attempts across concurrent callers and caches for a rolling 24 hours', async t => {
  const calls = [];
  const options = { directory: await cache(t), env: {}, now, entities: [],
    fetcher: async value => { calls.push(value); return autocompleteFixture(value); } };
  // Import a separate instance so only the file claim, not the in-process promise, is shared.
  const other = await import('./google-search.mjs?separate-cache-consumer');
  const query = () => searchGoogle('zarquelt', 'Zarquelt', options);
  const results = await Promise.all([query(), query(), other.searchGoogle('zarquelt', 'ZARQUELT', options)]);
  assert.deepEqual(results, Array(3).fill({ google: { result: 'open' } }));
  assert.equal(calls.length, 2);
  assert.deepEqual(await searchGoogle('zarquelt', 'ZARQUELT', { ...options, now: new Date(+now + day - 1) }),
    { google: { result: 'open' } });
  assert.equal(calls.length, 2);
  assert.deepEqual(await searchGoogle('zarquelt', 'Zarquelt', { ...options, now: new Date(+now + day) }),
    { google: { result: 'open' } });
  assert.equal(calls.length, 4);
});

test('backs off one endpoint on 429 without claiming open from missing data', async t => {
  const calls = [];
  const options = { directory: await cache(t), env: {}, now, entities: [],
    fetcher: async value => {
      const url = new URL(value);
      calls.push(url.hostname);
      if (url.hostname === 'trends.google.com') return new Response(null, { status: 429, headers: { 'Retry-After': '7200' } });
      return autocompleteFixture(value);
    } };
  assert.equal((await searchGoogle('zarquelt', 'zarquelt', options)).google, undefined);
  assert.equal((await searchGoogle('zarquelt', 'zarquelt', options)).google, undefined);
  assert.equal((await searchGoogle('violetdesk', 'violetdesk', options)).google, undefined);
  assert.equal(calls.filter(host => host === 'trends.google.com').length, 1);
  assert.equal(calls.filter(host => host === 'www.google.com').length, 2);
  await searchGoogle('sparedesk', 'sparedesk', { ...options, now: new Date(+now + 7200_000) });
  assert.equal(calls.filter(host => host === 'trends.google.com').length, 2);
});

test('optional Brave and Serper each add one quoted query with a header key', async t => {
  const calls = [];
  const env = { DOMAIN_HOUND_BRAVE_SEARCH_KEY: 'fixture-brave', DOMAIN_HOUND_SERPER_KEY: 'fixture-serper' };
  const options = { directory: await cache(t), env, now, entities: [],
    sameBusiness: description => description.includes('accounting'),
    fetcher: async (value, init) => {
      calls.push(value);
      assert.ok(!Object.values(env).some(key => value.includes(key)));
      if (value.startsWith(braveSearch)) {
        assert.equal(new URL(value).searchParams.get('q'), '"VioletDesk"');
        assert.equal(init.headers['X-Subscription-Token'], env.DOMAIN_HOUND_BRAVE_SEARCH_KEY);
        return Response.json({ web: { results: [] } });
      }
      if (value === serperSearch) {
        assert.equal(init.method, 'POST');
        assert.equal(JSON.parse(init.body).q, '"VioletDesk"');
        assert.equal(init.headers['X-API-KEY'], env.DOMAIN_HOUND_SERPER_KEY);
        return Response.json({ organic: [{ title: 'VioletDesk', link: 'https://violetdesk.example/', snippet: 'accounting' }] });
      }
      return autocompleteFixture(value);
    } };
  assert.deepEqual(await searchGoogle('violetdesk', 'VioletDesk', options),
    { google: { result: 'owned by VioletDesk', sameBusiness: true } });
  assert.equal(calls.length, 4);
  await searchGoogle('violetdesk', 'VioletDesk', options);
  assert.equal(calls.length, 4);
});

test('the applet can open only direct name searches on each trusted source', () => {
  const cli = fileURLToPath(new URL('./index.mjs', import.meta.url));
  const run = url => spawnSync(process.execPath, [cli, '--open', '--dry-run', url], { encoding: 'utf8' });
  for (const makeLink of [googleSearchLink, appStoreSearchLink, playSearchLink]) {
    const link = makeLink('Violet Desk');
    assert.deepEqual(JSON.parse(run(link).stdout), { opened: false, url: link });
    assert.equal(run(link + '&next=https://example.test').status, 1);
  }
});
