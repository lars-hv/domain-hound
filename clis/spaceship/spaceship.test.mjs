import '../../test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { ownerContactId, productionFetchTo, startSpaceshipMock } from '../../test-support/spaceship-mock.mjs';
import { directPurchaseEnv } from '../../test-support/spaceship-test-registrar.mjs';
import { capCents, claimKey, directPurchaseEnabled, ownerContact, spaceshipMcp } from './buy.mjs';
import { isLoopback, missingKeyText, spaceshipBase, spaceshipClient, spaceshipCredentials } from './client.mjs';
import { planChanges } from './dns.mjs';
import { liveOffer, readOffer } from './quote.mjs';
import { stateStore } from './store.mjs';
import { buyTool, purchaseHandlers, quoteTool, registeredTools, setupTool, withCheckQuoteOffer,
  withWatchQuoteOffer } from './tools.mjs';

// Zero live calls: any request that is not to the local mock fails the test run.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  if (!isLoopback(String(url))) throw Error('Live network call in a Spaceship test: ' + url);
  return realFetch(url, options);
};

const start = Date.parse('2026-11-25T12:00:00.000Z');

// The person's direct-purchase opt-in, exactly as set in the MCP server environment.
const DIRECT = directPurchaseEnv;

// Every handler uses the production client at the production base URL; only its fetch is routed to the local mock.
async function harness(t, { env = {}, clientEnv = env, keys = true, wrapStore = store => store } = {}) {
  const mock = await startSpaceshipMock();
  const directory = await mkdtemp(join(tmpdir(), 'hound-spaceship-'));
  t.after(async () => {
    await mock.close();
    await rm(directory, { recursive: true, force: true });
  });
  const fetcher = productionFetchTo(mock.baseUrl);
  const client = spaceshipClient({ key: mock.key, secret: mock.secret, env: clientEnv, fetcher });
  const registryStatus = new Map();
  let clock = start;
  const handlers = (handlerEnv, envForClient = handlerEnv, withKeys = keys, wrap = wrapStore) => purchaseHandlers({ env: handlerEnv,
    credentials: async () => withKeys ? { key: mock.key, secret: mock.secret } : null,
    clientFor: credentials => spaceshipClient({ ...credentials, env: envForClient, fetcher }),
    store: wrap(stateStore(directory)),
    registry: async ([{ domain }]) => [{ status: registryStatus.get(domain) ?? (mock.state.domains.has(domain) ? 'taken' : 'free') }],
    now: () => new Date(clock), sleep: async () => {} });
  return { mock, call: handlers(env, clientEnv), handlers, client, directory, registryStatus, advance: ms => { clock += ms; } };
}

const text = result => result.content[0].text;
const data = result => result.structuredContent;
const claimFile = (h, domain = 'lanternbay.com') => join(h.directory, 'claims', claimKey(domain) + '.json');
const claimOnDisk = async (h, domain) => JSON.parse(await readFile(claimFile(h, domain), 'utf8'));

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
  assert.match(text(result), /To buy: show the person this exact quote/);
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
  // Without a valid quote there is nothing to check a checkout against, so no checkout link.
  for (const domain of ['fancy.com', 'euro.com']) {
    assert.doesNotMatch(text(await h.call('quote_domain', { domain })), /spaceship\.com\/domain-search|Buy it yourself/);
  }
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
  // A typical .ai at its two-year minimum is over the default cap, in direct mode too.
  const direct = await harness(t, { env: DIRECT });
  const ai = await quoted(direct, 'lanternbay.ai', { register: { 2: '159.98' }, renew: { 2: '159.98' } });
  assert.equal(ai.years, 2);
  const aiResult = await direct.call('buy_domain', { domain: 'lanternbay.ai', quote_id: ai.id, max_usd: 200, confirm: true });
  assert.match(text(aiResult), /The quote is \$159\.98, over the cap of \$30\.00 set by DOMAIN_HOUND_MAX_USD/);
  assert.equal(direct.mock.sent('POST').length, 0);
  assert.equal(capCents({}), 3000);
  assert.throws(() => capCents({ DOMAIN_HOUND_MAX_USD: 'lots' }), /must be a dollar amount/);
  assert.ok(!Object.hasOwn(buyTool.inputSchema.properties, 'cap_usd'));
  assert.equal(h.mock.sent('POST').length + defaults.mock.sent('POST').length, 0);
});

const buyArgs = (quote, extra = {}) => ({ domain: quote.domain, quote_id: quote.id, max_usd: 20, ...extra });
const noFallback = output => {
  assert.doesNotMatch(output, /domain_register|spaceship\.com\/domain-search|claude mcp add|Buy it yourself/);
  assert.match(output, /Check orders in your Spaceship account first\./);
};

test('without the exact env flag, no POST at the handler: buy hands off to Spaceship’s MCP with explicit ceilings', async t => {
  for (const flag of [undefined, '', '0', 'false', 'true', 'yes', ' 1', '1 ', '01']) {
    const env = flag === undefined ? { DOMAIN_HOUND_SPACESHIP_CONTACT_ID: ownerContactId }
      : { DOMAIN_HOUND_DIRECT_PURCHASE: flag, DOMAIN_HOUND_SPACESHIP_CONTACT_ID: ownerContactId };
    assert.equal(directPurchaseEnabled(env), false, String(flag));
    // The client is allowed to send here, so only the handler's gate stops the order.
    const h = await harness(t, { env, clientEnv: DIRECT });
    const quote = await quoted(h);
    const result = await h.call('buy_domain', buyArgs(quote, { confirm: true }));
    assert.equal(data(result).ordered, false);
    assert.equal(data(result).handoff, 'spaceship-mcp');
    assert.equal(h.mock.sent('POST').length, 0, String(flag));
  }
  const h = await harness(t);
  const quote = await quoted(h);
  const quoteText = text(await h.call('quote_domain', { domain: 'lanternbay.com' }));
  assert.match(quoteText, /hands off to Spaceship’s own MCP \(domain_register\)/);
  const result = await h.call('buy_domain', buyArgs(quote));
  const say = text(result);
  assert.match(say, /^lanternbay\.com: \$9\.98 now for 1 year, then \$12\.98 per year\. Standard price\. Re-checked 12:00 UTC, unchanged\. The quote is within the max of \$20\.00 and the cap of \$30\.00\./);
  assert.match(say, /Hand off to Spaceship’s own MCP\. Domain Hound ordered nothing\./);
  // Preview, check, the person's yes, accept with the same arguments and the bound token, poll, verify, then DNS.
  assert.match(say, /\n1\. Preview: call domain_register with domain lanternbay\.com, 1 year, WHOIS privacy on, auto-renew on, and no confirmationToken\. This registers nothing\.\n/);
  assert.match(say, /\n2\. Check the preview: exactly lanternbay\.com, 1 year, the USD total upfront and the renewal\. Stop if the upfront total is above this quote \$9\.98, the person’s max \$20\.00 or Domain Hound’s cap \$30\.00, if the renewal is above \$12\.98 per year, or if the price or the payment method is missing\. Require USD, WHOIS privacy and auto-renew in the preview\.\n/);
  assert.match(say, /\n3\. Show the person the full confirmation and wait for their yes\. Only then call domain_register again with the exact same arguments, the confirmationToken from that preview and confirmationResponse: "accept"\. A fresh preview needs a fresh yes\.\n/);
  assert.match(say, /\n4\. Poll async_operation_get until the operation finishes\. If the outcome is unclear, stop: no retry and no other route/);
  assert.match(say, /\n5\. After the operation succeeds, call setup_domain with domain lanternbay\.com and verify: true\. Offer DNS setup only after it verifies\.\n/);
  assert.ok(say.includes('(' + spaceshipMcp.docs + ')'));
  assert.ok(say.includes('Claude Code: `claude mcp add --transport http spaceship https://mcp.spaceship.com/mcp`'));
  assert.ok(say.includes('Codex: `codex mcp add spaceship --url https://mcp.spaceship.com/mcp`'));
  // Checkout comes last.
  const lines = say.replace(/\n\nvia domainhound\.dev$/, '').split('\n');
  assert.match(lines.at(-1), /^Last resort, only if Spaceship’s MCP cannot be used and nothing was submitted there: Buy it yourself at Spaceship: \[lanternbay\.com at Spaceship\]\(https:\/\/www\.spaceship\.com\/domain-search\/\?query=lanternbay\.com\)\. Before paying, check the same limits: 1 year, at most \$9\.98 upfront \(this quote; your max \$20\.00, cap \$30\.00\), renewal at most \$12\.98 per year, WHOIS privacy on, auto-renew on\./);
  assert.equal(say.match(/spaceship\.com\/domain-search/g).length, 1);
  assert.deepEqual(data(result).ceilings, { quote: 998, max: 2000, cap: 3000 });
  assert.equal(h.mock.sent('POST').length, 0);
  // No tool argument can switch direct purchase on or set the owner contact.
  for (const extra of [{ direct: true }, { DOMAIN_HOUND_DIRECT_PURCHASE: '1' }, { contact_id: ownerContactId }]) {
    assert.equal((await h.call('buy_domain', buyArgs(quote, { confirm: true, ...extra }))).isError, true);
  }
  for (const name of ['direct', 'contact_id', 'owner', 'cap_usd']) assert.ok(!Object.hasOwn(buyTool.inputSchema.properties, name));
  assert.equal(h.mock.sent('POST').length, 0);
});

test('without the exact env flag, the production HTTP client refuses domainCreate, on loopback and on the live base', async t => {
  const mock = await startSpaceshipMock();
  t.after(() => mock.close());
  for (const env of [{}, { DOMAIN_HOUND_DIRECT_PURCHASE: '0' }, { DOMAIN_HOUND_DIRECT_PURCHASE: 'true' }]) {
    const loopback = spaceshipClient({ key: mock.key, secret: mock.secret, baseUrl: mock.baseUrl, env });
    await assert.rejects(loopback.createDomain('lanternbay.com', {}), error => error.notSent === true && /Direct purchase is off/.test(error.message));
    const calls = [];
    const live = spaceshipClient({ key: 'k', secret: 's', env, fetcher: async url => { calls.push(url); throw Error('no network'); } });
    assert.equal(live.baseUrl, spaceshipBase);
    await assert.rejects(live.createDomain('lanternbay.com', {}), /Direct purchase is off/);
    assert.equal(calls.length, 0);
  }
  assert.equal(mock.sent('POST').length, 0);
  // The handler allows it but the client does not: refused before sending, and the claim is released.
  const h = await harness(t, { env: DIRECT, clientEnv: {} });
  const quote = await quoted(h);
  const result = await h.call('buy_domain', buyArgs(quote, { confirm: true }));
  assert.match(text(result), /^Not ordered: Direct purchase is off: DOMAIN_HOUND_DIRECT_PURCHASE is not 1\. Nothing was sent\./);
  assert.equal(h.mock.sent('POST').length, 0);
  assert.equal(await stateStore(h.directory).readClaim(claimKey('lanternbay.com')), null);
  assert.throws(() => spaceshipClient({ key: 'k', secret: 's', baseUrl: 'https://example.com/api' }), /must be https:\/\/spaceship\.dev\/api/);
});

test('direct mode: without confirm true, buy is a dry run', async t => {
  const h = await harness(t, { env: DIRECT });
  const quote = await quoted(h);
  assert.match(text(await h.call('quote_domain', { domain: 'lanternbay.com' })), /After their yes, call buy_domain with quote_id, max_usd and confirm: true\./);
  const result = await h.call('buy_domain', buyArgs(quote));
  assert.match(text(result), /^Dry run\. Nothing ordered\.\nlanternbay\.com: \$9\.98 now for 1 year, then \$12\.98 per year\./);
  assert.match(text(result), /Only after their yes, call buy_domain again with confirm true\./);
  assert.match(text(result), /Quoted estimate, not the actual charge: \$9\.98 upfront for 1 year, renewal \$12\.98 per year\. Spaceship sets the actual charge/);
  assert.equal(data(result).dryRun, true);
  assert.equal(h.mock.sent('POST').length, 0);
});

test('direct mode: a confirmed order goes through the production client to one domainCreate, verifies, and offers DNS', async t => {
  const h = await harness(t, { env: DIRECT });
  const quote = await quoted(h);
  const result = await h.call('buy_domain', buyArgs(quote, { confirm: true }));
  assert.equal(data(result).ordered, true, text(result));
  assert.equal(data(result).verified, true);
  const [order] = h.mock.sent('POST');
  assert.equal(order.path, '/v1/domains/lanternbay.com');
  assert.equal(order.key, h.mock.key);
  assert.deepEqual(order.body, { autoRenew: true, years: 1, privacyProtection: { level: 'high', userConsent: true },
    contacts: { registrant: ownerContactId, admin: ownerContactId, tech: ownerContactId, billing: ownerContactId } });
  // The last price check runs after the claim, right before the order.
  const paths = h.mock.state.requests.map(row => row.method + ' ' + row.path);
  const post = paths.indexOf('POST /v1/domains/lanternbay.com');
  assert.equal(paths.slice(0, post).filter(path => path === 'GET /v1/domains/lanternbay.com/pricing').length, 3);
  assert.equal(paths[post - 1].startsWith('GET /v1/domains/lanternbay.com/'), true);
  assert.match(text(result), /^Ordered lanternbay\.com: Spaceship reports the registration succeeded \(operation op-1\)\.\nQuoted estimate, not the actual charge: \$9\.98 upfront for 1 year, renewal \$12\.98 per year\./);
  assert.doesNotMatch(text(result), /Ordered [^\n]* for \$/);
  assert.match(text(result), /Verified: registered at the registry and in your Spaceship account, high privacy, auto renew on, owner contact set\./);
  assert.match(text(result), /Next: set up lanternbay\.com for your website and mail\. Call setup_domain/);
  const receipt = JSON.parse(await readFile(data(result).receiptPath, 'utf8'));
  assert.deepEqual(receipt.checks, { registry: true, account: true, privacyHigh: true, autoRenew: true, ownerIsRegistrant: true });
  assert.equal(receipt.amount, undefined);
  assert.equal(receipt.quotedAmount, 998);
  assert.deepEqual(receipt.quotedRenewal, { years: 1, amount: 1298, currency: 'USD' });
  assert.match(receipt.note, /^Quoted estimates, not the actual charge\./);
  assert.ok(h.mock.sent('GET', /^\/v1\/async-operations\/op-1$/).length >= 1);
});

test('a successful direct order waits for registry verification before offering DNS setup', async t => {
  const h = await harness(t, { env: DIRECT });
  const quote = await quoted(h);
  h.mock.state.beforePricing = (domain, count) => {
    if (count === 3) h.registryStatus.set(domain, 'unknown');
  };
  const purchase = await h.call('buy_domain', buyArgs(quote, { confirm: true }));
  assert.equal(data(purchase).ordered, true, text(purchase));
  assert.equal(data(purchase).verified, false);
  assert.match(text(purchase), /Check again with setup_domain and verify: true/);
  assert.doesNotMatch(text(purchase), /Next: set up/);
  h.registryStatus.delete(quote.domain);
  const verified = await h.call('setup_domain', { domain: quote.domain, verify: true });
  assert.equal(data(verified).verified, true);
  assert.match(text(verified), /Next: set up/);
  assert.equal(h.mock.sent('POST').length, 1);
});

test('direct mode refuses premium, longer terms and a missing or malformed owner contact, sending nothing', async t => {
  const h = await harness(t, { env: DIRECT });
  const premium = await quoted(h, 'fancy.com', { priceClass: 'premium', premiumPricing: [{ operation: 'register', price: 25, currency: 'USD' }],
    register: { 1: '25.00' }, renew: { 1: '25.00' } });
  assert.equal(premium.premium, true);
  const refused = await h.call('buy_domain', buyArgs(premium, { max_usd: 30, confirm: true }));
  assert.match(text(refused), /^Not ordered: direct purchase never buys a premium domain\. Nothing was sent\./);
  assert.match(text(refused), /1\. Preview: call domain_register with domain fancy\.com, 1 year/);
  h.mock.setOffer('lanternbay.com', { register: { 1: '5.98', 2: '11.96' }, renew: { 1: '5.98' } });
  const twoYears = data(await h.call('quote_domain', { domain: 'lanternbay.com', years: 2 })).quote;
  assert.match(text(await h.call('buy_domain', buyArgs(twoYears, { confirm: true }))),
    /direct purchase buys only the registry minimum term, 1 year, not 2 years/);
  // A .com that Spaceship prices only for two years: the shortest priced term is not the registry minimum.
  const onlyTwo = await quoted(h, 'twoyear.com', { register: { 2: '11.96' }, renew: { 2: '11.96' } });
  assert.equal(onlyTwo.years, 2);
  const blocked = await h.call('buy_domain', buyArgs(onlyTwo, { confirm: true }));
  assert.match(text(blocked), /^Not ordered: direct purchase buys only the registry minimum term, 1 year, not 2 years\. Nothing was sent\./);
  assert.equal(data(blocked).ordered, false);
  // .ai: the registry minimum of two years is the shortest term, and it still has to fit the cap.
  const ai = await quoted(h, 'lanternbay.ai', { register: { 1: '10.00', 2: '25.00', 3: '37.50' }, renew: { 2: '25.00' } });
  assert.equal(ai.years, 2);
  const tooLong = data(await h.call('quote_domain', { domain: 'lanternbay.ai', years: 3 })).quote;
  assert.match(text(await h.call('buy_domain', buyArgs(tooLong, { max_usd: 50, confirm: true }))), /over the cap of \$30\.00/);
  for (const contact of [undefined, 'owner-contact-1', 'a'.repeat(26), 'a'.repeat(33)]) {
    const env = { DOMAIN_HOUND_DIRECT_PURCHASE: '1', ...(contact !== undefined && { DOMAIN_HOUND_SPACESHIP_CONTACT_ID: contact }) };
    assert.equal(ownerContact(env).id, null);
    const other = h.handlers(env);
    const quote = await quoted({ ...h, call: other }, 'nocontact.com');
    assert.match(text(await other('buy_domain', buyArgs(quote, { confirm: true }))),
      /^Not ordered: [^\n]*DOMAIN_HOUND_SPACESHIP_CONTACT_ID[^\n]*Only the person can (?:set|fix) it, in the MCP server settings\. Nothing was sent\./);
  }
  assert.equal(ownerContact({ DOMAIN_HOUND_SPACESHIP_CONTACT_ID: ownerContactId }).id, ownerContactId);
  assert.equal(h.mock.sent('POST').length, 0);
  // The .ai minimum term goes through.
  const ok = await h.call('buy_domain', buyArgs(ai, { max_usd: 30, confirm: true }));
  assert.equal(data(ok).ordered, true, text(ok));
  assert.equal(h.mock.sent('POST')[0].body.years, 2);
});

test('direct mode: a price change after the claim, seconds before the order, sends nothing and releases the claim', async t => {
  const h = await harness(t, { env: DIRECT });
  const quote = await quoted(h);
  // Pricing reads: 1 quote, 2 re-quote, 3 last check while holding the claim.
  h.mock.state.beforePricing = (domain, count) => { if (count === 3) h.mock.setOffer(domain, { register: { 1: '10.98' } }); };
  const result = await h.call('buy_domain', buyArgs(quote, { confirm: true }));
  assert.match(text(result), /^Not ordered: price changed from \$9\.98 to \$10\.98\. Nothing was sent\./);
  assert.equal(h.mock.sent('POST').length, 0);
  assert.equal(await stateStore(h.directory).readClaim(claimKey('lanternbay.com')), null);
  h.mock.state.beforePricing = null;
  const again = await quoted(h, 'lanternbay.com', { register: { 1: '10.98' } });
  assert.equal(data(await h.call('buy_domain', buyArgs(again, { confirm: true }))).ordered, true);
  assert.equal(h.mock.sent('POST').length, 1);
  // A registry that turns taken at the last check also refuses before sending.
  const other = await quoted(h, 'harborlane.com');
  // The registry is read when each check starts, so a change during the re-quote shows at the last check.
  h.mock.state.beforePricing = (domain, count) => { if (count === 2) h.registryStatus.set(domain, 'unknown'); };
  assert.match(text(await h.call('buy_domain', buyArgs(other, { confirm: true }))),
    /^Not ordered: registry result changed from free to unknown\. Nothing was sent\./);
  assert.equal(h.mock.sent('POST').length, 1);
});

test('direct mode: parallel and repeated confirmed calls send at most one order', async t => {
  const h = await harness(t, { env: DIRECT });
  const quote = await quoted(h);
  const args = buyArgs(quote, { confirm: true });
  const results = await Promise.all([h.call('buy_domain', args), h.call('buy_domain', args), h.call('buy_domain', args)]);
  assert.equal(h.mock.sent('POST').length, 1);
  assert.equal(results.filter(result => data(result).ordered).length, 1);
  const again = await h.call('buy_domain', args);
  assert.match(text(again), /already sent|availability is now taken/);
  assert.equal(h.mock.sent('POST').length, 1);
});

test('direct mode: every uncertain or refused order stays locked, is never retried, and sends the person to their account', async t => {
  for (const mode of ['drop', 'error500', 'noid', 'pending', 'failed']) {
    const h = await harness(t, { env: DIRECT });
    h.mock.state.createMode = mode;
    const first = await quoted(h);
    const result = await h.call('buy_domain', buyArgs(first, { confirm: true }));
    assert.equal(data(result).ordered, false, mode);
    assert.match(text(result), /Domain Hound will not send it again\./, mode);
    noFallback(text(result));
    // A new quote, direct or through the handoff path, never sends again or offers another path.
    const second = await quoted(h);
    const retry = await h.call('buy_domain', buyArgs(second, { confirm: true }));
    assert.match(text(retry), /was already sent \(\w[\w-]*(?:, operation op-\d+)?\)\. Domain Hound never sends a second order\./, mode);
    noFallback(text(retry));
    const handoffOnly = await h.handlers({})('buy_domain', buyArgs(second));
    assert.equal(data(handoffOnly).alreadySent, true, mode);
    noFallback(text(handoffOnly));
    assert.equal(h.mock.sent('POST').length, 1, mode);
  }
});

test('direct mode: a lost key after an unclear order still ends in the account check, with no other route', async t => {
  const h = await harness(t, { env: DIRECT });
  h.mock.state.createMode = 'drop';
  const quote = await quoted(h);
  assert.equal(data(await h.call('buy_domain', buyArgs(quote, { confirm: true }))).ambiguous, true);
  const requests = h.mock.state.requests.length;
  for (const env of [DIRECT, {}]) {
    // Same quote, no key: the earlier order is read before anything needs the key or a live quote.
    const lost = await h.handlers(env, env, false)('buy_domain', buyArgs(quote, { confirm: true }));
    assert.equal(lost.isError, false, text(lost));
    assert.equal(data(lost).alreadySent, true);
    assert.match(text(lost), /^An order for lanternbay\.com was already sent \(uncertain\)\. Domain Hound never sends a second order\./);
    noFallback(text(lost));
    assert.doesNotMatch(text(lost), /No Spaceship API key found/);
    // An expired or unknown quote gets the same answer.
    h.advance(11 * 60_000);
    const expired = await h.handlers(env, env, false)('buy_domain', buyArgs(quote));
    assert.equal(data(expired).alreadySent, true);
    noFallback(text(expired));
  }
  assert.equal(h.mock.state.requests.length, requests);
  assert.equal(h.mock.sent('POST').length, 1);
  // With no earlier order, a lost key gives the key instruction and no checkout link.
  const fresh = await harness(t);
  const other = await quoted(fresh, 'harborlane.com');
  const noKey = await fresh.handlers({}, {}, false)('buy_domain', buyArgs(other));
  assert.match(text(noKey), /No Spaceship API key found/);
  assert.doesNotMatch(text(noKey), /spaceship\.com\/domain-search|Buy it yourself/);
});

test('direct mode: disk errors after the order keep the outcome, the account check and the claim', async t => {
  const failAfterPost = store => ({ ...store,
    updateClaim: async (key, fields) => {
      if (fields.status === 'sending') return store.updateClaim(key, fields);
      throw Object.assign(Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    },
    saveReceipt: async () => { throw Object.assign(Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); } });
  // A successful registration whose receipt and claim updates cannot be written.
  const h = await harness(t, { env: DIRECT, wrapStore: failAfterPost });
  const quote = await quoted(h);
  const result = await h.call('buy_domain', buyArgs(quote, { confirm: true }));
  assert.equal(result.isError, false, text(result));
  assert.equal(data(result).ordered, true);
  assert.equal(data(result).operationId, 'op-1');
  assert.equal(data(result).receiptPath, null);
  assert.match(text(result), /^Ordered lanternbay\.com: Spaceship reports the registration succeeded \(operation op-1\)\./);
  assert.match(text(result), /No local receipt: Domain Hound could not save it \(ENOSPC: no space left on device\)\. The order itself went through; your Spaceship account has the record\./);
  const claim = await stateStore(h.directory).readClaim(claimKey('lanternbay.com'));
  assert.equal(claim.status, 'sending');
  assert.equal(claim.domain, 'lanternbay.com');
  assert.equal(claim.quoteId, quote.id);
  // An unclear order whose status update cannot be written: the account check still shows, and the claim still blocks.
  const unclear = await harness(t, { env: DIRECT, wrapStore: failAfterPost });
  unclear.mock.state.createMode = 'error500';
  const first = await quoted(unclear);
  const outcome = await unclear.call('buy_domain', buyArgs(first, { confirm: true }));
  assert.equal(outcome.isError, false, text(outcome));
  assert.equal(data(outcome).ambiguous, true);
  assert.match(text(outcome), /The order result for lanternbay\.com is unclear \(Spaceship answered HTTP 500\.\)\. Domain Hound will not send it again\./);
  noFallback(text(outcome));
  assert.doesNotMatch(text(outcome), /ENOSPC/);
  const again = await unclear.call('buy_domain', buyArgs(await quoted(unclear), { confirm: true }));
  assert.equal(data(again).alreadySent, true);
  noFallback(text(again));
  // A pending order keeps its operation ID in the answer even when the claim update fails.
  const pending = await harness(t, { env: DIRECT, wrapStore: failAfterPost });
  pending.mock.state.createMode = 'pending';
  const waiting = await pending.call('buy_domain', buyArgs(await quoted(pending), { confirm: true }));
  assert.equal(data(waiting).operationId, 'op-1');
  assert.match(text(waiting), /\(operation op-1\)\. Domain Hound will not send it again\./);
  assert.equal(h.mock.sent('POST').length + unclear.mock.sent('POST').length + pending.mock.sent('POST').length, 3);
  // A disk error before the order sends nothing and releases the claim.
  const before = await harness(t, { env: DIRECT, wrapStore: store => ({ ...store,
    updateClaim: async () => { throw Error('EROFS: read-only file system'); } }) });
  const refused = await before.call('buy_domain', buyArgs(await quoted(before), { confirm: true }));
  assert.match(text(refused), /^Not ordered: Domain Hound could not record the order on disk \(EROFS: read-only file system\)\. Nothing was sent\./);
  assert.equal(before.mock.sent('POST').length, 0);
  assert.equal(await stateStore(before.directory).readClaim(claimKey('lanternbay.com')), null);
});

test('setup_domain verify reads only and counts a purchase only when the registry and the account both confirm it', async t => {
  const h = await harness(t);
  h.mock.setDomain('lanternbay.com');
  const mine = await h.call('setup_domain', { domain: 'lanternbay.com', verify: true });
  assert.equal(data(mine).verified, true, text(mine));
  assert.match(text(mine), /^lanternbay\.com is yours: registered at the registry and in your Spaceship account\. Privacy high, auto renew on\./);
  assert.match(text(mine), /Next: set up lanternbay\.com for your website and mail\./);
  // Registered, but to someone else: not in this account.
  h.registryStatus.set('elsewhere.com', 'taken');
  const theirs = await h.call('setup_domain', { domain: 'elsewhere.com', verify: true });
  assert.equal(data(theirs).verified, false);
  assert.match(text(theirs), /not verified yet\. Do not count it as bought\.\nIt is not in this Spaceship account\./);
  assert.match(text(theirs), /possibly to someone else/);
  assert.doesNotMatch(text(theirs), /Next: set up/);
  // In the account but the registry does not confirm yet.
  h.mock.setDomain('pending.com');
  h.registryStatus.set('pending.com', 'free');
  const pending = await h.call('setup_domain', { domain: 'pending.com', verify: true });
  assert.equal(data(pending).verified, false);
  assert.match(text(pending), /The registry still lists it as free\./);
  assert.equal((await h.call('setup_domain', { domain: 'lanternbay.com', verify: true, apply: true })).isError, true);
  assert.equal((await h.call('setup_domain', { domain: 'lanternbay.com', verify: false })).isError, true);
  assert.equal(h.mock.state.requests.filter(row => row.method !== 'GET').length, 0);
  assert.match(setupTool.description, /With only verify: true it writes nothing: it looks the domain up at the registry/);
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
  for (const tool of ['quote', 'buy', 'direct', 'setup']) assert.match(missingKeyText(tool), /Never paste the secret into chat\.$/);
  assert.equal(h.mock.state.requests.length, 0);
});

test('advertises current purchase guidance on the purchase tools', () => {
  const tools = registeredTools([]);
  assert.deepEqual(tools.map(tool => tool.name), ['quote_domain', 'buy_domain', 'setup_domain', 'move_domain']);
  assert.match(buyTool.description, /COSTS MONEY/);
  assert.match(buyTool.description, /accept.*approval/);
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

test('setup adds before it removes, so a failed save leaves the old records in place and reports the partial state', async t => {
  const h = await harness(t);
  const domain = 'lanternbay.com';
  h.mock.setDomain(domain, { records: [{ type: 'A', name: '@', address: '192.0.2.10' }] });
  const preview = await h.call('setup_domain', { domain, website: ghPages });
  h.mock.state.dnsSaveFails = true;
  const outcome = await h.call('setup_domain', { domain, plan_id: data(preview).planId, apply: true, replace: true });
  assert.equal(data(outcome).ok, false);
  assert.match(text(outcome), /DNS update is incomplete/);
  assert.match(text(outcome), /Still present: A @ 192\.0\.2\.10/);
  assert.match(text(outcome), /Not found after save: A @ 185\.199\.108\.153/);
  assert.match(text(outcome), /Domain Hound sent no later changes\./);
  assert.equal(h.mock.sent('DELETE').length, 0);
  assert.equal(h.mock.sent('GET', /^\/v1\/dns\/records\//).length, 3);
});

const writes = h => h.mock.state.requests.filter(row => row.method === 'PUT' || row.method === 'DELETE')
  .map(row => row.method + ' ' + (row.method === 'PUT' ? row.body.items : row.body).map(item => item.type + ' ' + item.name).join(', '));

test('setup saves coexisting records first, removes only approved blockers, saves the rest, then removes the others', async t => {
  const h = await harness(t);
  const domain = 'lanternbay.com';
  const records = [{ type: 'A', name: 'www', address: '192.0.2.20' }, { type: 'A', name: '@', address: '192.0.2.10' },
    { type: 'MX', name: '@', exchange: 'mx.old-host.example', preference: 10 },
    { type: 'TXT', name: '@', value: 'v=spf1 include:old-host.example ~all' }, { type: 'TXT', name: '_dmarc', value: 'v=DMARC1; p=none' }];
  const choices = { website: ghPages, mail: { provider: 'google-workspace', dmarc: 'reject' } };
  h.mock.setDomain(domain, { records });
  const applied = await h.call('setup_domain', { domain, plan_id: data(await h.call('setup_domain', { domain, ...choices })).planId,
    apply: true, replace: true });
  assert.equal(data(applied).ok, true, text(applied));
  assert.deepEqual(writes(h), ['PUT A @, A @, A @, A @, MX @', 'DELETE A www, TXT @, TXT _dmarc', 'PUT CNAME www, TXT @, TXT _dmarc',
    'DELETE A @, MX @']);
  // A save that fails after the blockers went: later steps are not sent, and the readback shows exactly what changed.
  const failing = await harness(t);
  failing.mock.setDomain(domain, { records });
  const plan = data(await failing.call('setup_domain', { domain, ...choices })).planId;
  failing.mock.state.dnsSaveFails = body => body.items.some(item => item.type === 'CNAME');
  const partial = await failing.call('setup_domain', { domain, plan_id: plan, apply: true, replace: true });
  assert.equal(data(partial).ok, false);
  assert.equal(writes(failing).length, 3);
  for (const line of ['Added: A @ 185.199.108.153', 'Added: MX @ smtp.google.com 1', 'Removed: A www 192.0.2.20',
    'Not found after save: CNAME www octo.github.io', 'Still present: A @ 192.0.2.10', 'Still present: MX @ mx.old-host.example 10',
    'Domain Hound sent no later changes.']) assert.ok(text(partial).includes(line), line + '\n' + text(partial));
  // An apex ALIAS replaces the apex address: that address goes right before the ALIAS is saved.
  const alias = await harness(t);
  alias.mock.setDomain(domain, { records: [{ type: 'A', name: '@', address: '192.0.2.10' }] });
  const netlify = { website: { provider: 'netlify', target: 'site.netlify.app' } };
  const done = await alias.call('setup_domain', { domain, plan_id: data(await alias.call('setup_domain', { domain, ...netlify })).planId,
    apply: true, replace: true });
  assert.equal(data(done).ok, true, text(done));
  assert.deepEqual(writes(alias), ['PUT CNAME www', 'DELETE A @', 'PUT ALIAS @']);
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
  assert.deepEqual(replies.get(2).tools.slice(-4).map(tool => tool.name), ['quote_domain', 'buy_domain', 'setup_domain', 'move_domain']);
  assert.match(replies.get(3).content[0].text, /^No valid quote with that ID\./);
  assert.equal(replies.get(4).isError, true);
});

test('direct mode: the claim says checking during the last check, sending just before the POST, then sent with the operation ID', async t => {
  const h = await harness(t, { env: DIRECT });
  const quote = await quoted(h);
  const seen = [];
  h.mock.state.beforePricing = async (domain, count) => { if (count === 3) seen.push((await claimOnDisk(h, domain)).status); };
  h.mock.state.beforeCreate = async domain => { seen.push((await claimOnDisk(h, domain)).status); };
  const result = await h.call('buy_domain', buyArgs(quote, { confirm: true }));
  assert.equal(data(result).ordered, true, text(result));
  assert.deepEqual(seen, ['checking', 'sending']);
  const claim = await claimOnDisk(h);
  assert.equal(claim.status, 'sent');
  assert.equal(claim.operationId, 'op-1');
});

test('a stale checking claim names its file and the safe recovery, blocks every route, and clears once moved out', async t => {
  const h = await harness(t, { env: DIRECT });
  const quote = await quoted(h);
  await stateStore(h.directory).claim(claimKey(quote.domain), { domain: quote.domain, status: 'checking', at: '2026-11-25T11:00:00.000Z' });
  const path = claimFile(h);
  for (const call of [h.call, h.handlers({})]) {
    const blocked = await call('buy_domain', buyArgs(quote, { confirm: true }));
    assert.equal(data(blocked).ordered, false);
    assert.equal(data(blocked).inProgress, true);
    assert.equal(data(blocked).claimPath, path);
    const say = text(blocked);
    assert.match(say, /another purchase of this domain is in progress/);
    assert.ok(say.includes(path), say);
    assert.ok(say.includes('stop every Domain Hound instance that uses ' + h.directory), say);
    assert.match(say, /status is exactly "checking"/);
    assert.match(say, /move the file out of that folder, then get a fresh quote/);
    assert.doesNotMatch(say, /already sent|domain_register|Buy it yourself/);
  }
  assert.equal(h.mock.sent('POST').length, 0);
  await rename(path, join(h.directory, 'stale-claim.json'));
  const fresh = await h.call('buy_domain', buyArgs(await quoted(h), { confirm: true }));
  assert.equal(data(fresh).ordered, true, text(fresh));
  assert.equal(h.mock.sent('POST').length, 1);
});

test('direct mode: a parallel caller that loses the claim while the winner checks hears another purchase is in progress', async t => {
  const h = await harness(t, { env: DIRECT });
  const quote = await quoted(h);
  const args = buyArgs(quote, { confirm: true });
  // The late caller passes both claim reads and then loses the exclusive create.
  let claimAttempts = 0;
  const raceWindow = store => {
    let reads = 0;
    return { ...store, readClaim: async key => ++reads <= 2 ? null : store.readClaim(key),
      claim: async (...args) => {
        claimAttempts++;
        return store.claim(...args);
      } };
  };
  let lost;
  let early;
  h.mock.state.beforePricing = async (_domain, count) => {
    if (count !== 3) return;
    lost = await h.handlers(DIRECT, DIRECT, true, raceWindow)('buy_domain', args);
    early = await h.call('buy_domain', args);
  };
  const winner = await h.call('buy_domain', args);
  assert.equal(data(winner).ordered, true, text(winner));
  assert.equal(claimAttempts, 1);
  for (const loser of [lost, early]) {
    assert.equal(data(loser).ordered, false);
    assert.equal(data(loser).inProgress, true);
    assert.equal(data(loser).claimPath, claimFile(h));
    assert.match(text(loser), /another purchase of this domain is in progress/);
    assert.ok(text(loser).includes(claimFile(h)));
    assert.doesNotMatch(text(loser), /already sent/);
  }
  assert.equal(h.mock.sent('POST').length, 1);
});

test('old, unknown and unreadable claims block every route as already sent, without the checking recovery', async t => {
  const h = await harness(t, { env: DIRECT });
  const quote = await quoted(h);
  const path = claimFile(h);
  await mkdir(join(h.directory, 'claims'), { recursive: true });
  const status = value => JSON.stringify({ domain: quote.domain, status: value });
  const contents = ['submitted', 'failed', 'ambiguous', 'success', 'success-unverified', 'sending', 'sent', 'uncertain', 'later', 'CHECKING']
    .map(status).concat(['', '{"status":"check', 'null', '[]', '"checking"', JSON.stringify({ domain: quote.domain })]);
  for (const content of [...contents, null]) {
    await rm(path, { recursive: true, force: true });
    // null: the claim path cannot be read at all.
    if (content === null) await mkdir(path);
    else await writeFile(path, content);
    for (const call of [h.call, h.handlers({}), h.handlers(DIRECT, DIRECT, false)]) {
      const blocked = await call('buy_domain', buyArgs(quote, { confirm: true }));
      assert.equal(data(blocked).alreadySent, true, String(content) + ': ' + text(blocked));
      assert.equal(data(blocked).inProgress, undefined);
      noFallback(text(blocked));
    }
  }
  assert.equal(h.mock.sent('POST').length, 0);
});

test('a claim is published whole or not at all', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hound-claim-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = stateStore(directory);
  const key = claimKey('lanternbay.com');
  await assert.rejects(store.claim(key, { domain: 'lanternbay.com', status: 'checking', size: 1n }));
  assert.equal(await store.readClaim(key), null);
  assert.deepEqual(await readdir(join(directory, 'claims')).catch(() => []), []);
  assert.equal((await store.claim(key, { domain: 'lanternbay.com', status: 'checking' })).status, 'checking');
  assert.equal(await store.claim(key, { domain: 'lanternbay.com', status: 'checking' }), null);
  assert.deepEqual(await readdir(join(directory, 'claims')), [key + '.json']);
  assert.equal((await store.readClaim(key)).status, 'checking');
});

test('a claim made by another order during the re-check stops the handoff and the dry run', async t => {
  for (const env of [{}, DIRECT]) {
    const h = await harness(t, { env });
    const quote = await quoted(h);
    h.mock.state.beforePricing = async (domain, count) => {
      if (count === 2) await stateStore(h.directory).claim(claimKey(domain), { domain, status: 'sending', at: '2026-11-25T12:00:00.000Z' });
    };
    const result = await h.call('buy_domain', buyArgs(quote));
    assert.equal(data(result).ok, false, text(result));
    assert.equal(data(result).alreadySent, true);
    noFallback(text(result));
    assert.equal(h.mock.sent('POST').length, 0);
  }
});

const problem = (status, detail = 'Insufficient funds') => ({ status,
  body: JSON.stringify({ type: 'about:blank', title: 'Refused', status, detail }) });

test('direct mode: a documented Spaceship refusal is not an order: it says why and releases the claim', async t => {
  for (const status of [400, 401, 402, 403, 404, 422, 429]) {
    const h = await harness(t, { env: DIRECT });
    h.mock.state.createMode = problem(status);
    const quote = await quoted(h);
    const result = await h.call('buy_domain', buyArgs(quote, { confirm: true }));
    assert.equal(data(result).ordered, false, String(status));
    assert.equal(data(result).refused, true, String(status));
    assert.match(text(result), new RegExp('^Not ordered: Spaceship refused the order \\(HTTP ' + status + ': Insufficient funds\\)\\. '
      + 'Spaceship placed no order for lanternbay\\.com\\.'), String(status));
    assert.doesNotMatch(text(result), /unclear|will not send it again|already sent/);
    assert.equal(await stateStore(h.directory).readClaim(claimKey(quote.domain)), null, String(status));
    // Released: once the cause is fixed, a fresh quote can order.
    h.mock.state.createMode = 'success';
    assert.equal(data(await h.call('buy_domain', buyArgs(await quoted(h), { confirm: true }))).ordered, true, String(status));
    assert.equal(h.mock.sent('POST').length, 2);
  }
});

test('direct mode: timeouts, 408, 5xx, unreadable or malformed answers stay uncertain; an accepted order that fails stays sent', async t => {
  const modes = [['drop', 'uncertain'], [problem(408, 'Request timeout'), 'uncertain'], [problem(500), 'uncertain'],
    [problem(503), 'uncertain'], [{ status: 422, body: 'not json' }, 'uncertain'], [{ status: 422, body: '{"title":"Refused"}' }, 'uncertain'],
    [problem(422, ''), 'uncertain'], [{ status: 422, body: '["Insufficient funds"]' }, 'uncertain'],
    [{ ...problem(422), type: 'text/html' }, 'uncertain'], [{ ...problem(422), type: null }, 'uncertain'], ['truncate', 'uncertain'],
    ['noid', 'uncertain'], ['pending', 'uncertain'], ['failed', 'sent']];
  for (const [mode, status] of modes) {
    const label = JSON.stringify(mode);
    const h = await harness(t, { env: DIRECT });
    h.mock.state.createMode = mode;
    const result = await h.call('buy_domain', buyArgs(await quoted(h), { confirm: true }));
    assert.equal(data(result).ordered, false, label);
    assert.equal(data(result).refused, undefined, label);
    assert.match(text(result), /Domain Hound will not send it again\./, label);
    noFallback(text(result));
    const claim = await claimOnDisk(h);
    assert.equal(claim.status, status, label);
    if (mode === 'pending' || mode === 'failed') assert.equal(claim.operationId, 'op-1', label);
    const retry = await h.call('buy_domain', buyArgs(await quoted(h), { confirm: true }));
    assert.equal(data(retry).alreadySent, true, label);
    assert.equal(h.mock.sent('POST').length, 1, label);
  }
});

test('a quote without a readable expiry counts as expired and orders nothing', async t => {
  const h = await harness(t, { env: DIRECT });
  const quote = await quoted(h);
  const { id: _id, nonce: _nonce, ...fields } = JSON.parse(await readFile(join(h.directory, 'quotes', quote.id + '.json'), 'utf8'));
  for (const expiresAt of ['soon', '', null, 20261125, '2026-13-45T12:10:00.000Z']) {
    const bad = await stateStore(h.directory).saveBound('quotes', 'dhq-', { ...fields, expiresAt });
    for (const [call, confirm] of [[h.call, true], [h.call, false], [h.handlers({}), false]]) {
      const result = await call('buy_domain', { domain: quote.domain, quote_id: bad.id, max_usd: 20, ...(confirm && { confirm }) });
      assert.equal(data(result).expired, true, JSON.stringify(expiresAt) + ': ' + text(result));
      assert.match(text(result), /^Quote dhq-[0-9a-f]{20} has no readable expiry, so it counts as expired\. Quote again\. Nothing ordered\./);
    }
  }
  assert.equal(h.mock.sent('POST').length, 0);
});

test('plugin.json describes the Spaceship MCP default, the direct opt-in and the checkout fallback; the README the claim states', async () => {
  const plugin = JSON.parse(await readFile(new URL('../../plugin.json', import.meta.url), 'utf8'));
  const long = plugin.extensions['com.openai'].interface.longDescription;
  assert.match(long, /through Spaceship’s own MCP/);
  assert.match(long, /Direct purchase is an opt-in/);
  assert.match(long, /Spaceship checkout is the fallback/);
  assert.doesNotMatch(long, /Payment happens at Spaceship checkout/);
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
  assert.match(readme, /another purchase of this domain is in progress/);
  assert.match(readme, /exactly `"checking"`/);
  assert.match(readme, /`DOMAIN_HOUND_PURCHASE_DIR`/);
});

test('the purchase folder comes from the configured env, resolved to an absolute path when configured', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hound-configured-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const relative = stateStore('relative-purchases');
  assert.ok(isAbsolute(relative.directory), relative.directory);
  await mkdir(join(directory, 'claims'));
  await writeFile(join(directory, 'claims', claimKey('lanternbay.com') + '.json'), JSON.stringify({ status: 'sent' }));
  const call = purchaseHandlers({ env: { DOMAIN_HOUND_PURCHASE_DIR: directory }, credentials: async () => null });
  const result = await call('buy_domain', { domain: 'lanternbay.com', quote_id: 'dhq-00000000000000000000', max_usd: 10 });
  assert.equal(data(result).alreadySent, true, text(result));
});

test('a relative DOMAIN_HOUND_PURCHASE_DIR is resolved when the server starts, not after a later change of directory', async t => {
  const [first, later] = await Promise.all([mkdtemp(join(tmpdir(), 'hound-start-')), mkdtemp(join(tmpdir(), 'hound-later-'))]);
  t.after(() => Promise.all([rm(first, { recursive: true, force: true }), rm(later, { recursive: true, force: true })]));
  await mkdir(join(first, 'purchases', 'claims'), { recursive: true });
  await writeFile(join(first, 'purchases', 'claims', claimKey('lanternbay.com') + '.json'), JSON.stringify({ status: 'sent' }));
  const tools = new URL('./tools.mjs', import.meta.url).href;
  const script = 'const { callPurchaseTool } = await import(' + JSON.stringify(tools) + ');\nprocess.chdir(' + JSON.stringify(later) + ');\n'
    + 'const result = await callPurchaseTool("buy_domain", { domain: "lanternbay.com", quote_id: "dhq-00000000000000000000", max_usd: 10 });\n'
    + 'process.stdout.write(JSON.stringify(result.structuredContent));';
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script],
    { cwd: first, env: { ...process.env, DOMAIN_HOUND_PURCHASE_DIR: 'purchases' }, timeout: 20_000 });
  const reply = JSON.parse(stdout);
  assert.equal(reply.alreadySent, true, reply.display);
  assert.deepEqual(await readdir(later), []);
});
