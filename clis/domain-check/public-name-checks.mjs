import { parse, parseFragment } from 'parse5';

export const publicCheckTiming = Object.freeze({ budgetMs: 3000, timeoutMs: 1400, pageTimeoutMs: 2400, ttlMs: 3_600_000 });
export const publicHtmlLimit = 4_000_000;
export const publicPageKinds = Object.freeze(['youtube', 'threads', 'googlePlay']);
export const publicProfileKinds = Object.freeze(['youtube', 'instagram', 'x', 'tiktok', 'threads']);
export const embedKinds = Object.freeze([...publicProfileKinds.filter(kind => kind !== 'youtube'), 'googlePlay']);

const embedUrl = (endpoint, profile) => endpoint + '?' + new URLSearchParams({ url: profile });
export const playSearchLink = name => 'https://play.google.com/store/search?' +
  new URLSearchParams({ q: name, c: 'apps', hl: 'en', gl: 'US' });
export const validPlayName = name => typeof name === 'string' && name.length > 0 && name.length <= 100 &&
  /[\p{L}\p{N}]/u.test(name) && !/[\p{Cc}\p{Cf}]/u.test(name);
export const playCacheName = name => name.trim().replace(/\s+/gu, ' ').toLowerCase();
const exactAppName = name => name.replace(/\s+/gu, '').toLowerCase();

export const publicUrls = Object.freeze({
  tiktok: handle => embedUrl('https://www.tiktok.com/oembed', 'https://www.tiktok.com/@' + handle),
  instagram: handle => embedUrl('https://graph.facebook.com/v22.0/instagram_oembed', 'https://www.instagram.com/' + handle + '/'),
  x: handle => embedUrl('https://publish.twitter.com/oembed', 'https://x.com/' + handle),
  youtube: handle => 'https://www.youtube.com/@' + handle,
  threads: handle => 'https://www.threads.net/@' + handle,
  googlePlay: playSearchLink,
});

const jsonType = /^application\/(?:[\w.+-]+\+)?json\b/i;
const htmlType = /^text\/html\b/i;
const readsJson = (kind, type) => jsonType.test(type) || (kind === 'instagram' && /^text\/javascript\b/i.test(type));
export const readsPublicBody = (kind, status, type) => readsJson(kind, type) ||
  (!['tiktok', 'instagram'].includes(kind) && (status === 200 || status === 404) && htmlType.test(type));

// A Threads title and YouTube's profile metadata are sufficient evidence on a successful page.
export function publicBodyComplete(kind, status, type, body, name) {
  if (status !== 200 || !htmlType.test(type)) return false;
  if (kind === 'threads') return body.includes('</title>');
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
  if (cards.some(card => exactAppName(card.name) === exactAppName(query))) return 'taken';
  return cards.length && !incomplete ? 'not-found' : 'unknown';
}

function titleOf(html) {
  const raw = html.match(/<title\b[^>]*>([^<]{1,400})<\/title>/i)?.[1];
  // The title is RCDATA, so decoding entities must not interpret its contents as markup.
  return raw ? text(parseFragment('<title>' + raw + '</title>')).trim() : '';
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
        if (title === 'Threads • Log in') return 'not-found';
        const marker = ' (@' + name + ') • Threads';
        const at = title.toLowerCase().indexOf(marker.toLowerCase());
        if (at > 0 && /^[,\s]?$/.test(title.charAt(at + marker.length))) return 'taken';
      }
      break;
    case 'googlePlay':
      if (status === 200 && html) return classifyPlay(html, name);
      break;
  }
  return 'unknown';
}

export const publicHeaders = Object.freeze({ 'accept-language': 'en-US,en;q=0.9' });
