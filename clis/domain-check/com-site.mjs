import { Resolver } from 'node:dns/promises';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { anySignal } from './cache.mjs';

const maxBytes = 200_000;
const restricted = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) restricted.addSubnet(address, prefix);
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  restricted.addSubnet(address, prefix, 'ipv6');
}
const globalIpv6 = new BlockList();
globalIpv6.addSubnet('2000::', 3, 'ipv6');

export function publicAddress({ address, family }) {
  return family === 4 ? !restricted.check(address)
    : globalIpv6.check(address, 'ipv6') && !restricted.check(address, 'ipv6');
}

const timeoutCodes = new Set(['ETIMEOUT', 'ETIMEDOUT', 'ECANCELLED', 'ABORT_ERR']);
// A check that ran out of time is unknown, never "no site": a slow server is not a missing one.
const unanswered = { state: 'unknown', why: 'no answer in time' };

export function lookupPublic(signal) {
  const hosts = new Map();
  return (host, options, done) => {
    if (signal.aborted) return done(new Error('Site lookup timed out'));
    const key = host + ':' + (options.family || 0);
    if (!hosts.has(key)) hosts.set(key, resolvePublic(host, options.family, signal));
    hosts.get(key).then(usable => {
      if (options.all) done(null, usable);
      else done(null, usable[0].address, usable[0].family);
    }, done);
  };
}

async function resolvePublic(host, family, signal) {
  const resolver = new Resolver({ timeout: 950, tries: 1 });
  const cancel = () => resolver.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  const families = family ? [family] : [4, 6];
  const errors = [];
  const results = await Promise.all(families.map(async family => {
    const addresses = await (family === 4 ? resolver.resolve4(host) : resolver.resolve6(host)).catch(error => {
      errors.push(error?.code);
      return [];
    });
    return addresses.map(address => ({ address, family })).filter(publicAddress);
  })).finally(() => signal.removeEventListener('abort', cancel));
  const usable = results.flat();
  if (usable.length) return usable;
  // An NXDOMAIN applies to the hostname, even if the other address-family query did not answer.
  if (!errors.includes('ENOTFOUND') && errors.some(code => timeoutCodes.has(code))) {
    throw Object.assign(new Error('DNS lookup timed out'), { code: 'ETIMEOUT' });
  }
  throw new Error('No public address');
}

const saleHosts = ['sedo.com', 'sedoparking.com', 'afternic.com', 'dan.com', 'hugedomains.com', 'atom.com', 'squadhelp.com'];
const parkingHosts = ['parkingcrew.net', 'bodis.com', 'above.com', 'parklogic.com', 'parked.com', 'parking-page.net'];
const hasHost = (host, choices) => choices.some(name => host === name || host.endsWith('.' + name));
const saleText = /\b(?:this domain (?:name )?(?:may be|is) for sale|buy this domain(?: name)?|buy this domain on (?:sedo|afternic|dan\.com)|domain (?:for sale|is listed for sale))\b/i;
const parkedText = /\b(?:this (?:domain|web page) is parked|domain parking(?: page)?|parked (?:free|by|with|courtesy of|domain)|website coming soon)\b/i;
const errorText = /^(?:403|404|503|access denied|just a moment|site not found|domain not configured|not found)\b/i;

function decodeText(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? match;
    const point = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return point <= 0x10ffff ? String.fromCodePoint(point) : match;
  }).replace(/[\s\u202a-\u202e\u2066-\u2069]+/g, ' ').trim();
}

export function classifyComSite({ url, status, contentType, lastModified, body = '' } = {}, detailed = false) {
  const host = url ? new URL(url).hostname : '';
  if (hasHost(host, saleHosts) || (hasHost(host, ['godaddy.com']) && /\/forsale(?:\/|$)/i.test(new URL(url).pathname))) {
    return { state: 'for-sale' };
  }
  if (hasHost(host, parkingHosts)) return { state: 'parked' };
  if (!(status >= 200 && status < 300) || !/^text\/html\b|^application\/xhtml\+xml\b/i.test(contentType) || !body) {
    return { state: 'no-site' };
  }

  // A script-only page that sends visitors to /lander is a registrar parking page.
  if (/^\s*(?:<!doctype html>)?\s*<html>\s*<head>\s*<script>[^<]*location(?:\.href)?\s*=\s*["']\/lander["'][^<]*<\/script>\s*<\/head>\s*<\/html>\s*$/i.test(body)) {
    return { state: 'parked' };
  }
  const html = body.replace(/<!--[\s\S]*?(?:-->|$)|<(script|style|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ');
  const title = decodeText(html.match(/<title\b[^>]*>([^<]*)<\/title\s*>/i)?.[1] ?? '').slice(0, 140);
  const text = decodeText(html.replace(/<[^>]*>/g, ' '));
  if (saleText.test(text)) return { state: 'for-sale' };
  if (parkedText.test(text) || (detailed && /^(?:domain )?parking page$/i.test(title))) return { state: 'parked' };
  if (!text || errorText.test(title)) return { state: 'no-site' };
  if (detailed) {
    const meta = [...html.matchAll(/<meta\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)].map(match =>
      Object.fromEntries([...match[1].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
        .map(([, key, double, single, bare]) => [key.toLowerCase(), double ?? single ?? bare])));
    const description = meta.find(tag => tag.name?.toLowerCase() === 'description')?.content
      || meta.find(tag => tag.property?.toLowerCase() === 'og:description')?.content;
    // The newest year next to a copyright sign; a stale year is one dormant-site signal.
    const years = [...text.matchAll(/(?:©|\(c\)|copyright)\s*(?:[^\d\s]{0,3}\s*)?(?:(?:19|20)\d{2}\s*[-–]\s*)?((?:19|20)\d{2})/gi)]
      .map(match => Number(match[1]));
    const modified = Date.parse(lastModified);
    return { state: 'live', title, description: decodeText(description ?? '').slice(0, 300), host,
      ...(years.length && { copyright: Math.max(...years) }),
      ...(Number.isFinite(modified) && { lastModified: new Date(modified).getUTCFullYear() }) };
  }
  return { state: 'live', ...(title && { title }) };
}

function load(url, signal, lookup) {
  return new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsGet : httpGet;
    request(url, { lookup, signal, agent: false, autoSelectFamilyAttemptTimeout: 700,
      headers: { Accept: 'text/html, application/xhtml+xml', 'User-Agent': 'DomainHound/0.1 (+https://domainhound.dev)' } }, response => {
      const { statusCode: status, headers } = response;
      const contentType = headers['content-type'];
      const location = [301, 302, 303, 307, 308].includes(status) ? headers.location : null;
      if (location || !(status >= 200 && status < 300) || !/^text\/html\b|^application\/xhtml\+xml\b/i.test(contentType)) {
        resolve({ status, contentType, location });
        response.destroy();
        return;
      }
      const chunks = [];
      let size = 0;
      function finish() {
        resolve({ status, contentType, lastModified: headers['last-modified'], body: Buffer.concat(chunks).toString('utf8') });
      }
      response.on('data', chunk => {
        const part = chunk.subarray(0, maxBytes - size);
        chunks.push(part);
        size += part.length;
        if (size >= maxBytes) {
          finish();
          response.destroy();
        }
      });
      response.on('end', finish);
      response.on('error', reject);
    }).on('error', reject);
  });
}

async function visit(url, signal, detailed, lookup) {
  try {
    for (let hops = 0; hops <= 5; hops++) {
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
          isIP(url.hostname) || url.hostname.startsWith('[') || !url.hostname.includes('.')) break;
      const obvious = classifyComSite({ url }, detailed);
      if (obvious.state !== 'no-site') return obvious;
      const response = await load(url, signal, lookup);
      if (!response.location) return classifyComSite({ url, ...response }, detailed);
      url = new URL(response.location, url);
    }
  } catch (error) {
    // The site did not respond within the public lookup. A refused or missing host is no site; a timeout is unknown.
    if (signal.aborted || timeoutCodes.has(error?.code) || error?.name === 'AbortError') return { ...unanswered };
  }
  return { state: 'no-site' };
}

const settled = site => site.state !== 'no-site' && site.state !== 'unknown';

export async function checkDomainSite(domain, timeout = 5000, detailed = false) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z]{2,}(?:\.[a-z]{2,})?$/.test(domain)) return { state: 'no-site' };
  const deadline = performance.now() + timeout;
  const first = await probeSite(domain, Math.min(timeout, 4200), detailed);
  if (first.state !== 'unknown' || timeout < 2000 || deadline - performance.now() < 700) return first;
  await delay(300);
  return probeSite(domain, Math.max(1, Math.floor(deadline - performance.now())), detailed);
}

async function probeSite(domain, timeout, detailed) {
  const controller = new AbortController();
  const signal = anySignal([controller.signal, AbortSignal.timeout(timeout)]);
  const lookup = lookupPublic(signal);
  const https = visit(new URL('https://' + domain), signal, detailed, lookup);
  if (/\.(?:app|dev)$/.test(domain)) return https;
  const http = visit(new URL('http://' + domain), signal, detailed, lookup);
  const first = await Promise.race([http, https]);
  if (settled(first)) {
    controller.abort();
    return first;
  }
  const [secure, plain] = await Promise.all([https, http]);
  if (settled(secure)) return secure;
  if (settled(plain)) return plain;
  return secure.state === 'unknown' || plain.state === 'unknown' ? { ...unanswered } : { state: 'no-site' };
}

export const checkComSite = checkDomainSite;
