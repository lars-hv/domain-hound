import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { supportedEndings } from './clis/domain-check/name-search.mjs';
import { resultPages } from './results.mjs';
import { shareUrl } from './share.mjs';
import { readShareFragment } from './site/r/share-format.mjs';

const checkedAt = '2026-11-25T09:07:26.876Z';
const namePrice = (name, ending, type) =>
  (50 + createHash('sha256').update([name, ending, type].join('.')).digest().readUInt16BE() % 49_951) / 100;

test('a share carries five names and every checked ending within 2,000 characters', async () => {
  const groups = Array.from({ length: 6 }, (_, index) => {
    const name = createHash('sha256').update(String(index)).digest('hex').slice(0, 63);
    return {
      row: { name, verdict: 'Check first', reason: 'private analyst note' },
      records: supportedEndings.map((ending, offset) => ({
        domain: name + '.' + ending, status: offset === 0 ? 'Taken' : 'Free at the registry',
        now: offset ? namePrice(name, offset, 0) : null, renew: offset ? namePrice(name, offset, 1) : null,
        term: ending === 'ai' ? 2 : 1, checkout: 'https://example.com/private',
      })),
    };
  });
  const link = new URL(shareUrl(groups, checkedAt));
  assert.equal(link.origin + link.pathname, 'https://domainhound.dev/r/');
  assert.equal(link.search, '');
  assert.ok(link.href.length < 2000);
  const receipt = await readShareFragment(link.hash);
  assert.deepEqual(receipt, { checkedAt, groups: groups.slice(0, 5).map(({ row, records }) => ({
    name: row.name, verdict: row.verdict, records: records.map(({ checkout, ...fields }) => fields),
  })) });
});

test('a shared exact result keeps its domain, actual quote and price gaps', async () => {
  const group = { row: { name: 'Fjæra.com' }, records: [
    { domain: 'xn--fjra-zra.com', status: 'Confirmed at shop', now: 19.04, renew: null },
  ] };
  const url = new URL(shareUrl([group], checkedAt));
  assert.deepEqual((await readShareFragment(url.hash)).groups, [{
    name: 'Fjæra.com', verdict: null,
    records: [{ domain: 'xn--fjra-zra.com', status: 'Confirmed at shop', now: 19.04, renew: null, term: 1 }],
  }]);
});

test('the viewer rejects corrupt, oversized and invalid share fragments', async () => {
  const fragment = value => '#1.' + deflateSync(JSON.stringify(value)).toString('base64url');
  for (const hash of ['', '#2.ABC', '#1.AB_0', '#1.' + 'a'.repeat(2000),
    fragment('a'.repeat(50_000)), fragment([checkedAt, [['<img>', 0, '', []]]]),
    fragment([checkedAt, [['Fjæra', 0, '', [['javascript:alert(1)', 0, null, null, 1]]]]]),
    fragment([checkedAt, [['Fjæra', 0, '', [['example.com', 0, -1, null, 1]]]]])]) {
    assert.equal(await readShareFragment(hash), null);
  }
});

test('the receipt shares lookup facts and keeps the brief and locally entered notes out of the link', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hound-share-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pages = resultPages({ directory, env: { DOMAIN_HOUND_OPEN: 'off' } });
  const result = await pages({
    checkedAt, names: [{ name: 'Quiet Otter', verdict: 'Check first', reason: 'Private note',
      taken: ['com'], free: ['net'], competition: {} }],
    prices: { net: { now: 7.49, renew: 12.52 } },
  }, { about: 'Private brief' }, { triage: true });
  const html = await readFile(new URL(result.resultPage), 'utf8');
  const link = html.match(/href="(https:\/\/domainhound\.dev\/r\/#[A-Za-z0-9_.-]+)">Share<\/a>/)?.[1];
  assert.ok(link);
  const shared = await readShareFragment(new URL(link).hash);
  assert.deepEqual(Object.keys(shared), ['checkedAt', 'groups']);
  assert.equal(shared.groups[0].name, 'Quiet Otter');
  assert.equal(shared.groups[0].verdict, 'Check first');
  assert.deepEqual(shared.groups[0].records.find(row => row.domain === 'quietotter.net'),
    { domain: 'quietotter.net', status: 'Free at the registry', now: 7.49, renew: 12.52, term: 1 });
  assert.doesNotMatch(JSON.stringify(shared), /Private note|Private brief/);
});
