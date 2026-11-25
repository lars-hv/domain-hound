import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Quotes, DNS plans, order claims and receipts survive restarts. They live outside the package and outside the cache,
// which may be cleared. DOMAIN_HOUND_PURCHASE_DIR moves them (tests use a temporary folder).
export function purchaseDir(env = process.env) {
  return env.DOMAIN_HOUND_PURCHASE_DIR ? resolve(env.DOMAIN_HOUND_PURCHASE_DIR) : join(homedir(), '.domain-hound', 'purchases');
}

const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);

// An ID that binds the record: a changed file no longer matches its ID.
export function boundId(prefix, fields, nonce = randomBytes(12).toString('hex')) {
  return { id: prefix + createHash('sha256').update(nonce + canonical(fields)).digest('hex').slice(0, 20), nonce };
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

const safeId = id => typeof id === 'string' && /^[a-z]{3}-[0-9a-f]{20}$/.test(id);

export function stateStore(directory = purchaseDir()) {
  const folder = async name => {
    const path = join(directory, name);
    await mkdir(path, { recursive: true, mode: 0o700 });
    return path;
  };
  async function writePrivate(path, value) {
    const temp = path + '.' + randomBytes(6).toString('hex') + '.tmp';
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await rename(temp, path);
  }
  async function readJson(name, id) {
    if (!safeId(id)) return null;
    try { return JSON.parse(await readFile(join(directory, name, id + '.json'), 'utf8')); } catch { return null; }
  }
  return {
    directory,
    // Bound records: quotes and DNS plans. A record whose fields no longer match its ID reads as missing.
    async saveBound(name, prefix, fields) {
      const { id, nonce } = boundId(prefix, fields);
      await writePrivate(join(await folder(name), id + '.json'), { id, nonce, ...fields });
      return { id, ...fields };
    },
    async readBound(name, prefix, id) {
      if (typeof id !== 'string' || !id.startsWith(prefix)) return null;
      const record = await readJson(name, id);
      if (!record) return null;
      const { id: stored, nonce, ...fields } = record;
      return stored === id && boundId(prefix, fields, nonce).id === id ? { id, ...fields } : null;
    },
    // One durable claim per key. The exclusive create makes a second caller fail, also across processes and restarts.
    async claim(key, fields) {
      if (!safeId(key)) throw Error('Invalid claim key.');
      const path = join(await folder('claims'), key + '.json');
      let handle;
      try {
        handle = await open(path, 'wx', 0o600);
      } catch (error) {
        if (error.code === 'EEXIST') return null;
        throw error;
      }
      try { await handle.writeFile(JSON.stringify({ key, ...fields }, null, 2) + '\n'); } finally { await handle.close(); }
      return { key, ...fields };
    },
    // A claim file that exists but cannot be read (say, after a crash mid-write) still counts as sent.
    async readClaim(key) {
      if (!safeId(key)) return null;
      const record = await readJson('claims', key);
      if (record) return record;
      try {
        await readFile(join(directory, 'claims', key + '.json'));
        return { status: 'unresolved' };
      } catch {
        return null;
      }
    },
    async updateClaim(key, fields) {
      const current = await readJson('claims', key);
      await writePrivate(join(await folder('claims'), key + '.json'), { ...current, ...fields });
    },
    release: key => safeId(key) ? unlink(join(directory, 'claims', key + '.json')).catch(() => {}) : Promise.resolve(),
    async saveReceipt(receipt) {
      const path = join(await folder('receipts'), receipt.domain + '-' + receipt.at.replaceAll(/[:.]/g, '-') + '.json');
      await writePrivate(path, receipt);
      return path;
    },
  };
}
