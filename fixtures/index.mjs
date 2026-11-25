import { appendFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { progressReporter } from '../clis/domain-check/progress.mjs';
import { defaultEndings } from '../clis/domain-check/name-search.mjs';

const [mode, query, ...rest] = process.argv.slice(2);
const receipt = rest.indexOf('--receipt');
if (receipt >= 0) rest.splice(receipt, 1);
if (!['--agent', '--triage'].includes(mode) || dirname(fileURLToPath(import.meta.url)) !== process.cwd()) {
  throw new Error('Wrong command or working directory');
}
// A test holds a slow lookup at a gate and releases it by creating the DOMAIN_HOUND_TEST_GATE file, so no step
// depends on how fast the machine is. Without a gate the lookup waits fallbackMs.
async function gate(fallbackMs) {
  const file = process.env.DOMAIN_HOUND_TEST_GATE;
  if (!file) return new Promise(resolve => setTimeout(resolve, fallbackMs));
  while (!existsSync(file)) await new Promise(resolve => setTimeout(resolve, 10));
}
// Print the last line and exit once stdout has taken it; an immediate exit can lose piped output.
const finish = text => new Promise(resolve => process.stdout.write(text + '\n', resolve)).then(() => process.exit(0));
// Tests count capability runs through this log.
if (process.env.DOMAIN_HOUND_TEST_RUNS) appendFileSync(process.env.DOMAIN_HOUND_TEST_RUNS, JSON.stringify([mode, query]) + '\n');
if (query === 'endingsample' || query === 'Ending Sample') {
  // A forwarded --endings flag behaves like the capability's filter, so a test can catch it at the wire.
  const flag = rest.indexOf('--endings');
  const endings = flag < 0 ? defaultEndings : rest[flag + 1].split(',');
  const price = { now: 8, renew: 12.5 };
  const rows = mode === '--triage'
    ? { prices: Object.fromEntries(endings.map(ending => [ending, price])),
      names: [{ name: query, free: endings, verdict: 'Check first', reason: 'Review the available options' }] }
    : { complete: true, names: [{ name: query, free: endings.map(d => ({ d, s: 'nc', ...price })) }] };
  await finish(JSON.stringify(rows));
}
// A deliberately slow lookup: two registry answers at once, the final result after DOMAIN_HOUND_TEST_DELAY ms.
const slowBatch = query === '--names' ? rest[0]?.split(',') : null;
if (query === 'slowroom' || query === 'Slow Room' || slowBatch?.includes('slowroom')) {
  const progress = progressReporter();
  progress?.({ domain: 'slowroom.com', status: 'taken' });
  progress?.({ domain: 'slowroom.dev', status: 'probably-free' });
  setTimeout(() => {
    progress?.({ domain: 'slowroom.app', status: 'probably-free' });
    progress?.({ stage: mode === '--triage' ? 'rivals' : 'quotes' });
  }, 50);
  await gate(Number(process.env.DOMAIN_HOUND_TEST_DELAY ?? 1500));
  if (mode === '--triage') {
    await finish(JSON.stringify({ prices: { dev: { now: 8, renew: 12.5, shop: 'Spaceship' }, app: { now: 8.28, renew: 14.49, shop: 'Spaceship' } },
      names: [{ name: query, verdict: 'No conflict found', reason: 'No close US mark, app or site overlap',
        free: ['dev', 'app'], taken: ['com'], buy: 'https://www.spaceship.com/domain-search/?query=slowroom.dev' }] }));
  } else {
    const price = { now: 8, renew: 12.5, shop: 'Spaceship' };
    await finish(JSON.stringify({ complete: true, checkedAt: '2026-11-24T12:00:00.000Z', priceListDate: '2026-11-24',
      names: (slowBatch ?? ['slowroom']).map(name => name === 'slowroom'
        ? { name, taken: ['com'], free: [{ d: 'dev', s: 'nc', ...price }, { d: 'app', s: 'nc', ...price }] }
        : { name, free: [{ d: name.includes('.') ? name.split('.')[1] : 'com', s: 'nc', ...price }] }),
      buyUrlTemplate: { Spaceship: 'https://www.spaceship.com/domain-search/?query={domain}' } }));
  }
}
// A name screen with a slow source: the first answer lists Google Play as still checking, the follow-up line re-assesses.
if (mode === '--triage' && query === 'Late Room') {
  const prices = { app: { now: 8.28, renew: 14.49, shop: 'Spaceship' } };
  const row = (verdict, reason, GooglePlay) => ({ name: query, verdict, reason, free: ['app'], taken: ['com'],
    competition: { US: [], AppStore: [], GooglePlay, Wikidata: [], sameName: { summary: 'Same name used by: none found', level: 'few' } } });
  const detail = (GooglePlay, reason, waiting) => ({ competition: { US: [], AppStore: [], GooglePlay, Wikidata: [] },
    reason, ...(waiting && { waiting }) });
  const checkedAt = '2026-11-24T12:00:00.000Z';
  const followUp = process.env.DOMAIN_HOUND_FOLLOW_UP === '1';
  const first = JSON.stringify({ prices, checkedAt, ...(followUp && { followUp: true }),
    names: [row('Check first', 'still checking Google Play', null)], receiptDetails: [detail(null, 'still checking Google Play', ['Google Play'])] });
  if (!followUp) await finish(first);
  console.log(first);
  await gate(Number(process.env.DOMAIN_HOUND_TEST_FOLLOW_MS ?? 300));
  const app = [{ name: 'Late Room', developer: 'Example Apps', ratings: 5000, url: 'https://play.google.com/store/apps/details?id=example.lateroom' }];
  const reason = 'Late Room is an app in the same category with 5000 Android ratings';
  await finish(JSON.stringify({ prices, checkedAt: '2026-11-24T12:00:20.000Z',
    names: [row('Avoid', reason, app)], receiptDetails: [detail(app, reason)] }));
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
  await finish(JSON.stringify({ prices, names, legend: 'USD ex. VAT. Long legend.', flags: rest }));
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
