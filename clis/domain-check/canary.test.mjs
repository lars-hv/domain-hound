import '../../test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { countingFetch, nameChecks, priceChecks, randomLabel, registryChecks, registryEndings, requestLimit, summarize }
  from '../../scripts/canary.mjs';

const now = new Date('2026-11-24T06:17:00Z');
const checkedAt = now.toISOString();
const label = 'qwertyuiopasdfghjk';

test('the canary uses an 18-letter random name and refuses its 60th request while spacing Google hosts', async () => {
  assert.match(randomLabel(), /^[a-z]{18}$/);
  assert.equal(randomLabel(4, () => 0), 'aaaa');
  assert.equal(requestLimit, 59);
  const waits = [];
  const fetcher = countingFetch(async () => new Response('ok'), { limit: 3, spacing: 600, wait: async ms => { waits.push(ms); } });
  await fetcher('https://pubapi.registry.google/rdap/domain/example.app');
  await fetcher('https://www.google.com/complete/search?q=example');
  await fetcher('https://rdap.verisign.com/com/v1/domain/example.com');
  await assert.rejects(fetcher('https://itunes.apple.com/search?term=example'), /budget of 3 reached/);
  assert.equal(fetcher.count, 3);
  assert.equal(fetcher.refused, 1);
  assert.deepEqual(fetcher.hosts, { 'pubapi.registry.google': 1, 'www.google.com': 1, 'rdap.verisign.com': 1 });
  assert.equal(waits.length, 1);
  assert.ok(waits[0] > 0 && waits[0] <= 600);
});

test('each keyless live price list must be refreshed and at most three days old', () => {
  const prices = { com: { shop: 'x', firstYear: 9, renewal: 10 } };
  const fresh = { catalogs: { spaceship: { checkedAt, prices }, porkbun: { checkedAt, prices }, dynadot: { checkedAt, prices } } };
  assert.ok(priceChecks(fresh, now).every(check => check.ok));
  const old = new Date(+now - 4 * 86_400_000).toISOString();
  const checks = priceChecks({ catalogs: { porkbun: { checkedAt: old, prices }, dynadot: { checkedAt, prices },
    gandi: { checkedAt, prices: { so: prices.com } } } }, now);
  assert.deepEqual(checks.map(check => [check.source, check.ok]), [['Porkbun price list', false],
    ['Dynadot price list', true], ['Gandi price list', true]]);
  assert.equal(checks[0].detail, 'last refreshed ' + old);
  assert.equal(priceChecks(null, now)[1].detail, 'no valid prices returned');
});

test('every registry must settle the random name as free, google.com must be taken and list prices must be fresh', () => {
  const listPrices = Object.fromEntries(registryEndings.map(ending => [ending, { now: 9, renew: 10, shop: 'Spaceship' }]));
  const good = { priceListDate: '2026-11-24', listPrices, names: [
    { name: label, free: registryEndings.map(d => ({ d, s: 'nc' })) }, { name: 'google.com', taken: ['com'] }] };
  assert.ok(registryChecks(good, label, { now }).every(check => check.ok));
  const bad = { priceListDate: '2026-11-20', listPrices, names: [
    { name: label, free: registryEndings.filter(d => !['app', 'io'].includes(d)).map(d => ({ d, s: 'nc' })), shop_check: ['app'], taken: ['io'] },
    { name: 'google.com', free: [{ d: 'com', s: 'nc' }] }], shopCheckWhy: { app: 'Google Registry rate limit (HTTP 429)' } };
  const failed = registryChecks(bad, label, { now }).filter(check => !check.ok);
  assert.deepEqual(failed.map(check => check.source), ['Registry .app (Google Registry)', 'Registry .io (Identity Digital)',
    'Registry google.com (taken control)', 'check_domains list prices']);
  assert.equal(failed[0].detail, label + '.app came back unsettled: Google Registry rate limit (HTTP 429)');
  assert.equal(failed[1].detail, label + '.io came back taken');
  assert.match(failed[3].detail, /list date 2026-11-20/);
  assert.deepEqual(registryChecks({ error: 'Enter a valid name' }, label, { now }),
    [{ source: 'check_domains', ok: false, detail: 'Enter a valid name' }]);
});

test('the famous-name screen needs a live US mark, an App Store app and Google suggestions', () => {
  const sources = { USPTO: 100, 'App Store': 100 };
  const triage = { names: [{ competition: { US: 'Exact: SPOTIFY', AppStore: { name: 'Spotify' } } }], sources };
  assert.ok(nameChecks({ triage, suggestions: ['spotify', 'spotify premium'] }).every(check => check.ok));
  const failed = nameChecks({ triage: { names: [{}], sources: { 'App Store': 100 } }, suggestions: null });
  assert.deepEqual(failed.map(check => [check.source, check.ok, check.detail]), [
    ['USPTO trademark search', false, 'source did not answer'], ['iTunes Search (App Store)', false, 'no app named Spotify'],
    ['Google autocomplete', false, 'source did not answer']]);
});

test('a redirected request is counted and loses headers at the destination', async () => {
  const observed = [];
  const fetcher = countingFetch(async (url, init) => {
    observed.push([url, init]);
    return observed.length === 1 ? Response.redirect('https://second.example/tld', 302) : new Response('live');
  });
  const response = await fetcher('https://first.example/tld', { method: 'POST', body: '{}', headers: { Example: 'test' } });
  assert.equal(await response.text(), 'live');
  assert.equal(fetcher.count, 2);
  assert.deepEqual(observed[1], ['https://second.example/tld', { method: 'GET', headers: undefined, redirect: 'manual' }]);
});

test('the summary names every broken source, and the request budget is a failure of its own', () => {
  const summary = summarize([{ source: 'Registry .app (Google Registry)', ok: false }, { source: 'USPTO trademark search', ok: true },
    { source: 'Porkbun price list', ok: false }], { checkedAt, requests: 60, refused: 1 });
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.failures, ['Registry .app (Google Registry)', 'Porkbun price list', 'Request budget']);
  const passing = summarize([{ source: 'USPTO trademark search', ok: true }], { checkedAt, requests: 21 });
  assert.deepEqual([passing.ok, passing.failures, passing.requests], [true, [], 21]);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(summary)));
});

test('the canary workflow runs daily at 06:17 UTC and on demand, and opens or updates one issue per broken source', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/canary.yml', import.meta.url), 'utf8');
  assert.match(workflow, /schedule:\r?\n\s+- cron: '17 6 \* \* \*'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\r?\n\s+contents: read\r?\n\s+issues: write/);
  assert.match(workflow, /node-version: lts\/\*/);
  assert.match(workflow, /node scripts\/canary\.mjs/);
  assert.match(workflow, /Canary: \$\{source\} broken|"Canary: \$source broken"/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(workflow, /secrets\./);
});
