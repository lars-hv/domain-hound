import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userCacheDir } from '../clis/domain-check/cache.mjs';
import { listedPrices, targetEndings, validCatalog } from '../clis/domain-check/price-catalog.mjs';

// Copies the local first-party list price cache into the package as the dated snapshot for fresh installs.
// It reads only prices.json; no other cache file is ever bundled.
const source = join(userCacheDir(), 'prices.json');
const target = fileURLToPath(new URL('../clis/domain-check/price-snapshot.json', import.meta.url));
const catalog = JSON.parse(await readFile(source, 'utf8'));
if (!validCatalog(catalog)) throw new Error('The cached price catalog is not valid.');
const missing = targetEndings.filter(tld => !listedPrices(catalog, tld).length);
if (missing.length) throw new Error('The cached price catalog has no price for .' + missing.join(', .'));
await writeFile(target, JSON.stringify({ checkedAt: catalog.checkedAt,
  ...(catalog.catalogs ? { catalogs: catalog.catalogs } : { prices: catalog.prices }) }, null, 2) + '\n');
console.log('Snapshot from ' + catalog.checkedAt.slice(0, 10) + ' written for ' + targetEndings.length + ' endings.');
