import { shopSearchUrl, shops } from './clis/domain-check/prices.mjs';
import { isSearchLink, nameCheckLines } from './clis/domain-check/google-search.mjs';
import { canRecommend, eligibilityNeed, normalizeName, premiumRisk, unicodeName } from './clis/domain-check/name-search.mjs';
import { purchaseLine } from './clis/domain-check/naming-method.mjs';

export { purchaseLine, showAsIs } from './clis/domain-check/naming-method.mjs';
export const neverBuys = 'This check leaves checkout to you; open the link to buy.';
export const attribution = 'via domainhound.dev';

// Every MCP display carries one attribution line. The blank line keeps it out of a preceding table or list.
// When the display can show a checkout link, an exact lookup or purchase request can add the purchase line after it.
export const attributed = (display, purchase = false) => String(display ?? '').trimEnd() + '\n\n' + attribution
  + (purchase ? '\n\n' + purchaseLine : '');

const registrarIds = Object.keys(shops);
const compactTriageLegend = 'USD ex. VAT. prices by ending, own by name. term is years per payment.';

// Escape text from outside sources so it cannot add Markdown structure, links or HTML.
export function md(value) {
  return String(value ?? '')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/[\\`*_[\]<>|~]/g, '\\$&')
    .replace(/:\/\//g, ':\\/\\/')
    .replace(/\bwww\./gi, match => match.slice(0, 3) + '\\.');
}

const money = value => '$' + Number(value).toFixed(2);
// The DNS label of a screened name: punycode for æøå, never with letters removed.
const label = name => normalizeName(String(name ?? '')) ?? String(name ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9-]/g, '');
const fullDomain = (name, d) => d.includes('.') ? d : name + '.' + d;
const suffix = domain => domain.endsWith('.co.uk') || domain === 'co.uk' ? 'co.uk' : domain.split('.').at(-1);
const registered = (row, ending) => row.taken?.includes(ending) || row.resale?.includes(ending);
const checkoutLimitation = 'This check leaves checkout to you.';
const mayBePremium = 'may be premium, price at shop';

// A name or domain in its own spelling with the ASCII form registrars use beside it: "grønn.no (xn--grnn-zua.no)".
export function shown(value) {
  const text = String(value ?? '');
  const unicode = unicodeName(text);
  return unicode ? md(unicode) + ' (' + md(text) + ')' : md(text);
}

// "not eligible: needs Norwegian org/ID" for a restricted ending the buyer has not said they qualify for.
function ineligible(ending, eligible) {
  return canRecommend(ending, eligible ?? []) ? null : 'not eligible: needs ' + eligibilityNeed(ending);
}

// The shop whose search page is the fallback checkout for an ending.
const fallbackShop = ending => ending === 'no' ? 'dynadot' : ending === 'so' ? 'namecheap' : 'spaceship';
// A checkout link that is never empty: the given URL when it is a trusted shop search, else the fallback shop search.
function checkoutLink(url, domain) {
  return safeLink(url, domain) ?? safeLink(shopSearchUrl(fallbackShop(suffix(domain)), domain), domain);
}

// The renewal jump as a whole multiple, when the renewal is over twice the first payment for the same term.
// Both payments cover the same number of years (.ai: two), so the payments compare directly.
export function jumpRatio(price) {
  if (!(price?.now > 0) || price.renew == null) return null;
  const ratio = price.renew / price.now;
  return ratio > 2 ? Math.round(ratio) : null;
}

// Payments due in three years and the years they cover: .ai pays two years at a time, so it covers four.
function threeYears(price) {
  if (price?.now == null || price.renew == null) return null;
  if (price.y3 != null && !(price.term > 1)) return { total: price.y3, years: 3 };
  const term = price.term > 1 ? price.term : 1;
  const renewals = Math.ceil((3 - term) / term);
  return { total: price.y3 ?? Math.round((price.now + renewals * price.renew) * 100) / 100, years: term + renewals * term };
}

function preferredFirst(values, preferred, endingOf = value => value) {
  if (!preferred?.length) return values;
  const rank = value => {
    const index = preferred.indexOf(suffix(endingOf(value)));
    return index < 0 ? preferred.length : index;
  };
  return [...values].sort((a, b) => rank(a) - rank(b));
}

// A data-only shop has no search URL (null), so a missing URL must never match it.
export function safeLink(url, domain) {
  if (typeof url !== 'string' || !url || !/^[a-z0-9-]+\.[a-z0-9-]+$/i.test(domain) ||
      !registrarIds.some(id => shopSearchUrl(id, domain) === url)) return null;
  return '[' + domain + '](' + url + ')';
}

function templateLink(templates, shop, domain) {
  const template = templates?.[shop];
  return typeof template === 'string' && template.includes('{domain}')
    ? safeLink(template.replace('{domain}', encodeURIComponent(domain)), domain) : null;
}

// ".no not eligible: needs Norwegian org/ID." unless the buyer said they qualify.
function eligibilityLine(result) {
  return Object.keys(result.eligibility ?? {}).map(ending => {
    const need = eligibilityNeed(ending);
    return '.' + ending + (ineligible(ending, result.eligible) ? ' not eligible: needs ' + need + '.'
      : ': eligible, you said you qualify (' + need + ').');
  }).join(' ');
}

// When the live shop check could not run (no Playwright or no browser), the domain still needs a shop check.
// The line links the shop search and says the prices are list estimates, never a shop quote.
function liveCheckLine(result, withLink = true) {
  const check = result.liveCheck;
  if (!check || typeof check !== 'object' || typeof check.domain !== 'string') return '';
  const link = withLink ? safeLink(check.checkUrl, check.domain) : null;
  return (link ? 'Check at shop: ' + link + '. ' : '') + 'Live shop check unavailable'
    + (check.reason ? ' (' + md(check.reason) + ')' : '') + '. Any prices shown are list estimates.';
}

// ".com $9.48/$10.68", with the term when a payment covers more than one year. A renewal over twice the first
// payment is said in the same place: ".co $3.11, then $31.05/yr, 10x jump".
function priceText(price) {
  const term = price.term > 1 ? ' ' + price.term + 'y' : '';
  const ratio = jumpRatio(price);
  if (ratio) return money(price.now) + term + ', then ' + money(price.renew) + (term ? '/' + price.term + 'y' : '/yr') + ', ' + ratio + 'x jump';
  return money(price.now) + (price.renew != null ? '/' + money(price.renew) : '') + term;
}

function priced(ending, price) {
  return ending + ' ' + (price?.now == null ? 'price at shop' : priceText(price));
}

// "Best value: lanternbay.com, $30.84 over 3 years" (the lowest total of the payments due in three years).
function bestValueLine(domain, price) {
  const value = threeYears(price);
  if (!value) return '';
  return 'Best value: ' + shown(domain) + ', ' + money(value.total) + ' over 3 years'
    + (value.years > 3 ? ' (covers ' + value.years + ' years)' : '');
}

// The date of the oldest list price shown, e.g. "list price from 2026-11-25".
function listDate(result) {
  return /^\d{4}-\d{2}-\d{2}$/.test(result.priceListDate ?? '') ? result.priceListDate : null;
}

const clock = value => /^\d{2}:\d{2}$/.test(value ?? '') ? ' ' + value + ' UTC' : '';

// "confirmed at Spaceship 12:04 UTC" for a shop quote; "list price" otherwise.
function priceLabel(option, shop) {
  if (option?.s !== 'ok') return 'list price';
  const premium = option.prem === 'possible' ? 'possible premium, ' : option.prem ? 'premium, ' : '';
  return premium + 'confirmed at ' + md(shop ?? 'the shop') + clock(option.at);
}

// "Other endings (list prices, availability not checked): .ai $159.96/$159.96 2y · .io $21.40/$53.50 · ..."
function otherEndingsLine(result) {
  const entries = Object.entries(result.otherEndings ?? {}).filter(([ending, price]) =>
    price?.now != null && !ineligible(ending, result.eligible));
  return entries.length ? 'Other endings (list prices, availability not checked): '
    + entries.map(([ending, price]) => priced('.' + ending, price)).join(' · ') : '';
}

function exactDisplay(result) {
  const row = result.names?.[0] ?? {};
  const domain = row.name;
  const name = shown(domain);
  const ending = suffix(domain);
  const checked = result.checkedAt ? ' Checked ' + String(result.checkedAt).slice(0, 16).replace('T', ' ') + ' UTC.' : '';
  const others = otherEndingsLine(result);
  const tail = others ? [others] : [];
  const notEligible = ineligible(ending, result.eligible);
  const eligibility = result.eligibility ? [eligibilityLine(result)] : [];
  if (registered(row, ending)) {
    const resale = row.resale?.includes(ending) ? ' The owner may list it for resale.' : '';
    // The ending's standard list price, labelled as a benchmark: this name is not for sale at it.
    const standard = result.listPrices?.[ending];
    const date = listDate(result);
    const showBenchmark = standard?.now != null && !notEligible && (ending === 'ai' || !premiumRisk(domain));
    const term = standard?.term ?? 1;
    const renewal = ending === 'ai' && standard?.renew != null
      ? money(standard.renew / term) + '/yr renewal, billed as ' + money(standard.renew) + ' every ' + term + ' years'
      : showBenchmark ? priceText(standard) : '';
    const benchmark = showBenchmark
      ? ['Standard .' + ending + ' list price (benchmark' + (date ? ' from ' + date : '') + ', USD ex. VAT): ' + renewal + '.']
      : [];
    return ['**' + name + ' is taken. ' + checkoutLimitation + '**' + resale + checked, ...benchmark, ...tail].join('\n');
  }
  const free = row.free?.find(option => option.d === ending);
  if (free?.s === 'prem') {
    if (notEligible) return ['**' + name + ' is free at the registry.** ' + notEligible + '.' + checked, ...tail].join('\n');
    const shop = free.shop ?? Object.keys(result.buyUrlTemplate ?? {})[0];
    const link = templateLink(result.buyUrlTemplate, shop, domain);
    const head = free.risk ? '**' + name + ' is free at the registry.** May be premium, price at shop'
      : '**' + name + ' is free at the registry, but premium.** Premium, price at shop';
    return [head + (link ? ': ' + link : '') + '.' + (free.risk ? ' No list price shown.' : ' No list price applies.') + checked,
      ...eligibility, ...tail].join('\n');
  }
  if (free) {
    const confirmed = free.s === 'ok';
    // A shop quote never falls back to the list price.
    const offer = confirmed ? free : { ...result.listPrices?.[ending], ...free };
    const best = result.best?.domain === domain ? result.best : null;
    const shop = offer.shop ?? best?.shop;
    const link = safeLink(best?.buyUrl, domain) ?? templateLink(result.buyUrlTemplate, shop, domain);
    const term = offer.term > 1 ? ' for ' + offer.term + ' years' : '';
    const live = !notEligible && !confirmed && result.liveCheck?.domain === domain ? liveCheckLine(result) : '';
    const date = listDate(result);
    const ratio = jumpRatio(offer);
    const checkout = notEligible ?? (link ? link + (shop ? ' at ' + md(shop) : '') : '—');
    const lines = [
      '**' + name + (free.prem ? ' is free, at a premium price.** ' : ' is free.** ')
        + (confirmed ? 'Price ' + priceLabel(free, shop) + '.'
          : 'The registry shows it free; the price is a list price' + (offer.now != null && date ? ' from ' + date : '')
            + ', not a shop quote.') + checked,
      '',
      '| Domain | Today | Renewal | 3 years | Checkout |',
      '|---|---|---|---|---|',
      '| ' + name + ' | ' + (offer.now != null ? money(offer.now) + term : 'price at shop') + ' | '
        + (offer.renew != null ? money(offer.renew) + (offer.term > 1 ? term : '/yr') : '—') + (ratio ? ', ' + ratio + 'x jump' : '')
        + ' | ' + (offer.y3 != null ? money(offer.y3) : '—') + ' | ' + checkout + ' |',
      '',
      ...(live ? [live] : []),
      'USD ex. VAT.' + (confirmed ? '' : ' Estimate: the shop shows the final price.'),
      ...eligibility,
      ...tail,
    ];
    return lines.join('\n');
  }
  if (notEligible) return ['**' + name + ': ' + notEligible + '.**' + checked, ...tail].join('\n');
  const why = result.shopCheckWhy?.[domain] ?? result.shopCheckWhy?.[ending];
  const shop = Object.keys(result.buyUrlTemplate ?? {})[0];
  const link = templateLink(result.buyUrlTemplate, shop, domain);
  if (result.shopCheckWhy?.[domain]) {
    // Reserved or not offered: no list price applies.
    return ['**' + name + ': not offered for registration.** ' + md(why) + '. Check at shop' + (link ? ': ' + link : '') + '.' + checked,
      ...tail].join('\n');
  }
  const live = result.liveCheck?.domain === domain ? liveCheckLine(result, !link) : '';
  const estimate = result.listPrices?.[ending];
  const date = listDate(result);
  const hasEstimate = estimate?.now != null && date && !premiumRisk(domain);
  // DNS is a likelihood only; the registry or the shop settles it.
  const likely = row.likely_free?.includes(ending) ? ' Likely free (DNS), confirm at shop.'
    : row.likely_taken?.includes(ending) ? ' Likely taken (DNS).' : '';
  const risk = premiumRisk(domain) ? ' A short name ' + mayBePremium + '.' : '';
  return ['**' + name + ': not settled.** The registry did not settle it' + (why ? ' (' + md(why) + ')' : '') + '.' + likely
    + ' Check at shop' + (link ? ': ' + link : '') + '.' + risk + (hasEstimate || risk ? '' : ' No price yet.') + checked,
    ...(hasEstimate ? [
      priced('.' + ending, estimate) + ' at ' + md(estimate.shop) + ' (USD ex. VAT, list price from ' + date + ').',
      ...eligibility,
    ] : []),
    ...(live ? [live] : []), ...tail].join('\n');
}

// One line per free domain, so a copied answer cannot merge or drop an ending. Each price appears once.
// Level 1 drops the "list price" word (the header says it); level 2 leaves standard prices to the shared line;
// level 3, for the densest batches, names each name once above its own ending lines.
function freeLines(row, listPrices, level, eligible) {
  return (row.free ?? []).map(option => {
    const full = option.d.includes('.') ? option.d : row.name.includes('.') ? row.name : row.name + '.' + option.d;
    const domain = level >= 3 && !option.d.includes('.') && !row.name.includes('.') ? '.' + option.d : shown(full);
    const blocked = ineligible(suffix(full), eligible);
    if (blocked) return '- ' + domain + ' ' + blocked;
    if (option.s === 'prem') return '- ' + domain + ' ' + (option.risk ? mayBePremium : 'premium, price at shop');
    const own = option.now != null;
    if (!own && level >= 2) return '- ' + domain;
    const quote = own ? option : listPrices[option.d];
    const listed = jumpRatio(quote) ? ' (list price)' : ' list price';
    const tag = option.s === 'ok' ? ' ✓ ' + priceLabel(option, option.shop) : level >= 1 || quote?.now == null ? '' : listed;
    return '- ' + domain + ' ' + (quote?.now == null ? 'price at shop' : priceText(quote)) + tag;
  });
}

function groupRows(rows, linesFor) {
  const groups = new Map();
  for (const row of rows) {
    const lines = linesFor(row);
    if (!lines.length) continue;
    const key = lines.join('\n');
    if (!groups.has(key)) groups.set(key, { names: [], lines });
    groups.get(key).names.push(shown(row.name));
  }
  return [...groups.values()];
}

// For one bare name: the cheapest first payment and the best three-year value among the endings this buyer can register.
function choiceLines(row, listPrices, eligible) {
  const options = (row.free ?? []).flatMap(option => {
    const domain = option.d.includes('.') ? option.d : row.name + '.' + option.d;
    if (option.s === 'prem' || option.prem || premiumRisk(domain) || ineligible(suffix(domain), eligible)) return [];
    const price = option.now != null ? option : listPrices[option.d];
    return price?.now != null ? [{ domain, price, value: threeYears(price)?.total ?? Infinity }] : [];
  });
  if (!options.length) return [];
  const cheapest = options.reduce((best, row) => row.price.now < best.price.now ? row : best);
  const value = options.reduce((best, row) => row.value < best.value
    || (row.value === best.value && row.price.now < best.price.now) ? row : best);
  return ['Cheapest now: ' + shown(cheapest.domain), ...(value.value < Infinity ? [bestValueLine(value.domain, value.price)] : [])];
}

export function checkDisplay(result, level = 0, purchase = false) {
  const rows = (result.names ?? []).filter(Boolean);
  if (rows.length === 1 && rows[0].name?.includes('.')) return exactDisplay(result);
  const listPrices = result.listPrices ?? {};
  const eligible = result.eligible ?? [];
  // The shared line carries a standard price only where no free line shows it: free endings from level 2 on, and
  // endings left to a shop check. Short names may be premium, so their open endings add no list price.
  const standard = new Set();
  for (const row of rows) {
    for (const option of row.free ?? []) if (level >= 2 && option.now == null && option.s !== 'prem') standard.add(option.d);
    if (premiumRisk(row.name)) continue;
    for (const d of row.shop_check ?? []) if (listPrices[d]?.now != null) standard.add(d);
  }
  const shared = [...standard].filter(d => !d.includes('.') && listPrices[d] && !ineligible(d, eligible))
    .map(d => priced('.' + d, listPrices[d])).join(' · ');
  const lines = [
    '**Domain check, ' + rows.length + (rows.length === 1 ? ' name' : ' names') + '** (USD ex. VAT, today/renewal; '
      + 'list prices' + (listDate(result) ? ' from ' + listDate(result) : '') + ' unless ✓ confirmed at a shop'
      + '; 2y = two-year payments)',
  ];
  if (shared) lines.push('Standard prices: ' + shared);
  if (result.eligibility) lines.push(eligibilityLine(result));
  const free = level >= 3
    ? groupRows(rows, row => freeLines(row, listPrices, level, eligible))
      .flatMap(group => [group.names.join(', ') + ':', ...group.lines])
    : rows.flatMap(row => freeLines(row, listPrices, level, eligible));
  lines.push('', '**Free domains, one ending per line**' + (free.length ? '' : ': none found'), ...free, '');
  const endingsOf = (row, key) => (row[key] ?? []).map(d => d.includes('.') ? d : '.' + d);
  const statusLines = project => level >= 3
    ? groupRows(rows, project).map(group => group.names.join(', ') + ' ' + group.lines.join(' '))
    : rows.flatMap(row => {
      const endings = project(row);
      return endings.length ? [shown(row.name) + ' ' + endings.join(' ')] : [];
    });
  const likely = row => new Set([...(row.likely_free ?? []), ...(row.likely_taken ?? [])]);
  const taken = statusLines(row => [...endingsOf(row, 'taken'), ...endingsOf(row, 'resale').map(d => d + ' (resale)')]);
  const likelyTaken = statusLines(row => endingsOf(row, 'likely_taken'));
  const likelyFree = statusLines(row => endingsOf(row, 'likely_free'));
  const check = statusLines(row => endingsOf({ open: (row.shop_check ?? []).filter(d => !likely(row).has(d)) }, 'open'));
  if (taken.length) lines.push('Taken: ' + taken.join(' · '));
  // DNS is a likelihood only; the registry or the shop settles these.
  if (likelyTaken.length) lines.push('Likely taken (DNS): ' + likelyTaken.join(' · '));
  if (likelyFree.length) lines.push('Likely free (DNS), confirm at shop: ' + likelyFree.join(' · '));
  if (check.length) lines.push('Check at shop: ' + check.join(' · '));
  const reasons = new Map();
  for (const [ending, reason] of Object.entries(result.shopCheckWhy ?? {})) {
    if (!reasons.has(reason)) reasons.set(reason, []);
    reasons.get(reason).push(ending.includes('.') ? ending : '.' + ending);
  }
  for (const [reason, endings] of reasons) lines.push(endings.join(', ') + ' — ' + md(reason) + '.');
  if (result.complete === false) lines.push('Some checks did not finish in time; check those at a shop.');
  if (rows.length === 1) lines.push(...choiceLines(rows[0], listPrices, eligible));
  const best = result.best;
  const link = best && safeLink(best.buyUrl, best.domain);
  if (link) {
    lines.push('Confirmed at ' + md(best.shop ?? 'the shop') + clock(best.at) + ': ' + link + ' '
      + (best.priceNow != null ? priceText({ now: best.priceNow, renew: best.renewal, term: best.term }) : 'price at shop') + '.');
    lines.push(neverBuys);
  } else if (result.liveCheck) {
    const live = liveCheckLine(result);
    if (live) lines.push(live, neverBuys);
  } else if (rows.length === 1 || purchase) {
    const available = rows.flatMap(row => (row.free ?? []).flatMap(option => {
      const domain = option.d.includes('.') ? option.d : row.name.includes('.') ? row.name : row.name + '.' + option.d;
      if (!canRecommend(suffix(domain), eligible)) return [];
      const price = option.prem || option.s === 'prem' ? option : { ...listPrices[option.d], ...option };
      const link = templateLink(result.buyUrlTemplate, price.shop, domain);
      return link ? [{ link, price: price.now ?? Infinity }] : [];
    }));
    const cheapest = available.sort((a, b) => a.price - b.price)[0];
    if (cheapest) lines.push('Check at shop: ' + cheapest.link);
  }
  return lines.join('\n').trim();
}

function rowBestValue(row, prices) {
  const ending = row?.bestValue;
  return ending ? bestValueLine(fullDomain(label(row.name), ending), row.own?.[ending] ?? prices?.[ending]) : '';
}

// Google, App Store (iOS) and Google Play (Android), each with its result or "not checked" and a direct search link.
// The short form links the source label itself and reads the same once rendered.
export function checkLines(row, short = false) {
  const original = typeof row?.name === 'string' ? row.name : '';
  const input = original.length > 100 ? label(original) : original;
  return nameCheckLines({ ...row, name: input }).map(({ label, text, link }) => {
    const safe = isSearchLink(link, input);
    if (short && safe) return '[' + label + '](' + link + '): ' + md(text);
    return label + ': ' + md(text) + (safe ? ' · [search](' + link + ')' : '');
  });
}

const verdictRank = { 'No conflict found': 0, 'Check first': 1, Avoid: 2 };

// The cheapest free ending this buyer can register, at the name's own price or the standard list price.
function cheapestEligible(row, prices, eligible) {
  let best = null;
  for (const ending of Array.isArray(row?.free) ? row.free : []) {
    const quote = row.own?.[ending] ?? prices?.[ending];
    if (!canRecommend(ending, eligible) || quote?.now == null) continue;
    if (!best || quote.now < best.now) best = { ending, now: quote.now, renew: quote.renew ?? null, term: quote.term ?? null };
  }
  return best;
}

// Three ranked picks once three or more names are screened: the screen's own ranking first, then the other
// names by verdict and cheapest eligible price. Each pick carries its cheapest eligible domain and price.
export function topPicks(result) {
  const rows = (result.names ?? []).filter(Boolean);
  const prices = result.prices ?? {};
  const picks = (Array.isArray(result.top) ? result.top : []).filter(Boolean).slice(0, 3).map(pick => {
    if (pick.ending || pick.domain) return pick;
    const cheapest = cheapestEligible(rows.find(row => row.name === pick.name), prices, result.eligible);
    return cheapest ? { ...pick, ...cheapest } : pick;
  });
  if (rows.length < 3) return picks;
  const rest = rows.map((row, index) => ({ row, index, cheapest: cheapestEligible(row, prices, result.eligible) }))
    .filter(({ row }) => !picks.some(pick => pick.name === row.name))
    .sort((a, b) => (verdictRank[a.row.verdict] ?? 3) - (verdictRank[b.row.verdict] ?? 3)
      || (a.cheapest?.now ?? Infinity) - (b.cheapest?.now ?? Infinity) || a.index - b.index);
  for (const { row, cheapest } of rest.slice(0, 3 - picks.length)) {
    picks.push({ name: row.name, verdict: row.verdict, reason: row.reason,
      ...(cheapest && { ...cheapest, domain: fullDomain(label(row.name), cheapest.ending) }) });
  }
  return picks;
}

// A screened name as typed, with its DNS label beside it when that is punycode: "Grønnstue (xn--grnnstue-64a)".
function nameLabel(name) {
  const dns = label(name);
  return md(name) + (dns.startsWith('xn--') ? ' (' + md(dns) + ')' : '');
}

function topLines(result, showReason, showValue = true) {
  return ['**Top picks**', ...topPicks(result).map(row => {
    const ending = row.domain ? shown(row.domain) : row.ending && '.' + row.ending;
    const domain = ending ? ', cheapest now ' + priced(ending, row) : ', no eligible free ending';
    const value = !showValue ? '' : typeof row.bestValue === 'string'
      ? rowBestValue(result.names.find(candidate => candidate.name === row.name), result.prices)
      : row.bestValue && bestValueLine(row.bestValue.domain, row.bestValue);
    return '- **' + nameLabel(row.name) + '** — ' + md(row.verdict) + domain + (showReason ? '. ' + md(row.reason) : '')
      + (value ? '  \n  ' + value : '');
  })];
}

// The rival that sets the verdict, its traction level and its two strongest signals (unless the reason already
// names them), plus the GEO line: the agent's own answer, or the labelled Wikipedia/Wikidata stand-in.
export function tractionLine(row, compact = false) {
  const traction = row?.traction;
  if (!traction || typeof traction !== 'object') return '';
  const parts = [];
  if (typeof traction.rival === 'string' && typeof traction.level === 'string') {
    const signals = Array.isArray(traction.signals) ? traction.signals.filter(item => typeof item === 'string').slice(0, 2) : [];
    const named = String(row.reason ?? '').includes(traction.rival + ' (' + signals.join(', ') + ')');
    parts.push(compact && named ? traction.level + ' traction'
      : 'Rival: ' + traction.rival + ', ' + traction.level + (signals.length && !named ? ' (' + signals.join(', ') + ')' : ''));
  }
  if (typeof traction.geo === 'string' && (!compact || traction.rival || /agent knows/i.test(traction.geo))) parts.push('GEO ' + traction.geo);
  return parts.length ? '<br>' + md(parts.join(' · ')) : '';
}

// Every row lists each free ending on its own line with its price.
export function triageDisplay(result, prior, { short = false, compact = false, preferred } = {}) {
  const prices = result.prices ?? {};
  const rows = (result.names ?? []).filter(Boolean);
  const earlierRows = new Map((prior?.names ?? []).map(row => [row.name, row.free ?? []]));
  const lines = [];
  if (topPicks(result).length) lines.push(...topLines(result, !prior && rows.length !== 5, !prior && rows.length !== 5), '');
  lines.push(prior ? '**Name screen** (USD ex. VAT, estimates)' :
    '**Name screen** (USD ex. VAT; list prices, the shop shows the final price; 2y = each payment covers two years)');
  if (result.eligibility) lines.push(eligibilityLine(result));
  const checkoutHeading = prior ? 'Cheapest eligible / checkout' : 'Checkout';
  lines.push('', '| Name | Verdict and reason | Free endings, one per line, today/renewal | ' + checkoutHeading + ' | Search checks |',
    '|---|---|---|---|---|');
  for (const row of rows) {
    const base = label(row.name);
    const free = Array.isArray(row.free) ? row.free : [];
    const earlier = earlierRows.get(base) ?? [];
    // An earlier premium answer, or a shop quote above the list price, replaces the list price for that ending.
    const premiumQuote = ending => earlier.find(option => option.d === ending && (option.s === 'prem' || option.prem ||
      (option.s === 'ok' && option.now != null && option.now > ((row.own?.[ending] ?? prices[ending])?.now ?? Infinity) + 0.01)));
    const first = free.find(ending => canRecommend(ending, result.eligible) && !premiumQuote(ending));
    // The checkout always links a real shop search; it never renders an empty link.
    const link = first && base ? checkoutLink(row.buy, fullDomain(base, first)) : null;
    const cell = preferredFirst(free, preferred).map(ending => {
      const blocked = ineligible(ending, result.eligible);
      if (blocked) return '.' + ending + ' ' + blocked;
      const own = row.own?.[ending];
      const premium = premiumQuote(ending);
      if (premium) {
        return premium.s === 'prem' || premium.now == null ? '.' + ending + ' premium, price at shop'
          : priced('.' + ending, premium) + (premium.prem === true ? ' premium' : ' possible premium') + ' shop quote';
      }
      return priced('.' + ending, own ?? prices[ending]);
    });
    const previous = option => priced('.' + option.d, option.now != null ? option : prior.listPrices?.[option.d]);
    const recheck = earlier.filter(option => row.shop_check?.includes(option.d));
    const taken = earlier.filter(option => row.taken?.includes(option.d));
    const exact = earlier.filter(option => option.s === 'ok' && free.includes(option.d) && !premiumQuote(option.d) &&
      option.now !== (row.own?.[option.d] ?? prices[option.d])?.now);
    const likely = new Set([...(row.likely_free ?? []), ...(row.likely_taken ?? [])]);
    const groups = {
      premium: row.premium, taken: row.taken, likely_taken: row.likely_taken, likely_free: row.likely_free,
      shop_check: row.shop_check?.filter(ending => !likely.has(ending)),
    };
    for (const [key, heading] of [['premium', premiumRisk(base) ? mayBePremium : 'premium, price at shop'], ['taken', 'taken'],
      ['likely_taken', 'likely taken (DNS)'], ['likely_free', 'likely free (DNS), confirm at shop'], ['shop_check', 'check at shop']]) {
      if (groups[key]?.length) cell.push(heading + ': ' + preferredFirst(groups[key], preferred).map(ending => '.' + ending).join(' '));
    }
    if (!compact && recheck.length) cell.push('earlier price, recheck: ' + recheck.map(previous).join(', '));
    if (!compact && taken.length) cell.push('earlier price, now taken: ' + taken.map(previous).join(', '));
    if (!compact && exact.length) cell.push('earlier shop quote: ' + exact.map(previous).join(', '));
    // The price stays on the ending's own line, so the checkout cell carries only the link.
    const checkout = compact ? '—' : link ?? '—';
    const value = !compact && rowBestValue(row, prices);
    const reason = compact ? shorten(String(row.reason ?? '').split(' · ', 1)[0], 80) : row.reason;
    const checks = compact ? checkLines(row, false).map(line => line.split(' · [search]', 1)[0]) : checkLines(row, short);
    lines.push('| ' + nameLabel(row.name) + ' | ' + md(row.verdict) + ': ' + md(reason) + (compact ? '' : tractionLine(row, Boolean(prior) || short)) + ' | '
      + (cell.join('<br>') || 'none free') + (value ? '<br>' + value : '') + ' | ' + checkout + ' | '
      + checks.join('<br>') + ' |');
  }
  lines.push('', 'Choose a favorite and ask for its exact quote.');
  return lines.join('\n');
}

const shorten = (value, length) => value.length > length ? value.slice(0, length - 1).trimEnd() + '…' : value;

function denseDisplay(result, short = false, links = true) {
  const heading = topPicks(result).length ? topLines(result, false).join('\n') : '**Name screen**';
  const results = (result.names ?? []).filter(Boolean);
  const checksFor = row => checkLines(row, short).map(line =>
    links ? line : line.replace(/\[([^\]]+)\]\(https:\/\/[^)]+\)/g, '$1'));
  const names = results.map(row => '- **' + nameLabel(row.name) + '** — ' + md(row.verdict));
  const individual = names.map((name, index) => name + '  \n  ' + checksFor(results[index]).join('  \n  '));
  const groups = links ? [] : groupRows(results, checksFor);
  // A long group names its first and last name, so twenty long labels do not repeat in every heading.
  const shared = groups.flatMap(({ names, lines }) => [
    names.length === results.length ? '**Search checks for every name**'
      : names.length > 5 ? names.length + ' names, ' + names[0] + ' to ' + names.at(-1) : names.join(', '), ...lines,
  ]);
  const rows = shared.length && bytes([...names, ...shared].join('\n')) < bytes(individual.join('\n'))
    ? [...names, '', ...shared] : individual;
  const eligibility = result.eligibility ? [eligibilityLine(result)] : [];
  return [heading, '', ...eligibility, '**Every name** (reasons and prices are in the results below)', ...rows].join('\n');
}

// Dense screens keep whether each source found a match.
function compactCompetition(competition) {
  const found = value => value == null ? null : Array.isArray(value) ? value.length > 0 : Boolean(value);
  return Object.fromEntries(Object.entries(competition).map(([source, value]) =>
    [source, source === 'sameName' ? (typeof value === 'object' ? value?.level ?? null : value) : found(value)]));
}

export const bytes = text => Buffer.byteLength(text);
const withDisplay = (display, { display: ignored, ...data } = {}) => JSON.stringify({ display, ...data });

export const errorText = message => withDisplay(attributed(message));

const progressStage = {
  quotes: 'Registry checks are in; shop prices are being checked.',
  browser: 'The live shop check is running.',
  rivals: 'Domain checks are in; trademark, app and rival checks are still running.',
  handles: 'Domain checks are in; handles for the top three names are being checked.',
};

// The answer when a lookup outlasts this call's budget: what the registries have answered so far, the elapsed
// time against the budget, and how to collect the finished result from the lookup that keeps running.
// rows lists every requested name in input order with the domains it checks: each requested ending for a bare name,
// or the exact domain itself. A row without answers yet still shows every ending as still checking.
export function progressText(progress, { rows = [], elapsedMs = 0, budgetMs = 0, triage = false, purchase = false } = {}) {
  const answers = progress?.answers instanceof Map ? progress.answers : new Map(progress?.answers ?? []);
  const kinds = { 'probably-free': 'free', taken: 'taken', premium: 'premium' };
  const names = rows.map(({ name, domains }) => {
    const exact = String(name).includes('.') && domains.length === 1 && domains[0] === name;
    const groups = { free: [], taken: [], premium: [], shop_check: [], checking: [] };
    for (const domain of domains) {
      const status = answers.get(domain);
      groups[status === undefined ? 'checking' : kinds[status] ?? 'shop_check'].push(exact ? domain : domain.slice(domain.indexOf('.') + 1));
    }
    // The same row shapes as the finished result: check_domains rows list free endings as objects.
    const free = triage ? groups.free : [...groups.free.map(d => ({ d, s: 'nc' })), ...groups.premium.map(d => ({ d, s: 'prem' }))];
    return { name, ...(groups.taken.length && { taken: groups.taken }), ...(free.length && { free }),
      ...(triage && groups.premium.length && { premium: groups.premium }),
      ...(groups.shop_check.length && { shop_check: groups.shop_check }), ...(groups.checking.length && { checking: groups.checking }),
      _groups: groups, _exact: exact };
  });
  const waiting = names.reduce((count, row) => count + row._groups.checking.length, 0);
  const total = names.reduce((count, row) => count + Object.values(row._groups).flat().length, 0);
  const seconds = ms => (Math.max(0, ms) / 1000).toFixed(1) + ' s';
  const show = (row, endings) => endings.map(d => row._exact ? md(d) : '.' + md(d)).join(' ');
  const lines = [
    '**Still checking** after ' + seconds(elapsedMs) + ' (answer budget ' + seconds(budgetMs) + '). The lookup keeps running.',
    'Registry answers so far: ' + (total - waiting) + ' of ' + total + ' domains.',
    ...names.map(row => '- ' + md(row.name) + ': ' + [
      ['free', row._groups.free], ['taken', row._groups.taken], ['premium', row._groups.premium],
      ['not settled', row._groups.shop_check], ['still checking', row._groups.checking],
    ].filter(([, endings]) => endings.length).map(([kind, endings]) => kind + ' ' + show(row, endings)).join(' · ')
      + (row._groups.checking.length ? ', ask again' : '')),
    ...(progressStage[progress?.stage] ? [progressStage[progress.stage]] : []),
    'Prices, ' + (triage ? 'verdicts, ' : '') + 'links and every ending come with the finished result. '
      + (triage ? 'The results page fills in by itself; a repeat call with the same input returns it in chat.'
        : 'Call the same tool again with the same input to collect it from this lookup.'),
  ];
  for (const row of names) {
    delete row._groups;
    delete row._exact;
  }
  return withDisplay(attributed(lines.join('\n'), purchase), {
    complete: false, pending: true, elapsedMs: Math.round(elapsedMs), budgetMs: Math.round(budgetMs),
    ...(progressStage[progress?.stage] && { stage: progress.stage }), names,
  });
}

export function checkText(result, shortlist = false, { purchase = false, preferred } = {}) {
  if (preferred?.length) result = { ...result, names: result.names.map(row => ({ ...row,
    ...(row.free && { free: preferredFirst(row.free, preferred, option => option.d) }),
    ...(row.taken && { taken: preferredFirst(row.taken, preferred) }),
    ...(row.resale && { resale: preferredFirst(row.resale, preferred) }),
    ...(row.shop_check && { shop_check: preferredFirst(row.shop_check, preferred) }),
  })) };
  const initialLevel = (result.names?.length ?? 0) >= 10 ? 3 : 0;
  const shown = checkDisplay(result, initialLevel, purchase);
  const [row] = result.names ?? [];
  const exact = result.names?.length === 1 && row?.name?.includes('.');
  // A registered exact domain already shows the limitation with its status and has no checkout link.
  const taken = exact && registered(row, suffix(row.name));
  const ending = (exact || purchase) && !taken;
  let display = attributed(shown, ending);
  const data = { ...result };
  if (taken && data.purchaseAdvice) data.purchaseAdvice = checkoutLimitation;
  if (shortlist) {
    // The preliminary batch keeps statuses and payments. The display has the confirmed link.
    const quote = ({ y3, jump, shop, ...fields }) => fields;
    delete data.legend;
    delete data.best;
    delete data.buyUrlTemplate;
    delete data.shopCheckWhy;
    delete data.eligibility;
    data.names = data.names.map(row => row?.free ? { ...row, free: row.free.map(option => {
      const { s, ...fields } = quote(option);
      return s === 'nc' ? fields : { ...fields, s };
    }) } : row);
    if (data.listPrices) {
      data.listPrices = Object.fromEntries(Object.entries(data.listPrices).map(([ending, price]) => [ending, quote(price)]));
    }
    const groups = new Map();
    for (const row of data.names) {
      const free = (row.free ?? []).map(option => '.' + option.d
        + (option.risk ? ' (may be premium)' : option.s === 'prem' || option.prem ? ' (premium)' : ''));
      const statuses = ['Free ' + (free.join(' ') || 'none found')];
      for (const [key, heading] of [['taken', 'taken'], ['resale', 'resale'], ['shop_check', 'check at shop']]) {
        if (row[key]?.length) statuses.push(heading + ' ' + row[key].map(ending => '.' + ending).join(' '));
      }
      const statusesText = statuses.join(' · ');
      if (!groups.has(statusesText)) groups.set(statusesText, []);
      groups.get(statusesText).push(md(row.name));
    }
    const lines = ['**Preliminary domain screen**', ...[...groups].map(([available, names]) =>
      names.join(', ') + ' — ' + available)];
    if (result.eligibility) lines.push(eligibilityLine(result));
    const confirmed = shown.split('\n').filter(line => line.startsWith('Confirmed at ') || line.startsWith('Check at shop: ['));
    if (confirmed.length) lines.push(...confirmed);
    return withDisplay(attributed(lines.join('\n'), purchase), data);
  }
  const limit = 7900;
  let level = initialLevel;
  const compactDisplay = next => () => {
    if (next <= level) return;
    level = next;
    display = attributed(checkDisplay(result, level, purchase), ending);
  };
  const steps = [
    // Drop inline prices from unconfirmed rows; the display and the shared list price keep them.
    () => { data.names = data.names.map(row => row?.free
      ? { ...row, free: row.free.map(({ d, s, ...price }) => s === 'nc' ? { d, s } : { d, s, ...price }) } : row); },
    // The display header already says prices are list prices unless confirmed.
    compactDisplay(1),
    // Keep standard prices only for endings that some row could still buy.
    () => {
      const open = new Set(data.names.flatMap(row => [...(row?.free ?? []).map(option => option.d), ...(row?.shop_check ?? [])]));
      data.listPrices = Object.fromEntries(Object.entries(data.listPrices).filter(([d]) => open.has(d)));
    },
    () => { data.listPrices = Object.fromEntries(Object.entries(data.listPrices).map(([d, { y3, ...price }]) => [d, price])); },
    // The display header carries the currency and confirmation key.
    () => { delete data.legend; },
    // A dense batch keeps one line per free domain; standard prices stay on the shared line.
    compactDisplay(2),
    // Unconfirmed is the default status of a free ending.
    () => { data.names = data.names.map(row => row?.free
      ? { ...row, free: row.free.map(({ s, ...option }) => s === 'nc' ? option : { ...option, s }) } : row); },
    compactDisplay(3),
  ];
  const needsPrices = steps.slice(2, 4);
  let text = withDisplay(display, data);
  for (const step of steps) {
    if (bytes(text) <= limit) break;
    if (needsPrices.includes(step) && !data.listPrices) continue;
    step();
    text = withDisplay(display, data);
  }
  return text;
}

// Keep structured evidence keys in the MCP response when secondary details need to fit a shortlist.
export function triageText(result, prior, { purchase = false, preferred } = {}) {
  let dense = false;
  let short = false;
  const render = () => attributed(dense ? denseDisplay(result, short) : triageDisplay(result, prior, { short, preferred }), purchase);
  let display = render();
  const count = result.names?.length ?? 0;
  const data = structuredClone(result);
  if (typeof data.legend === 'string') data.legend = compactTriageLegend;
  // The display carries the three check lines; google stays for the client to fill.
  for (const row of data.names ?? []) {
    delete row.checks;
    for (const key of ['free', 'taken', 'premium', 'shop_check']) if (Array.isArray(row[key])) row[key] = preferredFirst(row[key], preferred);
  }
  let { top, ...fields } = data;
  const serialize = () => JSON.stringify({ display, ...(top && { top }), ...fields });
  const limit = count <= 1 ? 5900 : count <= 5 ? (prior ? 3800 : 5900) : 7800;
  let text = serialize();
  for (const trim of [
    row => { if (row.notes) row.notes = row.notes.slice(0, 1); },
    // The display already shows the rival line.
    row => { delete row.traction; },
    row => { if ('memorable' in row) row.memorable = null; if ('details' in row) row.details = null; },
    row => { if ('notes' in row) row.notes = null; if ('presence' in row) row.presence = null; },
    row => { if ((prior || count > 1) && 'buy' in row) row.buy = null; },
    row => {
      if (!row.competition) return;
      row.competition.mark = null;
      delete row.competition.marks;
      if (typeof row.competition.sameName === 'object') row.competition.sameName = row.competition.sameName?.level ?? null;
      for (const office of ['US', 'EU', 'NO']) {
        if (typeof row.competition[office] === 'string') row.competition[office] = row.competition[office].split(':', 1)[0];
      }
      for (const source of ['AppStore', 'GooglePlay', 'Wikidata']) {
        const match = row.competition[source];
        if (Array.isArray(match) && match.length) row.competition[source] = match[0].name;
        else if (match && !Array.isArray(match) && typeof match === 'object') row.competition[source] = match.name;
      }
    },
  ]) {
    if (bytes(text) <= limit) break;
    fields.names.forEach(trim);
    text = serialize();
  }
  if (prior && count <= 5 && bytes(text) > limit) {
    for (const row of fields.names) row.reason = row.reason?.split(' · ', 1)[0];
    const earlier = new Map(prior.names?.map(row => [row.name, new Set((row.free ?? []).map(option => option.d))]));
    const newlyFree = new Set(fields.names.flatMap(row => (Array.isArray(row.free) ? row.free : [])
      .filter(ending => !earlier.get(label(row.name))?.has(ending))));
    fields.prices = Object.fromEntries(Object.entries(fields.prices ?? {}).filter(([ending, quote]) => {
      const listed = prior.listPrices?.[ending];
      return newlyFree.has(ending) || !listed || quote.now !== listed.now || quote.renew !== listed.renew ||
        (quote.term ?? 1) !== (listed.term ?? 1) || Boolean(quote.jump) !== Boolean(listed.jump);
    }));
    text = serialize();
  }
  const maxBytes = count <= 5 ? (prior ? 5200 : 6000) : 8000;
  const step = change => {
    if (count <= 1 || bytes(text) < maxBytes) return;
    change();
    display = render();
    text = serialize();
  };
  // Link the source labels themselves; the rendered lines read the same.
  step(() => { short = true; });
  step(() => {
    for (const row of fields.names) {
      if (row.competition) row.competition = compactCompetition(row.competition);
      if (row.google) delete row.google.why;
    }
  });
  // The display retains the original spelling. The machine field can use a much shorter DNS label.
  step(() => {
    for (const row of fields.names) if (bytes(String(row.name ?? '')) > label(row.name).length + 8) row.name = label(row.name);
  });
  // The table shows every reason in full.
  step(() => { if (!dense) for (const row of fields.names) row.reason = null; });
  // A large screen keeps one verdict and the three check lines per name; reasons and prices stay in the JSON.
  if (count >= 10) {
    step(() => {
      dense = true;
      fields.names.forEach((row, index) => { row.reason = result.names[index]?.reason ?? null; });
    });
  }
  step(() => { for (const row of fields.names) if (row.reason) row.reason = shorten(row.reason.split(' · ', 1)[0], 60); });
  step(() => {
    if (!prior && !dense) return;
    if (top) top = top.map(({ name, verdict, ending, bestValue }) =>
      ({ name, verdict, ending, ...(bestValue && { bestValue: bestValue.domain?.split('.').at(-1) ?? bestValue }) }));
    for (const row of fields.names) {
      if (row.competition) row.competition = {};
      for (const field of ['buy', 'details', 'memorable', 'notes', 'presence']) if (row[field] === null) delete row[field];
      if (prior && row.reason === null) delete row.reason;
    }
  });
  step(() => {
    if (!prior && !dense) return;
    delete fields.legend;
    delete fields.eligibility; // The eligibility note is already shown above the table.
    for (const row of fields.names) {
      if (Object.keys(row.competition ?? {}).length === 0) delete row.competition;
      for (const field of ['taken', 'shop_check']) if (row[field]?.length === 0) delete row[field];
      if (Object.keys(row.own ?? {}).length === 0) delete row.own;
    }
  });
  step(() => {
    if (!prior) return;
    delete fields.sources;
    for (const row of fields.names) if (row.google && !row.google.search) delete row.google.link;
  });
  if (bytes(text) < maxBytes || count <= 1) return text;
  if (count > 5) {
    const names = result.names.map(({ name, verdict, reason, free, own, taken, shop_check, premium, bestValue, google }) => ({
      name, verdict, reason: shorten(reason?.split(' · ', 1)[0] ?? '', 60), free,
      ...(Object.keys(own ?? {}).length && { own }),
      ...(taken?.length && { taken }),
      ...(shop_check?.length && { shop_check }),
      ...(premium?.length && { premium }),
      ...(bestValue && { bestValue }),
      ...(google?.search && { google }),
    }));
    const renderWith = (links, repeatMetadata = true) => withDisplay(attributed(denseDisplay(result, true, links), purchase), {
      names, prices: result.prices, ...(repeatMetadata && top && { top }),
      ...(repeatMetadata && result.eligibility && { eligibility: result.eligibility }),
    });
    const linked = renderWith(true);
    if (bytes(linked) < maxBytes) return linked;
    const unlinked = renderWith(false);
    if (bytes(unlinked) < maxBytes) return unlinked;
    for (const row of names) {
      row.reason = shorten(row.reason, 24);
      if (row.google) row.google = { result: row.google.result, search: true };
    }
    return renderWith(false, false);
  }

  // Long labels and their repeated search URLs can exhaust even the dense format.
  // Keep every verdict, domain option and price, then add the source links where they fit.
  const names = result.names.map(row => ({
    name: label(row.name) || row.name,
    verdict: row.verdict,
    reason: shorten(String(row.reason ?? '').split(' · ', 1)[0], 95),
    free: row.free,
    ...(row.taken?.length && { taken: row.taken }),
    ...(row.shop_check?.length && { shop_check: row.shop_check }),
    ...(Object.keys(row.own ?? {}).length && { own: row.own }),
    ...(row.bestValue && { bestValue: row.bestValue }),
    ...(row.google?.search && { google: row.google }),
  }));
  for (const row of names) for (const key of ['free', 'taken', 'shop_check']) if (Array.isArray(row[key])) row[key] = preferredFirst(row[key], preferred);
  const compactDisplay = attributed(triageDisplay(result, prior, { compact: true, preferred }), purchase);
  return withDisplay(compactDisplay, { names, prices: result.prices });
}
