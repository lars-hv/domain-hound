import '../../test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { documentedWhois, lookupRegistrations, resetWhoisPacing, whoisCooldownMs, whoisSpacing } from './registry.mjs';

test('routes .co directly and settles a rate-limited .me/.io batch via registry WHOIS', async t => {
  const path = await mkdtemp(join(tmpdir(), 'hound-registry-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const requests = [];
  const referrals = [];
  const options = {
    directory: pathToFileURL(path + '/'),
    resolveNs: async () => [],
    timeLeft: () => 5000,
    fetcher: async value => {
      requests.push(value);
      if (value.startsWith('https://rdap.registry.co/co/domain/')) return new Response(null, { status: 404 });
      assert.match(value, /^https:\/\/rdap\.identitydigital\.services\/rdap\/domain\//);
      return new Response(null, { status: 429, headers: { 'Retry-After': '3600' } });
    },
    queryWhois: async (host, term) => {
      if (host === 'whois.iana.org') {
        referrals.push(term);
        return 'whois: whois.nic.' + term + '\n';
      }
      assert.equal(host, 'whois.nic.' + term.split('.').at(-1));
      if (term === 'sample.me') return 'Domain Name: sample.me\r\n';
      if (term === 'unknown.io') return 'Temporary failure, try again later\r\n';
      return 'Domain not found.\r\n\r\nTerms of Use: If too many queries are received, queries may be throttled.\r\n';
    },
  };
  const batch = ['example.co', 'example.io', 'sample.me', 'unknown.io'].map(domain => ({
    domain, tld: domain.split('.').at(-1),
  }));
  const result = await lookupRegistrations(batch, options);
  assert.deepEqual(result.map(({ status, source }) => [status, source]), [
    ['free', 'rdap'], ['free', 'whois'], ['taken', 'whois'], ['unknown', 'whois'],
  ]);
  assert.match(result[3].reason, /WHOIS returned no definitive answer/);
  // .io and .me use the registry WHOIS servers the IANA Root Zone Database lists, with no referral query.
  assert.deepEqual(referrals, []);
  assert.ok(requests.includes('https://rdap.registry.co/co/domain/example.co'));
  assert.ok(requests.filter(url => url.includes('identitydigital.services')).length <= 2);

  requests.length = 0;
  const [next] = await lookupRegistrations([{ domain: 'fresh.me', tld: 'me' }], options);
  assert.deepEqual(next, { status: 'free', source: 'whois' });
  assert.deepEqual(requests, []);
});

const identityBatch = domains => domains.map(domain => ({ domain, tld: domain.split('.').at(-1) }));

test('while Identity Digital RDAP cools down, .ai/.io/.me go to their IANA-listed WHOIS hosts, paced per host', async t => {
  resetWhoisPacing();
  const path = await mkdtemp(join(tmpdir(), 'hound-registry-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const directory = pathToFileURL(path + '/');
  // An earlier run saw HTTP 429 with a long Retry-After: the cooldown is on disk.
  const { writeCache } = await import('./cache.mjs');
  await writeCache(directory, 'rdap-cooldown-rdap.identitydigital.services.json', { until: Date.now() + 3_600_000 });
  const rdap = [];
  const starts = [];
  let waits = 0;
  const result = await lookupRegistrations(identityBatch(['one.ai', 'two.ai', 'three.ai', 'one.io', 'one.me']), {
    directory, resolveNs: async () => [], timeLeft: () => 6000,
    // Simulate one late wake-up and then one early wake-up between the .ai queries.
    pause: ms => delay(ms + (waits++ === 0 ? 80 : -20)),
    fetcher: async url => {
      rdap.push(url);
      if (String(url).startsWith('https://data.iana.org/')) return Response.json({ services: [[['ai'], ['https://rdap.identitydigital.services/rdap/']]] });
      return new Response(null, { status: 500 });
    },
    queryWhois: async (host, term) => {
      assert.notEqual(host, 'whois.iana.org');
      starts.push({ host, term, at: performance.now() });
      return term.startsWith('two.') ? 'Domain Name: ' + term + '\r\n' : 'NOT FOUND\r\n';
    },
  });
  assert.deepEqual(result.map(row => [row.status, row.source]), [
    ['free', 'whois'], ['taken', 'whois'], ['free', 'whois'], ['free', 'whois'], ['free', 'whois']]);
  // No RDAP request goes to the cooling host.
  assert.ok(rdap.every(url => !String(url).includes('identitydigital')), rdap.join(' '));
  assert.deepEqual([...new Set(starts.map(row => row.host))].sort(), ['whois.nic.ai', 'whois.nic.io', 'whois.nic.me']);
  assert.equal(documentedWhois.get('ai'), 'whois.nic.ai');
  const ai = starts.filter(row => row.host === 'whois.nic.ai').map(row => row.at);
  assert.equal(ai.length, 3);
  for (let index = 1; index < ai.length; index++) {
    const gap = ai[index] - ai[index - 1];
    assert.ok(gap >= whoisSpacing.identity - 3, 'gap ' + gap);
  }
});

test('a WHOIS rate-limit notice stops queries to that host for this run and the next', async t => {
  resetWhoisPacing();
  const path = await mkdtemp(join(tmpdir(), 'hound-registry-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const directory = pathToFileURL(path + '/');
  const queries = [];
  const options = {
    directory, resolveNs: async () => [], timeLeft: () => 5000, pause: async () => {},
    fetcher: async () => new Response(null, { status: 429, headers: { 'Retry-After': '3600' } }),
    queryWhois: async (host, term) => {
      queries.push(term);
      return 'WHOIS Rate Limit Exceeded\r\n';
    },
  };
  const first = await lookupRegistrations(identityBatch(['alpha.io', 'beta.io', 'gamma.io']), options);
  assert.equal(queries.length, 1);
  assert.ok(first.every(row => row.status === 'unknown'));
  assert.match(first.map(row => row.reason).join(' '), /HTTP 429/);
  // A new process reads the saved cooldown and sends nothing.
  resetWhoisPacing();
  const { readCache } = await import('./cache.mjs');
  const saved = await readCache(directory, 'whois-cooldown-whois.nic.io.json');
  assert.ok(saved.until > Date.now() + whoisCooldownMs - 60_000);
  await lookupRegistrations(identityBatch(['delta.io']), options);
  assert.equal(queries.length, 1);
});

test('reads DENIC, IIS, Punktum and EURid WHOIS answers', async t => {
  resetWhoisPacing();
  const path = await mkdtemp(join(tmpdir(), 'hound-registry-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const replies = {
    'free.de': 'Domain: free.de\nStatus: free\n', 'taken.de': 'Domain: taken.de\nStatus: connect\n',
    'free.se': 'domain "free.se" not found.\n', 'taken.se': 'domain:           taken.se\nstate:            active\n',
    'free.eu': 'Domain: free.eu\nStatus: AVAILABLE\n', 'taken.eu': 'Domain: taken.eu\nStatus: REGISTERED\n',
    'free.dk': '# Hello\nNo entries found for the selected source.\n', 'taken.dk': 'Domain:               taken.dk\nStatus:               Active\n',
  };
  const batch = identityBatch(Object.keys(replies));
  const result = await lookupRegistrations(batch, {
    directory: pathToFileURL(path + '/'), resolveNs: async () => [], timeLeft: () => 5000, pause: async () => {},
    fetcher: async () => Response.json({ services: [] }),
    queryWhois: async (host, term) => host === 'whois.iana.org' ? 'refer: whois.nic.' + term + '\n' : replies[term],
  });
  assert.deepEqual(result.map(row => row.status), ['free', 'taken', 'free', 'taken', 'free', 'taken', 'free', 'taken']);
});
