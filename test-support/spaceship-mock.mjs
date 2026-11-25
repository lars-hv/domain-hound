import { createServer } from 'node:http';

// A local stand-in for the documented Spaceship REST endpoints (docs.spaceship.dev). It listens on 127.0.0.1 only.
// Every request is logged so tests can prove what was, and was not, sent.
// GET availability: https://docs.spaceship.dev/#tag/Domain-Availability/operation/checkSingleDomainAvailability
// GET pricing: https://docs.spaceship.dev/#tag/Domain-Pricing/operation/getSingleDomainPricing
// GET domain info: https://docs.spaceship.dev/#tag/Domain-Management/operation/getDomainInfo
// POST registration: https://docs.spaceship.dev/#tag/Domain-Management/operation/domainCreate
// GET operation: https://docs.spaceship.dev/#tag/Async-Operations/operation/getAsyncOperationDetails
// GET DNS: https://docs.spaceship.dev/#tag/DNS-records/operation/getResourceRecordsList
// PUT DNS: https://docs.spaceship.dev/#tag/DNS-records/operation/saveRecords
// DELETE DNS: https://docs.spaceship.dev/#tag/DNS-records/operation/deleteRecords
const fields = { A: ['address'], AAAA: ['address'], ALIAS: ['aliasName'], CNAME: ['cname'], MX: ['exchange', 'preference'], TXT: ['value'] };
const same = (a, b) => a.type === b.type && a.name === b.name && (fields[a.type] ?? []).every(field => String(a[field]) === String(b[field]));
const price = (amount, currency) => ({ finalPrice: { amount, currency }, regularPrice: { amount, currency } });
const priceList = (terms, currency) => Object.entries(terms).map(([years, amount]) => ({
  period: { value: Number(years), unit: 'y' }, priceInDefaultCurrency: price(amount, currency) }));

// A contact ID in the documented shape: 27 to 32 letters and digits.
export const ownerContactId = '1ZdMXpapqp9sle5dl8BlppTJXAzf5';

// A fetch that sends requests for the production Spaceship base to the local mock, so tests can drive the production
// client unchanged. Any other host fails.
export function productionFetchTo(mockBaseUrl, productionBase = 'https://spaceship.dev/api') {
  return (url, options) => {
    const text = String(url);
    if (!text.startsWith(productionBase + '/')) throw Error('Unexpected host in a Spaceship test: ' + text);
    return fetch(mockBaseUrl + text.slice(productionBase.length), options);
  };
}

export async function startSpaceshipMock({ key = 'test-key', secret = 'test-secret' } = {}) {
  const state = { offers: new Map(), domains: new Map(), records: new Map(), operations: new Map(), requests: [],
    createMode: 'success', nextOperation: 1, dnsPageSize: 100, dnsSaveFails: false, beforePricing: null };

  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const url = new URL(request.url, 'http://127.0.0.1');
    const path = url.pathname.replace(/^\/api/, '');
    const body = text ? JSON.parse(text) : undefined;
    state.requests.push({ method: request.method, path, query: Object.fromEntries(url.searchParams), body,
      key: request.headers['x-api-key'], secret: request.headers['x-api-secret'] });
    const send = (status, payload, headers = {}) => {
      response.writeHead(status, { ...(payload !== undefined && { 'content-type': 'application/json' }), ...headers });
      response.end(payload === undefined ? '' : JSON.stringify(payload));
    };
    if (request.headers['x-api-key'] !== key || request.headers['x-api-secret'] !== secret) return send(401, { detail: 'Unauthorized' });
    let match;
    if ((match = path.match(/^\/v1\/domains\/([^/]+)\/available$/)) && request.method === 'GET') {
      const domain = decodeURIComponent(match[1]);
      const offer = state.offers.get(domain);
      return send(200, { domain, result: offer?.result ?? 'taken', premiumPricing: offer?.premiumPricing ?? [] });
    }
    if ((match = path.match(/^\/v1\/domains\/([^/]+)\/pricing$/)) && request.method === 'GET') {
      const domain = decodeURIComponent(match[1]);
      state.beforePricing?.(domain, state.requests.filter(row => row.path === path).length);
      const offer = state.offers.get(domain);
      if (!offer) return send(404, { detail: 'Not found' });
      return send(200, { domain, priceClass: offer.priceClass,
        prices: { register: priceList(offer.register, offer.currency), renew: priceList(offer.renew, offer.currency) } });
    }
    if ((match = path.match(/^\/v1\/domains\/([^/]+)$/))) {
      const domain = decodeURIComponent(match[1]);
      if (request.method === 'GET') {
        const info = state.domains.get(domain);
        return info ? send(200, info) : send(404, { detail: 'Not found' });
      }
      if (request.method === 'POST') {
        // Failure modes: drop the connection, a server error, a refusal, or an accepted order without an operation ID.
        if (state.createMode === 'drop') return request.socket.destroy();
        if (state.createMode === 'error500') return send(500, { detail: 'Internal error' });
        if (state.createMode === 'reject422') return send(422, { detail: 'Invalid contact' });
        if (state.createMode === 'noid') return send(202);
        const id = 'op-' + state.nextOperation++;
        state.operations.set(id, { id, status: state.createMode === 'failed' ? 'failed' : state.createMode === 'pending' ? 'pending' : 'success',
          type: 'domains_Create', details: { domain } });
        if (state.createMode === 'success') {
          state.domains.set(domain, { name: domain, lifecycleStatus: 'registered', autoRenew: body.autoRenew,
            privacyProtection: { level: body.privacyProtection?.level }, nameservers: { provider: 'basic', hosts: ['launch1.spaceship.net'] },
            contacts: { registrant: body.contacts?.registrant } });
          const offer = state.offers.get(domain);
          if (offer) offer.result = 'taken';
        }
        return send(202, undefined, { 'spaceship-async-operationid': id });
      }
    }
    if ((match = path.match(/^\/v1\/async-operations\/([^/]+)$/)) && request.method === 'GET') {
      const operation = state.operations.get(decodeURIComponent(match[1]));
      return operation ? send(200, operation) : send(404, { detail: 'Not found' });
    }
    if ((match = path.match(/^\/v1\/dns\/records\/([^/]+)$/))) {
      const domain = decodeURIComponent(match[1]);
      const items = state.records.get(domain) ?? [];
      state.records.set(domain, items);
      if (request.method === 'GET') {
        const take = Number(url.searchParams.get('take'));
        const skip = Number(url.searchParams.get('skip'));
        if (!(take >= 1 && take <= 500) || !(skip >= 0)) return send(422, { detail: 'take and skip are required' });
        return send(200, { total: items.length, items: items.slice(skip, skip + Math.min(take, state.dnsPageSize)) });
      }
      if (request.method === 'PUT') {
        if (state.dnsSaveFails) return send(422, { detail: 'DNS save rejected' });
        if (body?.force !== false || !Array.isArray(body.items)) return send(422, { detail: 'Invalid body' });
        for (const item of body.items) {
          const existing = items.find(row => same(row, item));
          if (existing) existing.ttl = item.ttl;
          else items.push({ ...item, group: { type: 'custom' } });
        }
        return send(204);
      }
      if (request.method === 'DELETE') {
        if (!Array.isArray(body)) return send(422, { detail: 'Invalid body' });
        const targets = body.map(item => items.findIndex(row => same(row, item) && row.group?.type === 'custom'));
        if (targets.some(index => index < 0)) return send(422, { detail: 'Only exact custom records can be deleted' });
        state.records.set(domain, items.filter((_row, index) => !targets.includes(index)));
        return send(204);
      }
    }
    return send(404, { detail: 'No such endpoint' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: 'http://127.0.0.1:' + port + '/api', key, secret, state,
    setOffer(domain, { result = 'available', premiumPricing = [], priceClass = 'standard', register = { 1: '9.98' },
      renew = { 1: '12.98' }, currency = 'USD' } = {}) {
      state.offers.set(domain, { result, premiumPricing, priceClass, register, renew, currency });
    },
    setDomain(domain, { provider = 'basic', hosts = ['launch1.spaceship.net', 'launch2.spaceship.net'], records = [] } = {}) {
      state.domains.set(domain, { name: domain, lifecycleStatus: 'registered', autoRenew: true, privacyProtection: { level: 'high' },
        nameservers: { provider, hosts }, contacts: { registrant: ownerContactId } });
      state.records.set(domain, records.map(row => ({ ttl: 3600, group: { type: 'custom' }, ...row })));
    },
    sent: (method, pattern) => state.requests.filter(row => row.method === method && (!pattern || pattern.test(row.path))),
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
