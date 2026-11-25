import '../../test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { registryFacts } from '../domain-check/dossier.mjs';
import { bootstrapUrl } from '../domain-check/registry.mjs';
import { resultsLine } from '../../results.mjs';
import { checkDomain, dnsHost, mailCheck, moneyFacts, portfolioRegistry, readRegistry, siteCheck, sortByUrgency, statusOnly, tlsCheck,
  urgency } from './checks.mjs';
import { domainsInFile, ownDomain, projectCandidates, spaceshipDomains } from './discover.mjs';
import { portfolioPages } from './page.mjs';
import { checkAll, myDomains, portfolioTool, sayLines } from './portfolio.mjs';
import { readList, writeList } from './store.mjs';

const fixture = async name => JSON.parse(await readFile(new URL('./fixtures/' + name, import.meta.url), 'utf8'));
const now = new Date('2026-11-25T12:00:00Z');
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const dnsError = code => Object.assign(new Error(code), { code });

async function scratch(t, prefix = 'hound-portfolio-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// A complete row with every check answered, for the say, order and page tests.
function row(domain, overrides = {}) {
  const base = {
    domain, checkedAt: now.toISOString(),
    registry: { state: 'ok', problems: [], registrar: 'Example Registrar', created: '2020-01-01T00:00:00.000Z',
      expires: '2027-06-01T00:00:00.000Z', daysLeft: 188, status: [], autoRenewGrace: false, transferLock: true, nameservers: [] },
    dnsHost: 'Cloudflare',
    site: { state: 'ok', httpStatus: 200 },
    tls: { state: 'ok', expires: '2027-01-01T00:00:00.000Z', daysLeft: 37 },
    email: { state: 'ok', mx: true, spf: true, dmarc: true },
    money: { currentShop: null, current: null, cheapest: null, move: null },
  };
  return Object.fromEntries(Object.entries(base).map(([key, value]) => [key,
    overrides[key] && typeof value === 'object' && value ? { ...value, ...overrides[key] } : overrides[key] ?? value]));
}

// ---- Registry -----------------------------------------------------------------------------------------------------

test('reads registrar, dates, status codes and name servers from an RDAP fixture, never claiming auto-renew on its own', async () => {
  const rdap = await fixture('rdap-lanternbay.json');
  const iana = await fixture('iana-dns.json');
  const requested = [];
  const fetcher = async url => {
    requested.push(String(url));
    if (String(url) === bootstrapUrl) return json(200, iana);
    if (String(url) === 'https://rdap.verisign.com/com/v1/domain/lanternbay.com') return json(200, rdap);
    throw Error('unexpected request ' + url);
  };
  const facts = await registryFacts('lanternbay.com', { fetcher, resolveNs: async () => ['ada.ns.cloudflare.com'],
    queryWhois: async () => '', clock: () => now });
  const record = readRegistry(facts, now);
  assert.equal(record.state, 'ok');
  assert.equal(record.registrar, 'Spaceship, Inc.');
  assert.equal(record.created, '2021-03-04T10:00:00.000Z');
  assert.equal(record.expires, '2026-12-07T10:00:00.000Z');
  assert.equal(record.daysLeft, 11);
  assert.equal(record.autoRenewGrace, true);
  assert.equal(record.transferLock, true);
  assert.equal(dnsHost(record.nameservers), 'Cloudflare');
  assert.ok(requested.every(url => url.startsWith('https://')));

  // Without the registry's grace status nothing about auto-renew is shown.
  const plain = readRegistry({ ...facts, status: ['client transfer prohibited'] }, now);
  assert.equal(plain.autoRenewGrace, false);
  const lines = sayLines([row('lanternbay.com', { registry: plain })]).join('\n');
  assert.doesNotMatch(lines, /auto-?renew/i);
  assert.match(sayLines([row('lanternbay.com', { registry: record })]).join('\n'), /registry shows auto-renew grace/);
});

test('flags lapsed and held registrations and keeps a silent registry unknown', () => {
  const base = { registered: 'taken', expires: '2026-11-20T00:00:00Z', status: ['redemption period'], nameservers: [] };
  const lapsed = readRegistry(base, now);
  assert.equal(lapsed.state, 'problem');
  assert.deepEqual(lapsed.problems, ['expired 6 days ago', 'in redemption: the registration lapsed and must be restored']);
  assert.equal(readRegistry({ registered: 'taken', status: ['pending delete'], nameservers: [] }, now).state, 'problem');
  const silent = readRegistry({ registered: 'unknown', reason: 'RDAP timed out', nameservers: [] }, now);
  assert.equal(silent.state, 'unknown');
  assert.equal(silent.reason, 'RDAP timed out');
  assert.equal(readRegistry(null, now).state, 'unknown');
});

test('uses public WHOIS facts when RDAP cannot supply them', async () => {
  const requested = [];
  const facts = await portfolioRegistry('example.com', {
    rdap: async () => ({ registered: 'taken', source: { method: 'dns' }, nameservers: [] }),
    query: async (host, query) => {
      requested.push([host, query]);
      if (host === 'whois.iana.org') return 'refer: whois.example.net';
      return ['Domain Name: EXAMPLE.COM', 'Registrar: Example Registrar', 'Creation Date: 2018-06-01T00:00:00Z',
        'Registry Expiry Date: 2027-06-01T00:00:00Z', 'Domain Status: clientTransferProhibited https://icann.org/epp',
        'Name Server: NS1.EXAMPLE.NET'].join('\n');
    },
  });
  assert.deepEqual(requested, [['whois.iana.org', 'com'], ['whois.example.net', 'example.com']]);
  assert.equal(facts.source.method, 'whois');
  assert.equal(facts.registrar, 'Example Registrar');
  assert.deepEqual(facts.status, ['client transfer prohibited']);
  assert.deepEqual(facts.nameservers, ['ns1.example.net']);
  assert.equal(facts.expires, '2027-06-01T00:00:00.000Z');
});

test('names the DNS host from name servers', () => {
  assert.equal(dnsHost(['ns-1.awsdns-01.org']), 'AWS Route 53');
  assert.equal(dnsHost(['ns1.vercel-dns.com']), 'Vercel');
  assert.equal(dnsHost(['launch1.spaceship.net']), 'Spaceship');
  assert.equal(dnsHost(['dns1.registrar-servers.com']), 'Namecheap');
  assert.equal(dnsHost(['ns1.example-dns.net.']), 'example-dns.net');
  assert.equal(dnsHost(['ns1.lanternbay.co.uk']), 'lanternbay.co.uk');
  assert.equal(dnsHost([]), null);
});

// ---- Website ------------------------------------------------------------------------------------------------------

test('follows public redirects and reports the target', async () => {
  const load = async url => url.hostname === 'lanternbay.com'
    ? { status: 301, location: 'https://www.lanternbay-app.com/start?utm_source=x' } : { status: 200 };
  const site = await siteCheck('lanternbay.com', { load });
  assert.equal(site.state, 'ok');
  assert.equal(site.httpStatus, 200);
  assert.equal(site.redirect, 'https://www.lanternbay-app.com/start');
});

test('never probes a redirect to a private, local or IP destination; such a site is unknown, not down', async () => {
  for (const target of ['http://127.0.0.1/admin', 'http://10.0.0.1/', 'http://[::1]/', 'http://router.local/',
    'http://intranet.corp/', 'http://user:pass@lanternbay.com/', 'http://lanternbay.com:8080/', 'file:///etc/passwd']) {
    const requested = [];
    const load = async url => {
      requested.push(url.href);
      return url.hostname === 'lanternbay.com' && !url.port ? { status: 302, location: target } : { status: 200 };
    };
    const site = await siteCheck('lanternbay.com', { load });
    assert.equal(site.state, 'unknown', target);
    assert.match(site.reason, /private or unsafe address; not followed/);
    assert.ok(requested.every(url => /^https?:\/\/lanternbay\.com\/$/.test(url)), target + ' was requested: ' + requested);
  }
});

test('the status probe resolves only public addresses, so a local server is never reached', async t => {
  let hits = 0;
  const server = createServer((_request, response) => { hits++; response.end('ok'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  await assert.rejects(statusOnly(new URL('http://localhost:' + port + '/'), AbortSignal.timeout(3000)));
  assert.equal(hits, 0);
});

test('keeps timeouts unknown and real failures as problems', async () => {
  const timeout = async () => { throw dnsError('ETIMEDOUT'); };
  assert.deepEqual(await siteCheck('lanternbay.com', { load: timeout }), { state: 'unknown', reason: 'no answer in time' });
  const refused = async () => { throw dnsError('ECONNREFUSED'); };
  assert.deepEqual(await siteCheck('lanternbay.com', { load: refused }), { state: 'problem', reason: 'connection refused' });
  const broken = await siteCheck('lanternbay.com', { load: async () => ({ status: 503 }) });
  assert.equal(broken.state, 'problem');
  assert.equal(broken.reason, 'HTTP 503');
  const walled = await siteCheck('lanternbay.com', { load: async () => ({ status: 403 }) });
  assert.equal(walled.state, 'ok');
  // A working http site with a broken https side is up, with a note.
  const httpOnly = await siteCheck('lanternbay.com', { load: async url => {
    if (url.protocol === 'https:') throw dnsError('ECONNREFUSED');
    return { status: 200 };
  } });
  assert.equal(httpOnly.state, 'ok');
  assert.match(httpOnly.note, /^http only; https: connection refused/);
  // On an HTTPS-only ending, a responding HTTP site does not settle whether HTTPS works.
  const silentHttps = async url => {
    if (url.protocol === 'https:') throw dnsError('ETIMEDOUT');
    return { status: 200 };
  };
  const preloaded = await siteCheck('lanternbay.app', { load: silentHttps });
  assert.equal(preloaded.state, 'unknown');
  assert.equal(preloaded.reason, 'HTTPS no answer in time. Browsers require HTTPS on .app');
  assert.equal(preloaded.httpStatus, 200);
  assert.equal((await siteCheck('lanternbay.app', { load: async url => {
    if (url.protocol === 'https:') throw dnsError('ECONNREFUSED');
    return { status: 200 };
  } })).state, 'problem');
  assert.equal((await siteCheck('lanternbay.com', { load: silentHttps })).state, 'ok');
  // With neither side answering, it stays unknown.
  assert.equal((await siteCheck('lanternbay.app', { load: timeout })).state, 'unknown');
});

// ---- Certificate --------------------------------------------------------------------------------------------------

test('reads certificate expiry and separates invalid, missing and unanswered certificates', async () => {
  const answer = fields => async () => ({ authorized: true, error: null, issuer: "Let's Encrypt", ...fields });
  const valid = await tlsCheck('lanternbay.com', { now, read: answer({ validTo: 'Feb 23 12:00:00 2027 GMT' }) });
  assert.equal(valid.state, 'ok');
  assert.equal(valid.daysLeft, 90);
  assert.equal(valid.expires, '2027-02-23T12:00:00.000Z');
  const soon = await tlsCheck('lanternbay.com', { now, read: answer({ validTo: 'Nov 30 12:00:00 2026 GMT' }) });
  assert.equal(soon.state, 'problem');
  assert.match(soon.reason, /certificate expires in 5 days/);
  const expired = await tlsCheck('lanternbay.com', { now,
    read: answer({ authorized: false, error: 'CERT_HAS_EXPIRED', validTo: 'Nov 1 12:00:00 2026 GMT' }) });
  assert.equal(expired.state, 'problem');
  assert.equal(expired.reason, 'certificate expired');
  const mismatch = await tlsCheck('lanternbay.com', { now, read: answer({ authorized: false, error: 'ERR_TLS_CERT_ALTNAME_INVALID' }) });
  assert.match(mismatch.reason, /certificate invalid \(ERR_TLS_CERT_ALTNAME_INVALID\)/);
  assert.equal((await tlsCheck('lanternbay.com', { read: async () => { throw dnsError('ETIMEDOUT'); } })).state, 'unknown');
  assert.equal((await tlsCheck('lanternbay.com', { read: async () => { throw dnsError('ECONNREFUSED'); } })).state, 'none');
});

// ---- Email --------------------------------------------------------------------------------------------------------

function resolver(answers) {
  const answer = async name => {
    const value = answers[name];
    if (value instanceof Error) throw value;
    if (value === undefined) throw dnsError('ENODATA');
    return value;
  };
  return { resolveMx: name => answer('mx:' + name), resolveTxt: name => answer('txt:' + name) };
}

test('checks MX, SPF and DMARC, and keeps resolver silence unknown', async () => {
  const full = await mailCheck('lanternbay.com', { resolver: resolver({
    'mx:lanternbay.com': [{ exchange: 'mx1.example-mail.net', priority: 10 }],
    'txt:lanternbay.com': [['v=spf1 include:', 'example-mail.net ~all'], ['site-verification=abc']],
    'txt:_dmarc.lanternbay.com': [['v=DMARC1; p=quarantine']],
  }) });
  assert.equal(full.state, 'ok');
  assert.deepEqual([full.mx, full.spf, full.dmarc], [true, true, true]);
  const noDmarc = await mailCheck('lanternbay.com', { resolver: resolver({
    'mx:lanternbay.com': [{ exchange: 'mx1.example-mail.net', priority: 10 }],
    'txt:lanternbay.com': [['v=spf1 -all']],
  }) });
  assert.equal(noDmarc.state, 'problem');
  assert.equal(noDmarc.reason, 'mail without DMARC');
  const nullMx = await mailCheck('lanternbay.com', { resolver: resolver({ 'mx:lanternbay.com': [{ exchange: '', priority: 0 }] }) });
  assert.equal(nullMx.state, 'none');
  assert.equal(nullMx.mx, 'null');
  assert.equal((await mailCheck('lanternbay.com', { resolver: resolver({}) })).state, 'none');
  const silent = await mailCheck('lanternbay.com', { resolver: resolver({ 'mx:lanternbay.com': dnsError('ETIMEOUT') }) });
  assert.equal(silent.state, 'unknown');
  const servfail = await mailCheck('lanternbay.com', { resolver: resolver({
    'mx:lanternbay.com': [{ exchange: 'mx1.example-mail.net', priority: 10 }],
    'txt:lanternbay.com': [['v=spf1 -all']], 'txt:_dmarc.lanternbay.com': dnsError('ESERVFAIL'),
  }) });
  assert.equal(servfail.state, 'unknown');
});

// ---- Money --------------------------------------------------------------------------------------------------------

const checkedAt = '2026-11-25T10:00:00.000Z';
const catalog = { checkedAt, catalogs: {
  spaceship: { checkedAt, prices: { com: { shop: 'Spaceship', firstYear: 9.48, renewal: 10.68, transfer: 10.18 } } },
  dynadot: { checkedAt, prices: { com: { shop: 'Dynadot', firstYear: 10.88, renewal: 30, transfer: 11 } } },
  porkbun: { checkedAt, prices: { com: { shop: 'Porkbun', firstYear: 1, renewal: 1, transfer: 1 } } },
} };

test('offers a move only when it saves more than $5 a year at dated list prices, never to a data-only shop', () => {
  const atDynadot = moneyFacts('lanternbay.com', 'DYNADOT LLC', catalog, now);
  assert.equal(atDynadot.current.renewal, 30);
  assert.equal(atDynadot.current.checkedAt, checkedAt);
  assert.equal(atDynadot.move.to, 'Spaceship');
  assert.equal(atDynadot.move.saving, 58.46);
  assert.equal(atDynadot.move.url, 'https://www.spaceship.com/domains/transfer/');
  assert.equal(atDynadot.cheapest.shop, 'Porkbun', 'Porkbun can show as price data');

  assert.equal(moneyFacts('lanternbay.com', 'Spaceship, Inc.', catalog, now).move, null);
  // At Porkbun its own renewal is the current price. A data-only shop is never a transfer destination.
  const atPorkbun = moneyFacts('lanternbay.com', 'Porkbun LLC', catalog, now);
  assert.equal(atPorkbun.current.renewal, 1);
  assert.equal(atPorkbun.move, null);
  // Under $5 a year: no offer.
  const close = { checkedAt, catalogs: { ...catalog.catalogs,
    dynadot: { checkedAt, prices: { com: { shop: 'Dynadot', firstYear: 10, renewal: 15, transfer: 11 } } } } };
  assert.equal(moneyFacts('lanternbay.com', 'Dynadot Inc', close, now).move, null);
  // An unknown registrar has no current price and so no saving claim.
  const elsewhere = moneyFacts('lanternbay.com', 'Example Registrar', catalog, now);
  assert.equal(elsewhere.current, null);
  assert.equal(elsewhere.move, null);
});

// ---- Order and say ------------------------------------------------------------------------------------------------

test('sorts by urgency and keeps the say short, with only the two next-step lines', () => {
  const rows = sortByUrgency([
    row('fine.com'),
    row('cheaper.com', { money: { currentShop: 'Dynadot', current: { renewal: 30 },
      move: { to: 'Spaceship', saving: 58.46, url: 'https://www.spaceship.com/domains/transfer/', checkedAt } } }),
    row('mailless.com', { email: { state: 'problem', reason: 'mail without DMARC' } }),
    row('silent.com', { site: { state: 'unknown', reason: 'no answer in time' } }),
    row('soon.com', { registry: { daysLeft: 12, expires: '2026-12-07T00:00:00.000Z', registrar: 'Spaceship, Inc.' } }),
    row('lapsed.com', { registry: { state: 'problem', problems: ['expired 2 days ago'], daysLeft: -2 } }),
  ]);
  assert.deepEqual(rows.map(item => item.domain), ['lapsed.com', 'soon.com', 'mailless.com', 'cheaper.com', 'silent.com', 'fine.com']);
  assert.deepEqual(rows.map(urgency), [0, 1, 2, 3, 4, 5]);
  const lines = sayLines(rows);
  assert.ok(lines.length <= 7);
  assert.equal(lines[0], '6 domains: 4 need attention. 1 check had no answer (see the page).');
  assert.equal(lines[1], 'lapsed.com: expired 2 days ago.');
  assert.equal(lines[2], 'soon.com: expires in 12 days (2026-12-07) at Spaceship, Inc.');
  assert.match(lines.join('\n'), /mailless\.com: mail without DMARC\./);
  assert.ok(lines.includes('Next: move to save $58.46 over 3 years on cheaper.com. [Spaceship transfer](https://www.spaceship.com/domains/transfer/). List prices from 2026-11-25. Ask to plan the move with move_domain.'));
  assert.ok(lines.includes('Next: watch expiry by email for soon.com (2026-12-07).'));
  // An unknown check is never listed as a failure.
  assert.doesNotMatch(lines.join('\n'), /silent\.com/);
});

test('a domain that outlives the budget is shown with unknown checks instead of holding up the rest', async () => {
  const checker = domain => domain === 'slow.com' ? new Promise(() => {}) : Promise.resolve(row(domain));
  const started = performance.now();
  const rows = await checkAll(['fast.com', 'slow.com'], { checker, now, budgetMs: 200, catalog });
  assert.ok(performance.now() - started < 2000);
  assert.equal(rows[0].site.state, 'ok');
  assert.equal(rows[1].registry.state, 'unknown');
  assert.equal(rows[1].site.state, 'unknown');
});

test('checkDomain runs every check on one domain and survives a failing check', async () => {
  const result = await checkDomain('lanternbay.com', { now, catalog,
    registry: async () => ({ registered: 'taken', registrar: 'DYNADOT LLC', expires: '2027-01-01T00:00:00Z', status: [],
      nameservers: ['ns1.example-dns.net'] }),
    resolveNs: async () => ['ns1.vercel-dns.com'],
    site: async () => { throw Error('boom'); },
    tls: async () => ({ state: 'ok', expires: '2027-01-01T00:00:00.000Z', daysLeft: 37 }),
    mail: async () => ({ state: 'none', mx: false, spf: false, dmarc: false, reason: 'no email set up' }) });
  assert.equal(result.registry.registrar, 'DYNADOT LLC');
  assert.equal(result.dnsHost, 'Vercel');
  assert.deepEqual(result.nameservers, ['ns1.vercel-dns.com']);
  assert.equal(result.site.state, 'unknown');
  assert.equal(result.money.move.to, 'Spaceship');
});

// ---- Discovery ----------------------------------------------------------------------------------------------------

test('finds candidates in project files only, never opening .env or following symlinks', async t => {
  const root = await scratch(t);
  const project = join(root, 'example-app');
  await mkdir(join(project, 'site'), { recursive: true });
  await mkdir(join(project, 'node_modules', 'dep'), { recursive: true });
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'x', homepage: 'https://www.lanternbay.com/docs' }));
  await writeFile(join(project, 'site', 'CNAME'), 'quietotter.dev\n');
  await writeFile(join(project, 'wrangler.toml'), 'main = "src/index.ts"\nroutes = [\n  { pattern = "api.paperheron.io/*", zone_name = "paperheron.io" }\n]\n');
  await writeFile(join(project, 'README.md'), 'See https://hushroom.app and https://github.com/x/y and https://example-app.github.io/');
  await writeFile(join(project, '.env'), 'SECRET_URL=https://leakydomain.com\nTOKEN=not-a-real-token\n');
  await writeFile(join(project, '.env.local'), 'https://leakylocal.com\n');
  await writeFile(join(project, 'node_modules', 'dep', 'package.json'), JSON.stringify({ homepage: 'https://dependency.com' }));
  const outside = join(root, 'outside.md');
  await writeFile(outside, 'https://symlinked.com');
  await mkdir(join(project, 'docs'));
  await symlink(outside, join(project, 'docs', 'README.md'));

  const found = await projectCandidates([project]);
  const domains = found.map(item => item.domain);
  assert.deepEqual(domains, ['lanternbay.com', 'paperheron.io', 'quietotter.dev', 'hushroom.app']);
  assert.deepEqual(found.find(item => item.domain === 'quietotter.dev').sources, ['example-app/site/CNAME']);
  for (const leaked of ['leakydomain.com', 'leakylocal.com', 'dependency.com', 'symlinked.com', 'index.ts', 'github.com']) {
    assert.ok(!domains.includes(leaked), leaked);
  }
  assert.ok(found.every(item => item.sources.every(source => !source.includes(root))), 'no absolute paths');
});

test('reduces hosts to registrable domains and skips hosted subdomains and third parties', () => {
  assert.equal(ownDomain('www.lanternbay.co.uk'), 'lanternbay.co.uk');
  assert.equal(ownDomain('api.paperheron.io'), 'paperheron.io');
  assert.equal(ownDomain('example-app.github.io'), null);
  assert.equal(ownDomain('my-app.vercel.app'), null);
  assert.equal(ownDomain('github.com'), null);
  assert.equal(ownDomain('192.168.1.1'), null);
  assert.deepEqual(domainsInFile('vercel.json', JSON.stringify({ alias: ['lanternbay.com'] })), ['lanternbay.com']);
});

test('lists Spaceship domains read-only with injected test credentials, and stays silent without a key', async () => {
  const list = await fixture('spaceship-domains.json');
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url: String(url), method: options.method, redirect: options.redirect, key: options.headers['X-API-Key'] });
    return json(200, list);
  };
  const keys = async () => ({ key: 'test-key', secret: 'test-secret' });
  const found = await spaceshipDomains({ credentials: keys, fetcher });
  assert.deepEqual(found, { state: 'ok', domains: ['lanternbay.com', 'quietotter.dev'] });
  assert.deepEqual(calls, [{ url: 'https://spaceship.dev/api/v1/domains?take=100&skip=0', method: 'GET', redirect: 'error', key: 'test-key' }]);

  const untouched = [];
  assert.deepEqual(await spaceshipDomains({ credentials: async () => null, fetcher: async url => untouched.push(url) }),
    { state: 'not-connected' });
  assert.deepEqual(untouched, []);
  const refused = await spaceshipDomains({ credentials: keys, fetcher: async () => json(403, { detail: 'Forbidden' }) });
  assert.equal(refused.state, 'unknown');
  assert.match(refused.reason, /domains:read/);
  assert.doesNotMatch(JSON.stringify(refused), /test-secret|test-key/);
  const elsewhere = await spaceshipDomains({ credentials: keys, fetcher, baseUrl: 'https://evil.example.com/api' });
  assert.equal(elsewhere.state, 'unknown');
});

// ---- The tool -----------------------------------------------------------------------------------------------------

function harness(directory, extra = {}) {
  const checked = [];
  const options = {
    file: join(directory, 'portfolio.json'), now: () => now, catalog,
    pages: portfolioPages({ env: { DOMAIN_HOUND_OPEN: 'off' }, directory: join(directory, 'results') }),
    checker: async domain => {
      checked.push(domain);
      return domain === 'soon.com' ? row(domain, { registry: { daysLeft: 12, expires: '2026-12-07T00:00:00.000Z' } }) : row(domain);
    },
    find: async () => [], spaceship: async () => ({ state: 'not-connected' }),
    ...extra,
  };
  return { checked, options, call: input => myDomains(input, options) };
}

test('explicit domains confirm the list, a call without input reuses it, and remove drops items', async t => {
  const directory = await scratch(t);
  const { checked, options, call } = harness(directory);

  const first = await call({ domains: ['Fine.com', 'soon.com'] });
  assert.deepEqual(checked, ['fine.com', 'soon.com']);
  assert.deepEqual(first.added, ['fine.com', 'soon.com']);
  assert.deepEqual((await readList(options.file)).domains, ['fine.com', 'soon.com']);
  assert.equal(first.say.split('\n')[0], resultsLine(first.resultPage));
  assert.ok(first.say.split('\n').length <= 8);
  assert.equal(first.domains[0].domain, 'soon.com', 'most urgent first');
  const html = await readFile(fileURLToPath(first.resultPage), 'utf8');
  assert.match(html, /<h1>Your domains<\/h1>/);
  assert.match(html, /--gold: #f4c64f/, 'receipt style');
  assert.match(html, /<code>soon\.com<\/code>/);
  assert.match(html, /An unknown result means the source did not answer/);
  if (process.platform !== 'win32') assert.equal((await stat(options.file)).mode & 0o777, 0o600);

  checked.length = 0;
  const again = await call({});
  assert.deepEqual(checked, ['fine.com', 'soon.com']);
  assert.deepEqual(again.added, []);

  checked.length = 0;
  const removed = await call({ remove: ['fine.com', 'other.com'] });
  assert.deepEqual(checked, [], 'removal checks nothing');
  assert.deepEqual(removed.removed, ['fine.com']);
  assert.deepEqual((await readList(options.file)).domains, ['soon.com']);
  assert.match(removed.display, /^Removed fine\.com from your saved list\.\n1 saved: soon\.com\./);
});

test('find returns candidates only: nothing saved, nothing checked', async t => {
  const directory = await scratch(t);
  await writeList(['lanternbay.com'], join(directory, 'portfolio.json'), now);
  const { checked, options, call } = harness(directory, {
    find: async paths => {
      assert.deepEqual(paths, ['/projects/example-app']);
      return [{ domain: 'lanternbay.com', sources: ['example-app/package.json'] },
        { domain: 'hushroom.app', sources: ['example-app/README.md'] }];
    },
    spaceship: async () => ({ state: 'ok', domains: ['quietotter.dev', 'hushroom.app'] }),
  });
  const before = await readFile(options.file, 'utf8');
  const found = await call({ find: true, paths: ['/projects/example-app'] });
  assert.deepEqual(checked, []);
  assert.equal(await readFile(options.file, 'utf8'), before);
  assert.deepEqual(found.candidates.map(item => [item.domain, item.saved]),
    [['lanternbay.com', true], ['hushroom.app', false], ['quietotter.dev', false]]);
  assert.match(found.display, /Found 2 candidate domains\. Nothing is saved until you confirm which are yours\./);
  assert.match(found.display, /- hushroom\.app \(your Spaceship account, example-app\/README\.md\)/);
  assert.match(found.display, /1 already saved\./);
  assert.match(found.display, /Spaceship account: 2 domains listed \(read-only\)\./);
});

test('rejects mixed or invalid input and never overwrites an unreadable list', async t => {
  const directory = await scratch(t);
  const { call, options, checked } = harness(directory);
  await assert.rejects(call({ domains: ['a.com'], find: true }), /one of domains, find or remove/);
  await assert.rejects(call({ paths: ['/tmp'] }), /paths works only with find/);
  await assert.rejects(call({ domains: ['not a domain'] }), /domains\[0\] is not an exact domain/);
  await assert.rejects(call({ domains: ['https://a.com/'] }), /not an exact domain/);
  await assert.rejects(call({ other: 1 }), /Pass domains, find: true, remove/);
  assert.match((await call({})).display, /^No saved domains yet\./);

  await writeFile(options.file, '{ broken');
  await assert.rejects(call({ domains: ['a.com'] }), /could not be read/);
  await assert.rejects(call({ remove: ['a.com'] }), /could not be read/);
  assert.equal(await readFile(options.file, 'utf8'), '{ broken');
  assert.deepEqual(checked, []);
});

test('the tool advertises read-only, local-only behaviour', () => {
  assert.equal(portfolioTool.name, 'my_domains');
  assert.equal(portfolioTool.annotations.readOnlyHint, true);
  assert.equal(portfolioTool.annotations.destructiveHint, false);
  assert.deepEqual(Object.keys(portfolioTool.inputSchema.properties), ['domains', 'find', 'paths', 'remove']);
});

// ---- Server -------------------------------------------------------------------------------------------------------

test('the MCP server dispatches my_domains with the saved list in a private file, without network for these calls', async t => {
  const directory = await scratch(t);
  const file = join(directory, 'portfolio.json');
  await writeList([], file, now);
  const server = new URL('../../server.mjs', import.meta.url);
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'my_domains', arguments: {} } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'my_domains', arguments: { remove: ['lanternbay.com'] } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'my_domains', arguments: { domains: ['a.com'], find: true } } },
  ];
  const stdout = await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [fileURLToPath(server)], {
      env: { ...process.env, DOMAIN_HOUND_PORTFOLIO_FILE: file, DOMAIN_HOUND_OPEN: 'off' }, timeout: 5000,
    }, (error, out) => error ? reject(error) : resolve(out));
    child.stdin.end(messages.map(message => JSON.stringify(message)).join('\n') + '\n');
  });
  const replies = new Map(stdout.trim().split('\n').map(line => JSON.parse(line)).map(reply => [reply.id, reply.result]));
  assert.match(replies.get(2).content[0].text, /^No saved domains yet\./);
  assert.equal(replies.get(2).isError, false);
  assert.match(replies.get(3).content[0].text, /^None of those domains were saved\./);
  assert.equal(replies.get(4).isError, true);
  assert.match(replies.get(4).content[0].text, /one of domains, find or remove/);
});
