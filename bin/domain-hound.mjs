#!/usr/bin/env node
// Domain Hound MCP server over stdio. Runs locally and never buys a domain.
// In the npm package this file is built into one script, which the server also starts with capabilityFlag for each
// lookup; each path loads only its own modules.
import { capabilityFlag } from '../packaged.mjs';

const trace = process.env.DOMAIN_HOUND_STARTUP_TRACE === '1';
const entered = Date.now();
if (process.argv[2] === capabilityFlag) {
  const { main } = await import('../clis/domain-check/index.mjs');
  await main(process.argv.slice(3));
} else {
  const { serve } = await import('../server.mjs');
  // Wall-clock milliseconds for the package smoke's diagnostics: when node started, reached this file and had loaded
  // the server, so a slow cold start can be split into npx, node startup and module loading.
  if (trace) {
    process.stderr.write('domain-hound startup ' + JSON.stringify({ processStart: Math.round(performance.timeOrigin), entered,
      loaded: Date.now() }) + '\n');
  }
  await serve();
}
