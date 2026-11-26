import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canRecommend, choosePick, comparePicks, defaultEndings, domainEnding, eligibilityNeed, lowestTotal, lowestUpfront, normalizeName,
  qualityRank, termCosts } from './clis/domain-check/name-search.mjs';
import { handleLabel, handlePriorities, handleSummary, linkedInSearchHint } from './clis/domain-check/handles.mjs';
import { googlePlayLabel, googlePlayLinkLabel, playSearchLink } from './clis/domain-check/google-play.mjs';
import { dnsNeed, shopSearchUrl, shops } from './clis/domain-check/prices.mjs';
import { trademarkSearches } from './clis/domain-check/triage-sources.mjs';
import { attributed, localCheckNotice, safeLink } from './display.mjs';
import { checkLines, nameCheckLines, pickDomain, pickLine, visibleChecks } from './hosted-results.mjs';
import { datedListPrices, loadCachedCatalog } from './clis/domain-check/price-catalog.mjs';
import { alternativeEndings } from './hosted.mjs';
import { anchor, escape, paragraph, priceDay, publicShare, renderCards } from './results-cards.mjs';
import { shareUrl } from './share.mjs';
import { compareScores, scoreEligible, scoreHeadline, scoreName } from './clis/domain-check/name-score.mjs';

const cash = value => Number.isFinite(value) ? '$' + value.toFixed(2) : null;
const cloudflareDns = 'Requires Cloudflare DNS';
const plain = value => String(value ?? '').replace(/[\r\n\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s*[—–]\s*/g, '. ').trim();
const evidenceText = value => plain(value).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/https?:\/\/[^\s)]+/gi, '').replace(/[\[\]<>]/g, '').replace(/\s{2,}/g, ' ').trim();
const markdown = value => plain(value).replace(/[\\|<>\[\]`*]/g, '\\$&');
const shopIds = new Map(Object.entries(shops).map(([id, { name }]) => [name, id]));
const fallbackShop = ending => ending === 'no' ? 'dynadot' : ending === 'so' ? 'namecheap' : 'spaceship';
const markOf = row => row.competition?.US;
// A check still running in the follow-up reads "still checking"; one that never answered reads "check incomplete".
const waitingOn = (row, source) => Array.isArray(row.waiting) && row.waiting.includes(source);
const notScreened = row => row.competition?.sameName?.summary === 'Not screened';
const missing = (row, source) => waitingOn(row, source) ? 'still checking' : notScreened(row) ? 'not screened' : 'check incomplete';
// EU and Norway marks appear once their key is set: a hit, [] for none, null for an incomplete check.
const offices = [['EU', 'EU', 'EUIPO'], ['NO', 'Norway', 'Patentstyret']];
const officeText = (row, office, name) => {
  const mark = row.competition?.[office];
  if (typeof mark === 'string') return evidenceText(mark);
  if (mark === true) return 'match found';
  if (mark != null) return 'no match found';
  return waitingOn(row, name) ? 'still checking' : "couldn't check";
};
const marksText = (row, skip = []) => {
  const mark = markOf(row);
  return [...(skip.includes('US') ? [] : ['US marks: ' + (typeof mark === 'string' ? evidenceText(mark) : mark == null ? missing(row, 'USPTO') : 'no match found')]),
    ...offices.filter(([office]) => Object.hasOwn(row.competition ?? {}, office) && !skip.includes(office))
      .map(([office, label, name]) => label + ' marks: ' + officeText(row, office, name))].join('; ');
};
// Record links only to the offices' own record pages.
const recordHosts = new Set(['euipo.europa.eu', 'services.patentstyret.no', 'tsdr.uspto.gov']);
const recordLink = value => {
  const url = httpsLink(value);
  return url && recordHosts.has(new URL(url).hostname) ? url : null;
};
const officeMarks = row => (Array.isArray(row.competition?.marks) ? row.competition.marks : [])
  .filter(entry => entry && typeof entry === 'object' && typeof entry.mark === 'string');
const markLabel = entry => plain(entry.office) + ' mark: ' + plain(entry.tier) + ' ' + plain(entry.mark) + ', ' + plain(entry.status)
  + ', classes ' + ((Array.isArray(entry.classes) ? entry.classes : []).map(plain).join('/') || 'unavailable')
  + (entry.checkedAt ? ', earlier answer from ' + plain(entry.checkedAt) : '');
const watchLink = domain => 'https://domainhound.dev/watch/?domain=' + encodeURIComponent(domain);
const verdictOrder = { 'No conflict found': 0, 'Check first': 1, Avoid: 2 };
// "Name score 91/100 - how clear the road is · Strong", or why a name has none. An exact domain check has no Name score.
function scoreText(row) {
  const score = row.score;
  if (score?.filtered) return 'Not scored: ' + plain(score.filtered) + '.';
  const headline = scoreHeadline(score);
  if (headline) return headline + ' · ' + plain(score.band) + (score.pending ? ' (still checking)' : '') + '.';
  return row.verdict && notScreened(row) ? 'Name score: not screened (first five names only).' : null;
}
const scoreReasons = row => Array.isArray(row.score?.reasons) && !row.score.filtered ? row.score.reasons.map(plain) : [];
const shortScore = row => Number.isInteger(row.score?.value) ? ' Name score ' + row.score.value + '/100, ' + plain(row.score.band) + '.'
  : row.score?.filtered ? ' Not scored: ' + plain(row.score.filtered) + '.' : '';

function resultGroups(data, eligibleEndings, preferred = []) {
  return data.names.map((row, index) => {
    const detail = data.receiptDetails?.[index] ?? {};
    const exact = row.name.includes('.');
    const label = exact ? row.name : normalizeName(row.name);
    const requested = exact ? [...preferred, row.name] : preferred;
    const eligibleList = eligibleEndings ?? data.eligible;
    const listed = [...(row.free ?? []), ...(row.taken ?? []), ...(row.shop_check ?? []), ...(row.resale ?? []),
      ...(row.premium ?? []), ...(row.reserved ?? [])].map(value => value.d ?? value).filter(value => typeof value === 'string');
    const variants = listed.filter(value => value.includes('.') && value !== 'co.uk');
    // Endings on request (such as .de or .uk) join the default endings when the lookup returned them.
    const extra = listed.filter(value => (!value.includes('.') || value === 'co.uk') && !defaultEndings.includes(value));
    const targets = exact ? [row.name] : [...new Set([...[...defaultEndings, ...extra].map(ending => label + '.' + ending), ...variants])];
    const records = targets.map(domain => {
      const ending = domainEnding(domain);
      const lookupKey = domain === label + '.' + ending || exact ? ending : domain;
      const match = list => list?.find(value => (value.d ?? value) === domain || (value.d ?? value) === lookupKey);
      const option = match(row.free);
      const raw = detail.endings?.find(item => item.domain === domain);
      const confirmed = option?.s === 'ok';
      const quote = confirmed ? option : { ...data.listPrices?.[ending], ...data.listPrices?.[domain],
        ...data.prices?.[ending], ...row.own?.[ending], ...(typeof option === 'object' ? option : {}) };
      const taken = Boolean(match(row.taken) || match(row.resale));
      const reserved = Boolean(match(row.reserved));
      const risk = Boolean(option?.risk || raw?.risk);
      const premium = Boolean(match(row.premium) || option?.s === 'prem' || option?.prem || risk);
      const includePrice = !reserved && (!premium || confirmed) && (!taken || exact);
      const likely = match(row.likely_free) ? 'possibly available by DNS' : match(row.likely_taken) ? 'likely taken by DNS' : null;
      const state = taken ? 'taken' : premium ? 'premium' : option ? 'free' : 'check';
      const status = taken ? (match(row.resale) ? 'Taken, possible resale' : 'Taken')
        : reserved ? 'Not offered for registration' : confirmed ? 'Confirmed at shop'
          : premium ? (risk ? 'May be premium, price at shop' : 'Premium, price at shop')
          : option ? 'Available at the registry' : likely ? 'Check at shop, ' + likely
            : data.pending && !data.failed && !match(row.shop_check) ? 'Still checking' : 'Check at shop';
      const usd = includePrice ? { now: quote.now, renew: quote.renew, y3: quote.y3, term: quote.term,
        jump: quote.jump, shop: quote.shop } : {};
      const term = usd.term ?? 1;
      const total = usd.y3 ?? (usd.now != null && usd.renew != null ? usd.now + (Math.ceil(3 / term) - 1) * usd.renew : null);
      const source = ({ web: 'Live site', dns: 'DNS', rdap: 'Registry RDAP', whois: 'Registry WHOIS',
        shop: 'Shop', list: 'Price list' })[raw?.source] ?? (confirmed ? 'Shop' : likely ? 'DNS' : 'Registry');
      const shop = usd.shop ?? raw?.shop ?? shops[fallbackShop(ending)]?.name;
      const eligible = canRecommend(ending, eligibleList);
      const shopUrl = shopSearchUrl(shopIds.get(shop) ?? fallbackShop(ending), domain);
      const checkout = taken || reserved || !eligible ? null : [raw?.checkout, shopUrl].find(url => safeLink(url, domain)) ?? null;
      return { domain, ending, rank: qualityRank(domain, requested, eligibleList), state, status, ...usd, total,
        shop, checkout, eligible, source, ...(raw?.savings && { savings: raw.savings }),
        ...(includePrice && dnsNeed(usd.shop) && { dns: cloudflareDns }),
        priceLabel: usd.now != null || usd.renew != null ? (confirmed ? 'Shop quote' : taken ? 'Standard list price benchmark' : 'List price') : '',
        checkedAt: raw?.checkedAt ?? data.checkedAt, priceAt: confirmed ? raw?.checkedAt ?? data.checkedAt : raw?.priceAt ?? data.priceListDate,
        site: raw?.site ?? detail.details?.sites?.[ending] ?? row.details?.sites?.[ending] };
    });
    // Free rows first, then in the quality order (a typed exact domain is requested), then by upfront payment.
    records.sort((a, b) => Number(b.state === 'free' || b.priceLabel === 'Shop quote')
      - Number(a.state === 'free' || a.priceLabel === 'Shop quote')
      || a.rank - b.rank || (a.now ?? Infinity) - (b.now ?? Infinity));
    return { row: { ...row, ...detail, name: row.name }, records };
  });
}

function availabilityScore(group, args) {
  const { row, records } = group;
  if (row.name.includes('.')) return group;
  const label = normalizeName(row.name);
  const domains = records.filter(record => record.status === 'Available at the registry' && record.eligible
    && record.domain === label + '.' + record.ending && (!args.endings?.length || args.endings.includes(record.ending))
    && (args.budget == null || (record.now ?? Infinity) <= args.budget))
    .map(record => ({ ending: record.ending, total: record.total, registry: true }));
  return { ...group, row: { ...row, score: scoreName({ name: row.name, domains }) } };
}

function priceDate(offer) {
  return offer.priceAt ? ' checked ' + offer.priceAt.slice(0, 10) : '';
}

function offerText(offer, linked = false) {
  const { domain, checkout, now, renew, term, jump, priceLabel } = offer;
  const price = now != null ? cash(now) + (renew != null ? ', then ' + cash(renew) : ', renewal at shop')
    : renew != null ? cash(renew) + ' renewal' : 'price at shop';
  return (linked && checkout ? '[' + domain + '](' + checkout + ')' : domain) + ' ' + price
    + (term > 1 ? ' every ' + term + ' years' : '') + (jump ? ' (renewal jumps)' : '')
    + (priceLabel ? ' ' + priceLabel.toLowerCase() + priceDate(offer) : '') + (offer.dns ? ' (' + offer.dns + ')' : '');
}

function appFinding(value, row, source) {
  if (value == null) return missing(row, source);
  return Array.isArray(value) && !value.length ? 'no app with this name' : 'same-name app found';
}

// check_domains never screens apps, so its lines show the web signal only.
function signals(group, triage = true) {
  const { row, records } = group;
  const comp = row.competition ?? {};
  const site = records.map(record => record.site).find(site => site?.state === 'live')?.host;
  const states = records.map(record => typeof record.site === 'string' ? record.site : record.site?.state).filter(Boolean);
  const checked = states.some(state => /^(?:live|parked|for.sale|no(?:-site| site found))/i.test(state));
  const web = site ? 'live site at ' + plain(site) : states.some(state => /live/i.test(state)) ? 'live site'
    : states.some(state => /parked|for sale|for-sale/i.test(state)) ? 'parked'
      : row.traction?.domain ? 'rival listed at ' + plain(row.traction.domain)
        : waitingOn(row, 'websites') ? 'still checking' : states.includes('unknown') ? 'check incomplete'
          : checked ? 'no live site found on checked endings' : 'not checked';
  if (!triage) return 'web: ' + web;
  const android = comp.GooglePlay != null || waitingOn(row, 'Google Play')
    ? ' | Android: ' + appFinding(comp.GooglePlay, row, 'Google Play') : '';
  return 'iOS: ' + appFinding(comp.AppStore, row, 'App Store') + android + ' | web: ' + web;
}

// One selection feeds the receipt lines and the share link: preferred endings, budget, eligibility, verdict and
// confirmed quotes decide the candidates. Each name's pick follows the shared rule (choosePick): the highest-quality
// ending within $60 over 3 years or the person's budget. Local MCP checks use the hosted rule for offers outside
// the default cap. Cheapest is the lowest upfront payment and best value the least paid over 3 years.
// names[i] is the same choice made inside groups[i] alone: its pick, its best value and its taken rows,
// preferred endings first in the user's order (.com first by default).
function receiptSelection(groups, args, triage, eligible = [], local = false) {
  const preferred = args.endings ?? [];
  const budget = args.budget;
  const exact = !triage && groups.length === 1 && groups[0].row.name.includes('.');
  const inScope = record => record.eligible && (!preferred.length || preferred.includes(record.ending))
    && (budget == null || (record.now ?? Infinity) <= budget);
  // An exact lookup reports its one domain and never recommends.
  // Triage recommendations require a name that passed its filters. Availability-only checks still show domain offers.
  const candidates = exact ? [] : groups.flatMap(group => triage && !scoreEligible(group.row) ? [] : group.records
    .filter(record => inScope(record) && (record.state === 'free' || record.priceLabel === 'Shop quote'))
    .map(record => ({ group, record, domain: record.domain, now: record.now ?? null, total: record.total ?? null, buyUrl: record.checkout })));
  const context = group => ({ requested: group.row.name.includes('.') ? [...preferred, group.row.name] : preferred,
    eligible, budget });
  // Across names, every exact domain the person typed counts as asked for.
  const across = { requested: [...preferred, ...groups.map(group => group.row.name).filter(name => name.includes('.'))], eligible, budget };
  // Ties on price go to the better verdict, then the quality order.
  const rank = item => (verdictOrder[item.group.row.verdict] ?? 0) * 1000 + item.record.rank;
  const pickOf = group => {
    const options = candidates.filter(item => item.group === group);
    const rules = context(group);
    return local ? pickDomain(options, { endings: rules.requested, eligible, budget }) : choosePick(options, rules);
  };
  const valueOf = items => lowestTotal(items, rank);
  const picks = groups.flatMap(group => {
    const pick = pickOf(group);
    return pick ? [pick] : [];
  }).sort((a, b) => (triage ? compareScores(a.group.row.score, b.group.row.score) : 0)
    || (verdictOrder[a.group.row.verdict] ?? 0) - (verdictOrder[b.group.row.verdict] ?? 0)
    || comparePicks(a, b, across) || a.record.domain.localeCompare(b.record.domain)).slice(0, triage && args.shortlist ? 8 : 3);
  const order = preferred.length ? preferred : ['com'];
  const takenRank = record => {
    const index = order.indexOf(record.ending);
    return index < 0 ? order.length : index;
  };
  return {
    exact, preferred, budget,
    best: picks[0],
    picks,
    cheapest: lowestUpfront(candidates, rank),
    value: valueOf(candidates),
    names: groups.map(group => {
      const own = candidates.filter(item => item.group === group);
      return { pick: pickOf(group)?.record ?? null, value: valueOf(own)?.record ?? null,
        taken: group.records.filter(record => record.state === 'taken' && (!preferred.length || preferred.includes(record.ending)))
          .sort((a, b) => takenRank(a) - takenRank(b)) };
    }),
  };
}

function checkedOption(record) {
  const term = record.term ?? 1;
  return { domain: record.domain, shop: record.shop, firstYearUsd: record.now == null ? null : record.now / term,
    renewalUsd: record.renew == null ? null : record.renew / term, firstPaymentUsd: record.now, threeYearUsd: record.total,
    minimumYears: term, buyUrl: record.checkout, needsCloudflareDns: Boolean(record.dns) };
}

function localExactPick(records, args, exactDomain) {
  return pickDomain(records.filter(record => record.state === 'free').map(record => ({
    ...checkedOption(record), now: record.now, total: record.total,
  })), { ...args, endings: [exactDomain] });
}

function localCheckSummary(group, args, selection, priceListDate) {
  const { row, records } = group;
  const exactDomain = row.name.includes('.') ? row.name : null;
  const domains = records.map(record => ({
    domain: record.domain, status: record.state === 'free' ? 'available' : record.state === 'taken' ? 'taken' : 'unknown',
    prices: record.state === 'free' && record.now != null ? [checkedOption(record)] : [],
    confirmed: record.priceLabel === 'Shop quote',
  }));
  const pick = exactDomain
    ? localExactPick(records, args, exactDomain)
    : selection.best?.record && checkedOption(selection.best.record);
  const lines = checkLines({ domains, choice: { pick }, query: { name: row.name, exactDomain }, score: row.score }, false, { local: true });
  if (priceListDate) lines.push('Dated list prices in USD before tax · ' + priceListDate);
  const savings = selection.best ? [savingsLine(selection.best.record)].filter(Boolean) : [];
  return { lines: attributed(lines.join('\n'), Boolean(args.purchase || exactDomain)).split('\n'), savings };
}

function summary(groups, args, triage, selection, local = false) {
  const [wanted] = groups;
  const { exact: isExact, preferred, budget, best, picks, cheapest, value } = selection;
  const constraints = [...(!isExact && preferred.length ? [preferred.map(ending => '.' + ending).join(', ') + ' first'] : []),
    ...(budget != null ? ['Up to ' + cash(budget) + ' today'] : [])];
  const target = wanted.records.find(record => record.ending === (preferred[0] ?? 'com')) ?? wanted.records[0];
  const watch = target?.state === 'taken' ? 'Want it anyway? [Watch ' + target.domain + '](' + watchLink(target.domain) + ').' : null;
  if (isExact) {
    const picked = wanted.records[0];
    const hasPrice = picked.now != null || picked.renew != null;
    let price = hasPrice ? ' ' + offerText(picked).slice(picked.domain.length + 1) + '.' : '';
    if (picked.state === 'taken' && picked.renew != null) {
      price = ' Standard list renewal: ' + cash(picked.renew) + (picked.term > 1
        ? ' every ' + picked.term + ' years (' + cash(picked.renew / picked.term) + ' a year)' : ' a year') + priceDate(picked) + '.';
    }
    const overBudget = budget != null && picked.now != null && picked.now > budget && picked.state !== 'taken';
    const intro = picked.domain + ': ' + picked.status.toLowerCase() + '.' + price + (overBudget ? ' Over budget.' : '');
    const step = overBudget ? 'Next: try a cheaper domain.' : picked.checkout
      ? 'Next: [check at ' + plain(picked.shop) + '](' + picked.checkout + ').' : watch ?? 'Next: check another domain.';
    return { lines: [...constraints, intro, ...(args.purchase ? ['This check leaves checkout to you.'] : []), step], savings: [] };
  }
  const reason = evidenceText(wanted.row.reason).replace('David vs Goliath: ', 'Established rival: ');
  const keep = triage ? 'Keep ' + evidenceText(wanted.row.name) + '? ' + plain(wanted.row.verdict) + '. '
    + reason.replaceAll(' · ', '. ') + '.'
    + markScreen(wanted.row, reason) + shortScore(wanted.row)
    + (wanted.row.verdict === 'Avoid' && best ? (best.group.row.verdict === 'No conflict found' ? ' Best available alternative: ' : ' Next name to check: ')
      + plain(best.group.row.name) + '.' : '')
    + (picks.some(item => item.group === wanted) ? '' : ' | ' + signals(wanted, triage)) : null;
  const next = watch ?? (!triage && args.shortlist ? 'Next: screen the best names.' : best ? 'Next: check your pick at the shop.' : 'Next: try another name.');
  const caution = item => item.group.row.verdict === 'Check first' ? ' (Check first)' : '';
  const label = item => offerText(item.record, true) + caution(item);
  const offerLines = picks.map(({ group, record }, index) =>
    (local ? pickLine(checkedOption(record)) + ' ' : (budget != null && index === 0 ? 'Pick: ' : (index + 1) + '. '))
    + offerText(record) + ' (' + plain(record.status.toLowerCase()) + ') | '
    + (triage ? plain(group.row.verdict) + ' |' + (shortScore(group.row) ? shortScore(group.row).slice(0, -1) + ' |' : '')
      + (scoreReasons(group.row).length ? ' ' + scoreReasons(group.row).join('; ') + ' |' : '') + ' ' + marksText(group.row) + ' | ' : '')
    + signals(group, triage));
  const scope = constraints.length ? constraints.join(' | ') + '. ' : '';
  const leadPick = scope && offerLines.length ? scope + offerLines.shift() : null;
  const eligibility = args.eligible?.includes('no') || cheapest?.record.ending === 'no'
    || value?.record.ending === 'no' || preferred.includes('no')
    ? ' .no needs a Norwegian address and organization or personal ID.' : '';
  const waiting = Array.isArray(wanted.row.handles) && wanted.row.handles.filter(row => row.why === 'still checking').map(row => row.platform);
  const handles = !triage || waiting?.length ? null : handleSummary(wanted.row.handles, { ordered: true });
  // One line for every check still running after the first answer; the results page fills in by itself.
  const running = !triage ? [] : [...new Set([...waiting?.length ? ['handles'] : [],
    ...groups.flatMap(group => Array.isArray(group.row.waiting) ? group.row.waiting : [])])];
  const lines = [
    leadPick || (scope ? scope + 'All endings are on the page.' : null),
    keep,
    !triage && shortScore(wanted.row) ? shortScore(wanted.row).trim() : null,
    handles && 'Handles for ' + evidenceText(wanted.row.name) + ': ' + plain(handles) + '.',
    triage && wanted.row.competition?.GooglePlay == null && !waitingOn(wanted.row, 'Google Play')
      ? googlePlayLabel + ' · [' + googlePlayLinkLabel + '](' + playSearchLink(wanted.row.name) + ')' : null,
    running.length ? 'Still checking ' + running.join(', ') + '. The results page updates by itself.' : null,
    ...offerLines,
    // Cheapest upfront and best value over 3 years each get a line only when they are not the pick.
    cheapest?.record !== best?.record || !best ? 'Cheapest: ' + (cheapest ? label(cheapest) : best ? 'needs a shop quote.' : 'none found in scope.') : null,
    value?.record !== best?.record || !best ? 'Best value: ' + (value ? value.record.domain + ', ' + cash(value.record.total) + ' in payments due in 3 years'
      + ' (' + value.record.priceLabel.toLowerCase() + priceDate(value.record) + (value.record.jump ? ', renewal jumps' : '') + ')'
      + caution(value) : 'needs a shop quote') + '.' : null,
    (args.purchase ? 'This check leaves checkout to you. ' : '') + next + eligibility,
  ];
  // Savings are page-only proof for each pick: dated list prices from at least three shops, never a pitch.
  const savings = picks.map(({ record }) => savingsLine(record)).filter(Boolean);
  const shortLines = args.shortlist && triage ? [
    constraints.length ? constraints.join(' | ') + '.' : null,
    ...picks.map(({ group, record }) => (local ? pickLine(checkedOption(record)) : offerText(record) + '.') + ' ' + plain(group.row.verdict) + '.' + shortScore(group.row)
      + (scoreReasons(group.row).length ? ' ' + scoreReasons(group.row).join('. ') + '.' : '')),
    picks.length ? null : 'No available pick in scope.',
    running.length ? 'Still checking ' + running.join(', ') + '. The results page updates.' : null,
    args.purchase ? 'Domain Hound cannot buy or complete checkout.' : null,
  ].filter(Boolean) : null;
  return { lines: lines.filter(Boolean), savings, shortLines };
}

// "lanternbay.xyz: 3 years here (Dynadot): $30.40 vs $36.45 at Spaceship, the median of 3 shops' list prices from 2026-11-25."
// Shown only when the pick is the compared list price and the difference is real and positive.
export function savingsLine(record) {
  const value = record?.savings;
  if (!value || record.priceLabel !== 'List price' || record.state !== 'free' || (record.term ?? 1) !== 1 || value.years !== 3) return null;
  const here = record.now != null && record.renew != null ? Math.round((record.now + 2 * record.renew) * 100) / 100 : null;
  const saved = Math.round((value.median - value.here) * 100) / 100;
  if (here == null || Math.abs(here - value.here) > 0.005 || record.shop !== value.shop || !(value.shops >= 3)
    || !(saved > 0) || Math.abs(saved - value.saved) > 0.005 || value.medianShop === value.shop
    || ![value.checkedFrom, value.checkedTo].every(date => /^\d{4}-\d{2}-\d{2}$/.test(date ?? ''))) return null;
  const dates = value.checkedFrom === value.checkedTo ? value.checkedFrom : value.checkedFrom + ' to ' + value.checkedTo;
  return record.domain + ' at ' + plain(value.shop) + '. 3 years here: ' + cash(value.here) + ' vs ' + cash(value.median) + ' at '
    + plain(value.medianShop) + ', the median of ' + value.shops + ' shops\' list prices from ' + dates + '.';
}

// The trademark part of the kept name's line: offices whose hit the reason already names are not repeated,
// and the strongest EU or Norwegian hit links to its record.
function markScreen(row, reason) {
  const named = ['US', ...offices.map(([office]) => office)].filter(office =>
    typeof row.competition?.[office] === 'string' && reason.includes(evidenceText(row.competition[office])));
  const manual = offices.filter(([office, , name]) => row.competition?.[office] == null && !waitingOn(row, name));
  const rest = marksText(row, [...named, ...manual.map(([office]) => office)]);
  const [hit] = officeMarks(row);
  const link = hit && recordLink(hit.url);
  return (named.length ? ' ' + named.map(office => office === 'NO' ? 'Norway' : office).join(' and ') + ' trademark screen.' : '')
    + (rest ? ' ' + rest + '.' : '') + (link ? ' [' + plain(hit.office) + ' record](' + link + ').' : '')
    + manual.map(([, label, name]) => ' [' + name + '](' + trademarkSearches[label] + "): couldn't check.").join('');
}

function httpsLink(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function details(group) {
  const { row } = group;
  const comp = row.competition ?? {};
  const titleAndLink = value => value && typeof value === 'object'
    ? [plain(value.name ?? value.domain ?? value.title), httpsLink(value.url)] : [plain(value)];
  const ios = Array.isArray(comp.AppStore) ? comp.AppStore : comp.AppStore ? [comp.AppStore] : [];
  const android = Array.isArray(comp.GooglePlay) ? comp.GooglePlay : comp.GooglePlay ? [comp.GooglePlay] : [];
  const matches = [
    ['US marks: ' + (typeof markOf(row) === 'string' ? plain(markOf(row)) : markOf(row) == null ? missing(row, 'USPTO') : 'no match found'), httpsLink(comp.mark)],
    ...officeMarks(row).map(entry => [markLabel(entry), recordLink(entry.url)]),
    // An office without a key, or one that did not answer in full, links to its search.
    ...offices.filter(([office]) => typeof comp[office] !== 'string').map(([office, label, name]) => [
      label + ' marks: ' + (!Object.hasOwn(comp, office) ? "couldn't check"
        : waitingOn(row, name) ? 'still checking'
           : comp[office] == null ? "couldn't check, " + name + ' did not answer in full' : 'no match found'),
      Array.isArray(comp[office]) ? null : trademarkSearches[label]]),
    ['WIPO marks', trademarkSearches.WIPO, 'Search WIPO'],
    ...(row.meaning ? [['Meaning: ' + plain(row.meaning)]] : []),
    ...(comp.AppStore == null ? [['iOS: ' + missing(row, 'App Store')]] : []),
    ...(waitingOn(row, 'Google Play') ? [['Android: still checking']] : []),
    ...ios.map(value => ['iOS: ' + titleAndLink(value)[0], titleAndLink(value)[1]]),
    ...android.map(value => ['Android: ' + titleAndLink(value)[0], titleAndLink(value)[1]]),
    ...[...(comp.sameName?.Norway ?? []), ...(comp.sameName?.EDGAR ?? [])].map(company => [plain(
      [company.name, company.employees != null ? company.employees + ' employees' : null].filter(Boolean).join(', ')), httpsLink(company.url)]),
    ...group.records.filter(row => row.site).map(({ domain, site }) => [
      (site.host ?? domain) + ': ' + (site.state === 'unknown' ? 'site did not answer in time' : plain(site.state ?? site))
        + (site.title ? ', ' + plain(site.title) : ''),
      httpsLink('https://' + (site.host ?? domain))]),
    ['Web search: ' + plain(row.google?.why === 'still checking' ? 'still checking' : row.google?.result ?? 'check incomplete'), httpsLink(row.google?.link)],
    ...(waitingOn(row, 'websites') ? [['Websites on taken endings: still checking']] : []),
    ['iOS search', 'https://apps.apple.com/us/iphone/search?term=' + encodeURIComponent(row.name)],
    [comp.GooglePlay == null ? googlePlayLabel : '', playSearchLink(row.name), googlePlayLinkLabel],
    ...(row.traction ? [[plain(row.traction.rival ?? row.traction.name ?? ''),
      httpsLink(row.traction.domain && 'https://' + row.traction.domain)],
    ...Object.values(row.traction).flat().filter(value => typeof value === 'string').map(value => [plain(value)])] : []),
    ...(typeof row.reason === 'string' ? row.reason.split(' · ').slice(1).map(value => [plain(value)]) : []),
  ];
  return matches.filter(([text, href, linkLabel]) => linkLabel || text && (href || !/ search$/.test(text)));
}

function handleLines(group) {
  const rows = Array.isArray(group.row.handles) ? group.row.handles : [];
  return rows.flatMap(row => {
    const label = row.platform + ' @' + plain(row.handle) + ' · ' + handleLabel(row);
    const detail = row.why === 'still checking' ? ' · still checking' : row.checkedAt ? ' · checked ' + plain(row.checkedAt) : '';
    return [[label + detail, httpsLink(row.link), row.linkLabel], ...(row.variants ?? []).map(variant => [
      row.platform + ' alternative @' + plain(variant.handle) + ' · ' + handleLabel(variant),
      httpsLink(variant.link),
    ])];
  });
}

function trademarkSnapshot(row) {
  const comp = row.competition ?? {};
  const keyed = offices.filter(([office]) => Object.hasOwn(comp, office));
  const found = value => value === true || (typeof value === 'string' && value.length > 0);
  if (found(comp.US) || keyed.some(([office]) => found(comp[office]))) return 'match found';
  if (['USPTO', ...keyed.map(([, , name]) => name)].some(name => waitingOn(row, name))) return 'still checking';
  if (comp.US == null || keyed.some(([office]) => comp[office] == null)) return notScreened(row) ? 'not screened' : 'check incomplete';
  return 'no ' + ['US', ...keyed.map(([, label]) => label)].join(' or ') + ' match';
}

function nameSnapshot({ row, records }) {
  const apps = [row.competition?.AppStore, ...(row.competition?.GooglePlay != null || waitingOn(row, 'Google Play')
    ? [row.competition?.GooglePlay] : [])];
  const open = records.filter(record => record.state === 'free' && record.eligible).length;
  const blocked = records.filter(record => record.state === 'taken').length;
  const handles = Array.isArray(row.handles) ? row.handles : [];
  const taken = handles.filter(handle => handle.state === 'taken').length;
  const absent = handles.filter(handle => handle.state === 'not-found').length;
  const notSeen = handles.filter(handle => handle.state === 'not-seen').length;
  const checks = handles.length - taken - absent - notSeen;
  return [
    'Domains ' + open + ' open' + (blocked ? ', ' + blocked + ' taken' : ''),
    'Trademark ' + trademarkSnapshot(row),
    ...(row.meaning ? ['Meaning: check first'] : []),
    'Apps ' + (apps.some(value => value?.length) ? 'same-name listing' : apps.some(value => value == null)
      ? (waitingOn(row, 'App Store') || waitingOn(row, 'Google Play') ? 'still checking' : notScreened(row) ? 'not screened' : 'check incomplete') : 'no match'),
    'Handles ' + (handles.length ? [taken ? taken + ' taken' : null,
      absent ? absent + ' with no profile found' : null, notSeen ? notSeen + ' with no page found in public archives' : null,
      checks ? "couldn't check " + checks : null].filter(Boolean).join(', ')
      : 'outside top three'),
  ].join(' / ');
}

function handlePriority({ row }, companyType) {
  if (!Array.isArray(row.handles) || !row.handles.length || !Object.hasOwn(handlePriorities, companyType)) return '';
  return 'Handles to secure for this business: ' + handlePriorities[companyType].map(platform => {
    const entry = row.handles.find(handle => handle.platform === platform);
    return platform + ' · ' + (entry?.why === 'still checking' ? 'still checking' : handleLabel(entry));
  }).join(', ') + '.';
}

function evidenceHtml([label, url, linkLabel]) {
  // Evidence can carry an earlier check time. Keep raw ISO values in the machine-readable receipt only.
  const text = label.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, value => priceDay(value) ?? value);
  if (!url) return escape(text);
  return (linkLabel && text ? escape(text) + ' · ' : '') + anchor(linkLabel ?? text, url);
}

function evidenceMarkdown([label, url, linkLabel]) {
  if (!url) return markdown(label);
  return (linkLabel && label ? markdown(label) + ' · ' : '') + '[' + markdown(linkLabel ?? label) + '](' + url + ')';
}
const amountsFor = ({ now, renew }) => [cash(now) ?? 'No price', cash(renew) ?? 'No price'];

function rowNote(row, forHtml = false) {
  const date = value => forHtml && value ? priceDay(value) ?? value : value;
  return [row.status, row.priceLabel, row.term > 1 ? row.term + ' years per payment' : null,
    row.jump ? 'Renewal jumps' : null, row.dns ?? null, !row.eligible ? '.' + row.ending + ' needs ' + eligibilityNeed(row.ending) : null,
    row.source, date(row.checkedAt), row.priceAt ? 'Price checked ' + date(row.priceAt) : null].filter(Boolean).join(' · ');
}

// Who saw what in this lookup, in one short paragraph for the page footer. Every clause matches a request the code makes.
export function disclosure(data, triage) {
  const shop = Array.isArray(data.shopAsked) && data.shopAsked.length
    ? 'This lookup sent ' + data.shopAsked.slice(0, 4).map(plain).join(', ') + ' to a registrar for a quote.'
    : 'No direct shop quote was requested. List prices come from public catalogs.';
  if (!triage) return 'Domain checks use registries and DNS. We may visit candidate sites to verify an answer. ' + shop;
  return 'Domain checks use registries, DNS and candidate sites. Up to five names go to public trademark, app, company and web sources. '
    + 'Up to three go to public handle APIs. Domain Hound uses your brief locally. ' + shop;
}

function hostedWarning(check) {
  const us = check.nameChecks?.trademarks?.us;
  return us?.status === 'exact_match_found' ? '<aside class="trademark-warning"><strong>Exact US trademark match for “'
    + escape(check.query.name) + '”.</strong>' + us.marks.map(mark => '<p>' + (mark.owner
      ? escape(mark.owner + ' filed for ' + (mark.mark || check.query.name) + '. ') : '')
      + (recordLink(mark.url) ? anchor('Read the filing', recordLink(mark.url)) : '') + '</p>').join('') + '</aside>' : '';
}

function hostedPrices(row, pick, budget, pending) {
  if (row.status !== 'available' || row.priceShown === false || row.premium) return [];
  let prices = row.prices ?? [];
  // Generated ideas sometimes carry the comparison (or just the winning quote) on the pick.
  if (!prices.length && pick?.domain === row.domain) {
    prices = pick.prices ?? [];
    if (!prices.length && pick.shop) prices = [{ ...pick, firstYearUsd: pick.firstPaymentUsd / (pick.minimumYears ?? 1) }];
  }
  return prices.map(quote => {
    const shop = shops[shopIds.get(quote.shop)];
    // The hosted catalog sets its own price-only flag. Match both registrar and exact domain.
    const expected = shop && shop.url + encodeURIComponent(row.domain) + (shop.suffix ?? '');
    const canBuy = !pending && !quote.dataOnly && expected && quote.buyUrl === expected
      && (!row.eligibility || row.eligibility.need || row.eligibility.note)
      && (budget == null || quote.firstPaymentUsd <= budget);
    return { ...quote, buyUrl: canBuy ? expected : null };
  });
}

function hostedNameChecks(details, pending, name) {
  // The page refreshes itself; the repeat-call hint is only for the MCP reply.
  if (!details) return paragraph(pending ? 'Name checks are still running.' : 'Name checks could not be completed.');
  const lines = nameCheckLines(details, pending, name);
  const apps = [];
  const handles = [];
  for (const line of lines) {
    const [label, ...finding] = line.split(' · ');
    const group = /^(?:App Store|Google Play|US trademarks)/.test(label) ? apps : handles;
    group.push('<div class="check-line"><dt>' + escape(label) + '</dt><dd>' + paragraph(finding.join(' · ')) + '</dd></div>');
  }
  return '<div class="check-grid"><section><h4>Apps and trademarks</h4><dl>' + apps.join('') + '</dl></section>'
    + (handles.length ? '<section><h4>Handles</h4><dl class="handle-list">' + handles.join('') + '</dl></section>' : '') + '</div>';
}

function hostedCard(check, pending, args, snapshot) {
  const { query, nameChecks, score } = check;
  const alternatives = check[alternativeEndings];
  const seen = new Set(check.domains.map(row => row.domain));
  const rows = [...check.domains, ...(alternatives?.domains ?? []).filter(row => !seen.has(row.domain))];
  const pick = check.choice?.pick ?? alternatives?.choice?.pick;
  const domains = rows.map(row => ({
    ...row, prices: hostedPrices(row, pick, args.budget, pending && !nameChecks),
    note: [row.premium, row.eligibility && (row.eligibility.note || row.eligibility.need || 'Check who can buy this domain.')]
      .filter(Boolean).join(' · '),
  }));
  const sameExact = alternatives?.domains.some(row => row.domain === query.exactDomain && row.status === 'taken');
  return { name: query.exactDomain ?? query.name, exact: query.exactDomain, domains, pick, cap: check.choice?.capUsd ?? alternatives?.choice?.capUsd,
    warning: hostedWarning(check) || (domains.some(row => row.status === 'available') && !['no_exact_match_found', 'exact_match_found'].includes(nameChecks?.trademarks?.us?.status)
      ? '<p class="trademark-pending">' + (pending ? 'Checking US trademarks…' : 'US trademark: couldn’t check.') + '</p>' : ''),
    checks: hostedNameChecks(nameChecks, pending, query.name),
    score: scoreText({ score }), reasons: score?.reasons, priceDate: alternatives?.priceSnapshot?.checkedAt ?? check.priceSnapshot?.checkedAt ?? snapshot,
    share: (sameExact && publicShare(alternatives.share?.url)) || publicShare(check.share?.url), complete: alternatives?.complete ?? check.complete, alternativesFailed: alternatives === null };
}

function localCard(group, pick, data, args, catalog) {
  const { row, records } = group;
  const exact = row.name.includes('.') ? row.name : null;
  if (!data.pending && data.source === 'local' && data.names.length === 1 && exact && !pick && args.budget == null && !args.endings && !args.confirm
      && !row.verdict) pick = localExactPick(records, args, exact);
  const domains = records.map(record => {
    const available = record.state === 'free' || (record.priceLabel === 'Shop quote' && record.state !== 'taken');
    const quote = checkedOption(record);
    const prices = available && (record.now != null || record.renew != null) ? [{ ...quote, checkedAt: record.priceAt }] : [];
    if (prices.length && data.source === 'local' && record.priceLabel === 'List price') {
      for (const item of datedListPrices(catalog, record.ending, new Date(data.checkedAt ?? Date.now()))) {
        if (item.shop === quote.shop) continue;
        const costs = termCosts(record.ending, item.firstYear, item.renewal);
        prices.push({ shop: item.shop, firstYearUsd: item.firstYear, renewalUsd: item.renewal,
          firstPaymentUsd: costs.firstPayment, renewalPaymentUsd: costs.renewalPayment, threeYearUsd: costs.threeYear,
          minimumYears: costs.minimumYears, checkedAt: item.checkedAt, buyUrl: shopSearchUrl(item.id, record.domain) });
      }
    }
    for (const price of prices) {
      if (!record.eligible || args.budget != null && (price.firstPaymentUsd ?? Infinity) > args.budget
        || !safeLink(price.buyUrl, record.domain) || price.buyUrl !== shopSearchUrl(shopIds.get(price.shop), record.domain)) price.buyUrl = null;
    }
    return { domain: record.domain, prices, confirmed: record.priceLabel === 'Shop quote', status: available ? 'available' : record.state === 'taken' ? 'taken' : 'unknown',
      note: [record.status, record.priceLabel, !record.eligible && '.' + record.ending + ' needs ' + eligibilityNeed(record.ending)]
        .filter(Boolean).join(' · ') };
  });
  const checks = [...(row.verdict ? [paragraph(plain(row.verdict) + '. ' + evidenceText(row.reason)), paragraph(nameSnapshot(group)),
    ...details(group).map(line => '<p>' + evidenceHtml(line) + '</p>')] : []),
    ...[handlePriority(group, args.companyType)].filter(Boolean).map(paragraph),
    ...(row.handles?.length ? ['<h4>Handles</h4>', ...handleLines(group).map(line => '<p>' + evidenceHtml(line) + '</p>')] : []),
    ...(row.verdict && !row.handles?.length ? ['<p>Handles: checked for the top three names.</p>'] : [])].join('');
  const rows = records.map(record => {
    const checkShop = record.state === 'check' && record.checkout && (args.budget == null || (record.now ?? Infinity) <= args.budget);
    return '<tr><th scope="row"><code>' + escape(record.domain) + '</code><small>' + escape(rowNote(record, true))
      + (checkShop ? ' · ' + anchor('Check at ' + record.shop, record.checkout) : '') + '</small></th>'
      + amountsFor(record).map(value => '<td>' + escape(value) + '</td>').join('') + '</tr>';
  });
  const evidence = '<h4>Registry and shop evidence</h4><table class="shop-table evidence-table"><thead><tr>'
    + '<th>Ending</th><th>Upfront</th><th>Renewal</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>';
  return { local: true, name: row.name, exact, domains, pick, priceDate: data.priceListDate, score: scoreText(row), reasons: scoreReasons(row), checks: checks + evidence,
    warning: trademarkSnapshot(row) === 'match found' ? '<aside class="trademark-warning"><strong>Trademark match for “'
      + escape(row.name) + '”.</strong>' + paragraph(marksText(row)) + '</aside>' : '' };
}

function render(groups, lines, checkedAt, coverage, watch, companyType, { data, cards, savings, note, refresh, shareFacts, hiddenWarnings }) {
  const shared = publicShare(data.generation?.share?.url) || (cards.length === 1 && cards[0].share)
    || shareUrl(groups, checkedAt, shareFacts);
  const shareLabel = groups.length > 5 ? 'Share first five names' : 'Share';
  const sources = watch?.source ? 'Registry: ' + String(watch.source).toUpperCase() :
    Object.entries(coverage ?? {}).map(([name, count]) => name + ' ' + count + '% answered').join(' · ');
  const comparison = groups.length ? lines.filter(line => /^(?:Cheapest|Best value):/.test(line)) : [];
  const html = renderCards({ data, cards, checkedAt, shared, shareLabel, watch, lines, savings, note, sources,
    comparison, refresh, hiddenWarnings });
  const md = ['# ' + (watch ? 'Domain watch' : 'Domain results'), '', 'Domain Hound · ' + checkedAt, '', ...lines, ...(savings.length ? ['', ...savings] : []), '',
    ...groups.flatMap(group => ['## ' + markdown(group.row.name), '',
      ...(group.row.verdict ? [markdown(group.row.verdict + '. ' + group.row.reason), markdown(nameSnapshot(group)), ''] : []),
      ...(scoreText(group.row) ? [markdown(scoreText(group.row)), ...scoreReasons(group.row).map(line => '- ' + markdown(line)), ''] : []),
      '| Ending | Today (USD) | Renewal (USD) | Evidence | Shop |', '| --- | --- | --- | --- | --- |',
      ...group.records.map(record => '| ' + [record.domain, ...amountsFor(record), markdown(rowNote(record)),
        record.checkout ? '[' + markdown(record.shop ?? 'Check at shop') + '](' + record.checkout + ')' : ''].join(' | ') + ' |'),
      '', ...(group.row.verdict ? details(group).map(line => '- ' + evidenceMarkdown(line)) : []),
      ...(handleLines(group).length ? ['', '### Handles', '', ...(handlePriority(group, companyType) ? [markdown(handlePriority(group, companyType)), ''] : []),
        ...handleLines(group).map(line => '- ' + evidenceMarkdown(line))] : []), '']),
    ...(sources ? [markdown(sources), ''] : []), ...(note ? [markdown(note), ''] : []), 'You hold the leash.', ''].join('\n');
  return { html, md };
}

async function writePrivate(filename, content) {
  const temporary = filename + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function prune(directory, current) {
  const owned = /^(?:\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z0-9-]+-[a-f0-9]{8}\.(?:html|md)|session-[a-f0-9]{8}\.html)$/;
  const files = (await readdir(directory)).filter(file => owned.test(file));
  const groups = new Map();
  for (const file of files) {
    const base = file.slice(0, file.lastIndexOf('.'));
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(file);
  }
  const ranked = await Promise.all([...groups].map(async ([base, entries]) => ({ base, entries,
    at: (await stat(join(directory, entries[0])).catch(() => null))?.mtimeMs ?? 0,
  })));
  ranked.sort((a, b) => Number(b.base === current) - Number(a.base === current) || b.at - a.at || b.base.localeCompare(a.base));
  let slots = 20;
  for (const { base, entries, at } of ranked) {
    // A second MCP process may be committing a twin. Leave a recent incomplete pair alone.
    if (!base.startsWith('session-') && entries.length === 1 && Date.now() - at < 60_000) continue;
    if (entries.length <= slots) {
      slots -= entries.length;
      continue;
    }
    await Promise.all(entries.map(file => unlink(join(directory, file)).catch(() => {})));
  }
}

const ownedPage = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z0-9-]+-[a-f0-9]{8}\.html$/;
// The page name a lookup already wrote, so a later update keeps the same URL. Anything else gets a new page.
function reusedBase(reuse, directory) {
  if (typeof reuse !== 'string') return null;
  try {
    const path = fileURLToPath(reuse);
    return dirname(path) === resolve(directory) && ownedPage.test(basename(path)) ? basename(path).slice(0, -'.html'.length) : null;
  } catch {
    return null;
  }
}

export function resultsLine(url) {
  const path = fileURLToPath(url).replaceAll('\\', '/').replace(/[\r\n<>]/g, encodeURIComponent);
  return 'Results page: [Open results](' + (/[\s()]/.test(path) ? '<' + path + '>' : path) + ')';
}

// Reuse keeps the same result URL as background checks update the files.
export function resultPages({ env = process.env,
  directory = env.DOMAIN_HOUND_RESULTS_DIR || join(homedir(), '.domain-hound', 'results') } = {}) {
  let writes = Promise.resolve();
  return (data, args, { triage = false, watch = false, reuse = null, refresh = false } = {}) => {
    const work = writes.then(async () => {
      const at = data.checkedAt ?? new Date().toISOString();
      let groups = watch || data.hosted ? [] : resultGroups(data, args.eligible, args.endings);
      if (!watch && !triage && !data.hosted && !data.pending) groups = groups.map(group => availabilityScore(group, args));
      if (triage && args.shortlist && !data.pending && groups.some(({ row }) => row.score != null)) {
        groups = groups.filter(({ row }) => Number.isInteger(row.score?.value) && scoreEligible(row))
          .sort((a, b) => compareScores(a.row.score, b.row.score)).slice(0, 8);
      }
      const local = !watch && data.source === 'local';
      const selection = receiptSelection(groups, args, triage, args.eligible ?? data.eligible ?? [], local);
      const { lines, savings, shortLines } = data.hosted ? { lines: data.lines, savings: [] } : watch ? { lines: data.say.split('\n'), savings: [] } : data.pending ? { lines: [
        ...(data.failed ? ['Some checks did not finish. Registry answers received are on the page.']
          : ['Still checking trademark, app and web sources. Registry answers so far are on the page.', 'The results page updates by itself.']),
        ...(args.purchase ? ['This check leaves checkout to you.'] : []),
      ], savings: [] } : local && !triage && groups.length === 1 && !args.confirm && !args.endings && args.budget == null
        ? localCheckSummary(groups[0], args, selection, data.priceListDate)
        : groups.length ? summary(groups, args, triage, selection, local)
        : { lines: ['No names passed the checks.'], savings: [] };
      // Before the verdicts arrive the receipt recommends nothing, so the link carries only taken rows and jumps.
      const shareFacts = selection.names.map(name => data.pending ? { taken: name.taken } : name);
      const title = watch ? data.domain : groups[0]?.row.name ?? data.names?.[0]?.name;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // If a caller points us at a shared directory, don't expose the searched name in its listing.
      const privateListing = process.platform === 'win32' || ((await stat(directory)).mode & 0o077) === 0;
      const slug = (privateListing && normalizeName(String(title).split('.')[0]) || 'results').slice(0, 30);
      const kept = reusedBase(reuse, directory);
      const base = kept ?? new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + slug + '-' + randomUUID().slice(0, 8);
      const filename = resolve(directory, base + '.html');
      const catalog = local && groups.length ? await loadCachedCatalog().catch(() => null) : null;
      const shown = [...visibleChecks(data.checks ?? [], args, data.generation)];
      if (data.generation?.stage === 'final') shown.sort((a, b) => (b.score?.value ?? -1) - (a.score?.value ?? -1));
      const hiddenWarnings = (data.checks ?? []).filter(check => !shown.includes(check)).map(hostedWarning).join('');
      const cards = data.hosted ? shown.map(check => hostedCard(check, data.pending, args, data.generation?.priceSnapshot?.checkedAt))
        : groups.map((group, index) => localCard(group, data.pending ? null : selection.names[index].pick, data, args, catalog));
      const page = render(groups, local ? [localCheckNotice, ...lines] : lines, at, data.sources, watch ? data : null, args.companyType,
        { data, cards, savings, hiddenWarnings, note: watch ? '' : data.hosted ? 'Domain Hound’s hosted service checks registries, prices and public name sources.' : disclosure(data, triage),
          refresh: Boolean(refresh), shareFacts });
      const markdownPath = resolve(directory, base + '.md');
      await writePrivate(markdownPath, page.md);
      try {
        await writePrivate(filename, page.html);
      } catch (error) {
        await unlink(markdownPath).catch(() => {});
        throw error;
      }
      await prune(directory, base).catch(() => {});
      const url = pathToFileURL(filename).href.replaceAll('(', '%28').replaceAll(')', '%29');
      // The link uses the client's local-file Markdown form. Keep the file URI for structured consumers.
      const handles = data.hosted ? data.checks.flatMap(check => check.nameChecks?.handles ?? [])
        : groups.flatMap(group => group.row.handles ?? []);
      const hints = [...new Set(handles.map(linkedInSearchHint).filter(Boolean))];
      const say = [...(local ? [localCheckNotice] : []), resultsLine(url), ...(shortLines ?? lines), ...hints].join('\n');
      if (data.hosted) {
        const { hosted, lines, ...structured } = data;
        return { display: say, say, ...structured, resultPage: url };
      }
      if (triage && args.shortlist) return { display: say, say, ...(local && { source: 'local' }), checkedAt: at, resultPage: url };
      const { receiptDetails, say: priorSay, display: priorDisplay, ...structured } = data;
      if (triage && receiptDetails) structured.names = structured.names.map((row, index) => ({
        ...row, ...(receiptDetails[index]?.score && { score: receiptDetails[index].score }),
        details: { ...row.details, sites: receiptDetails[index]?.details?.sites ?? {} },
      }));
      if (!watch && !triage) structured.names = structured.names.map((row, index) => ({
        ...row, ...(groups[index].row.score && { score: groups[index].row.score }),
      }));
      return { display: say, say, ...structured, checkedAt: at, resultPage: url };
    });
    writes = work.catch(() => {});
    return work;
  };
}
