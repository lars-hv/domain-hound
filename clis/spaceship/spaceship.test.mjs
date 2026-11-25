import '../../test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { startSpaceshipMock } from '../../test-support/spaceship-mock.mjs';
import { testRegistrar } from '../../test-support/spaceship-test-registrar.mjs';
import { blockedReasons, capCents, liveRegistrar } from './buy.mjs';
import { isLoopback, missingKeyText, spaceshipBase, spaceshipClient, spaceshipCredentials } from './client.mjs';
import { planChanges } from './dns.mjs';
import { liveOffer, readOffer } from './quote.mjs';
import { stateStore } from './store.mjs';
import { buyTool, currentDescription, purchaseHandlers, quoteTool, registeredTools, setupTool, withCheckQuoteOffer,
  withWatchQuoteOffer } from './tools.mjs';

// Zero live calls: any request that is not to the local mock fails the test run.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  if (!isLoopback(String(url))) throw Error('Live network call in a Spaceship test: ' + url);
  return realFetch(url, options);
};

const start = Date.parse('2026-11-25T12:00:00.000Z');

async function harness(t, { live = false, env = {}, keys = true } = {}) {
  const mock = await startSpaceshipMock();
  const directory = await mkdtemp(join(tmpdir(), 'hound-spaceship-'));
  t.after(async () => {
    await mock.close();
    await rm(directory, { recursive: true, force: true });
  });
  const clientFor = credentials => spaceshipClient({ ...credentials, baseUrl: mock.baseUrl });
  const client = clientFor({ key: mock.key, secret: mock.secret });
  let clock = start;
  const call = purchaseHandlers({ env, credentials: async () => keys ? { key: mock.key, secret: mock.secret } : null, clientFor,
    store: stateStore(directory), registrar: live ? liveRegistrar : testRegistrar(client),
    registry: async ([{ domain }]) => [{ status: mock.state.domains.has(domain) ? 'taken' : 'free' }],
    now: () => new Date(clock), sleep: async () => {} });
  return { mock, call, client, directory, advance: ms => { clock += ms; } };
}

const text = result => result.content[0].text;
const data = result => result.structuredContent;

async function quoted(h, domain = 'lanternbay.com', offer = {}) {
  h.mock.setOffer(domain, offer);
  const result = await h.call('quote_domain', { domain });
  assert.equal(result.isError, false, text(result));
  return data(result).quote;
}

test('quote reads the exact live price, renewal and term, bound to an ID that expires in 10 minutes', async t => {
  const h = await harness(t);
  const quote = await quoted(h, 'lanternbay.com', { register: { 1: '5.98', 2: '18.96' }, renew: { 1: '10.98' } });
  assert.deepEqual({ domain: quote.domain, years: quote.years, amount: quote.amount, currency: quote.currency, renewal: quote.renewal,
    premium: quote.premium, registry: quote.registry }, { domain: 'lanternbay.com', years: 1, amount: 598, currency: 'USD',
    renewal: { years: 1, amount: 1098, currency: 'USD' }, premium: false, registry: 'free' });
  assert.match(quote.id, /^dhq-[0-9a-f]{20}$/);
  assert.equal(quote.checkedAt, '2026-11-25T12:00:00.000Z');
  assert.equal(quote.expiresAt, '2026-11-25T12:10:00.000Z');
  const result = await h.call('quote_domain', { domain: 'lanternbay.com' });
  assert.match(text(result), /^lanternbay\.com: \$5\.98 now for 1 year, then \$10\.98 per year\. Standard price\./);
  assert.match(text(result), /Checked 12:00 UTC, quote expires 12:10 UTC\. Quote ID dhq-/);
  assert.match(text(result), /To buy: show the person this exact quote\./);
  // Documented endpoints, documented headers.
  const paths = h.mock.state.requests.map(row => row.method + ' ' + row.path);
  assert.ok(paths.includes('GET /v1/domains/lanternbay.com/available'));
  assert.ok(paths.includes('GET /v1/domains/lanternbay.com/pricing'));
  assert.ok(h.mock.state.requests.every(row => row.key === h.mock.key && row.secret === h.mock.secret));
});

test('.ai quotes the shortest offered term of at least two years', async t => {
  const h = await harness(t);
  const quote = await quoted(h, 'lanternbay.ai', { register: { 1: '80.00', 2: '159.98', 3: '239.97' }, renew: { 2: '159.98' } });
  assert.equal(quote.years, 2);
  assert.equal(quote.amount, 15998);
  assert.deepEqual(quote.renewal, { years: 2, amount: 15998, currency: 'USD' });
  h.mock.setOffer('only.ai', { register: { 1: '80.00' }, renew: { 1: '80.00' } });
  const none = await h.call('quote_domain', { domain: 'only.ai' });
  assert.equal(data(none).quote, null);
  assert.match(text(none), /no registration term/);
});

test('no quote for a taken name, an unpriced premium, a non-USD price or a registry that says registered', async t => {
  const h = await harness(t);
  h.mock.setOffer('taken.com', { result: 'taken' });
  assert.match(text(await h.call('quote_domain', { domain: 'taken.com' })), /no quote\. Spaceship lists it as taken\./);
  h.mock.setOffer('fancy.com', { premiumPricing: [{ operation: 'register', price: 2500, currency: 'USD' }] });
  assert.match(text(await h.call('quote_domain', { domain: 'fancy.com' })), /marks it premium but prices it as standard/);
  h.mock.setOffer('euro.com', { currency: 'EUR' });
  assert.match(text(await h.call('quote_domain', { domain: 'euro.com' })), /priced it in EUR/);
  const term = { period: { value: 1, unit: 'y' }, priceInDefaultCurrency: { finalPrice: { amount: '9.98', currency: 'USD' } } };
  const offerClient = { available: async domain => ({ domain, result: 'available' }),
    pricing: async domain => ({ domain, priceClass: 'standard', prices: { register: [term], renew: [term] } }) };
  assert.equal((await liveOffer('gone.com', { client: offerClient, registry: async () => [{ status: 'free' }] })).status, 'available');
  const gone = await liveOffer('gone.com', { client: offerClient, registry: async () => [{ status: 'taken' }] });
  assert.equal(gone.status, 'taken');
  assert.equal(gone.reason, 'The registry lists it as registered.');
  assert.equal(readOffer('gone.com', { domain: 'gone.com', result: 'available' },
    { domain: 'gone.com', priceClass: 'standard', prices: { register: [], renew: [] } }).status, 'unpriced');
});

test('buy requires a valid quote and sends nothing without one', async t => {
  const h = await harness(t);
  const result = await h.call('buy_domain', { domain: 'lanternbay.com', quote_id: 'dhq-00000000000000000000', max_usd: 20 });
  assert.match(text(result), /^No valid quote with that ID\./);
  assert.equal(h.mock.state.requests.length, 0);
  assert.equal((await h.call('buy_domain', { domain: 'lanternbay.com', max_usd: 20 })).isError, true);
  assert.equal((await h.call('buy_domain', { domain: 'lanternbay.com', quote_id: 'x' })).isError, true);
  assert.equal((await h.call('buy_domain', { domain: 'lanternbay.com', quote_id: 'x', max_usd: 20, cap_usd: 100 })).isError, true);
});

test('an expired quote is refused', async t => {
  const h = await harness(t);
  const quote = await quoted(h);
  h.advance(10 * 60_000);
  const result = await h.call('buy_domain', { domain: 'lanternbay.com', quote_id: quote.id, max_usd: 20, confirm: true });
  assert.match(text(result), /expired at 12:10 UTC\. Quote again\. Nothing ordered\./);
  assert.equal(h.mock.sent('POST').length, 0);
});

test('a changed price, renewal, term or premium status refuses the order', async t => {
  const h = await harness(t);
  for (const [change, pattern] of [[{ register: { 1: '10.98' } }, /price changed from \$9\.98 to \$10\.98/],
    [{ renew: { 1: '14.98' } }, /renewal changed from \$12\.98 to \$14\.98/],
    [{ register: { 2: '19.96' }, renew: { 2: '25.96' } }, /availability is now unpriced/],
    [{ priceClass: 'premium' }, /premium status changed from standard to premium/],
    [{ result: 'taken' }, /availability is now taken/]]) {
    const quote = await quoted(h);
    h.mock.setOffer('lanternbay.com', change);
    const result = await h.call('buy_domain', { domain: 'lanternbay.com', quote_id: quote.id, max_usd: 20, confirm: true });
    assert.match(text(result), pattern);
    assert.match(text(result), /^Not ordered: /);
  }
  assert.equal(h.mock.sent('POST').length, 0);
});

test('the explicit max and the configured cap both stop the order, and the agent cannot raise the cap', async t => {
  const h = await harness(t, { env: { DOMAIN_HOUND_MAX_USD: '5' } });
  const quote = await quoted(h);
  assert.match(text(await h.call('buy_domain', { domain: 'lanternbay.com', quote_id: quote.id, max_usd: 9.97, confirm: true })),
    /over the max of \$9\.97/);
  assert.match(text(await h.call('buy_domain', { domain: 'lanternbay.com', quote_id: quote.id, max_usd: 50, confirm: true })),
    /over the cap of \$5\.00 set by DOMAIN_HOUND_MAX_USD/);
  const defaults = await harness(t);
  const pricey = await quoted(defaults, 'pricey.com', { register: { 1: '39.98' } });
  assert.match(text(await defaults.call('buy_domain', { domain: 'pricey.com', quote_id: pricey.id, max_usd: 50, confirm: true })),
    /over the cap of \$30\.00/);
  assert.equal(capCents({}), 3000);
  assert.throws(() => capCents({ DOMAIN_HOUND_MAX_USD: 'lots' }), /must be a dollar amount/);
  assert.ok(!Object.hasOwn(buyTool.inputSchema.properties, 'cap_usd'));
  assert.equal(h.mock.sent('POST').length + defaults.mock.sent('POST').length, 0);
});

test('without confirm true, buy is a dry run', async t => {
  const h = await harness(t);
  const quote = await quoted(h);
  const result = await h.call('buy_domain', { domain: 'lanternbay.com', quote_id: quote.id, max_usd: 20 });
  assert.match(text(result), /^Dry run\. Nothing ordered\.\nlanternbay\.com: \$9\.98 now for 1 year, then \$12\.98 per year\./);
  assert.match(text(result), /Only after their yes, call buy_domain again with confirm true\./);
  assert.equal(data(result).dryRun, true);
  assert.equal(h.mock.sent('POST').length, 0);
});

test('a confirmed order sends one domainCreate to the mock, then reads back and writes a receipt', async t => {
  const h = await harness(t);
  const quote = await quoted(h);
  const result = await h.call('buy_domain', { domain: 'lanternbay.com', quote_id: quote.id, max_usd: 20, confirm: true });
  assert.equal(data(result).ordered, true, text(result));
  const [order] = h.mock.sent('POST');
  assert.equal(order.path, '/v1/domains/lanternbay.com');
  assert.deepEqual(order.body, { autoRenew: true, years: 1, privacyProtection: { level: 'high', userConsent: true },
    contacts: { registrant: 'owner-contact-1', admin: 'owner-contact-1', tech: 'owner-contact-1', billing: 'owner-contact-1' } });
  assert.match(text(result), /Readback: registered, high privacy, auto renew on, owner contact set\./);
  const receipt = JSON.parse(await readFile(data(result).receiptPath, 'utf8'));
  assert.deepEqual(receipt.checks, { registered: true, privacyHigh: true, autoRenew: true, ownerIsRegistrant: true });
  assert.equal(receipt.amount, 998);
  assert.ok(h.mock.sent('GET', /^\/v1\/async-operations\/op-1$/).length >= 1);
});

test('two confirmed calls with the same quote send at most one order', async t => {
  const h = await harness(t);
  const quote = await quoted(h);
  const args = { domain: 'lanternbay.com', quote_id: quote.id, max_usd: 20, confirm: true };
  const results = await Promise.all([h.call('buy_domain', args), h.call('buy_domain', args)]);
  assert.equal(h.mock.sent('POST').length, 1);
  assert.equal(results.filter(result => data(result).ordered).length, 1);
  const again = await h.call('buy_domain', args);
  assert.match(text(again), /already sent|availability is now taken/);
  assert.equal(h.mock.sent('POST').length, 1);
});

test('an unclear order result is never sent again, even with a new quote', async t => {
  const h = await harness(t);
  h.mock.state.createMode = 'drop';
  const first = await quoted(h);
  const result = await h.call('buy_domain', { domain: 'lanternbay.com', quote_id: first.id, max_usd: 20, confirm: true });
  assert.equal(data(result).ambiguous, true);
  assert.match(text(result), /will not send it again/);
  const second = await quoted(h);
  const retry = await h.call('buy_domain', { domain: 'lanternbay.com', quote_id: second.id, max_usd: 20, confirm: true });
  assert.match(text(retry), /already sent \(ambiguous\)\. Domain Hound never sends a second order\./);
  assert.equal(h.mock.sent('POST').length, 1);
});

test('the live client always blocks the order, even confirmed and cheap, and links checkout', async t => {
  const h = await harness(t, { live: true });
  const quote = await quoted(h, 'lanternbay.com', { register: { 1: '1.00' } });
  const quoteText = text(await h.call('quote_domain', { domain: 'lanternbay.com' }));
  assert.match(quoteText, /cannot place this order yet/);
  const result = await h.call('buy_domain', { domain: 'lanternbay.com', quote_id: quote.id, max_usd: 20, confirm: true });
  assert.equal(data(result).blocked, true);
  assert.equal(data(result).ordered, false);
  assert.match(text(result), /^Blocked\. Domain Hound did not order lanternbay\.com\./);
  assert.match(text(result), /reference only and checkout sets the actual charge/);
  assert.match(text(result), /no idempotency key/);
  assert.match(text(result), /cannot look up your account owner contact/);
  assert.match(text(result), /\(https:\/\/www\.spaceship\.com\/domain-search\/\?query=lanternbay\.com\)/);
  const dry = await h.call('buy_domain', { domain: 'lanternbay.com', quote_id: quote.id, max_usd: 20 });
  assert.match(text(dry), /A live order is blocked/);
  assert.equal(h.mock.sent('POST').length, 0);
  assert.equal(blockedReasons(liveRegistrar).length, 3);
  assert.ok(Object.isFrozen(liveRegistrar));
});

test('the production client never sends domainCreate and accepts only the documented base', async () => {
  const calls = [];
  const fetcher = async url => { calls.push(url); throw Error('no network in tests'); };
  const live = spaceshipClient({ key: 'k', secret: 's', fetcher });
  assert.equal(live.baseUrl, spaceshipBase);
  await assert.rejects(live.createDomain('lanternbay.com', {}), /does not send live registration orders/);
  assert.equal(calls.length, 0);
  assert.throws(() => spaceshipClient({ key: 'k', secret: 's', baseUrl: 'https://example.com/api' }), /must be https:\/\/spaceship\.dev\/api/);
});

test('credentials come from the environment, then the Keychain, and missing keys get one minimum-scope instruction', async t => {
  assert.deepEqual(await spaceshipCredentials({ env: { DOMAIN_HOUND_SPACESHIP_KEY: ' k ', DOMAIN_HOUND_SPACESHIP_SECRET: 's' },
    keychain: async () => { throw Error('not asked'); } }), { key: 'k', secret: 's', source: 'environment' });
  const asked = [];
  assert.deepEqual(await spaceshipCredentials({ env: {}, keychain: async account => { asked.push(account); return account + '-value\n'; } }),
    { key: 'spaceship-key-value', secret: 'spaceship-secret-value', source: 'keychain' });
  assert.deepEqual(asked.sort(), ['spaceship-key', 'spaceship-secret']);
  assert.equal(await spaceshipCredentials({ env: {}, keychain: async () => null }), null);
  const h = await harness(t, { keys: false });
  h.mock.setOffer('lanternbay.com');
  assert.match(text(await h.call('quote_domain', { domain: 'lanternbay.com' })), /create a key with only domains:read\./);
  assert.match(text(await h.call('setup_domain', { domain: 'lanternbay.com', website: { provider: 'netlify', target: 'site.netlify.app' } })),
    /only domains:read, dnsrecords:read, dnsrecords:write\./);
  for (const tool of ['quote', 'buy', 'setup']) assert.match(missingKeyText(tool), /Never paste the secret into chat\.$/);
  assert.equal(h.mock.state.requests.length, 0);
});

test('tool descriptions label money and DNS changes, and check descriptions drop stale claims', () => {
  assert.match(buyTool.description, /^COSTS MONEY/);
  assert.equal(buyTool.annotations.title, 'Buy a domain (costs money)');
  assert.equal(buyTool.annotations.destructiveHint, true);
  assert.equal(buyTool.annotations.readOnlyHint, false);
  assert.deepEqual(buyTool.inputSchema.required, ['domain', 'quote_id', 'max_usd']);
  assert.equal(quoteTool.annotations.readOnlyHint, true);
  assert.match(setupTool.description, /^Changes DNS/);
  assert.equal(setupTool.annotations.destructiveHint, true);
  const stale = 'Check things. For any request to buy, pass purchase: true and say “Domain Hound cannot buy or complete checkout,” now.';
  assert.equal(currentDescription(stale), 'Check things. For any request to buy, pass purchase: true and say “This check leaves checkout to you,” now. '
    + 'To buy through the person’s own Spaceship account, use quote_domain, then buy_domain.');
  assert.equal(currentDescription('Alias. Never buys.', false), 'Alias. This check leaves checkout to you.');
  const tools = registeredTools([{ name: 'check_domains', description: stale }, { name: 'broker_find', description: 'Alias. Never buys.' }]);
  assert.deepEqual(tools.map(tool => tool.name), ['check_domains', 'broker_find', 'quote_domain', 'buy_domain', 'setup_domain']);
  for (const tool of tools) assert.doesNotMatch(tool.description, /cannot buy|never buys/i);
});

test('a free watched or exactly checked domain offers the quote in one line', () => {
  const watched = withWatchQuoteOffer({ domain: 'lanternbay.com', status: 'free', say: 'lanternbay.com: free\nOdds.' });
  assert.equal(watched.say, 'lanternbay.com: free\nOdds.\nWant the exact price from your own Spaceship account? Ask to quote lanternbay.com.');
  const taken = { domain: 'taken.com', status: 'taken', say: 'taken.com: taken' };
  assert.equal(withWatchQuoteOffer(taken), taken);
  const say = 'lanternbay.com: confirmed at shop.\nAll endings: [Results page](file:///tmp/x.html)';
  const page = withCheckQuoteOffer({ display: say, say, names: [{ name: 'lanternbay.com', free: [{ d: 'com' }] }] }, { query: 'LanternBay.com' });
  assert.equal(page.say, 'lanternbay.com: confirmed at shop.\nWant the exact price from your own Spaceship account? Ask to quote lanternbay.com.\n'
    + 'All endings: [Results page](file:///tmp/x.html)');
  assert.equal(page.display, page.say);
  const bare = { display: say, say, names: [{ name: 'lanternbay', free: [{ d: 'com' }] }] };
  assert.equal(withCheckQuoteOffer(bare, { query: 'lanternbay' }), bare);
  const gone = { display: say, say, names: [{ name: 'lanternbay.com', taken: ['com'] }] };
  assert.equal(withCheckQuoteOffer(gone, { query: 'lanternbay.com' }), gone);
});

const ghPages = { provider: 'github-pages', target: 'octo.github.io' };

test('setup previews every exact change first, and deletion needs replace true', async t => {
  const h = await harness(t);
  h.mock.setDomain('lanternbay.com', { records: [{ type: 'A', name: '@', address: '192.0.2.10' },
    { type: 'TXT', name: '@', value: 'google-site-verification=abc' }] });
  const preview = await h.call('setup_domain', { domain: 'lanternbay.com', website: ghPages });
  assert.equal(preview.isError, false, text(preview));
  assert.match(text(preview), /^lanternbay\.com DNS plan\. Nothing changed yet\.\nAdd:\n- A @ 185\.199\.108\.153\n- A @ 185\.199\.109\.153\n- A @ 185\.199\.110\.153\n- A @ 185\.199\.111\.153\n- CNAME www octo\.github\.io\nRemove \(only with replace: true\):\n- A @ 192\.0\.2\.10\n/);
  assert.doesNotMatch(text(preview), /google-site-verification/);
  const planId = data(preview).planId;
  assert.match(planId, /^dhp-[0-9a-f]{20}$/);
  assert.equal(h.mock.sent('PUT').length + h.mock.sent('DELETE').length, 0);
  const refused = await h.call('setup_domain', { domain: 'lanternbay.com', plan_id: planId, apply: true });
  assert.match(text(refused), /This plan removes 1 record:\n- A @ 192\.0\.2\.10\nNothing changed\./);
  assert.equal(h.mock.sent('PUT').length + h.mock.sent('DELETE').length, 0);
  const applied = await h.call('setup_domain', { domain: 'lanternbay.com', plan_id: planId, apply: true, replace: true });
  assert.match(text(applied), /Readback matches the plan\./);
  assert.deepEqual(h.mock.sent('DELETE')[0].body, [{ type: 'A', name: '@', address: '192.0.2.10' }]);
  assert.equal(h.mock.sent('PUT')[0].body.force, false);
  assert.equal(h.mock.sent('PUT')[0].body.items.length, 5);
  const left = h.mock.state.records.get('lanternbay.com').map(row => row.type + ' ' + row.name + ' ' + (row.address ?? row.cname ?? row.value));
  assert.ok(left.includes('TXT @ google-site-verification=abc'));
  assert.ok(!left.includes('A @ 192.0.2.10'));
  assert.ok(h.mock.sent('GET', /^\/v1\/domains\/lanternbay\.com$/).length >= 2);
});

test('setup refuses a plan when DNS changed, nameservers are custom, or records are managed or collide', async t => {
  const h = await harness(t);
  h.mock.setDomain('lanternbay.com');
  const preview = await h.call('setup_domain', { domain: 'lanternbay.com', website: ghPages });
  h.mock.state.records.get('lanternbay.com').push({ type: 'TXT', name: '@', value: 'new', ttl: 3600, group: { type: 'custom' } });
  const stale = await h.call('setup_domain', { domain: 'lanternbay.com', plan_id: data(preview).planId, apply: true });
  assert.match(text(stale), /changed since the preview\. Nothing changed\./);
  h.advance(10 * 60_000);
  assert.match(text(await h.call('setup_domain', { domain: 'lanternbay.com', plan_id: data(preview).planId, apply: true })), /expired/);
  h.mock.setDomain('custom.com', { provider: 'custom', hosts: ['ns1.example.net'] });
  assert.match(text(await h.call('setup_domain', { domain: 'custom.com', website: ghPages })), /uses custom nameservers \(ns1\.example\.net\)/);
  h.mock.setDomain('managed.com', { records: [{ type: 'A', name: '@', address: '192.0.2.1', group: { type: 'product' } },
    { type: 'TXT', name: 'www', value: 'hello' }] });
  const blocked = await h.call('setup_domain', { domain: 'managed.com', website: ghPages });
  assert.match(text(blocked), /A @ 192\.0\.2\.1 is managed by Spaceship \(product\)/);
  assert.match(text(blocked), /The CNAME at www collides with TXT www hello/);
  assert.equal(data(blocked).planId, undefined);
  assert.equal(h.mock.sent('PUT').length + h.mock.sent('DELETE').length, 0);
});

test('mail presets keep one SPF and one DMARC, retain what already works, and never invent account values', () => {
  const custom = rows => rows.map(row => ({ ttl: 3600, group: { type: 'custom' }, ...row }));
  const google = planChanges('example.com', { mail: { provider: 'google-workspace' } }, custom([
    { type: 'MX', name: '@', exchange: 'mx.old-host.example', preference: 10 },
    { type: 'TXT', name: '@', value: 'v=spf1 include:sendgrid.net ~all' },
    { type: 'TXT', name: '_dmarc', value: 'v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com' }]));
  assert.deepEqual(google.adds.map(row => row.type + ' ' + row.name + ' ' + Object.values(row.fields).join(' ')),
    ['MX @ smtp.google.com 1', 'TXT @ v=spf1 include:_spf.google.com ~all']);
  assert.deepEqual(google.deletes.map(row => row.type + ' ' + row.name), ['MX @', 'TXT @']);
  assert.ok(google.notices.some(notice => notice.startsWith('Replaces your SPF record: v=spf1 include:sendgrid.net')));
  assert.ok(google.notices.some(notice => notice.startsWith('Keeps your DMARC policy: v=DMARC1; p=quarantine')));
  const kept = planChanges('example.com', { mail: { provider: 'google-workspace' } }, custom([
    { type: 'TXT', name: '@', value: 'v=spf1 include:_spf.google.com include:sendgrid.net ~all' }]));
  assert.equal(kept.deletes.length, 0);
  assert.ok(kept.adds.some(row => row.name === '_dmarc' && row.fields.value === 'v=DMARC1; p=none'));
  const forward = planChanges('example.com', { mail: { provider: 'forward-only', mx: [{ exchange: 'mx1.forwarder.example', preference: 10 }] } }, []);
  assert.deepEqual(forward.adds.map(row => row.fields.value ?? row.fields.exchange), ['mx1.forwarder.example', 'v=spf1 -all', 'v=DMARC1; p=reject']);
  assert.ok(forward.notices.some(notice => /cannot turn it on/.test(notice)));
  const microsoft = planChanges('example.com', { mail: { provider: 'microsoft-365', mx: [{ exchange: 'example-com.mail.protection.outlook.com', preference: 0 }] } }, []);
  assert.ok(microsoft.adds.some(row => row.type === 'CNAME' && row.name === 'autodiscover' && row.fields.cname === 'autodiscover.outlook.com'));
  assert.ok(microsoft.adds.some(row => row.fields.value === 'v=spf1 include:spf.protection.outlook.com -all'));
  const explicit = planChanges('example.com', { mail: { provider: 'proton', dmarc: 'reject' } }, custom([
    { type: 'TXT', name: '_dmarc', value: 'v=DMARC1; p=none' }]));
  assert.ok(explicit.notices.some(notice => notice === 'Replaces your DMARC record: v=DMARC1; p=none'));
  assert.deepEqual(explicit.adds.filter(row => row.type === 'MX').map(row => row.fields.exchange), ['mail.protonmail.ch', 'mailsec.protonmail.ch']);
  const icloud = planChanges('example.com', { mail: { provider: 'icloud', records: [{ type: 'TXT', name: '@', value: 'apple-domain=abc123' },
    { type: 'CNAME', name: 'sig1._domainkey', value: 'sig1.dkim.example.com.at.icloudmailadmin.com' }] } }, []);
  assert.ok(icloud.adds.some(row => row.type === 'CNAME' && row.name === 'sig1._domainkey'));
  assert.ok(icloud.adds.some(row => row.fields.value === 'v=spf1 include:icloud.com ~all'));
  assert.throws(() => planChanges('example.com', { mail: { provider: 'forward-only' } }, []), /forwarding service gives you/);
  assert.throws(() => planChanges('example.com', { mail: { provider: 'microsoft-365' } }, []), /tenant MX/);
  assert.throws(() => planChanges('example.com', { mail: { provider: 'fastmail', records: [{ type: 'TXT', name: '@', value: 'v=spf1 -all' }] } }, []),
    /one of each/);
  assert.throws(() => planChanges('example.com', { website: { provider: 'netlify', target: 'https://site.netlify.app/' } }, []), /not a URL/);
  assert.throws(() => planChanges('example.com', { website: { provider: 'vercel', ipv4: ['76.76.21.21'] } }, []), /Domains page/);
});

test('website presets: Netlify apex ALIAS, Cloudflare Pages www only, plain IP and CNAME on root and www', () => {
  const show = plan => plan.adds.map(row => row.type + ' ' + row.name + ' ' + Object.values(row.fields).join(' '));
  assert.deepEqual(show(planChanges('example.com', { website: { provider: 'netlify', target: 'site.netlify.app' } }, [])),
    ['ALIAS @ apex-loadbalancer.netlify.com', 'CNAME www site.netlify.app']);
  const pages = planChanges('example.com', { website: { provider: 'cloudflare-pages', target: 'project.pages.dev' } }, []);
  assert.deepEqual(show(pages), ['CNAME www project.pages.dev']);
  assert.ok(pages.notices.some(notice => /apex needs Cloudflare nameservers/.test(notice)));
  assert.deepEqual(show(planChanges('example.com', { website: { provider: 'ip', ipv4: ['192.0.2.7'], ipv6: ['2001:db8::7'] } }, [])),
    ['A @ 192.0.2.7', 'AAAA @ 2001:db8::7', 'A www 192.0.2.7', 'AAAA www 2001:db8::7']);
  assert.deepEqual(show(planChanges('example.com', { website: { provider: 'cname', target: 'host.example.net' } }, [])),
    ['ALIAS @ host.example.net', 'CNAME www host.example.net']);
  assert.deepEqual(show(planChanges('example.com', { website: { provider: 'vercel', ipv4: ['76.76.21.21'], www_target: 'abc123.vercel-dns-017.com' } }, [])),
    ['A @ 76.76.21.21', 'CNAME www abc123.vercel-dns-017.com']);
});

test('DNS reads every page of records', async t => {
  const h = await harness(t);
  h.mock.setDomain('many.com', { records: Array.from({ length: 101 }, (_, index) => ({ type: 'TXT', name: 'r' + index, value: 'v' + index })) });
  assert.equal((await h.client.dnsRecords('many.com')).at(-1).name, 'r100');
  assert.deepEqual(h.mock.sent('GET', /^\/v1\/dns\/records\//).map(row => row.query), [{ take: '500', skip: '0' }, { take: '500', skip: '100' }]);
  h.mock.state.dnsPageSize = 0;
  await assert.rejects(h.client.dnsRecords('many.com'), /incomplete DNS list/);
});

test('setup reads back a partial change when an approved delete succeeds but the save fails', async t => {
  const h = await harness(t);
  const domain = 'lanternbay.com';
  h.mock.setDomain(domain, { records: [{ type: 'A', name: '@', address: '192.0.2.10' }] });
  const preview = await h.call('setup_domain', { domain, website: ghPages });
  h.mock.state.dnsSaveFails = true;
  const outcome = await h.call('setup_domain', { domain, plan_id: data(preview).planId, apply: true, replace: true });
  assert.equal(data(outcome).ok, false);
  assert.match(text(outcome), /DNS update is incomplete/);
  assert.match(text(outcome), /Removed: A @ 192\.0\.2\.10/);
  assert.match(text(outcome), /Not found after save: A @ 185\.199\.108\.153/);
  assert.equal(h.mock.sent('GET', /^\/v1\/dns\/records\//).length, 3);
});

test('the server registers the purchase tools and answers buy_domain without a quote locally', async () => {
  const { serve } = await import('../../server.mjs');
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on('data', chunk => lines.push(...chunk.toString().split('\n').filter(Boolean)));
  const done = serve({ input, output });
  for (const message of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'buy_domain', arguments: { domain: 'lanternbay.com', quote_id: 'dhq-00000000000000000000', max_usd: 10, confirm: true } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'quote_domain', arguments: { domain: 'not a domain' } } },
  ]) input.write(JSON.stringify(message) + '\n');
  input.end();
  await done;
  const replies = new Map(lines.map(line => JSON.parse(line)).map(reply => [reply.id, reply.result]));
  assert.deepEqual(replies.get(2).tools.slice(-3).map(tool => tool.name), ['quote_domain', 'buy_domain', 'setup_domain']);
  assert.match(replies.get(3).content[0].text, /^No valid quote with that ID\./);
  assert.equal(replies.get(4).isError, true);
});
