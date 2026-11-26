import { attributed, md } from './display.mjs';
import { canRecommend, choosePick, normalizeName } from './clis/domain-check/name-search.mjs';
import { compareScores, scoreEligible, scoreHandles, scoreName } from './clis/domain-check/name-score.mjs';
import { relevantClasses } from './clis/domain-check/triage-sources.mjs';
import { handleLabel, handleStates, linkedInLabel, linkedInSearch } from './clis/domain-check/handles.mjs';
import { googlePlayLabel, googlePlayLinkLabel, playSearchLink } from './clis/domain-check/google-play.mjs';

const money = value => Number.isFinite(value) ? '$' + value.toFixed(2) : 'price at shop';
const platforms = ['LinkedIn', 'X', 'Instagram', 'TikTok', 'YouTube', 'Threads', 'GitHub'];

function link(label, value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) {
      return '[' + md(label) + '](' + url.href.replaceAll('(', '%28').replaceAll(')', '%29') + ')';
    }
  } catch { /* A source without a public link still has a label. */ }
  return md(label);
}

function warning(check) {
  const us = check.nameChecks?.trademarks?.us;
  if (us?.status !== 'exact_match_found') return [];
  if (!us.marks.length) return ['US trademark warning for ' + md(check.query.name) + '. An exact live match was found.'];
  return us.marks.map(mark => 'US trademark warning for ' + link(mark.mark, mark.url ?? us.searchUrl)
    + (mark.owner ? '. ' + md(mark.owner) + (mark.status === 'applied' ? ' applied for this mark' : ' is listed as the owner') : '')
    + '. The match applies to the name across all endings.');
}

function nameCheckLines(details, pending, name) {
  if (!details) return [pending ? 'Name checks are still running.' : 'Name checks could not be completed.'];
  const { appStore: app, googlePlay, trademarks, handles } = details;
  const appText = app.status === 'taken' ? 'Matching app found' : app.status === 'no_match_found' ? 'No matching app found'
    : app.reason === 'rate-limited' ? 'Search rate-limited' : 'Could not complete the search';
  const apps = app.matches?.map(match => link(match.name, match.url)).join(', ');
  const us = trademarks?.us;
  const markText = us?.status === 'no_exact_match_found' ? 'No exact live match found' : us?.status === 'unknown'
    ? "Couldn't check · " + link('Search US trademarks', us.searchUrl) : null;
  return [
    ...(markText ? ['US trademarks · ' + markText] : []),
    'App Store · ' + appText + (apps ? ' · ' + apps : ''),
    (googlePlay.why === 'no public search' ? googlePlayLabel : 'Google Play · ' + (handleStates[googlePlay.status] ?? handleStates.unknown))
      + ' · ' + link(googlePlayLinkLabel, googlePlay.link ?? playSearchLink(name)),
    ...platforms.map(platform => {
      const handle = handles.find(row => row.platform === platform);
      if (platform === 'LinkedIn') return linkedInLabel + ' · ' + link('Search LinkedIn', linkedInSearch(name));
      return platform + ' · ' + link(handleLabel(handle), handle?.link);
    }),
  ];
}

function priceLine(offer, cheapest) {
  const term = offer.minimumYears > 1 ? ' · ' + money(offer.firstPaymentUsd) + ' upfront for ' + offer.minimumYears + ' years' : '';
  return link(offer.shop, offer.buyUrl) + (cheapest ? ' (cheapest over three years)' : '') + ' · '
    + money(offer.firstYearUsd) + ' first year · ' + money(offer.renewalUsd) + ' yearly renewal · '
    + money(offer.threeYearUsd) + ' over three years' + term
    + (offer.needsCloudflareDns ? ' · requires Cloudflare DNS' : '');
}

function checkLines(check, pending) {
  const { domains, choice, nameChecks, score } = check;
  const pick = choice?.pick;
  const taken = domains.filter(row => row.status === 'taken').map(row => row.domain);
  const unknown = domains.filter(row => row.status === 'unknown');
  return [
    ...(score?.filtered ? [md(check.query.name) + ' · ' + md(score.filtered)]
      : Number.isInteger(score?.value) ? [md(check.query.name) + ' · Name score ' + score.value + '/100 · ' + md(score.band),
        ...(score.reasons ?? []).map(md)] : []),
    ...(pick ? ['The Hound’s pick is ' + md(pick.domain) + ' at ' + md(pick.shop) + ' for ' + money(pick.threeYearUsd) + ' over three years.'] : []),
    ...domains.filter(row => row.status === 'available').flatMap(row => [
      'Available · ' + md(row.domain),
      ...(row.prices?.length ? row.prices.map((offer, index) => priceLine(offer, index === 0)) : ['Check the price at the shop.']),
    ]),
    ...nameCheckLines(nameChecks, pending, check.query.name),
    ...(taken.length ? ['Taken · ' + taken.map(md).join(', ') + '. '
      + link('Watch', 'https://domainhound.dev/watch/?domain=' + encodeURIComponent(taken[0]))
      + ' · Draft an offer · Try a new name'] : []),
    ...(unknown.length ? ['Could not confirm ' + (domains.length === 1 ? md(unknown[0].domain)
      : unknown.length + (unknown.length === 1 ? ' ending' : ' endings')) + '.'] : []),
  ];
}

function preferredPick(check, args) {
  if (!args.endings?.length && args.budget == null && !args.eligible?.length && !args.country) return check.choice.pick;
  if (check.query.exactDomain) return check.choice.pick;
  const options = check.domains.filter(row => row.status === 'available' && canRecommend(row.ending, args.eligible)
    && (!args.endings?.length || args.endings.includes(row.ending))).flatMap(row =>
    row.prices.filter(offer => args.budget == null || offer.firstPaymentUsd <= args.budget).map(offer => ({
      ...offer, domain: row.domain, now: offer.firstPaymentUsd, total: offer.threeYearUsd,
    })));
  return choosePick(options, { requested: args.endings, eligible: args.eligible, budget: args.budget }) ?? null;
}

export function hostedChecks(checks, args, triage = false) {
  const classes = relevantClasses(args.category);
  const candidates = new Map(Object.entries(args.candidates ?? {}).map(([name, value]) => [normalizeName(name), value]));
  return checks.map(check => {
    const pick = preferredPick(check, args);
    if (!triage) return pick === check.choice.pick ? check : { ...check, choice: { ...check.choice, pick } };
    const us = check.nameChecks?.trademarks?.us;
    const score = scoreName({
      name: check.query.name,
      candidate: candidates.get(normalizeName(check.query.name)),
      domains: check.domains.filter(row => row.status === 'available' && canRecommend(row.ending, args.eligible)
        && (!args.endings?.length || args.endings.includes(row.ending)))
        .map(row => ({ ending: row.ending, total: row.prices[0]?.threeYearUsd, registry: true })),
      marks: { us: us?.status && us.status !== 'unknown' ? 'ok' : 'unknown',
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
    domains: entry.domains,
    choice: { pick: entry.domain },
    nameChecks: entry.nameChecks,
    score: { ...entry.score, value: entry.score?.total },
    share: entry.share,
  }));
}

export function hostedResult(checks, args, generation, { pending = false, failed = false, checkedAt } = {}) {
  const shown = !generation && args.shortlist && checks.some(check => check.score)
    ? checks.filter(check => scoreEligible(check)).sort((a, b) => compareScores(a.score, b.score)).slice(0, 8) : checks;
  const lines = [
    ...checks.flatMap(warning),
    ...(shown.length ? shown.flatMap((check, index) => [
      ...(shown.length > 1 ? [md(check.query.exactDomain ?? check.query.name)] : []),
      ...checkLines(check, pending),
      ...(index < shown.length - 1 ? [''] : []),
    ]) : [pending ? 'Still checking names and domains.' : 'No names passed the checks.']),
    ...(pending ? ['The results page updates when the remaining checks finish.'] : []),
    ...(failed ? ['The remaining checks did not finish.'] : []),
    ...(generation?.question && !pending ? [md(generation.question)] : []),
    ...((generation?.priceSnapshot ?? checks[0]?.priceSnapshot)?.checkedAt
      ? ['Dated list prices in USD before tax · ' + md((generation?.priceSnapshot ?? checks[0].priceSnapshot).checkedAt.slice(0, 10))] : []),
  ];
  const names = checks.map(check => {
    const rows = status => check.domains.filter(row => row.status === status);
    return { name: check.query.exactDomain ?? check.query.name,
      available: rows('available').map(row => row.ending), free: rows('available').map(row => ({ d: row.ending })),
      taken: rows('taken').map(row => row.ending), shop_check: rows('unknown').map(row => row.ending),
      ...(check.score && { score: check.score }) };
  });
  const { details, ...generationResult } = generation ?? {};
  return { hosted: true, checks, names, ...(generation && { generation: generationResult }), ...(pending && { pending: true }),
    complete: generation ? !pending && !failed && generation.complete : checks.every(check => check.complete),
    checkedAt: checkedAt ?? generation?.checkedAt ?? checks[0]?.checkedAt ?? new Date().toISOString(),
    lines: attributed(lines.join('\n'), Boolean(args.purchase || (checks.length === 1 && checks[0].query.exactDomain))).split('\n') };
}
