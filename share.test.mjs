import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateSync, inflateSync } from 'node:zlib';
import { supportedEndings } from './clis/domain-check/name-search.mjs';
import { resultPages } from './results.mjs';
import { shareUrl } from './share.mjs';
import { readShareFragment } from './site/r/share-format.mjs';

const checkedAt = '2026-11-25T09:07:26.876Z';
const namePrice = (name, ending, type) =>
  (50 + createHash('sha256').update([name, ending, type].join('.')).digest().readUInt16BE() % 49_951) / 100;
const fragment = (version, value) => '#' + version + '.' + deflateSync(JSON.stringify(value)).toString('base64url');
const rawPayload = link => inflateSync(Buffer.from(new URL(link).hash.slice(3), 'base64url')).toString('utf8');

async function receipt(t, data, args) {
  const directory = await mkdtemp(join(tmpdir(), 'hound-share-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await resultPages({ directory, env: { DOMAIN_HOUND_OPEN: 'off' } })(data, args, { triage: true });
  const html = await readFile(new URL(result.resultPage), 'utf8');
  const link = html.match(/href="(https:\/\/domainhound\.dev\/r\/#[A-Za-z0-9_.-]+)">Share<\/a>/)?.[1];
  assert.ok(link);
  return { say: result.say, html, link, shared: await readShareFragment(new URL(link).hash) };
}

test('a share carries five names, every checked ending and each name\'s facts within 2,000 characters', async () => {
  const groups = Array.from({ length: 6 }, (_, index) => {
    const name = createHash('sha256').update(String(index)).digest('hex').slice(0, 63);
    return {
      row: { name, verdict: 'Check first', reason: 'private analyst note' },
      records: supportedEndings.map((ending, offset) => ({
        domain: name + '.' + ending, status: offset < 2 ? 'Taken' : 'Free at the registry',
        now: offset ? namePrice(name, offset, 0) : null, renew: offset ? namePrice(name, offset, 1) : null,
        term: ending === 'ai' ? 2 : 1, jump: namePrice(name, offset, 3) > 250, total: namePrice(name, offset, 2),
        checkout: 'https://example.com/private',
      })),
    };
  });
  const facts = groups.map(({ records }) => ({ pick: records[2], value: records[3], taken: [records[1], records[0]] }));
  const link = new URL(shareUrl(groups, checkedAt, facts));
  assert.equal(link.origin + link.pathname + link.search, 'https://domainhound.dev/r/');
  assert.ok(link.href.length < 2000, link.href.length + ' characters');
  assert.deepEqual(await readShareFragment(link.hash), { checkedAt, groups: groups.slice(0, 5).map(({ row, records }) => ({
    name: row.name, verdict: row.verdict,
    records: records.map(({ checkout, total, ...fields }, index) => ({ ...fields, pick: index === 2,
      ...(index === 3 && { bestValue: total }) })),
    takenDomains: [records[1].domain, records[0].domain],
  })) });
  assert.doesNotMatch(rawPayload(link.href), /private|example\.com/);
});

test('a shared exact result keeps its domain, actual quote and price gaps', async () => {
  const group = { row: { name: 'Fjæra.com' }, records: [
    { domain: 'xn--fjra-zra.com', status: 'Confirmed at shop', now: 19.04, renew: null },
  ] };
  assert.deepEqual((await readShareFragment(new URL(shareUrl([group], checkedAt)).hash)).groups, [{
    name: 'Fjæra.com', verdict: null, takenDomains: [],
    records: [{ domain: 'xn--fjra-zra.com', status: 'Confirmed at shop', now: 19.04, renew: null, term: 1, jump: false, pick: false }],
  }]);
});

test('sharing records directly preserves the taken watch target', async () => {
  const group = { row: { name: 'Quiet Otter' }, records: [{ domain: 'quietotter.com', status: 'Taken' }] };
  const receipt = await readShareFragment(new URL(shareUrl([group], checkedAt)).hash);
  assert.deepEqual(receipt.groups[0].takenDomains, ['quietotter.com']);
});

test('an old link keeps its statuses, works out jumps from its prices and recommends nothing', async () => {
  const old = fragment(1, [checkedAt, [['Quiet Otter', 2, 'quietotter',
    [['.net', 0, 749, 1252, 1], ['.io', 0, 1800, 4200, 1], ['.ai', 2, null, null, 2], ['.com', 3, null, 1452, 1]]]]]);
  const row = (domain, status, now, renew, term, jump) => ({ domain, status, now, renew, term, jump, pick: false });
  assert.deepEqual(await readShareFragment(old), { checkedAt, groups: [{ name: 'Quiet Otter', verdict: 'Check first', records: [
    row('quietotter.net', 'Free at the registry', 7.49, 12.52, 1, false),
    row('quietotter.io', 'Free at the registry', 18, 42, 1, true),
    row('quietotter.ai', 'Taken', null, null, 2, null),
    row('quietotter.com', 'Taken, possible resale', null, 14.52, 1, null),
  ], takenDomains: ['quietotter.com', 'quietotter.ai'] }] });
});

test('the viewer rejects corrupt, oversized and invalid share fragments', async () => {
  const rows = [['.com', 2, null, 1452, 1], ['.net', 0, 749, 1252, 1]];
  const v2 = facts => fragment(2, [checkedAt, [['Quiet Otter', 2, 'quietotter', rows, facts]]]);
  assert.ok(await readShareFragment(v2({ p: 1, b: [1, 2247], j: 2, t: [0] })));
  // c marks the rows that need Cloudflare DNS.
  const cloudflare = await readShareFragment(v2({ p: 1, c: 2 }));
  assert.deepEqual(cloudflare.groups[0].records.map(row => row.dns ?? null), [null, 'Needs Cloudflare DNS']);
  for (const hash of ['', '#3.ABC', '#1.AB_0', '#1.' + 'a'.repeat(2000),
    fragment(1, 'a'.repeat(50_000)), fragment(1, [checkedAt, [['<img>', 0, '', []]]]),
    fragment(1, [checkedAt, [['Fjæra', 0, '', [['javascript:alert(1)', 0, null, null, 1]]]]]),
    fragment(1, [checkedAt, [['Fjæra', 0, '', [['example.com', 0, -1, null, 1]]]]]),
    fragment(1, [checkedAt, [['Quiet Otter', 2, 'quietotter', rows, { p: 1 }]]]),
    v2({ p: 0 }), v2({ p: 2 }), v2({ b: [1, null] }), v2({ b: [0, 100] }), v2({ j: 4 }), v2({ t: [1] }), v2({ t: [0, 0] }),
    v2({ rank: 1 }), v2([1]), v2({ c: 4 }), v2({ c: -1 }), v2({ c: 0.5 })]) {
    assert.equal(await readShareFragment(hash), null, hash);
  }
});

const lookup = y3 => ({
  checkedAt, priceListDate: checkedAt.slice(0, 10),
  prices: { com: { now: 12, renew: 14 }, io: { now: 18, renew: 42, jump: true }, ai: { now: 15, renew: 16, term: 2 }, no: { now: 7, renew: 8 } },
  names: [
    { name: 'Paper Heron', verdict: 'Avoid', reason: 'Private reason', taken: ['me', 'io', 'com'], free: ['ai', 'no'], competition: {} },
    { name: 'Cedar Heron', verdict: 'Check first', reason: 'Private reason', free: ['com', 'io', 'ai', 'no'], competition: {} },
    { name: 'Moss Heron', verdict: 'No conflict found', reason: 'Private reason', taken: ['com'],
      free: [{ d: 'io', s: 'ok', now: 30, renew: 31, ...(y3 && { y3 }), shop: 'Dynadot' }], competition: {} },
    { name: 'Fern Heron', verdict: 'No conflict found', reason: 'Private reason', free: ['com', 'ai'],
      own: { com: { now: 60, renew: 14 } }, competition: {} },
    { name: 'Reed Heron', verdict: 'Check first', reason: 'Private reason', free: ['io', 'com'], competition: {} },
  ],
});
const scope = { budget: 35, endings: ['io', 'com', 'ai', 'no'], about: 'Private brief for a stealth launch' };
const cards = shared => shared.groups.map(({ records, takenDomains }) => [records.find(row => row.pick)?.domain ?? null,
  ...records.filter(row => 'bestValue' in row).map(row => row.domain + ' ' + row.bestValue), takenDomains]);

test('every name gets its own pick and best value under the receipt\'s scope, with all rows in receipt order', async t => {
  const { say, html, link, shared } = await receipt(t, lookup(25), scope);
  // Same selection as the receipt: Avoid gets nothing, .no needs eligibility, $60 .com is over budget upfront, y3 and
  // terms count. The $35 budget replaces the $60 cap: the pick is the first asked-for ending within $35 over 3 years,
  // else the least paid over 3 years (Reed Heron: .com at $40 beats .io at $102).
  assert.match(say, /Pick: mossheron\.io \$30\.00, then \$31\.00/);
  assert.match(say, /^2\. fernheron\.ai \$15\.00/m);
  assert.match(say, /^Cheapest: \[cedarheron\.com\]/m);
  // The best 3-year value is the pick, so it gets no line of its own.
  assert.doesNotMatch(say, /^Best value:/m);
  assert.deepEqual(cards(shared), [
    [null, ['paperheron.io', 'paperheron.com']],
    ['cedarheron.ai', 'cedarheron.ai 31', []],
    ['mossheron.io', 'mossheron.io 25', ['mossheron.com']],
    ['fernheron.ai', 'fernheron.ai 31', []],
    ['reedheron.com', 'reedheron.com 40', []],
  ]);
  const rows = shared.groups.flatMap(group => group.records);
  assert.deepEqual(rows.map(row => row.domain), [...html.matchAll(/<code>([^<]+)<\/code>/g)].map(match => match[1]));
  assert.deepEqual(['cedarheron.io', 'mossheron.io', 'cedarheron.com'].map(domain => rows.find(row => row.domain === domain).jump),
    [true, false, false]);
  assert.doesNotMatch(rawPayload(link), /Private|stealth|brief|reason/i);

  const { say: termSay, shared: termShared } = await receipt(t, lookup(), scope);
  // Without the y3 quote, two-year .ai terms ($31) beat yearly .com ($40); a plain yearly sum would make .ai $47.
  // Fern Heron's .ai is now both the pick and the best value; a tie on price goes to the better verdict.
  assert.match(termSay, /Pick: fernheron\.ai \$15\.00/);
  assert.doesNotMatch(termSay, /^Best value:/m);
  assert.equal(cards(termShared)[3][1], 'fernheron.ai 31');
  assert.equal(cards(termShared)[2][1], 'mossheron.io 92');

  const { shared: early } = await receipt(t, { ...lookup(25), pending: true }, scope);
  assert.deepEqual(cards(early).map(([pick, ...rest]) => [pick, rest.length]), Array(5).fill([null, 1]));
  assert.deepEqual(early.groups[0].takenDomains, ['paperheron.io', 'paperheron.com']);
});

test('the receipt shares lookup facts and keeps the brief and locally entered notes out of the link', async t => {
  const { link, shared } = await receipt(t, {
    checkedAt, names: [{ name: 'Quiet Otter', verdict: 'Check first', reason: 'Private note',
      taken: ['net', 'com'], free: ['io'], competition: {} }],
    prices: { io: { now: 7.49, renew: 12.52 } },
  }, { about: 'Private brief' });
  assert.deepEqual(Object.keys(shared), ['checkedAt', 'groups']);
  assert.deepEqual(shared.groups[0].records.find(row => row.domain === 'quietotter.io'), { domain: 'quietotter.io',
    status: 'Free at the registry', now: 7.49, renew: 12.52, term: 1, jump: false, pick: true, bestValue: 32.53 });
  assert.deepEqual(shared.groups[0].takenDomains, ['quietotter.com', 'quietotter.net']);
  assert.doesNotMatch(rawPayload(link), /Private/);
});
