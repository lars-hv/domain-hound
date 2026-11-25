import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// Runtime evidence lives in the user's cache, never inside the installed package.
// DOMAIN_HOUND_CACHE_DIR overrides the location (tests point it at a temporary folder).
export function userCacheDir(env = process.env, platform = process.platform, home = homedir()) {
  if (env.DOMAIN_HOUND_CACHE_DIR) return resolve(env.DOMAIN_HOUND_CACHE_DIR);
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'domain-hound');
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'domain-hound', 'Cache');
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'domain-hound');
}

export const cacheDir = pathToFileURL(userCacheDir().replace(/[\\/]*$/, sep));

export async function readCache(directory, filename) {
  if (!directory) return null;
  try {
    return JSON.parse(await readFile(new URL(filename, directory), 'utf8'));
  } catch {
    return null;
  }
}

export async function writeCache(directory, filename, value) {
  if (!directory) return;
  const temp = new URL(filename + '.' + randomUUID() + '.tmp', directory);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, new URL(filename, directory));
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

export async function mapLimit(items, limit, processItem) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await processItem(items[index]);
    }
  }));
  return results;
}

// AbortSignal.any arrived in Node 20.3; this keeps Node 20.0 to 20.2 working.
export function anySignal(signals) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true, signal: controller.signal });
  }
  return controller.signal;
}
