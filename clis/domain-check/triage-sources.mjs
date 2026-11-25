import { anySignal, cacheDir, readCache, writeCache } from './cache.mjs';

const uspto = 'https://tmsearch.uspto.gov';
const githubState = 'triage-github-limit.json';
export const day = 86_400_000;
const userAgent = 'DomainHound/1.0 (public name lookup)';
const niceClasses = new Map(Object.entries({
  travel: ['039', '043'], software: ['009', '042'], finance: ['036'], retail: ['035'],
  health: ['044'], education: ['041'], food: ['043', '030'], media: ['038', '041'],
}));
const wikidataHeaders = { 'User-Agent': 'DomainHound/0.1 (https://domainhound.dev)' };
const brandTypes = new Set([
  'Q783794', 'Q4830453', 'Q891723', 'Q167037', // Companies
  'Q2424752', 'Q431289', 'Q7397', 'Q166142', 'Q620615', 'Q7889', // Products, brands and software
]);
let githubTail = Promise.resolve();
const githubHolds = new Map();

export const trademarkSearches = {
  US: uspto + '/',
  EU: 'https://www.euipo.europa.eu/en/search-ip',
  WIPO: 'https://branddb.wipo.int/',
  Norway: 'https://search.patentstyret.no/',
};
export const handleSearches = {
  GitHub: 'https://github.com/{name}',
  npm: 'https://www.npmjs.com/package/{name}',
  PyPI: 'https://pypi.org/project/{name}/',
  X: 'https://x.com/{name}',
  YouTube: 'https://www.youtube.com/@{name}',
};

// Latin letters for name matching: accents drop, and letters without a decomposition fold too (ø -> o, æ -> ae).
const folds = [[/æ/g, 'ae'], [/ø/g, 'o'], [/œ/g, 'oe'], [/ß/g, 'ss'], [/[đð]/g, 'd'], [/þ/g, 'th'], [/ł/g, 'l'], [/ı/g, 'i']];
export function foldLatin(value) {
  let text = String(value ?? '').normalize('NFC').toLowerCase();
  for (const [pattern, replacement] of folds) text = text.replace(pattern, replacement);
  return text.normalize('NFKD').replace(/\p{M}/gu, '');
}
export const letters = value => foldLatin(value).replace(/[^a-z0-9]/g, '');
export const compactText = (value, limit) => String(value ?? '')
  .replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim().slice(0, limit);

export function request(url, { fetcher = globalThis.fetch, signal } = {}, init = {}) {
  const timeout = AbortSignal.timeout(Math.max(1, Math.floor(init.timeout ?? 2600)));
  return fetcher(url, { redirect: 'error', ...init, signal: signal ? anySignal([signal, timeout]) : timeout,
    headers: { 'User-Agent': userAgent, ...init.headers } });
}

export async function readJson(url, options, init) {
  try {
    const response = await request(url, options, init);
    if (response.ok) return await response.json();
    await response.body?.cancel();
  } catch { /* An unavailable provider is different from an empty search result. */ }
  return null;
}

function exactPhrases(label, input) {
  const spaced = input.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
  // A glued name can have an unknown word boundary. Try each two-word spelling in one request.
  const splits = Array.from({ length: Math.max(0, label.length - 1) }, (_, index) => {
    const cut = index + 1;
    return label.slice(0, cut) + ' ' + label.slice(cut);
  });
  return [...new Set([label, spaced, ...splits])].filter(Boolean);
}

export function oneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length > b.length) return oneEdit(b, a);
  let index = 0;
  while (index < a.length && a[index] === b[index]) index++;
  if (a.length !== b.length) return a.slice(index) === b.slice(index + 1);
  return a.slice(index + 1) === b.slice(index + 1)
    || (a[index] === b[index + 1] && a[index + 1] === b[index] && a.slice(index + 2) === b.slice(index + 2));
}

export function matchTier(a, b) {
  if (a === b) return 'Exact';
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  const plural = long === short + 's' || (/(?:s|sh|ch|x|z)$/.test(short) && long === short + 'es')
    || (short.endsWith('y') && long === short.slice(0, -1) + 'ies');
  if (plural) return 'Near-identical';
  if (!oneEdit(a, b)) return null;
  const vowels = 'aeiouy';
  const changed = a.length === b.length ? [...a].findIndex((letter, i) => letter !== b[i]) : -1;
  const vowelSwap = changed >= 0 && vowels.includes(a[changed]) && vowels.includes(b[changed]) &&
    a.slice(changed + 1) === b.slice(changed + 1);
  const doubled = short !== long && long.replace(/(.)\1+/g, '$1') === short.replace(/(.)\1+/g, '$1');
  return vowelSwap || doubled ? 'Near-identical' : 'Fuzzy';
}

export async function searchMarks(name, input, options = {}) {
  const relevant = niceClasses.get(options.category?.trim().toLowerCase()) ?? niceClasses.get('software');
  const variants = exactPhrases(letters(name), input);
  const matches = variants.map(query => ({ match_phrase: { wordmark: { query, boost: 3 } } }));
  const key = variants[0];
  const plurals = [key + 's', key + 'es', key.replace(/y$/, 'ies'), key.replace(/(?:es|s)$/, ''), key.replace(/ies$/, 'y')];
  for (const query of new Set(plurals.filter(value => value !== key && matchTier(key, value) === 'Near-identical'))) {
    matches.push({ match_phrase: { wordmark: { query } } });
  }
  matches.push({ fuzzy: { wordmark: { value: key, fuzziness: 1, prefix_length: 0 } } });
  const data = await readJson(uspto + '/prod-stage-v1-0-0/tmsearch', options, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: uspto, Referer: uspto + '/' },
    body: JSON.stringify({
      size: 25, _source: ['alive', 'wordmark', 'ownerName', 'internationalClass', 'id', 'registered'],
      query: { bool: {
        filter: [{ term: { alive: true } }],
        must: [{ bool: { should: matches, minimum_should_match: 1 } }],
        should: [{ terms: { internationalClass: relevant.map(value => 'IC ' + value) } }],
      } },
    }),
  });
  if (!Array.isArray(data?.hits?.hits) || data.timedOut || data.shardsFailed > 0) return null;
  return data.hits.hits.flatMap(hit => {
    const row = hit.source;
    const mark = letters(row?.wordmark);
    if (row?.alive !== true || !mark) return [];
    const tier = matchTier(key, mark);
    if (!tier || (tier === 'Fuzzy' && key.length < 5)) return [];
    const classes = (Array.isArray(row.internationalClass) ? row.internationalClass : [])
      .map(value => String(value).match(/\b\d{3}\b/)?.[0]).filter(Boolean);
    const owner = String([].concat(row.ownerName ?? []).at(-1) ?? '')
      .replace(/\s+\([^;]*;\s*[A-Z ,.-]+\)$/, '').replace(/\s+\([^)]*\)$/, '');
    return [{ name: compactText(row.wordmark, 65), owner: compactText(owner, 70),
      classes, relevant: classes.some(value => relevant.includes(value)), relevantClasses: classes.filter(value => relevant.includes(value)),
      tier, registered: row.registered === true,
      serial: /^\d{8}$/.test(row.id) ? row.id : null }];
  }).sort((a, b) => markWeight(b, key) - markWeight(a, key) || Number(b.registered) - Number(a.registered));
}

function markWeight(mark, key) {
  const tier = ['Fuzzy', 'Near-identical', 'Exact'].indexOf(mark.tier);
  const firstLetter = Number(letters(mark.name)[0] === key[0]);
  const tech = Number(mark.classes.some(value => niceClasses.get('software').includes(value)));
  return 10 * tier + (mark.relevant ? tier ? 25 : 5 : 0) + firstLetter + 0.2 * tech;
}

export function appNameMatches(name, title) {
  const key = letters(name);
  return [title, title.split(/[:|]|\s[-–—]\s/, 1)[0]].some(value => letters(value) === key);
}

async function cacheTractionSource(source, name, options, fetchResult) {
  if (!options.cacheLifetime) return fetchResult();
  const { directory = cacheDir, now = new Date() } = options;
  const filename = 'traction-' + source + '-' + name + '.json';
  const saved = await readCache(directory, filename);
  const age = +now - saved?.at;
  if (age >= 0 && age < options.cacheLifetime && Array.isArray(saved?.result)) return saved.result;
  const result = await fetchResult();
  if (result !== null) await writeCache(directory, filename, { at: +now, result }).catch(() => {});
  return result;
}

export function searchApps(name, input, options = {}) {
  return cacheTractionSource('ios', name, options, () => fetchApps(name, input, options));
}

async function fetchApps(name, input, options) {
  const data = await readJson('https://itunes.apple.com/search?' + new URLSearchParams({
    term: input, country: 'us', entity: 'software', limit: '25',
  }), options);
  if (!Array.isArray(data?.results)) return null;
  const rows = data.results.flatMap(row => {
    if (typeof row?.trackName !== 'string' || !/^\d{4,}$/.test(row.trackId) || !appNameMatches(name, row.trackName)) return [];
    return [{ name: compactText(row.trackName, 70), url: 'https://apps.apple.com/us/app/id' + row.trackId,
      seller: compactText(row.sellerName || row.artistName, 70),
      ...(typeof row.sellerUrl === 'string' && /^https?:\/\//i.test(row.sellerUrl) && { sellerUrl: compactText(row.sellerUrl, 200) }),
      ratings: Number.isSafeInteger(row.userRatingCount) && row.userRatingCount >= 0 ? row.userRatingCount : null,
      category: compactText(row.primaryGenreName, 45),
      description: compactText(row.description, 650) }];
  });
  return [...new Map(rows.map(row => [row.url, row])).values()].sort((a, b) => (b.ratings ?? -1) - (a.ratings ?? -1));
}

function wikidataClasses(claims) {
  if (!Array.isArray(claims)) return [];
  return claims.flatMap(claim => {
    const id = claim?.mainsnak?.datavalue?.value?.id;
    return claim?.rank !== 'deprecated' && /^Q\d+$/.test(id) ? [id] : [];
  });
}

export function searchEntities(name, input, options = {}) {
  return cacheTractionSource('wikidata', name, options, () => fetchEntities(name, input, options));
}

async function fetchEntities(name, input, options) {
  const api = 'https://www.wikidata.org/w/api.php?';
  const data = await readJson(api + new URLSearchParams({
    action: 'wbsearchentities', search: input, language: 'en', format: 'json', limit: '15',
  }), options, { headers: wikidataHeaders });
  if (!Array.isArray(data?.search)) return null;
  const key = letters(name);
  const exact = data.search.filter(row => /^Q\d+$/.test(row.id) && letters(row.label) === key);
  if (!exact.length) return [];
  const getClaims = async (ids, props = 'claims') => (await readJson(api + new URLSearchParams({
    action: 'wbgetentities', ids: ids.join('|'), props, format: 'json',
  }), options, { timeout: 1200, headers: wikidataHeaders }))?.entities;
  // The same request returns sitelinks and the official website (P856) for traction.
  const details = await getClaims(exact.map(row => row.id), 'claims|sitelinks');
  if (!details && options.cacheLifetime) return null;
  const types = new Map(exact.map(row => [row.id, wikidataClasses(details?.[row.id]?.claims?.P31)]));
  const directBrand = [...types.values()].some(ids => ids.some(id => brandTypes.has(id)));
  const classes = [...new Set([...types.values()].flat())].slice(0, 50);
  const subclasses = !directBrand && classes.length ? await getClaims(classes) : null;
  return exact.map(row => {
    const brand = types.get(row.id).some(id =>
      brandTypes.has(id) || wikidataClasses(subclasses?.[id]?.claims?.P279).some(parent => brandTypes.has(parent)));
    const entity = details?.[row.id];
    const sitelinks = entity?.sitelinks && typeof entity.sitelinks === 'object' ? entity.sitelinks : {};
    const article = sitelinks.enwiki?.title;
    // Only an article whose title is the name itself, optionally with a qualifier in brackets, counts.
    const wikipedia = typeof article === 'string' && letters(article.replace(/\s*\([^)]*\)\s*$/, '')) === key
      ? compactText(article, 80) : null;
    const website = (Array.isArray(entity?.claims?.P856) ? entity.claims.P856 : [])
      .flatMap(claim => claim?.rank !== 'deprecated' && typeof claim?.mainsnak?.datavalue?.value === 'string'
        ? [compactText(claim.mainsnak.datavalue.value, 200)] : []).slice(0, 3);
    return { name: compactText(row.label, 55), description: compactText(row.description, 75),
      url: 'https://www.wikidata.org/wiki/' + row.id, ...(brand && { brand }),
      ...(details && { sitelinks: Object.keys(sitelinks).length, wikipedia, website }) };
  });
}

const handleUrls = {
  npm: name => 'https://registry.npmjs.org/' + name,
  PyPI: name => 'https://pypi.org/simple/' + name + '/',
  X: name => 'https://x.com/' + name,
  YouTube: name => 'https://www.youtube.com/@' + name,
};

async function searchGitHub(name, options) {
  const { directory = cacheDir, now = new Date() } = options;
  try {
    if (options.signal?.aborted) return { status: 'unknown' };
    const key = directory?.href;
    const held = githubHolds.get(key) ?? await readCache(directory, githubState);
    if (held?.until > now.getTime()) return { status: 'rate limited' };
    const query = new URLSearchParams({ q: '"' + name + '" in:name', per_page: '50' });
    const response = await request('https://api.github.com/search/repositories?' + query, options, { timeout: 4800 });
    if (response.status === 403 || response.status === 429) {
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      const retry = Number(response.headers.get('retry-after'));
      const until = Math.max(reset || 0, retry > 0 ? now.getTime() + retry * 1000 : 0);
      const hold = { until: until > now.getTime() ? until : now.getTime() + 60 * 60_000 };
      githubHolds.set(key, hold);
      await writeCache(directory, githubState, hold).catch(() => {});
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status === 403 || response.status === 429 ? 'rate limited' : 'unknown' };
    }
    const data = await response.json();
    if (!Array.isArray(data?.items)) return { status: 'unknown' };
    const repositories = new Set();
    let ownerType;
    for (const item of data.items) {
      if (item.owner?.login?.toLowerCase() === name) ownerType = item.owner.type;
      if (item.name?.toLowerCase() === name && /^[\w.-]+\/[\w.-]+$/.test(item.full_name)) repositories.add(item.full_name);
    }
    return {
      status: ownerType ? 'taken' : 'unknown', ...(ownerType && { ownerType }),
      count: repositories.size, examples: [...repositories].slice(0, 2),
      partial: Boolean(data.incomplete_results || data.total_count > data.items.length),
    };
  } catch { return { status: 'unknown' }; }
}

async function checkHandle(service, name, options) {
  try {
    if (options.signal?.aborted) return 'unknown';
    const response = await request(handleUrls[service](name), options, { redirect: 'manual', timeout: 2200 });
    await response.body?.cancel();
    if (response.status === 404) return 'free';
    return response.status === 200 ? 'taken' : 'unknown';
  } catch { return 'unknown'; }
}

export async function checkHandles(name, options = {}) {
  const { directory = cacheDir, now = new Date() } = options;
  const filename = 'triage-handles-' + name + '.json';
  const saved = await readCache(directory, filename) ?? {};
  const fresh = entry => {
    const age = now.getTime() - entry?.at;
    return age >= 0 && age < day;
  };
  const getGitHub = async () => {
    let status = saved.githubProfile?.status;
    if (!fresh(saved.githubProfile) || !['free', 'taken'].includes(status)) {
      const profile = async () => {
        try {
          const response = await request(handleSearches.GitHub.replace('{name}', name), options, {
            redirect: 'manual', timeout: 2200,
          });
          await response.body?.cancel();
          return response.status === 200 ? 'taken' : response.status === 404 ? 'free' : 'unknown';
        } catch { return 'unknown'; }
      };
      status = await profile();
      if (status === 'unknown' && options.retryUnavailable && !options.signal?.aborted) status = await profile();
      if (status !== 'unknown') saved.githubProfile = { status, at: now.getTime() };
    }
    if (fresh(saved.githubSearch) && saved.githubSearch.result?.count !== undefined) {
      return { ...saved.githubSearch.result, status };
    }
    if (options.githubSearch === false || options.timeLeft?.() < 3000 || options.signal?.aborted) return { status };
    const turn = githubTail.then(() => options.timeLeft?.() < 2800 ? {} : searchGitHub(name, options));
    githubTail = turn.catch(() => {});
    const result = await turn;
    if (result.count !== undefined) saved.githubSearch = { result, at: now.getTime() };
    return { ...result, status: status === 'unknown' && result.status === 'taken' ? 'taken' : status };
  };
  const [github, found] = await Promise.all([getGitHub(), Promise.all(Object.keys(handleUrls).map(async service => {
    const entry = saved[service];
    if (fresh(entry) && ['taken', 'free'].includes(entry.status)) return [service, entry.status];
    let status = await checkHandle(service, name, options);
    if (options.retryUnavailable && status === 'unknown' && !options.signal?.aborted) {
      status = await checkHandle(service, name, options);
    }
    if (status === 'taken' || status === 'free') saved[service] = { status, at: now.getTime() };
    return [service, status];
  }))]);
  await writeCache(directory, filename, saved).catch(() => {});
  return { github, handles: { GitHub: github.status, ...Object.fromEntries(found) } };
}
