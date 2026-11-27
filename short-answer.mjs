import { brandConflict, domainTier, rankedAlternatives, selectionReason, whoElse } from './name-context.mjs';
import { qualityRank } from './clis/domain-check/name-search.mjs';
const plain = value => String(value ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim();
const usd = value => '$' + value.toFixed(2);
const taken = row => ['taken', 'exact_match_found'].includes(row?.status);
const free = row => ['not-found', 'no_match_found'].includes(row?.status);

function price(offer) {
  const term = offer?.minimumYears ?? 1;
  const now = offer?.firstPaymentUsd ?? offer?.firstYearUsd;
  const renew = term > 1 ? offer?.renewalPaymentUsd : offer?.renewalUsd;
  if (!Number.isFinite(now) || !Number.isFinite(renew) || !offer.shop) return '';
  return usd(now) + ' now' + (term > 1 ? ' for ' + term + ' years' : '') + ', then ' + usd(renew)
    + (term > 1 ? ' every ' + term + ' years' : '/yr') + ' (' + plain(offer.shop) + ')'
    + (offer.needsCloudflareDns ? ' · requires Cloudflare DNS' : '');
}

function domainPrice(row, pick) {
  const offer = pick?.domain === row.domain ? pick : row.prices?.[0];
  return price(offer) || price(row.prices?.find(candidate => candidate.shop === offer?.shop));
}

function trademark(us) {
  if (us?.status !== 'exact_match_found') return '';
  const match = us.marks?.[0];
  if (!match?.mark) return 'An exact US trademark match was found.';
  const subject = plain(match.mark);
  const owner = match.owner ? ' (' + plain(match.owner) + ')' : '';
  const status = match.status === 'registered' ? ' is a US trademark' : match.status === 'applied'
    ? ' has a pending US trademark application' : ' has an exact US trademark match';
  return subject + status + owner + '. Matters if you sell in the US.';
}

function appChecks(check, pending) {
  const { nameChecks } = check;
  const app = check.appStore ?? nameChecks?.appStore;
  const play = check.googlePlay ?? nameChecks?.googlePlay;
  const us = check.trademarks?.us ?? nameChecks?.trademarks?.us;
  const sources = [['App Store', app], ['Google Play', play]];
  const waiting = row => row?.status === 'pending' || (!row && pending);
  const late = [...sources, ['US trademark', us]].filter(([, row]) => waiting(row)).map(([label]) => label);
  const ready = sources.filter(([, row]) => !waiting(row));
  const apps = ready.map(([label, row]) => label + ': '
    + (taken(row) ? 'taken' : free(row) ? 'no app with this name' : 'couldn’t check')).join(' · ');
  return { apps, late, ready, warning: trademark(us) };
}

export function shortDomainAnswer(check, { pending, link } = {}) {
  if (check.context || check.advice || check.ownedDomains?.length || check.ranked) {
    return rankedDomainAnswer(check, { pending, link });
  }
  const exact = check.query.exactDomain;
  const alternatives = check.alternatives;
  const rows = alternatives?.domains ?? check.domains;
  const available = rows.filter(row => row.status === 'available');
  const pick = alternatives?.choice?.pick ?? check.choice?.pick;
  const best = available.find(row => row.domain === pick?.domain) ?? available[0];
  const hit = check.domains.find(row => row.domain === exact);
  const primary = exact && hit?.status === 'available' ? hit : best;
  const priced = primary && domainPrice(primary, pick);
  const takenEnds = rows.filter(row => row.status === 'taken').map(row => '.' + row.ending);
  const unknown = rows.filter(row => row.status === 'unknown' && row.reason !== 'reserved').map(row => '.' + row.ending);
  let first;
  if (exact) {
    if (hit?.status === 'available') first = exact + ' is available' + (priced ? ': ' + priced : '') + '.';
    else if (hit?.status === 'taken') first = exact + ' is taken.' + (best
      ? ' Best available: ' + best.domain + (priced ? ', ' + priced : '') + '.' : '');
    else first = hit?.reason === 'reserved' ? exact + ' is reserved by the registry.' : 'Could not confirm ' + exact + '.';
  } else if (best) {
    first = best.domain + (best.domain === pick?.domain ? ' is your best bet' : ' is available') + (priced ? ': ' + priced : '') + '.';
  } else if (rows.length && takenEnds.length === rows.length) {
    first = 'All ' + rows.length + (rows.length === 1 ? ' ending is' : ' endings are') + ' taken. Want new name ideas?';
  } else {
    first = 'No available endings confirmed for ' + plain(check.query.name) + '.';
  }
  const also = available.filter(row => row !== primary).map(row => row.domain);
  const endings = [
    ...(also.length ? ['Also available: ' + also.join(', ')] : []),
    ...(takenEnds.length && ((exact && alternatives) || (!exact && takenEnds.length < rows.length))
      ? ['Taken: ' + takenEnds.join(' ')] : []),
  ];
  if (!exact && unknown.length) {
    const note = 'Couldn’t confirm: ' + unknown.join(' ');
    if (endings.length) endings[endings.length - 1] += ' · ' + note;
    else endings.push(note);
  }
  const { apps, late, warning } = appChecks(check, pending);
  if ([apps, late.length, warning].filter(Boolean).length === 3 && link && endings.length === 2) {
    endings.splice(0, 2, endings.join(' · '));
  }
  return [first, ...endings, apps, warning && 'Heads-up: ' + warning,
    late.length ? 'Still checking ' + late.join(', ') + '.' : '', link].filter(Boolean).join('\n');
}

function rankedDomainAnswer(check, { pending, link }) {
  const { query, ownedDomains = [], alternatives, context, advice } = check;
  const exact = query.exactDomain;
  const label = query.ascii ?? context?.label ?? (exact || query.name).toLowerCase().split('.')[0];
  const rows = alternatives?.domains ?? check.domains;
  const exactPick = check.choice?.pick;
  const best = alternatives?.choice?.pick ?? exactPick;
  const row = rows.find(row => row.domain === best?.domain);
  const hit = check.domains.find(row => row.domain === exact);
  const displayPick = !exact || best?.domain !== exact ? row : hit;
  const reason = best && selectionReason(best.domain, label);
  const priced = displayPick && domainPrice(displayPick, best);
  const owned = ownedDomains.length ? 'You own: ' + ownedDomains.join(', ') : '';
  let first;
  if (exact && ownStatus(hit, ownedDomains, exact)) first = best && best.domain !== exact && priced
    ? 'Alternative: ' + best.domain + ', ' + priced + '. ' + reason : 'Keep using ' + exact + '.';
  else if (exact && hit?.status === 'available' && !best && !hit.premium) first = exact + ' is available' +
    (hit.prices?.length ? ' above your price cap.' : '. Price unconfirmed.');
  else if (exact && hit?.status === 'available' && best?.domain === exact && priced) first = exact + ' is available: ' + priced + '.';
  else if (exact) {
    const state = hit?.status === 'taken' ? ' is taken.' : hit?.reason === 'reserved' ? ' is reserved.'
      : hit?.premium ? ' has ' + (/may be|possible|risk/i.test(hit.premium) ? 'possible premium pricing.' : 'premium pricing.')
        : hit?.status === 'available' ? ' is above your price cap.' : ' could not be confirmed.';
    first = exact + state + (best && priced ? ' Best alternative: ' + best.domain + ', ' + priced + '. ' + reason : '');
  } else if (best && priced) first = best.domain + ' is your best bet: ' + priced + '. ' + reason;
  else if (owned) first = 'Keep using ' + ownedDomains[0] + '.';
  else if (rows.filter(row => !row.variant).every(row => row.status === 'taken' || row.status === 'owned')) {
    first = 'All ' + rows.filter(row => !row.variant).length + ' checked endings are taken. Try a new name.';
  } else first = 'No priced domain confirmed within the cap. Try a new name.';
  const compare = (a, b) => domainTier(a.domain, label) - domainTier(b.domain, label) ||
    qualityRank(a.domain) - qualityRank(b.domain);
  const also = rankedAlternatives(rows, displayPick ?? hit, label, compare);
  const { apps, late, warning } = appChecks(check, pending);
  const appLine = [apps, late.filter(label => label !== 'US trademark').length
    ? 'Still checking ' + late.filter(label => label !== 'US trademark').join(', ') : ''].filter(Boolean).join(' · ');
  const trademarkLine = warning ? 'Heads-up: ' + warning : late.includes('US trademark') ? 'Still checking US trademark.' : '';
  const others = whoElse(context, { pick: best, ownedDomains, hasAdvice: Boolean(advice),
    blockedBrand: brandConflict(context, check.trademarks) });
  const lines = [first, appLine, trademarkLine, others, advice?.text, link].filter(Boolean);
  const extra = also.length ? 'Also available: ' + also.map(row => row.domain).join(', ') : '';
  if (owned && lines.length < 6) lines.splice(1, 0, owned);
  else if (owned) lines[0] += ' · ' + owned;
  if (extra && lines.length < 6) lines.splice(owned && lines[1] === owned ? 2 : 1, 0, extra);
  return lines.join('\n');
}

const ownStatus = (row, owned, exact) => row?.status === 'owned' || owned.includes(exact);

export function shortIdeaAnswer(checks, { pending, link } = {}) {
  const lines = checks.slice(0, 5).map(check => {
    const pick = check.choice?.pick;
    const row = check.domains.find(row => row.domain === pick?.domain && row.status === 'available');
    const { ready, late, warning } = appChecks(check, pending);
    const apps = ready.length === 2 && ready.every(([, answer]) => free(answer)) ? 'apps free'
      : ready.length === 2 && ready.every(([, answer]) => taken(answer)) ? 'apps taken'
        : ready.map(([label, answer]) => label + ' ' + (taken(answer) ? 'taken' : free(answer) ? 'free' : 'couldn’t check')).join(' · ');
    const offer = row && domainPrice(row, pick);
    return plain(check.query.name) + ' - ' + [
      plain(check.why), row ? row.domain + (offer ? ', ' + offer : '') : 'no domain pick',
      apps, warning ? 'Heads-up: ' + warning : check.why && (check.nameChecks?.trademarks?.us?.status === 'no_exact_match_found'
        ? 'no exact US trademark found' : 'US trademark unconfirmed'), late.length ? 'still checking ' + late.join(', ') : '',
    ].filter(Boolean).join(' · ');
  });
  return [...(lines.length ? lines : [pending ? 'Still checking names and domains.' : 'No names passed the checks.']),
    link].filter(Boolean).join('\n');
}
