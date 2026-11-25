// Post-install smoke on any OS: pack the package, start it through npx from the tarball like a fresh install,
// list the tools, and run one exact check against a domain that is registered by design (example.com, IANA).
// With --published <version> it starts domain-hound@<version> from the npm registry instead and only lists the tools
// (the release workflow runs this once the CDN serves the new tarball).
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
const tools = ['check_domains', 'triage_names', 'naming_method', 'broker_find', 'watch_domain', 'taken_domain_dossier'];
const { version: packageVersion } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const flag = process.argv.indexOf('--published');
const published = flag >= 0 ? process.argv[flag + 1] : null;
if (flag >= 0 && !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(published ?? '')) throw new Error('Use --published <version>, such as 0.1.5.');
const version = published ?? packageVersion;
// npm and npx are .cmd files on Windows and need a shell there.
const npm = (args, options) => exec(windows ? 'npm.cmd' : 'npm', args, { ...options, shell: windows });

const temp = await mkdtemp(join(tmpdir(), 'domain-hound-smoke-'));
try {
  const env = { ...process.env, npm_config_cache: join(temp, 'npm-cache'), DOMAIN_HOUND_CACHE_DIR: join(temp, 'lookup-cache'),
    DOMAIN_HOUND_RESULTS_DIR: join(temp, 'results'), DOMAIN_HOUND_OPEN: 'off' };
  let tarball = 'domain-hound@' + version;
  let filename = tarball;
  if (!published) {
    const { stdout } = await npm(['pack', '--json', '--pack-destination', temp], { cwd: root, env });
    const [packed] = JSON.parse(stdout);
    const paths = packed.files.map(file => file.path);
    for (const file of ['bin/domain-hound.mjs', 'server.mjs', 'display.mjs', 'results.mjs', 'results-style.mjs',
      'watch.mjs', 'dossier.mjs', 'clis/domain-check/index.mjs', 'clis/domain-check/dossier.mjs', 'clis/domain-check/handles.mjs',
      'clis/domain-check/price-snapshot.json']) {
      assert.ok(paths.includes(file), 'Tarball lacks ' + file);
    }
    assert.ok(!paths.some(file => /\.test\.mjs$|^fixtures\/|^test-support\/|^scripts\/|^\.github\//.test(file)), 'Tarball ships test or build files');
    filename = packed.filename;
    tarball = 'file:' + join(temp, filename);
  }
  const started = performance.now();
  const child = spawn(windows ? 'npx.cmd' : 'npx', ['-y', tarball], { cwd: temp, env, shell: windows, stdio: ['pipe', 'pipe', 'inherit'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const timer = setTimeout(() => child.kill(), 90_000);
  const request = async (id, method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const line = await lines.next();
    assert.ok(!line.done, 'No reply to ' + method);
    const reply = JSON.parse(line.value);
    assert.equal(reply.id, id);
    assert.ok(reply.result, JSON.stringify(reply.error));
    return reply.result;
  };
  try {
    const init = await request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'domain-hound-package-smoke', version: '1' } });
    assert.equal(init.serverInfo.version, version);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const listed = await request(2, 'tools/list');
    assert.deepEqual(listed.tools.map(tool => tool.name), tools);
    if (published) {
      console.log(`Published npx smoke on ${process.platform}: ${filename}, ${tools.length} tools, `
        + `${Math.round(performance.now() - started)} ms`);
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
      console.log(`Packed npx smoke on ${process.platform}: ${filename}, ${tools.length} tools, example.com taken, `
        + `${Math.round(performance.now() - started)} ms`);
    }
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    await closed;
  }
} finally {
  // On Windows, the first lookup's background price refresh can still hold the package directory open.
  await rm(temp, { recursive: true, force: true, maxRetries: 25, retryDelay: 100 });
}
