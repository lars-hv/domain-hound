import { setTimeout as delay } from 'node:timers/promises';
import { cacheDir, readCache, writeCache } from './cache.mjs';
import { money, shops, shopSearchUrl } from './prices.mjs';

const budget = 20_500;
const shopBudget = 10_000;
const cacheLifetime = 15 * 60_000;
const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const dollars = String.raw`\$\s*(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}`;
const priceLine = new RegExp('^' + dollars + '$');
const dynadotPrices = new RegExp('^(?:' + dollars + '){1,2}$');
const lastPrice = new RegExp(dollars + '$');
const spaceshipRenewal = new RegExp('^Renews (' + dollars + ')$', 'i');
const dynadotRenewal = new RegExp('^Renewal (' + dollars + ')$', 'i');
const namecheapPrice = new RegExp('^(' + dollars + ')/yr$', 'i');
const namecheapRenewal = new RegExp('^Renews at (' + dollars + ')/yr\\.?$', 'i');
const cloudflareQuote = new RegExp('^Buy now: ([a-z0-9.-]+) for (' + dollars + ')\\. Renews at (' + dollars + ') per year\\.$', 'i');
const taken = /^(?:Taken|Registered in \d{4})$/i;
const premiumLabel = /^(?:Premium|Premium domain)$/i;
const trackerRoots = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'googlesyndication.com',
  'facebook.net', 'facebook.com', 'nr-data.net', 'newrelic.com', 'crazyegg.com',
  'engagement.ai', 'spotify.com', 'clarity.ms', 'hotjar.com', 'tiktok.com', 'bing.com',
  'googleadservices.com', 'segment.io', 'segment.com', 'ads-twitter.com', 'analytics.twitter.com',
];
const blockedResources = ['Image', 'Font', 'Media'];
const blockedUrls = [
  ...trackerRoots.flatMap(root => ['*://' + root + '/*', '*://*.' + root + '/*']),
  '*://www.google.com/ccm/*', '*://www.google.com/rmkt/*', '*://www.google.com/pagead/*',
];

async function blockStorefrontRequests(page) {
  let client;
  try {
    client = await page.context().newCDPSession(page);
    await client.send('Network.enable');
    await client.send('Network.setBlockedURLs', { urls: blockedUrls });
    client.on('Fetch.requestPaused', ({ requestId }) => {
      void client.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    });
    await client.send('Fetch.enable', {
      patterns: blockedResources.map(resourceType => ({ resourceType })),
    });
  } catch {
    await client?.detach().catch(() => {});
    await page.route?.('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      const blocked = blockedResources.some(type => type.toLowerCase() === request.resourceType()) ||
        trackerRoots.some(root => url.hostname === root || url.hostname.endsWith('.' + root));
      return blocked ? route.abort() : route.continue();
    });
  }
}

const blocked = /performing security verification|verify (?:that )?you are human|just a moment|hardcore hacker detected|access denied|awaiting verification|pork captcha/i;

function linesOf(text) {
  return text.split('\n').map(line => line.trim()).filter(Boolean);
}

function quote(price, renewal, premium) {
  return { available: true, premium, price, renewal };
}

function unavailable(premium = false) {
  return { available: false, premium, price: null, renewal: null };
}

export function parseSpaceship(text, domain, badge = false) {
  const lines = linesOf(text);
  const [label, tld] = domain.split('.');
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i].toLowerCase();
    const split = start === label && lines[i + 1]?.toLowerCase() === '.' + tld;
    if (!split && start !== domain) continue;
    let cursor = i + (split ? 2 : 1);
    let premium = badge;
    const isPremium = () => premiumLabel.test(lines[cursor]);
    if (isPremium() && priceLine.test(lines[cursor + 1])) {
      premium = true;
      cursor++;
    }
    if (taken.test(lines[cursor])) return unavailable(premium);
    let price = null;
    for (let count = 0; count < 2 && priceLine.test(lines[cursor]); count++) {
      price = money(lines[cursor++]);
    }
    const renewalText = lines[cursor]?.match(spaceshipRenewal)?.[1];
    if (renewalText) cursor++;
    if (isPremium() && /^Add to cart$/i.test(lines[cursor + 1])) {
      premium = true;
      cursor++;
    }
    if (price > 0 && (renewalText || premium) && /^Add to cart$/i.test(lines[cursor])) {
      return quote(price, money(renewalText), premium);
    }
  }
  return null;
}

export function parseSpaceshipRows(rows, domains) {
  const results = new Map();
  const wanted = new Set(domains);
  for (const { domain, text, premium, canBuy, currentPrice } of rows) {
    if (!wanted.has(domain)) continue;
    // Some rows render the cart action as an icon with an accessible label.
    const action = canBuy && !/^Add to cart$/im.test(text) ? '\nAdd to cart' : '';
    const parsed = parseSpaceship(text + action, domain, premium);
    if (!parsed || (parsed.available && canBuy === false)) continue;
    if (parsed.available && priceLine.test(currentPrice)) parsed.price = money(currentPrice);
    const previous = results.get(domain);
    // Prioritize explicit taken or premium disclosures from a duplicate card.
    if (!previous || (previous.available && (!parsed.available || (parsed.premium && !previous.premium)))) {
      results.set(domain, parsed);
    }
  }
  return results;
}

export function parseDynadot(text, domain, badge = false) {
  const [name, ...lines] = linesOf(text);
  if (name?.toLowerCase() !== domain) return null;
  const premium = badge || lines.some(line => premiumLabel.test(line));
  if (lines.some(line => taken.test(line) || /^Place Backorder$/i.test(line))) return unavailable(premium);
  const renewal = money(lines.map(line => line.match(dynadotRenewal)?.[1]).find(Boolean));
  const prices = lines.find(line => dynadotPrices.test(line));
  const price = money(prices?.match(lastPrice)?.[0]);
  return price > 0 && (renewal > 0 || premium) && (premium || lines.includes('is available'))
    ? quote(price, renewal, premium) : null;
}

export function parseNamecheap(text, domain, badge = false) {
  const [name, ...lines] = linesOf(text);
  if (name?.toLowerCase() !== domain) return null;
  const premium = badge || lines.some(line => premiumLabel.test(line));
  if (lines.some(line => taken.test(line) || /^Make offer$/i.test(line))) return unavailable(premium);
  const price = money(lines.map(line => line.match(namecheapPrice)?.[1]).find(Boolean));
  const renewal = money(lines.map(line => line.match(namecheapRenewal)?.[1]).find(Boolean));
  return price > 0 && lines.some(line => /^Add to cart$/i.test(line)) ? quote(price, renewal, premium) : null;
}

export function parseCloudflare(text, domain, badge = false, buyLabel = '') {
  const lines = linesOf(text);
  const premium = badge || lines.some(line => premiumLabel.test(line));
  if (lines.at(-1) === 'Unavailable' && lines.slice(0, -1).join('').toLowerCase() === domain) {
    return unavailable(premium);
  }
  const match = buyLabel?.match(cloudflareQuote);
  return match?.[1].toLowerCase() === domain ? quote(money(match[2]), money(match[3]), premium) : null;
}

// Cloudflare renders a buy price before its exact-domain availability check settles.
export function cloudflareSettlement(domain) {
  let searchId;
  let exactId;
  let settled = null;
  return {
    read() { return settled; },
    receive(message) {
      let item;
      if (message?.type === 'results.snapshot' && Array.isArray(message.items)) {
        item = message.items.find(row => row?.fqdn === domain);
        if (!item || typeof item.id !== 'string' || !Number.isSafeInteger(message.searchId)) return;
        if (searchId !== message.searchId || exactId !== item.id) settled = null;
        searchId = message.searchId;
        exactId = item.id;
      } else if (message?.type === 'results.delta' && exactId && message.searchId === searchId &&
          Array.isArray(message.patches)) {
        item = message.patches.find(row => row?.id === exactId);
      }
      if (item?.status === 'taken') settled = { available: false, premium: false };
      if (item?.status === 'available' && typeof item.premium === 'boolean') {
        settled = { available: true, premium: item.premium };
      }
    },
  };
}

const adapters = {
  spaceship: {
    rows: '[data-zid="instantSearchMainResult"], [data-zid="instantSearchDomainListItem"]',
    name: '[data-zid="instantSearchMainResultName"], [data-zid="instantSearchDomainName"]',
    premium: '.domain-status-icons-icon-premium, [aria-label="Premium"]',
    parse: parseSpaceship,
  },
  dynadot: {
    rows: '.result-row',
    name: '.search-domain-word',
    premium: '[aria-label="Premium"], [title="Premium"]',
    parse: parseDynadot,
  },
  namecheap: {
    rows: 'section.standard article',
    name: 'h2',
    premium: '.premium, [aria-label="Premium"], [title="Premium"]',
    parse: parseNamecheap,
  },
  cloudflare: {
    rows: '.registrar-result-card',
    name: '[data-domain-name]',
    premium: '[aria-label="Premium"], [title="Premium"]',
    buyLabel: 'button[aria-label^="Buy now:"]',
    parse: parseCloudflare,
  },
};

async function readResult(page, adapter, domain, timeout) {
  const { rows, name, premium, buyLabel } = adapter;
  return page.locator('body').evaluate((body, selectors) => {
    const exact = [...body.querySelectorAll(selectors.rows)].filter(row => {
      const name = row.querySelector(selectors.name);
      return name?.textContent.replace(/\s/g, '').toLowerCase() === selectors.domain &&
        row.getClientRects().length > 0;
    });
    return {
      rows: exact.map(row => {
        const cart = selectors.cart && [...row.querySelectorAll('button, [role="button"]')].find(button =>
          button.matches('[data-zid="instantSearchAddToCartButton"], [data-zid="instantSearchMainResultAddToCart"], [aria-label="Add to cart"]') ||
          button.innerText.trim() === 'Add to cart');
        const enabled = cart ? !cart.disabled && cart.getAttribute('aria-disabled') !== 'true' : undefined;
        return {
          domain: selectors.domain,
          text: row.innerText,
          premium: row.matches(selectors.premium) || Boolean(row.querySelector(selectors.premium)),
          buyLabel: selectors.buyLabel ? row.querySelector(selectors.buyLabel)?.getAttribute('aria-label') : '',
          currentPrice: selectors.spaceship ? row.querySelector('.price-current')?.innerText.trim() : undefined,
          canBuy: selectors.spaceship ? Boolean(enabled) : enabled,
        };
      }),
      pageStatus: exact.length ? '' : document.title + '\n' + body.innerText.slice(0, 350),
    };
  }, { rows, name, premium, buyLabel, domain, spaceship: adapter === adapters.spaceship,
    cart: adapter === adapters.spaceship || adapter === adapters.namecheap }, { timeout });
}

function unknown(reason) {
  return { available: null, premium: false, price: null, renewal: null, reason };
}

const timedOut = 'Shop check timed out.';

async function checkShop(page, shop, domain, deadline) {
  const remaining = () => Math.max(1, Math.ceil(deadline - performance.now()));
  const url = shopSearchUrl(shop, domain);
  const origin = new URL(url).origin;
  const adapter = Object.hasOwn(adapters, shop) ? adapters[shop] : null;
  if (!adapter) return unknown('Shop has no supported exact-domain result.');
  if (performance.now() >= deadline) return unknown(timedOut);
  try {
    const response = await page.goto(url, { waitUntil: 'commit', timeout: remaining() });
    if ([401, 403, 429].includes(response?.status())) return unknown('Shop blocked the check.');
    if (!response?.ok()) return unknown('Shop search is unavailable.');
    while (performance.now() < deadline) {
      if (new URL(page.url()).origin !== origin) return unknown('Shop redirected the check.');
      const result = await readResult(page, adapter, domain, remaining());
      if (blocked.test(result.pageStatus)) return unknown('Shop blocked the check.');
      if (shop === 'spaceship') {
        const quote = parseSpaceshipRows(result.rows, [domain]).get(domain);
        if (quote) return quote;
      } else {
        for (const row of result.rows) {
          const parsed = adapter.parse(row.text, domain, row.premium, row.buyLabel);
          if (parsed && !(parsed.available && row.canBuy === false)) return parsed;
        }
      }
      await delay(Math.min(200, remaining()));
    }
    return unknown(timedOut);
  } catch (error) {
    return unknown(error?.name === 'TimeoutError' ? timedOut : 'Shop search is unavailable.');
  }
}

export async function withShopPages(deadline, run, {
  env = process.env, launch, onFailure = unknown,
} = {}) {
  let browser;
  let timer;
  let expired = false;
  async function work() {
    if (!launch) {
      try {
        const { chromium } = await import(env.DOMAIN_HOUND_PLAYWRIGHT || 'playwright');
        launch = options => chromium.launch(options);
      } catch { return onFailure('Playwright is unavailable.'); }
    }
    if (expired) return onFailure(timedOut);
    try {
      browser = await launch({ headless: true, timeout: Math.min(4000, Math.max(1, deadline - performance.now())) });
      if (expired) return onFailure(timedOut);
      const context = await browser.newContext({
        userAgent, locale: 'en-US', viewport: { width: 1280, height: 900 }, serviceWorkers: 'block',
      });
      async function openPage() {
        const page = await context.newPage();
        try {
          await blockStorefrontRequests(page);
          return page;
        } catch (error) {
          await page.close().catch(() => {});
          throw error;
        }
      }
      return await run(async (domain, usePage) => {
        let page;
        try {
          if (expired) return unknown(timedOut);
          page = await openPage();
          return await usePage((shop, until) => checkShop(page, shop, domain, Math.min(until, deadline)));
        } catch {
          return unknown('Shop search is unavailable.');
        } finally {
          await page?.close().catch(() => {});
        }
      }, openPage);
    } catch {
      return onFailure('Headless Chromium is unavailable.');
    } finally {
      // The caller's deadline also covers cleanup. Browser shutdown may continue after a result is returned.
      void browser?.close().catch(() => {});
    }
  }
  try {
    return await Promise.race([work(), new Promise(resolve => {
      timer = setTimeout(() => {
        expired = true;
        void browser?.close().catch(() => {});
        resolve(onFailure(timedOut));
      }, Math.max(0, Math.ceil(deadline - performance.now())));
    })]);
  } finally {
    clearTimeout(timer);
  }
}

export const confirmingShops = ['spaceship', 'namecheap', 'dynadot', 'cloudflare'];

function shopOrder(shop, tld, unsupported) {
  const preferred = tld === 'no' ? 'dynadot' : 'namecheap';
  // Spaceship's retail catalog does not cover .no and .so.
  return [...new Set([shop, 'spaceship', preferred, ...confirmingShops])]
    .filter(id => Object.hasOwn(adapters, id) && (id !== 'spaceship' || !unsupported?.includes(tld)))
    .slice(0, 2);
}

function formatResult(start, domain, requestedShop, shop, result, now) {
  const status = result.available === false ? 'taken' : result.available !== true ? 'could-not-confirm'
    : result.premium ? 'premium' : 'confirmed';
  return { ...result, shop, shopName: shops[shop]?.name ?? null, requestedShop, domain, status,
    ...fallbackNote(requestedShop, shop, status),
    buyUrl: shopSearchUrl(shop, domain), checkedAt: now.toISOString(), ms: Math.round(performance.now() - start) };
}

function fallbackNote(requestedShop, shop, status) {
  return shop !== requestedShop && status !== 'could-not-confirm'
    ? { note: `Requested ${shops[requestedShop].name}; confirmed at ${shops[shop].name}` } : {};
}

let spaceshipTail = Promise.resolve();

export async function confirmAtShops(domain, check, deadline, order) {
  let shop = order[0];
  let result;
  for (const id of order) {
    if (performance.now() >= deadline) break;
    shop = id;
    const run = () => performance.now() >= deadline ? unknown(timedOut)
      : check(shop, Math.min(deadline, performance.now() + shopBudget));
    if (shop === 'spaceship') {
      const turn = spaceshipTail.then(run);
      spaceshipTail = turn.catch(() => {});
      result = await turn;
    } else {
      result = await run();
    }
    if (result.available !== null) break;
  }
  return { shop, result: result ?? unknown(timedOut) };
}

export async function confirmDomain(shopValue, domain, options = {}) {
  const start = performance.now();
  const shop = typeof shopValue === 'string' ? shopValue.toLowerCase() : null;
  const now = options.now ?? new Date();
  if (!domain || !Object.hasOwn(shops, shop)) return { error: 'Choose a trusted shop and a valid domain.' };
  const directory = options.directory === undefined ? cacheDir : options.directory;
  const filename = 'confirm-' + shop + '-' + domain + '.json';
  const cached = options.fresh ? null : await readCache(directory, filename);
  const age = now - Date.parse(cached?.checkedAt);
  if (cached?.domain === domain && cached.requestedShop === shop && cached.status === 'confirmed' &&
      cached.available === true && cached.premium === false && Object.hasOwn(adapters, cached.shop) &&
      cached.buyUrl === shopSearchUrl(cached.shop, domain) && money(cached.price) > 0 &&
      age >= 0 && age < cacheLifetime) {
    return { ...cached, ...fallbackNote(shop, cached.shop, cached.status), cached: true,
      ms: Math.round(performance.now() - start) };
  }

  const deadline = Math.min(options.deadline ?? Infinity, start + budget);
  const tld = domain.split('.').at(-1);
  const order = shopOrder(shop, tld, options.unsupported).slice(0, options.oneShop ? 1 : 2);
  const run = usePage => usePage(domain, check => confirmAtShops(domain, check, deadline, order));
  const settled = options.usePage ? await run(options.usePage) : await withShopPages(deadline, run, options);
  const result = formatResult(start, domain, shop, settled.shop ?? shop, settled.result ?? settled, now);
  if (result.status === 'confirmed') await writeCache(directory, filename, result).catch(() => {});
  if (result.status === 'premium') await writeCache(directory, quoteFile(domain), result).catch(() => {});
  return result;
}

// Light confirm uses documented read operations. Without a key, prices stay labelled as list prices.
// Spaceship: https://docs.spaceship.dev/ (domains:read) · Dynadot: https://www.dynadot.com/domain/api-commands (search).
const spaceshipApi = 'https://spaceship.dev/api/v1/domains/';
const dynadotApi = 'https://api.dynadot.com/api3.json';
const signalLifetime = 24 * 3_600_000;
const apiTimeout = 2500;

export function apiShops(env = process.env) {
  return [
    ...(env.DOMAIN_HOUND_SPACESHIP_KEY?.trim() && env.DOMAIN_HOUND_SPACESHIP_SECRET?.trim() ? ['spaceship'] : []),
    ...(env.DOMAIN_HOUND_DYNADOT_KEY?.trim() ? ['dynadot'] : []),
  ];
}

const cents = value => Math.round(value * 100) / 100;

// The yearly USD price of the shortest documented period.
function yearly(entries) {
  const rows = (Array.isArray(entries) ? entries : []).map(row => {
    const years = row?.period?.unit === 'y' && Number.isSafeInteger(row.period.value) && row.period.value > 0
      ? row.period.value : null;
    const final = row?.priceInDefaultCurrency?.finalPrice;
    const amount = final?.currency === 'USD' && typeof final.amount === 'string' ? money(final.amount) : null;
    return years && amount > 0 ? { years, amount } : null;
  }).filter(Boolean).sort((a, b) => a.years - b.years);
  return rows[0] ? cents(rows[0].amount / rows[0].years) : null;
}

function apiQuote(shop, domain, fields, now) {
  return { shop, shopName: shops[shop].name, domain, buyUrl: shopSearchUrl(shop, domain), checkedAt: now.toISOString(),
    source: 'api', price: null, renewal: null, ...fields };
}

// Availability: result and premiumPricing. Pricing: priceClass and the register and renew price lists.
// premiumPricing marks a premium name even when it carries no price.
export function parseSpaceshipApi(availability, pricing, domains, now = new Date()) {
  const quotes = new Map();
  const find = (body, domain) => (Array.isArray(body?.domains) ? body.domains : [])
    .find(row => typeof row?.domain === 'string' && row.domain.toLowerCase() === domain);
  for (const domain of domains) {
    const open = find(availability, domain);
    if (typeof open?.result !== 'string') continue;
    if (open.result !== 'available') {
      const status = ['reserved', 'taken'].includes(open.result) ? open.result : 'could-not-confirm';
      quotes.set(domain, apiQuote('spaceship', domain, { status, available: status === 'could-not-confirm' ? null : false,
        reason: 'Not offered for registration at Spaceship' }, now));
      continue;
    }
    const priced = find(pricing, domain);
    const marked = Array.isArray(open.premiumPricing) && open.premiumPricing.length > 0;
    const premiumClass = priced?.priceClass === 'premium';
    if (marked || premiumClass) {
      const listed = marked ? money(open.premiumPricing.find(row => row?.operation === 'register' && row.currency === 'USD')?.price) : null;
      // Availability does not specify a term. Price multi-year endings from the pricing endpoint only.
      const price = (premiumClass ? yearly(priced.prices?.register) : null)
        ?? (!domain.endsWith('.ai') && listed > 0 ? listed : null);
      quotes.set(domain, apiQuote('spaceship', domain, { status: 'premium', available: true, premium: true, price,
        renewal: price != null && premiumClass ? yearly(priced.prices?.renew) : null }, now));
      continue;
    }
    const price = priced?.priceClass === 'standard' ? yearly(priced.prices?.register) : null;
    const renewal = priced?.priceClass === 'standard' ? yearly(priced.prices?.renew) : null;
    quotes.set(domain, price > 0 && renewal > 0
      ? apiQuote('spaceship', domain, { status: 'confirmed', available: true, premium: false, standard: true, price, renewal }, now)
      : apiQuote('spaceship', domain, { status: 'could-not-confirm', available: null, premium: false,
        reason: 'Spaceship gave no explicit standard price' }, now));
  }
  return quotes;
}

// Dynadot search with show_price=1: "Price": "77.00 in USD", optionally "... and domain is not premium".
// Without a marker, a price that matches Dynadot's own list price is standard; any other price may be premium.
export function parseDynadotSearch(body, domain, list = null, now = new Date()) {
  const response = body?.SearchResponse;
  if (String(response?.ResponseCode) !== '0' || !Array.isArray(response.SearchResults)) return null;
  const row = response.SearchResults.find(item => String(item?.DomainName ?? '').toLowerCase() === domain);
  if (!row || row.Error) return null;
  const available = String(row.Available ?? '').toLowerCase();
  if (available === 'no') {
    return apiQuote('dynadot', domain, { status: 'could-not-confirm', available: null,
      reason: 'Not offered for registration at Dynadot' }, now);
  }
  if (available !== 'yes') return null;
  const text = String(row.Price ?? '');
  const price = money(text.match(/^\s*(\d[\d,]*(?:\.\d{1,2})?) in USD\b/i)?.[1]?.replace(/,/g, ''));
  const twoYears = domain.endsWith('.ai');
  const marker = /\bis not premium\b/i.test(text) ? false : /\bpremium\b/i.test(text) ? true : null;
  if (marker) return apiQuote('dynadot', domain, { status: 'premium', available: true, premium: true,
    price: !twoYears && price > 0 ? price : null }, now);
  if (!(price > 0)) return null;
  // The legacy response gives one amount with no term or renewal. A list match can disambiguate .ai.
  const yearsMatch = list && (twoYears ? [1, 2] : [1]).find(years => Math.abs(price - cents(list.firstYear * years)) < 0.011);
  if (yearsMatch || marker === false && !twoYears) {
    const yearlyPrice = yearsMatch ? list.firstYear : price;
    return apiQuote('dynadot', domain, { status: 'confirmed', available: true, premium: false, standard: marker === false || undefined,
      price: yearlyPrice }, now);
  }
  return apiQuote('dynadot', domain, { status: 'premium', available: true, premium: 'possible',
    price: twoYears ? null : price }, now);
}

async function postJson(fetcher, url, body, headers, timeout) {
  const response = await fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error('HTTP ' + response.status);
  }
  return response.json();
}

async function spaceshipQuotes(domains, { env, fetcher, timeout, now }) {
  const headers = { 'X-API-Key': env.DOMAIN_HOUND_SPACESHIP_KEY.trim(), 'X-API-Secret': env.DOMAIN_HOUND_SPACESHIP_SECRET.trim() };
  const [availability, pricing] = await Promise.all([
    postJson(fetcher, spaceshipApi + 'available', { domains }, headers, timeout),
    postJson(fetcher, spaceshipApi + 'pricing/query', { domains }, headers, timeout).catch(() => null),
  ]);
  return parseSpaceshipApi(availability, pricing, domains, now);
}

async function dynadotQuotes(domains, { env, fetcher, timeout, now, listFor, deadline }) {
  const quotes = new Map();
  // A regular Dynadot account checks one domain per command and one request at a time.
  for (const domain of domains) {
    const wait = Math.min(timeout, Math.floor(deadline - performance.now()));
    if (wait < 300) break;
    const url = dynadotApi + '?' + new URLSearchParams({ key: env.DOMAIN_HOUND_DYNADOT_KEY.trim(), command: 'search',
      domain0: domain, show_price: '1', currency: 'USD' });
    try {
      const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(wait), headers: { Accept: 'application/json' } });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); continue; }
      const quote = parseDynadotSearch(await response.json(), domain, listFor(domain, 'dynadot'), now);
      if (quote) quotes.set(domain, quote);
    } catch { /* One failed check leaves that domain at its list price. */ }
  }
  return quotes;
}

const quoteFile = domain => 'quote-' + domain + '.json';

// Premium and reserved answers are kept for a day; a standard quote for 15 minutes.
function usableQuote(saved, domain, now) {
  const age = now - Date.parse(saved?.checkedAt);
  if (saved?.domain !== domain || !(age >= 0)) return false;
  if (['premium', 'reserved'].includes(saved.status)) return age < signalLifetime;
  return saved.status === 'confirmed' && money(saved.price) > 0 && age < cacheLifetime;
}

export async function cachedSignals(domains, { directory, now = new Date() } = {}) {
  const folder = directory === undefined ? cacheDir : directory;
  const found = new Map();
  if (!folder) return found;
  await Promise.all(domains.map(async domain => {
    const saved = await readCache(folder, quoteFile(domain));
    if (usableQuote(saved, domain, now) && ['premium', 'reserved'].includes(saved.status)) found.set(domain, saved);
  }));
  return found;
}

// Combine the shops: any premium or reserved answer wins; otherwise the cheapest explicit standard quote.
function combine(answers) {
  const known = answers.filter(Boolean);
  const premium = known.filter(quote => quote.status === 'premium');
  if (premium.length) {
    const explicit = premium.filter(quote => quote.premium === true);
    const pool = explicit.length ? explicit : premium;
    return pool.find(quote => quote.price != null) ?? pool[0];
  }
  const confirmed = known.filter(quote => quote.status === 'confirmed').sort((a, b) => a.price - b.price);
  return confirmed[0] ?? known.find(quote => ['taken', 'reserved'].includes(quote.status)) ?? known[0] ?? null;
}

export async function lightConfirm(domains, {
  env = process.env, fetcher = globalThis.fetch, directory, now = new Date(), deadline = performance.now() + 3000,
  listFor = () => null,
} = {}) {
  const folder = directory === undefined ? cacheDir : directory;
  const results = new Map();
  const wanted = [...new Set(domains)].slice(0, 20);
  const pending = [];
  for (const domain of wanted) {
    const saved = folder ? await readCache(folder, quoteFile(domain)) : null;
    if (usableQuote(saved, domain, now)) results.set(domain, { ...saved, cached: true });
    else pending.push(domain);
  }
  const keyed = apiShops(env);
  const timeout = Math.min(apiTimeout, Math.floor(deadline - performance.now()));
  if (!pending.length || !keyed.length || timeout < 300) return results;
  const context = { env, fetcher, timeout, now, listFor, deadline };
  const [spaceship, dynadot] = await Promise.all([
    keyed.includes('spaceship') ? spaceshipQuotes(pending, context).catch(() => new Map()) : new Map(),
    keyed.includes('dynadot') ? dynadotQuotes(pending, context) : new Map(),
  ]);
  for (const domain of pending) {
    const quote = combine([spaceship.get(domain), dynadot.get(domain)]);
    if (!quote) continue;
    results.set(domain, quote);
    if (folder && ['confirmed', 'premium', 'reserved'].includes(quote.status)) {
      await writeCache(folder, quoteFile(domain), quote).catch(() => {});
    }
  }
  return results;
}
