import { shopSearchUrl } from '../domain-check/prices.mjs';
import { boundFields, cents, changes, freshRegistry, liveOffer, offerLine, quoteLifetimeMs, usd } from './quote.mjs';
import { digest } from './store.mjs';

export const defaultCapUsd = 30;
export const checkoutUrl = domain => shopSearchUrl('spaceship', domain);

// What Spaceship's public REST API offers for registration today (docs.spaceship.dev). Each missing guarantee blocks a
// live order: Domain Hound would otherwise spend the person's money without a hard limit. There is no switch around it.
export const liveRegistrar = Object.freeze({
  kind: 'spaceship-rest',
  exactAmount: false,
  idempotent: false,
  ownerContact: null,
});

export function blockedReasons(registrar) {
  const reasons = [];
  if (registrar?.exactAmount !== true) {
    reasons.push('Spaceship’s API price is for reference only and checkout sets the actual charge, so Domain Hound cannot hold the charge to the quote');
  }
  if (registrar?.idempotent !== true) reasons.push('the order call has no idempotency key, so a retry could buy twice');
  if (typeof registrar?.ownerContact !== 'string' || !registrar.ownerContact) {
    reasons.push('the API cannot look up your account owner contact');
  }
  return reasons;
}

// The person's hard limit, set in the MCP server configuration. The agent has no input that raises it.
export function capCents(env = process.env) {
  const raw = env.DOMAIN_HOUND_MAX_USD;
  if (raw === undefined || raw.trim() === '') return defaultCapUsd * 100;
  const value = Number(raw.trim());
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw.trim()) || !(value > 0) || value > 100_000) {
    throw Error('DOMAIN_HOUND_MAX_USD must be a dollar amount, such as 30. Fix it in the MCP server settings.');
  }
  return Math.round(value * 100);
}

// domainCreate body: auto renew, high privacy, and the account owner for every contact role.
export function orderBody({ years }, owner) {
  return { autoRenew: true, years, privacyProtection: { level: 'high', userConsent: true },
    contacts: { registrant: owner, admin: owner, tech: owner, billing: owner } };
}

// One durable claim per domain, so neither a repeated call nor a second quote can send another order.
export const claimKey = domain => 'dom-' + digest(domain).slice(0, 20);

// Issue a quote: one live check, bound to domain, term, amounts and currency, valid for ten minutes.
export async function issueQuote(domain, { client, store, registry, years, now = new Date() }) {
  const offer = await liveOffer(domain, { client, registry, years, now });
  if (offer.status !== 'available') return { offer, quote: null };
  const expiresAt = new Date(now.getTime() + quoteLifetimeMs).toISOString();
  const { accountBinding, ...quote } = await store.saveBound('quotes', 'dhq-', { ...boundFields(offer),
    registry: offer.registry, offeredYears: offer.offeredYears, checkedAt: offer.checkedAt, expiresAt,
    accountBinding: client.accountBinding });
  return { offer, quote };
}

export const handoff = domain => 'Buy it yourself at Spaceship: [' + domain + ' at Spaceship](' + checkoutUrl(domain) + '). '
  + 'Then ask Domain Hound to set up the domain.';

const refusal = (text, fields = {}) => ({ ok: false, ordered: false, say: text, ...fields });
const alreadySent = (domain, prior) => refusal('An order for ' + domain + ' was already sent'
  + (prior?.status ? ' (' + prior.status + ')' : '') + '. Domain Hound never sends a second order. Check your Spaceship account.',
{ alreadySent: true });

// Guardrails in order: valid unexpired quote, explicit max, cap, no earlier order, strict re-quote, then dry run or order.
export async function buyDomain(input, { client, accountBinding, store, registrar = liveRegistrar, registry, env = process.env,
  now = () => new Date(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), polls = 5, pollMs = 3000 }) {
  const { domain, quote_id: quoteId, max_usd: maxUsd, confirm = false } = input;
  const cap = capCents(env);
  const stored = await store.readBound('quotes', 'dhq-', quoteId);
  if (!stored) return refusal('No valid quote with that ID. Call quote_domain, show the person the exact quote, then use its ID.');
  const { accountBinding: quotedAccount, ...quote } = stored;
  if (quote.domain !== domain) return refusal('That quote is for ' + quote.domain + ', not ' + domain + '. Nothing ordered.');
  if (now().getTime() >= Date.parse(quote.expiresAt)) {
    return refusal('Quote ' + quoteId + ' expired at ' + quote.expiresAt.slice(11, 16) + ' UTC. Quote again. Nothing ordered.',
      { expired: true });
  }
  const max = cents(String(maxUsd));
  if (max === null || max <= 0) return refusal('Give max_usd as a positive USD amount in whole cents.');
  if (quote.amount > max) {
    return refusal('The quote is ' + usd(quote.amount) + ', over the max of ' + usd(max) + '. Nothing ordered.', { overMax: true });
  }
  if (quote.amount > cap) {
    return refusal('The quote is ' + usd(quote.amount) + ', over the cap of ' + usd(cap) + ' set by DOMAIN_HOUND_MAX_USD. '
      + 'Only the person can raise it in the MCP server settings. Nothing ordered.', { overCap: true });
  }
  if (quotedAccount !== await accountBinding()) return refusal('The Spaceship key changed since the quote. Quote again.');
  const prior = await store.readClaim(claimKey(domain));
  if (prior) return alreadySent(domain, prior);
  const fresh = await liveOffer(domain, { client, registry, years: quote.years, now: now() });
  if (now().getTime() >= Date.parse(quote.expiresAt)) {
    return refusal('The quote expired during the price check. Quote again.');
  }
  const changed = changes(quote, fresh);
  if (changed.length) {
    return refusal('Not ordered: ' + changed.join('; ') + '. Quote again and show the person the new quote.', { changed });
  }
  const blocked = blockedReasons(registrar);
  const summary = offerLine(quote) + ' Re-checked ' + fresh.checkedAt.slice(11, 16) + ' UTC, unchanged. Within the max of '
    + usd(max) + ' and the cap of ' + usd(cap) + '.';
  if (confirm !== true) {
    return { ok: true, ordered: false, dryRun: true, blocked: blocked.length > 0, quote, say: ['Dry run. Nothing ordered.', summary,
      blocked.length ? 'A live order is blocked: ' + blocked.join('; ') + '. ' + handoff(domain)
        : 'Show the person this exact quote. Only after their yes, call buy_domain again with confirm true.'].join('\n') };
  }
  if (blocked.length) {
    return { ok: false, ordered: false, blocked: true, quote, reasons: blocked, say: ['Blocked. Domain Hound did not order ' + domain + '.',
      'Why: ' + blocked.join('; ') + '.', summary, handoff(domain)].join('\n') };
  }
  if (fresh.registry !== 'free') return refusal('The registry did not confirm availability. Quote again.');
  return placeOrder(quote, { store, registrar, registry, now, sleep, polls, pollMs });
}

async function placeOrder(quote, { store, registrar, registry, now, sleep, polls, pollMs }) {
  const { domain } = quote;
  const owner = registrar.ownerContact;
  const key = claimKey(domain);
  const claim = await store.claim(key, { domain, quoteId: quote.id, amount: quote.amount, years: quote.years, status: 'sending',
    at: now().toISOString() });
  if (!claim) return alreadySent(domain, await store.readClaim(key));
  let operationId;
  try {
    ({ operationId } = await registrar.placeOrder({ ...quote, owner }));
  } catch (problem) {
    // A refusal before sending (such as a price change at the last check) spent nothing, so a new quote may try again.
    // Any other failure is unclear and keeps the claim, so Domain Hound never sends a second order.
    if (problem.notSent) {
      await store.release(key);
      return refusal('Not ordered: ' + problem.message);
    }
    await store.updateClaim(key, { status: 'ambiguous', reason: String(problem.message).slice(0, 200) });
    return refusal('The order result is unclear (' + problem.message + '). Domain Hound will not send it again. '
      + 'Check orders in your Spaceship account before anything else.', { ambiguous: true });
  }
  await store.updateClaim(key, { status: 'submitted', operationId });
  let operation = null;
  for (let attempt = 0; attempt < polls; attempt++) {
    operation = await registrar.operation(operationId).catch(() => null);
    if (operation?.status === 'success' || operation?.status === 'failed') break;
    if (attempt < polls - 1) await sleep(pollMs);
  }
  if (operation?.status === 'failed') {
    await store.updateClaim(key, { status: 'failed' });
    return refusal('Spaceship reports the order for ' + domain + ' failed. Check your Spaceship account before trying again.');
  }
  if (operation?.status !== 'success') {
    await store.updateClaim(key, { status: 'ambiguous' });
    return refusal('Spaceship has not finished the order for ' + domain + ' (operation ' + operationId + '). Domain Hound will not '
      + 'send it again. Check your Spaceship account.', { ambiguous: true, operationId });
  }
  const [info, registryStatus] = await Promise.all([
    registrar.info(domain).catch(() => null), freshRegistry(domain, registry),
  ]);
  const checks = {
    registered: info?.name === domain && info.lifecycleStatus === 'registered' && registryStatus === 'taken',
    privacyHigh: info?.privacyProtection?.level === 'high',
    autoRenew: info?.autoRenew === true,
    ownerIsRegistrant: info?.contacts?.registrant === owner,
  };
  const at = now().toISOString();
  const receipt = { domain, at, quoteId: quote.id, operationId, years: quote.years, amount: quote.amount, currency: quote.currency,
    renewal: quote.renewal, checks };
  const path = await store.saveReceipt(receipt);
  await store.updateClaim(key, { status: 'success', receipt: path });
  const missing = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return { ok: true, ordered: true, receipt, receiptPath: path, say: ['Ordered ' + domain + ' for ' + usd(quote.amount) + '.',
    missing.length ? 'Readback needs a look: ' + missing.join(', ') + '.'
      : 'Readback: registered, high privacy, auto renew on, owner contact set.',
    'Receipt: ' + path].join('\n') };
}
