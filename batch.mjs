import { normalizeName } from './clis/domain-check/name-search.mjs';
import { md } from './display.mjs';

// check_batch: the host writes up to 60 names, the package checks them itself (registries, app stores, exact US
// trademarks) and returns at most five ranked picks. No hosted naming service and no AI quota are involved.
// A source that did not answer is left out; it never becomes an error, a caveat or a mention of limits.
export const maxBatch = 60;
export const batchPicks = 5;
// Preferred endings, best first.
export const batchEndings = ['com', 'app', 'ai'];
// Every name is checked on .com; the first names in the host's order also on .app and .ai. Google's .app registry
// answers one request at a time, so a full 60-name sweep of .app would not fit one reply.
const wideNames = 15;
// Names screened for apps and trademarks per round, side by side.
const finalistRound = 10;
const nameCheckMs = 3200;

const issues = {
  appStore: 'an iPhone app already uses the name',
  googlePlay: 'an Android app already uses the name',
  trademark: 'a live US trademark has this exact name',
};

const plain = value => String(value ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim();
const cell = value => md(plain(value));
const usd = value => '$' + value.toFixed(2);

export function batchArguments(args) {
  const allowed = ['idea', 'customer', 'feedback', 'round', 'shown', 'taste', 'candidates', 'detail'];
  if (args === null || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !allowed.includes(key))) {
    throw new Error('Send idea and candidates, up to ' + maxBatch + ' names in one call.');
  }
  const { candidates } = args;
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > maxBatch) {
    throw new Error('Send 1 to ' + maxBatch + ' candidates in one call.');
  }
  const seen = new Set();
  return candidates.flatMap((entry, index) => {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (typeof name !== 'string' || !name.trim() || name.length > 40 || /[\p{Cc}]/u.test(name)) {
      throw new Error('candidates[' + index + '] needs a name of up to 40 characters.');
    }
    const label = normalizeName(name);
    if (!label || seen.has(label)) return [];
    seen.add(label);
    const why = typeof entry?.why === 'string' ? entry.why.slice(0, 180) : null;
    return [{ name: name.trim(), label, why, territory: entry?.territory ?? null, anchor: entry?.anchor ?? null, index }];
  });
}

const rank = domain => batchEndings.indexOf(domain.slice(domain.indexOf('.') + 1));

// The best free, priced domain for one name on the preferred endings.
function bestDomain(rows) {
  return rows.filter(row => row.status === 'available' && !row.premium && row.prices?.[0]?.buyUrl
    && Number.isFinite(row.prices[0].firstPaymentUsd ?? row.prices[0].firstYearUsd) && rank(row.domain) >= 0)
    .sort((a, b) => rank(a.domain) - rank(b.domain))[0] ?? null;
}

const answered = row => ['taken', 'no_match_found', 'not-found', 'exact_match_found', 'no_exact_match_found'].includes(row?.status);

// The issues the answered sources found, and what the clean answers can honestly claim.
function screen(checks) {
  const found = [];
  const clear = [];
  const app = checks?.appStore;
  const play = checks?.googlePlay;
  const us = checks?.trademarks?.us;
  if (app?.status === 'taken') found.push(issues.appStore);
  if (play?.status === 'taken') found.push(issues.googlePlay);
  if (us?.status === 'exact_match_found') found.push(issues.trademark);
  const appFree = answered(app) && app.status !== 'taken';
  const playFree = answered(play) && play.status !== 'taken';
  if (appFree && playFree) clear.push('no app match');
  else if (appFree) clear.push('no App Store match');
  else if (playFree) clear.push('no Google Play match');
  if (us?.status === 'no_exact_match_found') clear.push('no exact US trademark');
  return { found, clear };
}

// sources: { batchDomains(domains), localChecks(name, label) }. deadline is a performance.now() time.
export async function checkBatch(candidates, sources, { deadline = performance.now() + 12_000 } = {}) {
  const domains = candidates.flatMap((entry, index) => batchEndings
    .filter(ending => ending === 'com' || index < wideNames).map(ending => entry.label + '.' + ending));
  const budget = Math.max(1500, Math.min(8000, Math.floor(deadline - performance.now() - nameCheckMs - 300)));
  const rows = await sources.batchDomains(domains, budget).catch(() => []);
  const byLabel = new Map();
  for (const row of rows) {
    const label = row.domain.slice(0, row.domain.indexOf('.'));
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(row);
  }
  // Names with a free preferred domain, .com first, then .app, then .ai; the host's order breaks ties.
  const withDomain = candidates.flatMap(entry => {
    const domain = bestDomain(byLabel.get(entry.label) ?? []);
    return domain ? [{ ...entry, domain, domains: byLabel.get(entry.label) }] : [];
  }).sort((a, b) => rank(a.domain.domain) - rank(b.domain.domain) || a.index - b.index);

  const screened = [];
  for (let start = 0; start < withDomain.length; start += finalistRound) {
    const passed = screened.filter(entry => !entry.found.length).length;
    if (passed >= batchPicks || deadline - performance.now() < nameCheckMs) break;
    const round = withDomain.slice(start, start + finalistRound);
    const results = await Promise.all(round.map(entry => {
      let timer;
      return Promise.race([
        Promise.resolve().then(() => sources.localChecks(entry.name, entry.label)).catch(() => null),
        new Promise(resolve => { timer = setTimeout(resolve, nameCheckMs, null); }),
      ]).finally(() => clearTimeout(timer));
    }));
    round.forEach((entry, index) => screened.push({ ...entry, nameChecks: results[index], ...screen(results[index]) }));
  }
  // Clean names first, then near misses with exactly one issue; two or more issues never show.
  const picks = [...screened.filter(entry => !entry.found.length), ...screened.filter(entry => entry.found.length === 1)]
    .slice(0, batchPicks);
  return { picks, checked: candidates.length };
}

function shortWhy(text, words = 7) {
  const all = plain(text).replace(/[.!]+$/, '').split(/\s+/).filter(Boolean);
  return all.length ? cell(all.slice(0, words).join(' ') + (all.length > words ? '…' : '')) : '';
}

export function batchAnswer({ picks }, { link } = {}) {
  if (!picks.length) {
    return ['Try a fresh naming direction with a new set of candidates.', link]
      .filter(Boolean).join('\n\n');
  }
  const withWhy = picks.some(entry => entry.why);
  const header = ['Name', ...(withWhy ? ['Why'] : []), 'Domain', 'Now / then', 'Checks'];
  const rows = picks.map(entry => {
    const offer = entry.domain.prices[0];
    const now = offer.firstPaymentUsd ?? offer.firstYearUsd;
    const renew = offer.renewalUsd;
    const price = usd(now) + (Number.isFinite(renew) ? ' / ' + usd(renew) + '/yr' : '') + ' (' + cell(offer.shop) + ')';
    const checks = entry.found.length ? 'Near miss: ' + entry.found[0] : entry.clear.length ? entry.clear.join(' · ') : 'domain free';
    return [cell(entry.name), ...(withWhy ? [shortWhy(entry.why) || ' '] : []), cell(entry.domain.domain), price, checks];
  });
  const line = cells => '| ' + cells.join(' | ') + ' |';
  const table = [line(header), '|' + header.map(() => '---').join('|') + '|', ...rows.map(line)].join('\n');
  return [table, link].filter(Boolean).join('\n\n');
}

// The page shape the naming receipts already use: one final generation with the screened names.
export function batchGeneration({ picks }) {
  return {
    version: 2, stage: 'final', complete: true, checkedAt: new Date().toISOString(),
    names: picks.map(entry => ({
      name: entry.name, why: entry.why, domain: { domain: entry.domain.domain, ...entry.domain.prices[0] },
      domains: entry.domains, nameChecks: entry.nameChecks ?? undefined,
    })),
  };
}
