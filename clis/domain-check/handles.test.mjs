import '../../test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { withSocial } from '../../test-support/social-fixture.mjs';
import { deadlineClock } from '../../test-support/deadline-clock.mjs';
import { autoPlatforms, checkSocialHandles, handleLifetime, handlePlatforms, handleStates, handleSummary, resetHandleRuns }
  from './handles.mjs';

const now = new Date('2026-11-25T12:00:00Z');
const hour = 3_600_000;

async function directoryFor(t) {
  const path = await mkdtemp(join(tmpdir(), 'hound-handles-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  resetHandleRuns();
  return pathToFileURL(path + '/');
}

const states = rows => Object.fromEntries(rows.map(row => [row.platform, row.state]));

test('shows every platform in Lars’s order with three states only; YouTube, X and PyPI stay check links', async t => {
  const directory = await directoryFor(t);
  const calls = [];
  const result = await checkSocialHandles([{ name: 'quietotter', variants: true }], {
    directory, now, fetcher: withSocial(undefined, { taken: ['quietotter'], calls }),
  });
  const rows = result.get('quietotter');
  assert.deepEqual(rows.map(row => row.platform), ['YouTube', 'X', 'Instagram', 'TikTok', 'Facebook', 'LinkedIn',
    'GitHub', 'npm', 'PyPI', 'Bluesky']);
  assert.deepEqual(states(rows), { YouTube: 'check', X: 'check', Instagram: 'check', TikTok: 'check', Facebook: 'check',
    LinkedIn: 'check', GitHub: 'taken', npm: 'taken', PyPI: 'check', Bluesky: 'taken' });
  assert.equal(rows[0].link, 'https://www.youtube.com/@quietotter');
  assert.equal(rows.find(row => row.platform === 'PyPI').link, 'https://pypi.org/project/quietotter/');
  assert.equal(rows.find(row => row.platform === 'Bluesky').link, 'https://bsky.app/profile/quietotter.bsky.social');
  // Taken exact handles get their variants; none of them exist here.
  const github = rows.find(row => row.platform === 'GitHub');
  assert.deepEqual(github.variants.map(row => [row.handle, row.state]),
    [['getquietotter', 'not-found'], ['quietotterapp', 'not-found'], ['quietotterhq', 'not-found']]);
  // No request ever goes to a link-only platform.
  assert.deepEqual([...new Set(calls.map(([platform]) => platform))].sort(), ['Bluesky', 'GitHub', 'npm']);
  assert.deepEqual(autoPlatforms, ['GitHub', 'npm', 'Bluesky']);
  assert.deepEqual(Object.values(handleStates), ['Taken', 'No public profile found', 'Check yourself']);
  assert.doesNotMatch(JSON.stringify(rows) + JSON.stringify(handleStates), /free|available/i);
  assert.equal(handlePlatforms.length, 10);
});

test('variants run only when the exact handle is taken, and missing handles read "no public profile found"', async t => {
  const directory = await directoryFor(t);
  const calls = [];
  const result = await checkSocialHandles([{ name: 'hushroom', variants: true }], {
    directory, now, fetcher: withSocial(undefined, { taken: ['gethushroom'], calls }),
  });
  const rows = result.get('hushroom');
  assert.deepEqual(states(rows.filter(row => autoPlatforms.includes(row.platform))), { GitHub: 'not-found', npm: 'not-found', Bluesky: 'not-found' });
  assert.ok(rows.every(row => !row.variants));
  assert.ok(!calls.some(([, handle]) => /gethushroom/.test(handle)));
  assert.equal(handleSummary(rows), 'GitHub no public profile found · npm no public profile found · Bluesky no public profile found; '
    + 'check yourself: YouTube, X, Instagram, TikTok, Facebook, LinkedIn, PyPI');
});

test('a wrong control answer turns that platform into check links for the whole run', async t => {
  const directory = await directoryFor(t);
  // npm stops reporting a known package, so no npm answer is trusted.
  const base = withSocial(undefined, { taken: ['quietotter'] });
  const fetcher = async (input, init) => new URL(input).href === 'https://registry.npmjs.org/lodash'
    ? Response.json({ error: 'Not found' }, { status: 404 }) : base(input, init);
  const rows = (await checkSocialHandles([{ name: 'quietotter' }], { directory, now, fetcher })).get('quietotter');
  const npm = rows.find(row => row.platform === 'npm');
  assert.equal(npm.state, 'check');
  assert.equal(npm.why, 'control check failed');
  assert.equal(rows.find(row => row.platform === 'GitHub').state, 'taken');
  // Nothing unverified is cached.
  resetHandleRuns();
  const again = (await checkSocialHandles([{ name: 'quietotter' }], { directory, now, fetcher: base })).get('quietotter');
  assert.equal(again.find(row => row.platform === 'npm').state, 'taken');
});

test('caches taken for 7 days and no public profile for 1 hour, keeps the original check time, never caches check', async t => {
  const directory = await directoryFor(t);
  const calls = [];
  const fetcher = withSocial(undefined, { taken: ['oakenroom'], calls });
  const rows = [{ name: 'oakenroom', platforms: ['GitHub'] }, { name: 'lanternbay', platforms: ['GitHub'] }];
  await checkSocialHandles(rows, { directory, now, fetcher });
  assert.equal(calls.length, 4); // two controls and two handles
  const run = async at => {
    calls.length = 0;
    resetHandleRuns();
    const result = await checkSocialHandles(rows, { directory, now: at, fetcher });
    const github = name => result.get(name).find(row => row.platform === 'GitHub');
    return { calls: calls.map(([, handle]) => handle), taken: github('oakenroom'), missing: github('lanternbay') };
  };
  const later = await run(new Date(+now + hour - 1));
  assert.deepEqual(later.calls, []);
  assert.equal(later.taken.checkedAt, now.toISOString());
  assert.equal(later.missing.checkedAt, now.toISOString());
  const afterHour = await run(new Date(+now + hour));
  assert.deepEqual(afterHour.calls.filter(handle => !/^zq|^github$/.test(handle)), ['lanternbay']);
  assert.equal(afterHour.taken.checkedAt, now.toISOString());
  const week = await run(new Date(+now + handleLifetime.taken));
  assert.ok(week.calls.includes('oakenroom'));
  assert.equal(handleLifetime.taken, 7 * 24 * hour);
  assert.equal(handleLifetime['not-found'], hour);
});

test('one platform shares one time budget for its controls, handles and variants; a slow platform reads check', async t => {
  const clock = deadlineClock(t);
  const base = withSocial(undefined, { taken: ['quietotter'] });
  const slowSignals = [];
  const fetcher = (input, init) => {
    if (new URL(input).hostname !== 'public.api.bsky.app') return base(input, init);
    slowSignals.push(init.signal);
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  };
  const checking = checkSocialHandles([{ name: 'quietotter', variants: true }],
    { directory: null, now, fetcher, budgetMs: 250, freshRun: true });
  // The injected APIs have no I/O. Let the fast answers settle and the slow calls reach their abort listener.
  await new Promise(setImmediate);
  assert.equal(slowSignals.length, 3);
  clock.tick(249);
  assert.ok(slowSignals.every(signal => !signal.aborted));
  clock.tick(1);
  assert.ok(slowSignals.every(signal => signal.aborted));
  const rows = (await checking).get('quietotter');
  assert.equal(rows.find(row => row.platform === 'Bluesky').state, 'check');
  assert.equal(rows.find(row => row.platform === 'GitHub').state, 'taken');
});

test('reads each API strictly: an unexpected body is "check yourself", never a guess', async t => {
  const directory = await directoryFor(t);
  const base = withSocial();
  const fetcher = async (input, init) => {
    const url = new URL(input);
    // A login that is not the handle, an HTML 404 and an unrelated 400.
    if (url.pathname === '/users/quietotter') return Response.json({ login: 'someoneelse', type: 'User' });
    if (url.pathname === '/quietotter') return new Response('<html>Not found</html>', { status: 404, headers: { 'content-type': 'text/html' } });
    if (url.searchParams.get('handle') === 'quietotter.bsky.social') return Response.json({ error: 'RateLimitExceeded' }, { status: 400 });
    return base(input, init);
  };
  const rows = (await checkSocialHandles([{ name: 'quietotter' }], { directory, now, fetcher })).get('quietotter');
  assert.deepEqual(states(rows.filter(row => autoPlatforms.includes(row.platform))), { GitHub: 'check', npm: 'check', Bluesky: 'check' });
});

test('a GitHub rate limit holds GitHub checks until the reset, without new requests', async t => {
  const directory = await directoryFor(t);
  const calls = [];
  const reset = String(Math.floor((+now + 30 * 60_000) / 1000));
  const fetcher = withSocial(async () => assert.fail('unexpected'), { calls });
  const limited = async (input, init) => new URL(input).hostname === 'api.github.com'
    ? Response.json({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-reset': reset, 'x-ratelimit-remaining': '0' } })
    : fetcher(input, init);
  const only = { name: 'quietotter', platforms: ['GitHub'], links: false };
  const first = (await checkSocialHandles([only], { directory, now, fetcher: limited })).get('quietotter');
  assert.deepEqual(first.map(row => [row.platform, row.state]), [['GitHub', 'check']]);
  resetHandleRuns();
  calls.length = 0;
  const second = (await checkSocialHandles([only], { directory, now, fetcher })).get('quietotter');
  assert.equal(second[0].state, 'check');
  assert.equal(second[0].why, 'rate limited');
  assert.deepEqual(calls, []);
});

test('an optional GitHub token goes only to api.github.com', async t => {
  const directory = await directoryFor(t);
  const seen = [];
  const base = withSocial();
  const fetcher = async (input, init) => {
    seen.push([new URL(input).hostname, init.headers.Authorization ?? null]);
    return base(input, init);
  };
  const env = { DOMAIN_HOUND_GITHUB_TOKEN: 'ghp_' + 'x'.repeat(36) };
  await checkSocialHandles([{ name: 'quietotter' }], { directory, now, fetcher, env });
  assert.ok(seen.filter(([host]) => host === 'api.github.com').every(([, auth]) => auth === 'Bearer ' + env.DOMAIN_HOUND_GITHUB_TOKEN));
  assert.ok(seen.filter(([host]) => host !== 'api.github.com').every(([, auth]) => auth === null));
});
