import '../../test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { domainToASCII, fileURLToPath, pathToFileURL } from 'node:url';
import { checkText, triageText } from '../../display.mjs';
import { writeCache } from './cache.mjs';
import { parseDynadot } from './confirm.mjs';
import { agentResult, normalize } from './index.mjs';
import { mergeQuote, pickName, premiumRisk, searchKey } from './name-search.mjs';
import { bootstrapUrl, lookupRegistrations, retryAfterMs } from './registry.mjs';
import { triageNames } from './triage.mjs';

// Fixtures only: every registry, DNS, WHOIS and shop answer below is injected. Names are synthetic.
const now = new Date('2026-11-24T12:00:00Z');
const day = now.toISOString().slice(0, 10);
const listed = {
  com: [9.48, 10.68], ai: [79.98, 79.98], io: [21.4, 53.5], me: [8.7, 15.53], co: [3.11, 31.05],
  dev: [8, 12.5], app: [8, 14.5], si: [10.98, 11.98], so: [57.5, 57.5], no: [7.91, 7.91],
  net: [7.49, 12.52], org: [7.99, 11.64], xyz: [1.5, 14.45], tech: [6.64, 52.65],
};
const notFound = () => Object.assign(new Error('not found'), { code: 'ENOTFOUND' });

async function pricedDirectory(t) {
  const folder = await mkdtemp(join(tmpdir(), 'hound-release-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const directory = pathToFileURL(folder + '/');
  const checkedAt = now.toISOString();
  const prices = Object.fromEntries(Object.entries(listed).map(([tld, [firstYear, renewal]]) =>
    [tld, { shop: 'Dynadot', firstYear, renewal }]));
  await writeCache(directory, 'prices.json', { checkedAt, catalogs: { dynadot: { checkedAt, prices } } });
  return directory;
}

// Every RDAP lookup answers 404 (not registered) unless a test overrides it.
function registryOptions(directory, overrides = {}) {
  return {
    directory, now, env: {}, cachedOnly: true, skipComSite: true, queryWhois: async () => '',
    fetcher: async url => url === bootstrapUrl
      ? Response.json({ services: [[Object.keys(listed), ['https://rdap.example.test/']]] })
      : new Response(null, { status: 404 }),
    resolveNs: async () => { throw notFound(); },
    ...overrides,
  };
}

const displayOf = result => JSON.parse(checkText(result)).display;
const count = (text, part) => text.split(part).length - 1;

test('a name with æøå is checked as its punycode label and shown in its own spelling with the ASCII form beside it', async t => {
  const directory = await pricedDirectory(t);
  const ascii = domainToASCII('grønnstue');
  assert.match(ascii, /^xn--/);
  const asked = [];
  const options = registryOptions(directory, { resolveNs: async domain => { asked.push(domain); throw notFound(); } });
  const result = await agentResult('Grønnstue', options);
  assert.equal(result.names[0].name, ascii);
  assert.equal(result.names[0].unicode, 'grønnstue');
  // Twelve endings, each on the punycode label; no stripped spelling and no prefixed variants.
  assert.equal(asked.length, 12);
  assert.ok(asked.every(domain => domain.startsWith(ascii + '.')), asked.join());
  const display = displayOf(result);
  assert.ok(display.includes('- grønnstue.com (' + ascii + '.com) $9.48/$10.68 list price'), display);
  assert.ok(!display.includes('grnnstue.'), 'no stripped spelling');

  asked.length = 0;
  const exact = await agentResult('https://www.Grønnstue.COM/', options);
  assert.equal(normalize('Grønnstue.com'), ascii + '.com');
  assert.deepEqual(asked, [ascii + '.com']);
  assert.equal(exact.names[0].name, ascii + '.com');
  assert.match(displayOf(exact), new RegExp('^\\*\\*grønnstue\\.com \\(' + ascii + '\\.com\\) is free\\.\\*\\*'));
});

test('the name screen checks æøå names as punycode, matches rivals by Latin letters and links the real domain', async t => {
  const directory = await pricedDirectory(t);
  const ascii = domainToASCII('grønnstue');
  assert.equal(searchKey('Grønnstue'), 'gronnstue');
  const registry = [];
  const urls = [];
  const options = registryOptions(directory, {
    budgetMs: 2500, compact: true, comSite: async () => ({ state: 'no-site' }),
    launch: async () => { throw Error('Fixture has no browser'); },
    resolveNs: async domain => { registry.push(domain); throw notFound(); },
    fetcher: async url => {
      urls.push(String(url));
      if (url === bootstrapUrl) return Response.json({ services: [[Object.keys(listed), ['https://rdap.example.test/']]] });
      if (String(url).includes('wikidata.org')) return Response.json({ search: [] });
      if (String(url).includes('itunes.apple.com')) return Response.json({ results: [] });
      return new Response(null, { status: 404 });
    },
  });
  const report = await triageNames(['Grønnstue'], options);
  assert.equal(report.names[0].name, 'Grønnstue');
  assert.ok(registry.length >= 10 && registry.every(domain => domain.startsWith(ascii + '.')), registry.join());
  assert.ok(report.names[0].free.includes('com'));
  assert.ok(urls.some(url => url.includes('gronnstue')), 'handle and rival sources use the Latin key');
  assert.ok(!urls.some(url => /[/=]grnnstue/.test(url)), 'no source gets the stripped spelling');
  const { display } = JSON.parse(triageText(report));
  assert.ok(display.includes('| Grønnstue (' + ascii + ') |'), display);
  assert.match(display, new RegExp('\\[' + ascii + '\\.[a-z]+\\]\\(https://'));
  assert.doesNotMatch(display, /\]\((?:null|undefined)?\)/);
});

test('a short name may be premium: no list price, never the cheapest pick, never a benchmark', async t => {
  const directory = await pricedDirectory(t);
  const result = await agentResult(['qxvo'], registryOptions(directory));
  const [row] = result.names;
  assert.ok(row.free.length === 12 && row.free.every(option => option.s === 'prem' && option.risk === true), JSON.stringify(row));
  assert.equal(result.best, undefined);
  assert.equal(result.listPrices, undefined);
  const display = displayOf(result);
  assert.match(display, /^- qxvo\.com may be premium, price at shop$/m);
  assert.doesNotMatch(display, /\$\d|Pick:|Cheapest now|Best value|Standard prices/);
  // A single name also gets longer .com variants; those are normal names with list prices and can be the pick.
  const single = await agentResult('qxvo', registryOptions(directory));
  assert.ok(single.names[0].free.filter(option => !option.d.includes('.')).every(option => option.s === 'prem' && option.risk));
  assert.match(displayOf(single), /^Pick: getqxvo\.com$/m);

  const exact = await agentResult('qxvo.com', registryOptions(directory));
  assert.equal(exact.otherEndings, undefined);
  assert.equal(exact.listPrices, undefined);
  const shown = displayOf(exact);
  assert.match(shown, /^\*\*qxvo\.com is free at the registry\.\*\* May be premium, price at shop: \[qxvo\.com\]\(https:/);
  assert.doesNotMatch(shown, /\$\d/);

  // Five characters is a normal name; length counts Unicode letters, not punycode bytes.
  const five = await agentResult('qxvob', registryOptions(directory));
  assert.ok(five.names[0].free.every(option => option.s === 'nc'));
  assert.equal(premiumRisk(domainToASCII('øl') + '.no'), true);
  assert.equal(premiumRisk(domainToASCII('grønnstue') + '.no'), false);
  assert.equal(premiumRisk('ab-c.io'), true);
  assert.equal(premiumRisk('abcde.com'), false);

  // Only a shop quote marked standard clears the risk; any other quote stays a possible premium.
  const risky = { domain: 'qxvo.co', tld: 'co', exact: true, status: 'premium', premium: 'risk', price: null };
  assert.equal(pickName([risky]), undefined);
  const quote = { status: 'confirmed', shopName: 'Spaceship', price: 3.11, renewal: 31.05, checkedAt: now.toISOString() };
  assert.equal(mergeQuote(risky, { ...quote, standard: true }).status, 'confirmed');
  const unmarked = mergeQuote(risky, quote);
  assert.equal(unmarked.status, 'premium');
  assert.equal(unmarked.premium, 'possible');
});

test('the shop parser reads whole-dollar prices and the Registry Premium label', () => {
  assert.deepEqual(parseDynadot('example.dev\n is available\nRenewal $12.50\n$8', 'example.dev'),
    { available: true, premium: false, price: 8, renewal: 12.5 });
  assert.deepEqual(parseDynadot('ab.dev\nRegistry Premium\n is available\n$713.90', 'ab.dev'),
    { available: true, premium: true, price: 713.9, renewal: null });
  assert.equal(parseDynadot('example.dev\n is available\nRenewal $12.50\n$1,234', 'example.dev').price, 1234);
});

test('a renewal jump is said on the price line, with one cheapest-now and one best-value line', () => {
  const template = { Dynadot: 'https://www.dynadot.com/domain/search?domain={domain}' };
  const payload = {
    complete: true, priceListDate: day, buyUrlTemplate: template,
    names: [{ name: 'lanternbay', free: [{ d: 'co', s: 'nc' }, { d: 'com', s: 'nc' }, { d: 'ai', s: 'nc' }] }],
    listPrices: {
      co: { now: 3.11, renew: 31.05, y3: 65.21, jump: true, shop: 'Dynadot' },
      com: { now: 9.48, renew: 10.68, y3: 30.84, shop: 'Dynadot' },
      ai: { now: 159.96, renew: 159.96, y3: 319.92, term: 2, shop: 'Dynadot' },
    },
  };
  const display = displayOf(payload);
  assert.match(display, /^- lanternbay\.co \$3\.11, then \$31\.05\/yr, 10x jump \(list price\)$/m);
  assert.match(display, /^- lanternbay\.ai \$159\.96\/\$159\.96 2y list price$/m);
  // .co renews at $31.05 ($65.21 over 3 years), so the pick is .com within $60; .co is only the cheapest upfront.
  // .com is also the best 3-year value, so it gets no separate line. .ai is never the default pick.
  assert.match(display, /^Pick: lanternbay\.com\nCheapest now: lanternbay\.co$/m);
  assert.doesNotMatch(display, /^Best value:|^Pick: lanternbay\.ai/m);
  // Each number appears in one place only.
  for (const amount of ['$31.05', '$10.68', '$9.48']) assert.equal(count(display, amount), 1, amount);

  // Two-year payments: the jump compares payments of the same term, and the three-year total says what it covers.
  const twoYear = { ...payload, names: [{ name: 'lanternbay', free: [{ d: 'ai', s: 'nc' }] }],
    listPrices: { ai: { now: 10, renew: 50, term: 2, shop: 'Dynadot' } } };
  const shown = displayOf(twoYear);
  assert.match(shown, /^- lanternbay\.ai \$10\.00 2y, then \$50\.00\/2y, 5x jump \(list price\)$/m);
  assert.match(shown, /^Best value: lanternbay\.ai, \$60\.00 over 3 years \(covers 4 years\)$/m);
});

test('a checkout cell always links a trusted shop search, never an empty or null link', () => {
  const screen = (row, extra = {}) => JSON.parse(triageText({ prices: { me: { now: 8.7, renew: 15.53 }, no: { now: 7.91, renew: 7.91 } },
    names: [{ verdict: 'No conflict found', reason: 'No close US mark, app or site overlap', ...row }], ...extra })).display;
  const display = screen({ name: 'Lantern Bay', free: ['me'], buy: null });
  assert.ok(display.includes('| [lanternbay.me](https://www.spaceship.com/domain-search/?query=lanternbay.me) |'), display);
  assert.doesNotMatch(display, /\]\((?:null|undefined)?\)/);
  const norway = screen({ name: 'Lantern Bay', free: ['no'] }, { eligible: ['no'] });
  assert.ok(norway.includes('[lanternbay.no](https://www.dynadot.com/domain/search?domain=lanternbay.no)'), norway);
  // Without eligibility .no gets no link and no price.
  const blocked = screen({ name: 'Lantern Bay', free: ['no'] });
  assert.match(blocked, /\.no not eligible: needs Norwegian org\/ID \| — \|/);
  assert.doesNotMatch(blocked, /\$7\.91/);
});

test('.no says plainly that the buyer is not eligible until they say they qualify', () => {
  const base = {
    complete: true, priceListDate: day, eligibility: { no: 'Norwegian address plus organization number or personal ID required' },
    names: [{ name: 'lanternbay', free: [{ d: 'no', s: 'nc' }, { d: 'com', s: 'nc' }] }],
    listPrices: { no: { now: 7.91, renew: 7.91, shop: 'Dynadot' }, com: { now: 9.48, renew: 10.68, shop: 'Dynadot' } },
  };
  const display = displayOf(base);
  assert.match(display, /^\.no not eligible: needs Norwegian org\/ID\.$/m);
  assert.match(display, /^- lanternbay\.no not eligible: needs Norwegian org\/ID$/m);
  assert.match(display, /^Pick: lanternbay\.com$/m);
  assert.doesNotMatch(display, /\$7\.91|^Cheapest now:|^Best value:/m);
  const eligible = displayOf({ ...base, eligible: ['no'] });
  assert.match(eligible, /^\.no: eligible, you said you qualify \(Norwegian org\/ID\)\.$/m);
  assert.match(eligible, /^- lanternbay\.no \$7\.91\/\$7\.91 list price$/m);
  // Eligible .no ranks right after .com: .com stays the pick, .no is the cheapest upfront.
  assert.match(eligible, /^Pick: lanternbay\.com\nCheapest now: lanternbay\.no$/m);

  const exact = displayOf({ ...base, names: [{ name: 'lanternbay.no', free: [{ d: 'no', s: 'nc' }] }],
    buyUrlTemplate: { Dynadot: 'https://www.dynadot.com/domain/search?domain={domain}' } });
  assert.match(exact, /\| not eligible: needs Norwegian org\/ID \|/);
  assert.doesNotMatch(exact, /\]\(https:/);
});

test('an exact .com adds one list-price line for the other endings and a benchmark when taken, with one registry lookup', async t => {
  const directory = await pricedDirectory(t);
  const asked = [];
  const options = registryOptions(directory, { resolveNs: async domain => { asked.push(domain); return ['ns1.example.net']; } });
  const result = await agentResult('lanternbay.com', options);
  assert.deepEqual(asked, ['lanternbay.com']);
  assert.deepEqual(result.names[0], { name: 'lanternbay.com', taken: ['com'] });
  assert.deepEqual(Object.keys(result.otherEndings), ['ai', 'io', 'me', 'co', 'dev', 'app', 'si', 'so', 'xyz', 'tech']);
  assert.deepEqual(result.otherEndings.ai, { now: 159.96, renew: 159.96, y3: 319.92, term: 2, shop: 'Dynadot' });
  const display = displayOf(result);
  assert.match(display, /^\*\*lanternbay\.com is taken\. This check leaves checkout to you\.\*\*/);
  assert.match(display, new RegExp('^Standard \\.com list price \\(benchmark from ' + day + ', USD ex\\. VAT\\): \\$9\\.48/\\$10\\.68\\.$', 'm'));
  const other = display.split('\n').filter(line => line.startsWith('Other endings'));
  assert.equal(other.length, 1);
  assert.match(other[0], /^Other endings \(list prices, availability not checked\): \.ai \$159\.96\/\$159\.96 2y · .*\.co \$3\.11, then \$31\.05\/yr, 10x jump/);
  assert.doesNotMatch(other[0], /\.no /);
  const eligible = await agentResult('lanternbay.com', { ...options, eligible: ['no'] });
  assert.ok(eligible.otherEndings.no);
  const singleBatch = await agentResult(['lanternbay.com'], options);
  assert.deepEqual(singleBatch.otherEndings, result.otherEndings);
  // Other exact endings get no other-endings line. A taken .ai still explains its standard renewal term.
  assert.equal((await agentResult('lanternbay.io', options)).otherEndings, undefined);
  const takenShortAi = displayOf(await agentResult('qxvo.ai', options));
  assert.match(takenShortAi, /Standard \.ai list price .*\$79\.98\/yr renewal, billed as \$159\.96 every 2 years/);
  assert.doesNotMatch(takenShortAi, /\]\(https:/);
});

test('Retry-After is read as seconds or an HTTP date, including waits longer than a day', () => {
  const at = Date.parse('2026-11-24T12:00:00Z');
  assert.equal(retryAfterMs('120', at), 120_000);
  assert.equal(retryAfterMs(' 30 ', at), 30_000);
  assert.equal(retryAfterMs('Tue, 24 Nov 2026 12:10:00 GMT', at), 600_000);
  assert.equal(retryAfterMs('Tue, 24 Nov 2026 11:00:00 GMT', at), 0);
  assert.equal(retryAfterMs('172800', at), 172_800_000);
  for (const value of [null, '', 'soon', '1.5', '-3']) assert.equal(retryAfterMs(value, at), null, String(value));
});

test('a throttled registry host gets no queued requests, stays cooled down for the next process, and DNS gives only a likelihood', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'hound-cooldown-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const directory = pathToFileURL(folder + '/');
  let rdap = 0;
  const options = {
    directory, timeLeft: () => 4000, pause: async () => {}, queryWhois: async () => '',
    fetcher: async url => {
      if (url === bootstrapUrl) return Response.json({ services: [[['app', 'dev'], ['https://pubapi.registry.google/rdap/']]] });
      rdap++;
      return new Response(null, { status: 429, headers: { 'Retry-After': new Date(Date.now() + 7_200_000).toUTCString() } });
    },
    resolveNs: async () => { throw notFound(); },
    authoritativeNs: async domain => domain.startsWith('held') ? 'taken' : 'free',
  };
  const names = ['open1.app', 'open2.dev', 'held3.app', 'open4.dev'].map(domain => ({ domain, tld: domain.split('.')[1] }));
  const first = await lookupRegistrations(names, options);
  assert.equal(rdap, 1);
  assert.ok(first.every(row => row.status === 'unknown' && /HTTP 429/.test(row.reason)), JSON.stringify(first));
  assert.deepEqual(first.map(row => row.likely), ['free', 'free', 'taken', 'free']);
  const second = await lookupRegistrations(names, options);
  assert.equal(rdap, 1, 'the cooldown holds across calls through the cache');
  assert.ok(second.every(row => row.status === 'unknown' && row.likelySource === 'dns'));

  // An agent row with a DNS likelihood stays a shop check: never free without the registry or a shop.
  const agent = await agentResult(['openfive'], { ...options, env: {}, endings: ['app', 'dev'], bundledCatalog: null,
    budgetMs: 3000, cachedOnly: true });
  assert.deepEqual(agent.names[0].shop_check, ['dev', 'app']);
  assert.deepEqual(agent.names[0].likely_free, ['dev', 'app']);
  assert.equal(agent.names[0].free, undefined);
  assert.match(displayOf(agent), /^Likely free \(DNS\), confirm at shop: openfive \.dev \.app$/m);
  const [failedDns] = await lookupRegistrations([{ domain: 'uncertain.app', tld: 'app' }], {
    ...options, authoritativeNs: async () => null,
    resolveNs: async () => { throw Object.assign(Error('DNS failure'), { code: 'ESERVFAIL' }); },
  });
  assert.equal(failedDns.status, 'unknown');
  assert.equal(failedDns.likely, undefined);
});

test('a throttled ending falls back to the registry WHOIS that IANA documents, and the DNS step has a deadline', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'hound-whois-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const directory = pathToFileURL(folder + '/');
  const hosts = [];
  const fetcher = async url => url === bootstrapUrl
    ? Response.json({ services: [[['app'], ['https://pubapi.registry.google/rdap/']]] })
    : new Response(null, { status: 429 });
  const names = [{ domain: 'open1.me', tld: 'me' }, { domain: 'held2.me', tld: 'me' }];
  const settled = await lookupRegistrations(names, {
    directory, fetcher, timeLeft: () => 4000, pause: async () => {}, resolveNs: async () => { throw notFound(); },
    queryWhois: async (host, term) => {
      hosts.push(host);
      if (host === 'whois.iana.org') return 'refer: whois.nic.me\n';
      return term.startsWith('held') ? 'Domain Name: ' + term + '\n' : 'Domain not found.\n';
    },
  });
  assert.deepEqual(settled.map(row => [row.status, row.source]), [['free', 'whois'], ['taken', 'whois']]);
  assert.ok(hosts.includes('whois.nic.me'));

  // A resolver that never answers cannot hold the lookup past its deadline.
  const started = performance.now();
  const [slow] = await lookupRegistrations([{ domain: 'open3.app', tld: 'app' }], {
    directory: null, fetcher, pause: async () => {}, queryWhois: async () => '', resolveNs: async () => { throw notFound(); },
    timeLeft: () => 1600 - (performance.now() - started), authoritativeNs: () => new Promise(() => {}),
  });
  assert.ok(performance.now() - started < 2500);
  assert.equal(slow.status, 'unknown');
  assert.equal(slow.likely, 'free', 'the recursive NXDOMAIN still gives the likelihood');
});

test('CI runs the tests on Windows too and smokes the packed package through npx', () => {
  const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /windows-latest/);
  assert.match(ci, /package-smoke:/);
  assert.match(ci, /node scripts\/package-smoke\.mjs/);
  assert.ok(existsSync(new URL('../../scripts/package-smoke.mjs', import.meta.url)));
});

// Release workflow: the readiness wait and the published npx smoke run against fixture npm and npx commands on PATH.
// The workflow shell is bash on ubuntu-latest, so these run where bash is; Windows CI covers the rest of the suite.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const publishYml = () => readFileSync(join(repoRoot, '.github/workflows/publish.yml'), 'utf8').replace(/\r\n/g, '\n');
const shellTests = { skip: process.platform === 'win32' && 'the release workflow shell runs on Linux' };

// The `run: |` block of one named step, dedented, exactly as GitHub Actions hands it to the shell.
function stepRun(workflow, name) {
  const lines = workflow.split('\n');
  const at = lines.findIndex(line => line.trim() === '- name: ' + name);
  assert.ok(at >= 0, 'No step named ' + name);
  const next = lines.findIndex((line, index) => index > at && /^\s*- (?:name|uses):/.test(line));
  const runAt = lines.findIndex((line, index) => index > at && /^\s+run: \|$/.test(line));
  assert.ok(runAt > at && (next < 0 || runAt < next), 'Step ' + name + ' has no run block');
  const indent = lines[runAt].search(/\S/);
  const body = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() && line.search(/\S/) <= indent) break;
    body.push(line);
  }
  while (body.length && !body.at(-1).trim()) body.pop();
  const strip = Math.min(...body.filter(line => line.trim()).map(line => line.search(/\S/)));
  return body.map(line => line.slice(strip)).join('\n') + '\n';
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, args, { ...options, timeout: 12_000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr, ms: performance.now() - started }));
  });
}

// A fixture command: a sh wrapper on PATH that runs a Node script with this Node.
async function fixtureCommand(bin, name, source) {
  await writeFile(join(bin, name + '.mjs'), source);
  await writeFile(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, name + '.mjs')}" "$@"\n`);
  await chmod(join(bin, name), 0o755);
}

// Each call takes the next answer from plan.json (the last one repeats) and logs its arguments and npm cache.
const planned = `import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
const dir = process.env.FIXTURE_DIR;
const plan = JSON.parse(readFileSync(dir + '/plan.json', 'utf8'));
const count = existsSync(dir + '/count') ? Number(readFileSync(dir + '/count', 'utf8')) : 0;
writeFileSync(dir + '/count', String(count + 1));
const args = process.argv.slice(2);
const cache = args.includes('--cache') ? args[args.indexOf('--cache') + 1] : process.env.npm_config_cache;
const fresh = !existsSync(cache) || readdirSync(cache).length === 0;
appendFileSync(dir + '/calls.jsonl', JSON.stringify({ args, cache, fresh }) + '\\n');
// Like npm, leave something in the cache, so a reused cache would no longer look fresh.
mkdirSync(cache + '/_cacache', { recursive: true });
export const step = plan[Math.min(count, plan.length - 1)];
`;

async function fixtureBin(t, plan) {
  const dir = await mkdtemp(join(tmpdir(), 'hound-release-fixture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'plan.json'), JSON.stringify(plan));
  await writeFile(join(dir, 'planned.mjs'), planned);
  // Nothing in the wait may touch the tarball URL; a curl or wget call is recorded and fails.
  for (const name of ['curl', 'wget']) {
    await writeFile(join(dir, name), `#!/bin/sh\necho "$0 $*" >> "${join(dir, 'downloads')}"\nexit 22\n`);
    await chmod(join(dir, name), 0o755);
  }
  // macOS ships no coreutils timeout; a minimal stand-in keeps the shell runnable there. Linux CI uses the real one.
  if (spawnSync('sh', ['-c', 'command -v timeout']).status !== 0) {
    await writeFile(join(dir, 'timeout'), '#!/bin/sh\n[ "$1" = "-s" ] && shift 2\nsecs=$1; shift\n'
      + 'exec perl -e \'alarm shift; exec @ARGV or die\' "$secs" "$@"\n');
    await chmod(join(dir, 'timeout'), 0o755);
  }
  const calls = async () => (await readFile(join(dir, 'calls.jsonl'), 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { dir, calls, env: { ...process.env, PATH: dir + ':' + process.env.PATH, FIXTURE_DIR: dir } };
}

const fakeNpm = `const { step } = await import(process.env.FIXTURE_DIR + '/planned.mjs');
if (step === 'ok') console.log('0.1.6');
else if (step === 'stale') console.log('0.1.5');
else if (step === 'e404') { console.error('npm error code E404\\nnpm error 404 Not Found - GET https://registry.npmjs.org/domain-hound'); process.exit(1); }
else if (step === 'hang') setInterval(() => {}, 1000);
// 'empty': npm view exits 0 and prints nothing when the version is not in the document yet.
`;

async function waitStep(t, plan, timing) {
  const fixture = await fixtureBin(t, plan);
  await fixtureCommand(fixture.dir, 'npm', fakeNpm);
  const script = join(fixture.dir, 'wait.sh');
  await writeFile(script, stepRun(publishYml(), 'Wait until npm lists the new version'));
  const result = await run('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
    env: { ...fixture.env, VERSION: '0.1.6', ...timing } });
  return { ...result, calls: await fixture.calls(), downloaded: existsSync(join(fixture.dir, 'downloads')) };
}

test('the publish workflow waits on npm view with fresh caches, then smokes through npx before the MCP Registry', () => {
  const workflow = publishYml();
  const wait = stepRun(workflow, 'Wait until npm lists the new version');
  assert.match(wait, /npm view "domain-hound@\$\{VERSION\}" version/);
  assert.match(wait, /--cache "\$cache"/);
  assert.match(wait, /timeout -s KILL "\$limit" npm view/);
  assert.doesNotMatch(workflow, /curl[^\n]*domain-hound-\$\{?VERSION|registry\.npmjs\.org\/domain-hound\/-\//,
    'no step fetches the tarball URL');
  assert.match(workflow, /run: node scripts\/package-smoke\.mjs --published "\$VERSION"/);
  assert.match(workflow, /mcp-registry:\n\s+needs: \[publish, smoke\]/);
  const smokeJob = workflow.slice(workflow.indexOf('  smoke:'), workflow.indexOf('  mcp-registry:'));
  const minutes = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(smokeJob)?.[1]);
  assert.ok(minutes >= 15 + 10 + 5, 'the smoke job has room for setup beyond both retry windows: ' + minutes);
  const steps = [...smokeJob.matchAll(/^ {8}timeout-minutes: (\d+)$/gm)].map(match => Number(match[1]));
  assert.equal(steps[0], 15);
  assert.ok(steps[1] >= 10 && steps[0] + steps[1] < minutes, steps.join());
});

test('the readiness wait needs three npm view answers in a row and starts the count again after a miss', shellTests, async t => {
  const plan = ['e404', 'empty', 'stale', 'ok', 'ok', 'e404', 'ok', 'ok', 'ok', 'e404'];
  const result = await waitStep(t, plan, { READY_TIMEOUT_SECONDS: '60', READY_ATTEMPT_SECONDS: '10', READY_POLL_SECONDS: '0' });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.calls.length, 9, 'stops at the third answer in a row');
  assert.ok(result.calls.every(call => call.args.slice(0, 3).join(' ') === 'view domain-hound@0.1.6 version'), JSON.stringify(result.calls));
  assert.equal(new Set(result.calls.map(call => call.cache)).size, 9, 'a new npm cache for every try');
  assert.ok(result.calls.every(call => call.fresh), 'every cache starts empty');
  assert.match(result.stdout, /^Try 5: npm view lists 0\.1\.6 \(2 of 3 in a row\)\.$/m);
  assert.match(result.stdout, /^Try 6: not listed yet \(npm view exit 1: npm error code E404/m);
  assert.match(result.stdout, /^Try 3: not listed yet \(npm view answered '0\.1\.5'\)\.$/m);
  assert.match(result.stdout, /^Try 9: npm view lists 0\.1\.6 \(3 of 3 in a row\)\.$/m);
  assert.equal(result.downloaded, false, 'no tarball download');
});

test('the readiness wait gives up at its deadline even when npm view hangs', shellTests, async t => {
  const result = await waitStep(t, ['hang'], { READY_TIMEOUT_SECONDS: '3', READY_ATTEMPT_SECONDS: '1', READY_POLL_SECONDS: '0' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /was not listed by npm view 3 times in a row within 3 s/);
  assert.match(result.stdout, /not listed yet/);
  assert.ok(result.ms < 9000, 'ends near its deadline: ' + Math.round(result.ms) + ' ms');
});

// The fake npx fails like npm while the version is missing, then serves this checkout's MCP server.
const fakeNpx = `const { step } = await import(process.env.FIXTURE_DIR + '/planned.mjs');
if (step === 'etarget') {
  console.error('npm error code ETARGET\\nnpm error notarget No matching version found for domain-hound@0.1.6.');
  process.exit(1);
} else if (step === 'e404') {
  console.error('npm error code E404');
  process.exit(1);
} else if (step === 'other') {
  console.error('npm error code EACCES\\nnpm error syscall mkdir');
  process.exit(1);
} else {
  if (step.startsWith('hang')) {
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  }
  if (step !== 'hang') await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'bin/domain-hound.mjs')).href)});
}
`;

async function publishedSmoke(t, plan, env = {}) {
  const fixture = await fixtureBin(t, plan);
  await fixtureCommand(fixture.dir, 'npx', fakeNpx);
  const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const result = await run(process.execPath, [join(repoRoot, 'scripts/package-smoke.mjs'), '--published', version], {
    env: { ...fixture.env, PACKAGE_SMOKE_RETRY_DELAY_MS: '0', ...env } });
  return { ...result, calls: await fixture.calls(), version };
}

test('the published smoke retries ETARGET and E404 with fresh npm caches, then lists the tools', shellTests, async t => {
  const result = await publishedSmoke(t, ['etarget', 'e404', 'serve']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.calls.length, 3);
  assert.ok(result.calls.every(call => call.args.join(' ') === '-y domain-hound@' + result.version), JSON.stringify(result.calls));
  assert.equal(new Set(result.calls.map(call => call.cache)).size, 3);
  assert.ok(result.calls.every(call => call.fresh));
  assert.match(result.stderr, /Attempt 2: npx could not find domain-hound@[\d.]+ yet \(ETARGET\/E404\)/);
  assert.match(result.stderr, /npm error notarget No matching version found/, 'npm diagnostics still reach the log');
  assert.match(result.stdout, /^MCP tools: check_domains, /m);
  assert.match(result.stdout, /Published npx smoke on .*, attempt 3$/m);
});

test('the published smoke fails at once on any other npx error and stops retrying at its overall cap', shellTests, async t => {
  const other = await publishedSmoke(t, ['other', 'serve']);
  assert.notEqual(other.code, 0);
  assert.equal(other.calls.length, 1, 'no retry for an unrelated error');
  assert.match(other.stderr, /npm error code EACCES/);

  const stale = await publishedSmoke(t, ['etarget'], { PACKAGE_SMOKE_WINDOW_MS: '1500', PACKAGE_SMOKE_RETRY_DELAY_MS: '200' });
  assert.notEqual(stale.code, 0);
  assert.ok(stale.calls.length >= 2, 'retried within the window');
  assert.match(stale.stderr, /npm error code ETARGET/);
  // The overall cap can expire while the last retry is in flight.
  assert.match(stale.stderr, /npx still could not find domain-hound@[\d.]+ after \d+ attempts|npx smoke timed out after [12] s/);
  assert.ok(stale.ms < 8000, Math.round(stale.ms) + ' ms');

  // A hanging npx is cut off at the overall cap, not after the full per-attempt allowance.
  const hung = await publishedSmoke(t, ['hang'], { PACKAGE_SMOKE_WINDOW_MS: '1500' });
  assert.notEqual(hung.code, 0);
  assert.equal(hung.calls.length, 1);
  assert.match(hung.stderr, /npx smoke timed out after 2 s/);
  assert.ok(hung.ms < 8000, Math.round(hung.ms) + ' ms');

  const hungAfterReply = await publishedSmoke(t, ['hang-after-reply'], { PACKAGE_SMOKE_WINDOW_MS: '1500' });
  assert.equal(hungAfterReply.code, 1);
  assert.match(hungAfterReply.stderr, /npx smoke timed out after 2 s/);
  assert.doesNotMatch(hungAfterReply.stdout, /Published npx smoke/);
  assert.ok(hungAfterReply.ms < 8000, Math.round(hungAfterReply.ms) + ' ms');
});
