import { brandConflict, domainTier, rankedAlternatives, selectionReason, whoElse } from './name-context.mjs';
import { normalizeName, qualityRank } from './clis/domain-check/name-search.mjs';
import { md } from './display.mjs';

// The short answer is a small Markdown table plus at most two supporting lines. It never mentions a source that
// failed, was blocked or is still running: that source is left out here and stays on the results page.
// The closing instruction to the host travels as its own text block.
export const doneGuidance = 'Done. Show this; do not call more tools unless the user asks.';

const plain = value => String(value ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim();
const usd = value => '$' + value.toFixed(2);
const taken = row => ['taken', 'exact_match_found'].includes(row?.status);
const free = row => ['not-found', 'no_match_found'].includes(row?.status);
const empty = '—';
const cell = value => md(plain(value)) || empty;
const maxSupportingLines = 2;
const maxNames = 5;

function table(header, rows) {
  const line = cells => '|' + cells.map(value => value ? ' ' + value + ' ' : ' ').join('|') + '|';
  return [line(header), '|' + header.map(() => '---').join('|') + '|', ...rows.map(row => line(row.map(value => value ?? empty)))].join('\n');
}

// Upfront payment, renewal and shop. A multi-year minimum term says so in both price cells.
export function priceCells(offer) {
  const term = offer?.minimumYears ?? 1;
  const now = offer?.firstPaymentUsd ?? offer?.firstYearUsd;
  const renew = term > 1 ? offer?.renewalPaymentUsd : offer?.renewalUsd;
  if (!Number.isFinite(now) || !Number.isFinite(renew) || !offer.shop) return null;
  return [usd(now) + (term > 1 ? ' for ' + term + ' yrs' : ''), usd(renew / term) + (term > 1 ? ' (' + term + '-yr term)' : ''),
    cell(offer.shop) + (offer.needsCloudflareDns ? ' (needs Cloudflare DNS)' : '')];
}

function rowOffer(row, pick) {
  const offer = pick?.domain === row.domain ? pick : row.prices?.[0];
  return priceCells(offer) ?? priceCells(row.prices?.find(candidate => candidate.shop === offer?.shop));
}

// Only definite registry states appear; an unanswered ending is left out.
function rowStatus(row, owned) {
  if (row.status === 'owned' || owned.has(row.domain)) return 'owned';
  if (row.status === 'available') return row.premium ? 'premium' : 'available';
  if (row.status === 'taken') return 'taken';
  return row.reason === 'reserved' ? 'reserved' : null;
}

function headsUp(us) {
  if (us?.status !== 'exact_match_found') return '';
  const match = us.marks?.[0];
  const kind = match?.status === 'applied' ? 'US trademark application ' : 'US trademark ';
  return 'Heads-up: ' + kind + (match?.mark ? cell(match.mark) : 'with this exact name')
    + (match?.owner ? ' (' + cell(match.owner) + ')' : '') + ', matters if you sell in the US.';
}

const sources = check => ({
  app: check.appStore ?? check.nameChecks?.appStore,
  play: check.googlePlay ?? check.nameChecks?.googlePlay,
  us: check.trademarks?.us ?? check.nameChecks?.trademarks?.us,
});
const appState = row => taken(row) ? 'taken' : free(row) ? 'free' : null;

// "Apps: App Store free · Google Play taken", from settled answers only.
function appsLine(check) {
  const { app, play, us } = sources(check);
  const apps = [['App Store', app], ['Google Play', play]].flatMap(([label, row]) => appState(row) ? [label + ' ' + appState(row)] : []);
  const mark = us?.status === 'no_exact_match_found' ? ['no exact US trademark'] : [];
  return apps.length ? 'Apps: ' + [...apps, ...mark].join(' · ') : mark.length ? 'US trademark: no exact match' : '';
}

// The Who else line without facts about sources that did not answer.
function whoElseLine(text) {
  if (!text) return '';
  const [, facts = ''] = text.match(/^Who else \(rough read\): (.*)\.$/) ?? [];
  const kept = facts.split(' · ').filter(fact => fact && !/unavailable|did not answer|couldn’t|could not/i.test(fact));
  return kept.length ? 'Who else (rough read): ' + kept.join(' · ') + '.' : '';
}

function supporting(candidates) {
  return candidates.filter(Boolean).slice(0, maxSupportingLines);
}

function answer(body, notes, link) {
  const lines = supporting(notes);
  if (link && lines.length === maxSupportingLines) lines[maxSupportingLines - 1] += ' · ' + link;
  else if (link) lines.push(link);
  return [body, lines.join('\n')].filter(Boolean).join('\n\n');
}

function domainRows(check, { primary, pick, also, owned, label }) {
  const rows = [];
  const seen = new Set();
  const add = (role, row) => {
    if (!row || seen.has(row.domain)) return;
    const status = rowStatus(row, owned);
    if (!status) return;
    seen.add(row.domain);
    const prices = ['available', 'premium'].includes(status) ? rowOffer(row, pick) : null;
    rows.push([role, cell(row.domain), status, ...(prices ?? [empty, empty, empty])]);
  };
  const exact = check.query.exactDomain;
  const hit = check.domains.find(row => row.domain === exact);
  if (exact) add(primary?.domain === exact && rowStatus(hit, owned) === 'available' ? 'Best' : 'Asked', hit);
  add('Best', primary);
  for (const row of also.slice(0, 2)) add('Also', row);
  const yours = [...owned].filter(domain => !seen.has(domain));
  if (yours.length) {
    rows.push(['Yours', yours.slice(0, 3).map(cell).join(', ') + (yours.length > 3 ? ' +' + (yours.length - 3) : ''), 'owned', empty, empty, empty]);
    yours.forEach(domain => seen.add(domain));
  }
  const all = [...new Map([...(check.alternatives?.domains ?? []), ...check.domains].map(row => [row.domain, row])).values()];
  const takenSame = all.filter(row => !seen.has(row.domain) && !row.variant && row.status === 'taken'
    && row.domain.split('.')[0] === label && !owned.has(row.domain));
  if (takenSame.length) {
    rows.push(['Taken', takenSame.length === 1 ? cell(takenSame[0].domain) : takenSame.map(row => '.' + cell(row.ending ?? row.domain.split('.').slice(1).join('.'))).join(' '),
      'taken', empty, empty, empty]);
  }
  return rows;
}

const domainHeader = ['', 'Domain', 'Status', 'Now', 'Then/yr', 'Where'];

export function shortDomainAnswer(check, { link, purchase = false } = {}) {
  const ranked = Boolean(check.context || check.advice || check.ownedDomains?.length || check.ranked);
  const { query, ownedDomains = [], context, advice } = check;
  const exact = query.exactDomain;
  const label = query.ascii ?? context?.label ?? normalizeName((exact || query.name).split('.')[0]) ?? '';
  const alternatives = check.alternatives;
  const rows = alternatives?.domains ?? check.domains;
  const hit = check.domains.find(row => row.domain === exact);
  const owned = new Set(ownedDomains);
  const available = rows.filter(row => row.status === 'available');
  let first;
  let primary;
  let pick;
  let also;
  if (ranked) {
    pick = alternatives?.choice?.pick ?? check.choice?.pick;
    const best = rows.find(row => row.domain === pick?.domain);
    primary = !exact || pick?.domain !== exact ? best : hit;
    const reason = pick ? ' ' + selectionReason(pick.domain, label) : '';
    const name = cell(exact);
    if (exact && (hit?.status === 'owned' || owned.has(exact))) {
      first = pick && pick.domain !== exact ? 'You own ' + name + '. Alternative: ' + cell(pick.domain) + '.' + reason : 'Keep using ' + name + '.';
    } else if (exact && hit?.status === 'available' && (!pick || pick.domain === exact) && !hit.premium) {
      first = name + ' is available' + (!pick && hit.prices?.length ? ' above your price cap.' : '.');
    } else if (exact) {
      const state = hit?.status === 'taken' ? ' is taken.' : hit?.reason === 'reserved' ? ' is reserved.'
        : hit?.premium ? ' has ' + (/may be|possible|risk/i.test(hit.premium) ? 'possible premium pricing.' : 'premium pricing.')
          : hit?.status === 'available' ? ' is above your price cap.' : '';
      first = (state ? name + state : '') + (pick && pick.domain !== exact ? ' Best alternative: ' + cell(pick.domain) + '.' + reason : '');
    } else if (pick) first = cell(pick.domain) + ' is your best bet.' + reason;
    else if (ownedDomains.length) first = 'Keep using ' + cell(ownedDomains[0]) + '.';
    else if (rows.filter(row => !row.variant).every(row => row.status === 'taken' || row.status === 'owned')) {
      first = 'All ' + rows.filter(row => !row.variant).length + ' checked endings are taken. Try a new name.';
    } else first = '';
    const compare = (a, b) => domainTier(a.domain, label) - domainTier(b.domain, label) || qualityRank(a.domain) - qualityRank(b.domain);
    also = rankedAlternatives(rows, primary ?? hit, label, compare);
  } else {
    pick = alternatives?.choice?.pick ?? check.choice?.pick;
    const best = available.find(row => row.domain === pick?.domain) ?? available[0];
    primary = exact && hit?.status === 'available' ? hit : best;
    const takenCount = rows.filter(row => row.status === 'taken').length;
    if (exact) {
      if (hit?.status === 'available') first = cell(exact) + ' is available.';
      else if (hit?.status === 'taken') first = cell(exact) + ' is taken.' + (best ? ' Best available: ' + cell(best.domain) + '.' : '');
      else if (hit?.reason === 'reserved') first = cell(exact) + ' is reserved by the registry.';
      else first = best ? 'Best available: ' + cell(best.domain) + '.' : '';
    } else if (best) first = cell(best.domain) + (best.domain === pick?.domain ? ' is your best bet.' : ' is available.');
    else if (rows.length && takenCount === rows.length) {
      first = 'All ' + rows.length + (rows.length === 1 ? ' ending is' : ' endings are') + ' taken. Want new name ideas?';
    } else first = '';
    also = available.filter(row => row !== primary && row.domain !== exact);
  }
  const tableRows = domainRows(check, { primary, pick, also, owned, label });
  const { us } = sources(check);
  const others = ranked ? whoElseLine(whoElse(context, { pick, ownedDomains, hasAdvice: Boolean(advice),
    blockedBrand: brandConflict(context, check.trademarks) })) : '';
  const text = tableRows.length ? table(domainHeader, tableRows) : first.trim();
  const ownAdvice = ownedDomains.length && context?.domain && !owned.has(context.domain)
    && check.domains.some(row => row.domain === context.domain && row.status === 'taken')
    ? 'Keep using ' + cell(ownedDomains[0]) + ' and hold off on ' + cell(context.domain) + '.' : '';
  const notes = [headsUp(us), ownAdvice || advice?.text, appsLine(check), others];
  const shown = answer(text, notes, link);
  return purchase && first && tableRows.length ? first + '\n\n' + shown : shown;
}

// Several names or domains in one call: one row per entry.
export function shortBatchAnswer(checks, { link } = {}) {
  const rows = checks.map(check => {
    const exact = check.query.exactDomain;
    const owned = new Set(check.ownedDomains ?? []);
    const rowsFor = check.alternatives?.domains ?? check.domains;
    const pick = check.alternatives?.choice?.pick ?? check.choice?.pick;
    const hit = exact ? check.domains.find(row => row.domain === exact) : null;
    const best = rowsFor.find(row => row.domain === pick?.domain && row.status === 'available')
      ?? rowsFor.find(row => row.status === 'available');
    const shown = hit && rowStatus(hit, owned) !== 'taken' ? hit : best ?? hit;
    const status = shown ? rowStatus(shown, owned) : rowsFor.length && rowsFor.every(row => row.status === 'taken') ? 'all taken' : null;
    const prices = shown && ['available', 'premium'].includes(status) ? rowOffer(shown, pick) : null;
    return [cell(exact ?? check.query.name), shown ? cell(shown.domain) : empty, status ?? empty, ...(prices ?? [empty, empty, empty])];
  });
  const warnings = checks.map(check => headsUp(sources(check).us)).filter(Boolean);
  return answer(table(['Name', 'Domain', 'Status', 'Now', 'Then/yr', 'Where'], rows), warnings, link);
}

function shortWhy(text, words = 6) {
  const all = plain(text).replace(/[.!]+$/, '').split(/\s+/).filter(Boolean);
  return all.length ? cell(all.slice(0, words).join(' ') + (all.length > words ? '…' : '')) : empty;
}

function nameChecks(check) {
  const { app, play, us } = sources(check);
  const states = [appState(app), appState(play)];
  const apps = states.every(state => state === 'free') ? ['apps free'] : states.every(state => state === 'taken') ? ['apps taken']
    : [['App Store', states[0]], ['Google Play', states[1]]].flatMap(([label, state]) => state ? [label + ' ' + state] : []);
  const mark = us?.status === 'no_exact_match_found' ? ['no US TM match'] : us?.status === 'exact_match_found' ? ['US TM match'] : [];
  return [...apps, ...mark].join(' · ') || empty;
}

// The screen's own pick; a screened name without one still shows its first priced free domain.
const domainPick = (check, fallback = false) => {
  const pick = check.choice?.pick;
  const row = pick && check.domains.find(row => row.domain === pick.domain && row.status === 'available');
  if (row) return { row, pick };
  const free = fallback && check.domains.find(row => row.status === 'available' && !row.premium && row.prices?.length);
  return free ? { row: free, pick: null } : null;
};

// Up to five names with a free domain, one per creative territory and anchor first, then by rank.
export function diverseNames(checks, limit = maxNames) {
  const withDomain = checks.filter(domainPick);
  const chosen = [];
  const territories = new Set();
  const anchors = new Set();
  for (const check of withDomain) {
    if (chosen.length >= limit) break;
    const territory = check.territory ?? null;
    const anchor = check.anchor ? normalizeName(check.anchor) : null;
    if ((territory && territories.has(territory)) || (anchor && anchors.has(anchor))) continue;
    chosen.push(check);
    if (territory) territories.add(territory);
    if (anchor) anchors.add(anchor);
  }
  for (const check of withDomain) {
    if (chosen.length >= limit) break;
    if (!chosen.includes(check)) chosen.push(check);
  }
  return withDomain.filter(check => chosen.includes(check));
}

// A generated round shows only
// names with a free domain; a screen of the person's own names shows each of them.
export function shortIdeaAnswer(checks, { link, generated = false } = {}) {
  const shown = generated ? diverseNames(checks) : checks.slice(0, maxNames);
  const rows = shown.map(check => {
    const found = domainPick(check);
    const prices = found ? rowOffer(found.row, found.pick) : null;
    const domain = found ? cell(found.row.domain)
      : check.domains.length && check.domains.every(row => row.status === 'taken') ? 'all taken' : empty;
    return [cell(check.query.name), shortWhy(check.why), domain, prices ? prices[0] + ' / ' + prices[1] : empty];
  });
  if (!rows.length) return link || 'Try another naming direction.';
  const warnings = shown.map(check => headsUp(sources(check).us)
    .replace(/^Heads-up: /, 'Heads-up for ' + cell(check.query.name) + ': ')).filter(Boolean);
  const checked = shown.map(check => ({ name: cell(check.query.name), checks: nameChecks(check) }))
    .filter(row => row.checks !== empty);
  const notes = [...warnings, checked.length ? checked.slice(0, 3).map(row => row.name + ' · ' + row.checks).join(' · ') : ''];
  return answer(table(['Name', 'Why', 'Domain', 'Now/Then'], rows), notes, link);
}
