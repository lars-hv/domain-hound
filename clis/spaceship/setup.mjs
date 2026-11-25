import { apiRecord, planChanges, planLifetimeMs, planText, presentIn, recordText, sameChanges } from './dns.mjs';

// DNS records only take effect when the domain uses Spaceship's own (basic) nameservers.
async function hostedHere(client, domain) {
  let info;
  try {
    info = await client.info(domain);
  } catch (problem) {
    if (problem.status === 404) return domain + ' is not in this Spaceship account.';
    throw problem;
  }
  if (info?.name !== domain) return 'Spaceship did not verify the domain ' + domain + '.';
  if (info.nameservers?.provider !== 'basic') {
    const hosts = Array.isArray(info?.nameservers?.hosts) ? info.nameservers.hosts.join(', ') : '';
    return domain + ' uses custom nameservers' + (hosts ? ' (' + hosts + ')' : '') + ', so Spaceship DNS records would not take effect. '
      + 'Domain Hound does not change nameservers. Set the records where your DNS is hosted.';
  }
  return null;
}

// Preview: read the domain and its records, then list every exact change. Nothing is written.
export async function previewSetup(domain, choices, { client, store, now = new Date() }) {
  const notHere = await hostedHere(client, domain);
  if (notHere) return { ok: false, say: notHere };
  const plan = planChanges(domain, choices, await client.dnsRecords(domain));
  if (plan.blocks.length || (!plan.adds.length && !plan.deletes.length)) {
    return { ok: !plan.blocks.length, plan, say: planText(domain, plan) };
  }
  const expiresAt = new Date(now.getTime() + planLifetimeMs).toISOString();
  const saved = await store.saveBound('plans', 'dhp-', { domain, accountBinding: client.accountBinding, choices, adds: plan.adds, deletes: plan.deletes,
    recordsDigest: plan.recordsDigest, createdAt: now.toISOString(), expiresAt });
  return { ok: true, planId: saved.id, expiresAt, plan, say: planText(domain, plan, { planId: saved.id, expiresAt }) };
}

// Apply a previewed plan: recheck it against the live records, delete only the listed custom records when replace is
// true, add with force false, then read everything back.
export async function applySetup(domain, { planId, replace = false }, { client, store, now = () => new Date() }) {
  const stored = await store.readBound('plans', 'dhp-', planId);
  if (!stored || stored.domain !== domain || stored.accountBinding !== client.accountBinding) {
    return { ok: false, say: 'No valid DNS plan with that ID for ' + domain + ' and this Spaceship key. Preview again.' };
  }
  const expired = () => now().getTime() >= Date.parse(stored.expiresAt);
  if (expired()) return { ok: false, say: 'Plan ' + planId + ' expired. Preview again.' };
  if (stored.deletes.length && replace !== true) {
    return { ok: false, say: ['This plan removes ' + stored.deletes.length + ' record' + (stored.deletes.length === 1 ? '' : 's') + ':',
      ...stored.deletes.map(row => '- ' + recordText(row)),
      'Nothing changed. After the person agrees to remove them, call again with replace: true.'].join('\n') };
  }
  const notHere = await hostedHere(client, domain);
  if (notHere) return { ok: false, say: notHere };
  const fresh = planChanges(domain, stored.choices, await client.dnsRecords(domain));
  if (expired()) return { ok: false, say: 'Plan ' + planId + ' expired during the DNS check. Preview again.' };
  if (fresh.blocks.length || fresh.recordsDigest !== stored.recordsDigest || !sameChanges(fresh, stored)) {
    return { ok: false, say: 'DNS for ' + domain + ' changed since the preview. Nothing changed. Preview again.' };
  }
  let writeProblem = false;
  try {
    if (stored.deletes.length) await client.deleteRecords(domain, stored.deletes.map(apiRecord));
    if (stored.adds.length) await client.saveRecords(domain, stored.adds.map(row => ({ ...apiRecord(row), ttl: row.ttl })));
  } catch {
    writeProblem = true;
  }
  const records = await client.dnsRecords(domain).catch(() => null);
  if (!records) return { ok: false, say: 'Spaceship could not verify the DNS write for ' + domain + '. Preview again to check the current records.' };
  const present = presentIn(records, domain);
  const missing = stored.adds.filter(row => !present(row));
  const lingering = stored.deletes.filter(row => present(row));
  const lines = [domain + ' DNS updated.',
    ...stored.adds.map(row => (present(row) ? 'Added: ' : 'Not found after save: ') + recordText(row)),
    ...stored.deletes.map(row => (present(row) ? 'Still present: ' : 'Removed: ') + recordText(row))];
  if (missing.length || lingering.length) {
    lines[0] = domain + ' DNS update is incomplete. The readback differs from the plan.';
    if (writeProblem) lines.push('Spaceship reported a write problem.');
    lines.push('Preview again for the current records.');
  } else lines.push('Readback matches the plan. DNS caches take time to update.');
  return { ok: !missing.length && !lingering.length, say: lines.join('\n') };
}
