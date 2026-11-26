import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { scoreVersion } from './name-score.mjs';

// Local Name score calibration log, off by default. With DOMAIN_HOUND_SCORE_LOG=1 each shown, scored name appends one
// line to ~/.domain-hound/score-log.jsonl: component points, weights version, rank, band, which checks were not done,
// and later whether it was picked. Nothing leaves the machine. The name is written only with
// DOMAIN_HOUND_SCORE_LOG_NAMES=1; the brief, domains, reasons and evidence never are.
export function scoreLogger({ env = process.env, file = join(homedir(), '.domain-hound', 'score-log.jsonl'), now = () => new Date() } = {}) {
  const enabled = env.DOMAIN_HOUND_SCORE_LOG === '1';
  const withNames = env.DOMAIN_HOUND_SCORE_LOG_NAMES === '1';
  // DNS label -> log id, for this server session only, so a later pick can point back without the name.
  const shown = new Map();
  const picked = new Set();
  let writes = Promise.resolve();
  const write = entries => {
    if (!entries.length) return writes;
    const text = entries.map(entry => JSON.stringify(entry) + '\n').join('');
    writes = writes.then(async () => {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await appendFile(file, text, { mode: 0o600 });
      await chmod(file, 0o600).catch(() => {});
    }).catch(() => {});
    return writes;
  };
  return {
    enabled,
    // rows: [{ label, name, score }] in rank order, scored and not filtered.
    shown(rows) {
      if (!enabled) return Promise.resolve();
      const at = now().toISOString();
      return write(rows.flatMap((row, rank) => {
        const score = row.score;
        if (!Number.isInteger(score?.value) || !score.components) return [];
        const id = randomUUID();
        if (row.label) shown.set(row.label, id);
        return [{ event: 'shown', at, id, weights: score.version ?? scoreVersion, rank: rank + 1, value: score.value, band: score.band,
          components: score.components, unknown: score.unknown ?? [], notChecked: (score.notChecked ?? []).length,
          ...(score.recipe && { recipe: score.recipe }), ...(withNames && typeof row.name === 'string' && { name: row.name }) }];
      }));
    },
    // The person explicitly chose a domain whose label was shown in this session.
    picked(domain, via) {
      if (!enabled || typeof domain !== 'string') return Promise.resolve();
      const id = shown.get(domain.toLowerCase().split('.')[0]);
      if (!id || picked.has(id + via)) return Promise.resolve();
      picked.add(id + via);
      return write([{ event: 'picked', at: now().toISOString(), id, weights: scoreVersion, via }]);
    },
    flush: () => writes,
  };
}
