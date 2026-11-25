import { shopSearchUrl } from '../domain-check/prices.mjs';
import { boundFields, cents, changes, freshRegistry, liveOffer, minimumYears, offerLine, quoteLifetimeMs, usd } from './quote.mjs';
import { digest } from './store.mjs';

export const defaultCapUsd = 30;
export const checkoutUrl = domain => shopSearchUrl('spaceship', domain);

// Spaceship's own MCP server. Its purchase confirmation shows the term, the prices and the payment source, and a person
// approves it. Endpoint and client setup: https://www.spaceship.com/knowledgebase/ai-apps-supported-by-spaceship-and-spacemail-mcp/
export const spaceshipMcp = Object.freeze({
  url: 'https://mcp.spaceship.com/mcp',
  docs: 'https://www.spaceship.com/knowledgebase/ai-apps-supported-by-spaceship-and-spacemail-mcp/',
  tool: 'domain_register',
  poll: 'async_operation_get',
  claude: 'claude mcp add --transport http spaceship https://mcp.spaceship.com/mcp',
  codex: 'codex mcp add spaceship --url https://mcp.spaceship.com/mcp',
});

// Direct purchase through the REST API is the person's explicit opt-in, set only in the MCP server's environment.
// Exactly "1" turns it on; anything else, including "true", leaves it off. No tool argument reaches this.
export const directPurchaseEnabled = (env = process.env) => env?.DOMAIN_HOUND_DIRECT_PURCHASE === '1';

// The REST API cannot discover the account owner's contact, so the person sets its ID in the MCP server's environment.
// Spaceship documents contact IDs as 27 to 32 letters and digits (docs.spaceship.dev: updateDomainContacts and getContact,
// which domainCreate's contact IDs share).
export const contactIdPattern = /^[A-Za-z0-9]{27,32}$/;
export function ownerContact(env = process.env) {
  const raw = env?.DOMAIN_HOUND_SPACESHIP_CONTACT_ID;
  if (raw === undefined || raw.trim() === '') {
    return { id: null, problem: 'Direct purchase needs DOMAIN_HOUND_SPACESHIP_CONTACT_ID, the contact ID of the Spaceship account owner. '
      + 'Only the person can set it, in the MCP server settings' };
  }
  if (!contactIdPattern.test(raw.trim())) {
    return { id: null, problem: 'DOMAIN_HOUND_SPACESHIP_CONTACT_ID is not a valid Spaceship contact ID (27 to 32 letters and digits). '
      + 'Only the person can fix it, in the MCP server settings' };
  }
  return { id: raw.trim(), problem: null };
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

// One durable claim per domain, so neither a repeated call nor a second quote can send another order. Its status:
// "checking" while the last price check runs (nothing sent yet), "sending" from just before the POST, "sent" once Spaceship
// accepted the order (also when the order later failed), "uncertain" when the outcome is unknown. Every claim blocks; only
// "checking" may be cleared by hand. Older and unknown statuses, and unreadable files, count as sent.
export const claimKey = domain => 'dom-' + digest(domain).slice(0, 20);

// A quote whose expiry cannot be read counts as expired.
const readableExpiry = quote => typeof quote.expiresAt === 'string' && Number.isFinite(Date.parse(quote.expiresAt));
const expired = (quote, at) => !readableExpiry(quote) || at.getTime() >= Date.parse(quote.expiresAt);

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

const term = years => years + (years === 1 ? ' year' : ' years');
const per = years => years === 1 ? 'year' : years + ' years';

// Last resort only, after a valid quote, when Spaceship's MCP cannot be used and nothing was submitted: the Spaceship search
// page, where the person pays at checkout and checks the same limits themselves.
export const checkoutHandoff = (quote, { max, cap }) => 'Buy it yourself at Spaceship: [' + quote.domain + ' at Spaceship]('
  + checkoutUrl(quote.domain) + '). Before paying, check the same limits: ' + term(quote.years) + ', at most ' + usd(quote.amount)
  + ' upfront (this quote; your max ' + usd(max) + ', cap ' + usd(cap) + '), renewal at most ' + usd(quote.renewal.amount) + ' per '
  + per(quote.renewal.years) + ', WHOIS privacy on, auto-renew on. Stop if either price is higher or the term or settings differ. '
  + 'Then ask Domain Hound to verify the domain '
  + 'before DNS setup.';

// The default purchase path: Spaceship's own MCP previews the order, a person approves that exact confirmation, and only then
// does the agent accept it with the confirmation token bound to that preview.
export function mcpHandoff(quote, { max, cap }) {
  const { domain } = quote;
  const args = 'domain ' + domain + ', ' + term(quote.years) + ', WHOIS privacy on, auto-renew on';
  return [
    'Hand off to Spaceship’s own MCP. Domain Hound ordered nothing.',
    '1. Preview: call ' + spaceshipMcp.tool + ' with ' + args + ', and no confirmationToken. This registers nothing.',
    '2. Check the preview: exactly ' + domain + ', ' + term(quote.years) + ', the USD total upfront and the renewal. Stop if the upfront '
      + 'total is above this quote ' + usd(quote.amount) + ', the person’s max ' + usd(max) + ' or Domain Hound’s cap ' + usd(cap)
      + ', if the renewal is above ' + usd(quote.renewal.amount) + ' per ' + per(quote.renewal.years)
      + ', or if the price or the payment method is missing. Require USD, WHOIS privacy and auto-renew in the preview.',
    '3. Show the person the full confirmation and wait for their yes. Only then call ' + spaceshipMcp.tool + ' again with the exact '
      + 'same arguments, the confirmationToken from that preview and confirmationResponse: "accept". A fresh preview needs a fresh yes.',
    '4. Poll ' + spaceshipMcp.poll + ' until the operation finishes. If the outcome is unclear, stop: no retry and no other route, '
      + 'not here, not through Domain Hound, not at checkout. Tell the person to check orders in their Spaceship account.',
    '5. After the operation succeeds, call setup_domain with domain ' + domain + ' and verify: true. Offer DNS setup only after it verifies.',
    'No Spaceship MCP? Connect it, then sign in when asked (' + spaceshipMcp.docs + '):',
    'Claude Code: `' + spaceshipMcp.claude + '`',
    'Codex: `' + spaceshipMcp.codex + '`',
    'Last resort, only if Spaceship’s MCP cannot be used and nothing was submitted there: ' + checkoutHandoff(quote, { max, cap }),
  ].join('\n');
}

// Direct mode charges what Spaceship sets at registration. The quote is the best estimate, not the charge.
const estimateLine = quote => 'Quoted estimate, not the actual charge: ' + usd(quote.amount) + ' upfront for ' + term(quote.years)
  + ', renewal ' + usd(quote.renewal.amount) + ' per ' + per(quote.renewal.years) + '. Spaceship sets the actual charge; your '
  + 'Spaceship account shows it.';

const refusal = (text, fields = {}) => ({ ok: false, ordered: false, say: text, ...fields });
const checkAccount = 'Do not retry here, through Spaceship’s MCP or at checkout. Check orders in your Spaceship account first.';
const alreadySent = (domain, prior) => refusal('An order for ' + domain + ' was already sent'
  + (prior?.status ? ' (' + prior.status + (prior.operationId ? ', operation ' + prior.operationId : '') + ')' : '')
  + '. Domain Hound never sends a second order. ' + checkAccount,
{ alreadySent: true, ...(prior?.operationId && { operationId: prior.operationId }) });

// A claim in "checking" is a live guard: another call holds it and has sent nothing yet. It never clears by itself, since
// that call may still be running, so the person gets the safe manual recovery.
const inProgress = (domain, store, path) => refusal('Not ordered: another purchase of this domain is in progress (' + domain + '). '
  + 'Its claim ' + path + ' says "checking": that purchase is running its last price check and has sent no order. Domain Hound '
  + 'sends no second order. Wait a minute and ask again. If no purchase is running (say, Domain Hound stopped mid-check): '
  + 'stop every Domain Hound instance that uses ' + store.directory + ', check that the claim’s status is exactly "checking", '
  + 'move the file out of that folder, then get a fresh quote. If the status is anything else, leave the file and check orders '
  + 'in your Spaceship account.', { inProgress: true, claimPath: path });

// The answer for any existing claim: in progress while it is checking, already sent otherwise.
async function blockedBy(domain, store) {
  const key = claimKey(domain);
  const prior = await store.readClaim(key);
  if (!prior) return null;
  return prior.status === 'checking' ? inProgress(domain, store, store.claimPath(key)) : alreadySent(domain, prior);
}

// Guardrails in order: no earlier order, valid unexpired quote, explicit max, cap, strict re-quote. Then, without direct
// mode, the Spaceship MCP handoff. With direct mode: owner contact, non-premium, registry minimum term, registry free, dry run
// or order. The earlier order comes first: it needs no key and no quote, so a lost key or an expired quote still ends in
// the account check and never in another route.
export async function buyDomain(input, { client, accountBinding, store, registry, env = process.env,
  now = () => new Date(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), polls = 5, pollMs = 3000 }) {
  const { domain, quote_id: quoteId, max_usd: maxUsd, confirm = false } = input;
  const blocked = await blockedBy(domain, store);
  if (blocked) return blocked;
  const cap = capCents(env);
  const stored = await store.readBound('quotes', 'dhq-', quoteId);
  if (!stored) return refusal('No valid quote with that ID. Call quote_domain, show the person the exact quote, then use its ID.');
  const { accountBinding: quotedAccount, ...quote } = stored;
  if (quote.domain !== domain) return refusal('That quote is for ' + quote.domain + ', not ' + domain + '. Nothing ordered.');
  if (expired(quote, now())) {
    return refusal('Quote ' + quoteId + (readableExpiry(quote) ? ' expired at ' + quote.expiresAt.slice(11, 16) + ' UTC.' : ' has no readable expiry, so it counts as expired.')
      + ' Quote again. Nothing ordered.', { expired: true });
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
  const fresh = await liveOffer(domain, { client, registry, years: quote.years, now: now() });
  if (expired(quote, now())) {
    return refusal('The quote expired during the price check. Quote again.');
  }
  const changed = changes(quote, fresh);
  if (changed.length) {
    return refusal('Not ordered: ' + changed.join('; ') + '. Quote again and show the person the new quote.', { changed });
  }
  // An order claimed by another call while this one re-checked: no handoff, dry run or order may go around it.
  const claimed = await blockedBy(domain, store);
  if (claimed) return claimed;
  const summary = offerLine(quote) + ' Re-checked ' + fresh.checkedAt.slice(11, 16) + ' UTC, unchanged. The quote is within the max '
    + 'of ' + usd(max) + ' and the cap of ' + usd(cap) + '.';
  if (!directPurchaseEnabled(env)) {
    return { ok: true, ordered: false, handoff: 'spaceship-mcp', quote, ceilings: { quote: quote.amount, max, cap },
      say: [summary, mcpHandoff(quote, { max, cap })].join('\n') };
  }
  const direct = directRefusal(quote, fresh, env);
  if (direct) {
    return refusal('Not ordered: ' + direct + '. Nothing was sent.\n' + summary + '\n' + mcpHandoff(quote, { max, cap }),
      { direct: false, handoff: 'spaceship-mcp' });
  }
  if (confirm !== true) {
    return { ok: true, ordered: false, dryRun: true, quote, say: ['Dry run. Nothing ordered.', summary, estimateLine(quote),
      'Direct purchase is on. Show the person this exact quote. Only after their yes, call buy_domain again with confirm true.'].join('\n') };
  }
  return placeOrder(quote, { client, store, registry, owner: ownerContact(env).id, now, sleep, polls, pollMs });
}

// Direct mode orders only what the brief allows: the owner contact is set, a standard price, the registry minimum term
// (one year; two for .ai), and a registry that answers free. The minimum is known per ending, never inferred from the terms
// Spaceship happens to price: a .com priced only for two years is still refused.
function directRefusal(quote, fresh, env) {
  const { problem } = ownerContact(env);
  if (problem) return problem;
  if (quote.premium || quote.priceClass !== 'standard') return 'direct purchase never buys a premium domain';
  const minimum = minimumYears(quote.domain);
  if (quote.years !== minimum || fresh.years !== minimum) {
    return 'direct purchase buys only the registry minimum term, ' + term(minimum) + ', not ' + term(quote.years);
  }
  if (fresh.registry !== 'free') return 'the registry did not confirm availability';
  return null;
}

async function placeOrder(quote, { client, store, registry, owner, now, sleep, polls, pollMs }) {
  const { domain } = quote;
  const key = claimKey(domain);
  let record = await store.claim(key, { domain, quoteId: quote.id, quotedAmount: quote.amount, years: quote.years,
    status: 'checking', at: now().toISOString() });
  if (!record) {
    return await blockedBy(domain, store) ?? refusal('Not ordered: another purchase of this domain was in progress and has just '
      + 'ended. This call sent nothing. Get a fresh quote.');
  }
  // Last check while holding the claim in "checking", seconds before the order: the same price, term, availability and a
  // free registry. These refusals are proven before anything is sent, so they release the claim.
  let last;
  try {
    last = await liveOffer(domain, { client, registry, years: quote.years, now: now() });
  } catch (problem) {
    await store.release(key);
    return refusal('Not ordered: the last price check failed (' + problem.message + '). Nothing was sent. Quote again.');
  }
  const changed = changes(quote, last);
  if (!changed.length && last.registry !== 'free') changed.push('the registry did not confirm availability');
  if (expired(quote, now())) changed.push('the quote expired');
  if (changed.length) {
    await store.release(key);
    return refusal('Not ordered: ' + changed.join('; ') + '. Nothing was sent. Quote again and show the person the new quote.', { changed });
  }
  // Recorded atomically just before the POST. If it cannot be written, nothing is sent.
  record = { ...record, status: 'sending' };
  try {
    await store.updateClaim(key, record);
  } catch (problem) {
    await store.release(key);
    return refusal('Not ordered: Domain Hound could not record the order on disk (' + problem.message + '). Nothing was sent.');
  }
  // From here the order may exist. Local bookkeeping is best effort: a disk error never hides the outcome, and a failed
  // write leaves the existing claim file in place (writes replace it atomically), so no second order can follow.
  const mark = async fields => {
    record = { ...record, ...fields };
    try { await store.updateClaim(key, record); } catch { /* the claim on disk still blocks a second order */ }
  };
  let operationId;
  try {
    ({ operationId } = await client.createDomain(domain, orderBody(quote, owner)));
  } catch (problem) {
    // Only the client's own gate and Spaceship's documented refusal are proven unsent. Anything else keeps the claim:
    // no retry, no other path, the person checks the account.
    if (problem.notSent === true) {
      await store.release(key);
      if (problem.refused === true) {
        return refusal('Not ordered: ' + problem.message + ' Spaceship placed no order for ' + domain + '. Fix the cause, then '
          + 'get a fresh quote.', { refused: true });
      }
      return refusal('Not ordered: ' + problem.message + ' Nothing was sent.');
    }
    await mark({ status: 'uncertain', reason: String(problem.message).slice(0, 200) });
    return refusal('The order result for ' + domain + ' is unclear (' + problem.message + '). Domain Hound will not send it again. '
      + checkAccount, { ambiguous: true });
  }
  await mark({ status: 'sent', operationId });
  let operation = null;
  for (let attempt = 0; attempt < polls; attempt++) {
    operation = await client.operation(operationId).catch(() => null);
    if (operation?.status === 'success' || operation?.status === 'failed') break;
    if (attempt < polls - 1) await sleep(pollMs);
  }
  if (operation?.status === 'failed') {
    await mark({ status: 'sent', outcome: 'failed' });
    return refusal('Spaceship reports the order for ' + domain + ' failed (operation ' + operationId + '). Domain Hound will not '
      + 'send it again. ' + checkAccount, { failed: true, operationId });
  }
  if (operation?.status !== 'success') {
    await mark({ status: 'uncertain' });
    return refusal('Spaceship has not finished the order for ' + domain + ' (operation ' + operationId + '). Domain Hound will not '
      + 'send it again. ' + checkAccount, { ambiguous: true, operationId });
  }
  const verified = await verifyRegistration(domain, { client, registry });
  const checks = { ...verified.checks, ownerIsRegistrant: verified.info?.contacts?.registrant === owner };
  const at = now().toISOString();
  const receipt = { domain, at, quoteId: quote.id, operationId, years: quote.years, quotedAmount: quote.amount,
    quotedRenewal: quote.renewal, currency: quote.currency,
    note: 'Quoted estimates, not the actual charge. Spaceship sets the actual charge; see the order in your Spaceship account.',
    checks };
  let path = null;
  let receiptProblem = null;
  try {
    path = await store.saveReceipt(receipt);
  } catch (problem) {
    receiptProblem = problem instanceof Error ? problem.message : String(problem);
  }
  await mark({ status: 'sent', outcome: verified.registered ? 'success' : 'success-unverified', ...(path && { receipt: path }) });
  const missing = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return { ok: true, ordered: true, verified: verified.registered, operationId, receipt, receiptPath: path, say: [
    'Ordered ' + domain + ': Spaceship reports the registration succeeded (operation ' + operationId + ').',
    estimateLine(quote),
    missing.length ? 'Readback needs a look: ' + missing.join(', ') + '. Check your Spaceship account.'
      : 'Verified: registered at the registry and in your Spaceship account, high privacy, auto renew on, owner contact set.',
    path ? 'Receipt: ' + path : 'No local receipt: Domain Hound could not save it (' + receiptProblem + '). The order itself went '
      + 'through; your Spaceship account has the record.',
    verified.registered ? setupOffer(domain) : 'Check again with setup_domain and verify: true. Offer DNS setup only after it verifies.'].join('\n') };
}

export const setupOffer = domain => 'Next: set up ' + domain + ' for your website and mail. Call setup_domain with website or mail to '
  + 'preview the exact DNS records.';

// Independent proof a domain belongs to this account: the registry lists it as registered, and the authenticated Spaceship
// account holds it. Either alone could be someone else's registration or a pending order.
export async function verifyRegistration(domain, { client, registry }) {
  const [info, registryStatus] = await Promise.all([
    client.info(domain).catch(problem => problem?.status === 404 ? null : undefined), freshRegistry(domain, registry)]);
  const inAccount = info?.name === domain && info.lifecycleStatus === 'registered';
  const checks = { registry: registryStatus === 'taken', account: inAccount, privacyHigh: info?.privacyProtection?.level === 'high',
    autoRenew: info?.autoRenew === true };
  return { registered: checks.registry && checks.account, checks, info, registryStatus, accountKnown: info !== undefined };
}
