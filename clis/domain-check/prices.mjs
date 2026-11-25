import { readFileSync } from 'node:fs';

const terms = JSON.parse(readFileSync(new URL('./terms.json', import.meta.url), 'utf8'));
const termsByShop = new Map(terms.map(item => [item.shop, item]));
export const vatNorway = terms.every(item => item.vatNorway === 'unknown') ? 'unknown' : null;

export const shops = {
  spaceship: { name: 'Spaceship', url: 'https://www.spaceship.com/domain-search/?query=' },
  cloudflare: {
    name: 'Cloudflare',
    url: 'https://www.cloudflare.com/domains/search/?q=',
    note: 'Must use Cloudflare DNS',
  },
  porkbun: { name: 'Porkbun', url: 'https://porkbun.com/checkout/search?q=' },
  namecheap: { name: 'Namecheap', url: 'https://www.namecheap.com/domains/registration/results/?domain=' },
  dynadot: { name: 'Dynadot', url: 'https://www.dynadot.com/domain/search?domain=' },
  namesilo: { name: 'NameSilo', url: 'https://www.namesilo.com/domain/search-domains?query=' },
  gandi: { name: 'Gandi', url: 'https://shop.gandi.net/en/domain/suggest?search=' },
  ionos: { name: 'IONOS', url: 'https://www.ionos.com/domainshop/search?domains=', suffix: '&skipContractSelection=true' },
  hover: { name: 'Hover', url: 'https://www.hover.com/domains/results?q=' },
};

const entities = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"', ndash: '–', mdash: '—' };

export function plain(value) {
  return String(value ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ').replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (entity, key) => {
    if (key[0] !== '#') return entities[key.toLowerCase()] ?? entity;
    const point = key[1]?.toLowerCase() === 'x' ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1));
    return point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  }).replace(/\s+/gu, ' ').trim();
}

export function offer(shop, domain, details) {
  const { name, note } = shops[shop];
  const { privacy, transferOut, dns, owner, sources, checked, transferLockDays, payWithoutCard, trust } = termsByShop.get(name);
  const privacyTerm = details.privacy == null ? privacy : details.privacy === 0
    ? 'Free privacy' : `Privacy listed at $${details.privacy.toFixed(2)}`;
  return {
    shop: name,
    ...details,
    threeYear: threeYearCost(details),
    note: details.note ?? note ?? null,
    terms: {
      lines: [[privacyTerm, transferOut].filter(Boolean).join(' · '), [dns, owner, trust].filter(Boolean).join(' · ')].filter(Boolean),
      sources, checked, transferLockDays, payWithoutCard,
    },
    buyUrl: shopSearchUrl(shop, domain),
  };
}

export function shopSearchUrl(shop, domain) {
  if (!Object.hasOwn(shops, shop)) return null;
  const { url, suffix = '' } = shops[shop];
  return url + encodeURIComponent(domain) + suffix;
}

function cents(amount) {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

export function rankedFirstYear(offer) {
  return offer.codeVerified === true ? offer.firstYear : offer.regularFirstYear;
}

export function threeYearCost(offer) {
  const firstYear = rankedFirstYear(offer);
  return firstYear == null || offer.renewal == null ? null : cents(firstYear + 2 * offer.renewal);
}

export function money(value) {
  if (typeof value === 'string' && /^\$?\s*\d[\d,]*(?:\.\d+)?$/.test(value.trim())) {
    value = Number(value.replace(/[$,\s]/g, ''));
  }
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000000000
    ? cents(value) : null;
}

export function catalogPrice(value) {
  const price = money(value);
  return price !== null && price >= 0.5 && price <= 500 ? price : null;
}

function validCode(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{2,40}$/.test(value) ? value : null;
}

const datedCoupon = /\buntil\s+(\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\s+\d{1,2}(?:,?\s+\d{4})?)(?:\s+(\d{1,2}:\d{2})(?:\s+([A-Z]{2,5}|[+-]\d{2}:?\d{2}))?)?/i;

function promoDate(detail, now) {
  const match = detail.match(datedCoupon);
  if (!match) return { valid: !/\buntil\b/i.test(detail) };
  const [, date, time, zone] = match;
  const withYear = /\b\d{4}\b/.test(date) ? date : date + ', ' + now.getUTCFullYear();
  const expires = Date.parse([withYear, time || '23:59:59.999', zone || 'UTC'].join(' '));
  return { valid: expires >= now.getTime(), expires, label: match[0].replace(/^until\s+/i, 'until ') };
}

function couponPrice(coupon, regular) {
  const amount = money(coupon?.amount);
  if (amount === null) return null;
  const type = String(coupon.type).toLowerCase();
  if (['percent', 'percentage', '%'].includes(type) && amount <= 100) return cents(regular * (1 - amount / 100));
  if (['fixed', 'flat', 'dollar', 'amount', 'usd'].includes(type) && amount <= regular) return cents(regular - amount);
  return null;
}

export function porkbunOffer(body, tld, domain, now, quality = {}) {
  const pricing = body?.pricing?.[tld];
  if (!pricing) return null;
  const regularFirstYear = catalogPrice(pricing.registration);
  const renewal = catalogPrice(pricing.renewal);
  if (regularFirstYear === null || renewal === null) { quality.invalid = true; return null; }
  const coupon = pricing.coupons?.registration;
  const discounted = catalogPrice(couponPrice(coupon, regularFirstYear));
  const expiry = promoDate(coupon?.until ? 'until ' + coupon.until : plain(coupon?.description), now);
  const code = expiry.valid && discounted !== null && discounted < regularFirstYear ? validCode(coupon.code) : null;
  const limit = Number(coupon?.max_per_user);
  const firstYearOnly = [true, 1, '1', 'true', 'yes'].includes(coupon?.first_year_only);
  const transferPrice = catalogPrice(pricing.transfer);
  const row = offer('porkbun', domain, {
    firstYear: code ? discounted : regularFirstYear,
    code,
    codeNote: code ? [
      Number.isSafeInteger(limit) && limit > 0 && `${limit} per customer`,
      firstYearOnly ? 'first year only' : 'New registrations',
      expiry.label,
    ].filter(Boolean).join(' · ') || null : null,
    regularFirstYear,
    renewal,
    transferPrice,
    regularTransferPrice: transferPrice,
    privacy: null,
    source: 'live',
    evidence: 'shop',
    checkedAt: now.toISOString(),
  });
  return row;
}

export function dynadotOffer(html, tld, domain, now, quality = {}) {
  for (const [, row] of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = new Map([...row.matchAll(/<td\b[^>]*\bdata-row-(\w+)[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(([, field, content]) => [field, plain(content)]));
    if (cells.get('name')?.toLowerCase() !== '.' + tld) continue;
    // The smaller table also lists registration prices. The full table has renewal.
    if (!cells.has('renew_price')) continue;
    const regularFirstYear = catalogPrice(cells.get('reg_price'));
    const renewal = catalogPrice(cells.get('renew_price'));
    if (regularFirstYear === null || renewal === null) { quality.invalid = true; return null; }
    const transferPrice = catalogPrice(cells.get('tr_price'));
    const own = offer('dynadot', domain, {
      firstYear: regularFirstYear,
      regularFirstYear,
      code: null,
      codeNote: null,
      renewal,
      transferPrice,
      regularTransferPrice: transferPrice,
      privacy: /^yes$/i.test(cells.get('privacy')) ? 0 : null,
        evidence: 'shop',
      source: 'live',
      checkedAt: now.toISOString(),
    });
    return own;
  }
  return null;
}

export function transferStrategy(offers) {
  offers = offers.filter(offer => offer.threeYear != null);
  if (!offers.length) return null;
  let best = null;
  for (const from of offers) {
    for (const to of offers) {
      if (from === to || to.regularTransferPrice == null) continue;
      const threeYear = cents(rankedFirstYear(from) + to.regularTransferPrice + to.renewal);
      const savings = cents(offers[0].threeYear - threeYear);
      if (savings < 3 || (best && best.savings >= savings)) continue;
      best = {
        from: from.shop,
        to: to.shop,
        threeYear,
        savings,
        lockDays: from.terms.transferLockDays,
        transferPrice: to.regularTransferPrice,
      };
    }
  }
  return best;
}
