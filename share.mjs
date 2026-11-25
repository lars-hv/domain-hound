import { deflateSync } from 'node:zlib';
import { shareDomain, shareName, shareNameLimit, sharePage, shareRecordLimit, shareStatuses, shareUrlLimit,
  shareVerdicts, shareVersion } from './site/r/share-format.mjs';

function cents(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  const rounded = Math.round(value * 100);
  return Number.isSafeInteger(rounded) ? rounded : null;
}

export function shareUrl(groups, checkedAt) {
  const timestamp = Date.parse(checkedAt);
  if (!groups.length || !Number.isFinite(timestamp)) return null;
  const shortlist = [];
  for (const { row, records } of groups.slice(0, shareNameLimit)) {
    if (!records.length || records.length > shareRecordLimit) return null;
    const base = records.length > 1 ? records[0].domain.split('.')[0] : '';
    const endings = [];
    for (const { domain, status, now, renew, term } of records) {
      const state = shareStatuses.indexOf(status);
      if (typeof domain !== 'string' || domain.length > 253 || !shareDomain.test(domain) || state < 0) return null;
      const part = domain.startsWith(base + '.') ? domain.slice(base.length) : domain;
      endings.push([part, state, cents(now), cents(renew), term ?? 1]);
    }
    const display = row.name.trim().normalize('NFC');
    const name = shareName.test(display) ? display : records[0].domain;
    shortlist.push([name, Math.max(0, shareVerdicts.indexOf(row.verdict)), base, endings]);
  }
  const packed = deflateSync(JSON.stringify([new Date(timestamp).toISOString(), shortlist]), { level: 9 });
  const url = sharePage + '#' + shareVersion + packed.toString('base64url');
  return url.length < shareUrlLimit ? url : null;
}
