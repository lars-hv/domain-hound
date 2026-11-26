import { parse, parseFragment } from 'parse5';

export const publicCheckTiming = Object.freeze({ budgetMs: 3000, timeoutMs: 1400, archiveTimeoutMs: 900, pageTimeoutMs: 2400, ttlMs: 3_600_000 });
export const publicHtmlLimit = 4_000_000;
export const archiveKinds = Object.freeze(['linkedin', 'reddit']);
export const publicPageKinds = Object.freeze(['youtube', 'threads', 'twitch', 'googlePlay']);
export const publicProfileKinds = Object.freeze(['youtube', 'instagram', 'x', 'tiktok', 'threads', 'facebook', 'twitch', ...archiveKinds]);
export const embedKinds = Object.freeze([...publicProfileKinds.filter(kind => kind !== 'youtube'), 'googlePlay']);

// Expire decisions made by the old Threads and Google Play classifiers.
export const publicCacheKind = kind => ['threads', 'googlePlay'].includes(kind) ? kind + '-v2' : kind;
const archiveProfile = (kind, handle) => (kind === 'linkedin' ? 'linkedin.com/company/' : 'reddit.com/user/') + handle;
export const archiveLabel = year => `Found · seen ${year}`;
export const threadsFromInstagram = (threads, instagram) => instagram?.state === 'not-found'
  ? { state: 'not-found', why: 'no Instagram account', checkedAt: instagram.checkedAt } : threads;

const embedUrl = (endpoint, profile) => endpoint + '?' + new URLSearchParams({ url: profile });
export const playSearchLink = name => 'https://play.google.com/store/search?' +
  new URLSearchParams({ q: name, c: 'apps', hl: 'en', gl: 'US' });
export const validPlayName = name => typeof name === 'string' && name.length > 0 && name.length <= 100 &&
  /[\p{L}\p{N}]/u.test(name) && !/[\p{Cc}\p{Cf}]/u.test(name);
export const playCacheName = name => name.trim().replace(/\s+/gu, ' ').toLowerCase();
export function playTitleMatches(name, title) {
  const query = playCacheName(name);
  const candidate = playCacheName(title);
  return candidate.replaceAll(' ', '') === query.replaceAll(' ', '') ||
    (candidate.startsWith(query) && /^[^\p{L}]/u.test(candidate.slice(query.length)));
}

export const publicUrls = Object.freeze({
  tiktok: handle => embedUrl('https://www.tiktok.com/oembed', 'https://www.tiktok.com/@' + handle),
  instagram: handle => embedUrl('https://graph.facebook.com/v22.0/instagram_oembed', 'https://www.instagram.com/' + handle + '/'),
  x: handle => embedUrl('https://publish.twitter.com/oembed', 'https://x.com/' + handle),
  youtube: handle => 'https://www.youtube.com/@' + handle,
  threads: handle => 'https://www.threads.net/@' + handle,
  facebook: handle => 'https://graph.facebook.com/' + handle + '/picture?redirect=false',
  twitch: handle => 'https://www.twitch.tv/' + handle,
  googlePlay: playSearchLink,
});

const jsonType = /^application\/(?:[\w.+-]+\+)?json\b/i;
const htmlType = /^text\/html\b/i;
const readsJson = (kind, type) => jsonType.test(type) ||
  (['instagram', 'facebook'].includes(kind) && /^text\/javascript\b/i.test(type));
export const readsPublicBody = (kind, status, type) => readsJson(kind, type) ||
  (!['tiktok', 'instagram'].includes(kind) && (status === 200 || status === 404) && htmlType.test(type));

// Stop reading once a successful page has supplied the evidence it needs.
export function publicBodyComplete(kind, status, type, body, name) {
  if (status !== 200 || !htmlType.test(type)) return false;
  if (kind === 'threads') return body.includes('</title>');
  if (kind === 'twitch') return body.includes('</head>');
  return kind === 'youtube' && body.includes('<meta property="og:type" content="profile">') &&
    classifyPublicCheck(kind, { status, contentType: type, body }, name) === 'taken';
}
const text = node => node.nodeName === '#text' ? node.value : (node.childNodes ?? []).map(text).join('');
const attr = (node, name) => node.attrs?.find(entry => entry.name === name)?.value;
const hasClass = (node, value) => (attr(node, 'class') ?? '').split(/\s+/).includes(value);

function* elements(node) {
  for (const child of node.childNodes ?? []) {
    if (!child.tagName || ['script', 'style', 'template', 'svg'].includes(child.tagName)) continue;
    yield child;
    yield* elements(child);
  }
}

function playCards(document, query) {
  const cards = [];
  let empty = false;
  let incomplete = false;
  const emptyMessage = 'no results for ' + playCacheName(query);
  for (const node of elements(document)) {
    if (['h1', 'h2', 'h3', 'span', 'p'].includes(node.tagName) && !empty && playCacheName(text(node)) === emptyMessage) {
      empty = true;
    }
    const href = node.tagName === 'a' ? attr(node, 'href') : null;
    if (!href?.startsWith('/store/apps/details?id=')) continue;
    const featured = hasClass(node, 'Qfxief');
    const find = (root, className) => {
      for (const child of elements(root)) if (hasClass(child, className)) return text(child);
      return '';
    };
    const id = new URL(href, 'https://play.google.com').searchParams.get('id');
    const name = featured ? attr(node, 'aria-label') : find(node, 'DdYX5');
    const seller = featured ? find(node.parentNode, 'LbQbAe') : find(node, 'wMUdtb');
    if (name?.trim() && id) cards.push({ name, seller, id });
    else incomplete = true;
  }
  return { cards, empty, incomplete };
}

export function parsePlayCards(document, query) {
  const { cards, empty } = playCards(document, query);
  const detailed = cards.filter(card => card.seller);
  return empty ? [] : detailed.length ? detailed : null;
}

function classifyPlay(html, query) {
  const document = parse(html);
  const head = document.childNodes.find(node => node.tagName === 'html')?.childNodes.find(node => node.tagName === 'head');
  const title = head?.childNodes.find(node => node.tagName === 'title');
  if (!title || playCacheName(text(title)) !== playCacheName(query + ' - Android Apps on Google Play')) return 'unknown';
  const { cards, empty, incomplete } = playCards(document, query);
  if (empty) return 'not-found';
  if (cards.some(card => playTitleMatches(query, card.name))) return 'taken';
  return cards.length && !incomplete ? 'not-found' : 'unknown';
}

function titleOf(html) {
  const raw = html.match(/<title\b[^>]*>([^<]{1,400})<\/title>/i)?.[1];
  // The title is RCDATA, so decoding entities must not interpret its contents as markup.
  return raw ? text(parseFragment('<title>' + raw + '</title>')).trim() : '';
}

function twitchProfile(html, name) {
  const head = parse(html).childNodes.find(node => node.tagName === 'html')?.childNodes.find(node => node.tagName === 'head');
  const meta = new Map(head?.childNodes.filter(node => node.tagName === 'meta')
    .map(node => [attr(node, 'property'), attr(node, 'content')]));
  const title = meta.get('og:title');
  const username = meta.get('og:profile:username');
  if (title && /^.+ - Twitch$/.test(title) && (!username || username.toLowerCase() === name)) return 'taken';
  const pageTitle = head?.childNodes.find(node => node.tagName === 'title');
  // Twitch also serves a generic homepage shell for existing channels. Require metadata for the requested URL.
  if (!username && (!title || title === 'Twitch') && meta.get('og:site_name') === 'Twitch' &&
    pageTitle && text(pageTitle).trim() === 'Twitch' &&
    profileUrlMatches(meta.get('og:url'), ['www.twitch.tv'], '/' + name)) return 'not-found';
  return 'unknown';
}

function profileUrlMatches(value, hosts, path) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
      hosts.includes(url.hostname) && url.pathname.replace(/\/$/, '').toLowerCase() === path;
  } catch {
    return false;
  }
}

// Allow only the observed cross-host redirects. No credentials, query changes or redirects to login pages.
export async function fetchPublicCheck(fetcher, url, init) {
  const response = await fetcher(url, { ...init, redirect: 'manual' });
  if (![301, 302, 303, 307, 308].includes(response.status)) return response;
  const original = new URL(url);
  const host = { 'publish.twitter.com': 'publish.x.com', 'www.threads.net': 'www.threads.com' }[original.hostname];
  let next;
  try { next = new URL(response.headers.get('location') ?? '', original); } catch { return response; }
  if (!host || next.origin !== 'https://' + host || next.username || next.password || next.hash ||
    next.pathname !== original.pathname || next.search !== original.search) return response;
  void response.body?.cancel().catch(() => {});
  return fetcher(next.href, { ...init, redirect: 'manual' });
}

export function classifyPublicCheck(kind, { status, contentType, body }, name) {
  const json = readsJson(kind, contentType);
  const html = htmlType.test(contentType) && typeof body === 'string' ? body : '';
  let data;
  if (json && [200, 400].includes(status)) {
    try { data = JSON.parse(body); } catch { return 'unknown'; }
  }
  switch (kind) {
    case 'tiktok':
      if (status === 200 && data?.provider_name === 'TikTok' && data.type === 'rich' && data.embed_type === 'profile' &&
        typeof data.embed_product_id === 'string' && data.embed_product_id.toLowerCase() === name && typeof data.html === 'string' &&
        profileUrlMatches(data.author_url, ['www.tiktok.com'], '/@' + name)) return 'taken';
      if (status === 400 && data?.code === 400 && data.message === 'Something went wrong') return 'not-found';
      break;
    case 'instagram': {
      const permalink = typeof data?.html === 'string' && data.html.match(/\bdata-instgrm-permalink="([^"]+)"/i)?.[1];
      if (status === 200 && data?.provider_name === 'Instagram' && data.type === 'rich' &&
        profileUrlMatches(permalink, ['www.instagram.com'], '/' + name)) return 'taken';
      if (status === 400 && data?.error?.type === 'OAuthException' && data.error.code === 24 &&
        data.error.error_subcode === 2207045 && data.error.is_transient === false &&
        data.error.message === 'The requested resource does not exist') return 'not-found';
      break;
    }
    case 'x':
      if (status === 200 && ['X', 'Twitter'].includes(data?.provider_name) && data.type === 'rich' &&
        typeof data.html === 'string' && /\bclass="twitter-timeline"/.test(data.html) &&
        profileUrlMatches(data.url, ['x.com', 'twitter.com'], '/' + name)) return 'taken';
      if (status === 404 && html && ['X / ?', 'Twitter / ?'].includes(titleOf(html)) &&
        /<h1 id="header">Nothing to see here<\/h1>/i.test(html)) return 'not-found';
      break;
    case 'youtube':
      if (status === 200 && html && /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/UC[\w-]{22}">/.test(html) &&
        /<meta property="og:type" content="profile">/.test(html) &&
        ['www', 'm'].some(host => html.toLowerCase().includes('href="https://' + host + '.youtube.com/@' + name + '"'))) return 'taken';
      if (status === 404 && html && titleOf(html) === '404 Not Found' &&
        /<iframe\b[^>]*\bsrc="\/error\?src=404&amp;ifr=1&amp;error="/i.test(html)) return 'not-found';
      break;
    case 'threads':
      if (status === 200 && html) {
        const title = titleOf(html);
        const marker = ' (@' + name + ') • Threads';
        const at = title.toLowerCase().indexOf(marker.toLowerCase());
        if (at > 0 && /^[,\s]?$/.test(title.charAt(at + marker.length))) return 'taken';
      }
      break;
    case 'facebook':
      if (status === 200 && typeof data?.data?.url === 'string' && typeof data.data.is_silhouette === 'boolean') return 'taken';
      if (status === 400 && data?.error?.type === 'GraphMethodException' && data.error.code === 100 &&
        data.error.error_subcode === 33 && typeof data.error.message === 'string' &&
        data.error.message.startsWith(`Unsupported get request. Object with ID '${name}' does not exist`)) {
        return 'not-found';
      }
      break;
    case 'twitch':
      if (status === 200 && html) return twitchProfile(html, name);
      break;
    case 'googlePlay':
      if (status === 200 && html) return classifyPlay(html, name);
      break;
  }
  return 'unknown';
}

export const publicHeaders = Object.freeze({ 'accept-language': 'en-US,en;q=0.9', 'accept-encoding': 'gzip' });

const commonCrawlCollections = 'https://index.commoncrawl.org/collinfo.json';
const archiveJson = /^(?:application\/(?:[\w.+-]+\+)?json|(?:application|text)\/x-ndjson)\b/i;
const plainText = /^text\/plain\b/i;
export const readsArchiveBody = (status, type) => [200, 404].includes(status) && (archiveJson.test(type) || plainText.test(type));
const captureYear = timestamp => typeof timestamp === 'string' && /^(?:19|20)\d{12}$/.test(timestamp) ? Number(timestamp.slice(0, 4)) : null;
const archiveUnknown = response => ({ state: 'unknown', why: response.skipped ?? (response.error === 'timeout' ? 'timeout'
  : response.status === 429 ? 'rate-limited' : 'archive lookup failed') });

function readArchive(response, provider, profile) {
  const { status, contentType, body } = response;
  if (response.skipped || response.error || typeof body !== 'string') return archiveUnknown(response);
  const value = body.trim();
  if (provider === 'wayback' && status === 200 && plainText.test(contentType)) {
    if (!value) return { state: 'not-seen' };
    const year = captureYear(value.match(/^(\d{14})\s+200$/)?.[1]);
    if (year) return { state: 'taken', seenYear: year };
  }
  if (provider === 'commonCrawl' && archiveJson.test(contentType)) {
    if (status === 200 && !value) return { state: 'not-seen' };
    try {
      const row = JSON.parse(value);
      if (status === 404 && row?.message === `No Captures found for: ${profile}`) return { state: 'not-seen' };
      const year = captureYear(row?.timestamp);
      const url = new URL(row?.url);
      const archived = url.hostname.replace(/^www\./, '') + url.pathname.replace(/\/$/, '');
      if (status === 200 && String(row.status) === '200' && year && ['https:', 'http:'].includes(url.protocol) &&
        !url.username && !url.password && !url.port && !url.search && archived.toLowerCase() === profile) return { state: 'taken', seenYear: year };
    } catch { /* A malformed capture is not evidence. */ }
  }
  return archiveUnknown(response);
}

export async function findCommonCrawlIndex(request) {
  const response = await request(commonCrawlCollections);
  if (response.status === 200 && archiveJson.test(response.contentType) && !response.error) {
    try {
      const index = JSON.parse(response.body)?.[0]?.['cdx-api'];
      if (/^https:\/\/index\.commoncrawl\.org\/CC-MAIN-\d{4}-\d{2}-index$/.test(index)) return { index };
    } catch { /* Ignore unrecognized collections. */ }
  }
  return archiveUnknown(response);
}

export async function checkPublicArchives(kind, handle, request, getCommonIndex) {
  const profile = archiveProfile(kind, handle);
  const wayback = await request('https://web.archive.org/cdx/search/cdx?' + new URLSearchParams({
    url: profile, limit: '1', fl: 'timestamp,statuscode', filter: 'statuscode:200',
  })).then(response => readArchive(response, 'wayback', profile));
  if (wayback.state !== 'unknown') return wayback;
  const { index } = await getCommonIndex();
  if (!index) return wayback;
  const common = await request(index + '?' + new URLSearchParams({
    url: profile, output: 'json', limit: '1', filter: '=status:200',
  })).then(response => readArchive(response, 'commonCrawl', profile));
  return common.state === 'unknown' ? wayback : common;
}
