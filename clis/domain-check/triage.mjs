import { canRecommend, defaultEndings, eligibilityNotes, nameCandidates, normalizeName, searchCandidates, searchKey,
  validEligibility, validEndings } from './name-search.mjs';
import { shopSearchUrl } from './prices.mjs';
import { checkHandles, compactText, handleSearches, letters, markOrder, searchApps, searchEntities, searchMarks, trademarkSearches }
  from './triage-sources.mjs';
import { checkOffice, officeAnswered, officeNames } from './trademarks.mjs';
import { screenMeaning } from './meaning.mjs';
import { loadEdgarCompanies, matchEdgarCompanies, searchNorwegianCompanies } from './company-search.mjs';
import { mapLimit } from './cache.mjs';
import { checkSocialHandles } from './handles.mjs';
import { checkDomainSite } from './com-site.mjs';
import { playSearchLink, searchAndroidApps } from './google-play.mjs';
import { googleSearchLink, lowerVerdict, nameCheckLines, searchGoogle } from './google-search.mjs';
import { autocompleteWords, collectRivals, createTraction, evidenceLifetime, judgeRivals, parseGeo, siteDomain, startEvidence,
  tractionNotes, tractionSummary, tractionVerdict } from './traction.mjs';

const coreWebsiteEndings = ['com', 'ai', 'io', 'app', 'co'];
// The slow, rate-limited sources (trademarks, app stores, rivals, web traction, GitHub and npm) screen only the first
// five names; registry answers and prices cover every name. Social handle rows go to the top three.
export const screenLimit = 5;
export const handleLimit = 3;
export const notScreened = 'Not screened (marks, apps, rivals: first ' + screenLimit + ' names only)';
const typicalProducts = [
  [/(?:domain|whois)/, /\b(?:domains?|whois|registrar)\b/i],
  [/(?:accounting|bookkeep|invoice|ledger)/, /\b(?:accounting|bookkeeping|invoic(?:e|ing)|ledger)\b/i],
  [/(?:calendar|schedule|appointment|booking)/, /\b(?:calendar|scheduling|appointment|booking)\b/i],
  [/(?:hosting|server|deploy)/, /\b(?:cloud hosting|server hosting|deployment)\b/i],
];
const genericWords = new Set([
  'company', 'business', 'platform', 'software', 'tool', 'service', 'product', 'online', 'application',
  'app', 'apps', 'developer', 'with', 'from', 'your', 'their', 'that', 'this', 'help', 'build', 'builder',
  'find', 'make', 'best', 'free',
]);
const siteCategories = [
  ['domains', /\b(?:domains?|whois|registrar)\b/i],
  ['property', /\b(?:real estate|home improvement|property|housing|rentals?)\b/i],
  ['finance', /\b(?:accounting|bookkeeping|financ\w+|banking|invoic\w+|investment)\b/i],
  ['health', /\b(?:health\w*|medical|fitness|wellness|therapy)\b/i],
  ['education', /\b(?:education|school|university|courses?|training)\b/i],
  ['travel', /\b(?:travel|flights?|hotels?|vacation|tourism)\b/i],
  ['retail', /\b(?:retail|ecommerce|shop|shopping|store)\b/i],
  ['media', /\b(?:podcasts?|news|music|magazine|entertainment)\b/i],
  ['software', /\b(?:software|saas|productivity|workspace|developer|hosting|deployment|app)\b/i],
];

function businessWords(value) {
  return (value.toLowerCase().match(/[a-z]{4,}/g) ?? [])
    .map(word => word.replace(/(?<=[a-z]{3}[^s])s$/, '')).filter(word => !genericWords.has(word));
}

const travelActivities = [
  /\b(?:book|books|reserve|reserves|reservation service|booking (?:app|assistant|platform|service|tool))\b/i,
  /\b(?:manag\w*|organiz\w*|track\w*) (?:[\w-]+ ){0,4}(?:trips?|itinerar\w*|reservations?|bookings?)\b/i,
  /\b(?:compar\w*|flight decision\w*|route guides?)\b/i,
];

function describedBusiness(name, text, about, category) {
  const brand = new RegExp('\\b' + letters(name).split('').join('[\\s-]*') + '\\b', 'gi');
  const descriptor = text.replace(brand, ' ');
  const description = about ?? category ?? '';
  if (category?.trim().toLowerCase() === 'travel' || /\b(?:travel|flights?|trips?)\b/i.test(description)) {
    const selected = travelActivities.filter(pattern => pattern.test(description));
    if (selected.length) {
      const capabilities = descriptor.replace(/\b(?:before|after) (?:you )?book(?:ing)?\b/gi, ' ');
      return selected.some(pattern => pattern.test(capabilities))
        && /\b(?:travel|flights?|trips?|hotels?|itinerar\w*|routes?)\b/i.test(capabilities);
    }
  }
  const words = new Set(businessWords(descriptor));
  return businessWords(description).some(word => words.has(word))
    || typicalProducts.some(([stem, pattern]) =>
      (pattern.test(description) || (!about && stem.test(name))) && pattern.test(descriptor));
}

export function memorability(name, input) {
  const parts = input.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
    .normalize('NFKD').replace(/\p{M}/gu, '').match(/[a-z]+/g) ?? [];
  const syllables = parts.reduce((total, part) => {
    const spoken = /[^aeiouy]le$/.test(part) ? part : part.replace(/([aeiouy].*[^aeiouy])e$/, '$1');
    return total + Math.max(1, (spoken.match(/[aeiouy]+/g) ?? []).length);
  }, 0);
  const letterCount = name.replace(/[^a-z]/g, '').length;
  const spelling = /\d|-/.test(name) ? 'hyphen or digit to spell out'
    : !/[aeiouy]/i.test(name) || /(?:[bcdfghjklmnpqrstvwxz]{4}|[aeiouy]{4}|ph|gh|[xz]{2})/.test(name)
      ? 'check spelling by ear' : 'no obvious spelling snag';
  return `${letterCount} letters (${letterCount <= 12 ? 'short' : 'long'}), ~${syllables} syllables${syllables > 3 ? ' (long)' : ''}, ${spelling}`;
}

function siteEvidence(row, site) {
  if (row?.status === 'probably-free') return 'Registry free';
  if (row?.status !== 'taken') return 'Registry unresolved';
  if (site?.state === 'live') return site.title ? 'Live: ' + compactText(site.title, 75) : 'Live site';
  if (site?.state === 'for-sale' || row.forSale) return 'Taken, possible resale';
  if (site?.state === 'parked') return 'Taken, parked';
  return site?.state === 'no-site' ? 'Taken, no site found' : 'Taken, site check unavailable';
}

function counted(count, singular, plural = singular + 's') {
  return count + ' ' + (count === 1 ? singular : plural);
}

function sameNameEvidence({ name, live, norway, us, entities, entity, github, handles, deferHandles }) {
  const sameBusiness = live.filter(site => site.sameBusiness).length;
  const businesses = new Map();
  for (const { business } of live) if (business !== 'unknown') businesses.set(business, (businesses.get(business) ?? 0) + 1);
  const [category, categoryCount] = [...businesses].sort((a, b) => b[1] - a[1])[0] ?? [];
  const siteBreakdown = sameBusiness ? ` (${sameBusiness} in your category)`
    : categoryCount ? ` (${categoryCount} in ${category})` : '';
  const repos = github.count ?? 0;
  const summary = [
    live.length && counted(live.length, 'live site') + siteBreakdown,
    norway?.matches.length && counted(norway.matches.length, 'Norwegian company', 'Norwegian companies'),
    us?.matches.length && counted(us.matches.length, 'EDGAR-listed company', 'EDGAR-listed companies'),
    entities?.length && counted(entities.length, 'Wikidata entity', 'Wikidata entities'),
    github.ownerType === 'Organization' && 'GitHub org taken',
    repos && counted(repos, 'GitHub repo'),
    handles.npm === 'taken' && 'npm package',
  ].filter(Boolean);
  const count = live.length + (norway?.matches.length ?? 0) + (us?.matches.length ?? 0) + (entities?.length ?? 0)
    + Math.min(repos * 0.25, 1) + Number(github.ownerType === 'Organization')
    + Number(handles.npm === 'taken');
  const unchecked = [
    !norway && 'Brønnøysund', !us && 'EDGAR', !entities && 'Wikidata', !deferHandles && github.status === 'check' && 'GitHub',
    !deferHandles && handles.npm === 'check' && 'npm',
  ].filter(Boolean);
  return {
    summary: 'Same name used by: ' + (summary.join(', ') || 'none found'),
    level: count >= 4 ? 'crowded' : count >= 2 ? 'some' : 'few',
    ...(live.length > 0 && { sites: live }),
    ...(norway?.matches.length > 0 && { Norway: norway.matches.slice(0, 2) }),
    ...(us?.matches.length > 0 && { EDGAR: us.matches.slice(0, 2) }),
    ...(entities?.length > 1 && { moreWikidata: entities.filter(row => row !== entity).slice(0, 2).map(row => row.url) }),
    ...(github.ownerType === 'Organization' && { githubOrg: 'https://github.com/' + name }),
    ...(repos > 0 && { githubRepos: github.examples }),
    ...((norway?.partial || github.partial) && { sampled: [norway?.partial && 'Brønnøysund', github.partial && 'GitHub'].filter(Boolean) }),
    ...(unchecked.length > 0 && { unchecked }),
  };
}

function appStatus(ios, android) {
  const taken = (store, matches) => 'taken on ' + store + (matches[0].seller ? ' (' + matches[0].seller + ')' : '');
  return 'App name: ' + (ios ? ios.length ? taken('iOS', ios) : 'free on iOS' : 'iOS not checked') + ', '
    + (android ? android.length ? taken('Android', android) : 'free on Android' : 'Android not checked');
}

// US marks read as before; EU and Norwegian marks name their office and status first.
function trademarkReason(mark) {
  const office = mark?.office && mark.office !== 'US' ? officeNames[mark.office] + ' ' + mark.status + ', ' : '';
  return mark && mark.tier + ': ' + mark.name + ' (' + office + (mark.owner || 'owner unavailable') + ', '
    + (mark.classes.join('/') || 'class unavailable') + ')';
}

// The EU and Norwegian hits a person can open: office, mark, status, classes and the office's own record.
function officeMarkEntries(marks) {
  const firstByOffice = Object.keys(officeNames).map(office => marks.find(mark => mark.office === office)).filter(Boolean);
  const selected = [...firstByOffice, ...marks.filter(mark => !firstByOffice.includes(mark))].slice(0, 3).sort((a, b) =>
    marks.indexOf(a) - marks.indexOf(b));
  return selected.map(mark => ({ office: officeNames[mark.office], mark: mark.name,
    tier: mark.tier, status: mark.status, classes: mark.classes, url: mark.url, ...(mark.checkedAt && { checkedAt: mark.checkedAt }) }));
}

function verdict({ mark, otherMark, silent, ...evidence }) {
  const [decision, reason] = baseVerdict({ mark, ...evidence });
  const trademark = trademarkReason(mark);
  const missing = silent.length ? silent.join(', ') + ' did not answer' : '';
  if (reason === 'A competition source did not answer' && missing) return [decision, missing];
  return [decision, [reason, trademark !== reason && trademark, trademarkReason(otherMark), missing].filter(Boolean).join(' · ')];
}

function silentSources({ marks, offices, apps, android, entities, norway, edgar, github, handles }) {
  return Object.entries({
    USPTO: marks,
    ...Object.fromEntries(offices.filter(result => result.state !== 'off')
      .map(result => [officeNames[result.office], officeAnswered(result) ? true : null])),
    'App Store': apps, 'Google Play': android, Wikidata: entities, Brønnøysund: norway,
    EDGAR: edgar, GitHub: github.status === 'check' ? null : github.status,
    npm: handles.npm === 'check' ? null : handles.npm,
  }).filter(([, value]) => value == null).map(([source]) => source);
}

// True when every Google signal for the name belongs to a rival whose traction was measured. Web search
// results from optional keys and unattributed autocomplete product words keep the Google floor.
function explainedGoogle(name, raw, judged, entities) {
  if (!raw || raw.web) return false;
  const key = letters(name);
  const prefix = new RegExp('^' + key.split('').join('[ ._-]*') + '(?=$|[^a-z0-9])', 'i');
  const { explained } = judged;
  const topics = (raw.topics ?? []).filter(row => prefix.test(row.name));
  // Suggestions such as "notion.so" name a home domain; each must be a measured rival's home.
  const hosts = (raw.suggestions ?? []).filter(value => /^(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(String(value).trim()))
    .map(value => siteDomain(String(value).trim())).filter(domain => domain?.split('.')[0] === key);
  const words = autocompleteWords(name, raw.suggestions) ?? 0;
  const brands = (entities ?? []).filter(row => row.brand && letters(row.name) === key);
  return topics.every(row => explained.has(row)) && brands.every(row => explained.has(row))
    && hosts.every(domain => explained.has(domain))
    && (words === 0 || judged.rivals.some(row => row.level !== 'unknown' && row.rival.autocomplete === words && words > 0));
}

// The applet's fast domain lookup stays independent of the slower name checks.
export async function namePresence(input, options = {}) {
  const name = normalizeName(input);
  if (!name) return { error: 'Enter one name without a domain ending.' };
  const started = performance.now();
  const timeLeft = () => 8500 - (performance.now() - started);
  const sources = { ...options, signal: AbortSignal.timeout(8500), playBudgetMs: 8000, timeLeft, cacheLifetime: evidenceLifetime };
  const traction = createTraction({ ...sources, refreshTranco: options.refreshTranco === true });
  const entityCheck = searchEntities(name, input, sources);
  const siteChecks = mapLimit(coreWebsiteEndings, 3, async ending => {
    const domain = name + '.' + ending;
    const site = await (options.comSite ?? checkDomainSite)(domain, 2400, true);
    if (site?.state === 'live') traction.evidence(domain);
    return [ending, site];
  });
  const [ios, android, google, entities, website] = await Promise.all([
    searchApps(name, input, sources),
    searchAndroidApps(new Map([[name, input]]), sources),
    searchGoogle(name, input, { ...sources, entities: entityCheck }),
    entityCheck, siteChecks,
  ]);
  // The applet has no agent: Wikipedia/Wikidata presence stands in for GEO and is labelled so.
  const apps = [...(ios ?? []).map(row => ({ ...row, store: 'iOS' })),
    ...(android.get(name) ?? []).map(row => ({ ...row, store: 'Android' }))];
  const rivals = collectRivals({ name, input, sites: Object.fromEntries(website), entities, topics: google.raw?.topics, suggestions: google.raw?.suggestions, apps });
  startEvidence(traction, rivals);
  const judged = judgeRivals(rivals, await traction.settle(400), { now: (options.now ?? new Date()).getTime(),
    answered: { wikidata: entities != null, apps: ios != null && android.has(name) }, entities });
  const summary = tractionSummary(judged);
  const notes = tractionNotes(judged);
  return { name, ...(summary && { traction: summary }), ...(notes.length && { notes }), checks: nameCheckLines({
    name,
    google: google.google,
    competition: {
      AppStore: ios?.map(({ name, seller, ratings }) => ({ name, developer: seller, ratings })),
      GooglePlay: android.get(name)?.map(({ name, seller, ratings }) => ({ name, developer: seller, ratings })),
    },
  }) };
}

// Same-name rivals with measured traction follow the traction rules first; evidence whose traction could not be
// measured keeps the earlier same-name checks. Trademark and availability guardrails stay in place.
function baseVerdict({ rival, overlap, sameName, activeApp, brand, app, entity, mark, site, best, available, marks, apps, android,
  androidAnswered = android, company, premium = [], offices = [] }) {
  if (rival?.[0] === 'Avoid') return rival;
  if (overlap) return ['Avoid', overlap.domain + ' is a live business in the same category'];
  if (activeApp) return ['Avoid', activeApp.name + ' is an app in the same category with ' + activeApp.ratings + ' ' + activeApp.store + ' ratings'];
  if (mark?.relevant && mark.tier !== 'Fuzzy') return ['Avoid', trademarkReason(mark)];
  if (rival) return rival;
  if (company) return ['Check first', company.name + ' is an active same-name company' +
    (company.employees > 0 ? ' with ' + company.employees + ' employees' : '')];
  if (brand) return ['Check first', brand.name + ' is an existing company or product in Wikidata'];
  if (mark) return ['Check first', trademarkReason(mark)];
  if (sameName.level !== 'few') return ['Check first', 'Several public sources show same-name use'];
  if (app) return ['Check first', 'An exact-name app already exists'];
  if (android?.length) return ['Check first', 'An exact-name Android app already exists'];
  if (site) return ['Check first', site.domain + ' has a live site under this name'];
  if (entity) return ['Check first', 'An exact-name Wikidata entity already exists'];
  const answeredOffices = offices.filter(result => result.state !== 'off');
  if (!marks || !apps || !androidAnswered || sameName.unchecked?.length || !answeredOffices.every(officeAnswered)) {
    return ['Check first', 'A competition source did not answer'];
  }
  if (!best) {
    return ['Check first', available.length ? 'The free endings require buyer eligibility'
      : premium.length ? 'The free endings may be premium, price at shop' : 'No domain was found free at the registry'];
  }
  const regions = ['US', ...answeredOffices.map(result => ({ EU: 'EU', NO: 'Norwegian' })[result.office])];
  return ['No conflict found', 'No ' + regions.slice(0, -1).join(', ') + (regions.length > 1 ? ' or ' : '') + regions.at(-1)
    + ' mark, same-name app or active company found in the sources checked'];
}

export async function triageNames(inputs, options = {}) {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 20 ||
      inputs.some(value => typeof value !== 'string' || value.length > 100 || !normalizeName(value))) {
    return { error: 'Provide 1 to 20 valid names without domain endings.' };
  }
  if (options.endings && !validEndings(options.endings)) return { error: 'Choose supported domain endings.' };
  if (options.eligible !== undefined && !validEligibility(options.eligible)) return { error: 'Eligible endings must list supported restricted endings, such as no.' };
  const endings = options.endings ?? defaultEndings;
  const websiteEndings = [...new Set([...endings, ...coreWebsiteEndings])];
  // Each name has its DNS label (punycode for æøå) for domains, and a Latin key for the rival, app and mark sources.
  const names = new Map();
  const keys = new Map();
  for (const input of inputs) {
    const name = normalizeName(input);
    if (names.has(name)) continue;
    names.set(name, input.trim());
    keys.set(name, searchKey(input));
  }
  const budgetMs = options.budgetMs ?? 13200;
  const started = performance.now();
  const timeLeft = () => budgetMs - (performance.now() - started);
  const signal = AbortSignal.timeout(budgetMs);
  const sources = { ...options, signal, timeLeft, cacheLifetime: evidenceLifetime, retryUnavailable: true, githubSearch: true };
  // Ask an unavailable source once more while the triage budget lasts.
  const retry = async (lookup, answered) => {
    const first = await lookup();
    return answered(first) || signal.aborted || timeLeft() < 300 ? first : lookup();
  };
  const found = value => value != null;
  const traction = createTraction({ ...sources, refreshTranco: options.refreshTranco === true });
  const nameOf = new Map([...names.keys()].map((name, index) => [name, index]));
  // Start traction lookups as soon as a rival's home is known, so the slow free sources overlap the other checks.
  const startHomes = (name, domains, live = true) => {
    for (const domain of domains) if (domain) traction.evidence(domain, live ? {} : { age: false, crawl: false });
  };
  const onSite = (domain, site) => {
    const name = domain.slice(0, domain.indexOf('.'));
    if (!nameOf.has(name) || nameOf.get(name) >= screenLimit) return;
    if (site?.state === 'live') startHomes(name, [domain]);
    else if (site?.state === 'parked' || site?.state === 'for-sale') startHomes(name, [domain], false);
  };
  const groups = [...names.keys()].map(name => ({
    name, candidates: nameCandidates(name, { variants: false, endings: websiteEndings }),
  }));
  const entries = [...names].map(([name, input], index) => [keys.get(name), input, index]);
  // The names put first are screened in full: the person's own name and the strongest candidates.
  const screened = entries.slice(0, screenLimit);
  const isScreened = index => index < screenLimit;
  const screenedDomains = new Set([...names.keys()].slice(0, screenLimit));
  const check = (concurrency, lookup, after = () => {}) => mapLimit(entries, concurrency, async ([name, input, index]) => {
    const result = signal.aborted || !isScreened(index) ? null : await retry(() => lookup(name, input, sources), found);
    after(result, index);
    return result;
  });
  // A deferred per name (Promise.withResolvers needs Node 22; the package supports Node 20).
  const entities = entries.map(() => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  });
  const entityChecks = check(4, searchEntities, (result, index) => {
    entities[index].resolve(result);
    const name = entries[index][0];
    startHomes(name, (result ?? []).filter(row => row.brand).flatMap(row => (row.website ?? []).map(siteDomain))
      .filter(domain => domain?.split('.')[0].includes(name)));
  });
  const domainsDone = searchCandidates(groups, { ...options, budgetMs: Math.min(budgetMs, 11500),
    siteEndings: websiteEndings, siteTimeout: 3000, siteDetails: true, onSite,
    siteFilter: domain => screenedDomains.has(domain.slice(0, domain.indexOf('.'))) });
  // GitHub and npm accounts are same-name evidence for every screened name; they share one run of controls.
  const evidenceHandles = options.deferHandles ? Promise.resolve(new Map()) : checkSocialHandles(screened.map(([name]) => ({ name, platforms: ['GitHub', 'npm'], links: false })),
    { ...options, signal });
  // Once the registry answers are in, the top three names get the full handle row, with Bluesky and variants.
  const handleRows = options.deferHandles || options.handleRows === false ? Promise.resolve(new Map()) : domainsDone.then(domains => {
    const order = handleOrder(domains.groups, keys, options.eligible).slice(0, handleLimit);
    options.onProgress?.({ stage: 'handles' });
    return evidenceHandles.then(() => checkSocialHandles(order.map(key => ({ name: key, variants: true })), { ...options, signal }));
  }).catch(() => new Map());
  // EU and Norwegian marks: one office lookup per screened name, with its own single retry inside the shared budget.
  const officeCheck = office => mapLimit(entries, 4, ([name, input, index]) => isScreened(index)
    ? checkOffice(office, name, input, sources) : null);
  const [domains, marksByName, appsByName, entitiesByName, handlesByName, norwayByName, androidApps, edgar, googleByName, socialByName,
    euByName, noByName] = await Promise.all([
      // A cold cache still gets the bundled, dated list prices, so free endings never all read "price at shop".
      domainsDone,
      check(6, searchMarks), check(8, searchApps, (result, index) => startHomes(entries[index][0],
        (result ?? []).map(row => siteDomain(row.sellerUrl)).filter(domain => domain?.split('.')[0].includes(entries[index][0])))),
      entityChecks,
      Promise.all(entries.map(([name], index) => isScreened(index)
        ? checkHandles(name, { ...sources, social: evidenceHandles.then(rows => rows.get(name)).catch(() => null) }) : null)),
      check(8, searchNorwegianCompanies),
      searchAndroidApps(new Map(screened.map(([key, input]) => [key, input])),
        { ...sources, playBudgetMs: Math.min(12000, options.playBudgetMs ?? Infinity, budgetMs) }),
      retry(() => loadEdgarCompanies(sources), found),
      mapLimit(entries, 5, ([name, input, index]) => isScreened(index) ? searchGoogle(name, input, {
        ...sources, timeoutMs: timeLeft(),
        entities: entities[index].promise,
        sameBusiness: text => describedBusiness(name, text, options.about, options.category),
      }) : { unchecked: 'not screened' }),
      handleRows,
      officeCheck('EU'), officeCheck('NO'),
    ]);
  const counts = {};
  function coverage(source, answered) { counts[source] = (counts[source] ?? 0) + Number(answered); }
  const geoByName = new Map(Object.entries(options.geo ?? {}).map(([key, value]) => [normalizeName(key), parseGeo(value)]));
  const storeAppsByName = domains.groups.map(({ name }, index) => [
    ...(appsByName[index] ?? []).map(row => ({ ...row, store: 'iOS', ref: row })),
    ...(androidApps.get(keys.get(name)) ?? []).map(row => ({ ...row, store: 'Android', ref: row })),
  ]);
  const rivalsByName = domains.groups.map(({ name, sites }, index) => {
    if (!isScreened(index)) return [];
    const raw = googleByName[index].raw ?? {};
    const key = keys.get(name);
    const rivals = collectRivals({
      name: key, input: names.get(name), sites, entities: entitiesByName[index], topics: raw.topics, suggestions: raw.suggestions,
      apps: storeAppsByName[index], geo: geoByName.get(name),
      sameBusiness: text => describedBusiness(key, text, options.about, options.category),
    });
    startEvidence(traction, rivals);
    return rivals;
  });
  options.onProgress?.({ stage: 'rivals' });
  const evidence = await traction.settle();
  const rows = domains.groups.map(({ name, results, sites }, index) => {
      const requested = results.filter(row => endings.includes(row.tld));
      const available = results.filter(row => row.status === 'probably-free' && endings.includes(row.tld));
      const recommendable = available.filter(row => canRecommend(row.tld, options.eligible));
      const [best] = recommendable;
      const social = socialByName.get(keys.get(name)) ?? null;
      const domainFields = {
        taken: requested.filter(row => row.status === 'taken').map(row => row.tld),
        shop_check: requested.filter(row => ['check-at-shop', 'reserved'].includes(row.status)).map(row => row.tld),
        ...(requested.some(row => row.status === 'reserved') && {
          reserved: requested.filter(row => row.status === 'reserved').map(row => row.tld) }),
        // Subsets of shop_check with a DNS likelihood; only a registry or shop settles them.
        ...likelyEndings(requested),
        // Premium endings never carry a list price; the shop shows their price. A short name may be premium.
        ...(requested.some(row => row.status === 'premium') && {
          premium: requested.filter(row => row.status === 'premium').map(row => row.tld) }),
      };
      const receipt = options.receipt && { _receiptEndings: requested.map(row => ({ domain: row.domain, source: row.source,
        checkedAt: row.checkedAt, priceAt: row.priceCheckedAt, shop: row.shop, checkout: row.buyUrl,
        site: sites[row.tld], risk: row.premium === 'risk' || row.premiumRisk })), _handles: social };
      if (!isScreened(index)) {
        // Registry answers and prices only. The verdict never reads "No conflict found" without the checks.
        return {
          name: names.get(name), verdict: 'Check first', reason: notScreened,
          _free: available, _recommendable: recommendable, _googleExplained: true,
          google: { result: 'not checked', why: 'not screened', link: googleSearchLink(names.get(name)) },
          ...domainFields,
          competition: { US: null, mark: null, AppStore: null, GooglePlay: null, Wikidata: null,
            sameName: { summary: 'Not screened', level: 'unknown' } },
          buy: best ? best.buyUrl ?? shopSearchUrl(best.confirmShop, best.domain) : null,
          ...receipt,
          details: { memorable: memorability(keys.get(name), names.get(name)), presence: null, sites: {},
            appName: 'App name: not checked', AndroidSearch: playSearchLink(names.get(name)) },
        };
      }
      const marks = marksByName[index];
      const apps = appsByName[index];
      const entities = entitiesByName[index];
      const { github, handles } = handlesByName[index];
      const norway = norwayByName[index];
      const [app] = apps ?? [];
      const brand = entities?.find(row => row.brand);
      const entity = brand ?? entities?.[0];
      const key = keys.get(name);
      const android = androidApps.get(key);
      const google = googleByName[index];
      const judged = judgeRivals(rivalsByName[index], evidence, { now: (options.now ?? new Date()).getTime(),
        answered: { wikidata: entities != null, apps: apps != null && android != null },
        geo: geoByName.get(name), entities });
      const { explained } = judged;
      const storeApps = storeAppsByName[index];
      const activeApp = storeApps.find(row => !explained.has(row.ref) && row.ratings >= 100 && describedBusiness(key,
        [row.name, row.category, row.description].join(' '), options.about, options.category));
      const offices = [euByName[index], noByName[index]].filter(Boolean);
      const officeMarks = offices.flatMap(result => result.marks ?? []);
      // US, EU and Norwegian hits share one order; a same-name mark at another office stays a separate hit.
      const allMarks = [...(marks ?? []), ...officeMarks].sort(markOrder(key));
      const mark = allMarks[0];
      const others = allMarks.filter(item => item !== mark && (item.office !== mark?.office || letters(item.name) !== letters(mark?.name)));
      const otherMark = others.find(item => item.relevant) ?? others.find(item => item.tier === 'Fuzzy') ?? others[0];
      const seen = websiteEndings.flatMap(tld => {
        const row = results.find(result => result.tld === tld);
        return tld === 'com' || row?.status === 'taken' ? [[tld, siteEvidence(row, sites[tld])]] : [];
      });
      const live = Object.entries(sites).flatMap(([tld, site]) => {
        const domain = name + '.' + tld;
        if (site.state !== 'live' || (site.host && site.host !== domain && !site.host.endsWith('.' + domain)
            && !letters([site.title, site.description].join(' ')).includes(letters(key)))) return [];
        const business = siteCategories.find(([, pattern]) => pattern.test(site.title ?? ''))?.[0]
          ?? siteCategories.find(([, pattern]) => pattern.test(site.description ?? ''))?.[0] ?? 'unknown';
        const sameBusiness = describedBusiness(key, [site.title, site.description].join(' '), options.about, options.category);
        return [{ domain, title: compactText(site.title, 75), business, ...(sameBusiness && { sameBusiness }) }];
      });
      // Only same-name evidence whose traction could not be measured keeps the earlier checks.
      const unmeasured = live.filter(row => !explained.has(row.domain));
      const site = unmeasured[0];
      const overlap = unmeasured.find(row => row.sameBusiness && /\.(com|ai)$/.test(row.domain));
      const us = matchEdgarCompanies(key, edgar);
      const company = norway?.matches.find(row => row.employees > 0 && row.match === 'exact')
        ?? us?.matches.find(row => row.match === 'exact');
      const sameName = sameNameEvidence({ name: key, live, norway, us, entities, entity, github, handles, deferHandles: options.deferHandles });
      const otherEntities = entities?.filter(row => !explained.has(row));
      const legacy = sameNameEvidence({ name: key, live: unmeasured, norway, us, entities: otherEntities, entity, github, handles, deferHandles: options.deferHandles });
      const silent = silentSources({ marks, offices, apps, android, entities, norway, edgar, github, handles })
        .filter(source => !options.deferHandles || !['GitHub', 'npm'].includes(source));
      const otherEntity = otherEntities?.find(row => row.brand) ?? otherEntities?.[0];
      const [decision, reason] = verdict({
        rival: tractionVerdict(judged), overlap, sameName: legacy, activeApp,
        brand: otherEntity?.brand ? otherEntity : undefined, app: apps?.find(row => !explained.has(row)), entity: otherEntity,
        mark, otherMark, site, silent, best, available, marks, apps, premium: results.filter(row => row.status === 'premium'),
        android: android?.filter(row => !explained.has(row)), androidAnswered: android, company, offices,
      });
      const googleExplained = explainedGoogle(key, googleByName[index].raw, judged, entities);
      const summary = tractionSummary(judged);
      const answered = {
        USPTO: marks, 'App Store': apps, 'Google Play': android, Google: google.google, Wikidata: entities,
        Brønnøysund: norway, EDGAR: edgar,
        ...Object.fromEntries(offices.filter(result => result.state !== 'off')
          .map(result => [officeNames[result.office], officeAnswered(result) ? true : null])),
        ...!options.deferHandles && Object.fromEntries(Object.entries(handles).map(([service, status]) => [service, status === 'check' ? null : status])),
      };
      for (const [source, value] of Object.entries(answered)) coverage(source, value != null);
      const usMark = marks?.[0];
      const competition = {
        US: usMark ? trademarkReason(usMark) : marks ? [] : null,
        mark: usMark?.url ?? null,
        // EU and NO appear once a key is set: the strongest hit, [] when the office answered in full with none,
        // null when it failed or answered in part (check yourself).
        ...Object.fromEntries(offices.filter(result => result.state !== 'off').map(result => {
          const [best] = result.marks;
          return [result.office, officeAnswered(result) ? (best ? trademarkReason(best) : []) : null];
        })),
        ...(officeMarks.length > 0 && { marks: officeMarkEntries(officeMarks.sort(markOrder(key))) }),
        AppStore: app ? { name: app.name, developer: app.seller, ratings: app.ratings, url: app.url } : apps ? [] : null,
        GooglePlay: android?.map(({ name, seller, url, ratings }) => ({ name, developer: seller, url, ratings })).slice(0, 3) ?? null,
        Wikidata: entity ? { name: entity.name, description: entity.description, url: entity.url,
          ...(entity.brand && { brand: true }) } : entities ? [] : null,
        sameName,
      };
      return {
        // Small and dormant same-name uses are notes after the reason; they never change the verdict.
        name: names.get(name), verdict: decision, reason: [reason, ...tractionNotes(judged)].join(' · '),
        _free: available, _recommendable: recommendable, _mark: mark, _googleExplained: googleExplained,
        ...(summary && { traction: summary }),
        google: { ...(google.google ?? { result: 'not checked', why: google.unchecked }), link: googleSearchLink(names.get(name)) },
        ...domainFields,
        _social: compactHandles(social),
        // The checkout is the listed shop's search, or the confirming shop's search when no list price is known.
        competition, buy: best ? best.buyUrl ?? shopSearchUrl(best.confirmShop, best.domain) : null,
        ...receipt,
        details: {
          memorable: memorability(key, names.get(name)),
          presence: Object.fromEntries(Object.entries(handles).map(([service, status]) =>
            [service, status === 'check' ? null : status])),
          sites: Object.fromEntries(seen), appName: appStatus(apps, android),
          AndroidSearch: android ? null : playSearchLink(names.get(name)),
        },
      };
    });
  for (const row of rows) {
    // Google evidence that a measured rival explains is judged by its traction, not by the Google floor.
    if (!row._googleExplained) lowerVerdict(row, row.google);
    // A rude or embarrassing meaning is a note and at most Check first, for every name, screened or not.
    const meaning = screenMeaning(row.name);
    if (meaning) {
      row.meaning = meaning.note;
      if (row.verdict === 'No conflict found') {
        row.verdict = 'Check first';
        row.reason = 'Meaning: ' + meaning.note + ' · ' + row.reason;
      } else row.reason += ' · Meaning: ' + meaning.note;
    }
    row.checks = options.compact ? null
      : nameCheckLines(row).map(({ label, text, link }) => label + ': ' + text + ' · ' + link);
  }
  for (const row of googleCandidates(rows)) row.google.search = true;
  const sourcesSummary = Object.fromEntries(Object.entries(counts).map(([source, answered]) =>
    [source, Math.round(100 * answered / Math.min(names.size, screenLimit))]));
  const receiptDetails = options.receipt ? structuredClone(rows.map(({ competition, details, traction, google, reason, meaning, _receiptEndings, _handles }) =>
    ({ competition, details, traction, google, reason, meaning, endings: _receiptEndings, handles: _handles }))) : null;
  const result = packTriage(rows, sourcesSummary, options.compact, endings, options.eligible);
  if (options.receipt) {
    result.checkedAt = (options.now ?? new Date()).toISOString();
    result.priceListDate = domains.priceDate?.slice(0, 10);
    result.receiptDetails = receiptDetails;
    if (options.deferHandles) {
      const targets = handleOrder(domains.groups, keys, options.eligible).slice(0, handleLimit);
      result.handleTargets = targets.map(name => ({ name, index: [...keys.values()].indexOf(name) }));
    }
  }
  return result;
}

// The order the handle rows go in: the person's own name first, then names with a free recommendable ending,
// cheapest first, then the other screened names in input order.
export function handleOrder(groups, keys, eligible) {
  const screened = groups.slice(0, screenLimit).map((group, index) => {
    const free = group.results.filter(row => row.status === 'probably-free' && canRecommend(row.tld, eligible))
      .map(row => row.firstPayment ?? Infinity);
    return { key: keys.get(group.name), index, free: free.length > 0, cost: Math.min(...free, Infinity) };
  });
  const [first, ...rest] = screened;
  rest.sort((a, b) => Number(b.free) - Number(a.free) || a.cost - b.cost || a.index - b.index);
  return [first, ...rest].filter(Boolean).map(row => row.key);
}

function compactHandles(entries) {
  if (!Array.isArray(entries)) return null;
  const by = state => entries.filter(entry => entry.state === state).map(entry => entry.platform);
  const [taken, notFound, check] = [by('taken'), by('not-found'), by('check')];
  return { ...(taken.length && { taken }), ...(notFound.length && { not_found: notFound }), ...(check.length && { check }) };
}

// The first three ranked names, filled from the screened names in input order when fewer than three rank.
export function googleCandidates(rows) {
  const picked = rankedRows(rows).slice(0, 3);
  for (const row of rows) if (picked.length < 3 && !picked.includes(row)) picked.push(row);
  return picked;
}

function priceEntry(row) {
  return {
    ...(row.firstPayment != null && { now: row.firstPayment }),
    ...(row.renewalPayment != null && { renew: row.renewalPayment }),
    ...(row.minimumYears > 1 && { term: row.minimumYears }),
    ...(row.renewalJump && { jump: true }),
    ...(row.shop && { shop: row.shop }),
  };
}

function likelyEndings(rows) {
  const open = rows.filter(row => row.status === 'check-at-shop');
  const free = open.filter(row => row.likely === 'free').map(row => row.tld);
  const taken = open.filter(row => row.likely === 'taken').map(row => row.tld);
  return { ...(free.length && { likely_free: free }), ...(taken.length && { likely_taken: taken }) };
}

// Best value is the lowest total of the payments due in three years; the cheaper first payment breaks a tie.
function bestValue(options) {
  return options.filter(row => Number.isFinite(row.threeYear)).reduce((best, row) => !best || row.threeYear < best.threeYear
    || (row.threeYear === best.threeYear && row.firstPayment < best.firstPayment) ? row : best, undefined);
}

function rankedRows(rows) {
  const order = { 'No conflict found': 0, 'Check first': 1 };
  return rows.filter(row => row.verdict !== 'Avoid').sort((a, b) => order[a.verdict] - order[b.verdict]
    || (a._recommendable[0]?.firstPayment ?? Infinity) - (b._recommendable[0]?.firstPayment ?? Infinity));
}

function topChoices(rows) {
  return rankedRows(rows).slice(0, 3)
    .map(({ name, verdict, reason, _recommendable }) => {
      const [best] = _recommendable;
      const value = bestValue(_recommendable);
      return {
        name, verdict, reason, domain: best?.domain ?? null, ending: best?.tld ?? null,
        now: best?.firstPayment ?? null, renew: best?.renewalPayment ?? null, term: best?.minimumYears ?? null,
        ...(value && { bestValue: { domain: value.domain, now: value.firstPayment,
          renew: value.renewalPayment, term: value.minimumYears, y3: value.threeYear } }),
      };
    });
}

// Share each ending's standard price once and keep only per-name differences.
function packTriage(rows, sources, compact, endings, eligible) {
  const prices = {};
  const top = topChoices(rows);
  // Handle states for the top names: taken, not_found (no public profile found) or check (check yourself).
  const handles = Object.fromEntries(rows.filter(row => row._social).map(row => [row.name, row._social]));
  const names = rows.map(({ _free, _recommendable, _mark, _googleExplained, _receiptEndings, _handles, _social, ...row }) => {
    const own = {};
    for (const option of _free) {
      const entry = priceEntry(option);
      if (Object.keys(entry).length === 0) continue;
      if (!prices[option.tld]) prices[option.tld] = entry;
      else if (JSON.stringify(prices[option.tld]) !== JSON.stringify(entry)) own[option.tld] = entry;
    }
    return { ...row, free: _free.map(option => option.tld), own, bestValue: bestValue(_recommendable)?.tld ?? null };
  });
  const result = { top, names, prices, sources, eligibility: eligibilityNotes(endings),
    ...(Object.keys(handles).length && { handles }),
    ...(eligible?.length && { eligible }),
    ...(!compact && names.length <= 5 && { trademarkSearches, handleSearches }) };
  const limit = names.length <= 5 ? (compact ? 5600 : 5999) : compact ? 9150 : 9850;
  const size = () => Buffer.byteLength(JSON.stringify(result));
  if (!compact && names.length <= 5 && size() > limit) {
    delete result.handleSearches;
    if (size() > limit) for (const row of names) row.buy = null;
  }
  for (const trim of [
    // Platforms not listed under taken or not_found are "check yourself"; the results page lists them all.
    () => { for (const value of Object.values(result.handles ?? {})) delete value.check; },
    // GitHub and npm stand in the handle states and the same-name summary too.
    row => { if (row.details) delete row.details.presence; },
    row => { row.details = null; },
    row => { row.buy = null; },
    row => { if (row.traction) delete row.traction.geo; },
    row => { if (row.competition.marks) row.competition.marks = row.competition.marks.slice(0, 1); },
    row => {
      const { sameName, mark, marks, ...remaining } = row.competition;
      row.competition = { ...remaining, mark: null, sameName: { level: sameName.level } };
    },
    row => {
      for (const source of ['AppStore', 'GooglePlay', 'Wikidata']) {
        const match = row.competition[source];
        if (Array.isArray(match) && match.length) row.competition[source] = match[0].name;
        else if (match && !Array.isArray(match)) row.competition[source] = match.name;
      }
    },
    // The reason already names a rival with traction and its two strongest signals.
    row => { delete row.traction; },
    row => { delete row.google.why; },
    row => { row.name = normalizeName(row.name); },
    row => {
      for (const office of ['US', 'EU', 'NO']) {
        if (typeof row.competition[office] === 'string') row.competition[office] = row.competition[office].split(':', 1)[0];
      }
      row.reason = row.reason.split(' · ', 1)[0];
    },
    // Last: the results page and say keep the full handle rows.
    () => { delete result.handles; },
  ]) {
    if (size() <= limit) break;
    names.forEach(trim);
  }
  if (names.length > 5 && size() > limit) {
    const revised = new Map(rows.map(({ name }, index) => [name, names[index]]));
    for (const [index, row] of names.entries()) {
      row.reason = compactReason(row, rows[index]._mark, 60);
      for (const office of ['US', 'EU', 'NO']) if (typeof row.competition[office] === 'string') row.competition[office] = true;
      for (const source of ['AppStore', 'GooglePlay', 'Wikidata']) {
        if (typeof row.competition[source] === 'string') row.competition[source] = true;
      }
    }
    const compactTop = () => top.map(row => {
      const { name, reason, bestValue } = revised.get(row.name);
      return { ...row, domain: null, name, reason, ...(bestValue && { bestValue }) };
    });
    result.top = compactTop();
    if (size() > limit && names.some(row => row.bestValue)) {
      names.forEach((row, index) => { row.reason = compactReason(row, rows[index]._mark, 40); });
      result.top = compactTop();
    }
  }
  return result;
}

function shortenBytes(value, bytes) {
  const buffer = Buffer.from(value);
  if (buffer.length <= bytes) return value;
  return buffer.subarray(0, bytes - 3).toString().replace(/\uFFFD$/, '') + '…';
}

function compactReason(row, mark, budget) {
  if (!mark || !row.reason.startsWith(mark.tier + ': ')) return shortenBytes(row.reason, budget);
  const classes = [...new Set([...mark.relevantClasses, ...mark.classes])].slice(0, 2).join('/');
  const prefix = mark.tier + ': ';
  const suffix = ', ' + (classes || 'class unavailable') + ')';
  const remaining = budget - Buffer.byteLength(prefix + ' (' + suffix);
  if (remaining < 6) return shortenBytes(row.reason, budget);
  // A compact EU or Norwegian hit names its office in place of the owner.
  const owner = mark.office && mark.office !== 'US' ? officeNames[mark.office] : mark.owner || 'owner unavailable';
  return prefix + shortenBytes(mark.name, Math.ceil(remaining / 2)) + ' ('
    + shortenBytes(owner, Math.floor(remaining / 2)) + suffix;
}
