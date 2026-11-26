import '../../test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { compareScores, nameBan, scoreEligible, scoreHandles, scoreHeadline, scoreName } from './name-score.mjs';
import { scoreLogger } from './score-log.mjs';
import { resultPages } from '../../results.mjs';
import { readShareFragment } from '../../site/r/share-format.mjs';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/name-score.json', import.meta.url), 'utf8'));
const loomfox = fixtures.loomfox.input;
const mesa = fixtures.mesa.input;
const clear = { ...loomfox, handles: { GitHub: 'free', npm: 'free', Bluesky: 'free' } };

test('reproduces the spec examples: Loomfox 91 Strong and Mesa 33 Advise against', () => {
  for (const key of ['loomfox', 'mesa']) {
    const { input, expected } = fixtures[key];
    const score = scoreName(input);
    assert.equal(score.value, expected.value, key);
    assert.equal(score.band, expected.band, key);
    assert.deepEqual(score.reasons, expected.reasons, key);
    assert.deepEqual(score.components, expected.components, key);
    assert.equal(score.version, 'v1');
  }
  assert.equal(scoreHeadline(scoreName(loomfox)), 'Name score 91/100 - how clear the road is');
});

test('a failed or missing check is never clear: 40% of the component and a "Not checked" reason', () => {
  const noUs = scoreName({ ...clear, marks: { us: 'unknown', eu: 'off', list: [] } });
  assert.equal(noUs.components.trademark, 10);
  assert.ok(noUs.reasons.includes('Not checked: US trademarks'));
  assert.ok(noUs.notChecked.includes('US trademarks'));
  const noRivals = scoreName({ ...clear, rivals: { state: 'unknown', list: [] } });
  assert.equal(noRivals.components.rivals, 8);
  assert.ok(noRivals.reasons.includes('Not checked: rivals'));
  const noApps = scoreName({ ...clear, apps: { state: 'unknown', list: [] } });
  assert.equal(noApps.components.apps, 3);
  // All three handles missing: 40% of the combined 7 points, rounded down.
  assert.equal(scoreName({ ...clear, handles: {} }).components.handles, 2);
  assert.equal(scoreName({ ...clear, handles: { GitHub: 'free', npm: 'free' } }).components.handles, 5);
  // Missing spelling and subject-fit evidence count 40% of their 4 points each.
  const { spellings, relation, ...rest } = clear.candidate;
  assert.equal(scoreName({ ...clear, candidate: rest }).components.quality, 3 + 3 + 1 + 1);
  // A check still running reads "Still checking" and marks the score pending.
  const pending = scoreName({ ...clear, rivals: { state: 'pending', list: [] }, handles: { GitHub: 'pending', npm: 'free', Bluesky: 'free' } });
  assert.equal(pending.pending, true);
  assert.ok(pending.reasons.some(reason => reason.startsWith('Still checking: ')));
  // Hits already known still count when the rest of the source failed.
  const partialApps = scoreName({ ...clear, apps: { state: 'unknown', list: [{ sameCategory: true }] } });
  assert.equal(partialApps.components.apps, 1);
  const partialRivals = scoreName({ ...clear, rivals: { state: 'unknown', list: [{ level: 'strong', sameSubject: false }] } });
  assert.equal(partialRivals.components.rivals, 4);
  assert.equal(scoreName({ ...clear, rivals: { state: 'ok', list: [], company: true } }).components.rivals, 17);
});

test('caps: trademark at 20 until the EU answers, total at 79 when US marks, rivals or ban evidence are missing', () => {
  assert.equal(scoreName(clear).components.trademark, 20);
  const withEu = scoreName({ ...clear, marks: { us: 'ok', eu: 'ok', list: [] } });
  assert.equal(withEu.components.trademark, 25);
  assert.equal(withEu.value, 99);
  assert.equal(withEu.band, 'Strong');
  assert.ok(!withEu.notChecked.length);
  for (const input of [{ ...clear, marks: { us: 'unknown', eu: 'ok', list: [] } }, { ...clear, rivals: { state: 'unknown', list: [] } }]) {
    const score = scoreName({ ...input, apps: { state: 'ok', list: [] } });
    assert.ok(score.value <= 79, String(score.value));
    assert.equal(score.band, 'Workable');
  }
  // Ban evidence the code cannot judge alone, when missing, keeps a name out of Strong and says so.
  const { realWord, ...unchecked } = clear.candidate;
  const noBans = scoreName({ ...clear, marks: { us: 'ok', eu: 'ok', list: [] }, candidate: unchecked });
  assert.equal(noBans.value, 79);
  assert.deepEqual(noBans.bansUnchecked, ['realWord']);
  assert.ok(noBans.reasons.includes('Not checked: naming bans'));
  assert.deepEqual(noBans.caps, ['bans']);
  assert.ok(scoreName({ ...clear, candidate: {} }).notChecked.includes('naming bans'));
});

test('bans run in code before scoring; hard filters remove a name instead of scoring it', () => {
  const evidence = clear.candidate;
  for (const [name, ban] of [['Loom4', 'Numbers or hyphens'], ['Loom-Fox', 'Numbers or hyphens'], ['LoomAI', 'AI, GPT, bot or smart in the name'],
    ['LoomGPT', 'AI, GPT, bot or smart in the name'], ['Loombot', 'AI, GPT, bot or smart in the name'], ['SmartLoom', 'AI, GPT, bot or smart in the name'],
    ['Loomfoxterrier', 'Over 12 letters'], ['Loomify', 'Trend ending (-ly, -ify, -io)'], ['Loomly', 'Trend ending (-ly, -ify, -io)'],
    ['Loomio', 'Trend ending (-ly, -ify, -io)'], ['Flickr', 'Dropped vowels'], ['Lmfx', 'Dropped vowels'], ['Loomhub', 'Subject word plus a generic word'],
    ['Loom Labs', 'Subject word plus a generic word'], ['Lööm', 'Not English']]) {
    assert.equal(nameBan(name, evidence), ban, name);
    const score = scoreName({ ...clear, name });
    assert.equal(score.filtered, ban, name);
    assert.equal(score.value, undefined, name);
  }
  // Real words and the person's own language stay clear.
  for (const name of ['Firefly', 'Studio Fox', 'Robot Moth', 'Repro', 'Loomfox']) assert.equal(nameBan(name, evidence), null, name);
  assert.equal(nameBan('Lööm', { ...evidence, language: 'asked' }), null);
  // The caller's evidence decides the bans code cannot.
  for (const [key, value, ban] of [['descriptive', true, 'Pure descriptive'], ['realWord', false, 'Pure invented, no real word inside'],
    ['misspelled', true, 'Deliberate misspelling'], ['narrow', true, 'Too narrow for the product'], ['soundsLike', 'drug', 'Sounds like a drug'],
    ['language', 'other', 'Not English']]) {
    assert.equal(scoreName({ ...clear, candidate: { ...evidence, [key]: value } }).filtered, ban, key);
  }
  // Hard filters on the checked evidence.
  const filtered = input => scoreName({ ...clear, ...input }).filtered;
  assert.equal(filtered({ domains: [{ ending: 'com', total: 60.01, registry: true }] }), 'No free ending with a known price within $60.00 over 3 years');
  assert.equal(filtered({ domains: [{ ending: 'com', total: null, registry: true }] }), 'No free ending with a known price within $60.00 over 3 years');
  assert.equal(filtered({ domains: [{ ending: 'com', total: 20, registry: false }] }), 'No free ending with a known price within $60.00 over 3 years');
  assert.equal(scoreName({ ...clear, domains: [{ ending: 'com', total: 60, registry: true }] }).components.price, 1);
  assert.equal(filtered({ marks: { us: 'ok', eu: 'off', list: [{ tier: 'Exact', sameClass: true, live: true }] } }), 'Identical live trademark in your classes');
  assert.equal(filtered({ rivals: { state: 'unknown', list: [{ level: 'strong', sameSubject: true }] } }), 'Same-name rival with strong traction in your subject');
  assert.equal(filtered({ meaning: { how: 'is' } }), 'Severe bad meaning');
  assert.equal(filtered({ candidate: { ...evidence, badMeaning: 'severe' } }), 'Severe bad meaning');
  // Unverified status or classes never hard-filter; a dead mark is skipped.
  for (const mark of [{ tier: 'Exact', sameClass: true, live: null }, { tier: 'Exact', sameClass: null, live: true }]) {
    const score = scoreName({ ...clear, marks: { us: 'ok', eu: 'off', list: [mark] } });
    assert.equal(score.components.trademark, 5);
    assert.ok(score.reasons.includes('Identical trademark, status or class unclear'));
  }
  assert.equal(scoreName({ ...clear, marks: { us: 'ok', eu: 'off', list: [{ tier: 'Exact', sameClass: true, live: false }] } }).components.trademark, 20);
  // A mild meaning costs 5 points.
  assert.equal(scoreName({ ...clear, meaning: { how: 'contains' } }).components.quality, 14 - 5);
});

test('reasons: at most three, best point first, an unknown that costs points always takes a slot', () => {
  const score = scoreName({ ...mesa, rivals: { state: 'unknown', list: [] } });
  assert.equal(score.reasons.length, 3);
  assert.equal(score.reasons[0], 'Short and easy to say');
  assert.ok(score.reasons.includes('Not checked: rivals'));
  for (const name of ['loomfox', 'mesa']) assert.ok(scoreName(fixtures[name].input).reasons.length <= 3);
});

test('ranking puts finished scores first, then pending ones, then names without a score; Avoid stays a guard', () => {
  const rows = [{ name: 'a' }, { name: 'b', score: { value: 70, pending: true } }, { name: 'c', score: { value: 60 } },
    { name: 'd', score: { filtered: 'Over 12 letters' } }, { name: 'e', score: { value: 90 } }];
  const ranked = rows.map((row, index) => ({ row, index }))
    .sort((x, y) => compareScores(x.row.score, y.row.score) || x.index - y.index).map(({ row }) => row.name);
  assert.deepEqual(ranked, ['e', 'c', 'b', 'a', 'd']);
  assert.equal(scoreEligible({ verdict: 'Avoid', score: { value: 80 } }), false);
  assert.equal(scoreEligible({ verdict: 'Avoid', score: { value: 80, overridesAvoid: true } }), true);
  assert.equal(scoreEligible({ verdict: 'Check first', score: { filtered: 'x' } }), false);
  assert.deepEqual(scoreHandles([{ platform: 'GitHub', state: 'taken' }, { platform: 'npm', state: 'not-found' },
    { platform: 'Bluesky', state: 'check', why: 'still checking' }]), { GitHub: 'taken', npm: 'free', Bluesky: 'pending' });
});

test('the calibration log is off by default, stays local and private, and never holds the name unless asked', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hound-score-log-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'nested', 'score-log.jsonl');
  const score = scoreName(loomfox);
  const rows = [{ label: 'loomfox', name: 'Loomfox', score }];
  const off = scoreLogger({ env: {}, file });
  await off.shown(rows);
  await off.picked('loomfox.com', 'quote_domain');
  await assert.rejects(stat(file));

  const on = scoreLogger({ env: { DOMAIN_HOUND_SCORE_LOG: '1' }, file });
  await on.shown(rows);
  await on.picked('loomfox.com', 'quote_domain');
  await on.picked('loomfox.com', 'quote_domain');
  await on.picked('other.com', 'quote_domain');
  const text = await readFile(file, 'utf8');
  const lines = text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map(line => line.event), ['shown', 'picked']);
  assert.equal(lines[1].id, lines[0].id);
  assert.deepEqual(lines[0].components, score.components);
  assert.equal(lines[0].weights, 'v1');
  assert.equal(lines[0].rank, 1);
  assert.doesNotMatch(text, /loomfox|\.com is free|\$29/i);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);

  const named = scoreLogger({ env: { DOMAIN_HOUND_SCORE_LOG: '1', DOMAIN_HOUND_SCORE_LOG_NAMES: '1' }, file });
  await named.shown(rows);
  assert.equal(JSON.parse((await readFile(file, 'utf8')).trim().split('\n').at(-1)).name, 'Loomfox');
});

const at = '2026-11-25T12:00:00.000Z';
function scoredPayload() {
  const strong = scoreName(loomfox);
  const risky = scoreName(mesa);
  return {
    checkedAt: at, priceListDate: at.slice(0, 10),
    prices: { com: { now: 9, renew: 10, shop: 'Spaceship' }, tech: { now: 10, renew: 20, shop: 'Spaceship' } },
    names: [
      { name: 'Mesa', verdict: 'Check first', reason: 'Same-name use with some traction', free: ['tech'], taken: ['com'],
        score: { value: risky.value, band: risky.band, reasons: risky.reasons }, competition: { AppStore: [], GooglePlay: [], US: [] } },
      { name: 'Loomfox', verdict: 'No conflict found', reason: 'No US mark, same-name app or active company found', free: ['com'],
        score: { value: strong.value, band: strong.band, reasons: strong.reasons }, competition: { AppStore: [], GooglePlay: [], US: [] } },
      { name: 'Loomify', verdict: 'No conflict found', reason: 'No US mark, same-name app or active company found', free: ['com'],
        score: { filtered: 'Trend ending (-ly, -ify, -io)' }, competition: { AppStore: [], GooglePlay: [], US: [] } },
    ],
    receiptDetails: [{ score: risky }, { score: strong }, { score: { version: 'v1', filtered: 'Trend ending (-ly, -ify, -io)' } }],
  };
}

test('the results page and say show the Name score, its reasons and why a name has none; picks rank by score', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hound-score-page-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await resultPages({ directory, env: { DOMAIN_HOUND_OPEN: 'off' } })(scoredPayload(), {}, { triage: true });
  const html = await readFile(new URL(result.resultPage), 'utf8');
  const md = await readFile(new URL(result.resultPage.replace(/\.html$/, '.md')), 'utf8');
  for (const file of [html, md]) {
    assert.ok(file.includes('Name score 91/100 - how clear the road is · Strong.'));
    assert.ok(file.includes('Name score 33/100 - how clear the road is · Advise against.'));
    assert.ok(file.includes('Not checked: EU trademarks'));
    assert.ok(file.includes('Not scored: Trend ending (-ly, -ify, -io).'));
  }
  assert.match(html, /<div class="name-score"><p>Name score 91\/100/);
  assert.match(result.say, /Keep Mesa\? Check first\..* Name score 33\/100, Advise against\./);
  // Loomfox (91) is the first pick although Mesa came first; the filtered name has a diagnostic row only.
  const picks = result.say.split('\n').filter(line => /^\d\. /.test(line));
  assert.match(picks[0], /^1\. loomfox\.com .*Name score 91\/100, Strong/);
  assert.match(picks[1], /^2\. mesa\.tech .*Name score 33\/100, Advise against/);
  assert.equal(picks.length, 2);
  assert.doesNotMatch(result.say, /[—–]/);

  // The share link carries the finished score and the count of checks not done; old readers keep version 2 links.
  const link = html.match(/href="(https:\/\/domainhound\.dev\/r\/#[A-Za-z0-9_.-]+)">Share<\/a>/)?.[1];
  assert.ok(link.includes('/r/#3.'));
  const shared = await readShareFragment(new URL(link).hash);
  assert.deepEqual(shared.groups.map(group => group.score && [group.score.value, group.score.band, group.score.notChecked]),
    [[33, 'Advise against', 1], [91, 'Strong', 1], undefined]);
});

test('a generated shortlist hides filters and ranks scored names on the page and share link', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hound-score-shortlist-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await resultPages({ directory, env: { DOMAIN_HOUND_OPEN: 'off' } })(scoredPayload(), { shortlist: true }, { triage: true });
  const html = await readFile(new URL(result.resultPage), 'utf8');
  assert.doesNotMatch(html, /Loomify/i);
  assert.ok(html.indexOf('<h2>Loomfox') < html.indexOf('<h2>Mesa'));
  assert.ok(result.display.indexOf('91/100') < result.display.indexOf('33/100'));
});

test('a bare-name availability check scores registry evidence and leaves unchecked sources explicit', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hound-score-availability-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const page = resultPages({ directory, env: { DOMAIN_HOUND_OPEN: 'off' } });
  const data = { checkedAt: at, names: [{ name: 'loomfox', free: [{ d: 'com', s: 'nc', now: 9, renew: 10 }] }] };
  const result = await page(data, {});
  assert.match(result.display, /Name score \d+\/100/);
  assert.ok(result.names[0].score.notChecked.includes('US trademarks'));
  assert.ok(result.names[0].score.notChecked.includes('rivals'));
  const exact = await page({ ...data, names: [{ ...data.names[0], name: 'loomfox.com' }] }, {});
  assert.equal(exact.names[0].score, undefined);
});

test('share stays backward compatible: version 2 links without a score, version 2 never accepts a score fact', async () => {
  const group = ['Loomfox', 1, 'loomfox', [['.com', 0, 900, 1000, 1]], { p: 0 }];
  const encode = (version, value) => '#' + version + deflateSync(JSON.stringify(value)).toString('base64url');
  const old = await readShareFragment(encode('2.', [at, [group]]));
  assert.equal(old.groups[0].name, 'Loomfox');
  assert.equal(old.groups[0].score, undefined);
  assert.equal(await readShareFragment(encode('2.', [at, [[...group.slice(0, 4), { p: 0, s: [91, 1] }]]])), null);
  const scored = await readShareFragment(encode('3.', [at, [[...group.slice(0, 4), { p: 0, s: [91, 1] }]]]));
  assert.deepEqual(scored.groups[0].score, { value: 91, band: 'Strong', notChecked: 1 });
  for (const bad of [[101, 0], [91, -1], [91.5, 0], [91], '91']) {
    assert.equal(await readShareFragment(encode('3.', [at, [[...group.slice(0, 4), { s: bad }]]])), null, JSON.stringify(bad));
  }
  const v1 = await readShareFragment(encode('1.', [at, [group.slice(0, 4)]]));
  assert.equal(v1.groups[0].score, undefined);
});
