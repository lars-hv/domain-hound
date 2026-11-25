// Progress events for the MCP server while a lookup runs: one stderr line each, only when the server asks.
// Events: { domain, status } per registry answer, and { stage } for the step after the registry checks.
export const progressPrefix = 'domain-hound-progress ';

export function progressReporter(env = process.env, stream = process.stderr) {
  if (env.DOMAIN_HOUND_PROGRESS !== '1') return undefined;
  return event => {
    try {
      stream.write(progressPrefix + JSON.stringify(event) + '\n');
    } catch {
      // Progress is optional; the lookup result never depends on it.
    }
  };
}
