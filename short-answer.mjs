import { domainTier, rankedAlternatives, selectionReason, whoElse } from './name-context.mjs';
import { canRecommend, normalizeName, preferUnlocked, qualityRank } from './clis/domain-check/name-search.mjs';
import { md } from './display.mjs';
import { fitsBudget, preferenceScore, usMarket } from './host-context.mjs';

// The short answer is a small Markdown table plus at most two supporting lines. It never mentions a source that
// failed, was blocked or is still running: that source is left out here and stays on the results page.
// The closing instruction to the host travels as its own text block.
export const doneGuidance = 'Share these checked facts and add up to two lines of tailored advice if useful. Do not call more tools unless the user asks. '
  + 'For an exact domain that is taken, always show its best available alternative from the answer, even for a yes/no question. '
  + 'Mention resale only if the user asks about buying the taken domain. '
  + 'Base factual claims on the listed checks. Leave out discussion of missing checks.';

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

// Upfront payment, renewal and shop. A multi-year minimum term says so in both price cells. Shop conditions such as a
// required DNS provider stay on the results page.
export function priceCells(offer) {
  const term = offer?.minimumYears ?? 1;
  const now = offer?.firstPaymentUsd ?? offer?.firstYearUsd;
  const renew = term > 1 ? offer?.renewalPaymentUsd : offer?.renewalUsd;
  if (!Number.isFinite(now) || !Number.isFinite(renew) || !offer.shop) return null;
  return [usd(now) + (term > 1 ? ' for ' + term + ' yrs' : ''), usd(renew / term) + (term > 1 ? ' (' + term + '-yr term)' : ''),
    cell(offer.shop)];
}

function rowOffer(row, pick) {
  const offer = pick?.domain === row.domain ? pick : preferUnlocked(row.prices ?? []);
  return priceCells(offer) ?? priceCells(row.prices?.find(candidate => candidate.shop === offer?.shop));
}

// Only definite registry states appear; an unanswered ending is left out.
function rowStatus(row, owned) {
  if (row.status === 'owned' || owned.has(row.domain)) return 'owned';
  if (row.status === 'available') return row.premium ? 'premium' : 'available';
  if (row.status === 'taken') return 'taken';
  return row.reason === 'reserved' ? 'reserved' : null;
}

function headsUp(us, market) {
  if (us?.status !== 'exact_match_found') return '';
  const match = us.marks?.[0];
  const kind = match?.status === 'applied' ? 'US trademark application ' : 'US trademark ';
  return 'Heads-up: ' + kind + (match?.mark ? cell(match.mark) : 'with this exact name')
    + (match?.owner ? ' (' + cell(match.owner) + ')' : '') + (usMarket(market) ? ', matters if you sell in the US.' : '.');
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

// The table holds only priced, available rows. Taken, owned and unpriced domains go on one status line below it,
// never as rows of empty cells.
function domainRows(check, { primary, pick, also, owned, label }) {
  const rows = [];
  const seen = new Set();
  const taken = [];
  const yours = [];
  const other = [];
  const add = (role, row) => {
    if (!row || seen.has(row.domain)) return;
    const status = rowStatus(row, owned);
    if (!status) return;
    seen.add(row.domain);
    const prices = ['available', 'premium'].includes(status) ? rowOffer(row, pick) : null;
    if (prices) rows.push([role, cell(row.domain), status, ...prices]);
    else if (status === 'taken') taken.push(cell(row.domain));
    else if (status === 'owned') yours.push(row.domain);
    else if (status !== 'available') other.push(cell(row.domain) + ' ' + status);
  };
  const exact = check.query.exactDomain;
  const hit = check.domains.find(row => row.domain === exact);
  if (exact) add(primary?.domain === exact && rowStatus(hit, owned) === 'available' ? 'Best' : 'Asked', hit);
  add('Best', primary);
  for (const row of also.slice(0, 2)) add('Also', row);
  for (const domain of owned) if (!seen.has(domain) && !yours.includes(domain)) yours.push(domain);
  yours.forEach(domain => seen.add(domain));
  const all = [...new Map([...(check.alternatives?.domains ?? []), ...check.domains].map(row => [row.domain, row])).values()];
  const takenSame = all.filter(row => !seen.has(row.domain) && !row.variant && row.status === 'taken'
    && row.domain.split('.')[0] === label && !owned.has(row.domain));
  const endings = takenSame.map(row => '.' + cell(row.ending ?? row.domain.split('.').slice(1).join('.')));
  const takenText = [...taken, ...(taken.length || takenSame.length > 1 ? endings : takenSame.map(row => cell(row.domain)))];
  const status = [
    takenText.length ? 'Taken: ' + takenText.join(', ') : '',
    yours.length ? 'Yours: ' + yours.slice(0, 3).map(cell).join(', ') + (yours.length > 3 ? ' +' + (yours.length - 3) : '') : '',
    other.length ? other.join(', ') : '',
  ].filter(Boolean).join(' · ');
  return { rows, status };
}

const domainHeader = ['', 'Domain', 'Status', 'Now', 'Then/yr', 'Where'];

export function shortDomainAnswer(check, { link, purchase = false, market, eligible = [], preferred = [],
  budget, budgetThreeYearUsd, likes, dislikes, idea } = {}) {
  const ranked = Boolean(check.context || check.advice || check.ownedDomains?.length || check.ranked);
  const { query, ownedDomains = [], context } = check;
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
    const tier = row => preferred.includes(row.ending) && !row.variant ? 0 : domainTier(row.domain, label);
    const compare = (a, b) => tier(a) - tier(b) || qualityRank(a.domain, preferred, eligible) - qualityRank(b.domain, preferred, eligible);
    const choices = rows.filter(row => canRecommend(row.ending, eligible) && preferenceScore(row.ending, { likes, dislikes }, { ending: true }) >= 0
      && row.prices?.some(offer => fitsBudget(offer, { budget, budgetThreeYearUsd })));
    also = rankedAlternatives(choices, primary ?? hit, label, compare);
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
  const { rows: tableRows, status: statusLine } = domainRows(check, { primary, pick, also, owned, label });
  const { us } = sources(check);
  const others = ranked ? whoElseLine(whoElse(context, { hasAdvice: true, idea })) : '';
  const priced = tableRows.length ? table(domainHeader, tableRows) : '';
  const takenExact = hit?.status === 'taken' && !owned.has(exact);
  const alternative = takenExact && primary && tableRows.some(row => row[1] === cell(primary.domain) && row[2] === 'available')
    ? 'Best available alternative: ' + cell(primary.domain) + '.' : '';
  const sections = takenExact ? [statusLine, alternative, priced] : [priced || first.trim(), statusLine];
  const text = sections.filter(Boolean).join('\n\n');
  const notes = [headsUp(us, market), appsLine(check), others];
  const shown = answer(text, notes, link);
  return purchase && first && tableRows.length ? first + '\n\n' + shown : shown;
}

// Several names or domains in one call: one row per entry.
export function shortBatchAnswer(checks, { link, market } = {}) {
  const taken = new Set();
  const yours = new Set();
  const other = [];
  const rows = checks.flatMap(check => {
    const exact = check.query.exactDomain;
    const owned = new Set(check.ownedDomains ?? []);
    const rowsFor = check.alternatives?.domains ?? check.domains;
    const pick = check.alternatives?.choice?.pick ?? check.choice?.pick;
    const hit = exact ? check.domains.find(row => row.domain === exact) : null;
    if (hit && rowStatus(hit, owned) === 'taken') taken.add(cell(hit.domain));
    const best = rowsFor.find(row => row.domain === pick?.domain && row.status === 'available')
      ?? rowsFor.find(row => row.status === 'available');
    const hitStatus = hit && rowStatus(hit, owned);
    const shown = hitStatus && hitStatus !== 'taken' ? hit : best ?? hit;
    const status = shown ? rowStatus(shown, owned) : rowsFor.length && rowsFor.every(row => row.status === 'taken') ? 'all taken' : null;
    const prices = shown && ['available', 'premium'].includes(status) ? rowOffer(shown, pick) : null;
    if (prices) return [[cell(exact ?? check.query.name), cell(shown.domain), status, ...prices]];
    if (status === 'all taken') taken.add(cell(check.query.name));
    else if (status === 'owned') yours.add(cell(shown.domain));
    else if (status && status !== 'taken') other.push(cell(shown.domain) + ' ' + status);
    return [];
  });
  const body = [
    rows.length ? table(['Name', 'Domain', 'Status', 'Now', 'Then/yr', 'Where'], rows) : '',
    taken.size ? 'Taken: ' + [...taken].join(', ') : '',
    yours.size ? 'Yours: ' + [...yours].join(', ') : '',
    other.join(', '),
  ].filter(Boolean).join('\n\n');
  const warnings = checks.map(check => headsUp(sources(check).us, market)).filter(Boolean);
  return answer(body, warnings, link);
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
  const row = pick && check.domains.find(row => row.domain === pick.domain && ['available', 'owned'].includes(row.status));
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
export function shortIdeaAnswer(checks, { link, generated = false, market } = {}) {
  const shown = generated ? diverseNames(checks) : checks.slice(0, maxNames);
  const rows = shown.map(check => {
    const found = domainPick(check);
    const prices = found ? rowOffer(found.row, found.pick) : null;
    const domain = found ? cell(found.row.domain)
      : check.domains.length && check.domains.every(row => row.status === 'taken') ? 'all taken' : empty;
    return [cell(check.query.name), shortWhy(check.why), domain, found?.row.status === 'owned' ? 'Already yours' : prices ? prices[0] + ' / ' + prices[1] : empty];
  });
  if (!rows.length) return link || 'Try another naming direction.';
  const warnings = shown.map(check => headsUp(sources(check).us, market)
    .replace(/^Heads-up: /, 'Heads-up for ' + cell(check.query.name) + ': ')).filter(Boolean);
  const checked = shown.map(check => ({ name: cell(check.query.name), checks: nameChecks(check) }))
    .filter(row => row.checks !== empty);
  const notes = [...warnings, checked.length ? checked.slice(0, 3).map(row => row.name + ' · ' + row.checks).join(' · ') : ''];
  return answer(table(['Name', 'Why', 'Domain', 'Now/Then'], rows), notes, link);
}
