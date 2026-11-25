#!/usr/bin/env node
// Daily self-check: runs Domain Hound's own functions against the live sources with a fresh, empty cache and
// synthetic names (google.com is taken; random 18-letter names are free). Prints one JSON summary and exits 1 when
// any source is broken, naming each one. Polite by design: strictly under 60 requests, Google hosts paced.
import { randomInt } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { readCache } from '../clis/domain-check/cache.mjs';
import { agentResult } from '../clis/domain-check/index.mjs';
import { refreshPrices } from '../clis/domain-check/price-catalog.mjs';
import { systemQueryWhois, systemResolveNs } from '../clis/domain-check/registry.mjs';
import { triageNames } from '../clis/domain-check/triage.mjs';

export const requestLimit = 59;
export const freshDays = 3;
export const famousName = 'Spotify';
export const registryEndings = ['com', 'ai', 'app', 'dev', 'io', 'co', 'me', 'si'];
const registries = {
  com: 'Verisign', ai: 'Identity Digital', app: 'Google Registry', dev: 'Google Registry', io: 'Identity Digital',
  co: '.CO Internet', me: 'Identity Digital', si: 'Register.si',
};
const googleHosts = /(?:^|\.)(?:google\.com|registry\.google)$/;
const googleSpacing = 600;

export function randomLabel(length = 18, pick = randomInt) {
  return Array.from({ length }, () => String.fromCharCode(97 + pick(26))).join('');
}

// Counts every application request, refuses the 60th, and spaces requests to Google hosts.
export function countingFetch(base, { limit = requestLimit, spacing = googleSpacing, wait = delay } = {}) {
  let googleTurn = Promise.resolve();
  let lastGoogle = -Infinity;
  const redirects = new Set([301, 302, 303, 307, 308]);
  const counter = async (input, init = {}, depth = 0) => {
    const url = new URL(input instanceof Request ? input.url : input);
    await counter.take(url.host);
    if (init.redirect && init.redirect !== 'follow') return base(url.href, init);
    const response = await base(url.href, { ...init, redirect: 'manual' });
    const location = response.headers.get('location');
    if (!redirects.has(response.status) || !location) return response;
    await response.body?.cancel();
    const target = new URL(location, url);
    if (depth >= 8 || target.protocol !== 'https:') throw new Error('Canary refused an unsafe redirect');
    // Strip headers before following a redirect to a different origin.
    const next = { ...init, ...(url.origin !== target.origin && { headers: undefined }) };
    if (response.status === 303 || ([301, 302].includes(response.status) && next.method === 'POST')) {
      next.method = 'GET';
      delete next.body;
    }
    return counter(target, next, depth + 1);
  };
  counter.take = async host => {
    if (counter.count >= limit) {
      counter.refused++;
      throw new Error('Canary request budget of ' + limit + ' reached');
    }
    counter.count++;
    counter.hosts[host] = (counter.hosts[host] ?? 0) + 1;
    if (googleHosts.test(host)) {
      const turn = googleTurn.then(async () => {
        const gap = lastGoogle + spacing - performance.now();
        if (gap > 0) await wait(gap);
        lastGoogle = performance.now();
      });
      googleTurn = turn.catch(() => {});
      await turn;
    }
  };
  counter.count = 0;
  counter.refused = 0;
  counter.hosts = {};
  return counter;
}

const ageDays = (checkedAt, now) => (now - Date.parse(checkedAt)) / 86_400_000;

// Each first-party price list must have refreshed now and be at most three days old.
export function priceChecks(refresh, now, { days = freshDays } = {}) {
  const catalogs = refresh?.catalogs ?? {};
  // The automatic refresh uses the public lists. Spaceship quotes require an account or the opt-in browser.
  const checks = ['porkbun', 'dynadot'].map(id => {
    const name = id[0].toUpperCase() + id.slice(1) + ' price list';
    const source = catalogs[id];
    const age = source ? ageDays(source.checkedAt, now) : Infinity;
    const ok = Boolean(source) && age >= 0 && age <= days && Object.keys(source.prices ?? {}).length > 0;
    const why = ok ? null : source ? 'last refreshed ' + source.checkedAt : 'no valid prices returned';
    return { source: name, ok, ...(source && { checkedAt: source.checkedAt, endings: Object.keys(source.prices ?? {}).length }),
      ...(why && { detail: why }) };
  });
  // Gandi fills only endings the other shops lack; it is checked when it was needed.
  if (catalogs.gandi) {
    const age = ageDays(catalogs.gandi.checkedAt, now);
    checks.push({ source: 'Gandi price list', ok: age >= 0 && age <= days, checkedAt: catalogs.gandi.checkedAt,
      endings: Object.keys(catalogs.gandi.prices ?? {}).length });
  }
  return checks;
}

// The batch result for the random name and google.com: every registry must answer, google.com must be taken.
export function registryChecks(result, label, { endings = registryEndings, now, days = freshDays } = {}) {
  if (!result || result.error) return [{ source: 'check_domains', ok: false, detail: result?.error ?? 'no result' }];
  const [random, google] = result.names ?? [];
  const checks = endings.map(ending => {
    const free = (random?.free ?? []).some(option => option.d === ending);
    const why = result.shopCheckWhy?.[ending] ?? result.shopCheckWhy?.[label + '.' + ending];
    const status = free ? 'free' : random?.taken?.includes(ending) || random?.resale?.includes(ending) ? 'taken'
      : random?.shop_check?.includes(ending) ? 'unsettled' : 'missing';
    return { source: 'Registry .' + ending + ' (' + registries[ending] + ')', ok: free,
      ...(!free && { detail: label + '.' + ending + ' came back ' + status + (why ? ': ' + why : '') }) };
  });
  const taken = google?.taken?.includes('com') || google?.resale?.includes('com');
  checks.push({ source: 'Registry google.com (taken control)', ok: Boolean(taken),
    ...(!taken && { detail: 'google.com was not reported as taken' }) });
  const listed = endings.filter(ending => result.listPrices?.[ending]?.now > 0 ||
    (random?.free ?? []).some(option => option.d === ending && option.now > 0));
  const age = ageDays(result.priceListDate + 'T00:00:00Z', now);
  const dated = age >= 0 && age <= days;
  checks.push({ source: 'check_domains list prices', ok: listed.length === endings.length && Boolean(dated),
    ...(result.priceListDate && { priceListDate: result.priceListDate }),
    ...(!(listed.length === endings.length && dated) && {
      detail: 'priced ' + listed.length + ' of ' + endings.length + ' endings; list date ' + (result.priceListDate ?? 'missing') }) });
  return checks;
}

export function nameChecks({ triage, suggestions }, name = famousName) {
  const result = triage?.names?.[0];
  const markHit = Boolean(result?.competition?.US);
  const appHit = Boolean(result?.competition?.AppStore);
  const suggested = Array.isArray(suggestions) && suggestions.length > 0;
  return [
    { source: 'USPTO trademark search', ok: markHit,
      detail: markHit ? 'live mark found' : triage?.sources?.USPTO ? 'no live mark for ' + name : 'source did not answer' },
    { source: 'iTunes Search (App Store)', ok: appHit,
      detail: appHit ? 'app found' : triage?.sources?.['App Store'] ? 'no app named ' + name : 'source did not answer' },
    { source: 'Google autocomplete', ok: suggested,
      ...(suggested ? { detail: suggestions.length + ' suggestions' } : { detail: suggestions == null ? 'source did not answer' : 'no suggestions' }) },
  ];
}

export function summarize(checks, { checkedAt, requests, refused = 0, limit = requestLimit, hosts = {} }) {
  const all = [...checks];
  if (requests >= limit + 1 || refused > 0) {
    all.push({ source: 'Request budget', ok: false, detail: requests + ' requests, ' + refused + ' refused; limit ' + limit });
  }
  const failures = all.filter(check => !check.ok).map(check => check.source);
  return { ok: failures.length === 0, checkedAt, requests, hosts, failures, checks: all };
}

export async function runCanary({ now = new Date(), label = randomLabel() } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'domain-hound-canary-'));
  const directory = pathToFileURL(folder + sep);
  const fetcher = countingFetch(globalThis.fetch);
  const options = {
    directory, now, fetcher, env: {}, cachedOnly: true,
    resolveNs: async domain => {
      await fetcher.take('DNS');
      return systemResolveNs(domain);
    },
    queryWhois: async (host, query, timeout) => {
      if (timeout <= 0) return '';
      await fetcher.take(host);
      return systemQueryWhois(host, query, timeout);
    },
  };
  try {
    const checks = [];
    const refresh = await refreshPrices(options).catch(() => null);
    checks.push(...priceChecks(refresh, now));
    const result = await agentResult([label, 'google.com'], { ...options, endings: registryEndings })
      .catch(error => ({ error: error.message }));
    checks.push(...registryChecks(result, label, { now }));
    const triage = await triageNames([famousName], { ...options, endings: ['com'], playBudgetMs: 0, budgetMs: 6500 })
      .catch(() => null);
    const autocomplete = await readCache(directory, 'google-autocomplete-' + famousName.toLowerCase() + '.json');
    checks.push(...nameChecks({ triage, suggestions: autocomplete?.value }));
    return summarize(checks, { checkedAt: now.toISOString(), requests: fetcher.count, refused: fetcher.refused, hosts: fetcher.hosts });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const summary = await runCanary();
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) {
    for (const source of summary.failures) console.error('Canary: ' + source + ' broken');
    process.exitCode = 1;
  }
}
