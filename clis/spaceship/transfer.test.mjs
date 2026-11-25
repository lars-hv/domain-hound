import '../../test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ownerContactId, productionFetchTo, startSpaceshipMock } from '../../test-support/spaceship-mock.mjs';
import { directPurchaseEnv } from '../../test-support/spaceship-test-registrar.mjs';
import { isLoopback, spaceshipClient } from './client.mjs';
import { stateStore } from './store.mjs';
import { moveTool, purchaseHandlers, registeredTools } from './tools.mjs';
import { readTransferPrice, spaceshipMcpTransfer, transferClaimKey } from './transfer.mjs';

// Zero live calls: any request that is not to the local mock fails the test run.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  if (!isLoopback(String(url))) throw Error('Live network call in a transfer test: ' + url);
  return realFetch(url, options);
};

const start = Date.parse('2026-11-25T12:00:00.000Z');
// A synthetic auth code, chosen so any echo is easy to find.
const CODE = 'Zq7#Auth-Code-Example';
const domain = 'lanternbay.com';
const at = '2026-11-25T11:00:00.000Z';
const catalog = { checkedAt: at, catalogs: {
  spaceship: { checkedAt: at, prices: { com: { shop: 'Spaceship', firstYear: 9.48, renewal: 10.68, transfer: 10.18 } } },
  porkbun: { checkedAt: at, prices: { com: { shop: 'Porkbun', firstYear: 11.81, renewal: 11.81, transfer: 11.81 } } },
} };

async function harness(t, { env = {}, keys = true } = {}) {
  const mock = await startSpaceshipMock();
  const directory = await mkdtemp(join(tmpdir(), 'hound-transfer-'));
  t.after(async () => {
    await mock.close();
    await rm(directory, { recursive: true, force: true });
  });
  const fetcher = productionFetchTo(mock.baseUrl);
  // Public registry facts for the domain, changeable per test.
  const registry = { registered: 'taken', registrar: 'Porkbun LLC', created: '2020-01-01T00:00:00.000Z',
    expires: '2027-06-01T00:00:00.000Z', status: ['active'], nameservers: [] };
  let clock = start;
  const call = purchaseHandlers({ env,
    credentials: async () => keys ? { key: mock.key, secret: mock.secret } : null,
    clientFor: credentials => spaceshipClient({ ...credentials, env, fetcher }),
    store: stateStore(directory), facts: async () => ({ ...registry }), catalog: async () => catalog,
    now: () => new Date(clock), sleep: async () => {} });
  mock.setOffer(domain, { result: 'taken', transfer: { 1: '10.18' }, renew: { 1: '10.68' } });
  return { mock, call, directory, registry, advance: ms => { clock += ms; } };
}

const text = result => result.content[0].text;
const data = result => result.structuredContent;

async function planned(h, args = {}) {
  const result = await h.call('move_domain', { domain, ...args });
  assert.equal(result.isError, false, text(result));
  return result;
}

// Every file Domain Hound wrote, as text.
async function filesUnder(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (entry.isFile()) out.push(await readFile(join(entry.parentPath ?? entry.path, entry.name), 'utf8'));
  }
  return out.join('\n');
}

async function assertNoCode(h, ...results) {
  for (const result of results) assert.ok(!JSON.stringify(result).toLowerCase().includes(CODE.toLowerCase()), 'auth code echoed: ' + text(result));
  assert.ok(!(await filesUnder(h.directory)).toLowerCase().includes(CODE.toLowerCase()), 'auth code stored on disk');
}

test('move_domain is a normal MCP tool next to the purchase tools', () => {
  const names = registeredTools([]).map(tool => tool.name);
  assert.deepEqual(names, ['quote_domain', 'buy_domain', 'setup_domain', 'move_domain']);
  assert.equal(moveTool.annotations.destructiveHint, true);
  assert.match(moveTool.description, /COSTS MONEY with quote_id and max_usd/);
  // The gap is recorded, not papered over: no Spaceship MCP transfer tool is named.
  assert.equal(spaceshipMcpTransfer.tool, null);
});

test('without a key the plan is public: registry facts and list prices, nothing sent or saved', async t => {
  const h = await harness(t, { keys: false });
  const result = await planned(h);
  assert.match(text(result), /lanternbay\.com: registered at Porkbun LLC, expires 2027-06-01\./);
  assert.match(text(result), /Moving to Spaceship saves \$3\.89 over 3 years/);
  assert.match(text(result), /set a Spaceship key with domains:read/);
  assert.equal(data(result).quote, null);
  assert.equal(h.mock.state.requests.length, 0);
  assert.equal(await filesUnder(h.directory), '');
});

test('with a key the plan adds a live transfer quote bound to account, domain, registrar, expiry, term and prices', async t => {
  const h = await harness(t);
  h.mock.setOffer(domain, { result: 'taken', transfer: { 1: '8.00' }, renew: { 1: '10.68' }, regular: { transfer: { 1: '10.18' } } });
  const result = await planned(h);
  const quote = data(result).quote;
  assert.match(quote.id, /^dht-[0-9a-f]{20}$/);
  assert.deepEqual({ registrar: quote.registrar, expires: quote.expires, years: quote.years, amount: quote.amount, regular: quote.regular,
    currency: quote.currency, renewal: quote.renewal, promo: quote.promo }, { registrar: 'Porkbun LLC', expires: '2027-06-01T00:00:00.000Z',
    years: 1, amount: 800, regular: 1018, currency: 'USD', renewal: { years: 1, amount: 1068, regular: 1068, currency: 'USD' }, promo: true });
  assert.equal(quote.expiresAt, '2026-11-25T12:10:00.000Z');
  assert.match(text(result), /Spaceship: transfer \$8\.00 adds 1 year, renews \$10\.68\/yr; 3 years \$29\.36 \(live Spaceship quote\)/);
  assert.match(text(result), /Promotion: the regular price is \$10\.18 for the transfer/);
  assert.match(text(result), /Quote ID dht-/);
  assert.deepEqual(h.mock.state.requests.map(row => row.method + ' ' + row.path).sort(),
    ['GET /v1/domains/lanternbay.com', 'GET /v1/domains/lanternbay.com/pricing']);
});

test('no quote when Spaceship lists no transfer price, the account already holds it, or a transfer happened under 60 days ago', async t => {
  const h = await harness(t);
  h.mock.setOffer(domain, { result: 'taken', renew: { 1: '10.68' } });
  assert.match(text(await planned(h)), /No live Spaceship transfer quote: Spaceship lists no transfer price/);
  h.mock.setOffer(domain, { result: 'taken', transfer: { 1: '10.18' }, renew: { 1: '10.68' } });
  h.mock.setDomain(domain);
  assert.match(text(await planned(h)), /already in this Spaceship account/);
  h.mock.state.domains.delete(domain);
  h.registry.transferred = '2026-11-01T00:00:00.000Z';
  const recent = await planned(h);
  assert.equal(data(recent).quote, null);
  assert.match(text(recent), /Blocked now: transferred 2026-11-01, under 60 days ago; wait until 2026-12-31/);
  assert.equal(readTransferPrice('x.com', { domain: 'x.com', priceClass: 'standard', prices: { transfer: [{ period: { value: 1, unit: 'y' },
    priceInDefaultCurrency: { finalPrice: { amount: '9.00', currency: 'USD' } } }], renew: [] } }).status, 'unpriced');
});

test('default: re-checks the quote and hands off to Spaceship checkout without the auth code and without domain_register', async t => {
  const h = await harness(t);
  const { id } = data(await planned(h)).quote;
  h.registry.status = ['client transfer prohibited'];
  const result = await h.call('move_domain', { domain, quote_id: id, max_usd: 15 });
  assert.equal(data(result).handoff, 'spaceship-checkout');
  assert.match(text(result), /Re-checked 12:00 UTC, unchanged, within the max of \$15\.00 and the cap of \$30\.00/);
  assert.match(text(result), /First unlock it at Porkbun LLC/);
  assert.match(text(result), /Do not use domain_register/);
  assert.match(text(result), /\[Transfer lanternbay\.com at Spaceship\]\(https:\/\/www\.spaceship\.com\/domains\/transfer\/\)\. Enter the auth code there, never in this chat/);
  assert.equal(h.mock.sent('POST').length, 0);
  // Without direct mode no auth code is taken at all.
  const refused = await h.call('move_domain', { domain, quote_id: id, max_usd: 15, confirm: true, auth_code: CODE });
  assert.equal(refused.isError, true);
  assert.match(text(refused), /Direct transfer is off, so Domain Hound takes no auth code/);
  assert.equal(h.mock.sent('POST').length, 0);
  await assertNoCode(h, result, refused);
});

test('a changed price, regular price, renewal, registrar or expiry refuses; so do max, cap, expiry, domain and blockers', async t => {
  const h = await harness(t);
  const quoteFor = async () => data(await planned(h)).quote.id;
  const refuse = async (id, pattern, max = 15) => {
    const result = await h.call('move_domain', { domain, quote_id: id, max_usd: max });
    assert.match(text(result), pattern);
    assert.equal(data(result).ok, false);
  };
  let id = await quoteFor();
  h.mock.setOffer(domain, { result: 'taken', transfer: { 1: '11.00' }, renew: { 1: '10.68' } });
  await refuse(id, /price changed from \$10\.18 to \$11\.00/);
  h.mock.setOffer(domain, { result: 'taken', transfer: { 1: '10.18' }, renew: { 1: '10.68' } });
  id = await quoteFor();
  h.mock.setOffer(domain, { result: 'taken', transfer: { 1: '10.18' }, renew: { 1: '10.68' }, regular: { transfer: { 1: '12.00' } } });
  await refuse(id, /regular price changed from \$10\.18 to \$12\.00/);
  h.mock.setOffer(domain, { result: 'taken', transfer: { 1: '10.18' }, renew: { 1: '10.68' } });
  id = await quoteFor();
  h.mock.setOffer(domain, { result: 'taken', transfer: { 1: '10.18' }, renew: { 1: '12.68' } });
  await refuse(id, /renewal changed from \$10\.68 to \$12\.68/);
  h.mock.setOffer(domain, { result: 'taken', transfer: { 1: '10.18' }, renew: { 1: '10.68' } });
  id = await quoteFor();
  h.registry.registrar = 'NameCheap, Inc.';
  await refuse(id, /registrar changed from Porkbun LLC to NameCheap, Inc\./);
  h.registry.registrar = 'Porkbun LLC';
  id = await quoteFor();
  h.registry.expires = '2028-06-01T00:00:00.000Z';
  await refuse(id, /expiry changed from 2027-06-01 to 2028-06-01/);
  h.registry.expires = '2027-06-01T00:00:00.000Z';
  id = await quoteFor();
  await refuse(id, /over the max of \$5\.00/, 5);
  h.mock.setOffer(domain, { result: 'taken', transfer: { 1: '40.00' }, renew: { 1: '10.68' } });
  const pricey = await quoteFor();
  await refuse(pricey, /over the cap of \$30\.00 set by DOMAIN_HOUND_MAX_USD/, 50);
  assert.match(text(await h.call('move_domain', { domain: 'other.com', quote_id: id, max_usd: 15 })), /That quote is for lanternbay\.com/);
  assert.match(text(await h.call('move_domain', { domain, quote_id: 'dht-00000000000000000000', max_usd: 15 })), /No valid transfer quote/);
  h.advance(10 * 60_000);
  await refuse(id, /has expired/);
  assert.equal(h.mock.sent('POST').length, 0);
});

test('direct: dry run first, then one transfer with the documented body; the code is never echoed or stored', async t => {
  const h = await harness(t, { env: directPurchaseEnv });
  h.mock.state.transferMode = 'pending';
  const { id } = data(await planned(h)).quote;
  const dry = await h.call('move_domain', { domain, quote_id: id, max_usd: 15 });
  assert.equal(data(dry).dryRun, true);
  assert.match(text(dry), /Dry run\. Nothing sent\./);
  assert.match(text(await h.call('move_domain', { domain, quote_id: id, max_usd: 15, confirm: true })), /Give the auth code/);
  assert.equal(h.mock.sent('POST').length, 0);
  const sent = await h.call('move_domain', { domain, quote_id: id, max_usd: 15, confirm: true, auth_code: CODE });
  assert.equal(data(sent).requested, true, text(sent));
  assert.match(text(sent), /Transfer requested: Spaceship accepted the transfer of lanternbay\.com \(operation op-1\)/);
  const [post] = h.mock.sent('POST');
  assert.equal(post.path, '/v1/domains/lanternbay.com/transfer');
  assert.deepEqual(post.body, { autoRenew: true, privacyProtection: { level: 'high', userConsent: true },
    contacts: { registrant: ownerContactId, admin: ownerContactId, tech: ownerContactId, billing: ownerContactId }, authCode: CODE });
  const claim = JSON.parse(await readFile(join(h.directory, 'claims', transferClaimKey(domain) + '.json'), 'utf8'));
  assert.equal(claim.status, 'sent');
  assert.equal(claim.operationId, 'op-1');
  // A repeat never sends again, with or without a fresh quote.
  const again = await h.call('move_domain', { domain, quote_id: id, max_usd: 15, confirm: true, auth_code: CODE });
  assert.equal(data(again).alreadySent, true);
  assert.equal(h.mock.sent('POST').length, 1);
  // Status needs no code and sends nothing.
  const status = await h.call('move_domain', { domain, status: true });
  assert.match(text(status), /lanternbay\.com: incoming transfer, status pending, started 2026-11-25 12:00 UTC\./);
  assert.match(text(status), /Domain Hound sent it \(operation op-1, pending\); claim status "sent"/);
  assert.equal(h.mock.sent('POST').length, 1);
  await assertNoCode(h, dry, sent, again, status);
});

test('direct: a transfer lock or premium price stops before sending; a missing owner contact hands off', async t => {
  const h = await harness(t, { env: directPurchaseEnv });
  const { id } = data(await planned(h)).quote;
  h.registry.status = ['client transfer prohibited'];
  const locked = await h.call('move_domain', { domain, quote_id: id, max_usd: 15, confirm: true, auth_code: CODE });
  assert.match(text(locked), /still shows a transfer lock\. Unlock it at Porkbun LLC/);
  const noOwner = await harness(t, { env: { DOMAIN_HOUND_DIRECT_PURCHASE: '1' } });
  const other = data(await planned(noOwner)).quote.id;
  assert.match(text(await noOwner.call('move_domain', { domain, quote_id: other, max_usd: 15 })), /needs DOMAIN_HOUND_SPACESHIP_CONTACT_ID[\s\S]*Do not use domain_register/);
  h.registry.status = ['active'];
  h.mock.setOffer(domain, { result: 'taken', priceClass: 'premium', transfer: { 1: '10.18' }, renew: { 1: '10.68' } });
  const premium = data(await planned(h)).quote.id;
  assert.match(text(await h.call('move_domain', { domain, quote_id: premium, max_usd: 15, confirm: true, auth_code: CODE })),
    /never move a premium-priced domain/);
  assert.equal(h.mock.sent('POST').length + noOwner.mock.sent('POST').length, 0);
  await assertNoCode(h, locked);
});

test('direct: Spaceship error details stay private; a refusal frees the claim, an unclear answer keeps it', async t => {
  const h = await harness(t, { env: directPurchaseEnv });
  h.mock.state.transferMode = { status: 422, body: JSON.stringify({ detail: 'Invalid auth code ' + CODE.toUpperCase() + ' for domain' }) };
  let { id } = data(await planned(h)).quote;
  const refused = await h.call('move_domain', { domain, quote_id: id, max_usd: 15, confirm: true, auth_code: CODE });
  assert.match(text(refused), /Spaceship refused the transfer \(HTTP 422\)/);
  assert.equal(data(refused).refused, true);
  await assert.rejects(readFile(join(h.directory, 'claims', transferClaimKey(domain) + '.json')));
  // Even escaped copies of the code stay out of replies.
  h.mock.state.transferMode = { status: 422, body: JSON.stringify({ detail: 'x'.repeat(190) + encodeURIComponent(CODE) }) };
  ({ id } = data(await planned(h)).quote);
  const cut = await h.call('move_domain', { domain, quote_id: id, max_usd: 15, confirm: true, auth_code: CODE });
  assert.doesNotMatch(text(cut), /Zq7/);
  h.mock.state.transferMode = 'error500';
  ({ id } = data(await planned(h)).quote);
  const unclear = await h.call('move_domain', { domain, quote_id: id, max_usd: 15, confirm: true, auth_code: CODE });
  assert.equal(data(unclear).ambiguous, true);
  assert.match(text(unclear), /unclear\. .*will not send it again/);
  const claim = JSON.parse(await readFile(join(h.directory, 'claims', transferClaimKey(domain) + '.json'), 'utf8'));
  assert.equal(claim.status, 'uncertain');
  const blocked = await h.call('move_domain', { domain, quote_id: id, max_usd: 15, confirm: true, auth_code: CODE });
  assert.equal(data(blocked).alreadySent, true);
  assert.equal(h.mock.sent('POST').length, 3);
  await assertNoCode(h, refused, cut, unclear, blocked);
});

test('direct: the regular price fits both ceilings and any pre-existing transfer prevents a POST', async t => {
  const h = await harness(t, { env: directPurchaseEnv });
  h.mock.setOffer(domain, { result: 'taken', transfer: { 1: '10.18' }, renew: { 1: '10.68' }, regular: { transfer: { 1: '35.00' } } });
  const promo = data(await planned(h)).quote.id;
  const promoResult = await h.call('move_domain', { domain, quote_id: promo, max_usd: 40, confirm: true, auth_code: CODE });
  assert.equal(data(promoResult).overCap, true);
  assert.match(text(promoResult), /regular transfer price of \$35\.00/);

  h.mock.setOffer(domain, { result: 'taken', transfer: { 1: '10.18' }, renew: { 1: '10.68' } });
  const { id } = data(await planned(h)).quote;
  h.registry.status = [];
  const unknown = await h.call('move_domain', { domain, quote_id: id, max_usd: 15, confirm: true, auth_code: CODE });
  assert.match(text(unknown), /registry did not publish the transfer status/);
  h.registry.status = ['active'];
  h.mock.state.transfers.set(domain, { direction: 'in', status: 'pending' });
  const existing = await h.call('move_domain', { domain, quote_id: id, max_usd: 15, confirm: true, auth_code: CODE });
  assert.match(text(existing), /Spaceship already has an ongoing or unconfirmed transfer/);
  assert.equal(h.mock.sent('POST').length, 0);
  await assertNoCode(h, promoResult, unknown, existing);
});

test('direct: an invalid operation ID is suppressed, leaving an unresolved claim', async t => {
  const h = await harness(t, { env: directPurchaseEnv });
  h.mock.state.transferMode = { status: 202, headers: { 'spaceship-async-operationid': encodeURIComponent(CODE) } };
  const { id } = data(await planned(h)).quote;
  const result = await h.call('move_domain', { domain, quote_id: id, max_usd: 15, confirm: true, auth_code: CODE });
  assert.equal(data(result).ambiguous, true);
  assert.doesNotMatch(JSON.stringify(result) + await filesUnder(h.directory), /Zq7/i);
  assert.equal(h.mock.sent('POST').length, 1);
});

test('direct: a dropped connection is unclear and never retried', async t => {
  const h = await harness(t, { env: directPurchaseEnv });
  h.mock.state.transferMode = 'drop';
  const { id } = data(await planned(h)).quote;
  const result = await h.call('move_domain', { domain, quote_id: id, max_usd: 15, confirm: true, auth_code: CODE });
  assert.equal(data(result).ambiguous, true);
  assert.equal(h.mock.sent('POST').length, 1);
  assert.equal(data(await h.call('move_domain', { domain, quote_id: id, max_usd: 15, confirm: true, auth_code: CODE })).alreadySent, true);
  assert.equal(h.mock.sent('POST').length, 1);
  await assertNoCode(h, result);
});

test('the client sends no transfer while direct purchase is off, whatever the host', async t => {
  const mock = await startSpaceshipMock();
  t.after(() => mock.close());
  const client = spaceshipClient({ key: mock.key, secret: mock.secret, env: {}, fetcher: productionFetchTo(mock.baseUrl) });
  await assert.rejects(client.startTransfer(domain, { authCode: CODE }), error => error.notSent === true && !error.message.includes(CODE));
  assert.equal(mock.state.requests.length, 0);
});

test('input rules: status alone, auth_code only with confirm, no quote fields without quote_id', async t => {
  const h = await harness(t, { env: directPurchaseEnv });
  assert.equal((await h.call('move_domain', { domain, status: true, quote_id: 'x' })).isError, true);
  assert.equal((await h.call('move_domain', { domain, max_usd: 10 })).isError, true);
  assert.equal((await h.call('move_domain', { domain, auth_code: CODE })).isError, true);
  const early = await h.call('move_domain', { domain, quote_id: 'dht-00000000000000000000', max_usd: 10, auth_code: CODE });
  assert.match(text(early), /auth_code goes only with confirm: true/);
  assert.equal((await h.call('move_domain', { domain: 'not a domain' })).isError, true);
  const missing = await harness(t, { keys: false });
  assert.match(text(await missing.call('move_domain', { domain, status: true })), /domains:transfer, asyncoperations:read/);
  assert.equal(h.mock.sent('POST').length, 0);
  await assertNoCode(h, early);
});
