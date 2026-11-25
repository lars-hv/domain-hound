import { anySignal } from './cache.mjs';

export const atomSearchUrl = 'https://mcp.atom.com/mcp';
export const atomSearchDocs = 'https://www.atom.com/atom-mcp-server/docs';

// Atom documents this particular MCP tool as public and read-only.
const searchName = 'search_brandable_domains';
const maxResponseBytes = 96 * 1024;

async function readResult(response) {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxResponseBytes) return null;
      body += decoder.decode(value, { stream: true });
    }
    const reply = JSON.parse(body + decoder.decode());
    if (reply.id !== 1 || reply.result?.isError) return null;
    const result = reply.result?.structuredContent;
    return result?.success === true && Array.isArray(result.results) ? result.results : null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function exactAtomListingUrl(value, domain) {
  if (typeof value !== 'string' || value.length > 320) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.origin !== 'https://www.atom.com' || url.username || url.password || url.search || url.hash) return null;
  const path = url.pathname.toLowerCase();
  return path === '/name/' + domain || (domain.endsWith('.com') && path === '/name/' + domain.slice(0, -4))
    ? url.href : null;
}

export async function lookupAtomListing(domain, {
  fetcher = globalThis.fetch, timeoutMs = 8500, signal, now = () => new Date(),
} = {}) {
  const result = (status, fields) => ({ status, url: atomSearchUrl, checkedAt: now().toISOString(), ...fields });
  try {
    const response = await fetcher(atomSearchUrl, {
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      signal: anySignal([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: searchName, arguments: { concept: domain, page_size: 10 } },
      }),
    });
    const rows = await readResult(response);
    if (!rows) return result('unavailable');
    const matches = rows.filter(row => typeof row?.domain === 'string' && row.domain.toLowerCase() === domain);
    for (const row of matches) {
      const listingUrl = exactAtomListingUrl(row.url, domain);
      if (!listingUrl) continue;
      const price = Number.isFinite(row.price) && row.price > 0 && row.price <= Number.MAX_SAFE_INTEGER / 100
        && typeof row.currency === 'string' && /^[A-Z]{3}$/.test(row.currency)
        ? { amount: row.price, currency: row.currency } : null;
      return result('listed', { listingUrl, price });
    }
    return result(matches.length ? 'unavailable' : 'no-exact-result');
  } catch {
    return result('unavailable');
  }
}
