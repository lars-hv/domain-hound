import '../../test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkText, topPicks } from '../../display.mjs';
import { resultPages } from '../../results.mjs';
import { readShareFragment } from '../../site/r/share-format.mjs';
import { pickAlternatives } from './dossier.mjs';
import { lightTargets } from './index.mjs';
import { bundledCatalog, datedListPrices, requestEndings, snapshotShops, targetEndings } from './price-catalog.mjs';
import { choosePick, comparePicks, defaultEndings, listQuote, pickCapUsd, pickName, qualityEndings, qualityRank, rankName } from './name-search.mjs';
import { bestValue } from './triage.mjs';

// Synthetic fixture prices from the 0.1.6 live check: .com $9.48 then $10.68 ($30.84 in 3 years) against
// .xyz $1.50 then $14.45 ($30.40 in 3 years). 0.1.6 chose .xyz for the pick.
const at = '2026-11-25T12:00:00.000Z';
const prices = ({ com, xyz, ...rest } = {}) => ({
  com: { now: 9.48, renew: 10.68, y3: 30.84, shop: 'Spaceship', ...com },
  xyz: { now: 1.5, renew: 14.45, y3: 30.4, jump: true, shop: 'Dynadot', ...xyz },
  ...rest,
});
// .ai pays two years at a time: $159.96 now, $319.92 due in 3 years.
const ai = { now: 159.96, renew: 159.96, y3: 319.92, term: 2, shop: 'Spaceship' };
const dev = { now: 8.28, renew: 12.42, y3: 33.12, shop: 'Spaceship' };
const free = endings => endings.map(d => ({ d, s: 'nc' }));
const lookup = (names, listPrices = prices()) => ({ checkedAt: at, priceListDate: at.slice(0, 10), listPrices, names });
const both = name => ({ name, free: free(['xyz', 'com']) });

async function receipt(t, data, args = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hound-quality-'));
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
  rows: records.map(row => row.domain + (row.jump ? ' jump' : '') + (row.dns ? ' cf' : '')) }));

test('one quality order: .com, .ai, .io, .dev, .app, .co, .so, .me, .si, then .xyz and .tech; .net and .org on request', () => {
  assert.deepEqual(qualityEndings, ['com', 'ai', 'io', 'dev', 'app', 'co', 'so', 'me', 'si', 'xyz', 'tech']);
  assert.equal(pickCapUsd, 60);
  assert.deepEqual(defaultEndings, ['com', 'ai', 'io', 'me', 'co', 'dev', 'app', 'si', 'so', 'no', 'xyz', 'tech']);
  assert.ok(!targetEndings.includes('net') && !targetEndings.includes('org'));
  assert.ok(requestEndings.includes('net') && requestEndings.includes('org'));
  const order = ['a.tech', 'a.org', 'a.no', 'a.me', 'a.com', 'a.xyz', 'a.net', 'a.so', 'a.ai', 'a.si', 'a.dev', 'a.io', 'a.co', 'a.app']
    .sort((a, b) => qualityRank(a) - qualityRank(b));
  assert.deepEqual(order, ['a.com', 'a.ai', 'a.io', 'a.dev', 'a.app', 'a.co', 'a.so', 'a.me', 'a.si', 'a.xyz', 'a.tech',
    'a.no', 'a.net', 'a.org']);
  // Asked-for endings and typed domains come first in the person's order; an eligibility opt-in follows .com.
  assert.ok(qualityRank('a.xyz', ['xyz']) < qualityRank('a.com', ['xyz']));
  assert.ok(qualityRank('a.xyz', ['a.xyz']) < qualityRank('a.com'));
  assert.ok(qualityRank('a.org', ['com', 'org']) > qualityRank('a.com', ['com', 'org']));
  assert.ok(qualityRank('a.no', [], ['no']) > qualityRank('a.com', [], ['no']));
  assert.ok(qualityRank('a.no', [], ['no']) < qualityRank('a.ai', [], ['no']));
});

test('the pick rule: best quality within $60 over 3 years, else the least paid over 3 years, never .ai by default', () => {
  const option = (domain, now, total) => ({ domain, now, total });
  const pick = (options, context) => choosePick(options, context)?.domain;
  assert.equal(pick([option('a.xyz', 1.5, 30.4), option('a.com', 9.48, 30.84)]), 'a.com');
  // Exactly $60 fits; a cent more does not.
  assert.equal(pick([option('a.com', 20, 60), option('a.dev', 8.28, 33.12)]), 'a.com');
  assert.equal(pick([option('a.com', 20, 60.01), option('a.dev', 8.28, 33.12)]), 'a.dev');
  // Nothing fits: the least paid over 3 years.
  assert.equal(pick([option('a.com', 30, 90), option('a.io', 25, 75), option('a.ai', 80, 70)]), 'a.io');
  // .ai only when asked for or within the person's budget.
  assert.equal(pick([option('a.ai', 159.96, 319.92)]), undefined);
  assert.equal(pick([option('a.ai', 159.96, 319.92)], { requested: ['ai'] }), 'a.ai');
  assert.equal(pick([option('a.ai', 159.96, 319.92), option('a.dev', 8.28, 33.12)], { budget: 400 }), 'a.ai');
  assert.equal(pick([option('a.ai', 159.96, 319.92), option('a.dev', 8.28, 33.12)], { budget: 300 }), 'a.dev');
  // A budget replaces the $60 cap.
  assert.equal(pick([option('a.com', 30, 90), option('a.dev', 8.28, 33.12)], { budget: 100 }), 'a.com');
  assert.equal(pick([option('a.com', 9.48, 30.84), option('a.xyz', 1.5, 30.4)], { budget: 30.5 }), 'a.xyz');
  assert.equal(pick([option('a.com', 30, 90), option('a.dev', 8.28, 33.12)], { requested: ['com', 'dev'] }), 'a.dev');
  assert.equal(pick([option('a.com', 10, null), option('a.dev', 8.28, 33.12)]), 'a.dev');
  assert.equal(pick([option('a.com', 10, null)]), undefined);
  assert.ok(comparePicks(option('a.com', 30, 90), option('b.dev', 23, 69)) > 0);
});

test('baseline prices: the pick is .com, with distinct cheapest-upfront and 3-year value lines and every row kept', async t => {
  const { say, html, md, shared } = await receipt(t, lookup([both('exampleheron'), both('examplewren')]));
  assert.match(say, /^1\. exampleheron\.com \$9\.48, then \$10\.68 list price/m);
  assert.match(say, /^2\. examplewren\.com \$9\.48, then \$10\.68 list price/m);
  assert.match(say, /^Cheapest: \[exampleheron\.xyz\]\(https:\/\/www\.dynadot\.com\/domain\/search\?domain=exampleheron\.xyz\) \$1\.50, then \$14\.45 \(renewal jumps\)/m);
  assert.match(say, /^Best value: exampleheron\.xyz, \$30\.40 in payments due in 3 years \(list price checked 2026-11-25, renewal jumps\)\.$/m);
  assert.doesNotMatch(say, /^Fallback:/m);
  assert.doesNotMatch(html, /Fallback:/);
  assert.match(html, /<div class="comparison">.*Cheapest: .*Best value: exampleheron\.xyz.*<\/div>/s);
  for (const domain of ['exampleheron.com', 'exampleheron.xyz', 'examplewren.com', 'examplewren.xyz']) {
    assert.ok(md.includes('| ' + domain + ' |'), domain);
    assert.ok(html.includes('<code>' + domain + '</code>'), domain);
  }
  assert.ok(md.indexOf('| exampleheron.com |') < md.indexOf('| exampleheron.xyz |'));
  assert.match(md, /\| exampleheron\.xyz \| \$1\.50 \| \$14\.45 \| .*Renewal jumps.*\(https:\/\/www\.dynadot\.com\/domain\/search\?domain=exampleheron\.xyz\) \|/);
  for (const card of cards(shared)) {
    const label = card.pick.split('.')[0];
    assert.deepEqual(card, { pick: label + '.com', value: [label + '.xyz 30.4'],
      rows: [label + '.com', label + '.xyz jump', ...card.rows.slice(2)] });
    assert.equal(card.rows.length, defaultEndings.length);
  }
});

test('the cheapest and best-value lines are left out when they are the pick', async t => {
  const { say } = await receipt(t, lookup([{ name: 'exampleheron', taken: ['xyz'], free: free(['com', 'tech']) }],
    prices({ tech: { now: 49.2, renew: 49.2, y3: 147.6, shop: 'Cloudflare' } })));
  assert.match(say, /^1\. exampleheron\.com \$9\.48/m);
  assert.doesNotMatch(say, /^Cheapest:|^Best value:/m);
});

test('.ai is shown but never the default pick unless asked for or within the budget', async t => {
  const names = [{ name: 'exampleheron', free: free(['ai', 'dev']) }];
  const listPrices = prices({ ai, dev });
  const plain = await receipt(t, lookup(names, listPrices));
  assert.match(plain.say, /^1\. exampleheron\.dev \$8\.28/m);
  assert.doesNotMatch(plain.say, /^Cheapest:|^Best value:/m);
  assert.ok(plain.md.includes('| exampleheron.ai | $159.96 | $159.96 |'));
  assert.equal(cards(plain.shared)[0].pick, 'exampleheron.dev');

  const only = await receipt(t, lookup([{ name: 'exampleheron', free: free(['ai']) }], listPrices));
  assert.doesNotMatch(only.say, /^1\./m);
  assert.match(only.say, /^Cheapest: \[exampleheron\.ai\]/m);
  assert.equal(cards(only.shared)[0].pick, null);

  const asked = await receipt(t, lookup(names, listPrices), { endings: ['ai'] });
  assert.match(asked.say, /\.ai first\. 1\. exampleheron\.ai \$159\.96/);
  const rich = await receipt(t, lookup(names, listPrices), { budget: 400 });
  assert.match(rich.say, /Pick: exampleheron\.ai \$159\.96/);
  // The budget is also the upfront cap: $300 lets .ai in upfront, but its 3-year total does not fit.
  const short = await receipt(t, lookup(names, listPrices), { budget: 300 });
  assert.match(short.say, /Pick: exampleheron\.dev \$8\.28/);
  assert.match(short.say, /^Best value: exampleheron\.dev|^Up to \$300\.00 today/m);
});

test('within $60 the quality order wins; above it the least paid over 3 years, and a budget replaces $60', async t => {
  const listPrices = prices({ com: { now: 25, renew: 25, y3: 75 }, io: { now: 20, renew: 20, y3: 60, shop: 'Dynadot' },
    dev: { now: 30, renew: 30, y3: 90, shop: 'Spaceship' } });
  const name = [{ name: 'exampleheron', free: free(['com', 'io', 'dev']) }];
  const fits = await receipt(t, lookup(name, listPrices));
  assert.match(fits.say, /^1\. exampleheron\.io \$20\.00/m);
  const none = await receipt(t, lookup(name, prices({ com: { now: 25, renew: 25, y3: 75 },
    dev: { now: 30, renew: 30, y3: 90, shop: 'Spaceship' } })));
  assert.match(none.say, /^1\. exampleheron\.com \$25\.00/m);
  const budget = await receipt(t, lookup(name, listPrices), { budget: 80 });
  assert.match(budget.say, /Pick: exampleheron\.com \$25\.00/);
});

test('batch picks: one pick per name, ranked by fit, then quality', async t => {
  const names = [
    { name: 'examplewren', free: free(['com']) },
    { name: 'exampleheron', free: free(['xyz', 'co', 'so']) },
    { name: 'examplefinch', free: free(['xyz']) },
  ];
  const { say, shared } = await receipt(t, lookup(names, prices({
    co: { now: 3.11, renew: 31.05, y3: 65.21, jump: true, shop: 'Spaceship' }, so: { now: 1, renew: 2, y3: 5, shop: 'Dynadot' } })));
  assert.match(say, /^1\. examplewren\.com \$9\.48/m);
  assert.match(say, /^2\. exampleheron\.so \$1\.00/m);
  assert.match(say, /^3\. examplefinch\.xyz \$1\.50, then \$14\.45 \(renewal jumps\)/m);
  assert.match(say, /^Cheapest: \[exampleheron\.so\]/m);
  assert.match(say, /^Best value: exampleheron\.so, \$5\.00/m);
  assert.deepEqual(cards(shared).map(card => card.pick), ['examplewren.com', 'exampleheron.so', 'examplefinch.xyz']);
  assert.deepEqual(cards(shared)[1].rows.slice(0, 3), ['exampleheron.co jump', 'exampleheron.so', 'exampleheron.xyz jump']);
});

test('an explicitly requested ending or exact domain ranks first and is never demoted', async t => {
  const asked = await receipt(t, lookup([both('exampleheron')]), { endings: ['xyz'] });
  assert.match(asked.say, /\.xyz first\. 1\. exampleheron\.xyz \$1\.50/);
  assert.doesNotMatch(asked.say, /^Cheapest:|^Best value:/m);

  const order = await receipt(t, lookup([both('exampleheron')]), { endings: ['com', 'xyz'] });
  assert.match(order.say, /\.com, \.xyz first\. 1\. exampleheron\.com \$9\.48/);
  assert.match(order.say, /^Cheapest: \[exampleheron\.xyz\]/m);
  assert.match(order.say, /^Best value: exampleheron\.xyz, \$30\.40/m);

  const typed = await receipt(t, lookup([{ name: 'examplewren.xyz', free: free(['xyz']) }, both('exampleheron')]));
  assert.match(typed.say, /^1\. examplewren\.xyz \$1\.50/m);
  assert.match(typed.say, /^2\. exampleheron\.com \$9\.48/m);
});

test('a partial quote keeps its receipt row and does not qualify for the pick', async t => {
  const quoteOnly = { name: 'exampleheron', free: [{ d: 'com', s: 'ok', now: 18, shop: 'Dynadot' }, { d: 'xyz', s: 'nc' }] };
  const { say, shared } = await receipt(t, lookup([quoteOnly]));
  assert.match(say, /^1\. exampleheron\.xyz \$1\.50/m);
  assert.doesNotMatch(say, /^Cheapest:|^Best value:/m);
  assert.ok(cards(shared)[0].rows.includes('exampleheron.com'));
});

const row = (domain, firstPayment, threeYear, status = 'probably-free') => ({ domain, tld: domain.slice(domain.indexOf('.') + 1),
  exact: true, status, price: firstPayment, renewal: 1, firstPayment, threeYear });

test('the light confirm sends the shop quote to the same pick, and rows rank in the quality order', () => {
  const rows = [row('exampleheron.xyz', 1.5, 30.4), row('exampleheron.tech', 6.64, 111.94),
    row('exampleheron.ai', 159.96, 319.92), row('exampleheron.com', 9.48, 30.84), row('exampleheron.dev', 8.28, 33.12)];
  assert.deepEqual(rankName(rows).map(item => item.domain),
    ['exampleheron.com', 'exampleheron.ai', 'exampleheron.dev', 'exampleheron.xyz', 'exampleheron.tech']);
  assert.equal(pickName(rows).domain, 'exampleheron.com');
  assert.equal(lightTargets(rows, [], 1)[0].domain, 'exampleheron.com');
  const noCom = rows.filter(item => item.tld !== 'com');
  assert.equal(pickName(noCom).domain, 'exampleheron.dev', '.ai is never the default pick');
  assert.equal(lightTargets(noCom, [], 1, ['ai'])[0].domain, 'exampleheron.ai');
  assert.equal(lightTargets(rows, [], 1, ['xyz'])[0].domain, 'exampleheron.xyz');
  assert.equal(lightTargets(rows, [], 1, [], 5)[0].domain, 'exampleheron.xyz');
  assert.equal(lightTargets(rows, [], 1, [], 400)[0].domain, 'exampleheron.com');
  assert.equal(lightTargets(noCom, [], 1, [], 400)[0].domain, 'exampleheron.ai');
  assert.equal(lightTargets([row('exampleheron.com', 9.48, 30.84), row('examplewren.xyz', 1.5, 30.4)], [], 1, [], undefined,
    ['examplewren.xyz'])[0].domain, 'examplewren.xyz');
  // An eligibility opt-in puts .no right after .com.
  const norway = [row('exampleheron.com', 9.48, 30.84), row('exampleheron.no', 7.97, 23.91), row('exampleheron.dev', 8.28, 33.12)];
  assert.equal(pickName(norway).domain, 'exampleheron.com');
  assert.equal(pickName(norway.slice(1), ['no']).domain, 'exampleheron.no');
  assert.equal(pickName(norway.slice(1)).domain, 'exampleheron.dev');
});

test('structured best value compares known three-year totals', () => {
  const rows = [row('exampleheron.com', 9.48, 30.84), row('exampleheron.xyz', 1.5, 30.4)];
  assert.equal(bestValue(rows).domain, 'exampleheron.xyz');
  assert.equal(bestValue([row('exampleheron.com', 18, null), rows[1]]).domain, 'exampleheron.xyz');
  assert.equal(bestValue([]), undefined);
});

test('legacy check and screen displays use the same pick and lines', () => {
  const { display } = JSON.parse(checkText({ names: [both('exampleheron')], listPrices: prices() }));
  assert.match(display, /^Pick: exampleheron\.com\nCheapest now: exampleheron\.xyz\nBest value: exampleheron\.xyz, \$30\.40 over 3 years$/m);
  assert.match(display, /^- exampleheron\.xyz \$1\.50, then \$14\.45\/yr, 10x jump \(list price\)$/m);
  const asked = JSON.parse(checkText({ names: [both('exampleheron')], listPrices: prices() }, false, { preferred: ['xyz'] }));
  assert.match(asked.display, /^Pick: exampleheron\.xyz$/m);
  assert.doesNotMatch(asked.display, /^Cheapest now:|^Best value:/m);
  const names = ['Example Heron', 'Example Wren', 'Quiet Otter'].map(name => ({ name, verdict: 'Check first', free: ['xyz', 'com'] }));
  names[1].free = ['xyz'];
  const picks = topPicks({ names, prices: prices() });
  assert.deepEqual(picks.map(pick => pick.domain), ['exampleheron.com', 'quietotter.com', 'examplewren.xyz']);
  assert.ok(picks.every(pick => !('total' in pick) && !('fits' in pick)));
});

test('the broker dossier uses the same order and pick rule', () => {
  const priced = list => rankName(list.map(([name, tld, price, renewal]) => ({ domain: name + '.' + tld, tld,
    exact: name === 'example', status: 'probably-free', price, renewal, shop: tld === 'me' ? 'Cloudflare' : 'Spaceship' })));
  const { picks } = pickAlternatives(priced([['example', 'ai', 80, 80], ['example', 'xyz', 1, 14], ['example', 'me', 16.56, 16.56],
    ['example', 'io', 32, 52]]), 'example.com');
  assert.deepEqual(picks.map(item => [item.domain, item.role]),
    [['example.me', 'pick'], ['example.ai', 'exact-ending'], ['example.io', 'exact-ending']]);
});

test('Cloudflare: one checked official snapshot, merged by registrar with fresh cache, flagged Needs Cloudflare DNS', async t => {
  assert.deepEqual(snapshotShops, ['cloudflare']);
  const cloudflare = bundledCatalog.catalogs.cloudflare;
  assert.equal(cloudflare.source, 'https://pricing.registrar.cloudflare.com/');
  assert.equal(cloudflare.checkedAt.slice(0, 10), '2026-11-25');
  const standard = { com: 11.17, ai: 80, io: 50, dev: 12.2, app: 14.2, co: 30, me: 16.56, xyz: 13.5, tech: 49.2, net: 11.86,
    org: 11.2, studio: 31.2, uk: 5.3, 'co.uk': 5.3 };
  assert.deepEqual(Object.fromEntries(Object.entries(cloudflare.prices).map(([tld, item]) => [tld, item.firstYear])), standard);
  for (const item of Object.values(cloudflare.prices)) assert.equal(item.renewal, item.firstYear);

  // A fresh cache from the shops that refresh at run time keeps the dated Cloudflare row instead of dropping the snapshot.
  const now = new Date('2026-11-26T12:00:00.000Z');
  const fresh = { checkedAt: now.toISOString(), catalogs: {
    dynadot: { checkedAt: now.toISOString(), prices: { com: { shop: 'Dynadot', firstYear: 11.5, renewal: 11.5 },
      io: { shop: 'Dynadot', firstYear: 21, renewal: 53 }, me: { shop: 'Dynadot', firstYear: 9, renewal: 17 },
      uk: { shop: 'Dynadot', firstYear: 6.14, renewal: 6.14 } } } } };
  const com = datedListPrices(fresh, 'com', now);
  assert.deepEqual(com.map(item => [item.id, item.firstYear, Boolean(item.bundled)]), [['dynadot', 11.5, false], ['cloudflare', 11.17, true]]);
  assert.equal(datedListPrices(fresh, 'com', now).find(item => item.id === 'spaceship'), undefined, 'other snapshot rows still yield to fresh data');
  // It competes on price: the cheapest first payment wins the listed quote.
  const uk = listQuote(fresh, { domain: 'example.uk', tld: 'uk' }, now);
  assert.deepEqual([uk.shop, uk.price, uk.renewal, uk.priceCheckedAt.slice(0, 10)], ['Cloudflare', 5.3, 5.3, '2026-11-25']);
  assert.equal(uk.buyUrl, 'https://www.cloudflare.com/domains/search/?q=example.uk');
  assert.equal(listQuote(fresh, { domain: 'example.com', tld: 'com' }, now).shop, 'Cloudflare');
  assert.equal(listQuote(null, { domain: 'example.com', tld: 'com' }, now).shop, 'Spaceship');

  const names = [{ name: 'exampleheron', taken: ['com'], free: free(['uk', 'xyz']) }];
  const { say, md, html, shared } = await receipt(t, lookup(names, prices({ uk: { now: 5.3, renew: 5.3, y3: 15.9, shop: 'Cloudflare' } })),
    { endings: ['uk', 'xyz'] });
  assert.match(say, /\.uk, \.xyz first\. 1\. exampleheron\.uk \$5\.30, then \$5\.30 list price checked 2026-11-25 \(needs cloudflare dns\)/);
  assert.match(md, /\| exampleheron\.uk \| \$5\.30 \| \$5\.30 \| .*Needs Cloudflare DNS.*\[Cloudflare\]\(https:\/\/www\.cloudflare\.com\/domains\/search\/\?q=exampleheron\.uk\) \|/);
  assert.match(html, /<code>exampleheron\.uk<\/code><small>[^<]*Needs Cloudflare DNS/);
  assert.deepEqual(cards(shared)[0].rows.filter(item => item.endsWith(' cf')), ['exampleheron.uk cf']);
  // The legacy display says it too; dossier.test.mjs covers the broker dossier line.
  const { display } = JSON.parse(checkText({ names: [{ name: 'exampleheron', free: free(['uk']) }],
    listPrices: { uk: { now: 5.3, renew: 5.3, y3: 15.9, shop: 'Cloudflare' } } }));
  assert.match(display, /exampleheron\.uk \$5\.30\/\$5\.30 list price \(needs cloudflare dns\)/);
});
