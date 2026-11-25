// Transfer a domain the person owns elsewhere into their own Spaceship account. The live quote is bound to the account, the
// domain, its current registrar and expiry, the transfer term, amount, regular price, renewal and currency. The default ends
// at Spaceship's own transfer checkout, where the person enters the auth code; Domain Hound never sees it there. Direct
// transfers through the REST API are the person's opt-in (DOMAIN_HOUND_DIRECT_PURCHASE=1) and take the auth code only for
// the one request: it is never printed, stored or echoed, also not from Spaceship's error text.
import { spaceshipTransferPage, transferBlockers, transferRegistryRecord, transferRules } from '../portfolio/move.mjs';
import { capCents, directPurchaseEnabled, ownerContact } from './buy.mjs';
import { cents, minimumYears, quoteLifetimeMs, usd } from './quote.mjs';
import { digest } from './store.mjs';

// Spaceship's MCP tool reference lists registration and read tools; it has no incoming-transfer tool. domain_register
// registers new names only and must never be used to move a domain. Set tool when Spaceship documents one with a
// preview and a confirmation step.
export const spaceshipMcpTransfer = Object.freeze({ tool: null, reference: 'https://www.spaceship.com/knowledgebase/spaceship-mcp/',
  checked: '2026-11-25' });

const plainWord = value => typeof value === 'string' && /^[A-Za-z][A-Za-z _-]{0,39}$/.test(value) ? value : null;
const isoDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

// Every term in years with its final and regular price, in whole cents.
function termRows(rows) {
  return (Array.isArray(rows) ? rows : []).flatMap(row => {
    const years = row?.period?.unit === 'y' && Number.isSafeInteger(row.period.value) && row.period.value > 0 ? row.period.value : null;
    const price = row?.priceInDefaultCurrency;
    const amount = cents(price?.finalPrice?.amount);
    const regular = cents(price?.regularPrice?.amount);
    const currency = price?.finalPrice?.currency;
    return years && amount !== null && regular !== null && typeof currency === 'string' && price.regularPrice.currency === currency
      ? [{ years, amount, regular, currency }] : [];
  }).sort((a, b) => a.years - b.years);
}

// Spaceship's pricing answer read as one transfer offer. Spaceship omits the transfer price when the ending cannot be
// transferred in or transfers are paused. The transfer term is Spaceship's own (a transfer request has no years field).
export function readTransferPrice(domain, pricing) {
  if (typeof pricing?.domain !== 'string' || pricing.domain.toLowerCase() !== domain || !['standard', 'premium'].includes(pricing.priceClass)) {
    return { status: 'unpriced', reason: 'Spaceship gave no price for it.' };
  }
  const [term] = termRows(pricing.prices?.transfer);
  if (!term) return { status: 'unpriced', reason: 'Spaceship lists no transfer price for it (transfers may not be offered for this ending now).' };
  const renewal = termRows(pricing.prices?.renew).find(row => row.years >= minimumYears(domain));
  if (!renewal) return { status: 'unpriced', reason: 'Spaceship lists no renewal price for it.' };
  if (term.currency !== 'USD' || renewal.currency !== 'USD') {
    return { status: 'unpriced', reason: 'Spaceship priced it in ' + term.currency + ', not USD.' };
  }
  return { status: 'priced', priceClass: pricing.priceClass, premium: pricing.priceClass === 'premium', years: term.years,
    amount: term.amount, regular: term.regular, currency: 'USD', promo: term.amount < term.regular || renewal.amount < renewal.regular,
    renewal: { years: renewal.years, amount: renewal.amount, regular: renewal.regular, currency: 'USD' } };
}

// One live check: Spaceship's transfer price, whether the account already holds the domain, and the registry's facts.
export async function liveTransferOffer(domain, { client, facts, record, now = new Date() }) {
  const [pricing, info, registry] = await Promise.all([client.pricing(domain),
    client.info(domain).catch(problem => problem?.status === 404 ? false : null),
    record ?? transferRegistryRecord(domain, { facts, now })]);
  const { blockers, locked } = transferBlockers(registry, transferRules(domain), now);
  const base = { domain, checkedAt: now.toISOString(), registrar: registry.registrar ?? null, expires: registry.expires ?? null,
    locked, blockers, inAccount: info === false ? false : info?.name === domain ? true : null,
    statusKnown: Boolean(registry.status?.length), created: registry.created };
  if (/\bspaceship\b/i.test(base.registrar ?? '')) base.blockers.unshift('it is already registered at Spaceship');
  if (base.inAccount) base.blockers.unshift('it is already in this Spaceship account');
  if (base.inAccount === null) base.blockers.push('Spaceship did not say whether this account already holds it');
  if (!base.registrar) base.blockers.push('the registry did not name the current registrar');
  if (!base.expires) base.blockers.push('the registry did not confirm the expiry date');
  return { ...base, ...readTransferPrice(domain, pricing) };
}

// The fields a transfer quote binds. Any change between quote and transfer refuses it.
export const boundTransferFields = offer => ({ domain: offer.domain, registrar: offer.registrar, expires: offer.expires,
  years: offer.years, amount: offer.amount, regular: offer.regular, currency: offer.currency, renewal: offer.renewal,
  priceClass: offer.priceClass, premium: offer.premium });

export function transferChanges(quote, fresh) {
  const found = [];
  if (fresh.status !== 'priced') return [fresh.reason ?? 'Spaceship no longer prices the transfer'];
  if (fresh.registrar !== quote.registrar) found.push('the registrar changed from ' + quote.registrar + ' to ' + (fresh.registrar ?? 'unknown'));
  if (fresh.expires !== quote.expires) found.push('the expiry changed from ' + String(quote.expires).slice(0, 10) + ' to ' + String(fresh.expires).slice(0, 10));
  if (fresh.priceClass !== quote.priceClass) found.push('price class changed from ' + quote.priceClass + ' to ' + fresh.priceClass);
  if (fresh.years !== quote.years) found.push('the transfer term changed from ' + quote.years + ' to ' + fresh.years + ' years');
  if (fresh.amount !== quote.amount || fresh.currency !== quote.currency) found.push('price changed from ' + usd(quote.amount) + ' to ' + usd(fresh.amount));
  if (fresh.regular !== quote.regular) found.push('regular price changed from ' + usd(quote.regular) + ' to ' + usd(fresh.regular));
  const was = quote.renewal;
  const now = fresh.renewal;
  if (now.amount !== was.amount || now.regular !== was.regular || now.years !== was.years) {
    found.push('renewal changed from ' + usd(was.amount) + ' to ' + usd(now.amount) + ' per ' + per(now.years));
  }
  return found;
}

const term = years => years + (years === 1 ? ' year' : ' years');
const per = years => years === 1 ? 'year' : years + ' years';
const clock = iso => iso.slice(11, 16) + ' UTC';

export const transferOfferLine = offer => offer.domain + ': transfer to Spaceship ' + usd(offer.amount) + ', adds ' + term(offer.years)
  + ', then ' + usd(offer.renewal.amount) + ' per ' + per(offer.renewal.years) + '.'
  + (offer.promo ? ' Promotion: the regular price is ' + usd(offer.regular) + ' for the transfer and ' + usd(offer.renewal.regular)
    + ' for the renewal.' : '') + (offer.premium ? ' Premium price.' : '');

// Issue a transfer quote: one live check, bound and valid for ten minutes. No quote while anything blocks the move.
export async function issueTransferQuote(domain, { client, store, facts, record, now = new Date() }) {
  const offer = await liveTransferOffer(domain, { client, facts, record, now });
  if (offer.status !== 'priced' || offer.blockers.length) return { offer, quote: null };
  const expiresAt = new Date(now.getTime() + quoteLifetimeMs).toISOString();
  const { accountBinding, ...quote } = await store.saveBound('transfer-quotes', 'dht-', { ...boundTransferFields(offer), promo: offer.promo,
    checkedAt: offer.checkedAt, expiresAt, accountBinding: client.accountBinding });
  return { offer, quote };
}

export const transferClaimKey = domain => 'trn-' + digest('transfer ' + domain).slice(0, 20);

const readableExpiry = quote => typeof quote.expiresAt === 'string' && Number.isFinite(Date.parse(quote.expiresAt));
const expired = (quote, at) => !readableExpiry(quote) || at.getTime() >= Date.parse(quote.expiresAt);

const refusal = (text, fields = {}) => ({ ok: false, transferred: false, say: text, ...fields });
const checkAccount = 'Do not retry here or at checkout. Check transfers in your Spaceship account first.';
const alreadySent = (domain, prior) => refusal('A transfer of ' + domain + ' was already sent'
  + (prior?.status ? ' (' + prior.status + (prior.operationId ? ', operation ' + prior.operationId : '') + ')' : '')
  + '. Domain Hound never sends a second one. Follow it with move_domain and status: true. ' + checkAccount,
{ alreadySent: true, ...(prior?.operationId && { operationId: prior.operationId }) });
const inProgress = (domain, store, path) => refusal('Not sent: another transfer of ' + domain + ' is in progress. Its claim ' + path
  + ' says "checking": it is running its last price check and has sent nothing. Wait a minute and ask again. If no transfer is '
  + 'running, stop every Domain Hound instance that uses ' + store.directory + ', check that the status is exactly "checking", move '
  + 'the file out of that folder, then get a fresh quote.', { inProgress: true, claimPath: path });

async function blockedBy(domain, store) {
  const key = transferClaimKey(domain);
  const prior = await store.readClaim(key);
  if (!prior) return null;
  return prior.status === 'checking' ? inProgress(domain, store, store.claimPath(key)) : alreadySent(domain, prior);
}

// The default handoff: Spaceship's transfer checkout, where the person enters the auth code. Never through domain_register.
export function checkoutHandoff(quote, { max, cap }) {
  const limits = 'exactly ' + quote.domain + ', the transfer adds ' + term(quote.years) + ', at most ' + usd(quote.amount)
    + ' upfront (this quote; your max ' + usd(max) + ', cap ' + usd(cap) + '), renewal at most ' + usd(quote.renewal.amount) + ' per '
    + per(quote.renewal.years) + ', WHOIS privacy on, auto-renew on';
  return [
    'Spaceship’s MCP has no incoming-transfer tool (tool reference checked ' + spaceshipMcpTransfer.checked + '). Do not use '
      + 'domain_register: it registers new names and cannot move this one.',
    'Transfer it yourself at Spaceship: [Transfer ' + quote.domain + ' at Spaceship](' + spaceshipTransferPage + '). Enter the auth '
      + 'code there, never in this chat.',
    'Before starting, check Transfer Manager for any existing transfer. Before paying, check: ' + limits + '. Stop if anything differs' + (quote.promo ? ', or if checkout shows the regular price '
      + usd(quote.regular) + ' (the promotion ended)' : '') + '.',
    'If your Spaceship MCP lists an incoming-transfer tool with a preview and a confirmation step, you may use it instead with the same '
      + 'limits: preview, check, show the person, accept only after their yes.',
    'Afterwards, follow it with move_domain and status: true (no code needed).',
  ].join('\n');
}

// transferRequest body: auto renew, high privacy, the account owner for every contact role and the auth code. No years field.
export const transferBody = (owner, authCode) => ({ autoRenew: true, privacyProtection: { level: 'high', userConsent: true },
  contacts: { registrant: owner, admin: owner, tech: owner, billing: owner }, authCode });

// An auth code as Spaceship accepts it: 1 to 50 characters on one line. Checked without echoing it.
export const validAuthCode = value => typeof value === 'string' && value.length >= 1 && value.length <= 50 && !/\p{Cc}/u.test(value)
  && value.trim() === value;

// Guardrails in order: no earlier transfer, valid unexpired quote, explicit max, cap, same account, strict re-check and no
// blockers. Without direct mode: the checkout handoff. With it: owner contact, standard price, unlocked, dry run or transfer.
export async function transferDomain(input, { client, accountBinding, store, facts, env = process.env, now = () => new Date(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), polls = 3, pollMs = 3000 }) {
  const { domain, quote_id: quoteId, max_usd: maxUsd, confirm = false, authCode } = input;
  const blocked = await blockedBy(domain, store);
  if (blocked) return blocked;
  const cap = capCents(env);
  const stored = await store.readBound('transfer-quotes', 'dht-', quoteId);
  if (!stored) return refusal('No valid transfer quote with that ID. Call move_domain with the domain, show the person the quote, then use its ID.');
  const { accountBinding: quotedAccount, ...quote } = stored;
  if (quote.domain !== domain) return refusal('That quote is for ' + quote.domain + ', not ' + domain + '. Nothing sent.');
  if (expired(quote, now())) return refusal('Quote ' + quoteId + ' has expired. Get a fresh plan. Nothing sent.', { expired: true });
  const max = cents(String(maxUsd));
  if (max === null || max <= 0) return refusal('Give max_usd as a positive USD amount in whole cents.');
  if (quote.amount > max) return refusal('The quote is ' + usd(quote.amount) + ', over the max of ' + usd(max) + '. Nothing sent.', { overMax: true });
  if (quote.amount > cap) {
    return refusal('The quote is ' + usd(quote.amount) + ', over the cap of ' + usd(cap) + ' set by DOMAIN_HOUND_MAX_USD. Only the person '
      + 'can raise it in the MCP server settings. Nothing sent.', { overCap: true });
  }
  if (quotedAccount !== await accountBinding()) return refusal('The Spaceship key changed since the quote. Get a fresh plan.');
  const fresh = await liveTransferOffer(domain, { client, facts, now: now() });
  if (expired(quote, now())) return refusal('The quote expired during the price check. Get a fresh plan.');
  const changed = transferChanges(quote, fresh);
  if (changed.length) return refusal('Not sent: ' + changed.join('; ') + '. Get a fresh plan and show the person the new quote.', { changed });
  if (fresh.blockers.length) return refusal('Not sent: ' + fresh.blockers.join('; ') + '.', { blockers: fresh.blockers });
  const claimed = await blockedBy(domain, store);
  if (claimed) return claimed;
  const summary = transferOfferLine(quote) + ' Re-checked ' + clock(fresh.checkedAt) + ', unchanged, within the max of ' + usd(max)
    + ' and the cap of ' + usd(cap) + '.';
  const handoff = () => checkoutHandoff(quote, { max, cap });
  if (!directPurchaseEnabled(env)) {
    return { ok: true, transferred: false, handoff: 'spaceship-checkout', quote, ceilings: { quote: quote.amount, max, cap },
      say: [summary, fresh.locked ? 'First unlock it at ' + quote.registrar + ' (the registry still shows a transfer lock).' : null, handoff()]
        .filter(Boolean).join('\n') };
  }
  // Spaceship's REST endpoint accepts no price ceiling. A promotion can lapse between the re-check and the charge.
  if (quote.regular > Math.min(max, cap)) {
    return refusal('The regular transfer price of ' + usd(quote.regular) + ' exceeds the approved max or server cap. Nothing sent.',
      { overMax: quote.regular > max, overCap: quote.regular > cap });
  }
  const { id: owner, problem } = ownerContact(env);
  const rules = transferRules(domain);
  const direct = problem ?? (quote.premium ? 'direct transfers never move a premium-priced domain'
    : quote.years !== rules.yearsAdded ? 'the transfer term does not match the verified rule for this ending' : null);
  if (direct) return refusal('Not sent: ' + direct + '. Nothing was sent.\n' + summary + '\n' + handoff(), { handoff: 'spaceship-checkout' });
  if (fresh.locked) {
    return refusal('Not sent: the registry still shows a transfer lock. Unlock it at ' + quote.registrar + ', then ask again. Nothing was sent.',
      { locked: true });
  }
  const eligibility = directRegistryIssue(fresh, rules);
  if (eligibility) return refusal('Not sent: ' + eligibility + '. Nothing was sent.');
  if (confirm !== true) {
    return { ok: true, transferred: false, dryRun: true, quote, say: ['Dry run. Nothing sent.', summary,
      'Direct transfer is on. Spaceship sets the actual charge. Show the person this exact quote. After they approve, call move_domain '
        + 'with confirm: true and the code from their private tool input. Keep the code out of chat and results.'].join('\n') };
  }
  if (!validAuthCode(authCode)) return refusal('Give the auth code from the current registrar (1 to 50 characters). Nothing was sent.');
  return placeTransfer(quote, { client, store, facts, owner, authCode, now, sleep, polls, pollMs });
}

function directRegistryIssue(offer, rules) {
  if (!offer.statusKnown) return 'the registry did not publish the transfer status';
  if (rules.lockDays && !offer.created) return 'the registry did not confirm the registration date';
  return null;
}

async function placeTransfer(quote, { client, store, facts, owner, authCode, now, sleep, polls, pollMs }) {
  const { domain } = quote;
  const key = transferClaimKey(domain);
  let record = await store.claim(key, { domain, kind: 'transfer', quoteId: quote.id, quotedAmount: quote.amount, years: quote.years,
    status: 'checking', at: now().toISOString() });
  if (!record) {
    return await blockedBy(domain, store) ?? refusal('Not sent: another transfer of this domain has just ended. Get a fresh plan.');
  }
  let last, existing;
  try {
    [last, existing] = await Promise.all([
      liveTransferOffer(domain, { client, facts, now: now() }),
      client.transferInfo(domain).catch(error => {
        if (error?.status === 404) return false;
        throw error;
      }),
    ]);
  } catch {
    await store.release(key);
    return refusal('The final Spaceship price or transfer status check failed. Nothing was sent. Check the key scopes and get a fresh plan.');
  }
  const changed = transferChanges(quote, last);
  if (last.status === 'priced') changed.push(...last.blockers);
  if (last.locked) changed.push('the registry shows a transfer lock again');
  const eligibility = directRegistryIssue(last, transferRules(domain));
  if (eligibility) changed.push(eligibility);
  if (existing !== false && !['completed', 'cancelled'].includes(existing?.status)) {
    changed.push('Spaceship already has an ongoing or unconfirmed transfer for this domain');
  }
  if (expired(quote, now())) changed.push('the quote expired');
  if (changed.length) {
    await store.release(key);
    return refusal('Not sent: ' + changed.join('; ') + '. Nothing was sent. Get a fresh plan.', { changed });
  }
  record = { ...record, status: 'sending' };
  try {
    await store.updateClaim(key, record);
  } catch {
    await store.release(key);
    return refusal('Domain Hound could not record the transfer on disk. Nothing was sent.');
  }
  const mark = async fields => {
    record = { ...record, ...fields };
    try { await store.updateClaim(key, record); } catch { /* the claim on disk still blocks a second transfer */ }
  };
  let operationId;
  try {
    ({ operationId } = await client.startTransfer(domain, transferBody(owner, authCode)));
  } catch (problem) {
    if (problem.notSent === true) {
      await store.release(key);
      return refusal(problem.refused ? 'Spaceship refused the transfer (HTTP ' + problem.status + '). Get a fresh plan after resolving it.'
        : 'Nothing was sent.', { refused: problem.refused === true });
    }
    await mark({ status: 'uncertain' });
    return refusal('The transfer result for ' + domain + ' is unclear. Domain Hound will not send it '
      + 'again. ' + checkAccount, { ambiguous: true });
  }
  await mark({ status: 'sent', operationId });
  let operation = null;
  for (let attempt = 0; attempt < polls; attempt++) {
    operation = await client.operation(operationId).catch(() => null);
    if (operation?.status === 'success' || operation?.status === 'failed') break;
    if (attempt < polls - 1) await sleep(pollMs);
  }
  if (operation?.status === 'failed') {
    await mark({ outcome: 'failed' });
    return refusal('Spaceship reports the transfer of ' + domain + ' failed (operation ' + operationId + '). Domain Hound will not send '
      + 'it again. ' + checkAccount, { failed: true, operationId });
  }
  if (operation?.status === 'success') await mark({ outcome: 'success' });
  return { ok: true, transferred: false, requested: true, operationId, say: [
    'Transfer requested: Spaceship accepted the transfer of ' + domain + ' (operation ' + operationId + ').',
    'Quoted ' + usd(quote.amount) + ' for ' + term(quote.years) + '; Spaceship sets the actual charge and your account shows it.',
    'It completes when ' + quote.registrar + ' releases the domain; approve any email from them to speed it up. Follow it with '
      + 'move_domain and status: true (no code needed).'].join('\n') };
}

// Status of a transfer into this account: Spaceship's transfer record and, when Domain Hound sent it, the async operation.
// Never sends anything and needs no auth code.
export async function transferStatus(domain, { client, store }) {
  const key = transferClaimKey(domain);
  const claim = await store.readClaim(key);
  const [info, operation] = await Promise.all([
    client.transferInfo(domain).catch(problem => problem?.status === 404 ? null : undefined),
    claim?.operationId ? client.operation(claim.operationId).catch(() => null) : null]);
  const status = ['pending', 'completed', 'cancelled'].includes(info?.status) ? info.status : null;
  const direction = info?.direction === 'in' ? 'in' : null;
  const opStatus = ['pending', 'success', 'failed'].includes(operation?.status) ? operation.status : null;
  if (claim && opStatus && ['success', 'failed'].includes(opStatus) && claim.outcome !== opStatus) {
    try { await store.updateClaim(key, { ...claim, outcome: opStatus }); } catch { /* the claim still blocks a second transfer */ }
  }
  const lines = [];
  if (info === undefined) lines.push('Spaceship did not answer for this transfer. The key needs domains:transfer. Try again later.');
  else if (!info) lines.push('Spaceship has no transfer record for ' + domain + ' in this account.');
  else {
    lines.push(domain + ': incoming transfer, status ' + (status ?? 'unknown')
      + (isoDate(info.startedAt) ? ', started ' + isoDate(info.startedAt).slice(0, 16).replace('T', ' ') + ' UTC' : '')
      + (isoDate(info.finishedAt) ? ', finished ' + isoDate(info.finishedAt).slice(0, 16).replace('T', ' ') + ' UTC' : '') + '.');
  }
  if (claim) {
    lines.push('Domain Hound sent it' + (claim.operationId ? ' (operation ' + claim.operationId + (opStatus ? ', ' + opStatus : '') + ')' : '')
      + '; claim status "' + (plainWord(claim.status) ?? 'unresolved') + '". It will not send another.');
  }
  if (status === 'pending' || opStatus === 'pending') lines.push('Still waiting for the current registrar to release it. Ask again later.');
  return { domain, transfer: info ? { status, direction, startedAt: isoDate(info.startedAt),
    finishedAt: isoDate(info.finishedAt) } : null, operation: opStatus, claim: claim ? plainWord(claim.status) : null, say: lines.join('\n') };
}
