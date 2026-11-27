import { attributed, md } from './display.mjs';
import { canRecommend, choosePick, normalizeName } from './clis/domain-check/name-search.mjs';
import { compareScores, scoreEligible, scoreHandles, scoreName } from './clis/domain-check/name-score.mjs';
import { relevantClasses } from './clis/domain-check/triage-sources.mjs';
import { handleLabel } from './clis/domain-check/handles.mjs';
import { googlePlayLinkLabel, playSearchLink } from './clis/domain-check/google-play.mjs';

const money = value => Number.isFinite(value) ? '$' + value.toFixed(2) : 'price at shop';
const platforms = ['LinkedIn', 'X', 'Instagram', 'TikTok', 'YouTube', 'Threads', 'Facebook', 'Reddit', 'Twitch', 'GitHub'];

function link(label, value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) {
      return '[' + md(label) + '](' + url.href.replaceAll('(', '%28').replaceAll(')', '%29') + ')';
    }
  } catch { /* A source without a public link still has a label. */ }
  return md(label);
}

export const usTrademark = check => check.trademarks?.us ?? check.nameChecks?.trademarks?.us;

const usptoSearch = 'https://tmsearch.uspto.gov/';

function usptoLink(label, value) {
  try {
    const url = new URL(value);
    if (url.origin === 'https://tsdr.uspto.gov' && !url.username && !url.password) return link(label, url.href);
  } catch { /* The trademark search is available when the filing link is missing. */ }
  return link(label, usptoSearch);
}

export function trademarkLines(check, pending, markLimit = 10) {
  const us = usTrademark(check);
  if (us?.status === 'pending' || (!us && pending)) return ['Trademark check still running.'];
  if (us?.status === 'no_exact_match_found') return ['US trademark: no exact live match found.'];
  if (us?.status !== 'exact_match_found') return ['US trademark: couldn’t check. ' + link('Search US trademarks', usptoSearch)];
  const marks = us.marks?.length ? us.marks.slice(0, markLimit) : [{ mark: check.query.name }];
  return [...marks.map(mark => 'Heads-up: ' + usptoLink(mark.mark || check.query.name, mark.url)
    + ' has an exact live US trademark match' + (mark.owner ? ' (' + md(mark.owner) + ')' : '') + '.'),
  'Search aid, not legal advice.'];
}

export function domainAnswer({ domains, query, choice }) {
  const exact = domains.find(row => row.domain === query.exactDomain);
  const available = domains.find(row => row.status === 'available');
  if (query.exactDomain) {
    const ending = exact?.reason === 'reserved' ? ' is reserved by the registry.'
      : ['available', 'taken'].includes(exact?.status) ? ' is ' + exact.status + '.' : ' could not be confirmed.';
    return md(query.exactDomain) + ending;
  }
  if (choice?.pick) return pickLine(choice.pick);
  if (available) return md(available.domain) + ' is available.';
  return md(query.name) + (domains.length && domains.every(row => row.status === 'taken')
    ? ' · All checked endings are taken.' : ' · No available endings confirmed.');
}

export function appNameLines(check, pending, withLinks = true) {
  const app = check.appStore ?? check.nameChecks?.appStore;
  const play = check.googlePlay ?? check.nameChecks?.googlePlay;
  const outcome = row => {
    if (['taken', 'exact_match_found'].includes(row?.status)) return 'Taken';
    if (['not-found', 'no_match_found'].includes(row?.status)) return 'No matching app found';
    return row?.status === 'pending' || (!row && pending) ? 'Still checking' : 'Couldn’t check';
  };
  const match = withLinks && app?.matches?.[0];
  return ['App Store (iOS) · ' + outcome(app) + (match ? ' · ' + link(match.name, match.url) : ''),
    'Google Play (Android) · ' + outcome(play) + (withLinks ? ' · '
      + link(googlePlayLinkLabel, play?.link ?? playSearchLink(check.query.name)) : '')];
}

export function hostedIntroLines(check, pending, markLimit = 10, withAppLinks = true) {
  return [domainAnswer(check), ...appNameLines(check, pending, withAppLinks), ...trademarkLines(check, pending, markLimit)];
}

export function nameCheckLines(details, pending) {
  if (!details) return [pending ? 'Name checks are still running. Call the same tool with the same input to collect them.' : 'Name checks could not be completed.'];
  return platforms.flatMap(platform => {
    const handle = details.handles?.find(row => row.platform === platform);
    if (!handle) return [];
    const label = handleLabel(handle);
    return platform + ' · ' + (handle.linkLabel ? label + ' · ' + link(handle.linkLabel, handle.link) : link(label, handle.link));
  });
}

function priceLine(offer, cheapest) {
  const term = offer.minimumYears > 1 ? ' · ' + money(offer.firstPaymentUsd) + ' upfront for ' + offer.minimumYears + ' years' : '';
  return link(offer.shop, offer.buyUrl) + (cheapest ? ' (cheapest over three years)' : '') + ' · '
    + money(offer.firstYearUsd) + ' first year · ' + money(offer.renewalUsd) + ' yearly renewal · '
    + money(offer.threeYearUsd) + ' over three years' + term
    + (offer.needsCloudflareDns ? ' · requires Cloudflare DNS' : '')
    + (offer.checkedAt && offer.source ? ' · ' + link(offer.checkedAt.slice(0, 10), offer.source) : '');
}

export function pickLine(pick) {
  return 'The Hound’s pick is ' + md(pick.domain) + ' at ' + md(pick.shop) + ' for ' + money(pick.threeYearUsd) + ' over three years.';
}

export function checkLines(check, pending, { local = false, includePick = true } = {}) {
  const { domains, choice, nameChecks, score } = check;
  const pick = choice?.pick;
  const taken = domains.filter(row => row.status === 'taken').map(row => row.domain);
  const reserved = domains.filter(row => row.reason === 'reserved');
  const unknown = domains.filter(row => row.status === 'unknown' && row.reason !== 'reserved');
  return [
    ...(score?.filtered ? [md(check.query.name) + ' · ' + md(score.filtered)]
      : Number.isInteger(score?.value) ? [md(check.query.name) + ' · Name score ' + score.value + '/100 · ' + md(score.band),
        ...(score.reasons ?? []).map(md)] : []),
    ...(pick && includePick ? [pickLine(pick)] : []),
    ...domains.filter(row => row.status === 'available').flatMap(row => [
      'Available · ' + md(row.domain),
      ...(row.prices?.length ? row.prices.map((offer, index) => priceLine(offer, !local && index === 0)) : ['Check the price at the shop.']),
      ...(local && row.confirmed ? ['Confirmed at the shop.'] : []),
    ]),
    ...(taken.length ? ['Taken · ' + taken.map(md).join(', ') + '. '
      + link('Watch', 'https://domainhound.dev/watch/?domain=' + encodeURIComponent(taken[0]))
      + ' · Draft an offer · Try a new name'] : []),
    ...(reserved.length ? ['Reserved by the registry · ' + reserved.map(row => md(row.domain)).join(', ') + '.'] : []),
    ...(unknown.length ? ['Could not confirm ' + (domains.length === 1 ? md(unknown[0].domain)
      : unknown.length + (unknown.length === 1 ? ' ending' : ' endings')) + '.'] : []),
    ...(local ? [] : nameCheckLines(nameChecks, pending)),
  ];
}

export function pickDomain(options, { endings, eligible, budget } = {}) {
  return choosePick(options.filter(option => option.buyUrl), {
    requested: endings, eligible, budget, allowOverCap: budget != null,
  }) ?? null;
}

function preferredPick(check, args) {
  if (!args.endings?.length && args.budget == null && !args.eligible?.length && !args.country) return check.choice.pick;
  if (check.query.exactDomain) return check.choice.pick;
  const options = check.domains.filter(row => row.status === 'available' && canRecommend(row.ending, args.eligible)
    && (!args.endings?.length || args.endings.includes(row.ending))).flatMap(row =>
    row.prices.filter(offer => args.budget == null || offer.firstPaymentUsd <= args.budget).map(offer => ({
      ...offer, domain: row.domain, now: offer.firstPaymentUsd, total: offer.threeYearUsd,
    })));
  return pickDomain(options, args);
}

export function hostedChecks(checks, args, triage = false) {
  const classes = relevantClasses(args.category);
  const candidates = new Map(Object.entries(args.candidates ?? {}).map(([name, value]) => [normalizeName(name), value]));
  return checks.map(check => {
    const pick = preferredPick(check, args);
    if (!triage) return pick === check.choice.pick ? check : { ...check, choice: { ...check.choice, pick } };
    const us = usTrademark(check);
    const score = scoreName({
      name: check.query.name,
      candidate: candidates.get(normalizeName(check.query.name)),
      domains: check.domains.filter(row => row.status === 'available' && canRecommend(row.ending, args.eligible)
        && (!args.endings?.length || args.endings.includes(row.ending)))
        .map(row => ({ ending: row.ending, total: row.prices[0]?.threeYearUsd, registry: true })),
      marks: { us: ['exact_match_found', 'no_exact_match_found'].includes(us?.status) ? 'ok' : 'unknown',
        list: us?.marks.map(mark => ({ tier: 'Exact', live: true,
          sameClass: mark.classes?.length ? mark.classes.some(value => classes.includes(value)) : null })) },
      apps: { list: check.nameChecks?.appStore?.matches },
      handles: scoreHandles(check.nameChecks?.handles),
    });
    return { ...check, score, choice: { ...check.choice, pick: scoreEligible({ score }) ? pick : null } };
  });
}

export function generatedChecks(generation) {
  return generation.names.map(entry => ({
    query: { name: entry.name, exactDomain: null },
    why: entry.why,
    domains: entry.domains,
    choice: { pick: entry.domain },
    nameChecks: entry.nameChecks,
    score: { ...entry.score, value: entry.score?.total },
    share: entry.share,
  }));
}

export function visibleChecks(checks, args, generation) {
  return !generation && args.shortlist && checks.some(check => check.score)
    ? checks.filter(check => scoreEligible(check)).sort((a, b) => compareScores(a.score, b.score)).slice(0, 8) : checks;
}

export function hostedResult(checks, args, generation, { pending = false, failed = false, checkedAt } = {}) {
  const shown = visibleChecks(checks, args, generation);
  const warnings = checks.filter(check => !shown.includes(check) && usTrademark(check)?.status === 'exact_match_found')
    .flatMap(check => trademarkLines(check, pending));
  const lines = [
    ...(shown.length ? shown.flatMap((check, index) => [
      ...(generation && !check.domains.length ? [md(check.query.name)] : hostedIntroLines(check, pending)),
      ...checkLines(check, pending, { includePick: false }),
      ...(index < shown.length - 1 ? [''] : []),
    ]) : [pending && generation?.suggestions?.length
      ? 'Checking domains for ' + generation.suggestions.map(entry => md(entry.name)).join(', ') + '.'
      : pending ? 'Still checking names and domains.' : 'No names passed the checks.']),
    ...warnings,
    ...(pending ? ['The results page updates when the remaining checks finish.'] : []),
    ...(failed ? ['The remaining checks did not finish.'] : []),
    ...(generation?.question && !pending ? [md(generation.question)] : []),
    ...((generation?.priceSnapshot ?? checks[0]?.priceSnapshot)?.checkedAt
      ? ['Dated list prices in USD before tax · ' + md((generation?.priceSnapshot ?? checks[0].priceSnapshot).checkedAt.slice(0, 10))] : []),
  ];
  const names = checks.map(check => {
    const key = row => row.variant ? row.domain : row.ending;
    const rows = status => check.domains.filter(row => row.status === status);
    return { name: check.query.exactDomain ?? check.query.name,
      available: rows('available').map(key), free: rows('available').map(row => ({ d: key(row) })),
      taken: rows('taken').map(key),
      reserved: rows('unknown').filter(row => row.reason === 'reserved').map(key),
      shop_check: rows('unknown').filter(row => row.reason !== 'reserved').map(key),
      ...(check.score && { score: check.score }) };
  });
  const { details, ...generationResult } = generation ?? {};
  return { hosted: true, checks, names, ...(generation && { generation: generationResult }), ...(pending && { pending: true }),
    complete: generation ? !pending && !failed && generation.complete : !pending && checks.every(check => check.complete),
    checkedAt: checkedAt ?? generation?.checkedAt ?? checks[0]?.checkedAt ?? new Date().toISOString(),
    lines: attributed(lines.join('\n'), Boolean(args.purchase || (checks.length === 1 && checks[0].query.exactDomain))).split('\n') };
}
