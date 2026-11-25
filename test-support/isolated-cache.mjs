import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Import this first in every test file. It points the runtime cache at a throwaway folder, so tests never write
// into the package or the real user cache. Child processes inherit the variable.
if (!process.env.DOMAIN_HOUND_CACHE_DIR) {
  const directory = mkdtempSync(join(tmpdir(), 'domain-hound-test-cache-'));
  process.env.DOMAIN_HOUND_CACHE_DIR = directory;
  process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
}
