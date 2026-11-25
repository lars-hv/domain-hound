import { checkDomainSite } from './clis/domain-check/com-site.mjs';
import { asciiDomain, defaultEndings } from './clis/domain-check/name-search.mjs';
import { lookupRegistrations } from './clis/domain-check/registry.mjs';

export const newsQuestion = 'Domain Hound can also email you news about itself and other developer tools from its maker, BrightBoard AS, at most twice a month. It is optional and your watch works either way. Do you want that?';
const endpoint = 'https://domainhound-alerts.domainhound.workers.dev/watch';
const consentTextVersion = 'news-v1';

export const watchTool = {
  name: 'watch_domain',
  description: 'Check a specific domain’s registry, expiry and website and start a free release watch at the person’s request. '
    + 'Use the email and optional name they gave for this submission. If the email is missing, ask once and never guess. '
    + 'Before submitting, ask exactly: “' + newsQuestion + '” Pass news: true only on an explicit yes, or false if they decline or skip it. '
    + 'This highlights a choice in the confirmation email. Only the email confirmation can start news. Relay say as written.',
  annotations: { title: 'Watch a domain', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string', maxLength: 127, description: 'The exact domain, like example.com.' },
      email: { type: 'string', maxLength: 254, description: 'The email address the person provided. Omit to preview.' },
      name: { type: 'string', maxLength: 80, description: 'Optional name provided by the person.' },
      news: { type: 'boolean', description: 'True only after an explicit yes to the optional news question.' },
    },
    required: ['domain'],
    additionalProperties: false,
  },
};

export async function watchDomain(input, { fetcher = globalThis.fetch, registry = lookupRegistrations,
  siteCheck = checkDomainSite, now = new Date() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !Object.hasOwn(watchTool.inputSchema.properties, key))) {
    throw Error('Enter the exact domain you want to watch.');
  }
  const domain = typeof input.domain === 'string' && input.domain.length <= 127 && asciiDomain(input.domain.trim());
  const ending = domain && domain.split('.').at(-1);
  if (!domain || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z]+$/.test(domain) || !defaultEndings.includes(ending)) {
    throw Error('Enter a supported domain to watch, such as example.com.');
  }
  if (input.news !== undefined && typeof input.news !== 'boolean') throw Error('Optional news must be true or false.');
  if (input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 80 || /[\p{Cc}\p{Cf}]/u.test(input.name))) {
    throw Error('Use up to 80 characters for the optional name.');
  }
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : null;
  if (Object.hasOwn(input, 'email') && (!email || email.length > 254 ||
      !/^[^\s@<>()[\]",;:\\]{1,64}@(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(email))) {
    throw Error('Enter the email address for the watch.');
  }
  const watchUrl = 'https://domainhound.dev/watch/?domain=' + encodeURIComponent(domain);
  const started = performance.now();
  const [[registration], site] = await Promise.all([
    registry([{ domain, tld: ending }], { timeLeft: () => Math.max(0, 4800 - (performance.now() - started)),
      now, dnsFirst: false, readExpiry: true, rdapAttempts: 1 }).catch(() => []),
    siteCheck(domain, 2200, true).catch(() => null),
  ]);
  const siteState = ['live', 'parked', 'for-sale'].includes(site?.state) ? site.state : 'no live site found';
  const status = registration?.status === 'taken' || siteState === 'live' || siteState === 'parked' || siteState === 'for-sale'
    ? 'taken' : registration?.status === 'free' ? 'free' : 'unverified';
  const expiryValue = registration?.expires;
  const expiry = expiryValue && Number.isFinite(Date.parse(expiryValue)) ? expiryValue.slice(0, 10) : null;
  const odds = status === 'free' ? 'The registry lists it as free. Check the price at a shop.'
    : status === 'unverified' ? 'Release odds are unknown.'
      : siteState === 'live' ? 'Low near-term odds. The site is live.'
        : 'Release odds are unknown. Owners can renew after expiry.';
  const lines = [domain + ': ' + status + ' | web: ' + siteState + ' | ' + (expiry ? 'expires ' + expiry : 'expiry unknown'), odds];
  let submission = 'needs-email';
  if (!email) {
    lines.push('Ask for the email address once.', newsQuestion,
      '[Start the free watch](' + watchUrl + '). You confirm by email.');
  } else if (input.news === undefined) {
    submission = 'needs-news-choice';
    lines.push(newsQuestion);
  } else {
    let response;
    try {
      response = await fetcher(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domain, email, ...(input.name?.trim() && { name: input.name.trim() }),
          ...(input.news === true && { news: 'yes' }), source: 'agent', consentTextVersion }) });
    } catch { /* A timeout may occur after the worker has already accepted the request. */ }
    const accepted = response?.status === 202 && (await response.json().catch(() => null))?.ok === true;
    if (accepted) {
      submission = 'accepted';
      lines.push('Check your inbox to start watching. Choose “Confirm watch only” or “Confirm watch + news”. Already watching? Your watch stays on.');
    } else {
      submission = response?.status === 429 ? 'rate-limited' : 'unconfirmed';
      lines.push(response?.status === 429 ? 'Too many tries. Wait a minute.' : 'Signup could not be verified. Check your inbox before trying again.',
        '[Open the watch page](' + watchUrl + ').');
    }
  }
  return { domain, status, expiry, site: siteState, odds, watchUrl, submission, checkedAt: now.toISOString(),
    source: registration?.source ?? null, newsConsentTextVersion: consentTextVersion, say: lines.join('\n') };
}
