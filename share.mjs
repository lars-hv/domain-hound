import { deflateSync } from 'node:zlib';
import { scoreShareVersion, shareDomain, shareName, shareNameLimit, sharePage, shareRecordLimit, shareStatuses, shareUrlLimit,
  shareVerdicts, shareVersion } from './site/r/share-format.mjs';

function cents(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  const rounded = Math.round(value * 100);
  return Number.isSafeInteger(rounded) ? rounded : null;
}

// facts[i] is what the local receipt chose for groups[i], as rows of that group: { pick, value, taken }.
// Only those derived rows travel; the brief, budget, preferred endings and evidence stay local. A finished Name score
// travels as its value and the number of checks not done; its reasons and components stay local.
export function shareUrl(groups, checkedAt, facts = []) {
  const timestamp = Date.parse(checkedAt);
  if (!groups.length || !Number.isFinite(timestamp)) return null;
  const shortlist = [];
  let scored = false;
  for (const [index, { row, records }] of groups.slice(0, shareNameLimit).entries()) {
    if (!records.length || records.length > shareRecordLimit) return null;
    const base = records.length > 1 ? records[0].domain.split('.')[0] : '';
    const endings = [];
    let jumps = 0;
    let cloudflare = 0;
    for (const [position, { domain, status, now, renew, term, jump, dns }] of records.entries()) {
      // Older receipt readers use these status strings at the same wire positions.
      const wireStatus = status === 'Available at the registry' ? 'Free at the registry'
        : status === 'Check at shop, possibly available by DNS' ? 'Check at shop, likely free by DNS' : status;
      const state = shareStatuses.indexOf(wireStatus);
      if (typeof domain !== 'string' || domain.length > 253 || !shareDomain.test(domain) || state < 0) return null;
      const part = domain.startsWith(base + '.') ? domain.slice(base.length) : domain;
      endings.push([part, state, cents(now), cents(renew), term ?? 1]);
      if (jump) jumps += 2 ** position;
      if (dns) cloudflare += 2 ** position;
    }
    const { pick, value, taken = records.filter(record => /^Taken\b/.test(record.status)) } = facts[index] ?? {};
    const rowOf = record => records.indexOf(record);
    const total = value && cents(value.total);
    if ([pick, value, ...taken].some(record => record && rowOf(record) < 0) || (value && total === null)) return null;
    const score = row.score;
    const shareScore = Number.isInteger(score?.value) && score.value >= 0 && score.value <= 100 && !score.pending
      ? [score.value, Math.min(7, Array.isArray(score.notChecked) ? score.notChecked.length : 0)] : null;
    if (shareScore) scored = true;
    const meta = { ...(pick && { p: rowOf(pick) }), ...(value && { b: [rowOf(value), total] }),
      ...(jumps && { j: jumps }), ...(taken.length && { t: taken.map(rowOf) }), ...(cloudflare && { c: cloudflare }),
      ...(shareScore && { s: shareScore }) };
    const display = row.name.trim().normalize('NFC');
    const name = shareName.test(display) ? display : records[0].domain;
    shortlist.push([name, Math.max(0, shareVerdicts.indexOf(row.verdict)), base, endings,
      ...(Object.keys(meta).length ? [meta] : [])]);
  }
  const packed = deflateSync(JSON.stringify([new Date(timestamp).toISOString(), shortlist]), { level: 9 });
  const url = sharePage + '#' + (scored ? scoreShareVersion : shareVersion) + packed.toString('base64url');
  return url.length < shareUrlLimit ? url : null;
}
