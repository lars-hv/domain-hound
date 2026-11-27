// Builds the npm package's one executable: dist/domain-hound.mjs holds the server, the capability it starts for each
// lookup, parse5 and every file they read at run time, so a cold npx unpacks a handful of files and installs nothing.
// dist/THIRD-PARTY-NOTICES.txt carries the licenses of the bundled code, font and word list.
// npm runs this before every pack and publish (prepack); the source checkout runs without it.
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));

// Every path that packageFile or packageJson reads, from the repository root.
export const inlinedFiles = [
  'package.json',
  'assets/icon.svg',
  'assets/mulish-OFL.txt',
  'assets/mulish-latin-wght-normal.woff2',
  'assets/results.css',
  'clis/domain-check/meaning-words.json',
  'clis/domain-check/price-snapshot.json',
  'clis/domain-check/terms.json',
];

async function inline(path) {
  const data = await readFile(join(root, path));
  if (path === 'package.json') {
    // The server reads only its version; the rest of package.json ships beside the script anyway.
    const { name, version } = JSON.parse(data);
    return { text: JSON.stringify({ name, version }) };
  }
  if (path.endsWith('.json')) return { text: JSON.stringify(JSON.parse(data)) };
  if (/\.(?:css|svg|txt)$/.test(path)) return { text: data.toString('utf8') };
  return { base64: data.toString('base64') };
}

// The licenses of the npm packages in the bundle, then the font and the word list.
async function notices(metafile) {
  const packages = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const match = input.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//);
    if (match) packages.add(match[1]);
  }
  const sections = [];
  for (const name of [...packages].sort()) {
    const folder = join(root, 'node_modules', name);
    const { version, license } = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'));
    sections.push(`${name}@${version} (${license})\n\n${(await readFile(join(folder, 'LICENSE'), 'utf8')).trim()}`);
  }
  sections.push('Mulish font, embedded in result pages\n\n' + (await readFile(join(root, 'assets/mulish-OFL.txt'), 'utf8')).trim());
  sections.push((await readFile(join(root, 'clis/domain-check/meaning-words.LICENSE.txt'), 'utf8')).trim());
  return 'Domain Hound bundles the following third-party material in domain-hound.mjs.\n\n'
    + sections.join('\n\n' + '-'.repeat(78) + '\n\n') + '\n';
}

// Writes domain-hound.mjs and THIRD-PARTY-NOTICES.txt to outDir (the tests build into a temporary folder).
export async function buildPackage({ outDir = join(root, 'dist') } = {}) {
  const outfile = join(outDir, 'domain-hound.mjs');
  const noticesFile = join(outDir, 'THIRD-PARTY-NOTICES.txt');
  const files = {};
  for (const path of inlinedFiles) files[path] = await inline(path);
  await mkdir(outDir, { recursive: true });
  await rm(outfile, { force: true });
  const { metafile } = await build({
    absWorkingDir: root,
    entryPoints: ['bin/domain-hound.mjs'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    define: { DOMAIN_HOUND_INLINED: JSON.stringify(files) },
    // Function and class names stay as written.
    minify: true,
    keepNames: true,
    legalComments: 'none',
    metafile: true,
    logLevel: 'error',
  });
  await chmod(outfile, 0o755);
  await writeFile(noticesFile, await notices(metafile));
  // Source files in the bundle, and what the script still imports at run time (Node built-ins only).
  const inputs = Object.keys(metafile.inputs).filter(path => !path.startsWith('<'));
  const imports = Object.values(metafile.outputs).flatMap(output => output.imports.map(({ path }) => path));
  return { outfile, noticesFile, inputs, imports };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { outfile: script, inputs } = await buildPackage();
  // stderr, so `npm pack --json` keeps clean JSON on stdout.
  console.error(`Built ${script.slice(root.length)} from ${inputs.length} modules.`);
}
