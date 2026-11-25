import '../../test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readRdap } from '../domain-check/dossier.mjs';
import { readRegistry } from './checks.mjs';
import { planFromFacts, planLines, registrarGuide, threeYearCost, transferBlockers, transferRegistryRecord, transferRules } from './move.mjs';

const now = new Date('2026-11-25T12:00:00Z');
const at = '2026-11-25T11:00:00.000Z';
// Synthetic dated list prices, newer than the bundled snapshot so they win. Catalog prices are per year.
const catalog = (rows = {}) => ({ checkedAt: at, catalogs: Object.fromEntries(Object.entries({
  spaceship: { com: { shop: 'Spaceship', firstYear: 9.48, renewal: 10.68, transfer: 10.18 },
    ai: { shop: 'Spaceship', firstYear: 79.98, renewal: 79.98, transfer: 79.98 },
    io: { shop: 'Spaceship', firstYear: 31.98, renewal: 51.75, transfer: 51.75 } },
  porkbun: { com: { shop: 'Porkbun', firstYear: 11.81, renewal: 11.81, transfer: 11.81 },
    ai: { shop: 'Porkbun', firstYear: 82.7, renewal: 82.7, transfer: 165.09 } },
  dynadot: { com: { shop: 'Dynadot', firstYear: 11.62, renewal: 11.62, transfer: 11.62 },
    ai: { shop: 'Dynadot', firstYear: 85.6, renewal: 85.6, transfer: 171.2 } },
  ...rows,
}).map(([id, prices]) => [id, { checkedAt: at, prices }])) });

const record = (fields = {}) => readRegistry({ registered: 'taken', registrar: 'Porkbun LLC', created: '2020-01-01T00:00:00Z',
  expires: '2027-06-01T00:00:00Z', status: ['client transfer prohibited'], nameservers: [], ...fields }, now);

test('RDAP: the transfer event is read from eventAction "transfer", never from "last changed"', () => {
  const base = { ldhName: 'lanternbay.com', status: [], entities: [], nameservers: [] };
  const withTransfer = readRdap({ ...base, events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' },
    { eventAction: 'transfer', eventDate: '2025-01-30T08:00:00Z' },
    { eventAction: 'transfer', eventDate: '2026-10-30T08:00:00Z' }, { eventAction: 'last changed', eventDate: '2026-11-20T00:00:00Z' }] },
  'lanternbay.com');
  assert.equal(withTransfer.transferred, '2026-10-30T08:00:00.000Z');
  const changedOnly = readRdap({ ...base, events: [{ eventAction: 'last changed', eventDate: '2026-11-20T00:00:00Z' }] }, 'lanternbay.com');
  assert.equal(changedOnly.transferred, null);
  assert.equal(readRegistry({ registered: 'taken', ...changedOnly }, now).transferred, null);
  // A recent transfer blocks the move; a recent change alone does not.
  const rules = transferRules('lanternbay.com');
  assert.match(transferBlockers(readRegistry({ registered: 'taken', ...withTransfer, expires: '2027-06-01T00:00:00Z' }, now), rules, now)
    .blockers.join(), /transferred 2026-10-30, under 60 days ago; wait until 2026-12-29/);
  assert.deepEqual(transferBlockers(readRegistry({ registered: 'taken', ...changedOnly, expires: '2027-06-01T00:00:00Z' }, now), rules, now)
    .blockers, []);
});

test('.com at Porkbun: three-year comparison, Spaceship first within $2 a year, unlock and auth code steps', () => {
  const plan = planFromFacts('lanternbay.com', record(), catalog(), now);
  assert.equal(plan.current.shop, 'Porkbun');
  assert.equal(plan.current.renewalPerYear, 11.81);
  const spaceship = plan.options.find(option => option.id === 'spaceship');
  // Transfer adds one year, then two renewals.
  assert.equal(spaceship.threeYear, 10.18 + 2 * 10.68);
  assert.equal(plan.target.id, 'spaceship');
  assert.equal(plan.saving, 3.89);
  assert.equal(plan.verdict, 'small-saving');
  assert.equal(plan.locked, true);
  const text = planLines(plan).join('\n');
  assert.match(text, /Renewal at Porkbun: \$11\.81\/yr \(list price 2026-11-25\)/);
  assert.match(text, /Moving to Spaceship saves \$3\.89 over 3 years \(annualized\), against \$35\.43 staying\./);
  assert.match(text, /1\. Unlock the domain at Porkbun .*Get Authorization Code.*kb\.porkbun\.com/);
  assert.match(text, /Keep WHOIS privacy on unless a registrar requires it off/);
  assert.match(text, /enter the code there yourself: \[Spaceship transfer\]\(https:\/\/www\.spaceship\.com\/domains\/transfer\/\)/);

  // Dynadot $5.54 cheaper over three years: within $2 a year, so Spaceship stays the target.
  const close = planFromFacts('lanternbay.com', record(), catalog({ dynadot: { com: { shop: 'Dynadot', renewal: 9, transfer: 8 } } }), now);
  assert.equal(close.target.id, 'spaceship');
  // More than $2 a year cheaper: Dynadot is the target and only gets a link.
  const far = planFromFacts('lanternbay.com', record(), catalog({ dynadot: { com: { shop: 'Dynadot', renewal: 8, transfer: 5 } } }), now);
  assert.equal(far.target.id, 'dynadot');
  assert.match(planLines(far).join('\n'), /\[Dynadot transfer\]\(https:\/\/www\.dynadot\.com\/domain\/transfer\)/);
  const worth = planFromFacts('lanternbay.com', record({ registrar: 'Dynadot Inc' }), catalog({ dynadot: { com: { shop: 'Dynadot', renewal: 20, transfer: 20 } } }), now);
  assert.equal(worth.verdict, 'worth-moving');
  assert.equal(worth.saving, 28.46);
});

test('.ai compares three years annualized: the transfer adds two years, list prices only where the term is stated', () => {
  const plan = planFromFacts('lanternbay.ai', record({ status: [] }), catalog(), now);
  assert.equal(plan.rules.yearsAdded, 2);
  assert.equal(plan.rules.lockDays, null);
  const spaceship = plan.options.find(option => option.id === 'spaceship');
  assert.equal(spaceship.transfer, 159.96);
  assert.equal(spaceship.threeYear, 159.96 + 79.98);
  assert.equal(spaceship.note, 'list $79.98/yr × 2 years');
  const dynadot = plan.options.find(option => option.id === 'dynadot');
  assert.equal(dynadot.threeYear, 171.2 + 85.6);
  assert.equal(plan.saving, Math.round((3 * 82.7 - 239.94) * 100) / 100);
  const text = planLines(plan).join('\n');
  assert.match(text, /Spaceship: transfer \$159\.96 adds 2 years \(list \$79\.98\/yr × 2 years\), renews \$79\.98\/yr; 3 years \$239\.94/);
  assert.match(text, /Dynadot: transfer \$171\.20 adds 2 years/);
  assert.match(text, /\.ai: a transfer renews the domain for 2 years/);
  assert.match(text, /Check the transfer lock in your registrar account/);
  // No 60-day rule is claimed for .ai; .io has one.
  assert.deepEqual(transferBlockers(record({ created: '2026-11-01T00:00:00Z', status: [] }), transferRules('x.ai'), now).blockers, []);
  assert.match(transferBlockers(record({ created: '2026-11-01T00:00:00Z' }), transferRules('x.io'), now).blockers.join(), /registered 2026-11-01/);
  assert.match(transferRules('x.io').rule, /at least 60 days old.*adds one year/);
  assert.equal(threeYearCost({ transfer: 100, transferYears: 2, renewalPerYear: 50 }), 150);
  const live = planFromFacts('lanternbay.ai', record({ status: [] }), catalog(), now, { years: 2, amount: 15000, regular: 15000, promo: false,
    renewal: { years: 2, amount: 16000, regular: 16000 } });
  const quoted = live.options.find(option => option.id === 'spaceship');
  assert.deepEqual([quoted.basis, quoted.transfer, quoted.transferYears, quoted.renewalPerYear, quoted.threeYear], ['live', 150, 2, 80, 230]);
});

test('blockers: expiry under 15 days, expired, registry lock, pending transfer; unknown registrars get no invented price', () => {
  const soon = planFromFacts('lanternbay.com', record({ expires: '2026-12-05T00:00:00Z' }), catalog(), now);
  assert.equal(soon.verdict, 'blocked');
  assert.match(planLines(soon).join('\n'), /Blocked now: it expires in 9 days \(2026-12-05\); renew at the current registrar first/);
  assert.doesNotMatch(planLines(soon).join('\n'), /^1\. /m);
  assert.match(planFromFacts('lanternbay.com', record({ expires: '2026-11-01T00:00:00Z' }), catalog(), now).blockers.join(), /expired on 2026-11-01/);
  assert.match(planFromFacts('lanternbay.com', record({ status: ['server transfer prohibited'] }), catalog(), now).blockers.join(), /registry locks transfers/);
  assert.match(planFromFacts('lanternbay.com', record({ status: ['pending transfer'] }), catalog(), now).blockers.join(), /already pending/);
  assert.match(planFromFacts('lanternbay.com', readRegistry(null, now), catalog(), now).blockers.join(), /did not answer/);

  const godaddy = planFromFacts('lanternbay.com', record({ registrar: 'GoDaddy.com, LLC' }), catalog(), now);
  assert.equal(godaddy.current.renewalPerYear, 22.99);
  assert.equal(godaddy.saving, 37.43);
  assert.equal(godaddy.verdict, 'worth-moving');
  const text = planLines(godaddy).join('\n');
  assert.match(text, /Renewal at GoDaddy: \$22\.99\/yr/);
  assert.match(text, /GoDaddy unlocks it and turns off Domain Privacy/);
  assert.match(text, /godaddy\.com\/help\/transfer-my-domain-away-from-godaddy-3560/);
  for (const name of ['GoDaddy.com, LLC', 'NameCheap, Inc.', 'Squarespace Domains II LLC', 'Cloudflare, Inc.', 'Porkbun LLC', 'DYNADOT LLC',
    'Hover', 'Gandi SAS', 'IONOS SE']) {
    assert.ok(registrarGuide(name)?.url?.startsWith('https://'), name);
  }
  const unknown = planFromFacts('lanternbay.com', record({ registrar: 'Example Registrar Ltd' }), catalog(), now);
  assert.match(planLines(unknown).join('\n'), /from Example Registrar Ltd\. \[ICANN transfer rules\]/);

  const atSpaceship = planFromFacts('lanternbay.com', record({ registrar: 'Spaceship, Inc.' }), catalog(), now);
  assert.equal(atSpaceship.verdict, 'already-at-spaceship');
  assert.match(planLines(atSpaceship).join('\n'), /Already at Spaceship\. The prices below show no cheaper move\./);
  const cheaper = planFromFacts('lanternbay.com', record({ registrar: 'Spaceship, Inc.' }),
    catalog({ dynadot: { com: { shop: 'Dynadot', renewal: 8, transfer: 5 } } }), now);
  assert.equal(cheaper.target.shop, 'Dynadot');
  assert.match(planLines(cheaper).join('\n'), /Domain Manager.*Transfer domain/);

  const grace = planFromFacts('lanternbay.com', record({ status: ['auto renew period'] }), catalog(), now);
  assert.match(planLines(grace).join('\n'), /auto-renew grace .*Ask Porkbun whether a transfer now refunds or keeps that renewal/);
  // An ending without checked rules: no transfer price is computed.
  const unknownEnding = planFromFacts('lanternbay.no', record(), catalog(), now);
  assert.equal(unknownEnding.rules.yearsAdded, null);
  assert.match(planLines(unknownEnding).join('\n'), /no checked transfer rules/);
});

test('the public plan works on any exact domain from registry facts alone', async () => {
  const registry = await transferRegistryRecord('lanternbay.com', { now,
    facts: async domain => ({ registered: 'taken', registrar: 'Porkbun LLC', created: '2020-01-01T00:00:00Z',
      expires: '2027-06-01T00:00:00Z', transferred: '2024-02-02T00:00:00Z', status: [], nameservers: [], domain }) });
  const plan = planFromFacts('lanternbay.com', registry, catalog(), now);
  assert.equal(plan.registry.transferred, '2024-02-02T00:00:00Z');
  assert.match(planLines(plan)[0], /^lanternbay\.com: registered at Porkbun LLC, expires 2027-06-01\. Last transfer 2024-02-02 \(registry\)\.$/);
  const free = planFromFacts('lanternbay.com',
    await transferRegistryRecord('lanternbay.com', { now, facts: async () => ({ registered: 'free' }) }), catalog(), now);
  assert.equal(free.verdict, 'blocked');
  assert.deepEqual(planLines(free), ['lanternbay.com: the registry has no record of it, so there is nothing to move.']);
});
