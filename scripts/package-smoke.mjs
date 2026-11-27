// Post-install smoke on any OS: pack the package, start it through npx from the tarball like a fresh install,
// list the tools, and run one exact check against a domain that is registered by design (example.com, IANA).
// With --published <version> it starts domain-hound@<version> from the npm registry instead and only lists the tools
// (the release workflow runs this once `npm view` lists the new version).
// Every attempt gets its own freshly created npm cache. In --published mode, an npx that fails with ETARGET or E404
// before the server answers is retried for up to ten minutes in total: npx can be served a different (and staler)
// metadata representation than the one `npm view` saw, so the readiness wait alone does not guarantee npx finds it.
// Any other failure ends the smoke at once.
// Every attempt also times the cold start the way a host sees it: the initialize handshake must answer within the
// hosts' connect window, and in packed mode the first lookup must return a short table answer within the tool limit,
// with no wording about checks that failed or are still running, and the separate instruction to stop there.
// With PACKAGE_SMOKE_DIAGNOSTICS=1 every attempt also prints where its cold start went: npm's own timers and network
// requests (npm --timing), and when node started the server, reached its entry, loaded it and answered initialize.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const windows = process.platform === 'win32';
const tools = ['check_domains', 'triage_names', 'check_batch', 'naming_guide', 'watch_domain', 'taken_domain_dossier', 'my_domains',
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
// Hard ceilings that an override can only lower. 30 s is Claude Code's default MCP connect timeout (MCP_TIMEOUT);
// Codex's default startup_timeout_sec is 10 s, so this is a ceiling, not a target. The server answers each tool call
// within its own 14 s budget, and 15 s leaves a second for transport.
const ceiling = (value, max) => Math.min(max, Number(value) || max);
const maxInitMs = ceiling(process.env.PACKAGE_SMOKE_MAX_INIT_MS, 30_000);
const maxLookupMs = ceiling(process.env.PACKAGE_SMOKE_MAX_LOOKUP_MS, 15_000);
const diagnostics = process.env.PACKAGE_SMOKE_DIAGNOSTICS === '1';
const doneGuidance = 'Done. Show this; do not call more tools unless the user asks.';
const unknownWording = /still checking|couldn’t|couldn't|could not|failed|blocked|unknown|unavailable|unreachable|call the same tool/i;
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
    // One executable with everything it reads inlined, its notices, and the plugin metadata; no dependency installs.
    for (const file of ['package.json', 'dist/domain-hound.mjs', 'dist/THIRD-PARTY-NOTICES.txt', 'skills/domain-hound/SKILL.md']) {
      assert.ok(paths.includes(file), 'Tarball lacks ' + file);
    }
    assert.deepEqual(paths.filter(file => /\.(?:mjs|cjs|js)$/.test(file)), ['dist/domain-hound.mjs'], 'One script in the tarball');
    assert.ok(!paths.some(file => /^node_modules\/|\.test\.mjs$|^fixtures\/|^test-support\/|^scripts\/|^\.github\//.test(file)), 'Tarball ships dependencies, test or build files');
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    assert.equal(manifest.bin['domain-hound'], 'dist/domain-hound.mjs');
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) {
      assert.ok(!Object.keys(manifest[field] ?? {}).length, 'The package must install nothing: ' + field);
    }
    for (const script of ['preinstall', 'install', 'postinstall', 'prepare']) assert.ok(!manifest.scripts?.[script], 'Install script ' + script);
    console.log(`Packed ${packed.filename}: ${packed.size} B gzip, ${packed.unpackedSize} B unpacked, ${packed.entryCount} files`);
    filename = packed.filename;
    tarball = 'file:' + join(temp, filename);
  }

  // One npx start with a new, empty npm cache. Returns the failure (or null) and whether the server ever answered.
  const attempt = async number => {
    const cache = await mkdtemp(join(temp, 'npx-cache-'));
    const logs = join(temp, 'npm-logs-' + number);
    const env = { ...baseEnv, npm_config_cache: cache, npm_config_color: 'false',
      ...diagnostics && { npm_config_timing: 'true', npm_config_logs_dir: logs, DOMAIN_HOUND_STARTUP_TRACE: '1' } };
    const started = performance.now();
    const spawnedAt = Date.now();
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
    let initializedMs;
    let initializedAt;
    let listedMs;
    let lookupMs;
    let checkBytes;
    let exitCode;
    try {
      const init = await request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {},
        clientInfo: { name: 'domain-hound-package-smoke', version: '1' } });
      initializedMs = Math.round(performance.now() - started);
      initializedAt = Date.now();
      assert.ok(initializedMs < maxInitMs, `Cold npx initialize took ${initializedMs} ms; hosts allow about ${maxInitMs} ms`);
      assert.equal(init.serverInfo.version, version);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const listStarted = performance.now();
      const listed = await request(2, 'tools/list');
      listedMs = Math.round(performance.now() - listStarted);
      toolsListed = listed.tools;
      assert.deepEqual(toolsListed.map(tool => tool.name), tools);
      for (const tool of toolsListed) {
        assert.ok(tool.annotations.title, tool.name);
        for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
          assert.equal(typeof tool.annotations[hint], 'boolean', tool.name + '.' + hint);
        }
      }
      if (published) {
        description = `Published npx smoke on ${process.platform}: ${filename}, ${tools.length} tools`;
      } else {
        const lookupStarted = performance.now();
        const checked = await request(3, 'tools/call', { name: 'check_domains', arguments: { query: 'example.com' } });
        lookupMs = Math.round(performance.now() - lookupStarted);
        assert.ok(lookupMs < maxLookupMs, `First lookup took ${lookupMs} ms; hosts allow about ${maxLookupMs} ms`);
        assert.equal(checked.isError, false, JSON.stringify(checked.content));
        const display = checked.content[0].text;
        assert.equal(checked.structuredContent.rows[0].name, 'example.com');
        assert.deepEqual(checked.structuredContent.rows[0].statuses.taken, ['com']);
        // The first answer is a table with the exact verdict and at most two supporting lines.
        const lines = display.split('\n');
        assert.equal(lines[0], '| | Domain | Status | Now | Then/yr | Where |');
        assert.equal(lines[1], '|---|---|---|---|---|---|');
        assert.equal(lines[2], '| Asked | example.com | taken | — | — | — |');
        assert.match(lines.at(-1), /All prices, shops and handles: \[Open results\]\(.+\.html>?\)$/);
        const tableEnd = lines.findLastIndex(line => line.startsWith('|'));
        assert.equal(lines[tableEnd + 1], '', 'Markdown separates the table from the notes');
        assert.ok(lines.length - tableEnd - 2 <= 2, 'At most two supporting lines: ' + display);
        assert.doesNotMatch(display, unknownWording);
        assert.equal(checked.content.length, 2);
        assert.equal(checked.content[1].text, doneGuidance);
        assert.equal(checked.structuredContent.answer, display);
        assert.equal(checked.structuredContent.next, doneGuidance);
        assert.doesNotMatch(JSON.stringify(checked.structuredContent), /still checking|couldn’t|unavailable|:"unknown"|:"pending"/i);
        checkBytes = Buffer.byteLength(JSON.stringify(checked));
        assert.ok(checkBytes < 8_000, checkBytes + ' bytes');
        description = `Packed npx smoke on ${process.platform}: ${filename}, ${tools.length} tools, example.com taken`;
      }
    } catch (error) {
      failure = error;
    } finally {
      child.stdin.end();
      exitCode = await closed;
      clearTimeout(timer);
      if (diagnostics) await diagnose({ spawnedAt, initializedAt, stderr, logs });
    }
    if (timedOut) return {
      failure: new Error(`npx smoke timed out after ${Math.ceil(limit / 1000)} s`),
      registryWait: limit < attemptMs && !responded && (!stderr.trim() || notListedYet(stderr)),
    };
    if (spawnError) return { failure: spawnError };
    if (exitCode !== 0) failure ??= new Error(`npx exited with status ${exitCode}`);
    if (!failure) {
      console.log('MCP tools: ' + toolsListed.map(tool => tool.name).join(', '));
      console.log('tools/list annotations: ' + JSON.stringify(Object.fromEntries(toolsListed.map(tool => [tool.name, tool.annotations]))));
      console.log('Cold npx initialize: ' + initializedMs + ' ms, tools/list: ' + listedMs + ' ms'
        + (checkBytes ? ', first lookup: ' + lookupMs + ' ms, one exact check: ' + checkBytes + ' bytes' : ''));
      const duration = `${Math.round(performance.now() - started)} ms`;
      console.log(`${description}, ${duration}${published ? `, attempt ${number}` : ''}`);
    }
    return { failure, retryable: exitCode !== 0 && !responded && notListedYet(stderr) };
  };

  // Where one cold start went: the smoke's clock, the server's startup line and npm's debug log.
  async function diagnose({ spawnedAt, initializedAt, stderr, logs }) {
    const line = stderr.match(/^domain-hound startup (\{.*\})\r?$/m);
    const startup = line ? JSON.parse(line[1]) : null;
    const parts = startup ? [`npx until node started the server ${startup.processStart - spawnedAt} ms`,
      `node startup ${startup.entered - startup.processStart} ms`, `loading the server ${startup.loaded - startup.entered} ms`,
      initializedAt ? `then initialize answered after ${initializedAt - startup.loaded} ms` : 'initialize never answered']
      : [`the server never started (${Date.now() - spawnedAt} ms after npx was spawned)`];
    console.error('Cold start diagnostics: ' + parts.join(', '));
    const names = await readdir(logs).catch(() => []);
    for (const name of names.filter(file => file.endsWith('.log'))) {
      const text = await readFile(join(logs, name), 'utf8');
      const timers = [...text.matchAll(/timing (\S+) Completed in (\d+)ms/g)].map(([, timer, ms]) => [timer, Number(ms)])
        .sort((a, b) => b[1] - a[1]).slice(0, 12);
      console.error(`npm ${name} slowest timers: ` + timers.map(([timer, ms]) => `${timer} ${ms} ms`).join(', '));
      for (const request of text.split(/\r?\n/).filter(row => /\bhttp fetch\b/.test(row))) console.error('npm ' + request.replace(/^\d+\s+/, ''));
    }
  }

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
