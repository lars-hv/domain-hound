// move_domain plan: where a domain is registered, what renewal costs there, what moving to the cheaper shop costs, what
// blocks a move and the exact steps at the current registrar. Public facts only (the same registry facts and dated list
// prices my_domains uses); nothing is saved to the portfolio list and nothing is bought.
import { md } from '../../display.mjs';
import { datedListPrices, isListPriceUsable } from '../domain-check/price-catalog.mjs';
import { domainEnding } from '../domain-check/name-search.mjs';
import { shops } from '../domain-check/prices.mjs';
import { minimumYearlySaving, portfolioRegistry, readRegistry, registrarShop, transferPages } from './checks.mjs';
import { publishedRenewal, publishedSpaceshipPrice } from './transfer-prices.mjs';

const day = 86_400_000;
export const transferLockDays = 60;
export const minimumDaysToExpiry = 15;
// Spaceship is the target when its comparable cost is the cheapest or within this much per year of the cheapest.
export const preferenceUsdPerYear = 2;
export const compareYears = 3;

const icannPolicy = 'https://www.icann.org/resources/pages/transfer-policy-2024-02-21-en';

// Transfer rules per ending, from official pages. yearsAdded is what a completed transfer adds to the registration.
// lockDays: the registrar may refuse a transfer this soon after registration or an earlier transfer.
const gtld = { yearsAdded: 1, lockDays: transferLockDays, source: icannPolicy,
  rule: 'ICANN Transfer Policy: the current registrar may refuse a transfer within 60 days of registration or of an earlier transfer.' };
const endingRules = {
  ai: { yearsAdded: 2, lockDays: null, source: 'https://www.gandi.net/en/domain/tld/ai',
    sources: ['https://www.gandi.net/en/domain/tld/ai', 'https://support.hover.com/support/solutions/articles/201000105559--ai-domain-policies'],
    rule: '.ai: a transfer renews the domain for 2 years. The status must not be transfer prohibited, and the domain should not expire soon. '
      + 'The pages we read state no 60-day lock for .ai; the current registrar may still have its own.' },
  io: { yearsAdded: 1, lockDays: transferLockDays, source: 'https://www.gandi.net/en/domain/tld/io',
    rule: '.io: the domain must be at least 60 days old and not expire soon; the transfer is confirmed by email and adds one year. '
      + 'An expired .io is deactivated and can be renewed up to 45 days after expiry.' },
};
// Generic top-level domains in the price catalog: ICANN's Transfer Policy applies and each transfer adds one year.
const gtldEndings = new Set(['com', 'net', 'org', 'app', 'dev', 'xyz', 'tech', 'inc', 'studio', 'info', 'biz']);

export function transferRules(domain) {
  const ending = domainEnding(domain);
  if (endingRules[ending]) return { ending, ...endingRules[ending] };
  if (gtldEndings.has(ending)) return { ending, ...gtld };
  return { ending, yearsAdded: null, lockDays: null, source: null,
    rule: '.' + ending + ': Domain Hound has no checked transfer rules for this ending. Check the registry and the new shop before moving.' };
}

// Official transfer-out pages, checked 2026-11-25. Steps are what each page says; a page we could not read is named only.
export const registrarGuides = [
  { id: 'spaceship', name: 'Spaceship', match: /\bspaceship\b/i, url: 'https://www.spaceship.com/domains/transfer/',
    steps: 'Domain Manager → the domain → Transfer → Transfer domain. Follow the flow to unlock the domain and get its code.' },
  { id: 'godaddy', name: 'GoDaddy', match: /\bgodaddy\b/i, url: 'https://www.godaddy.com/help/transfer-my-domain-away-from-godaddy-3560',
    steps: 'Domain Portfolio → the domain → Transfer to Another Registrar → Continue with transfer. GoDaddy unlocks it and turns off Domain Privacy as part of this flow. Verify your identity if prompted, then choose Click here to see Authorization Code.' },
  { id: 'namecheap', name: 'Namecheap', match: /\bnamecheap\b/i,
    url: 'https://www.namecheap.com/support/knowledgebase/article.aspx/258/84/what-should-i-do-to-transfer-a-domain-from-namecheap/',
    steps: 'Domain List → Manage → Sharing & Transfer → Transfer Out: turn off Registrar Lock and ask for the code. Namecheap emails it to the registrant address.' },
  { id: 'squarespace', name: 'Squarespace', match: /\bsquarespace\b/i,
    url: 'https://support.squarespace.com/hc/en-us/articles/205812338-Transfer-a-domain-away-from-Squarespace',
    steps: 'Domains dashboard → the domain → switch Domain Lock off → Request transfer code. Reauthenticate and check the registrant email for the code.' },
  { id: 'cloudflare', name: 'Cloudflare', match: /\bcloudflare\b/i,
    url: 'https://developers.cloudflare.com/registrar/account-options/transfer-out-from-cloudflare/',
    steps: 'Manage Domains → Manage → Configuration → Unlock → Confirm and Unlock. Copy the auth code shown in the dashboard.' },
  { id: 'porkbun', name: 'Porkbun', match: /\bporkbun\b/i, url: 'https://kb.porkbun.com/article/27-how-to-transfer-a-domain-from-porkbun-to-another-registrar',
    steps: 'Domain Management: click the lock icon until it shows unlocked. Details → Get Authorization Code (shown in a popup).' },
  { id: 'dynadot', name: 'Dynadot', match: /\bdynadot\b/i, url: 'https://www.dynadot.com/help/question/transfer-away',
    steps: 'Manage Domains → the domain → Authorization Code. If locked, choose Unlock Account and then Unlock. Copy the code shown and lock your account again. Any Auction Lock or Buy Lock must have ended.' },
  { id: 'hover', name: 'Hover', match: /\bhover\b/i,
    url: 'https://support.hover.com/support/solutions/articles/201000064729-transferring-your-domain-away-from-hover',
    steps: 'Control Panel → the domain’s Overview. Turn off Transfer Lock, retrieve the Authorization Code and check that the owner email is reachable.' },
  { id: 'gandi', name: 'Gandi', match: /\bgandi\b/i, url: 'https://docs.gandi.net/en/domain_names/transfer_out/auth_info.html',
    steps: 'Domain → Transfer Out tab: turn off Transfer Lock, then Copy (or Generate a new code).' },
  { id: 'ionos', name: 'IONOS', match: /\bionos\b|\b1&1\b/i,
    url: 'https://www.ionos.com/help/domains/transferring-your-domain-away-from-ionos-to-another-provider/transferring-a-domain-from-11-ionos-to-another-provider/',
    steps: 'Turn off the domain transfer lock, then Renewal & Transfer → the domain → Show Authorization Code (it can take a few minutes).' },
];
export const registrarGuide = registrar => registrarGuides.find(guide => guide.match.test(String(registrar ?? ''))) ?? null;

// Where the new shop takes the transfer. Only Spaceship can be run by Domain Hound; the others are links.
export const spaceshipTransferPage = transferPages.spaceship;

const cents = value => Math.round(value * 100);
const usd = value => '$' + (value / 100).toFixed(2);
const ymd = iso => String(iso).slice(0, 10);
const daysSince = (iso, now) => {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.floor((now.getTime() - at) / day) : null;
};

// Status words that stop a transfer outright, and the one the person can fix at the current registrar.
const hardStatus = [
  ['transfer prohibited', 'the registry reports a transfer prohibition; ask your registrar to check it'],
  ['server transfer prohibited', 'the registry locks transfers (server transfer prohibited); only the registry or registrar can lift it'],
  ['pending transfer', 'a transfer is already pending'],
  ['pending delete', 'pending delete: the registry will release it'],
  ['redemption period', 'in redemption: restore it at the current registrar first'],
  ['pending restore', 'restore pending at the registry'],
];

// Blockers that stop a move now (hard), and the fixable lock. The same check runs again just before any transfer.
export function transferBlockers(record, rules, now = new Date()) {
  const blockers = [];
  if (record.state === 'unknown') blockers.push('the registry did not answer, so the lock dates and status are unknown');
  if (record.registered === false) blockers.push('the registry has no record of it');
  for (const [word, text] of hardStatus) if (record.status?.includes(word)) blockers.push(text);
  if (record.daysLeft !== null && record.daysLeft !== undefined) {
    if (record.daysLeft < 0) blockers.push('it expired on ' + ymd(record.expires) + '; renew it at the current registrar first');
    else if (record.daysLeft < minimumDaysToExpiry) {
      blockers.push('it expires in ' + record.daysLeft + (record.daysLeft === 1 ? ' day' : ' days') + ' (' + ymd(record.expires)
        + '); renew at the current registrar first, a transfer this close to expiry can fail');
    }
  }
  if (rules.lockDays) {
    const created = daysSince(record.created, now);
    const moved = daysSince(record.transferred, now);
    if (created !== null && created < rules.lockDays) {
      blockers.push('registered ' + ymd(record.created) + ', under ' + rules.lockDays + ' days ago; wait until '
        + ymd(new Date(Date.parse(record.created) + rules.lockDays * day).toISOString()));
    }
    if (moved !== null && moved < rules.lockDays) {
      blockers.push('transferred ' + ymd(record.transferred) + ', under ' + rules.lockDays + ' days ago; wait until '
        + ymd(new Date(Date.parse(record.transferred) + rules.lockDays * day).toISOString()));
    }
  }
  const locked = record.status?.includes('client transfer prohibited') ?? false;
  return { blockers, locked };
}

// One comparable three-year cost: the transfer (which adds yearsAdded years) and the remaining years at the shop's renewal
// price per year. Years beyond a whole renewal term are counted pro rata (annualized), so .ai's 2-year terms compare fairly.
export function threeYearCost({ transfer, transferYears, renewalPerYear }) {
  if (!Number.isFinite(transfer) || !Number.isFinite(renewalPerYear) || !(transferYears > 0)) return null;
  return transfer + Math.max(0, compareYears - transferYears) * renewalPerYear;
}

// The list-price options for one ending. Catalog prices are per year. A transfer price is used only where the term is
// known: endings whose transfer adds one year, and Spaceship's pricing page, whose transfer cell is per year.
function listOptions(tld, catalog, now) {
  const byShop = new Map();
  for (const row of [...datedListPrices(catalog, tld, now), ...datedListPrices(null, tld, now)]) {
    if (!Number.isFinite(row.renewal) || Date.parse(row.checkedAt) > now.getTime()) continue;
    if (!byShop.has(row.id) || row.checkedAt > byShop.get(row.id).checkedAt) byShop.set(row.id, row);
  }
  const spaceship = publishedSpaceshipPrice(tld, now);
  if (spaceship && !byShop.has('spaceship')) byShop.set('spaceship', spaceship);
  return byShop;
}

const listSource = id => ({
  spaceship: 'https://www.spaceship.com/domain-search/pricing/',
  dynadot: 'https://www.dynadot.com/domain/prices?currency=USD',
  porkbun: 'https://porkbun.com/products/domains',
  gandi: 'https://www.gandi.net/en/domain/tld/',
})[id] ?? null;

function targetOption(id, row, rules, live) {
  if (id === 'spaceship' && live) {
    const transferYears = live.years;
    const renewalPerYear = live.renewal.amount / live.renewal.years / 100;
    return { id, shop: 'Spaceship', basis: 'live', transfer: live.amount / 100, transferYears, renewalPerYear,
      regularTransfer: live.regular / 100, promo: live.promo, url: spaceshipTransferPage,
      threeYear: threeYearCost({ transfer: live.amount / 100, transferYears, renewalPerYear }) };
  }
  if (!row) return null;
  const years = rules.yearsAdded;
  let transfer = null;
  let note = null;
  if (Number.isFinite(row.transfer) && years === 1) transfer = row.transfer;
  else if (Number.isFinite(row.transfer) && years > 1 && id === 'spaceship') {
    transfer = Math.round(row.transfer * years * 100) / 100;
    note = 'list $' + row.transfer.toFixed(2) + '/yr × ' + years + ' years';
  } else if (Number.isFinite(row.transfer) && rules.ending === 'ai' && id === 'dynadot') {
    // Dynadot's table lists the full fee and its .ai page confirms the two-year extension.
    transfer = row.transfer;
  }
  const option = { id, shop: shops[id]?.name ?? id, basis: row.bundled ? 'snapshot' : 'list', checkedAt: row.checkedAt,
    transfer, transferYears: years, renewalPerYear: row.renewal, url: transferPages[id], source: row.source ?? listSource(id), ...(note && { note }) };
  option.threeYear = threeYearCost(option);
  if (option.threeYear === null) option.unavailable = years > 1 ? 'its list does not state the ' + years + '-year transfer price'
    : !years ? 'the transfer term for this ending is unknown' : 'no transfer price listed';
  return option;
}

// The plan from registry facts and prices. live is an optional live Spaceship transfer offer (see spaceship/transfer.mjs).
export function planFromFacts(domain, record, catalog, now = new Date(), live = null) {
  const rules = transferRules(domain);
  const guide = registrarGuide(record.registrar);
  const currentId = registrarShop(record.registrar);
  const rows = listOptions(rules.ending, catalog, now);
  const currentRow = currentId ? rows.get(currentId) : null;
  const published = publishedRenewal(guide?.id ?? currentId, rules.ending, now);
  const current = { registrar: record.registrar, shop: currentId ? shops[currentId]?.name ?? null : guide?.name ?? null,
    renewalPerYear: currentRow?.renewal ?? null, basis: currentRow ? currentRow.bundled ? 'snapshot' : 'list' : null,
    checkedAt: currentRow?.checkedAt ?? null, source: currentRow ? listSource(currentId) : null,
    ...(!currentRow && published) };
  const atSpaceship = currentId === 'spaceship' || guide?.id === 'spaceship';
  const options = Object.keys(transferPages).filter(id => id !== currentId)
    .map(id => targetOption(id, rows.get(id), rules, id === 'spaceship' ? live : null)).filter(Boolean);
  const comparable = options.filter(option => option.threeYear !== null);
  const cheapest = comparable.reduce((best, option) => !best || option.threeYear < best.threeYear ? option : best, null);
  const spaceship = comparable.find(option => option.id === 'spaceship');
  const target = spaceship && cheapest && spaceship.threeYear <= cheapest.threeYear + preferenceUsdPerYear * compareYears
    ? spaceship : cheapest;
  const stay = current.renewalPerYear !== null ? current.renewalPerYear * compareYears : null;
  const saving = stay !== null && target ? cents(stay - target.threeYear) / 100 : null;
  const { blockers, locked } = record.state === 'problem' && !record.registrar
    ? { blockers: [record.reason ?? 'the registry has no record'], locked: false } : transferBlockers(record, rules, now);
  const cautions = [];
  if (record.autoRenewGrace) {
    cautions.push('The registry shows auto-renew grace (a renewal just happened). Ask ' + (current.shop ?? 'the current registrar')
      + ' whether a transfer now refunds or keeps that renewal before you move.');
  }
  if (rules.yearsAdded === null) cautions.push(rules.rule);
  if ([current, target].some(price => price?.checkedAt && !isListPriceUsable(price.checkedAt, now))) {
    cautions.push('Some prices are from an older list. Check today’s prices before deciding.');
  } else if (current.renewalPerYear !== null) {
    cautions.push('Your own renewal bill may differ from the published standard price.');
  }
  if (target?.promo) cautions.push('Spaceship’s transfer price is a promotion; the regular price is ' + usd(cents(target.regularTransfer)) + '.');
  let verdict;
  if (atSpaceship && (saving === null || saving <= 0)) verdict = 'already-at-spaceship';
  else if (blockers.length) verdict = 'blocked';
  else if (!target) verdict = 'no-price';
  else if (saving === null) verdict = 'renewal-unknown';
  else verdict = saving / compareYears > minimumYearlySaving ? 'worth-moving' : 'small-saving';
  return { domain, checkedAt: now.toISOString(), rules, guide: guide && { name: guide.name, url: guide.url ?? null, steps: guide.steps ?? null },
    registry: { registered: record.registered ?? null, registrar: record.registrar,
      created: record.created, transferred: record.transferred ?? null, expires: record.expires,
      daysLeft: record.daysLeft, status: record.status, source: record.source },
    current, options, target: target ?? null, stayThreeYear: stay, saving, blockers, locked, cautions, verdict };
}

const money = value => '$' + value.toFixed(2);
const basisText = option => option.basis === 'live' ? 'live Spaceship quote' : (option.basis === 'snapshot' ? 'snapshot' : 'list')
  + ' price ' + ymd(option.checkedAt);

// The steps at the current registrar, then at the new shop.
export function moveSteps(plan) {
  const at = plan.current.shop ?? plan.registry.registrar ?? 'your current registrar';
  const guide = plan.guide;
  const steps = [];
  const lock = plan.locked ? 'Unlock the domain at ' + at + ' (the registry shows a transfer lock). '
    : plan.registry.status?.length ? 'The registry shows no transfer lock. ' : 'Check the transfer lock in your registrar account. ';
  steps.push(lock
    + 'Get the authorization (EPP) code' + (guide?.steps ? ': ' + guide.steps : ' from ' + at + '.')
    + (guide?.url ? ' [' + at + ' guide](' + guide.url + ')' : ' [ICANN transfer rules](' + icannPolicy + ')'));
  steps.push('Keep WHOIS privacy on unless a registrar requires it off for transfer. Make sure the owner email at ' + at
    + ' is reachable: some transfers ask for approval there.');
  if (plan.target?.id === 'spaceship') {
    steps.push('Start the transfer at Spaceship and enter the code there yourself: [Spaceship transfer](' + spaceshipTransferPage + '). '
      + 'Or ask Domain Hound for the transfer with your limits (move_domain with quote_id and max_usd).');
  } else if (plan.target) {
    steps.push('Start the transfer at ' + plan.target.shop + ' and enter the code there yourself: [' + plan.target.shop + ' transfer]('
      + plan.target.url + ').');
  }
  steps.push('Check that your current DNS provider will keep serving the domain after the move. If your current registrar hosts DNS, copy its records and arrange continued DNS service before transferring. Verify DNS and the new expiry afterwards.');
  return steps;
}

// The answer, at most about ten lines.
export function planLines(plan) {
  const { domain, registry, current, target } = plan;
  if (registry.registered === false) return [md(domain) + ': the registry has no record of it, so there is nothing to move.'];
  const lines = [];
  const where = registry.registrar ? md(registry.registrar) : 'an unknown registrar';
  lines.push(md(domain) + ': registered at ' + where + (registry.expires ? ', expires ' + ymd(registry.expires) : '') + '.'
    + (registry.transferred ? ' Last transfer ' + ymd(registry.transferred) + ' (registry).' : ''));
  if (plan.verdict === 'already-at-spaceship') {
    lines.push('Already at Spaceship. The prices below show no cheaper move.');
  }
  lines.push('Renewal at ' + md(current.shop ?? current.registrar ?? 'the current registrar') + ': '
    + (current.renewalPerYear !== null ? money(current.renewalPerYear) + '/yr (' + basisText(current) + ')'
      : 'unavailable (no reliable list price; check your last renewal invoice)') + '.');
  if (current.source) lines[lines.length - 1] += ' [Pricing](' + current.source + ')';
  for (const option of plan.options) {
    lines.push(option.shop + ': ' + (option.threeYear === null ? 'transfer price unavailable (' + option.unavailable + ')'
      : 'transfer ' + money(option.transfer) + ' adds ' + option.transferYears + (option.transferYears === 1 ? ' year' : ' years')
        + (option.note ? ' (' + option.note + ')' : '') + ', renews ' + money(option.renewalPerYear) + '/yr; ' + compareYears
        + ' years ' + money(option.threeYear) + ' (' + basisText(option) + ')') + '.');
  }
  if (target && plan.saving !== null) {
    const comparison = plan.saving >= 0 ? ' saves ' + money(plan.saving) : ' costs ' + money(-plan.saving) + ' more';
    lines.push('Moving to ' + target.shop + comparison + ' over ' + compareYears + ' years (annualized), against '
      + money(plan.stayThreeYear) + ' staying.');
  } else if (target) {
    lines.push('Suggested transfer shop: ' + target.shop + '. Check your current renewal bill to calculate the saving.');
  }
  if (plan.blockers.length) lines.push('Blocked now: ' + plan.blockers.map(md).join('; ') + '.');
  lines.push(...plan.cautions.map(md));
  lines.push('Rules: ' + plan.rules.rule + (plan.rules.source ? ' [source](' + plan.rules.source + ')' : ''));
  if (!plan.blockers.length && target && plan.verdict !== 'already-at-spaceship') {
    moveSteps(plan).forEach((step, index) => lines.push((index + 1) + '. ' + step));
  }
  else if (plan.guide?.url) lines.push('[' + plan.guide.name + ' transfer instructions](' + plan.guide.url + ')');
  return lines;
}

// Registry record shared by the public plan and the paid path.
export async function transferRegistryRecord(domain, { facts = portfolioRegistry, now = new Date() } = {}) {
  const answer = await facts(domain, { deadline: performance.now() + 6000 }).catch(() => null);
  return { ...readRegistry(answer, now), registered: answer?.registered === 'taken' ? true : answer?.registered === 'free' ? false : null };
}
