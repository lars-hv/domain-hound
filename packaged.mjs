// Where Domain Hound finds its own files and its capability at run time.
// The npm package ships one script built by scripts/build.mjs: the build inlines the files read here and defines
// DOMAIN_HOUND_INLINED, and the capability runs as that same script with capabilityFlag. A source checkout reads the
// files from disk and runs clis/domain-check/index.mjs.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* global DOMAIN_HOUND_INLINED */
const inlined = typeof DOMAIN_HOUND_INLINED === 'undefined' ? null : DOMAIN_HOUND_INLINED;

export const bundled = inlined !== null;
export const capabilityFlag = '--domain-hound-capability';

// A package file by its path from the repository root.
export function packageFile(path) {
  if (!inlined) return readFileSync(new URL('./' + path, import.meta.url));
  if (!Object.hasOwn(inlined, path)) throw new Error('The package build did not inline ' + path);
  const { text, base64 } = inlined[path];
  return Buffer.from(text ?? base64, text === undefined ? 'base64' : 'utf8');
}

export const packageJson = path => JSON.parse(packageFile(path).toString('utf8'));

// The working directory of a capability run: the capability's folder, or the packaged script's own folder.
export const capabilityDir = fileURLToPath(new URL(bundled ? './' : './clis/domain-check/', import.meta.url));

// Arguments for process.execPath that run the capability with args.
export const capabilityArgs = args => bundled
  ? [fileURLToPath(import.meta.url), capabilityFlag, ...args]
  : [fileURLToPath(new URL('./clis/domain-check/index.mjs', import.meta.url)), ...args];

// Whether a source module was started directly with node. Inside the packaged script every module shares one URL,
// so only the bin entry dispatches there.
export const isEntry = url => !bundled && Boolean(process.argv[1]) && url === pathToFileURL(process.argv[1]).href;
