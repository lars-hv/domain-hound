// The npm package is one built script. These tests build it into a temporary folder and check that it runs on its own,
// installs nothing, reads only inlined files, and serves the same tools as the source checkout.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { capabilityArgs, capabilityDir } from './packaged.mjs';
import { buildPackage, inlinedFiles } from './scripts/build.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('./', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const messages = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'package-test', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'naming_guide', arguments: {} } },
];

function exchange(script, cwd) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [script], {
      cwd, timeout: 10_000, env: { ...process.env, DOMAIN_HOUND_LOCAL: '1', DOMAIN_HOUND_OPEN: 'off', DOMAIN_HOUND_STARTUP_TRACE: '' },
    }, (error, stdout) => {
      if (error) return reject(error);
      const replies = new Map(stdout.trim().split('\n').map(line => JSON.parse(line)).map(reply => [reply.id, reply.result]));
      resolve(replies);
    });
    child.stdin.end(messages.map(message => JSON.stringify(message)).join('\n') + '\n');
  });
}

let built;
const packaged = async t => {
  built ??= (async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'hound-package-'));
    return { outDir, ...await buildPackage({ outDir }) };
  })();
  const result = await built;
  return result;
};
test.after(async () => { if (built) await rm((await built).outDir, { recursive: true, force: true }); });

test('the packaged script runs alone from an empty folder with the same tools, version and capability', async t => {
  const { outfile, imports } = await packaged(t);
  const alone = await mkdtemp(join(tmpdir(), 'hound-alone-'));
  t.after(() => rm(alone, { recursive: true, force: true }));
  const script = join(alone, 'domain-hound.mjs');
  await copyFile(outfile, script);
  const text = await readFile(script, 'utf8');
  assert.match(text, /^#!\/usr\/bin\/env node\n/);
  // Zero runtime dependencies: the script imports only Node built-ins. The optional Playwright fallback is a computed
  // import, resolved from the user's project as before.
  assert.ok(imports.length > 0);
  assert.deepEqual(imports.filter(specifier => !isBuiltin(specifier)), []);

  const [fromPackage, fromSource] = await Promise.all([exchange(script, alone), exchange(join(root, 'bin/domain-hound.mjs'), alone)]);
  assert.deepEqual(fromPackage.get(1), fromSource.get(1));
  assert.equal(fromPackage.get(1).serverInfo.version, pkg.version);
  assert.deepEqual(fromPackage.get(2), fromSource.get(2), 'tool names, schemas and annotations are unchanged');
  assert.deepEqual(fromPackage.get(3), fromSource.get(3));

  // The server starts the capability as this same script with the capability flag.
  const options = { cwd: alone, env: { ...process.env, DOMAIN_HOUND_OPEN: 'off' } };
  const [capability, source] = await Promise.all([
    run(process.execPath, [script, '--domain-hound-capability', '--naming-method', '--about', 'a tide clock'], options),
    run(process.execPath, [join(root, 'clis/domain-check/index.mjs'), '--naming-method', '--about', 'a tide clock'], options),
  ]);
  assert.equal(capability.stdout, source.stdout);
  assert.match(capability.stdout, /^Naming recipe/);
});

test('every file the code reads at run time is inlined, and no bundled module reads beside itself', async t => {
  const { inputs, noticesFile } = await packaged(t);
  const ownModules = inputs.filter(path => !path.startsWith('node_modules/'));
  assert.ok(ownModules.includes('server.mjs') && ownModules.includes('clis/domain-check/index.mjs'));
  assert.ok(inputs.some(path => path.startsWith('node_modules/parse5/')), 'parse5 is bundled');
  const read = new Set();
  for (const path of ownModules) {
    const source = await readFile(join(root, path), 'utf8');
    for (const [, file] of source.matchAll(/\bpackage(?:File|Json)\('([^']+)'\)/g)) read.add(file);
    for (const [, file] of source.matchAll(/\basset\('([^']+)'\)/g)) read.add('assets/' + file);
    if (path === 'packaged.mjs') continue;
    // A file read or child process relative to import.meta.url would point beside the one packaged script.
    const uses = source.match(/import\.meta\.url/g) ?? [];
    const entryChecks = source.match(/isEntry\(import\.meta\.url\)/g) ?? [];
    assert.equal(uses.length, entryChecks.length, path + ' resolves a path from import.meta.url; use packaged.mjs');
  }
  assert.deepEqual([...read].sort(), [...inlinedFiles].sort());
  for (const path of inlinedFiles) await readFile(join(root, path));
  const notices = await readFile(noticesFile, 'utf8');
  for (const part of ['parse5@', 'entities@', 'SIL Open Font License', 'Creative Commons Attribution 4.0']) assert.ok(notices.includes(part), part);
});

test('the source checkout runs the capability from its own folder', () => {
  assert.equal(capabilityDir, join(root, 'clis/domain-check/'));
  assert.deepEqual(capabilityArgs(['--refresh-prices']), [join(root, 'clis/domain-check/index.mjs'), '--refresh-prices']);
});

test('the package installs nothing and the smoke keeps its hard cold-start ceilings', async () => {
  assert.equal(pkg.bin['domain-hound'], 'dist/domain-hound.mjs');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.bundleDependencies, undefined);
  for (const script of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(pkg.scripts[script], undefined, script);
  assert.equal(pkg.scripts.prepack, 'node scripts/build.mjs');
  const smoke = await readFile(join(root, 'scripts/package-smoke.mjs'), 'utf8');
  assert.match(smoke, /const ceiling = \(value, max\) => Math\.min\(max, Number\(value\) \|\| max\);/);
  assert.match(smoke, /ceiling\(process\.env\.PACKAGE_SMOKE_MAX_INIT_MS, 30_000\)/);
  assert.match(smoke, /ceiling\(process\.env\.PACKAGE_SMOKE_MAX_LOOKUP_MS, 15_000\)/);
});
