import '../../test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { withSocial } from '../../test-support/social-fixture.mjs';
import { deadlineClock } from '../../test-support/deadline-clock.mjs';
import { autoPlatforms, checkGooglePlayNames, checkSocialHandles, handleLifetime, handlePlatforms, handleStates, handleSummary, resetHandleRuns }
  from './handles.mjs';

const now = new Date('2026-11-25T12:00:00Z');
const hour = 3_600_000;
const fixtures = JSON.parse(await readFile(new URL('./fixtures/public-name-checks.json', import.meta.url), 'utf8'));
const youtube = JSON.parse(await readFile(new URL('./fixtures/youtube-handle.json', import.meta.url), 'utf8'));

async function directoryFor(t) {
  const path = await mkdtemp(join(tmpdir(), 'hound-handles-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  resetHandleRuns();
  return pathToFileURL(path + '/');
}

const states = rows => Object.fromEntries(rows.map(row => [row.platform, row.state]));

test('shows every platform in Lars’s order with three states only; ambiguous replies and link-only platforms stay unknown', async t => {
  const directory = await directoryFor(t);
  const calls = [];
  const result = await checkSocialHandles([{ name: 'quietotter', variants: true }], {
    directory, now, fetcher: withSocial(undefined, { taken: ['quietotter'], calls }),
  });
  const rows = result.get('quietotter');
  assert.deepEqual(rows.map(row => row.platform), ['YouTube', 'X', 'Instagram', 'TikTok', 'Threads', 'Facebook', 'LinkedIn',
    'GitHub', 'npm', 'PyPI', 'Bluesky']);
  assert.deepEqual(states(rows), { YouTube: 'unknown', X: 'unknown', Instagram: 'unknown', TikTok: 'unknown', Threads: 'unknown', Facebook: 'unknown',
    LinkedIn: 'unknown', GitHub: 'taken', npm: 'taken', PyPI: 'unknown', Bluesky: 'taken' });
  assert.equal(rows[0].link, 'https://www.youtube.com/@quietotter');
  assert.equal(rows[0].why, 'no clear answer');
  assert.equal(rows.find(row => row.platform === 'LinkedIn').linkLabel, 'Search LinkedIn');
  assert.equal(rows.find(row => row.platform === 'PyPI').link, 'https://pypi.org/project/quietotter/');
  assert.equal(rows.find(row => row.platform === 'Bluesky').link, 'https://bsky.app/profile/quietotter.bsky.social');
  // Taken exact handles get their variants; none of them exist here.
  const github = rows.find(row => row.platform === 'GitHub');
  assert.deepEqual(github.variants.map(row => [row.handle, row.state]),
    [['getquietotter', 'not-found'], ['quietotterapp', 'not-found'], ['quietotterhq', 'not-found']]);
  // No request ever goes to a link-only platform.
  assert.deepEqual([...new Set(calls.map(([platform]) => platform))].sort(), ['Bluesky', 'GitHub', 'npm']);
  assert.deepEqual(autoPlatforms, ['YouTube', 'X', 'Instagram', 'TikTok', 'Threads', 'GitHub', 'npm', 'Bluesky']);
  assert.deepEqual(Object.values(handleStates), ['Taken', 'No profile found', "Couldn't check"]);
  assert.doesNotMatch(JSON.stringify(rows) + JSON.stringify(handleStates), /free|available/i);
  assert.equal(handlePlatforms.length, 11);
});

test('variants run only when the exact handle is taken, and missing handles read "no profile found"', async t => {
  const directory = await directoryFor(t);
  const calls = [];
  const result = await checkSocialHandles([{ name: 'hushroom', variants: true }], {
    directory, now, fetcher: withSocial(undefined, { taken: ['gethushroom'], calls }),
  });
  const rows = result.get('hushroom');
  assert.deepEqual(states(rows.filter(row => autoPlatforms.includes(row.platform))), { YouTube: 'unknown', X: 'unknown', Instagram: 'unknown', TikTok: 'unknown', Threads: 'unknown', GitHub: 'not-found', npm: 'not-found', Bluesky: 'not-found' });
  assert.ok(rows.every(row => !row.variants));
  assert.ok(!calls.some(([, handle]) => /gethushroom/.test(handle)));
  assert.equal(handleSummary(rows), "GitHub · No profile found, npm · No profile found, Bluesky · No profile found · "
    + "Couldn't check (YouTube, X, Instagram, TikTok, Threads, Facebook, PyPI) · LinkedIn doesn't allow checks");
});

test('a wrong control answer turns that platform into check links for the whole run', async t => {
  const directory = await directoryFor(t);
  // npm stops reporting a known package, so no npm answer is trusted.
  const base = withSocial(undefined, { taken: ['quietotter'] });
  const fetcher = async (input, init) => new URL(input).href === 'https://registry.npmjs.org/lodash'
    ? Response.json({ error: 'Not found' }, { status: 404 }) : base(input, init);
  const rows = (await checkSocialHandles([{ name: 'quietotter' }], { directory, now, fetcher })).get('quietotter');
  const npm = rows.find(row => row.platform === 'npm');
  assert.equal(npm.state, 'unknown');
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
  assert.equal(rows.find(row => row.platform === 'Bluesky').state, 'unknown');
  assert.equal(rows.find(row => row.platform === 'GitHub').state, 'taken');
});

test('reads each API strictly: an unexpected body is "unknown", never a guess', async t => {
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
  assert.deepEqual(states(rows.filter(row => autoPlatforms.includes(row.platform))), { YouTube: 'unknown', X: 'unknown', Instagram: 'unknown', TikTok: 'unknown', Threads: 'unknown', GitHub: 'unknown', npm: 'unknown', Bluesky: 'unknown' });
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
  assert.deepEqual(first.map(row => [row.platform, row.state]), [['GitHub', 'unknown']]);
  resetHandleRuns();
  calls.length = 0;
  const second = (await checkSocialHandles([only], { directory, now, fetcher })).get('quietotter');
  assert.equal(second[0].state, 'unknown');
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

test('YouTube matches Worker states, retries one transient failure and caches definite answers for one hour', async t => {
  const directory = await directoryFor(t);
  const env = { YOUTUBE_API_KEY: 'fixture-placeholder' };
  const fixtures = { quietotter: youtube.taken, absentbrand: youtube.missing, gonebrand: youtube.channelNotFound,
    quotaerror: youtube.quota, unrelated: youtube.unrelated404, malformed: youtube.malformed };
  const attempts = new Map();
  const fetcher = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin + url.pathname, 'https://www.googleapis.com/youtube/v3/channels');
    assert.equal(url.searchParams.get('part'), 'id');
    assert.equal(url.searchParams.has('key'), false);
    assert.equal(new Headers(init.headers).get('x-goog-api-key'), env.YOUTUBE_API_KEY);
    assert.equal(init.redirect, 'error');
    const name = url.searchParams.get('forHandle').slice(1);
    attempts.set(name, (attempts.get(name) ?? 0) + 1);
    const fixture = name === 'quietotter' && attempts.get(name) === 1 ? youtube.transient : fixtures[name];
    return Response.json(fixture.body, { status: fixture.status });
  };
  const rows = Object.keys(fixtures).map(name => ({ name, platforms: ['YouTube'], links: false }));
  const run = (options = {}) => checkSocialHandles(rows, { directory, now, fetcher, env, ...options });
  const checked = await run();
  assert.deepEqual([...checked.values()].map(([row]) => row.state),
    ['taken', 'not-found', 'not-found', 'unknown', 'unknown', 'unknown']);
  assert.equal(attempts.get('quietotter'), 2);
  assert.ok(checked.get('malformed')[0].why);
  assert.equal(attempts.get('quotaerror'), 1);
  const cached = await run({ now: new Date(+now + hour - 1) });
  assert.equal(cached.get('quietotter')[0].checkedAt, now.toISOString());
  assert.equal(attempts.get('quietotter'), 2);
  assert.equal(attempts.get('absentbrand'), 1);
  assert.equal(attempts.get('malformed'), 2);
  await run({ now: new Date(+now + hour) });
  assert.equal(attempts.get('quietotter'), 3);
  assert.equal(attempts.get('absentbrand'), 2);
});

for (const [kind, platform] of [
  ['tiktok', 'TikTok'], ['instagram', 'Instagram'], ['x', 'X'], ['youtube', 'YouTube'], ['threads', 'Threads'], ['googlePlay', 'Google Play'],
]) {
  test(`${platform} local check accepts only recorded response signatures`, async () => {
    const counts = { taken: 0, 'not-found': 0, unknown: 0 };
    const play = kind === 'googlePlay';
    const { publicUrls } = await import('./public-name-checks.mjs');
    for (const [key, name] of [['taken', play ? 'Paper Heron' : 'paperheron'], ['not-found', play ? 'Absent Brand' : 'absentbrand'],
      ['unknown', play ? 'Changed Brand' : 'changedbrand'], ['login', 'loginwall'], ['limited', 'limitedbrand']]) {
      const { status, type, body } = fixtures[kind][key];
      const options = { directory: null, env: {}, fetcher: async (url, init) => {
        assert.equal(url, publicUrls[kind](name));
        assert.equal(init.redirect, 'manual');
        assert.equal(new Headers(init.headers).has('x-goog-api-key'), false);
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });
      } };
      const row = play ? (await checkGooglePlayNames([name], options)).get(name)
        : (await checkSocialHandles([{ name, platforms: [platform], links: false }], options)).get(name)[0];
      assert.equal(row.state, ['login', 'limited'].includes(key) ? 'unknown' : key);
      assert.equal(Boolean(row.why), row.state === 'unknown');
      if (key === 'limited') assert.equal(row.why, 'rate-limited');
      counts[row.state]++;
    }
    assert.deepEqual(counts, { taken: 1, 'not-found': 1, unknown: 3 });
  });
}

test('turning embeds off leaves the original links, skips Google Play, and still checks YouTube without a key', async () => {
  const calls = [];
  const options = { directory: null, env: { DOMAIN_HOUND_EMBED_CHECKS: 'off' }, fetcher: async url => {
    calls.push(url);
    const { status, type, body } = fixtures.youtube.taken;
    return new Response(body, { status, headers: { 'content-type': type } });
  } };
  const name = 'paperheron';
  const platforms = ['YouTube', 'X', 'Instagram', 'TikTok', 'Threads'];
  const handles = (await checkSocialHandles([{ name, platforms, links: false }], options)).get(name);
  assert.deepEqual(states(handles), { YouTube: 'taken', X: 'unknown', Instagram: 'unknown', TikTok: 'unknown', Threads: 'unknown' });
  assert.ok(handles.every(row => row.link));
  assert.deepEqual(handles.slice(1).map(row => row.why), ['lookup requires approved API access', 'embed only', 'embed only', 'link only']);
  assert.equal((await checkGooglePlayNames([name], options)).size, 0);
  assert.deepEqual(calls, ['https://www.youtube.com/@paperheron']);
});

test('cache keeps public page results separate from the optional YouTube API', async t => {
  const directory = await directoryFor(t);
  const hosts = [];
  const options = { directory, now, fetcher: async url => {
    const host = new URL(url).hostname;
    hosts.push(host);
    if (host === 'www.googleapis.com') return Response.json({ items: [] });
    return new Response(fixtures.youtube.taken.body, { headers: { 'content-type': fixtures.youtube.taken.type } });
  } };
  const rows = [{ name: 'paperheron', platforms: ['YouTube'], links: false }];
  const state = async env => (await checkSocialHandles(rows, { ...options, env })).get('paperheron')[0].state;
  assert.equal(await state({}), 'taken');
  assert.equal(await state({ YOUTUBE_API_KEY: 'fixture-placeholder' }), 'not-found');
  assert.equal(await state({}), 'taken');
  assert.deepEqual(hosts, ['www.youtube.com', 'www.googleapis.com']);
});
