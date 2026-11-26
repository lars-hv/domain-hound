import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { cacheDir, mapLimit, readCache, writeCache } from './cache.mjs';
import { bootstrapUrl, rdapBase, rdapDomainUrl, registryCooldown } from './registry.mjs';
import { compactText, day, letters, readJson, request } from './triage-sources.mjs';

// Every traction threshold lives in this table. Tuned with the strong, no-traction and some-traction
// fixtures in traction.test.mjs.
// strong: a Goliath. Any one signal is enough.
// some: real but small use. Domain age counts only with a live, current site.
// dormant: parked or for-sale pages, or stale live sites with a tiny crawl and no Tranco rank.
export const tractionThresholds = {
  strong: { trancoRank: 100_000, appRatings: 1_000, wikipediaArticle: true, agentKnows: true },
  some: { trancoRank: 1_000_000, crawlPages: 200, domainYears: 3, appRatings: 100, autocompleteWords: 2 },
  dormant: { crawlPagesBelow: 20, staleYears: 3 },
};

export const evidenceLifetime = 7 * day;
const crawlSample = 1000;
const crawlLimitPerRun = 6;
const rdapLimitPerRun = 10;
const productWords = /^(?:app|apps|login|log in|sign in|signup|sign up|pricing|price|download|reviews?|ai|api|support|careers|jobs|customer service|discount|promo code|coupon)\b/;
const trancoUrl = 'https://tranco-list.eu/download/daily/top-1m.csv.zip';
const trancoFile = 'tranco-top-1m.csv';
const trancoMeta = 'tranco.json';
const trancoMarker = 'tranco-refresh.attempt';
const commonCrawl = 'https://index.commoncrawl.org/';
const twoLevelSuffixes = new Set(['co.uk', 'org.uk', 'com.au', 'net.au', 'co.nz', 'co.jp', 'com.br', 'co.in', 'co.za', 'com.mx', 'com.sg']);
const level = { unknown: -1, none: 0, some: 1, strong: 2 };
const trancoLists = new Map();

const thousands = value => value.toLocaleString('en-US');
const fresh = (entry, now) => now - entry?.at >= 0 && now - entry.at < evidenceLifetime;

// The registrable domain of a URL or host, e.g. https://www.notion.so/product -> notion.so.
export function siteDomain(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : 'https://' + value).hostname.toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
    const parts = host.split('.');
    const keep = twoLevelSuffixes.has(parts.slice(-2).join('.')) ? 3 : 2;
    return parts.slice(-keep).join('.');
  } catch { return null; }
}

// A domain is the rival's own home only when its label carries the name, so a seller's portfolio,
// a hosting platform or an unrelated publisher never borrows the rival's traction.
export function ownsName(name, domain) {
  const label = domain?.split('.')[0] ?? '';
  return letters(label).includes(letters(name));
}

// The name followed by a product word, e.g. "notion login". A different brand that only shares a prefix never counts.
export function autocompleteWords(name, suggestions) {
  if (!Array.isArray(suggestions)) return null;
  const key = letters(name);
  const prefix = new RegExp('^' + key.split('').join('[ ._-]*') + '\\s+', 'i');
  return new Set(suggestions.map(value => String(value).trim().toLowerCase())
    .filter(value => prefix.test(value) && productWords.test(value.replace(prefix, '')))).size;
}

// The qualifier after the name in a rival's name, e.g. "ai" in "RouteMender AI", or '' for an exact name.
export function rivalHead(name, title) {
  const head = String(title ?? '').split(/\s[|–—·•-]\s|[|–—:]/, 1)[0].trim();
  const key = letters(name);
  const text = letters(head);
  if (!text.startsWith(key)) return null;
  const rest = text.slice(key.length);
  return /^(?:|s|es|ai|app|hq|inc|labs|io|co|com|official)$/.test(rest) ? { head: compactText(head, 60), qualifier: rest } : null;
}

function unzipFirst(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > buffer.length) return null;
  const central = buffer.readUInt32LE(end + 16);
  if (central + 46 > buffer.length || buffer.readUInt32LE(central) !== 0x02014b50) return null;
  const method = buffer.readUInt16LE(central + 10);
  const size = buffer.readUInt32LE(central + 20);
  const local = buffer.readUInt32LE(central + 42);
  if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) return null;
  const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
  const data = buffer.subarray(start, start + size);
  if (method === 0) return data;
  return method === 8 ? inflateRawSync(data, { maxOutputLength: 64 * 1024 * 1024 }) : null;
}

async function writeText(directory, filename, text) {
  const temp = new URL(filename + '.' + randomUUID() + '.tmp', directory);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temp, text, { mode: 0o600 });
    await rename(temp, new URL(filename, directory));
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

// Download the free Tranco top-1M list once and keep it locally. Called by --refresh-tranco.
export async function refreshTranco({ directory = cacheDir, fetcher = globalThis.fetch, now = new Date() } = {}) {
  try {
    let response = await request(trancoUrl, { fetcher }, { timeout: 60_000, redirect: 'manual' });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      const next = new URL(location, trancoUrl);
      if (next.origin !== new URL(trancoUrl).origin) return { refreshed: false, reason: 'Tranco redirected off its host.' };
      response = await request(next.href, { fetcher }, { timeout: 60_000, redirect: 'manual' });
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { refreshed: false, reason: 'Tranco returned HTTP ' + response.status };
    }
    const csv = unzipFirst(Buffer.from(await response.arrayBuffer()))?.toString('latin1');
    const rows = csv?.match(/\n/g)?.length ?? 0;
    if (!csv || !/^1,[a-z0-9.-]+\.[a-z]{2,}\r?\n/.test(csv) || rows < 1000) {
      return { refreshed: false, reason: 'Tranco did not return a valid list.' };
    }
    await writeText(directory, trancoFile, csv);
    await writeCache(directory, trancoMeta, { at: now.getTime(), rows });
    trancoLists.delete(directory.href);
    return { refreshed: true, rows };
  } catch {
    return { refreshed: false, reason: 'Tranco could not be downloaded.' };
  }
}

async function startTrancoRefresh(directory) {
  const marker = new URL(trancoMarker, directory);
  await mkdir(directory, { recursive: true });
  try {
    // One attempt per six hours, shared by concurrent runs.
    if (Date.now() - (await stat(marker)).mtimeMs < 6 * 60 * 60_000) return;
    await unlink(marker);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try { await (await open(marker, 'wx', 0o600)).close(); } catch { return; }
  const child = spawn(process.execPath, [fileURLToPath(new URL('./index.mjs', import.meta.url)), '--refresh-tranco'], {
    detached: true, stdio: 'ignore', env: { ...process.env, DOMAIN_HOUND_OPEN: 'off', DOMAIN_HOUND_TRANCO_CACHE: fileURLToPath(directory) },
  });
  child.on('error', () => {});
  child.unref();
}

// The local list, or null when it is missing or older than the evidence lifetime (plus a day while it refreshes).
export async function loadTranco({ directory = cacheDir, now = new Date(), refresh = false, scheduleRefresh = startTrancoRefresh } = {}) {
  if (!directory) return null;
  const key = directory.href;
  const meta = await readCache(directory, trancoMeta);
  const age = now.getTime() - meta?.at;
  if (refresh && !(age >= 0 && age < evidenceLifetime)) {
    void Promise.resolve().then(() => scheduleRefresh(directory)).catch(() => {});
  }
  if (!(age >= 0 && age < evidenceLifetime + day)) return null;
  if (trancoLists.get(key)?.at !== meta.at) {
    const list = readFile(new URL(trancoFile, directory), 'latin1')
      .then(text => ({ text: '\n' + text, at: meta.at }))
      .catch(() => {
        trancoLists.delete(key);
        return null;
      });
    trancoLists.set(key, { at: meta.at, list });
  }
  return trancoLists.get(key).list;
}

// A rank, null when the domain is not in the top 1M, or undefined when the list is unavailable.
export function trancoRank(list, domain) {
  if (!list?.text || !domain) return undefined;
  for (const end of ['\n', '\r']) {
    const index = list.text.indexOf(',' + domain + end);
    if (index < 0) continue;
    const rank = Number(list.text.slice(list.text.lastIndexOf('\n', index) + 1, index));
    if (Number.isSafeInteger(rank) && rank > 0) return rank;
  }
  return null;
}

async function latestCrawl(options) {
  const { directory, now } = options;
  const saved = await readCache(directory, 'commoncrawl-index.json');
  if (fresh(saved, now) && /^CC-MAIN-\d{4}-\d{2}$/.test(saved.id)) return saved.id;
  const data = await readJson(commonCrawl + 'collinfo.json', options, { timeout: Math.min(2500, options.timeLeft()) });
  const id = Array.isArray(data) ? data.find(row => /^CC-MAIN-\d{4}-\d{2}$/.test(row?.id))?.id : null;
  if (id) await writeCache(directory, 'commoncrawl-index.json', { id, at: now }).catch(() => {});
  return id ?? null;
}

// Common Crawl's page count (showNumPages) counts compressed index blocks, not pages. One bounded NDJSON
// sample of the latest crawl counts distinct URLs instead; a full sample is a lower bound.
export async function crawlPages(domain, options) {
  const id = await latestCrawl(options);
  if (!id || options.timeLeft() < 400) return undefined;
  try {
    const query = new URLSearchParams({
      url: domain, matchType: 'domain', output: 'json', fl: 'urlkey', limit: String(crawlSample),
    });
    query.append('filter', '=status:200');
    query.append('filter', '=mime:text/html');
    const response = await request(commonCrawl + id + '-index?' + query, options,
      { timeout: Math.min(6000, options.timeLeft()) });
    const text = (await response.text()).slice(0, 600_000);
    if (response.status === 404) return /No Captures found/i.test(text) ? { pages: 0, crawl: id } : undefined;
    if (!response.ok) return undefined;
    const lines = text.split('\n').filter(line => line.trim());
    const urls = new Set(lines.flatMap(line => {
      try {
        const row = JSON.parse(line);
        if (typeof row.urlkey === 'string') return [row.urlkey];
        return typeof row.url === 'string' ? [row.url.replace(/^https?:\/\/(?:www\.)?/i, '').replace(/\/$/, '')] : [];
      } catch { return []; }
    }));
    return { pages: urls.size, ...(lines.length >= crawlSample && { limited: true }), crawl: id };
  } catch { return undefined; }
}

async function rdapServices(options) {
  const { directory, now } = options;
  const saved = await readCache(directory, 'iana.json');
  if (Array.isArray(saved?.value) && now - saved.savedAt >= 0 && now - saved.savedAt < day) return saved.value;
  const data = await readJson(bootstrapUrl, options, { timeout: Math.min(1800, options.timeLeft()) });
  if (Array.isArray(data?.services)) {
    await writeCache(directory, 'iana.json', { savedAt: now, value: data.services }).catch(() => {});
    return data.services;
  }
  return Array.isArray(saved?.value) ? saved.value : null;
}

// The RDAP registration date, null when the registry gives none, or undefined when it did not answer.
export async function registeredOn(domain, options) {
  const base = rdapBase(domain.split('.').at(-1), await rdapServices(options));
  if (!base || options.timeLeft() < 300 || await registryCooldown(base, options.directory) > Date.now()) return undefined;
  try {
    const response = await request(rdapDomainUrl(base, domain), options, {
      timeout: Math.min(2500, options.timeLeft()), headers: { Accept: 'application/rdap+json, application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const data = await response.json();
    const date = Array.isArray(data?.events) ? data.events.find(event => event?.eventAction === 'registration')?.eventDate : null;
    return Number.isFinite(Date.parse(date)) ? new Date(date).toISOString().slice(0, 10) : null;
  } catch { return undefined; }
}

function limiter(concurrency) {
  let active = 0;
  const waiting = [];
  return async job => {
    if (active >= concurrency) await new Promise(resolve => waiting.push(resolve));
    active++;
    try { return await job(); } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

// One collector per run: memoized domain evidence, a 7-day cache, and per-run caps on network lookups.
export function createTraction(options = {}) {
  const directory = options.directory === undefined ? cacheDir : options.directory;
  const now = (options.now ?? new Date()).getTime();
  const timeLeft = options.timeLeft ?? (() => 8000);
  const context = { ...options, directory, now, timeLeft };
  const crawlTurn = limiter(2);
  const rdapTurn = limiter(4);
  const budget = { crawl: options.crawlLimit ?? crawlLimitPerRun, rdap: options.rdapLimit ?? rdapLimitPerRun };
  const tranco = options.tranco !== undefined ? Promise.resolve(options.tranco)
    : loadTranco({ directory, now: new Date(now), refresh: options.refreshTranco === true });
  const domains = new Map();
  const done = new Map();

  async function lookUp(domain, { age: wantAge, crawl: wantCrawl }) {
    const filename = 'traction-' + domain + '.json';
    const saved = (await readCache(directory, filename)) ?? {};
    const evidence = { tranco: trancoRank(await tranco, domain) };
    const reuse = key => fresh(saved[key], now) ? saved[key].value : undefined;
    let changed = false;
    const [crawl, registered] = await Promise.all([
      reuse('crawl') ?? (wantCrawl && budget.crawl-- > 0 && timeLeft() > 800 && !options.signal?.aborted
        ? crawlTurn(() => crawlPages(domain, context)) : undefined),
      reuse('registered') !== undefined ? reuse('registered')
        : wantAge && budget.rdap-- > 0 && timeLeft() > 500 && !options.signal?.aborted
          ? rdapTurn(() => registeredOn(domain, context)) : undefined,
    ]);
    for (const [key, value] of Object.entries({ crawl, registered })) {
      if (value === undefined) continue;
      evidence[key] = value;
      if (!fresh(saved[key], now)) {
        saved[key] = { value, at: now };
        changed = true;
      }
    }
    if (changed) await writeCache(directory, filename, saved).catch(() => {});
    return evidence;
  }

  return {
    // Start one domain's lookups as soon as its home is known: Tranco (local), a Common Crawl sample and RDAP age.
    // A parked or for-sale page needs only the local Tranco rank.
    evidence(domain, { age = true, crawl = true } = {}) {
      if (!domain) return Promise.resolve({});
      if (!domains.has(domain)) {
        const job = lookUp(domain, { age, crawl }).catch(() => ({}));
        domains.set(domain, job);
        job.then(value => { done.set(domain, value); });
      }
      return domains.get(domain);
    },
    tranco,
    // Wait for started lookups, but never past the run's budget. Unfinished lookups read as unavailable.
    async settle(reserveMs = 150) {
      const wait = Math.max(0, timeLeft() - reserveMs);
      let timer;
      await Promise.race([
        Promise.all([tranco, ...domains.values()]),
        new Promise(resolve => { timer = setTimeout(resolve, wait); }),
      ]);
      clearTimeout(timer);
      const list = await Promise.race([tranco, Promise.resolve(null)]);
      // A lookup still running keeps only its local Tranco rank.
      return new Map([...domains.keys()].map(domain => [domain, done.get(domain) ?? { tranco: trancoRank(list, domain) }]));
    },
  };
}

function signal(text, strength, weight) {
  return { text, level: strength, weight };
}

// Find each same-name rival and its home. Rivals that share a home domain are one rival.
export function collectRivals({ name, input = name, sites = {}, entities, topics, suggestions, apps = [], geo, sameBusiness = () => false }) {
  const rivals = [];
  const byDomain = new Map();
  const add = rival => {
    const owner = rival.domains.map(domain => byDomain.get(domain)).find(Boolean);
    if (owner) {
      for (const domain of rival.domains) if (!owner.domains.includes(domain)) owner.domains.push(domain);
      owner.sources.push(...rival.sources);
      owner.refs.push(...rival.refs);
      owner.sameBusiness ||= rival.sameBusiness;
      owner.wikipedia ??= rival.wikipedia;
      owner.apps.push(...rival.apps);
      owner.description ??= rival.description;
      owner.website ??= rival.website;
      if (rival.sources.includes('wikidata') && !owner.sources.includes('wikidata-name')) {
        owner.name = rival.name;
        owner.sources.push('wikidata-name');
      }
      for (const domain of owner.domains) byDomain.set(domain, owner);
      return owner;
    }
    rivals.push(rival);
    for (const domain of rival.domains) byDomain.set(domain, rival);
    return rival;
  };
  const base = (rivalName, source, extra = {}) => ({ name: compactText(rivalName, 60), sources: [source], domains: [], apps: [],
    refs: [], sameBusiness: false, ...extra });

  for (const [tld, site] of Object.entries(sites)) {
    if (!['live', 'parked', 'for-sale'].includes(site?.state)) continue;
    const domain = name + '.' + tld;
    const head = site.state === 'live' ? rivalHead(name, site.title) : null;
    if (site.state === 'live' && site.host && site.host !== domain && !site.host.endsWith('.' + domain) && !head
        && !letters([site.title, site.description].join(' ')).includes(letters(name))) continue;
    // A site that redirects to another home of the same name (notion.ai to notion.com) joins that rival.
    const final = site.state === 'live' && site.host ? siteDomain(site.host) : null;
    add(base(head?.head ?? domain, 'site', {
      domains: [domain, ...(final && final !== domain && ownsName(name, final) ? [final] : [])], refs: [domain],
      website: final ?? (site.state === 'live' ? domain : undefined),
      site: { domain, state: site.state, copyright: site.copyright, lastModified: site.lastModified },
      description: compactText([site.title, site.description].filter(Boolean).join(' '), 200) || undefined,
      sameBusiness: site.state === 'live' && sameBusiness([site.title, site.description].join(' ')),
    }));
  }
  for (const entity of entities ?? []) {
    if (!entity?.brand || letters(entity.name) !== letters(name)) continue;
    const homes = (entity.website ?? []).map(siteDomain).filter(domain => domain && ownsName(name, domain));
    add(base(entity.name, 'wikidata', {
      domains: [...new Set(homes)], website: homes[0], refs: [entity], description: entity.description || undefined,
      wikipedia: entity.wikipedia ?? null, sitelinks: entity.sitelinks ?? 0,
      sameBusiness: sameBusiness(entity.name + ' ' + (entity.description ?? '')),
    }));
  }
  for (const app of apps) {
    const home = siteDomain(app.sellerUrl);
    const rival = base(rivalHead(name, app.name)?.head ?? app.name, 'app', {
      domains: home && ownsName(name, home) ? [home] : [], apps: [{ store: app.store, ratings: app.ratings }],
      refs: [app.ref ?? app],
      description: compactText([app.category, app.description].filter(Boolean).join(' '), 200) || undefined,
      sameBusiness: sameBusiness([app.name, app.category, app.description].join(' ')),
    });
    // An app joins another rival only through the same home domain.
    add(rival);
  }
  for (const topic of topics ?? []) {
    const head = rivalHead(name, topic?.name);
    if (!head) continue;
    const text = topic.name + ' ' + (topic.description ?? '');
    const twin = rivals.find(rival => letters(rival.name) === letters(head.head) && rival.sources.includes('wikidata')
      && wordsOverlap(rival.description, topic.description));
    if (twin) {
      twin.sameBusiness ||= sameBusiness(text);
      twin.sources.push('trends');
      twin.refs.push(topic);
      continue;
    }
    const same = rivals.find(rival => rival.sources.includes('trends') && letters(rival.name) === letters(head.head));
    if (same) {
      same.refs.push(topic);
      continue;
    }
    add(base(head.head, 'trends', { qualifier: head.qualifier, sameBusiness: sameBusiness(text), refs: [topic],
      description: topic.description && !/^topic$/i.test(topic.description) ? topic.description : undefined }));
  }
  const words = autocompleteWords(name, suggestions);
  for (const rival of rivals) {
    const ownHost = (suggestions ?? []).some(value => rival.domains.includes(siteDomain(String(value).trim())));
    const qualified = rival.qualifier && (suggestions ?? []).some(value =>
      letters(value) === letters(name) + rival.qualifier);
    rival.autocomplete = suggestions == null ? undefined : ownHost || qualified ? words : 0;
  }
  if (geo?.known) {
    const target = rivals.find(rival => rival.domains.some(domain => geo.text.toLowerCase().includes(domain)))
      ?? rivals.find(rival => wordsOverlap(rival.description, geo.text));
    if (target) target.geo = geo.text;
    else add(base(input, 'geo', {
      geo: geo.text, description: geo.text, sameBusiness: sameBusiness(geo.text),
    }));
  }
  return rivals;
}

function wordsOverlap(a, b) {
  const words = value => new Set((String(value ?? '').toLowerCase().match(/[a-z]{4,}/g) ?? [])
    .filter(word => !['software', 'company', 'topic', 'service', 'website', 'brand', 'with', 'from', 'that', 'this', 'your'].includes(word)));
  const left = words(a);
  return [...words(b)].some(word => left.has(word));
}

function yearsSince(date, now) {
  return (now - Date.parse(date)) / (365.25 * day);
}

// Level a rival: strong, some, none (checked and small) or unknown (its sources did not answer).
export function assessRival(rival, evidence = new Map(), { now = Date.now(), answered = {}, geoGiven = false } = {}) {
  const T = tractionThresholds;
  const signals = [];
  const known = { domain: false, other: false };
  let dormant = null;
  const year = new Date(now).getUTCFullYear();
  // One signal per kind across the rival's domains: the best Tranco rank, the largest crawl, the oldest live domain.
  const best = { tranco: null, crawl: null, age: null };
  for (const domain of rival.domains) {
    const facts = evidence.get(domain) ?? {};
    const site = rival.site?.domain === domain ? rival.site : null;
    if (facts.tranco !== undefined || facts.crawl !== undefined) known.domain = true;
    if (facts.tranco != null && !(best.tranco?.rank <= facts.tranco)) best.tranco = { rank: facts.tranco, domain };
    const pages = facts.crawl?.pages;
    if (pages != null && !(best.crawl?.pages >= pages)) best.crawl = { ...facts.crawl, domain };
    const lastUpdated = Math.max(site?.copyright ?? 0, site?.lastModified ?? 0);
    const stale = site?.state === 'live' && lastUpdated > 0 && year - lastUpdated >= T.dormant.staleYears
      && pages != null && pages < T.dormant.crawlPagesBelow && facts.tranco === null;
    if (site && (site.state === 'parked' || site.state === 'for-sale' || stale) && facts.tranco == null) {
      dormant ??= { domain, why: site.state === 'live' ? 'stale site' : site.state };
    }
    if (facts.registered && site?.state === 'live' && !stale && !(best.age?.date <= facts.registered)) {
      best.age = { date: facts.registered, domain };
    }
  }
  if (best.tranco?.rank <= T.some.trancoRank) {
    signals.push(signal('Tranco #' + thousands(best.tranco.rank), best.tranco.rank <= T.strong.trancoRank ? 'strong' : 'some',
      1 - best.tranco.rank / 1e7));
  }
  if (best.crawl?.pages >= T.some.crawlPages) {
    signals.push(signal(thousands(best.crawl.pages) + (best.crawl.limited ? '+' : '') + ' crawled pages', 'some', 0.5));
  }
  if (best.age && yearsSince(best.age.date, now) >= T.some.domainYears) {
    signals.push(signal('domain since ' + best.age.date.slice(0, 4), 'some', 0.3));
  }
  const home = rival.website ?? (rival.site?.state === 'live' ? rival.site.domain : null);
  if (rival.wikipedia && T.strong.wikipediaArticle) signals.push(signal('Wikipedia article', 'strong', 0.9));
  for (const app of rival.apps) {
    if (!Number.isSafeInteger(app.ratings)) continue;
    known.other = true;
    if (app.ratings >= T.some.appRatings) {
      signals.push(signal(thousands(app.ratings) + ' ' + app.store + ' ratings',
        app.ratings >= T.strong.appRatings ? 'strong' : 'some', 0.8 + Math.min(app.ratings, 1e7) / 1e8));
    }
  }
  if (rival.autocomplete >= T.some.autocompleteWords) {
    signals.push(signal(rival.autocomplete + ' autocomplete product words', 'some', 0.2));
  }
  if (rival.geo && T.strong.agentKnows) signals.push(signal('AI agent knows it', 'strong', 0.7));
  // An app is measured by its ratings. A rival without a home is measured by Wikidata plus apps, autocomplete or the agent.
  if (!rival.apps.length && !rival.domains.length) {
    known.other = Boolean(answered.wikidata && (answered.apps || rival.autocomplete !== undefined || geoGiven));
  }
  signals.sort((a, b) => level[b.level] - level[a.level] || b.weight - a.weight);
  const top = signals[0]?.level;
  if (top !== 'strong' && dormant && !rival.apps.length) return { level: 'none', dormant, signals: [], home };
  const result = top ?? (known.domain || known.other ? 'none' : 'unknown');
  return { level: result, signals: signals.map(({ text, level }) => ({ text, level })), home };
}

// GEO is the calling agent's own recollection. Without an agent, Wikipedia/Wikidata presence stands in, labelled.
function geoLabel(rival, geo, entities) {
  if (geo) return geo.known ? 'agent knows it: ' + compactText(geo.text, 80) : 'agent: unknown';
  if (entities == null) return 'stand-in Wikipedia/Wikidata: not checked';
  if (rival?.wikipedia) return 'stand-in Wikipedia/Wikidata: article ' + compactText(rival.wikipedia, 60);
  return 'stand-in Wikipedia/Wikidata: ' + (rival?.sources.includes('wikidata') ? 'Wikidata only' : 'none');
}

// Parse one name's agent answer: "known: what it is" or "unknown".
export function parseGeo(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim();
  const match = text.match(/^known\b[\s:(—–-]*(.*?)\)?$/i);
  if (match) return match[1].trim() ? { known: true, text: compactText(match[1], 120) } : null;
  return /^unknown\b/i.test(text) ? { known: false } : null;
}

// Assess every rival of one name and pick the one that matters most.
export function judgeRivals(rivals, evidence, { now, answered, geo, entities }) {
  const judged = rivals.map(rival => ({ rival, ...assessRival(rival, evidence, { now, answered, geoGiven: Boolean(geo) }) }));
  const named = judged.filter(row => row.level === 'strong' || row.level === 'some');
  // A plain Trends topic with no traction of its own is the same name as a measured rival, not a second rival.
  const kept = judged.filter(row => !(row.rival.sources.join() === 'trends' && row.level === 'none' && !row.rival.qualifier
    && named.some(other => letters(other.rival.name) === letters(row.rival.name))));
  // Strong and some first, then rivals that could not be measured, then small ones and dormant domains.
  const rank = row => row.dormant ? -2 : level[row.level] === -1 ? 0.5 : level[row.level];
  // Within a level: the most strong signals (the clearest Goliath), then same business, then the most signals.
  const strongCount = row => row.signals.filter(item => item.level === 'strong').length;
  kept.sort((a, b) => rank(b) - rank(a) || strongCount(b) - strongCount(a)
    || Number(b.rival.sameBusiness) - Number(a.rival.sameBusiness) || b.signals.length - a.signals.length);
  const [main] = kept;
  return {
    rivals: kept,
    // Evidence behind a measured rival no longer counts as unexplained same-name use.
    explained: new Set(judged.filter(row => row.level !== 'unknown').flatMap(row => [...row.rival.refs, ...row.rival.domains])),
    main,
    agent: Boolean(geo),
    geo: geoLabel(main?.rival, geo, entities),
  };
}

export function rivalLabel(row) {
  const home = row.home ?? row.rival.domains[0];
  return row.rival.name + (home && letters(home) !== letters(row.rival.name) ? ' at ' + home : '');
}

export function strongest(row, count = 2) {
  return row.signals.slice(0, count).map(item => item.text).join(', ');
}

// Verdict rules: a strong rival is a Goliath (Avoid); same business with some traction is Avoid; another
// business with some traction is Check first; no traction or a dormant domain is only a note.
export function tractionVerdict(judged) {
  const goliath = judged.rivals.find(row => row.level === 'strong');
  if (goliath) return ['Avoid', 'David vs Goliath: ' + rivalLabel(goliath) + ' (' + strongest(goliath) + ')'];
  const close = judged.rivals.find(row => row.level === 'some' && row.rival.sameBusiness);
  if (close) return ['Avoid', 'Same-business rival with traction: ' + rivalLabel(close) + ' (' + strongest(close) + ')'];
  const some = judged.rivals.find(row => row.level === 'some');
  if (some) return ['Check first', 'Same-name use with some traction: ' + rivalLabel(some) + ' (' + strongest(some) + ')'];
  return null;
}

const listed = (items, count = 2) => [...new Set(items)].slice(0, count).join(', ')
  + (new Set(items).size > count ? ' +' + (new Set(items).size - count) : '');

// Notes never change the verdict. A small use that shares its name with a bigger rival is that rival's echo.
export function tractionNotes(judged) {
  const bigger = new Set(judged.rivals.filter(row => level[row.level] > 0).map(row => letters(row.rival.name)));
  const small = judged.rivals.filter(row => row.level === 'none' && !row.dormant && !bigger.has(letters(row.rival.name)))
    .map(row => row.rival.name);
  const dormant = judged.rivals.filter(row => row.dormant).map(row => row.dormant.domain + ' (' + row.dormant.why + ')');
  return [
    small.length && 'Small same-name use: ' + listed(small) + ' (no visible traction)',
    dormant.length && 'Dormant: ' + listed(dormant),
  ].filter(Boolean);
}

// The rival that sets the verdict, its level, its two strongest signals and the GEO line; null when no rival
// has traction and no agent answered (the notes cover small and dormant uses).
export function tractionSummary(judged) {
  const { main, geo } = judged;
  if (!main || level[main.level] < 1) return judged.agent ? { geo } : null;
  return {
    rival: rivalLabel(main), level: main.level, ...(main.rival.sameBusiness && { sameBusiness: true }),
    ...(main.home && { domain: main.home }), signals: main.signals.slice(0, 2).map(item => item.text), geo,
  };
}

// Start the lookups for every home domain the rivals of one name have.
export function startEvidence(traction, rivals) {
  return mapLimit(rivals.flatMap(rival => rival.domains.map(domain => [domain, rival])), 8, ([domain, rival]) =>
    rival.site?.domain === domain && rival.site.state !== 'live'
      ? traction.evidence(domain, { age: false, crawl: false })
      : traction.evidence(domain));
}
