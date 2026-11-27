import { lookupAtomListing } from './clis/domain-check/broker-atom.mjs';
import { readList } from './clis/portfolio/store.mjs';
import { playSearchLink } from './clis/domain-check/google-play.mjs';
import { searchApps, searchMarks } from './clis/domain-check/triage-sources.mjs';
import { checkGooglePlayNames, checkSocialHandles } from './clis/domain-check/handles.mjs';
import { companyRequest, isParkingHost, marketplace, readCompanies, readEntities, readRegistration, readSitePage,
  sourceUrl, wikiRequest } from './name-context.mjs';
import { bootstrapUrl, rdapBase, rdapDomainUrl, documentedWhois } from './clis/domain-check/registry.mjs';
import { followSite } from './clis/domain-check/safe-web.mjs';
import { priceEvidenceUrl } from './clis/domain-check/price-catalog.mjs';
import { searchCandidates } from './clis/domain-check/name-search.mjs';

export function registrySource(domain, ending, method) {
  if (method === 'dns' || method?.startsWith('dns')) {
    return 'https://cloudflare-dns.com/dns-query?' + new URLSearchParams({ name: domain, type: 'NS' });
  }
  if (method === 'whois' || method?.startsWith('whois')) {
    const provider = documentedWhois.get(ending);
    return provider ? 'whois://' + provider : null;
  }
  if (method === 'web') return 'https://' + domain + '/';
  if (!method?.startsWith('rdap')) return null;
  const base = rdapBase(ending) ?? ({
    com: 'https://rdap.verisign.com/com/v1/',
    ai: 'https://rdap.identitydigital.services/rdap/',
    app: 'https://pubapi.registry.google/rdap/',
    dev: 'https://pubapi.registry.google/rdap/',
  })[ending];
  return base ? rdapDomainUrl(base, domain) : bootstrapUrl;
}

async function boundedJson(url, signal, fetcher) {
  if (!url) return null;
  try {
    const response = await fetcher(url, {
      headers: { 'user-agent': 'DomainHound (+https://domainhound.dev)', accept: 'application/json, application/rdap+json' },
      redirect: 'error', credentials: 'omit', signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const reader = response.body?.getReader();
    if (!reader) return null;
    try {
      const decoder = new TextDecoder();
      let body = '';
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return JSON.parse(body + decoder.decode());
        bytes += value.length;
        if (bytes > 180_000) return null;
        body += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch {
    return null;
  }
}

async function domainSite(domain, options) {
  const start = 'https://' + domain + '/';
  const read = scheme => followSite(scheme + '://' + domain + '/', {
    ...options, stopAt: url => marketplace(url) ? 'marketplace' : isParkingHost(url) ? 'parking' : null,
  });
  const evidence = result => {
    const checkedAt = new Date().toISOString();
    if (result.stopped?.url && result.hops.length) {
      const url = result.stopped.url;
      const market = marketplace(url);
      const path = url.pathname.toLowerCase().split('/').filter(Boolean);
      const bound = path.includes(domain) || url.searchParams.get('domain')?.toLowerCase() === domain ||
        (market === 'Atom' && path[0] === 'name' && path[1] === domain.slice(0, -4));
      if (market || isParkingHost(url)) return { state: !market ? 'parked' : bound ? 'for-sale' : 'redirect', host: url.hostname,
        url: sourceUrl(url), checkedAt, ...(market && bound && { marketplace: market }) };
    }
    const page = result.final;
    if (page?.status === 200 && page.body) return readSitePage(domain, page.url, page.body, checkedAt, { complete: !page.truncated });
    const target = result.failed?.url ?? result.stopped?.url ?? page?.url;
    return { state: target && ![domain, 'www.' + domain].includes(target.hostname) ? 'redirect' : 'unconfirmed',
      ...(target && { host: target.hostname }), url: start, checkedAt };
  };
  const https = evidence(await read('https'));
  return https.state === 'unconfirmed' && !options.signal.aborted ? evidence(await read('http')) : https;
}

async function candidateRows(labels, endings, variant) {
  const candidates = labels.flatMap(name => endings.map(tld => ({ domain: name + '.' + tld, tld, exact: !variant })));
  if (!candidates.length) return [];
  const { groups } = await searchCandidates([{ candidates }], { budgetMs: 3500, cachedOnly: true, skipComSite: true });
  return groups[0].results.map(row => {
    const status = ['confirmed', 'probably-free', 'premium'].includes(row.status) ? 'available' : row.status === 'taken' ? 'taken' : 'unknown';
    return { domain: row.domain, ending: row.tld, status, variant, premium: row.premium,
      checkedAt: row.checkedAt, source: registrySource(row.domain, row.tld, row.source), evidence: row.source,
      reason: row.status === 'reserved' ? 'reserved' : null, prices: status === 'available' && !row.premium && row.price != null ? [{
        shop: row.shop, firstYearUsd: row.price, firstPaymentUsd: row.firstPayment, minimumYears: row.minimumYears,
        renewalUsd: row.renewal, renewalPaymentUsd: row.renewalPayment, threeYearUsd: row.threeYear,
        checkedAt: row.priceCheckedAt, source: row.status === 'confirmed' ? row.buyUrl : priceEvidenceUrl(row.shop, row.tld) ?? row.buyUrl, buyUrl: row.buyUrl,
        needsCloudflareDns: row.shop === 'Cloudflare',
      }] : [] };
  });
}

export function publicSources({ fetcher = globalThis.fetch, env = process.env } = {}) {
  return {
    async owned() {
      return (await readList()).domains;
    },
    async names(name, label) {
      const signal = AbortSignal.timeout(2800);
      const wiki = wikiRequest(name);
      const companies = companyRequest(name);
      const [wikidata, brreg, handles] = await Promise.all([
        boundedJson(wiki, signal, fetcher), boundedJson(companies, signal, fetcher),
        checkSocialHandles([{ name: label, platforms: ['LinkedIn'] }], { env, fetcher, signal }).catch(() => null),
      ]);
      const checkedAt = new Date().toISOString();
      const entities = readEntities(wikidata, name, checkedAt);
      const matches = readCompanies(brreg, name, checkedAt);
      return { entities, companies: matches, linkedin: handles?.get(label)?.find(row => row.platform === 'LinkedIn'), lookups: [
        { url: wiki, checkedAt, status: entities ? 'checked' : 'unconfirmed' },
        { url: companies, checkedAt, status: matches ? 'checked' : 'unconfirmed' },
      ] };
    },
    async domain(domain) {
      const signal = AbortSignal.timeout(3800);
      const url = registrySource(domain, 'com', 'rdap');
      const [site, registry, info] = await Promise.all([
        domainSite(domain, { signal }), boundedJson(url, signal, fetcher), lookupAtomListing(domain, { signal, fetcher }),
      ]);
      const listing = { state: info.status, name: 'Atom', url: info.listingUrl ?? info.url,
        sourceUrl: info.url, checkedAt: info.checkedAt, ...(info.price && ['USD', 'EUR', 'GBP'].includes(info.price.currency) && { price: info.price }) };
      return { domain, site, registration: readRegistration(registry, domain, url, new Date().toISOString()), listing };
    },
    variants: (labels, endings) => candidateRows(labels, endings, true),
    comparison: (label, endings) => candidateRows([label], endings, false),
    proposalDomains: labels => candidateRows(labels, ['com', 'app', 'dev'], false),
    async localChecks(name, label) {
      const signal = AbortSignal.timeout(2800);
      const [apps, play, marks] = await Promise.all([
        searchApps(label, name, { signal, fetcher }).catch(() => null),
        checkGooglePlayNames([name], { signal, fetcher, env }).catch(() => null),
        searchMarks(label, name, { signal, fetcher }).catch(() => null),
      ]);
      const checkedAt = new Date().toISOString();
      const exact = (marks ?? []).filter(row => row.tier === 'Exact').map(row => ({ ...row, mark: row.name }));
      const playRow = play?.get(name);
      return {
        appStore: { status: !apps ? 'unknown' : apps.length ? 'taken' : 'no_match_found',
          checkedAt: apps ? checkedAt : null, matches: apps ?? [] },
        googlePlay: { status: playRow?.state ?? 'unknown', link: playSearchLink(name), checkedAt: playRow?.checkedAt ?? null },
        // This local endpoint includes fuzzy hits and can truncate the result set. Positive exact matches are usable.
        trademarks: { us: { status: exact.length ? 'exact_match_found' : 'unknown', marks: exact, checkedAt: exact.length ? checkedAt : null } },
      };
    },
  };
}
