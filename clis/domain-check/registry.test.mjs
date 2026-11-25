import '../../test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { lookupRegistrations } from './registry.mjs';

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
      if (term === 'unknown.io') return 'WHOIS Rate Limit Exceeded\r\n';
      return 'Domain not found.\r\n';
    },
  };
  const batch = ['example.co', 'example.io', 'sample.me', 'unknown.io'].map(domain => ({
    domain, tld: domain.split('.').at(-1),
  }));
  const result = await lookupRegistrations(batch, options);
  assert.deepEqual(result.map(({ status, source }) => [status, source]), [
    ['free', 'rdap'], ['free', 'whois'], ['taken', 'whois'], ['unknown', 'rdap'],
  ]);
  assert.match(result[3].reason, /HTTP 429/);
  assert.deepEqual(referrals.sort(), ['io', 'me']);
  assert.ok(requests.includes('https://rdap.registry.co/co/domain/example.co'));
  assert.ok(requests.filter(url => url.includes('identitydigital.services')).length <= 2);

  requests.length = 0;
  const [next] = await lookupRegistrations([{ domain: 'fresh.me', tld: 'me' }], options);
  assert.deepEqual(next, { status: 'free', source: 'whois' });
  assert.deepEqual(requests, []);
});
