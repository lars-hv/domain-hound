import { portfolioDomain } from './clis/portfolio/store.mjs';

export const ownedDomainsSchema = {
  type: 'array', maxItems: 100, items: { type: 'string', maxLength: 253 },
  description: 'Exact domains the user said they own, for example ["acme.ai"].',
};

const preferences = { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 80 } };
export const hostContext = {
  market: { type: 'array', maxItems: 10, items: { type: 'string', pattern: '^[A-Za-z]{2}$' },
    description: 'Known selling markets as country codes, for example ["NO"] for Norway, or ["US", "GB"]. Omit if unknown. Use ZZ for worldwide.' },
  budgetThreeYearUsd: { type: 'number', minimum: 0, maximum: 1_000_000, description: 'Maximum USD due over three years, for example 120.' },
  ownedDomains: ownedDomainsSchema,
  likes: { ...preferences, description: 'Words, styles or endings the user likes, for example ["warm", ".com"].' },
  dislikes: { ...preferences, description: 'Words, styles or endings the user dislikes, for example ["-ify", ".io"].' },
};

const marketEnding = { NO: 'no', SE: 'se', DK: 'dk', DE: 'de', GB: 'co.uk', EU: 'eu' };
export const marketEndings = (market = []) => [...new Set(market.map(code => marketEnding[code.toUpperCase()]).filter(Boolean))];
export const usMarket = (market = []) => !market.length || market.some(code => ['US', 'ZZ'].includes(code.toUpperCase()));

export function validateHostContext(args) {
  const { market, budgetThreeYearUsd, ownedDomains, likes, dislikes } = args;
  const list = (value, max, valid) => value === undefined || (Array.isArray(value) && value.length <= max && value.every(valid));
  const preference = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 80 && !/[\p{Cc}\p{Cf}]/u.test(value);
  if (!list(market, 10, value => typeof value === 'string' && /^[a-z]{2}$/i.test(value))) {
    throw new Error('Market must be a list of up to 10 two-letter country codes.');
  }
  if (budgetThreeYearUsd !== undefined && (!Number.isFinite(budgetThreeYearUsd) || budgetThreeYearUsd < 0 || budgetThreeYearUsd > 1_000_000)) {
    throw new Error('The three-year budget must be a USD amount between 0 and 1,000,000.');
  }
  if (!list(ownedDomains, 100, value => typeof value === 'string' && value.length <= 253 && portfolioDomain(value))) {
    throw new Error('Owned domains must be a list of up to 100 exact domain names.');
  }
  if (!list(likes, 10, preference) || !list(dislikes, 10, preference)) {
    throw new Error('Likes and dislikes must each list up to 10 preferences of up to 80 characters.');
  }
}

const key = text => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export function preferenceScore(text, { likes = [], dislikes = [] }, { ending = false } = {}) {
  const matches = list => list.filter(value => ending
    ? value.trim().toLowerCase().replace(/^\./, '') === text
    : !value.startsWith('.') && key(value) && key(text).includes(key(value))).length;
  return matches(likes) - matches(dislikes);
}

// Explicit caps apply to every offer. An upfront cap on its own retains its legacy meaning.
export function fitsBudget(offer, { budgetThreeYearUsd, budget } = {}, defaultCap) {
  const totalCap = budgetThreeYearUsd ?? (budget === undefined ? defaultCap : undefined);
  return (budget === undefined || offer.firstPaymentUsd <= budget)
    && (totalCap === undefined || offer.threeYearUsd <= totalCap);
}
