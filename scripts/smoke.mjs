import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resultsLine } from '../results.mjs';
import { defaultEndings } from '../clis/domain-check/name-search.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = join(root, '.verify');
const query = 'example-hound-test';
const tools = ['check_domains', 'triage_names', 'naming_guide', 'watch_domain', 'taken_domain_dossier', 'my_domains', 'quote_domain', 'buy_domain', 'setup_domain', 'move_domain'];
// The engine filters .inc out of a bare-name result unless it finds an affordable available registration.
const endings = defaultEndings.filter(ending => ending !== 'inc');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

async function smokeMcp(label, command, args, options, capability) {
  const started = performance.now();
  const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'inherit'] });
  const completion = new Promise(resolve => {
    child.once('error', error => resolve(error));
    child.once('close', (code, signal) => resolve(code === 0 ? null : new Error(`Exit ${code ?? signal}`)));
  });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const replies = reader[Symbol.asyncIterator]();
  const timeout = setTimeout(() => child.kill('SIGKILL'), 25_000);
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

  async function request(id, method, params) {
    send({ id, method, params });
    const line = await replies.next();
    if (line.done) throw (await completion) ?? new Error(`Missing reply to ${method}`);
    const reply = JSON.parse(line.value);
    assert.equal(reply.jsonrpc, '2.0');
    assert.equal(reply.id, id);
    assert.ok(reply.result, JSON.stringify(reply.error));
    return reply.result;
  }

  try {
    const initialize = await request(1, 'initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'domain-hound-smoke', version: '1' },
    });
    const startup = Math.round(performance.now() - started);
    assert.equal(initialize.protocolVersion, '2025-11-25');
    assert.equal(initialize.serverInfo.name, 'domain-hound');
    assert.equal(initialize.serverInfo.version, version);
    assert.ok(startup < 5000, `${label} took ${startup} ms to initialize`);
    send({ method: 'notifications/initialized' });
    const advertised = await request(2, 'tools/list');
    assert.deepEqual(advertised.tools.map(tool => tool.name), tools);

    // The first lookup on an empty cache must already carry dated list prices.
    const firstStarted = performance.now();
    const first = await request(3, 'tools/call', { name: 'check_domains', arguments: { names: [query] } });
    const firstLookup = Math.round(performance.now() - firstStarted);
    assert.equal(first.isError, false, JSON.stringify(first.content));
    const batch = first.structuredContent;
    assert.equal(batch.rows[0].name, query);
    assert.ok(Buffer.byteLength(JSON.stringify(first)) < 8_000);
    const receipt = await readFile(new URL(batch.resultPage), 'utf8');
    assert.ok(receipt.includes('Price checked ' + capability.priceListDate), 'First receipt has no price date');
    for (const ending of endings) {
      assert.ok(capability.listPrices?.[ending]?.now > 0, 'First call has no list price for .' + ending);
      assert.ok(receipt.includes(query + '.' + ending), 'First receipt omits .' + ending);
    }

    const lookupStarted = performance.now();
    const result = await request(4, 'tools/call', { name: 'check_domains', arguments: { query } });
    const lookup = Math.round(performance.now() - lookupStarted);
    assert.equal(result.isError, false, JSON.stringify(result.content));
    const display = result.content[0].text;
    assert.equal(result.structuredContent.rows[0].name, query);
    assert.ok(display.includes(query));
    assert.ok(display.split('\n').includes(resultsLine(result.structuredContent.resultPage)));
    const html = await readFile(new URL(result.structuredContent.resultPage), 'utf8');
    assert.ok(endings.every(ending => html.includes(query + '.' + ending)));

    child.stdin.end();
    assert.equal((await replies.next()).done, true, 'Unexpected stdout after last response');
    assert.equal(await completion, null);
    console.log(`${label}: initialize ${startup} ms, tools/list ${tools.length}, first check_domains ${firstLookup} ms `
      + `(${endings.length} endings priced, list price from ${capability.priceListDate}), check_domains ${lookup} ms`);
  } finally {
    clearTimeout(timeout);
    reader.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await completion;
  }
}

await mkdir(scratch, { recursive: true });
const temp = await mkdtemp(join(scratch, 'smoke-'));
try {
  // Every run starts with its own empty npm and lookup caches, like a fresh install.
  const freshEnv = name => ({ ...process.env, npm_config_cache: join(temp, name, 'npm-cache'),
    XDG_CACHE_HOME: join(temp, name, 'lookup-cache'), DOMAIN_HOUND_CACHE_DIR: join(temp, name, 'lookup-cache'),
    DOMAIN_HOUND_RESULTS_DIR: join(temp, name, 'results'), DOMAIN_HOUND_OPEN: 'off', DOMAIN_HOUND_TEST: '1' });
  const direct = await exec(process.execPath, [join(root, 'clis/domain-check/index.mjs'), '--agent', '--names', query],
    { cwd: temp, env: freshEnv('cli'), timeout: 20_000 });
  const capability = JSON.parse(direct.stdout);
  assert.equal(capability.names[0].name, query);
  assert.equal(direct.stderr, '');
  console.log('Capability CLI: returned the requested name');

  await smokeMcp('Source bin', process.execPath, [join(root, 'bin/domain-hound.mjs')], { cwd: temp, env: { ...freshEnv('bin'), DOMAIN_HOUND_LOCAL: '1' } }, capability);
  const pack = await exec('npm', ['pack', '--json', '--pack-destination', temp], { cwd: root, env: freshEnv('pack') });
  const [{ filename, files }] = JSON.parse(pack.stdout);
  assert.ok(files.some(file => file.path === 'clis/domain-check/price-snapshot.json'), 'Tarball lacks the price snapshot');
  await smokeMcp('Cold npx tarball', 'npx', ['-y', 'file:' + join(temp, filename)],
    { cwd: temp, env: { ...freshEnv('npx'), DOMAIN_HOUND_LOCAL: '1' } }, capability);
} finally {
  await rm(temp, { recursive: true, force: true });
}
