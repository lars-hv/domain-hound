// Domain marketplaces for the taken-domain dossier. Fail closed: no marketplace is read automatically until its
// terms are confirmed to permit it and an authorized public endpoint is independently verified. Until then each
// one is a manual link and its listing state is "unchecked". An adapter that is enabled must bind its answer to the
// exact domain; a search page, parking page or failed request never counts as a listing.
import { shopSearchUrl } from './prices.mjs';
import { hostMatches, safeUrl, evidenceUrl } from './safe-web.mjs';
import { atomSearchDocs, exactAtomListingUrl, lookupAtomListing } from './broker-atom.mjs';

const godaddyTerms = 'https://www.godaddy.com/en/legal/agreements/universal-terms-of-service-agreement';
const policy = (note, url) => ({ automated: false, note, url });
const atomManualUrl = domain => 'https://www.atom.com/name/' + encodeURIComponent(domain.replace(/\.com$/, ''));

export const providers = Object.freeze([
  { id: 'afternic', name: 'Afternic / GoDaddy', hosts: ['afternic.com', 'godaddy.com'],
    policy: policy('Public listings require a manual check. The designated portfolio API is for sellers.', godaddyTerms),
    manualUrl: domain => 'https://www.afternic.com/domain/' + encodeURIComponent(domain) },
  { id: 'sedo', name: 'Sedo', hosts: ['sedo.com'],
    policy: policy('Sedo prohibits scraping its marketplace.', 'https://sedo.com/us/about-us/policies/general-terms-and-conditions/'),
    manualUrl: domain => 'https://sedo.com/search/details/?domain=' + encodeURIComponent(domain) },
  // Dan.com forwarded to Afternic when checked on 2026-11-25.
  { id: 'dan', name: 'Dan.com', hosts: ['dan.com', 'undeveloped.com'],
    policy: policy('Dan landers are part of GoDaddy’s aftermarket. Check through Afternic.', 'https://blog.afternic.com/dan-landers-afternic/'),
    manualUrl: domain => 'https://dan.com/buy-domain/' + encodeURIComponent(domain) },
  { id: 'atom', name: 'Atom / Squadhelp', hosts: ['atom.com', 'squadhelp.com'],
    policy: { automated: true, url: atomSearchDocs }, manualUrl: atomManualUrl,
    async check(domain, { signal }) {
      const result = await lookupAtomListing(domain, { signal });
      if (result.status === 'unavailable') throw new Error('Public search unavailable');
      return {
        domain, url: result.listingUrl ?? atomManualUrl(domain), listed: result.status === 'listed',
        price: result.price?.amount, currency: result.price?.currency, sourceUrl: result.url, checkedAt: result.checkedAt,
      };
    } },
  { id: 'spaceship', name: 'Spaceship marketplace', hosts: ['spaceship.com'],
    policy: policy('The documented marketplace search requires signing in.', 'https://www.spaceship.com/knowledgebase/spaceship-connector-mcp/'),
    manualUrl: domain => shopSearchUrl('spaceship', domain) },
]);

// Hosts where a redirect chain stops without a request: marketplaces (terms not confirmed) and ad-parking services.
const otherSaleHosts = ['hugedomains.com', 'buydomains.com', 'brandbucket.com', 'sedoparking.com', 'uniregistry.com'];
const parkingHosts = ['parkingcrew.net', 'bodis.com', 'above.com', 'parklogic.com', 'parked.com', 'parking-page.net',
  'cashparking.com', 'smartname.com', 'domaincontrol.com'];

export function marketplaceFor(host) {
  return providers.find(provider => hostMatches(host, provider.hosts)) ?? null;
}

// Why a redirect target is not fetched, or null when it may be.
export function stopReason(url) {
  const host = url?.hostname;
  if (marketplaceFor(host) || hostMatches(host, otherSaleHosts)) return 'marketplace';
  if (hostMatches(host, parkingHosts)) return 'parking';
  return null;
}

// True when a URL names the exact domain in its path or query (not a longer or shorter name).
export function urlBindsDomain(value, domain) {
  const url = safeUrl(value);
  if (!url) return false;
  if (exactAtomListingUrl(url.href, domain)) return true;
  let text;
  try { text = decodeURIComponent(url.pathname + ' ' + url.search).toLowerCase(); } catch { return false; }
  return new RegExp('(?:^|[^a-z0-9.-])' + domain.replace(/[.]/g, '\\.') + '(?![a-z0-9-]|\\.[a-z0-9])').test(text);
}

const currencies = new Set(['USD', 'EUR', 'GBP']);
const validPrice = value => typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 100_000_000;

// One adapter answer checked against the exact domain and the provider's own hosts.
export function acceptAnswer(provider, domain, answer, checkedAt) {
  const url = evidenceUrl(answer?.url);
  const bound = typeof answer?.domain === 'string' && answer.domain.toLowerCase() === domain;
  if (!bound || !url || !hostMatches(new URL(url).hostname, provider.hosts) || typeof answer.listed !== 'boolean') {
    return { state: 'unavailable', reason: 'answer not bound to this exact domain', checkedAt };
  }
  const matchingPage = provider.id === 'atom' ? exactAtomListingUrl(answer.url, domain)
    : urlBindsDomain(answer.url, domain) && !/^\/(?:search|listings)\/?$/i.test(new URL(url).pathname);
  if (answer.listed && !matchingPage) {
    return { state: 'unavailable', reason: 'listing page does not name this exact domain', checkedAt };
  }
  if (!answer.listed) {
    // Only an endpoint that authoritatively covers every listing can confirm absence.
    return provider.policy.authoritative ? { state: 'not-listed', url, checkedAt } : { state: 'unknown', url, checkedAt };
  }
  const price = validPrice(answer.price) && currencies.has(answer.currency) ? { amount: answer.price, currency: answer.currency } : null;
  return { state: 'listed', url, checkedAt, ...(price && { price }) };
}

// Listing state per marketplace. Unpermitted ones are not contacted and come back "unchecked" with a manual link.
export async function checkListings(domain, { list = providers, signal, clock = () => new Date() } = {}) {
  return Promise.all(list.map(async provider => {
    const row = { id: provider.id, name: provider.name, manualUrl: provider.manualUrl(domain) ?? null,
      ...(provider.policy?.url && { policyUrl: provider.policy.url }) };
    if (provider.policy?.automated !== true || typeof provider.check !== 'function') {
      return { ...row, state: 'unchecked', reason: provider.policy?.note ?? 'No permitted public lookup.',
        checkedAt: clock().toISOString() };
    }
    try {
      const answer = await provider.check(domain, { signal });
      return { ...row, ...acceptAnswer(provider, domain, answer, answer?.checkedAt ?? clock().toISOString()),
        ...(answer?.sourceUrl && { sourceUrl: answer.sourceUrl }),
        ...(provider.id === 'atom' && answer?.listed === false && { reason: 'No exact match in the public search. Coverage is incomplete.' }) };
    } catch {
      return { ...row, state: 'unavailable', reason: signal?.aborted ? 'timed out' : 'no answer', checkedAt: clock().toISOString() };
    }
  }));
}
