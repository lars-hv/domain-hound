// Post-install smoke on any OS: pack the package, start it through npx from the tarball like a fresh install,
// list the tools, and run one exact check against a domain that is registered by design (example.com, IANA).
// With --published <version> it starts domain-hound@<version> from the npm registry instead and only lists the tools
// (the release workflow runs this once `npm view` lists the new version).
// Every attempt gets its own freshly created npm cache. In --published mode, an npx that fails with ETARGET or E404
// before the server answers is retried for up to ten minutes in total: npx can be served a different (and staler)
// metadata representation than the one `npm view` saw, so the readiness wait alone does not guarantee npx finds it.
// Any other failure ends the smoke at once.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const windows = process.platform === 'win32';
const tools = ['check_domains', 'triage_names', 'naming_method', 'broker_find', 'watch_domain', 'taken_domain_dossier', 'my_domains',
  'quote_domain', 'buy_domain', 'setup_domain', 'move_domain'];
const { version: packageVersion } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const flag = process.argv.indexOf('--published');
const published = flag >= 0 ? process.argv[flag + 1] : null;
if (flag >= 0 && !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(published ?? '')) throw new Error('Use --published <version>, such as ' + packageVersion + '.');
const version = published ?? packageVersion;
// The overall cap covers every attempt and every pause; the test suite shortens both through these variables.
const windowMs = Math.min(600_000, Number(process.env.PACKAGE_SMOKE_WINDOW_MS) || 600_000);
const retryDelayMs = Math.min(15_000, Number(process.env.PACKAGE_SMOKE_RETRY_DELAY_MS ?? 15_000));
const attemptMs = 90_000;
const deadline = performance.now() + windowMs;
// npm and npx are .cmd files on Windows and need a shell there.
const npm = (args, options) => exec(windows ? 'npm.cmd' : 'npm', args, { ...options, shell: windows });
// npm logs the error code on stderr, with a different prefix on older releases.
const notListedYet = text => /^npm (?:error|ERR!) code (?:ETARGET|E404)\b/m.test(text);

const temp = await mkdtemp(join(tmpdir(), 'domain-hound-smoke-'));
try {
  const baseEnv = { ...process.env, DOMAIN_HOUND_CACHE_DIR: join(temp, 'lookup-cache'),
    DOMAIN_HOUND_RESULTS_DIR: join(temp, 'results'), DOMAIN_HOUND_OPEN: 'off' };
  let tarball = 'domain-hound@' + version;
  let filename = tarball;
  if (!published) {
    const cache = await mkdtemp(join(temp, 'pack-cache-'));
    const { stdout } = await npm(['pack', '--json', '--pack-destination', temp],
      { cwd: root, env: { ...baseEnv, npm_config_cache: cache } });
    const [packed] = JSON.parse(stdout);
    const paths = packed.files.map(file => file.path);
    for (const file of ['bin/domain-hound.mjs', 'server.mjs', 'display.mjs', 'results.mjs', 'results-style.mjs',
      'watch.mjs', 'dossier.mjs', 'clis/domain-check/index.mjs', 'clis/domain-check/dossier.mjs', 'clis/domain-check/handles.mjs',
      'clis/domain-check/price-snapshot.json', 'clis/domain-check/meaning-words.LICENSE.txt',
      'share.mjs', 'site/r/share-format.mjs', 'clis/spaceship/tools.mjs', 'clis/spaceship/transfer.mjs',
      'clis/portfolio/move.mjs', 'clis/portfolio/transfer-prices.mjs']) {
      assert.ok(paths.includes(file), 'Tarball lacks ' + file);
    }
    assert.ok(!paths.some(file => /\.test\.mjs$|^fixtures\/|^test-support\/|^scripts\/|^\.github\//.test(file)), 'Tarball ships test or build files');
    filename = packed.filename;
    tarball = 'file:' + join(temp, filename);
  }

  // One npx start with a new, empty npm cache. Returns the failure (or null) and whether the server ever answered.
  const attempt = async number => {
    const cache = await mkdtemp(join(temp, 'npx-cache-'));
    const env = { ...baseEnv, npm_config_cache: cache, npm_config_color: 'false' };
    const started = performance.now();
    const child = spawn(windows ? 'npx.cmd' : 'npx', ['-y', tarball], {
      cwd: temp, env, shell: windows, detached: !windows, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
    // npx can exit before reading anything; a write to its closed stdin must not crash the smoke.
    child.stdin.on('error', () => {});
    let spawnError;
    child.once('error', error => { spawnError = error; });
    const closed = new Promise(resolve => child.once('close', resolve));
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const lines = reader[Symbol.asyncIterator]();
    const limit = Math.max(1, Math.min(attemptMs, deadline - performance.now()));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // npx can have an MCP child holding the pipes open. On Unix the attempt has its own process group.
      if (windows) child.kill('SIGKILL');
      else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
      }
      reader.close();
      child.stdout.destroy();
      child.stderr.destroy();
    }, limit);
    let responded = false;
    const request = async (id, method, params) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const line = await lines.next();
      assert.ok(!line.done, 'No reply to ' + method);
      responded = true;
      const reply = JSON.parse(line.value);
      assert.equal(reply.id, id);
      assert.ok(reply.result, JSON.stringify(reply.error));
      return reply.result;
    };
    let failure = null;
    let description;
    let toolsListed;
    let exitCode;
    try {
      const init = await request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {},
        clientInfo: { name: 'domain-hound-package-smoke', version: '1' } });
      assert.equal(init.serverInfo.version, version);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const listed = await request(2, 'tools/list');
      toolsListed = listed.tools.map(tool => tool.name);
      assert.deepEqual(toolsListed, tools);
      if (published) {
        description = `Published npx smoke on ${process.platform}: ${filename}, ${tools.length} tools`;
      } else {
        const checked = await request(3, 'tools/call', { name: 'check_domains', arguments: { query: 'example.com' } });
        assert.equal(checked.isError, false, JSON.stringify(checked.content));
        const { display, names } = checked.structuredContent;
        assert.equal(names[0].name, 'example.com');
        assert.deepEqual(names[0].taken, ['com'], JSON.stringify(names[0]));
        assert.ok(display.includes('example.com'));
        const lines = display.split('\n');
        assert.ok(/^Results page: \[Open results\]\(.+\.html>?\)$/.test(lines[0])
          || /^All endings: \[Results page\]\(file:\/\/.*\.html\)$/.test(lines.at(-1)), display);
        description = `Packed npx smoke on ${process.platform}: ${filename}, ${tools.length} tools, example.com taken`;
      }
    } catch (error) {
      failure = error;
    } finally {
      child.stdin.end();
      exitCode = await closed;
      clearTimeout(timer);
    }
    if (timedOut) return {
      failure: new Error(`npx smoke timed out after ${Math.ceil(limit / 1000)} s`),
      registryWait: limit < attemptMs && !responded && (!stderr.trim() || notListedYet(stderr)),
    };
    if (spawnError) return { failure: spawnError };
    if (exitCode !== 0) failure ??= new Error(`npx exited with status ${exitCode}`);
    if (!failure) {
      console.log('MCP tools: ' + toolsListed.join(', '));
      const duration = `${Math.round(performance.now() - started)} ms`;
      console.log(`${description}, ${duration}${published ? `, attempt ${number}` : ''}`);
    }
    return { failure, retryable: exitCode !== 0 && !responded && notListedYet(stderr) };
  };

  let sawMissingVersion = false;
  for (let number = 1; ; number++) {
    const { failure, retryable, registryWait } = await attempt(number);
    if (!failure) break;
    const left = deadline - performance.now();
    if (!published || !retryable || left <= retryDelayMs) {
      if (published && (retryable || (registryWait && sawMissingVersion))) console.error(`npx still could not find ${tarball} after ${number} attempts in `
        + `${Math.round(windowMs / 60_000)} minutes.`);
      throw failure;
    }
    sawMissingVersion = true;
    console.error(`Attempt ${number}: npx could not find ${tarball} yet (ETARGET/E404). Retrying with a fresh npm cache `
      + `in ${Math.round(retryDelayMs / 1000)} s, ${Math.round(left / 1000)} s left.`);
    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
  }
} finally {
  // On Windows, the first lookup's background price refresh can still hold the package directory open.
  await rm(temp, { recursive: true, force: true, maxRetries: 25, retryDelay: 100 });
}
