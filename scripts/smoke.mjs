import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = join(root, '.verify');
const query = 'example-hound-test';
const tools = ['check_domains', 'triage_names', 'naming_method', 'broker_find'];
const endings = ['com', 'ai', 'io', 'me', 'co', 'dev', 'app', 'si', 'so', 'no'];
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

async function smokeMcp(label, command, args, options) {
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

    // The first lookup on an empty cache must already carry a dated list price for every ending.
    const firstStarted = performance.now();
    const first = await request(3, 'tools/call', { name: 'check_domains', arguments: { names: [query] } });
    const firstLookup = Math.round(performance.now() - firstStarted);
    assert.equal(first.isError, false, JSON.stringify(first.content));
    const batch = first.structuredContent;
    assert.deepEqual(first.content, [{ type: 'text', text: batch.display }]);
    assert.match(batch.priceListDate ?? '', /^\d{4}-\d{2}-\d{2}$/, 'First call has no price date');
    for (const ending of endings) {
      assert.ok(batch.listPrices?.[ending]?.now > 0, 'First call has no list price for .' + ending);
    }
    assert.ok(batch.display.includes('list prices from ' + batch.priceListDate), 'First call display has no price date');

    const lookupStarted = performance.now();
    const result = await request(4, 'tools/call', { name: 'check_domains', arguments: { query } });
    const lookup = Math.round(performance.now() - lookupStarted);
    assert.equal(result.isError, false, JSON.stringify(result.content));
    const { display, names } = result.structuredContent;
    assert.deepEqual(result.content, [{ type: 'text', text: display }]);
    assert.equal(names[0].name, query);
    assert.ok(display.includes(query));
    assert.match(display, /Check at shop[^\n]*\]\(https:\/\//i);
    assert.equal(display.split('\n').at(-1), 'via domainhound.dev');
    assert.equal(display.match(/via domainhound\.dev/g)?.length, 1);

    child.stdin.end();
    assert.equal((await replies.next()).done, true, 'Unexpected stdout after last response');
    assert.equal(await completion, null);
    console.log(`${label}: initialize ${startup} ms, tools/list ${tools.length}, first check_domains ${firstLookup} ms `
      + `(10 endings priced, list price from ${batch.priceListDate}), check_domains ${lookup} ms`);
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
    XDG_CACHE_HOME: join(temp, name, 'lookup-cache'), DOMAIN_HOUND_CACHE_DIR: join(temp, name, 'lookup-cache') });
  const direct = await exec(process.execPath, [join(root, 'clis/domain-check/index.mjs'), '--agent', query],
    { cwd: temp, env: freshEnv('cli'), timeout: 20_000 });
  const capability = JSON.parse(direct.stdout);
  assert.equal(capability.names[0].name, query);
  assert.equal(direct.stderr, '');
  console.log('Capability CLI: returned the requested name');

  await smokeMcp('Source bin', process.execPath, [join(root, 'bin/domain-hound.mjs')], { cwd: temp, env: freshEnv('bin') });
  const pack = await exec('npm', ['pack', '--json', '--pack-destination', temp], { cwd: root, env: freshEnv('pack') });
  const [{ filename, files }] = JSON.parse(pack.stdout);
  assert.ok(files.some(file => file.path === 'clis/domain-check/price-snapshot.json'), 'Tarball lacks the price snapshot');
  await smokeMcp('Cold npx tarball', 'npx', ['-y', 'file:' + join(temp, filename)],
    { cwd: temp, env: freshEnv('npx') });
} finally {
  await rm(temp, { recursive: true, force: true });
}
