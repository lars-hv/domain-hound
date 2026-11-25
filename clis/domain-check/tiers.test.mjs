import '../../test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkText, topPicks } from '../../display.mjs';
import { resultPages } from '../../results.mjs';
import { readShareFragment } from '../../site/r/share-format.mjs';
import { lightTargets } from './index.mjs';
import { defaultEndings, endingTier, fallbackEndings, mainstreamEndings, pickName, rankName } from './name-search.mjs';
import { tierBestValue } from './triage.mjs';

// Synthetic fixture prices from the 0.1.6 live check: .com $9.48 then $10.68 ($30.84 in 3 years) against
// .xyz $1.50 then $14.45 ($30.40 in 3 years). 0.1.6 chose .xyz for the pick, Cheapest and Best value.
const at = '2026-11-25T12:00:00.000Z';
const prices = ({ com, xyz } = {}) => ({
  com: { now: 9.48, renew: 10.68, y3: 30.84, shop: 'Spaceship', ...com },
  xyz: { now: 1.5, renew: 14.45, y3: 30.4, jump: true, shop: 'Dynadot', ...xyz },
});
const free = endings => endings.map(d => ({ d, s: 'nc' }));
const lookup = (names, listPrices = prices()) => ({ checkedAt: at, priceListDate: at.slice(0, 10), listPrices, names });
const both = name => ({ name, free: free(['xyz', 'com']) });

async function receipt(t, data, args = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hound-tiers-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const result = await resultPages({ directory, env: { DOMAIN_HOUND_OPEN: 'off' } })(data, args);
  const page = new URL(result.resultPage);
  const html = await readFile(page, 'utf8');
  const md = await readFile(new URL(page.href.replace(/\.html$/, '.md')), 'utf8');
  const link = html.match(/href="(https:\/\/domainhound\.dev\/r\/#[A-Za-z0-9_.-]+)">Share<\/a>/)?.[1];
  assert.ok(link);
  return { say: result.say, html, md, shared: await readShareFragment(new URL(link).hash) };
}
const cards = shared => shared.groups.map(({ records }) => ({ pick: records.find(row => row.pick)?.domain ?? null,
  value: records.filter(row => 'bestValue' in row).map(row => row.domain + ' ' + row.bestValue),
  rows: records.map(row => row.domain + (row.jump ? ' jump' : '')) }));

test('the dossier tiers are the one shared list: mainstream first, .xyz and .tech as fallback', () => {
  assert.deepEqual(mainstreamEndings, ['com', 'ai', 'si', 'io', 'app', 'dev', 'me', 'co', 'net', 'org']);
  assert.deepEqual(fallbackEndings, ['xyz', 'tech']);
  assert.equal(endingTier('a.xyz'), 1);
  assert.equal(endingTier('a.tech'), 1);
  assert.equal(endingTier('a.com'), 0);
  for (const domain of ['a.so', 'a.no', 'a.de', 'a.co.uk', 'a.eu']) assert.equal(endingTier(domain), 2, domain);
  assert.equal(endingTier('a.no', [], ['no']), 0);
  assert.equal(endingTier('a.xyz', ['xyz']), 0);
  assert.equal(endingTier('a.xyz', ['a.xyz']), 0);
});

test('baseline prices: pick, Cheapest and Best value are .com, and every row, flag and link stays', async t => {
  const { say, html, md, shared } = await receipt(t, lookup([both('exampleheron'), both('examplewren')]));
  assert.match(say, /^1\. exampleheron\.com \$9\.48, then \$10\.68 list price/m);
  assert.match(say, /^2\. examplewren\.com \$9\.48, then \$10\.68 list price/m);
  assert.match(say, /^Cheapest: \[exampleheron\.com\]\(https:\/\/www\.spaceship\.com\/domain-search\/\?query=exampleheron\.com\) \$9\.48/m);
  assert.match(say, /^Best value: exampleheron\.com, \$30\.84 in payments due in 3 years/m);
  // $0.44 is no reason to mention the fallback.
  assert.doesNotMatch(say, /\.xyz|^Fallback:/m);
  for (const domain of ['exampleheron.com', 'exampleheron.xyz', 'examplewren.com', 'examplewren.xyz']) {
    assert.ok(md.includes('| ' + domain + ' |'), domain);
    assert.ok(html.includes('<code>' + domain + '</code>'), domain);
  }
  // Within the free rows, the top tier comes first; the fallback keeps its price, jump and checkout link.
  assert.ok(md.indexOf('| exampleheron.com |') < md.indexOf('| exampleheron.xyz |'));
  assert.match(md, /\| exampleheron\.xyz \| \$1\.50 \| \$14\.45 \| .*Renewal jumps.*\(https:\/\/www\.dynadot\.com\/domain\/search\?domain=exampleheron\.xyz\) \|/);
  for (const card of cards(shared)) {
    const label = card.pick.split('.')[0];
    assert.deepEqual(card, { pick: label + '.com', value: [label + '.com 30.84'],
      rows: [label + '.com', label + '.xyz jump', ...card.rows.slice(2)] });
    assert.equal(card.rows.length, defaultEndings.length);
  }
});

test('a fallback saving more than $10 over 3 years gets one separate line; exactly $10 does not', async t => {
  // 40.02 - 30.02 is 10.000000000000004 in floating point; in cents it is exactly 1000, so no line.
  const exact = await receipt(t, lookup([both('exampleheron')],
    prices({ com: { renew: 15.27, y3: 40.02 }, xyz: { renew: 14.26, y3: 30.02 } })));
  assert.match(exact.say, /^1\. exampleheron\.com /m);
  assert.match(exact.say, /^Best value: exampleheron\.com, \$40\.02 in payments/m);
  assert.doesNotMatch(exact.say, /^Fallback:/m);

  const more = await receipt(t, lookup([both('exampleheron')],
    prices({ com: { renew: 15.28, y3: 40.04 }, xyz: { renew: 14.26, y3: 30.02 } })));
  assert.match(more.say, /^1\. exampleheron\.com /m);
  assert.match(more.say, /^Cheapest: \[exampleheron\.com\]/m);
  assert.match(more.say, /^Best value: exampleheron\.com, \$40\.04 in payments due in 3 years.*\nFallback: exampleheron\.xyz, \$30\.02 in 3 years, saves \$10\.02\.$/m);
  assert.equal(more.say.match(/^Fallback:/gm).length, 1);
  assert.match(more.html, /<div class="comparison">.*Fallback: exampleheron\.xyz.*<\/div>/s);
  assert.deepEqual(cards(more.shared)[0].value, ['exampleheron.com 40.04']);
});

test('batch picks follow the best offer for each name and use only the top available tier', async t => {
  const names = [
    { name: 'examplewren', free: free(['com']) },
    { name: 'exampleheron', free: free(['xyz', 'co', 'so']) },
    { name: 'examplefinch', free: free(['xyz']) },
  ];
  const { say, shared } = await receipt(t, lookup(names, { ...prices(),
    co: { now: 3.11, renew: 31.05, jump: true }, so: { now: 1, renew: 2 } }));
  assert.match(say, /^1\. exampleheron\.co \$3\.11, then \$31\.05 \(renewal jumps\)/m);
  assert.match(say, /^2\. examplewren\.com \$9\.48/m);
  assert.doesNotMatch(say, /^3\.|examplefinch\.xyz|exampleheron\.so/m);
  assert.match(say, /^Cheapest: \[exampleheron\.co\]/m);
  assert.match(say, /^Best value: examplewren\.com, \$30\.84/m);
  assert.deepEqual(cards(shared).map(card => card.pick), ['examplewren.com', 'exampleheron.co', 'examplefinch.xyz']);
  assert.deepEqual(cards(shared)[1].rows.slice(0, 3), ['exampleheron.co jump', 'exampleheron.xyz jump', 'exampleheron.so']);
});

test('a fallback ending is chosen when it is the only free ending in scope, or within budget', async t => {
  const only = await receipt(t, lookup([{ name: 'examplewren', taken: ['com'], free: free(['xyz']) }]));
  assert.match(only.say, /^1\. examplewren\.xyz \$1\.50, then \$14\.45 \(renewal jumps\)/m);
  assert.match(only.say, /^Cheapest: \[examplewren\.xyz\]/m);
  assert.match(only.say, /^Best value: examplewren\.xyz, \$30\.40 in payments/m);
  assert.doesNotMatch(only.say, /^Fallback:/m);
  assert.equal(cards(only.shared)[0].pick, 'examplewren.xyz');

  const capped = await receipt(t, lookup([both('exampleheron')]), { budget: 5 });
  assert.match(capped.say, /Pick: exampleheron\.xyz \$1\.50/);
  assert.match(capped.say, /^Best value: exampleheron\.xyz, \$30\.40/m);
});

test('an explicitly requested fallback ending or exact domain is never demoted', async t => {
  const asked = await receipt(t, lookup([both('exampleheron')]), { endings: ['xyz'] });
  assert.match(asked.say, /\.xyz first\. 1\. exampleheron\.xyz \$1\.50/);
  assert.match(asked.say, /^Cheapest: \[exampleheron\.xyz\]/m);
  assert.match(asked.say, /^Best value: exampleheron\.xyz, \$30\.40/m);

  // Both asked for: the pick follows the person's order; cheapest and best value compare both as equals.
  const order = await receipt(t, lookup([both('exampleheron')]), { endings: ['com', 'xyz'] });
  assert.match(order.say, /\.com, \.xyz first\. 1\. exampleheron\.com \$9\.48/);
  assert.match(order.say, /^Cheapest: \[exampleheron\.xyz\]/m);
  assert.match(order.say, /^Best value: exampleheron\.xyz, \$30\.40/m);
  assert.doesNotMatch(order.say, /^Fallback:/m);

  const typed = await receipt(t, lookup([{ name: 'examplewren.xyz', free: free(['xyz']) }, both('exampleheron')]));
  assert.match(typed.say, /^1\. examplewren\.xyz \$1\.50/m);
  assert.match(typed.say, /^2\. exampleheron\.com \$9\.48/m);
  assert.match(typed.say, /^Cheapest: \[examplewren\.xyz\]/m);
  assert.match(typed.say, /^Best value: examplewren\.xyz, \$30\.40/m);
});

test('best value never falls back silently when a top-tier free row lacks a three-year price', async t => {
  const quoteOnly = { name: 'exampleheron', free: [{ d: 'com', s: 'ok', now: 18, shop: 'Dynadot' }, { d: 'xyz', s: 'nc' }] };
  const { say, shared } = await receipt(t, lookup([quoteOnly]));
  assert.match(say, /^1\. exampleheron\.com \$18\.00, renewal at shop/m);
  assert.match(say, /^Cheapest: \[exampleheron\.com\]/m);
  assert.match(say, /^Best value: needs a shop quote\.$/m);
  assert.doesNotMatch(say, /^Fallback:/m);
  assert.deepEqual(cards(shared)[0].value, []);
});

const row = (domain, firstPayment, threeYear, status = 'probably-free') => ({ domain, tld: domain.slice(domain.indexOf('.') + 1),
  exact: true, status, price: firstPayment, renewal: 1, firstPayment, threeYear });

test('the light-confirm pick and row ranking follow the tiers, upfront payment within each tier', () => {
  const rows = [row('exampleheron.xyz', 1.5, 30.4), row('exampleheron.tech', 6.64, 111.94),
    row('exampleheron.ai', 340, 700), row('exampleheron.com', 9.48, 30.84)];
  assert.deepEqual(rankName(rows).map(item => item.domain), ['exampleheron.com', 'exampleheron.ai', 'exampleheron.xyz', 'exampleheron.tech']);
  assert.equal(pickName(rows).domain, 'exampleheron.com');
  assert.deepEqual(lightTargets(rows, [], 4).map(item => item.domain), ['exampleheron.com', 'exampleheron.ai', 'exampleheron.xyz', 'exampleheron.tech']);
  assert.equal(lightTargets(rows, [], 1, ['xyz'])[0].domain, 'exampleheron.xyz');
  assert.equal(lightTargets(rows, [], 1, [], 5)[0].domain, 'exampleheron.xyz');
  assert.equal(lightTargets([row('exampleheron.com', 9.48, 30.84), row('examplewren.xyz', 1.5, 30.4)], [], 1, [], undefined,
    ['examplewren.xyz'])[0].domain, 'examplewren.xyz');
  assert.equal(pickName([row('examplewren.com', null, null, 'taken'), row('examplewren.xyz', 1.5, 30.4)]).domain, 'examplewren.xyz');
  // Eligibility opt-in lets .no compete with the mainstream tier.
  const norway = [row('exampleheron.com', 9.48, 30.84), row('exampleheron.no', 7.97, 23.91)];
  assert.equal(pickName(norway).domain, 'exampleheron.com');
  assert.equal(pickName(norway, ['no']).domain, 'exampleheron.no');
});

test('structured best value stays in the top tier and needs a quote rather than falling back', () => {
  const rows = [row('exampleheron.com', 9.48, 30.84), row('exampleheron.xyz', 1.5, 30.4)];
  assert.equal(tierBestValue(rows).domain, 'exampleheron.com');
  assert.equal(tierBestValue(rows, ['xyz']).domain, 'exampleheron.xyz');
  assert.equal(tierBestValue([row('exampleheron.com', 18, null), rows[1]]), undefined);
  assert.equal(tierBestValue([rows[1]]).domain, 'exampleheron.xyz');
  assert.equal(tierBestValue([]), undefined);
});

test('legacy check and screen displays pick within the top tier', () => {
  const { display } = JSON.parse(checkText({ names: [both('exampleheron')], listPrices: prices() }));
  assert.match(display, /^Cheapest now: exampleheron\.com\nBest value: exampleheron\.com, \$30\.84 over 3 years$/m);
  assert.match(display, /exampleheron\.xyz/);
  const asked = JSON.parse(checkText({ names: [both('exampleheron')], listPrices: prices() }, false, { preferred: ['xyz'] }));
  assert.match(asked.display, /^Cheapest now: exampleheron\.xyz\nBest value: exampleheron\.xyz, \$30\.40 over 3 years$/m);
  const names = ['Example Heron', 'Example Wren', 'Quiet Otter'].map(name => ({ name, verdict: 'Check first', free: ['xyz', 'com'] }));
  names[1].free = ['xyz'];
  const picks = topPicks({ names, prices: prices() });
  assert.deepEqual(picks.map(pick => pick.domain), ['exampleheron.com', 'quietotter.com', 'examplewren.xyz']);
  assert.ok(picks.every(pick => !('tier' in pick)));
});
