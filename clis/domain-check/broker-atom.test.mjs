import assert from 'node:assert/strict';
import { test } from 'node:test';
import { atomSearchUrl, lookupAtomListing } from './broker-atom.mjs';

const domain = 'example.com';
const listing = { domain: 'Example.com', url: 'https://www.atom.com/name/example', price: 1250, currency: 'USD' };
const now = () => new Date('2026-11-25T15:00:00Z');
const reply = results => Response.json({ jsonrpc: '2.0', id: 1, result: { structuredContent: { success: true, results } } });

test('uses only the public Atom search and accepts a sourced exact-domain record', async () => {
  const result = await lookupAtomListing(domain, {
    now,
    fetcher: async (url, options) => {
      assert.equal(url, atomSearchUrl);
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'search_brandable_domains', arguments: { concept: domain, page_size: 10 } },
      });
      return reply([{ ...listing, domain: 'anotherexample.com', price: 5 }, listing]);
    },
  });
  assert.deepEqual(result, {
    status: 'listed', url: atomSearchUrl, checkedAt: now().toISOString(),
    listingUrl: listing.url, price: { amount: 1250, currency: 'USD' },
  });
});

test('keeps semantic misses inconclusive and drops untrusted links, prices and responses', async () => {
  const lookup = fetcher => lookupAtomListing(domain, { now, fetcher });
  assert.equal((await lookup(async () => reply([{ ...listing, domain: 'example.net' }]))).status, 'no-exact-result');
  const fakeUrl = 'https://www.atom.com/name/other';
  assert.equal((await lookup(async () => reply([{ ...listing, url: fakeUrl }]))).status, 'unavailable');
  for (const price of ['1250', -1, 0]) {
    const result = await lookup(async () => reply([{ ...listing, price }]));
    assert.equal(result.status, 'listed');
    assert.equal(result.price, null);
  }
  assert.equal((await lookup(async () => Response.json({}, { status: 429 }))).status, 'unavailable');
  assert.equal((await lookup(async () => reply([{ ...listing, oversized: 'x'.repeat(97 * 1024) }]))).status, 'unavailable');
});
