// Published USD renewal prices for common endings outside the portfolio's regular price feeds.
// These are dated estimates. Actual renewals can vary with discounts, taxes and premium names.
const checkedAt = '2026-11-25T00:00:00.000Z';
const godaddy = 'https://developer.godaddy.com/en/pricing/domains';
const hover = 'https://www.hover.com/domain-pricing';
const ionos = 'https://www.ionos.com/domains/domain-name-prices';
const squarespace = 'https://support.squarespace.com/hc/en-us/articles/205812208-Squarespace-domains-FAQ';
const spaceship = 'https://www.spaceship.com/domain-search/pricing/';

const renewals = new Map(Object.entries({
  godaddy: { com: [22.99, godaddy], net: [24.99, godaddy], org: [23.99, godaddy] },
  namecheap: {
    com: [20.18, 'https://www.namecheap.com/support/knowledgebase/article.aspx/10840/2201/com-price-change-november-1-2026/'],
    ai: [114.98, 'https://www.namecheap.com/domains/registration/cctld/ai/'],
    io: [75.98, 'https://www.namecheap.com/domains/registration/cctld/io/'],
  },
  squarespace: { com: [20, squarespace], org: [20, squarespace] },
  hover: { com: [19.99, hover], io: [74.99, hover], net: [19.99, hover], org: [17.99, hover] },
  gandi: {
    com: [38.38, 'https://www.gandi.net/en-US/domain/tld/com'],
    ai: [179.76, 'https://www.gandi.net/en-US/domain/tld/ai'],
    io: [74.99, 'https://www.gandi.net/en-US/domain/tld/io'],
  },
  ionos: { app: [25, ionos], co: [48, ionos], com: [20, ionos], me: [25, ionos], org: [20, ionos] },
}));

export function publishedRenewal(shop, ending, now) {
  const prices = renewals.get(shop);
  if (!prices || !Object.hasOwn(prices, ending) || now < Date.parse(checkedAt)) return null;
  const [renewalPerYear, source] = prices[ending];
  return { renewalPerYear, source, checkedAt, basis: 'snapshot' };
}

// The existing bundled catalog predates Spaceship's .net and .org rows. The regular prices here include the ICANN fee.
const spaceshipTransfers = new Map([['net', 11.4], ['org', 11.59]]);

export function publishedSpaceshipPrice(ending, now) {
  const amount = spaceshipTransfers.get(ending);
  if (amount === undefined || now < Date.parse(checkedAt)) return null;
  return { id: 'spaceship', transfer: amount, renewal: amount, checkedAt, bundled: true, source: spaceship };
}
