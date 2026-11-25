import { StringDecoder } from 'node:string_decoder';
import { money } from './prices.mjs';

const searchUrl = 'https://www.spaceship.com/gateway/api/v1/instantsearch-api/search';

export function spaceshipFeedQuote(row, domain) {
  if (row?.type !== 'result' || row.name !== domain || row.verified !== true || row.isPrimary !== true) return null;
  if (row.state === 'taken') return { available: false, premium: false, price: null, renewal: null };
  if (row.state !== 'available' || row.price?.currency !== 'USD') return null;
  const price = money(row.price.price);
  const renewal = money(row.price.renewal);
  if (!price || !renewal) return null;
  return { available: true, premium: row.premium === true || row.isPremium === true, price, renewal };
}

// Consume only the exact query's verified result from the storefront's existing response.
// The browser continues to handle the page and its request normally.
export async function watchSpaceshipFeed(page, domain) {
  let client;
  try {
    client = await page.context().newCDPSession(page);
    await client.send('Network.enable');
  } catch {
    await client?.detach().catch(() => {});
    return null;
  }
  const decoder = new StringDecoder('utf8');
  let quote = null;
  let requestId;
  let chunks = [];
  let fragment = '';
  let ready = false;
  let finished = false;

  function consume(data, final = false) {
    if (data) fragment += decoder.write(Buffer.from(data, 'base64'));
    if (final) fragment += decoder.end() + '\n';
    if (fragment.length > 128 * 1024) { fragment = ''; return; }
    const lines = fragment.split('\n');
    fragment = lines.pop();
    for (const line of lines) {
      try { quote ??= spaceshipFeedQuote(JSON.parse(line), domain); } catch { /* Ignore malformed lines. */ }
    }
  }

  client.on('Network.responseReceived', async event => {
    const { response } = event;
    if (requestId || response.url !== searchUrl || response.status !== 200 ||
        response.mimeType !== 'application/x-ndjson') return;
    requestId = event.requestId;
    try {
      const { bufferedData } = await client.send('Network.streamResourceContent', { requestId });
      consume(bufferedData);
      for (const part of chunks) consume(part);
      ready = true;
      if (finished) consume(null, true);
    } catch { /* The exact visible storefront result remains available. */ }
    chunks = [];
  });
  client.on('Network.dataReceived', event => {
    if (event.requestId !== requestId || !event.data || quote) return;
    if (ready) consume(event.data);
    else if (chunks.length < 24) chunks.push(event.data);
  });
  client.on('Network.loadingFinished', event => {
    if (event.requestId !== requestId) return;
    finished = true;
    if (ready) consume(null, true);
  });

  return { read: () => quote, close: () => client.detach().catch(() => {}) };
}
