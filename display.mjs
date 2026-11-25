import { shopSearchUrl, shops } from './clis/domain-check/prices.mjs';
import { isSearchLink, nameCheckLines } from './clis/domain-check/google-search.mjs';
import { canRecommend } from './clis/domain-check/name-search.mjs';

export { showAsIs } from './clis/domain-check/naming-method.mjs';
export const neverBuys = 'Domain Hound never buys; open the link to buy.';
export const attribution = 'via domainhound.dev';

// Every MCP display ends with one attribution line. The blank line keeps it out of a preceding table or list.
export const attributed = display => String(display ?? '').trimEnd() + '\n\n' + attribution;

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
const label = name => String(name).normalize('NFKD').toLowerCase().replace(/[^a-z0-9-]/g, '');
const fullDomain = (name, d) => d.includes('.') ? d : name + '.' + d;

export function safeLink(url, domain) {
  if (!/^[a-z0-9-]+\.[a-z0-9-]+$/i.test(domain) ||
      !registrarIds.some(id => shopSearchUrl(id, domain) === url)) return null;
  return '[' + domain + '](' + url + ')';
}

function templateLink(templates, shop, domain) {
  const template = templates?.[shop];
  return typeof template === 'string' && template.includes('{domain}')
    ? safeLink(template.replace('{domain}', encodeURIComponent(domain)), domain) : null;
}

function eligibilityLine(result) {
  return Object.entries(result.eligibility ?? {}).map(([ending, note]) => '.' + ending + ' — ' + md(note) + '.').join(' ');
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

// ".co $3.11/$31.05" with the term when a payment covers more than one year.
function priced(ending, price) {
  if (price?.now == null) return ending + ' price at shop';
  const renew = price.renew != null ? '/' + money(price.renew) : '';
  return ending + ' ' + money(price.now) + renew + (price.term > 1 ? ' ' + price.term + 'y' : '');
}

function checkRow(row) {
  const name = row.name;
  const ending = d => d.includes('.') ? d : '.' + d;
  const free = (row.free ?? []).map(option => {
    const own = option.now != null;
    const mark = option.s === 'ok' ? ' ✓' : '';
    return own ? priced(ending(option.d), option) + mark : ending(option.d) + mark;
  });
  const usesStandard = (row.free ?? []).filter(option => option.now == null).map(option => option.d);
  return {
    name, usesStandard,
    free: free.join(' '),
    taken: [...(row.taken ?? []).map(ending), ...(row.resale ?? []).map(d => ending(d) + ' (resale)')].join(' '),
    check: (row.shop_check ?? []).map(ending).join(' '),
  };
}

function exactDisplay(result) {
  const row = result.names?.[0] ?? {};
  const domain = row.name;
  const ending = domain.split('.').at(-1);
  const checked = result.checkedAt ? ' Checked ' + String(result.checkedAt).slice(0, 16).replace('T', ' ') + ' UTC.' : '';
  if (row.resale?.includes(ending)) {
    return ['**' + domain + ' is taken.** The owner may list it for resale.' + checked,
      '', 'For domains with a checkout link:', neverBuys].join('\n');
  }
  if (row.taken?.includes(ending)) {
    return ['**' + domain + ' is taken.** It is already registered.' + checked,
      '', 'For domains with a checkout link:', neverBuys].join('\n');
  }
  const free = row.free?.find(option => option.d === ending);
  if (free) {
    const offer = { ...result.listPrices?.[ending], ...free };
    const best = result.best?.domain === domain ? result.best : null;
    const shop = offer.shop ?? best?.shop;
    const link = safeLink(best?.buyUrl, domain) ?? templateLink(result.buyUrlTemplate, shop, domain);
    const confirmed = offer.s === 'ok';
    const term = offer.term > 1 ? ' for ' + offer.term + ' years' : '';
    const live = !confirmed && result.liveCheck?.domain === domain ? liveCheckLine(result) : '';
    const lines = [
      '**' + domain + ' is free.** ' + (confirmed ? 'Exact quote confirmed by ' + (shop ?? 'the shop') + '.'
        : 'The registry shows it free; prices are list estimates until checkout.') + checked,
      '',
      '| Domain | Today | Renewal | 3 years | Checkout |',
      '|---|---|---|---|---|',
      '| ' + domain + ' | ' + (offer.now != null ? money(offer.now) + term : 'price at shop') + ' | '
        + (offer.renew != null ? money(offer.renew) + (offer.term > 1 ? term : '/yr') : '—') + (offer.jump ? ' (renewal jump)' : '')
        + ' | ' + (offer.y3 != null ? money(offer.y3) : '—') + ' | ' + (link ? link + (shop ? ' at ' + md(shop) : '') : '—') + ' |',
      '',
      ...(live ? [live] : []),
      'USD ex. VAT.' + (confirmed ? '' : ' Estimate: the shop shows the final price.'),
      ...(result.eligibility ? [eligibilityLine(result)] : []),
      neverBuys,
    ];
    return lines.join('\n');
  }
  const why = result.shopCheckWhy?.[ending];
  const shop = Object.keys(result.buyUrlTemplate ?? {})[0];
  const link = templateLink(result.buyUrlTemplate, shop, domain);
  const live = result.liveCheck?.domain === domain ? liveCheckLine(result, !link) : '';
  return ['**' + domain + ': not settled.** The registry did not settle it' + (why ? ' (' + md(why) + ')' : '')
    + '. Check at shop' + (link ? ': ' + link : '') + '. No price yet.' + checked,
    ...(live ? [live] : []),
    '', 'For domains with a checkout link:', neverBuys].join('\n');
}

export function checkDisplay(result) {
  const rows = (result.names ?? []).filter(Boolean);
  if (rows.length === 1 && rows[0].name?.includes('.')) return exactDisplay(result);
  const listPrices = result.listPrices ?? {};
  const groups = new Map();
  const standard = new Set();
  for (const row of rows) {
    const cells = checkRow(row);
    cells.usesStandard.forEach(d => standard.add(d));
    const key = JSON.stringify([cells.free, cells.taken, cells.check]);
    if (!groups.has(key)) groups.set(key, { names: [], ...cells });
    groups.get(key).names.push(cells.name);
  }
  const shared = [...standard].filter(d => !d.includes('.'))
    .map(d => priced('.' + d, listPrices[d])).join(' · ');
  const lines = [
    '**Domain check, ' + rows.length + (rows.length === 1 ? ' name' : ' names') + '** (USD ex. VAT, today/renewal; '
      + 'estimates unless ✓ shop-confirmed; 2y = two-year payments)',
  ];
  if (shared) lines.push('Standard prices: ' + shared);
  if (result.eligibility) lines.push(eligibilityLine(result));
  lines.push('', '| Names | Free | Taken | Check at shop |', '|---|---|---|---|');
  for (const group of groups.values()) {
    lines.push('| ' + group.names.join(', ') + ' | ' + (group.free || '—') + ' | ' + (group.taken || '—') + ' | '
      + (group.check || '—') + ' |');
  }
  lines.push('');
  const reasons = new Map();
  for (const [ending, reason] of Object.entries(result.shopCheckWhy ?? {})) {
    if (!reasons.has(reason)) reasons.set(reason, []);
    reasons.get(reason).push(ending.includes('.') ? ending : '.' + ending);
  }
  for (const [reason, endings] of reasons) lines.push(endings.join(', ') + ' — ' + md(reason) + '.');
  if (result.complete === false) lines.push('Some checks did not finish in time; check those at a shop.');
  const best = result.best;
  const link = best && safeLink(best.buyUrl, best.domain);
  if (link) {
    lines.push('Confirmed: ' + link + ' ' + (best.priceNow != null ? money(best.priceNow) : 'price at shop')
      + (best.renewal != null ? '/' + money(best.renewal) : '') + (best.term > 1 ? ' ' + best.term + 'y' : '')
      + (best.shop ? ' at ' + md(best.shop) : '') + '.');
    lines.push(neverBuys);
  } else if (result.liveCheck) {
    const live = liveCheckLine(result);
    if (live) lines.push(live, neverBuys);
  }
  return lines.join('\n').trim();
}

function bestValueLine(domain, quote) {
  if (quote?.now == null || quote.renew == null) return '';
  const term = quote.term > 1 ? ' (each payment covers ' + quote.term + ' years)' : '';
  return 'Best value: ' + md(domain) + ' ' + money(quote.now) + ' now, ' + money(quote.renew) + ' renewal' + term;
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

function topLines(result, showReason, showValue = true) {
  return ['**Top picks**', ...result.top.map(row => {
    const ending = row.domain ?? (row.ending && '.' + row.ending);
    const domain = ending ? ', ' + priced(ending, row) : '';
    const value = !showValue ? '' : typeof row.bestValue === 'string'
      ? rowBestValue(result.names.find(candidate => candidate.name === row.name), result.prices)
      : row.bestValue && bestValueLine(row.bestValue.domain, row.bestValue);
    return '- **' + md(row.name) + '** — ' + md(row.verdict) + domain + (showReason ? '. ' + md(row.reason) : '')
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

export function triageDisplay(result, prior, sharePrices = false, short = false) {
  const prices = result.prices ?? {};
  const rows = (result.names ?? []).filter(Boolean);
  const earlierRows = new Map((prior?.names ?? []).map(row => [row.name, row.free ?? []]));
  const lines = [];
  if (result.top?.length) lines.push(...topLines(result, !prior, !prior), '');
  lines.push(prior ? '**Name screen** (USD ex. VAT, estimates)' :
    '**Name screen** (USD ex. VAT; list estimates, the shop shows the final price; 2y = each payment covers two years)');
  if (result.eligibility) lines.push(eligibilityLine(result));
  if (sharePrices) {
    const standard = Object.entries(prices).map(([ending, price]) => priced('.' + ending, price));
    if (standard.length) lines.push('Standard today/renewal: ' + standard.join(', '));
  }
  const checkoutHeading = prior ? 'Cheapest eligible / checkout' : 'Checkout';
  lines.push('', '| Name | Verdict and reason | Free endings, today/renewal, cheapest first | ' + checkoutHeading + ' | Search checks |',
    '|---|---|---|---|---|');
  for (const row of rows) {
    const base = label(row.name);
    const free = Array.isArray(row.free) ? row.free : [];
    const first = free.find(ending => canRecommend(ending, result.eligible));
    const cheapestYear = free.filter(ending => canRecommend(ending, result.eligible))
      .find(ending => {
        const quote = row.own?.[ending] ?? prices[ending];
        return quote?.now != null && (quote.term ?? 1) === 1;
      });
    const link = first && base ? safeLink(row.buy, fullDomain(base, first)) : null;
    const checkoutPrice = prior && link && (row.own?.[first] ?? prices[first]);
    const cell = free.map(ending => {
      const own = row.own?.[ending];
      return sharePrices && !own && prices[ending] && (ending !== cheapestYear || (checkoutPrice && ending === first))
        ? '.' + ending : priced('.' + ending, own ?? prices[ending]);
    });
    const earlier = earlierRows.get(base) ?? [];
    const previous = option => priced('.' + option.d, option.now != null ? option : prior.listPrices?.[option.d]);
    const recheck = earlier.filter(option => row.shop_check?.includes(option.d));
    const taken = earlier.filter(option => row.taken?.includes(option.d));
    const exact = earlier.filter(option => option.s === 'ok' && free.includes(option.d) &&
      option.now !== (row.own?.[option.d] ?? prices[option.d])?.now);
    if (row.shop_check?.length) cell.push('check at shop: ' + row.shop_check.map(ending => '.' + ending).join(' '));
    if (recheck.length) cell.push('earlier price, recheck: ' + recheck.map(previous).join(', '));
    if (taken.length) cell.push('earlier price, now taken: ' + taken.map(previous).join(', '));
    if (exact.length) cell.push('earlier shop quote: ' + exact.map(previous).join(', '));
    const checkout = checkoutPrice ? priced(link, checkoutPrice) : link ?? '—';
    const value = rowBestValue(row, prices);
    lines.push('| ' + md(row.name) + ' | ' + md(row.verdict) + ': ' + md(row.reason) + tractionLine(row, Boolean(prior) || short) + ' | '
      + (cell.join(', ') || 'none free') + (value ? '<br>' + value : '') + ' | ' + checkout + ' | '
      + checkLines(row, short).join('<br>') + ' |');
  }
  if (!prior) lines.push('', 'Choose a favorite, if you want, and ask for its exact quote.');
  return lines.join('\n');
}

const shorten = (value, length) => value.length > length ? value.slice(0, length - 1).trimEnd() + '…' : value;

function denseDisplay(result, short = false) {
  const heading = result.top?.length ? topLines(result, false).join('\n') : '**Name screen**';
  const rows = (result.names ?? []).filter(Boolean).map(row => '- **' + md(row.name) + '** — ' + md(row.verdict)
    + '  \n  ' + checkLines(row, short).join('  \n  '));
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

export function checkText(result, shortlist = false) {
  const shown = checkDisplay(result);
  const display = attributed(shown);
  const data = { ...result };
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
      const available = (row?.free ?? []).map(option => '.' + option.d).join(' ') || 'none found';
      if (!groups.has(available)) groups.set(available, []);
      groups.get(available).push(md(row?.name));
    }
    const lines = ['**Preliminary domain screen** (free endings)', ...[...groups].map(([available, names]) =>
      names.join(', ') + ' — ' + available)];
    if (result.eligibility) lines.push(eligibilityLine(result));
    const confirmed = shown.split('\n').filter(line => line.startsWith('Confirmed: ') || line.startsWith('Check at shop: '));
    if (confirmed.length) lines.push(...confirmed);
    return withDisplay(attributed(lines.join('\n')), data);
  }
  const limit = 7900;
  const steps = [
    // Drop inline prices from unconfirmed rows; the shared list price stays.
    () => { data.names = data.names.map(row => row?.free
      ? { ...row, free: row.free.map(({ d, s, ...price }) => s === 'nc' ? { d, s } : { d, s, ...price }) } : row); },
    // Keep standard prices only for endings that some row could still buy.
    () => {
      const open = new Set(data.names.flatMap(row => [...(row?.free ?? []).map(option => option.d), ...(row?.shop_check ?? [])]));
      data.listPrices = Object.fromEntries(Object.entries(data.listPrices).filter(([d]) => open.has(d)));
    },
    () => { data.listPrices = Object.fromEntries(Object.entries(data.listPrices).map(([d, { y3, ...price }]) => [d, price])); },
    // The display header carries the currency and confirmation key.
    () => { delete data.legend; },
  ];
  let text = withDisplay(display, data);
  for (const step of steps) {
    if (bytes(text) <= limit) break;
    if (step !== steps[0] && step !== steps.at(-1) && !data.listPrices) continue;
    step();
    text = withDisplay(display, data);
  }
  return text;
}

// Keep structured evidence keys in the MCP response when secondary details need to fit a shortlist.
export function triageText(result, prior) {
  let shared = false;
  let dense = false;
  let short = false;
  const render = () => attributed(dense ? denseDisplay(result, short) : triageDisplay(result, prior, shared, short));
  let display = render();
  const count = result.names?.length ?? 0;
  const data = structuredClone(result);
  if (typeof data.legend === 'string') data.legend = compactTriageLegend;
  // The display carries the three check lines; google stays for the client to fill.
  for (const row of data.names ?? []) delete row.checks;
  let { top, ...fields } = data;
  const serialize = () => JSON.stringify({ ...(top && { top }), display, ...fields });
  const limit = count <= 1 ? 5900 : count <= 5 ? (prior ? 3800 : 5900) : 9900;
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
      if (typeof row.competition.sameName === 'object') row.competition.sameName = row.competition.sameName?.level ?? null;
      if (typeof row.competition.US === 'string') row.competition.US = row.competition.US.split(':', 1)[0];
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
  if (count > 1 && bytes(text) > limit) {
    shared = true;
    display = render();
    text = serialize();
  }
  if (prior && count <= 5 && bytes(text) > limit) {
    for (const row of fields.names) row.reason = row.reason?.split(' · ', 1)[0];
    fields.prices = Object.fromEntries(Object.entries(fields.prices ?? {}).filter(([ending, quote]) => {
      const earlier = prior.listPrices?.[ending];
      return !earlier || quote.now !== earlier.now || quote.renew !== earlier.renew ||
        (quote.term ?? 1) !== (earlier.term ?? 1) || Boolean(quote.jump) !== Boolean(earlier.jump);
    }));
    text = serialize();
  }
  const maxBytes = count <= 5 ? (prior ? 5200 : 6000) : 10_000;
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
  if (count <= 1 || count > 5 || bytes(text) < maxBytes) return text;

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
  const summary = result.names.map(row => '- **' + md(row.name) + '** — ' + md(row.verdict)
    + (row.reason ? ': ' + md(shorten(row.reason, 200)) : ''));
  const header = ['**Name screen** (prices and reasons in the results)', ...(result.eligibility ? [eligibilityLine(result)] : [])];
  const dataOnly = { names, prices: result.prices };
  const fit = lines => JSON.stringify({ display: attributed([...header, ...lines].join('\n')), ...dataOnly });
  const links = fit(summary.map((line, index) => line + '  \n  ' + checkLines(result.names[index], true).join('  \n  ')));
  return bytes(links) < maxBytes ? links : fit(summary);
}
