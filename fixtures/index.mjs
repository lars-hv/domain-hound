import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode, query, ...rest] = process.argv.slice(2);
if (!['--agent', '--triage'].includes(mode) || dirname(fileURLToPath(import.meta.url)) !== process.cwd()) {
  throw new Error('Wrong command or working directory');
}
if (mode === '--triage') {
  // Mirrors the compact triage shape; flags echo the forwarded arguments for the tests.
  const prices = { co: { now: 3.11, renew: 31.05, jump: true, shop: 'Spaceship' }, app: { now: 8.28, renew: 14.49, shop: 'Spaceship' },
    ai: { now: 160.02, renew: 160.02, term: 2, shop: 'Spaceship' } };
  const names = query.split(',').map(name => name === 'Taken Name'
    ? { name, verdict: 'Avoid', reason: 'Live US trademark for a close name in a relevant class', taken: ['com', 'co', 'app', 'ai'],
      notes: ['US mark: TAKEN NAME (Example Inc., 9/42, key class)'], memorable: '9 letters (short), ~3 syllables' }
    : { name, verdict: 'Check first', reason: 'An exact-name app already exists | see [x](https://example.com)',
      free: ['co', 'app', 'ai'], taken: ['com'], shop_check: ['dev'],
      buy: 'https://www.spaceship.com/domain-search/?query=' + name.toLowerCase().replace(/[^a-z0-9-]/g, '') + '.co',
      notes: ['iOS app: ' + name + ' (Example Inc., 12 ratings)'], memorable: '10 letters (short), ~3 syllables' });
  console.log(JSON.stringify({ prices, names, legend: 'USD ex. VAT. Long legend.', flags: rest }));
  process.exit(0);
}
const batch = query === '--names' ? rest.shift() : null;
const flags = rest.length ? { flags: rest } : {};
if (query === 'slow') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (query === 'broken-json') {
  console.log('Not JSON');
} else if (query === 'taken.me') {
  console.log(JSON.stringify({ complete: true, checkedAt: '2026-11-24T12:00:00.000Z', names: [{ name: 'taken.me', taken: ['me'] }],
    purchaseAdvice: 'If the person asked to buy, say Domain Hound cannot buy domains, even if the domain is taken.',
    legend: { nc: 'Free, not confirmed' } }));
} else if (query === 'failed') {
  console.log(JSON.stringify({ error: 'Broker lookup failed.\nInternal detail.' }));
  process.exitCode = 1;
} else if (query === '--names' && process.env.DOMAIN_HOUND_TEST_LEGACY === '1') {
  console.log(JSON.stringify({ error: 'Enter a name, such as Example Studio.' }));
  process.exitCode = 1;
} else {
  const checkedAt = '2026-11-24T12:00:00.000Z';
  const legend = { nc: 'Free, not confirmed', ok: 'Free, confirmed by a shop' };
  const shop = 'Spaceship';
  const template = 'https://www.spaceship.com/domain-search/?query={domain}';
  const buyUrlTemplate = { [shop]: template };
  const price = { now: 9.48, renew: 10.68, y3: 30.84, shop };
  if (batch) {
    const names = batch.split(',').map(name => ({
      name, free: [{ d: 'com', s: 'nc', ...price }], shop_check: ['so'],
    }));
    console.log(JSON.stringify({ complete: false, checkedAt, priceListDate: checkedAt.slice(0, 10), names, legend, buyUrlTemplate }));
  } else {
    const [label, ending] = query.split('.');
    const d = ending ?? 'com';
    const domain = label + '.' + d;
    console.log(JSON.stringify({
      complete: true, checkedAt, ...flags,
      best: { domain, status: 'free-confirmed', priceNow: price.now, renewal: price.renew, threeYear: price.y3,
        shop, buyUrl: template.replace('{domain}', domain) },
      names: [{ name: query, free: [{ d, s: 'ok', ...price }] }], legend, buyUrlTemplate,
    }));
  }
}
