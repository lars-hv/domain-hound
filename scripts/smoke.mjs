import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = join(root, '.verify');
const query = 'example-hound-test';
const tools = ['check_domains', 'triage_names', 'naming_method', 'broker_find'];

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
    assert.equal(initialize.serverInfo.version, '0.1.0');
    assert.ok(startup < 5000, `${label} took ${startup} ms to initialize`);
    send({ method: 'notifications/initialized' });
    const advertised = await request(2, 'tools/list');
    assert.deepEqual(advertised.tools.map(tool => tool.name), tools);

    const lookupStarted = performance.now();
    const result = await request(3, 'tools/call', { name: 'check_domains', arguments: { query } });
    const lookup = Math.round(performance.now() - lookupStarted);
    assert.equal(result.isError, false, JSON.stringify(result.content));
    const { display, names } = JSON.parse(result.content[0].text);
    assert.equal(names[0].name, query);
    assert.ok(display.includes(query));
    assert.match(display, /Check at shop[^\n]*\]\(https:\/\//i);
    assert.equal(display.split('\n').at(-1), 'via domainhound.dev');
    assert.equal(display.match(/via domainhound\.dev/g)?.length, 1);

    child.stdin.end();
    assert.equal((await replies.next()).done, true, 'Unexpected stdout after last response');
    assert.equal(await completion, null);
    console.log(`${label}: initialize ${startup} ms, tools/list ${tools.length}, check_domains ${lookup} ms`);
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
  const env = { ...process.env, npm_config_cache: join(temp, 'npm-cache'),
    XDG_CACHE_HOME: join(temp, 'lookup-cache'), DOMAIN_HOUND_CACHE_DIR: join(temp, 'lookup-cache') };
  const direct = await exec(process.execPath, [join(root, 'clis/domain-check/index.mjs'), '--agent', query],
    { cwd: temp, env, timeout: 20_000 });
  const capability = JSON.parse(direct.stdout);
  assert.equal(capability.names[0].name, query);
  assert.equal(direct.stderr, '');
  console.log('Capability CLI: returned the requested name');

  await smokeMcp('Source bin', process.execPath, [join(root, 'bin/domain-hound.mjs')], { cwd: temp, env });
  const pack = await exec('npm', ['pack', '--json', '--pack-destination', temp], { cwd: root, env });
  const [{ filename }] = JSON.parse(pack.stdout);
  await smokeMcp('Cold npx tarball', 'npx', ['-y', '--package', join(temp, filename), 'domain-hound'],
    { cwd: temp, env });
} finally {
  await rm(temp, { recursive: true, force: true });
}
