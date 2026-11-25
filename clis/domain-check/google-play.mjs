import { cacheDir, mapLimit, readCache, writeCache } from './cache.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { withShopPages } from './confirm.mjs';
import { appNameMatches, compactText, day, request } from './triage-sources.mjs';

const origin = 'https://play.google.com';
const maxHtmlBytes = 4_000_000;

export function playSearchLink(input) {
  return origin + '/store/search?' + new URLSearchParams({ q: input, c: 'apps', hl: 'en', gl: 'US' });
}

export function readPlayCards(query) {
  // Google's featured and compact cards have different markup.
  const emptyMessage = ('No results for ' + query).replace(/\s+/g, ' ').toLowerCase();
  if ([...document.querySelectorAll('h1, h2, h3, span, p')].some(node =>
    node.textContent.replace(/\s+/g, ' ').trim().toLowerCase() === emptyMessage)) return [];
  const links = [...document.querySelectorAll('a[href^="/store/apps/details?id="]')];
  const rows = links.flatMap(link => {
    const featured = link.matches('.Qfxief');
    const name = featured ? link.getAttribute('aria-label') : link.querySelector('.DdYX5')?.textContent;
    const seller = featured ? link.parentElement.querySelector('.LbQbAe')?.textContent
      : link.querySelector('.wMUdtb')?.textContent;
    const id = new URL(link.href).searchParams.get('id');
    return name && seller && id ? [{ name, seller, id }] : [];
  });
  return rows.length ? rows : null;
}

export function readPlayDetails(html, url) {
  const website = html.match(/<a\b[^>]*aria-label=["']Website\s[^>]*>/i)?.[0];
  const sellerUrl = website?.match(/\bhref=["'](https?:\/\/[^"']+)["']/i)?.[1]?.replaceAll('&amp;', '&');
  const seller = sellerUrl ? { sellerUrl: compactText(sellerUrl, 200) } : {};
  for (const match of html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const app = JSON.parse(match[1]);
      if (app['@type'] !== 'SoftwareApplication' ||
        new URL(app.url).searchParams.get('id') !== new URL(url).searchParams.get('id')) continue;
      const count = app.aggregateRating?.ratingCount;
      const ratings = /^\d+$/.test(count) && Number.isSafeInteger(Number(count)) ? Number(count) : null;
      return { ratings, category: compactText(app.applicationCategory, 45), description: compactText(app.description, 650), ...seller };
    } catch { /* Ignore malformed structured data. */ }
  }
  return { ratings: null, ...seller };
}

// Server-rendered fallback for installs without Chromium. It mirrors readPlayCards on a parse5 tree.
export function parsePlayCards(document, query) {
  const nodes = [];
  const walk = node => {
    for (const child of node.childNodes ?? []) {
      if (child.tagName) nodes.push(child);
      walk(child);
    }
  };
  walk(document);
  const attribute = (node, name) => node.attrs.find(attr => attr.name === name)?.value;
  const hasClass = (node, name) => (attribute(node, 'class') ?? '').split(/\s+/).includes(name);
  const text = node => node.nodeName === '#text' ? node.value : (node.childNodes ?? []).map(text).join('');
  const find = (node, name) => {
    for (const child of node.childNodes ?? []) {
      if (child.tagName && hasClass(child, name)) return child;
      const found = child.tagName && find(child, name);
      if (found) return found;
    }
    return null;
  };
  const clean = value => value.replace(/\s+/g, ' ').trim();
  const emptyMessage = clean('No results for ' + query).toLowerCase();
  if (nodes.some(node => ['h1', 'h2', 'h3', 'span', 'p'].includes(node.tagName) &&
    clean(text(node)).toLowerCase() === emptyMessage)) return [];
  const rows = nodes.flatMap(link => {
    const href = link.tagName === 'a' ? attribute(link, 'href') : null;
    if (!href?.startsWith('/store/apps/details?id=')) return [];
    const featured = hasClass(link, 'Qfxief');
    const nameNode = featured ? null : find(link, 'DdYX5');
    const name = featured ? attribute(link, 'aria-label') : nameNode && text(nameNode);
    const sellerNode = featured ? link.parentNode?.tagName && find(link.parentNode, 'LbQbAe') : find(link, 'wMUdtb');
    const seller = sellerNode ? text(sellerNode) : null;
    const id = new URL(href, origin).searchParams.get('id');
    return name && seller && id ? [{ name, seller, id }] : [];
  });
  return rows.length ? rows : null;
}

async function readBounded(response) {
  if (!response.ok || Number(response.headers?.get('content-length')) > maxHtmlBytes || !response.body) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxHtmlBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function fetchSource(parse, options) {
  const get = (url, timeout) => request(url, options, { timeout, headers: { 'Accept-Language': 'en-US,en;q=0.9' } })
    .then(readBounded);
  return {
    async search(input, remaining) {
      const html = await get(playSearchLink(input), remaining());
      return html === null ? null : parsePlayCards(parse(html), input);
    },
    details: get,
  };
}

function browserSource(page) {
  return {
    async search(input, remaining) {
      const response = await page.goto(playSearchLink(input), { waitUntil: 'domcontentloaded', timeout: remaining() });
      const { origin: base, pathname } = new URL(page.url());
      if (!response?.ok() || base !== origin || pathname !== '/store/search') return null;
      const result = await page.waitForFunction(readPlayCards, input, { timeout: remaining() });
      return result.jsonValue();
    },
    async details(url, timeout) {
      const response = await page.request.get(url, { timeout, maxRedirects: 0 });
      try {
        return response.ok() ? await response.text() : null;
      } finally { await response.dispose(); }
    },
    close: () => page.close().catch(() => {}),
  };
}

async function lookUp(source, name, input, deadline) {
  const remaining = () => Math.max(1, Math.floor(deadline - performance.now()));
  const rows = await source.search(input, remaining);
  if (rows === null) return null;
  const matches = rows.flatMap(row => {
    if (!/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(row.id) || !appNameMatches(name, row.name)) return [];
    return [{ name: compactText(row.name, 70), seller: compactText(row.seller, 70),
      url: origin + '/store/apps/details?id=' + row.id }];
  });
  return mapLimit([...new Map(matches.map(row => [row.url, row])).values()], 3, async row => {
    try {
      const html = await source.details(row.url + '&hl=en&gl=US', Math.min(1500, remaining()));
      if (html !== null) return { ...row, ...readPlayDetails(html, row.url) };
    } catch { /* An exact-name match remains useful without rating data. */ }
    return { ...row, ratings: null };
  });
}

// Leave room for a retry on slow pages or failed connections within the shared clock.
const playAttemptMs = 2800;

export async function searchAndroidApps(names, options = {}) {
  const { directory = cacheDir, now = new Date(), playBudgetMs = 12000, cacheLifetime = day } = options;
  const budget = Math.min(30000, playBudgetMs);
  const deadline = performance.now() + budget;
  const retryMs = Math.min(playAttemptMs, budget / 2);
  const answered = (name, apps) => { results.set(name, apps); options.onResult?.(name, apps); };
  const results = new Map();
  const pending = (await Promise.all([...names].map(async ([name, input]) => {
    const filename = 'triage-play-' + name + '.json';
    const prior = await readCache(directory, filename);
    const age = now.getTime() - prior?.at;
    if (age >= 0 && age < cacheLifetime && Array.isArray(prior.apps) && prior.apps.every(app => Object.hasOwn(app, 'ratings')) && (!prior.apps.length || prior.version === 2)) {
      answered(name, prior.apps);
      return null;
    }
    return { name, input, filename };
  }))).filter(Boolean);
  const waits = budget < 1600 ? [0, 0] : [0, 350, 1200];
  const search = useSource => mapLimit(pending, 5, async ({ name, input, filename }) => {
    if (performance.now() >= deadline) return;
    for (const pause of waits) {
      if (options.signal?.aborted || deadline - performance.now() < (pause ? retryMs + pause : 1)) break;
      if (pause) await delay(pause);
      let source;
      try {
        source = await useSource();
        const apps = await lookUp(source, name, input, Math.min(deadline, performance.now() + 8000));
        if (apps === null || performance.now() >= deadline) continue;
        answered(name, apps);
        await writeCache(directory, filename, { at: now.getTime(), apps, version: 2 }).catch(() => {});
        return;
      } catch { /* An unavailable search gives no evidence about the name. */ }
      finally { await source?.close?.(); }
    }
  });
  if (pending.length && performance.now() < deadline) {
    // The public search response includes the cards. A normal lookup needs no browser or page assets.
    let browserFailed = !options.launch;
    if (options.launch) {
      let browserReady = false;
      await withShopPages(deadline, async (_, openPage) => {
        browserReady = true;
        await search(async () => browserSource(await openPage()));
      }, { ...options, onFailure: () => { browserFailed = !browserReady; return null; } });
    }
    if (browserFailed && performance.now() < deadline) {
      const parse = await import('parse5').then(module => module.parse, () => null);
      if (parse) await search(() => fetchSource(parse, options));
    }
  }
  return new Map(results);
}
