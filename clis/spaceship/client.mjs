import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

// First-party Spaceship REST API: https://docs.spaceship.dev
// Every request sends X-API-Key and X-API-Secret, JSON bodies, and refuses redirects.
export const spaceshipBase = 'https://spaceship.dev/api';
export const keychainService = 'domain-hound';
export const keychainAccounts = { key: 'spaceship-key', secret: 'spaceship-secret' };

// The smallest Spaceship API scopes each tool needs.
export const scopes = {
  quote: ['domains:read'],
  buy: ['domains:read'],
  setup: ['domains:read', 'dnsrecords:read', 'dnsrecords:write'],
};

// One short instruction per tool when no key is set. It never asks for the secret in chat.
export function missingKeyText(tool) {
  return 'No Spaceship API key found. In Spaceship, create a key with only ' + scopes[tool].join(', ')
    + '. Then set DOMAIN_HOUND_SPACESHIP_KEY and DOMAIN_HOUND_SPACESHIP_SECRET for the MCP server, or store both in the '
    + 'macOS Keychain as shown under "Buy and set up" in the README. Never paste the secret into chat.';
}

export class SpaceshipError extends Error {
  constructor(message, { status = null, ambiguous = false } = {}) {
    super(message);
    this.status = status;
    this.ambiguous = ambiguous;
  }
}

function readKeychain(account) {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise(resolve => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', keychainService, '-a', account, '-w'],
      { timeout: 4000, windowsHide: true }, (error, stdout) => resolve(error ? null : stdout.replace(/\r?\n$/, '') || null));
  });
}

// Environment first, then the macOS Keychain. Returns null when either half is missing.
export async function spaceshipCredentials({ env = process.env, keychain = readKeychain } = {}) {
  const key = env.DOMAIN_HOUND_SPACESHIP_KEY?.trim();
  const secret = env.DOMAIN_HOUND_SPACESHIP_SECRET?.trim();
  if (key && secret) return { key, secret, source: 'environment' };
  const [storedKey, storedSecret] = await Promise.all([keychain(keychainAccounts.key), keychain(keychainAccounts.secret)]);
  if (storedKey?.trim() && storedSecret?.trim()) return { key: storedKey.trim(), secret: storedSecret.trim(), source: 'keychain' };
  return null;
}

const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
export const isLoopback = url => loopback.has(new URL(url).hostname);

const domainPath = domain => encodeURIComponent(domain);

// A thin client for the documented endpoints. baseUrl and fetcher are injectable for the local test mock only.
export function spaceshipClient({ key, secret, baseUrl = spaceshipBase, fetcher = globalThis.fetch, timeout = 8000 }) {
  if (!key || !secret) throw new SpaceshipError('Spaceship API key and secret are required.');
  const base = baseUrl.replace(/\/+$/, '');
  if (base !== spaceshipBase && !isLoopback(base)) throw new SpaceshipError('Spaceship API base must be ' + spaceshipBase + '.');

  async function request(method, path, { query, body, accept = [200] } = {}) {
    const url = base + path + (query ? '?' + new URLSearchParams(query) : '');
    let response;
    try {
      response = await fetcher(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(timeout),
        headers: { 'X-API-Key': key, 'X-API-Secret': secret, Accept: 'application/json',
          ...(body !== undefined && { 'Content-Type': 'application/json' }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch {
      // A write may have reached Spaceship before the connection failed.
      throw new SpaceshipError('Spaceship did not answer in time.', { ambiguous: method !== 'GET' });
    }
    const text = await response.text().catch(() => '');
    if (!accept.includes(response.status)) {
      const reason = response.status === 401 || response.status === 403 ? 'Spaceship refused the API key or its scope'
        : response.status === 404 ? 'Spaceship has no such item' : response.status === 429 ? 'Spaceship rate limit reached'
          : 'Spaceship answered HTTP ' + response.status;
      throw new SpaceshipError(reason + '.', { status: response.status, ambiguous: method !== 'GET' && response.status >= 500 });
    }
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch { throw new SpaceshipError('Spaceship returned invalid JSON.', { status: response.status }); }
    }
    return { status: response.status, headers: response.headers, json };
  }

  return {
    baseUrl: base,
    accountBinding: createHash('sha256').update(key).digest('hex'),
    // checkSingleDomainAvailability: { domain, result, premiumPricing }
    available: async domain => (await request('GET', '/v1/domains/' + domainPath(domain) + '/available')).json,
    // getSingleDomainPricing: { domain, priceClass, prices: { register: [...], renew: [...] } }
    pricing: async domain => (await request('GET', '/v1/domains/' + domainPath(domain) + '/pricing')).json,
    // getDomainInfo: { name, lifecycleStatus, autoRenew, privacyProtection, nameservers, contacts }
    info: async domain => (await request('GET', '/v1/domains/' + domainPath(domain))).json,
    // getResourceRecordsList, read every page.
    async dnsRecords(domain) {
      const items = [];
      let total;
      for (let page = 0; page < 20; page++) {
        const { json } = await request('GET', '/v1/dns/records/' + domainPath(domain), {
          query: { take: 500, skip: items.length },
        });
        const rows = json?.items;
        total ??= json?.total;
        if (!Array.isArray(rows) || !Number.isInteger(total) || total < 0 || json.total !== total
          || items.length + rows.length > total || (!rows.length && items.length < total)) {
          throw new SpaceshipError('Spaceship returned an incomplete DNS list. Preview again.');
        }
        items.push(...rows);
        if (items.length === total) return items;
      }
      throw new SpaceshipError('Spaceship listed too many DNS records to plan safely.');
    },
    // saveRecords with force false: adds items, or updates the TTL of an exact match.
    saveRecords: (domain, items) => request('PUT', '/v1/dns/records/' + domainPath(domain), { body: { force: false, items }, accept: [204] }),
    // deleteRecords: removes exact custom records only.
    deleteRecords: (domain, items) => request('DELETE', '/v1/dns/records/' + domainPath(domain), { body: items, accept: [204] }),
    // domainCreate has no price cap or idempotency field, so it is only ever sent to the local test mock.
    async createDomain(domain, body) {
      if (!isLoopback(base)) throw new SpaceshipError('Domain Hound does not send live registration orders.');
      const { headers } = await request('POST', '/v1/domains/' + domainPath(domain), { body, accept: [202] });
      const operationId = headers.get('spaceship-async-operationid');
      if (!operationId) throw new SpaceshipError('Spaceship accepted the order without an operation ID.', { ambiguous: true });
      return { operationId };
    },
    // getAsyncOperationDetails: { status: pending | success | failed, type, details }
    operation: async id => (await request('GET', '/v1/async-operations/' + encodeURIComponent(id))).json,
  };
}
