import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Import this first in every test file. It points the runtime cache at a throwaway folder, so tests never write
// into the package or the real user cache. Child processes inherit the variable.
if (!process.env.DOMAIN_HOUND_CACHE_DIR) {
  const directory = mkdtempSync(join(tmpdir(), 'domain-hound-test-cache-'));
  process.env.DOMAIN_HOUND_CACHE_DIR = directory;
  process.env.DOMAIN_HOUND_RESULTS_DIR ??= join(directory, 'results');
  process.env.DOMAIN_HOUND_OPEN ??= 'off';
  process.env.DOMAIN_HOUND_PURCHASE_DIR ??= join(directory, 'purchases');
  process.env.DOMAIN_HOUND_PORTFOLIO_FILE ??= join(directory, 'portfolio.json');
  process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
}
