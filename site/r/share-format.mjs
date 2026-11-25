// Version 1 stores a timestamp and up to five groups of [name, verdict, domain label, endings].
// A domain starts with a dot when it reuses the group's label. Prices are in integer cents.
export const sharePage = 'https://domainhound.dev/r/';
export const shareUrlLimit = 2000;
export const shareNameLimit = 5;
export const shareRecordLimit = 28;
export const shareVersion = '1.';
export const shareVerdicts = [null, 'No conflict found', 'Check first', 'Avoid'];
export const shareStatuses = [
  'Free at the registry',
  'Confirmed at shop',
  'Taken',
  'Taken, possible resale',
  'Not offered for registration',
  'May be premium, price at shop',
  'Premium, price at shop',
  'Check at shop',
  'Check at shop, likely free by DNS',
  'Check at shop, likely taken by DNS',
  'Still checking',
];

const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const baseLabel = new RegExp('^' + label + '$');
export const shareDomain = new RegExp('^' + label + '(?:\\.' + label + ')+$');
export const shareName = /^[\p{L}\p{N}\p{M}. -]{1,100}$/u;
const maximumInflatedBytes = 24 * 1024;
const isCents = value => value === null || (Number.isSafeInteger(value) && value >= 0);
const dollars = value => value === null ? null : value / 100;

function parseReceipt(receipt) {
  if (!Array.isArray(receipt) || receipt.length !== 2) return null;
  const [checkedAt, groups] = receipt;
  if (typeof checkedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(checkedAt)
      || !Number.isFinite(Date.parse(checkedAt)) || new Date(checkedAt).toISOString() !== checkedAt
      || !Array.isArray(groups) || !groups.length || groups.length > shareNameLimit) return null;
  const parsed = [];
  for (const group of groups) {
    if (!Array.isArray(group) || group.length !== 4) return null;
    const [name, verdict, base, records] = group;
    if (typeof name !== 'string' || !shareName.test(name) || !name.trim() || !Number.isInteger(verdict)
        || verdict < 0 || verdict >= shareVerdicts.length
        || typeof base !== 'string' || (base && !baseLabel.test(base))
        || !Array.isArray(records) || !records.length || records.length > shareRecordLimit) return null;
    const endings = [];
    for (const record of records) {
      if (!Array.isArray(record) || record.length !== 5) return null;
      const [part, status, now, renew, term] = record;
      if (typeof part !== 'string') return null;
      const domain = part.startsWith('.') ? base + part : part;
      if (domain.length > 253 || !shareDomain.test(domain)
          || !Number.isInteger(status) || status < 0 || status >= shareStatuses.length
          || !isCents(now) || !isCents(renew) || !Number.isInteger(term) || term < 1 || term > 10) return null;
      endings.push({ domain, status: shareStatuses[status], now: dollars(now), renew: dollars(renew), term });
    }
    parsed.push({ name, verdict: shareVerdicts[verdict], records: endings });
  }
  return { checkedAt, groups: parsed };
}

export async function readShareFragment(fragment) {
  const prefix = '#' + shareVersion;
  if (typeof fragment !== 'string' || !fragment.startsWith(prefix) || sharePage.length + fragment.length >= shareUrlLimit) return null;
  const encoded = fragment.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const bytes = Uint8Array.from(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')), value => value.charCodeAt(0));
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let size = 0;
      let json = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maximumInflatedBytes) return null;
        json += decoder.decode(value, { stream: true });
      }
      return parseReceipt(JSON.parse(json + decoder.decode()));
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch {
    return null;
  }
}
