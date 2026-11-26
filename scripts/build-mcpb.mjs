import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const plugin = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const filename = `domain-hound-${pkg.version}.mcpb`;
const entry = 'server.mjs';
const buildEnv = { ...process.env, TZ: 'UTC' };
const epoch = new Date('2000-01-01T00:00:00Z');

async function bundleFiles(directory, prefix = '') {
  const paths = [];
  for (const item of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix + item.name;
    if (path === 'node_modules/.package-lock.json') continue;
    if (item.isDirectory()) paths.push(...await bundleFiles(directory, path + '/'));
    else if (item.isFile()) paths.push(path);
  }
  return paths;
}

await mkdir(dist, { recursive: true });
const staging = await mkdtemp(join(dist, '.mcpb-'));
try {
  const bundle = join(staging, 'bundle');
  await mkdir(bundle);
  // Reuse the npm allowlist for runtime files and exclude distribution metadata.
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root, encoding: 'utf8',
  }));
  const paths = pack.files.map(file => file.path).filter(path =>
    ['package.json', 'README.md', 'LICENSE', entry, 'display.mjs', 'results.mjs', 'results-cards.mjs', 'results-style.mjs', 'share.mjs',
      'hosted.mjs', 'hosted-results.mjs',
      'site/r/share-format.mjs', 'watch.mjs', 'dossier.mjs'].includes(path)
    || /^(?:assets|clis|bin)\//.test(path));
  for (const path of [...paths, 'package-lock.json']) {
    const target = join(bundle, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, path), target);
  }
  execFileSync('npm', ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: bundle, stdio: ['ignore', 'inherit', 'inherit'],
  });
  const manifest = {
    manifest_version: '0.3',
    name: pkg.name,
    display_name: 'Domain Hound',
    version: pkg.version,
    description: plugin.description,
    author: plugin.author,
    homepage: pkg.homepage,
    repository: { type: 'git', url: pkg.repository.url.replace(/^git\+/, '') },
    support: pkg.bugs.url,
    license: pkg.license,
    icon: 'assets/icon-512.png',
    server: {
      type: 'node',
      entry_point: entry,
      mcp_config: { command: 'node', args: ['${__dirname}/' + entry] },
    },
    compatibility: { runtimes: { node: pkg.engines.node } },
  };
  await writeFile(join(bundle, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const files = (await bundleFiles(bundle)).sort();
  for (const path of files) {
    const fullPath = join(bundle, path);
    const { mode } = await stat(fullPath);
    await chmod(fullPath, mode & 0o111 ? 0o755 : 0o644);
    await utimes(fullPath, epoch, epoch);
  }
  const archive = join(staging, filename);
  // Stable paths, metadata and compression let the same build reproduce the registry checksum.
  execFileSync('zip', ['-X', '-q', '-9', archive, '-@'], {
    cwd: bundle, env: buildEnv, input: files.join('\n') + '\n',
  });
  const fileSha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  await rename(archive, join(dist, filename));
  console.log(JSON.stringify({ path: 'dist/' + filename, fileSha256 }));
} finally {
  await rm(staging, { recursive: true, force: true });
}
