// Run against the Worker branch with wrangler dev. The browser request and the package each do their own lookup.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:8787');
const temp = await mkdtemp(join(tmpdir(), 'domain-hound-parity-'));
const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/domain-hound.mjs', import.meta.url))], {
  env: { ...process.env, DOMAIN_HOUND_LOCAL: '0', DOMAIN_HOUND_API_URL: base.origin, DOMAIN_HOUND_OPEN: 'off', DOMAIN_HOUND_TEST: '1',
    DOMAIN_HOUND_RESULTS_DIR: join(temp, 'results'), DOMAIN_HOUND_CACHE_DIR: join(temp, 'cache'),
    DOMAIN_HOUND_SCORE_LOG: '0' },
  stdio: ['pipe', 'pipe', 'inherit'],
});
const closed = once(child, 'close');
const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
const replies = reader[Symbol.asyncIterator]();
const timeout = setTimeout(() => child.kill('SIGTERM'), 60_000);
let id = 0;
const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
async function rpc(method, params) {
  send({ id: ++id, method, params });
  const line = await replies.next();
  assert.ok(!line.done, 'The package did not answer ' + method);
  const reply = JSON.parse(line.value);
  assert.equal(reply.id, id);
  assert.ok(reply.result, JSON.stringify(reply.error));
  return reply.result;
}
const compare = check => ({
  domains: check.domains.map(row => ({
    domain: row.domain, status: row.status, shopOrder: row.prices.map(offer => offer.shop),
  })),
  pick: check.choice.pick,
});
try {
  await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'domain-hound-parity', version: '1' } });
  send({ method: 'notifications/initialized' });
  for (const name of ['brightboard', 'tripfixer', 'parity' + randomBytes(5).toString('hex')]) {
    const site = await fetch(new URL('/v1/check?' + new URLSearchParams({ name }), base), {
      headers: { Origin: 'https://domainhound.dev', 'X-Domain-Hound-Test': '1' }, signal: AbortSignal.timeout(6000),
    });
    assert.equal(site.status, 200, 'Site check failed for ' + name);
    const webAnswer = await site.json();
    const reply = await rpc('tools/call', { name: 'check_domains', arguments: { query: name } });
    assert.equal(reply.isError, false, reply.content[0].text);
    assert.ok(reply.structuredContent.rows?.[0]?.name === name, 'The compact reply did not identify the checked name');
    // The compatibility endpoint keeps the raw evidence this parity check compares.
    const full = await rpc('tools/call', { name: 'broker_find', arguments: { query: name } });
    const check = full.structuredContent.checks?.[0];
    assert.ok(check, 'The package fell back to the local engine for ' + name);
    assert.deepEqual(compare(check), compare(webAnswer), 'Site and package differ for ' + name);
    console.log(name + ' · ' + check.domains.length + ' matching rows · pick ' + (check.choice.pick?.domain ?? 'none'));
    if (name === 'brightboard') {
      const display = reply.content[0].text;
      // The temporary receipt is removed after this run. Print the actual tool text without its local file path.
      console.log(display.slice(display.indexOf('\n') + 1) + '\n');
    }
  }
  console.log('Parity passed for all three names.');
} finally {
  clearTimeout(timeout);
  child.stdin.end();
  await closed;
  reader.close();
  await rm(temp, { recursive: true, force: true });
}
