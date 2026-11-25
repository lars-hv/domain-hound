import { asciiDomain, domainEnding } from '../domain-check/name-search.mjs';
import { lookupRegistrations } from '../domain-check/registry.mjs';

export const quoteLifetimeMs = 10 * 60_000;
// The registry minimum: .ai registers for two years at a time.
export const minimumYears = domain => domain.endsWith('.ai') ? 2 : 1;

// A full domain in ASCII form with one registrable label, e.g. example.com or example.co.uk.
export function exactDomain(value) {
  const domain = typeof value === 'string' && value.length <= 253 ? asciiDomain(value.trim().replace(/\.$/, '')) : null;
  if (!domain || !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:co\.uk|[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(domain)) return null;
  return domain;
}

// Whole cents as an integer, from Spaceship's decimal string amount.
export function cents(amount) {
  if (typeof amount !== 'string' || !/^\d{1,7}(?:\.\d{1,4})?$/.test(amount)) return null;
  const [whole, fraction = ''] = amount.split('.');
  if (/[1-9]/.test(fraction.slice(2))) return null;
  return Number(whole) * 100 + Number(fraction.slice(0, 2).padEnd(2, '0'));
}
export const dollars = value => (value / 100).toFixed(2);
export const usd = value => '$' + dollars(value);

// Every documented term in years, with the final price that covers that whole term.
function terms(rows) {
  return (Array.isArray(rows) ? rows : []).flatMap(row => {
    const years = row?.period?.unit === 'y' && Number.isSafeInteger(row.period.value) && row.period.value > 0 ? row.period.value : null;
    const final = row?.priceInDefaultCurrency?.finalPrice;
    const amount = cents(final?.amount);
    return years && amount !== null && typeof final.currency === 'string' ? [{ years, amount, currency: final.currency }] : [];
  }).sort((a, b) => a.years - b.years);
}

// Read Spaceship's availability and pricing answers into one offer, or a reason it cannot be quoted.
export function readOffer(domain, availability, pricing, years) {
  const same = body => typeof body?.domain === 'string' && body.domain.toLowerCase() === domain;
  if (!same(availability) || typeof availability.result !== 'string') return { status: 'unknown', reason: 'Spaceship gave no availability answer.' };
  if (availability.result !== 'available') {
    const status = availability.result === 'taken' ? 'taken' : availability.result;
    return { status, reason: status === 'taken' ? 'Spaceship lists it as taken.' : 'Spaceship cannot register it (' + status + ').' };
  }
  if (!same(pricing) || !['standard', 'premium'].includes(pricing.priceClass)) {
    return { status: 'unpriced', reason: 'Spaceship gave no price class for it.' };
  }
  const signal = Array.isArray(availability.premiumPricing) && availability.premiumPricing.length > 0;
  const premium = signal || pricing.priceClass === 'premium';
  if (signal && pricing.priceClass !== 'premium') {
    return { status: 'unpriced', premium, reason: 'Spaceship marks it premium but prices it as standard.' };
  }
  const minimum = minimumYears(domain);
  const offered = terms(pricing.prices?.register).filter(term => term.years >= minimum);
  const term = years === undefined ? offered[0] : offered.find(row => row.years === years);
  if (!term) {
    return { status: 'unpriced', premium, reason: years === undefined ? 'Spaceship lists no registration term for it.'
      : 'Spaceship does not offer ' + years + ' years. Offered: ' + (offered.map(row => row.years).join(', ') || 'none') + '.' };
  }
  const renewTerms = terms(pricing.prices?.renew).filter(row => row.years >= minimum);
  const renewal = renewTerms[0];
  if (!renewal) return { status: 'unpriced', premium, reason: 'Spaceship lists no renewal price for it.' };
  if (term.currency !== 'USD' || renewal.currency !== 'USD') {
    return { status: 'unpriced', premium, reason: 'Spaceship priced it in ' + term.currency + ', not USD.' };
  }
  return { status: 'available', domain, premium, priceClass: pricing.priceClass, years: term.years, amount: term.amount,
    currency: 'USD', renewal: { years: renewal.years, amount: renewal.amount, currency: 'USD' },
    offeredYears: offered.map(row => row.years) };
}

// A fresh registry answer: dnsFirst false skips the DNS shortcut and the availability cache.
export async function freshRegistry(domain, registry = lookupRegistrations) {
  const started = performance.now();
  const [answer] = await registry([{ domain, tld: domainEnding(domain) }], {
    dnsFirst: false, rdapAttempts: 1, timeLeft: () => Math.max(0, 6000 - (performance.now() - started)) }).catch(() => []);
  return ['free', 'taken'].includes(answer?.status) ? answer.status : 'unknown';
}

// Live price and availability for one domain and term, checked now.
export async function liveOffer(domain, { client, registry, years, now = new Date() }) {
  const [availability, pricing, registryStatus] = await Promise.all([
    client.available(domain), client.pricing(domain).catch(() => null), freshRegistry(domain, registry)]);
  const offer = readOffer(domain, availability, pricing, years);
  const checkedAt = now.toISOString();
  if (offer.status === 'available' && registryStatus === 'taken') {
    return { status: 'taken', domain, registry: registryStatus, checkedAt, reason: 'The registry lists it as registered.' };
  }
  return { ...offer, domain, registry: registryStatus, checkedAt };
}

// The fields a quote ID binds. Any change between quote and order refuses the order.
export const boundFields = offer => ({ domain: offer.domain, years: offer.years, amount: offer.amount, currency: offer.currency,
  renewal: offer.renewal, premium: offer.premium, priceClass: offer.priceClass, status: offer.status });

// Exact differences between the quoted and the fresh offer, in plain words.
export function changes(quote, fresh) {
  const found = [];
  if (fresh.status !== 'available') found.push('availability is now ' + fresh.status + (fresh.reason ? ' (' + fresh.reason + ')' : ''));
  else {
    if (fresh.premium !== quote.premium || fresh.priceClass !== quote.priceClass) {
      found.push('premium status changed from ' + quote.priceClass + ' to ' + fresh.priceClass);
    }
    if (fresh.years !== quote.years) found.push('term changed from ' + quote.years + ' to ' + fresh.years + ' years');
    if (fresh.registry !== quote.registry) found.push('registry result changed from ' + quote.registry + ' to ' + fresh.registry);
    if (fresh.amount !== quote.amount || fresh.currency !== quote.currency) {
      found.push('price changed from ' + usd(quote.amount) + ' to ' + usd(fresh.amount));
    }
    if (fresh.renewal.amount !== quote.renewal.amount || fresh.renewal.years !== quote.renewal.years
      || fresh.renewal.currency !== quote.renewal.currency) {
      found.push('renewal changed from ' + usd(quote.renewal.amount) + ' to ' + usd(fresh.renewal.amount));
    }
  }
  return found;
}

const per = years => years === 1 ? 'year' : years + ' years';
const clock = iso => iso.slice(11, 16) + ' UTC';

// "lanternbay.ai: $159.98 now for 2 years, then $159.98 per 2 years. Standard price."
export function offerLine(offer) {
  return offer.domain + ': ' + usd(offer.amount) + ' now for ' + offer.years + (offer.years === 1 ? ' year' : ' years') + ', then '
    + usd(offer.renewal.amount) + ' per ' + per(offer.renewal.years) + '. ' + (offer.premium ? 'Premium price.' : 'Standard price.');
}

export const quoteTimes = quote => 'Checked ' + clock(quote.checkedAt) + ', quote expires ' + clock(quote.expiresAt) + '.';
