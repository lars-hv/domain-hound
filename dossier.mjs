import { buildDossier, dossierDomain, formatMoney } from './clis/domain-check/dossier.mjs';
import { attributed, md } from './display.mjs';

export const dossierTool = {
  name: 'taken_domain_dossier',
  description: 'Use when someone wants a domain that is already taken. Builds a read-only broker dossier: registry facts '
    + '(created, expiry, registrar, name servers, status), what the site does now, public listing evidence, likely owner type, '
    + 'the track (listed, not listed, expiring), a price range only from shown evidence, 3 free alternatives with prices, '
    + 'and a draft for the owner when an inquiry makes sense. Relay the display with its sources. Provide follow-up drafts only '
    + 'on request. Never send a draft, start a watch automatically, or reveal maxBudget to the owner.',
  annotations: { title: 'Taken domain dossier', readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string', minLength: 3, maxLength: 127, description: 'The exact taken domain, like example.com.' },
      maxBudget: { type: 'number', minimum: 0,
        description: 'Optional private walk-away price in USD. Kept out of every draft and the display.' },
    },
    required: ['domain'],
    additionalProperties: false,
  },
};

const day = value => typeof value === 'string' ? value.slice(0, 10) : null;
const time = value => typeof value === 'string' ? value.slice(0, 19).replace('T', ' ') + ' UTC' : 'unknown time';
const money = value => '$' + Number(value).toFixed(2).replace(/\.00$/, '');
const trackText = { listed: 'listed for sale', 'not-listed': 'no verified listing found', expiring: 'expiring', available: 'not registered',
  unknown: 'unknown' };

function source(label, url) {
  if (!/^https?:\/\/[^ <>\s]+$/i.test(url ?? '')) return md(label);
  return '[' + md(label) + '](<' + url + '>)';
}

function registryLine({ registry: r }) {
  const facts = [r.created && 'created ' + day(r.created), r.expires && 'expires ' + day(r.expires),
    r.registrar && 'registrar ' + md(r.registrar), r.nameservers.length && 'name servers ' + md(r.nameservers.join(', ')),
    r.status.length && 'status ' + md(r.status.join(', '))].filter(Boolean);
  const evidence = source(r.source?.method?.toUpperCase() ?? 'no registry answer', r.source?.url);
  const description = r.registered === 'unknown' ? 'no answer (' + md(r.reason) + ')'
    : r.registered === 'free' ? 'not registered' : facts.join(' · ') || 'registered, no details published';
  return 'Registry: ' + description + '. ' + evidence + ', ' + time(r.checkedAt) + '.';
}

function siteLine({ site: s, domain }) {
  const what = {
    live: 'a live site on the domain',
    parked: 'a parked page' + (s.host && s.host !== domain && s.host !== 'www.' + domain ? ' at ' + md(s.host) : ''),
    redirect: 'redirects to ' + md(s.host) + ' (' + (s.finalState === 'no-site' ? 'no page there' : s.finalState) + ')',
    'for-sale-lander': s.fetched ? 'a for-sale page on the domain' : 'redirects to a sale page at ' + md(s.host),
    'no-site': 'no readable site' + (s.reason ? ' (' + md(s.reason) + ')' : ''),
    unknown: 'not settled' + (s.reason ? ' (' + md(s.reason) + ')' : ''),
  }[s.state] ?? 'not settled';
  const target = s.finalUrl && s.finalUrl !== s.url ? ' → ' + source('destination', s.finalUrl) : '';
  return 'Site: ' + what + '. ' + source('Site check', s.url) + target + ', ' + time(s.checkedAt) + '.';
}

function listingLines(data) {
  const { found, signals, checked, unchecked, unavailable } = data.listings;
  const lines = [];
  if (found.length) {
    lines.push('Listing: ' + found.map(row => source(row.source, row.url) + (row.price ? ' at ' + formatMoney(row.price) : ', no price shown')
      + ' (' + time(row.checkedAt) + ')').join('; ') + '.');
  } else {
    const miss = checked.find(row => row.state === 'unknown');
    lines.push(miss ? 'Listing: no exact match in ' + source(miss.name + ' public search', miss.sourceUrl)
      + ' (' + time(miss.checkedAt) + '). Coverage is incomplete.' : 'Listing: no verified public listing found.');
    if (signals.length) lines.push('Sale signal: ' + md(signals[0].signal) + '. ' + source('Destination', signals[0].url)
      + ', ' + time(signals[0].checkedAt) + '.');
  }
  if (unchecked.length) lines.push('Manual marketplace checks: ' + unchecked.map(row => source(row.name, row.manualUrl)).join(', ') + '.');
  if (unavailable.length) lines.push('No answer from: ' + unavailable.map(row => source(row.name, row.manualUrl)
    + ' (' + time(row.checkedAt) + ')').join(', ') + '.');
  return lines;
}

function rangeLine(data) {
  const range = data.fairRange;
  const renewal = data.renewalCost ? ' Standard renewal list price for this ending is ' + money(data.renewalCost.renewal) + '/year. '
    + source(data.renewalCost.shop, data.renewalCost.url) + ', ' + time(data.renewalCost.checkedAt) + '.' : '';
  if (!range) return 'Price range: no sale price evidence, so no range.' + renewal;
  if (range.low == null) return 'Price range: none (' + md(range.note) + ').' + renewal;
  const low = formatMoney({ amount: range.low, currency: range.currency });
  if (range.low === range.high) return 'Public asking price: ' + low + '.' + renewal;
  const high = formatMoney({ amount: range.high, currency: range.currency });
  return 'Observed asking prices run from ' + low + ' to ' + high + '.' + renewal;
}

function trackLine(data) {
  if (data.track === 'expiring') {
    const status = data.expiry.pendingDelete ? 'pending delete' : data.expiry.redemption ? 'redemption period' : null;
    const expiry = data.registry.expires ? ' The registry expiry date is ' + day(data.registry.expires) + '.' : '';
    return 'Next: use watch_domain to watch for release. ' + (status ? 'The registry shows ' + status + '.' : '')
      + expiry + ' The registry did not give a release date.';
  }
  if (data.track === 'available') return 'Next: the registry lists it as not registered. Check price with check_domains.';
  if (data.track === 'unknown') return 'Next: check registration once the registry responds.';
  if (data.drafts?.channel === 'marketplace') return 'Next: use the verified marketplace listing if you want to make an inquiry.';
  return 'Next: if you want to inquire, review the draft and use a public contact route.';
}

export function dossierDisplay(data) {
  const owner = data.owner.type === 'unknown' ? 'Owner type: unknown.'
    : 'Owner type: likely ' + data.owner.type + ' (' + data.owner.confidence + ' confidence). '
    + md(data.owner.basis) + '. ' + source('Public signal', data.owner.url) + ', ' + time(data.owner.checkedAt) + '.';
  const lines = [
    md(data.domain) + ': ' + trackText[data.track],
    registryLine(data), siteLine(data), owner, ...listingLines(data), rangeLine(data), trackLine(data),
  ];
  if (data.alternatives.length) {
    lines.push('', 'Alternatives that appear available (list prices, USD)', ...data.alternatives.map(row => '- '
      + md(row.domain) + ' ' + money(row.price) + (row.renewal != null ? ', renews at ' + money(row.renewal) : '')
      + '. ' + source(row.shop, row.priceUrl) + ', ' + time(row.priceCheckedAt) + '. '
      + source(row.registrySource?.method?.toUpperCase() ?? 'Registry', row.registrySource?.url)
      + ', ' + time(row.registryCheckedAt) + '.'));
  } else {
    lines.push('No available alternatives with a price were verified.');
  }
  if (data.drafts) {
    lines.push('', 'Draft opening note', '', ...data.drafts.opening.split('\n').map(line => '> ' + line));
  }
  return attributed(lines.join('\n'));
}

// Validate, build and format. Throws a plain message for invalid input.
export async function domainDossier(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !Object.hasOwn(dossierTool.inputSchema.properties, key))) {
    throw Error('Enter the exact taken domain, like example.com, and an optional maxBudget.');
  }
  const domain = dossierDomain(input.domain);
  if (!domain) throw Error('Enter one exact domain, like example.com.');
  if (Object.hasOwn(input, 'maxBudget') && (typeof input.maxBudget !== 'number' || !Number.isFinite(input.maxBudget)
    || input.maxBudget < 0)) {
    throw Error('maxBudget must be a nonnegative USD amount.');
  }
  const data = await buildDossier(domain, { ...options, maxBudget: input.maxBudget });
  return { display: dossierDisplay(data), ...data };
}
