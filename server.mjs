import { geoInstruction, googleSearchInstruction, namingRecipe, showAsIs } from './clis/domain-check/naming-method.mjs';
import { defaultEndings, normalizeName, restrictedEndings, validEligibility } from './clis/domain-check/name-search.mjs';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { progressPrefix } from './clis/domain-check/progress.mjs';
import { attributed, checkText, errorText, progressText, triageText } from './display.mjs';

// The capability ships inside the package; tests inject another directory through serve({ cwd }).
export const capabilityDir = fileURLToPath(new URL('./clis/domain-check/', import.meta.url));
// One version for the server, package and manifests; the release workflow checks the tag against it.
const serverVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
// Each call answers within this budget, leaving a second under the clients' 15-second limit for formatting and
// transport. A lookup that needs longer keeps running, and a repeated call with the same input collects it.
const timeoutMs = 14_000;
// A lookup still running after this long is stopped.
const maxLookupMs = 120_000;
// A finished lookup whose caller already had a progress answer waits this long for the repeated call.
const keepFinishedMs = 120_000;
const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const entryPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.(?:[A-Za-z]{2,63}|[xX][nN]--[A-Za-z0-9](?:[A-Za-z0-9-]{0,57}[A-Za-z0-9])?))?$/;
const nameSchema = { type: 'string', minLength: 1, maxLength: 127, pattern: entryPattern.source };
const endingsSchema = {
  type: 'array', minItems: 1, maxItems: 10, uniqueItems: true,
  items: { type: 'string', enum: defaultEndings },
  description: 'Optional preferences in display order. Bare names always check and show all ten default endings, including .ai. Omit when no preference was given.',
};
const lookupProperties = {
  ai: { type: 'boolean', description: 'Legacy option. .ai is now included by default.' },
  endings: endingsSchema,
  eligible: { type: 'array', uniqueItems: true, items: { type: 'string', enum: restrictedEndings },
    description: 'Restricted endings the buyer qualifies to register. Pass ["no"] only when the buyer qualifies for .no.' },
};
const checkTool = {
  name: 'check_domains',
  description: showAsIs + ' '
    + 'For any request to buy or register, pass purchase: true and explicitly say “Domain Hound cannot buy or complete checkout,” even when the domain is taken. '
    + 'Input: query for one name or exact domain ({"query":"oakenroom.me"}), or names for 1 to 20 names in one call ({"names":["oakenroom","oakenroom.me"]}). A bare name checks ten endings, including .ai. '
    + 'For a batch, make one call and report check-at-shop endings as returned. Recheck only when the person asks. '
    + 'Set confirm true only when the person asks for a live shop check (slower). '
    + 'Prices are list prices unless marked confirmed at a shop; premium names show the shop price or "premium, price at shop". Look up alternatives only if asked. For new names, call naming_method first; to screen an existing name, use triage_names. With shortlist true, pass one DNS label per name (Quiet Otter becomes quietotter).',
  inputSchema: {
    type: 'object',
    properties: {
      ...lookupProperties,
      query: { ...nameSchema,
        description: 'One name or exact domain, e.g. "oakenroom.me" or "oakenroom". Supply either query or names.' },
      names: { type: 'array', minItems: 1, maxItems: 20,
        items: nameSchema,
        description: '1 to 20 bare names, exact domains or both, e.g. ["oakenroom","quietbook","oakenroom.me"]. Use one DNS label for a bare name, with no spaces or dots. A dot means an exact domain. Supply either names or query.' },
      shortlist: { type: 'boolean', description: 'Use true for the preliminary bare-name batch specified by naming_method.' },
      purchase: { type: 'boolean', description: 'Pass true when asked to buy or register, even for an exact domain that may be taken. State the checkout limitation from the display in the answer.' },
      confirm: { type: 'boolean', description: 'True only when the person explicitly asks for a live shop check. Uses an optional headless browser and is slower.' },
    },
    additionalProperties: false,
    oneOf: [{ required: ['query'] }, { required: ['names'] }],
  },
};

const legacyTool = { ...checkTool, name: 'broker_find',
  description: showAsIs + ' Legacy alias for Domain Hound check_domains, same input. Never buys.' };

const triageTool = {
  name: 'triage_names',
  description: showAsIs + ' '
    + 'Use to screen 1 to 20 product names, or once with a bare name when asked whether an existing name is safe: {"names":["Quiet Otter","Hush Room"],"about":"book quiet meeting rooms"}. Checks same-name rivals and their traction, live US marks, iOS and Android apps, handles and every domain ending, including .ai. '
    + 'Verdicts weigh each same-name rival by its traction: a strong rival (David vs Goliath) or a same-business rival with traction means Avoid; small or dormant same-name uses are notes that never lower the verdict. '
    + 'Fill geo for every name from your own memory before calling. ' + googleSearchInstruction + ' Let the person choose.',
  inputSchema: {
    type: 'object',
    properties: {
      ...lookupProperties,
      names: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 100 },
        description: '1 to 20 bare names without endings, e.g. ["Quiet Otter","Hush Room"].' },
      purchase: { type: 'boolean', description: 'True when the person asks to buy or register a domain.' },
      category: { type: 'string', minLength: 1, maxLength: 100, description: 'Category for relevant trademark classes and competitors. Use travel, software, finance, retail, health, education, food or media.' },
      about: { type: 'string', minLength: 1, maxLength: 160, description: 'A short description of what your product does, to identify overlapping sites and apps.' },
      geo: { type: 'object', maxProperties: 20,
        additionalProperties: { type: 'string', minLength: 1, maxLength: 160, pattern: '^\\s*(?:[Kk]nown\\b.*\\S.*|[Uu]nknown)\\s*$' },
        description: geoInstruction + ' Example: {"ExampleBoard":"known: a team notes workspace","QuietOtter":"unknown"}.' },
    },
    required: ['names'],
    additionalProperties: false,
  },
};

const namingTool = {
  name: 'naming_method',
  description: 'Get the Domain Hound naming recipe for new names. For an existing name, use triage_names. The recipe and preliminary check are intermediate. For the final triage result, copy the tool display as written.',
  inputSchema: { type: 'object', properties: {
    about: { type: 'string', minLength: 1, maxLength: 512, description: 'An optional one-sentence product description.' },
  }, additionalProperties: false },
};

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// The person sees one text block: the display. The structured result repeats the display first, then the fields.
function toolResult(json, isError = false) {
  const structured = JSON.parse(json);
  return { content: [{ type: 'text', text: structured.display }], structuredContent: structured, isError };
}
const errorResult = message => toolResult(errorText(message), true);

const showValue = value => JSON.stringify(String(value).slice(0, 40));

function queryValue(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('query is empty. Enter one name or exact domain in query, such as oakenroom or oakenroom.me.');
  }
  const query = value.toLowerCase();
  if (!entryPattern.test(query)) {
    throw new Error('query ' + showValue(value) + ' is not valid. Give a name like oakenroom or a domain like oakenroom.me in query.');
  }
  return query;
}

function batchNames(names) {
  if (!Array.isArray(names) || names.length < 1 || names.length > 20) {
    throw new Error('names must list 1 to 20 names or domains' + (Array.isArray(names) ? '; it has ' + names.length : '')
      + '. Split a longer list into batches of up to 20.');
  }
  return names.map((value, index) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error('names[' + index + '] is empty. Use a bare name such as oakenroom or an exact domain such as oakenroom.me.');
    }
    const name = value.toLowerCase();
    if (!entryPattern.test(name)) {
      throw new Error('names[' + index + '] ' + showValue(value) + ' is not valid. Give a name like oakenroom or a domain like oakenroom.me in names.');
    }
    return name;
  });
}

function lookupFlags(args) {
  const flags = [];
  if (Object.hasOwn(args, 'eligible')) {
    if (!validEligibility(args.eligible)) throw new Error('Eligible endings must list supported restricted endings, such as no.');
    if (args.eligible.length) flags.push('--eligible', args.eligible.join(','));
  }
  if (Object.hasOwn(args, 'ai') && typeof args.ai !== 'boolean') throw new Error('ai must be a boolean.');
  if (args.ai) flags.push('--ai');
  for (const flag of ['purchase', 'confirm']) {
    if (Object.hasOwn(args, flag) && typeof args[flag] !== 'boolean') throw new Error(flag + ' must be a boolean.');
  }
  // The headless browser runs only on this explicit request.
  if (args.confirm === true) flags.push('--confirm');
  if (Object.hasOwn(args, 'endings')) {
    const endings = args.endings;
    if (!Array.isArray(endings) || endings.length < 1 || endings.length > 10 ||
        new Set(endings).size !== endings.length || endings.some(ending => !endingsSchema.items.enum.includes(ending))) {
      throw new Error('Choose supported domain endings.');
    }
  }
  return flags;
}

function cliArguments(args) {
  if (!isObject(args) || Object.keys(args).some(key => !Object.hasOwn(checkTool.inputSchema.properties, key))) {
    throw new Error('Supply an object with query or names.');
  }
  const flags = lookupFlags(args);
  const hasQuery = Object.hasOwn(args, 'query');
  if (hasQuery === Object.hasOwn(args, 'names')) throw new Error('Supply exactly one of query or names.');
  if (Object.hasOwn(args, 'shortlist') && typeof args.shortlist !== 'boolean') {
    throw new Error('shortlist must be a boolean.');
  }
  const names = hasQuery ? [] : batchNames(args.names);
  if (args.shortlist && (hasQuery || names.some(name => name.includes('.')))) {
    throw new Error('Use shortlist only with bare names in names.');
  }
  if (hasQuery) return ['--agent', queryValue(args.query), ...flags];
  return ['--agent', '--names', names.join(','), ...flags];
}

// The rows a progress answer lists, in input order: a bare name with every requested ending, an exact domain as itself.
function checkRows(args) {
  const names = Object.hasOwn(args, 'query') ? [queryValue(args.query)] : batchNames(args.names);
  const endings = [...new Set([...(args.endings ?? []), ...defaultEndings])];
  return [...new Set(names)].map(name => name.includes('.')
    ? { name, domains: [name] } : { name, domains: endings.map(ending => name + '.' + ending) });
}

function triageRows(args) {
  const endings = [...new Set([...(args.endings ?? []), ...defaultEndings])];
  const seen = new Set();
  return args.names.flatMap(name => {
    const label = normalizeName(name);
    if (!label || seen.has(label)) return [];
    seen.add(label);
    return [{ name: name.trim(), domains: endings.map(ending => label + '.' + ending) }];
  });
}

// GEO is the client's own recollection per name: "known: <what it is>" or "unknown", never a search result.
function geoValue(geo, names) {
  const valid = isObject(geo) && Object.keys(geo).length <= 20 && Object.entries(geo).every(([name, text]) =>
    name.length >= 1 && name.length <= 100 && typeof text === 'string' && text.length <= 160
    && /^(?:known\b.*\S.*|unknown)$/i.test(text.trim()) && !/\p{Cc}/u.test(text));
  if (!valid) throw new Error('geo must map each name to "known: <what it is>" or "unknown", from your own knowledge.');
  const screened = new Set(names.map(normalizeName).filter(Boolean));
  const extra = Object.keys(geo).find(name => !screened.has(normalizeName(name)));
  if (extra !== undefined) throw new Error('geo names ' + showValue(extra) + ', which is not in names.');
  return Object.fromEntries(Object.entries(geo).map(([name, text]) => [name, text.trim()]));
}

function triageArguments(args) {
  if (!isObject(args) || Object.keys(args).some(key => !Object.hasOwn(triageTool.inputSchema.properties, key))) {
    throw new Error('Supply an object with names and an optional about.');
  }
  if (!Array.isArray(args.names) || args.names.length < 1 || args.names.length > 20) {
    throw new Error('names must list 1 to 20 names' + (Array.isArray(args.names) ? '; it has ' + args.names.length : '') + '.');
  }
  const bad = args.names.findIndex(name => typeof name !== 'string' || !name.trim() || name.length > 100 || /[,.\p{Cc}]/u.test(name));
  if (bad >= 0) {
    throw new Error('names[' + bad + '] is not valid. Supply 1 to 20 bare names of up to 100 characters, without commas or domain endings.');
  }
  const flags = lookupFlags(args);
  if (Object.hasOwn(args, 'category')) {
    if (typeof args.category !== 'string' || !args.category.trim() || args.category.length > 100) {
      throw new Error('Use up to 100 characters for the product category.');
    }
    flags.push('--category', args.category);
  }
  if (Object.hasOwn(args, 'about')) {
    if (typeof args.about !== 'string' || !args.about.trim() || args.about.length > 160) {
      throw new Error('Use up to 160 characters for the product description.');
    }
    flags.push('--about', args.about);
  }
  if (Object.hasOwn(args, 'geo')) flags.push('--geo', JSON.stringify(geoValue(args.geo, args.names)));
  return ['--triage', args.names.join(','), '--compact', ...flags];
}

// The capability prints one JSON object on stdout.
function parseOutput(stdout, failed, stoppedAfter) {
  if (stoppedAfter) {
    const seconds = Math.max(1, Math.round(stoppedAfter / 1000));
    throw new Error('Domain Hound stopped the lookup after ' + seconds + (seconds === 1 ? ' second.' : ' seconds.'));
  }
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error(failed ? 'Domain Hound could not run.' : 'Domain Hound returned invalid JSON.');
  }
  if (typeof data?.error === 'string') {
    const message = data.error.split(/[\r\n\u2028\u2029]/, 1)[0].replace(/[\x00-\x1f\x7f]/g, ' ').trim();
    throw new Error(message.slice(0, 240) || 'Domain Hound could not complete the lookup.');
  }
  if (failed) throw new Error('Domain Hound could not complete the lookup.');
  if (!isObject(data) || !Array.isArray(data.names)) throw new Error('Domain Hound returned invalid JSON.');
  return data;
}

// Progress events from the capability: each registry answer and its current stage.
function readProgress(progress, line) {
  if (!line.startsWith(progressPrefix)) return;
  let event;
  try { event = JSON.parse(line.slice(progressPrefix.length)); } catch { return; }
  if (!isObject(event)) return;
  if (typeof event.domain === 'string' && typeof event.status === 'string' && progress.answers.size < 1000) {
    progress.answers.set(event.domain.slice(0, 127), event.status.slice(0, 20));
  }
  if (typeof event.stage === 'string') progress.stage = event.stage.slice(0, 20);
}

// Start one capability run. It ends on its own; only the maximum lookup time or server shutdown stops it.
function startLookup(args, cwd, maxMs) {
  const lookup = { started: performance.now(), progress: { answers: new Map(), stage: null }, finished: false,
    collect: false, outcome: null };
  const child = spawn(process.execPath, ['index.mjs', ...args], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DOMAIN_HOUND_PROGRESS: '1' },
  });
  lookup.child = child;
  const chunks = [];
  let size = 0;
  child.stdout.on('data', chunk => {
    size += chunk.length;
    if (size <= 4_000_000) chunks.push(chunk);
  });
  createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', line => readProgress(lookup.progress, line));
  let stopped = false;
  const limit = setTimeout(() => {
    stopped = true;
    child.kill('SIGKILL');
  }, maxMs);
  lookup.done = new Promise(resolve => {
    let settled = false;
    const finish = failed => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      try {
        lookup.outcome = { data: parseOutput(Buffer.concat(chunks).toString('utf8'), failed, stopped && maxMs) };
      } catch (problem) {
        lookup.outcome = { error: problem.message };
      }
      lookup.finished = true;
      resolve();
    };
    child.once('error', () => finish(true));
    child.once('close', code => finish(code !== 0));
  });
  return lookup;
}

// Wait for the lookup while this call's budget lasts. The lookup itself keeps running either way.
async function within(lookup, budget) {
  let timer;
  const finished = await Promise.race([
    lookup.done.then(() => true),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, budget)); }),
  ]);
  clearTimeout(timer);
  return finished;
}

export async function serve({
  input = process.stdin, output = process.stdout, cwd = capabilityDir, timeout = timeoutMs, maxLookup = maxLookupMs,
} = {}) {
  const send = response => output.write(JSON.stringify({ jsonrpc: '2.0', ...response }) + '\n');
  const error = (id, code, message) => send({ id, error: { code, message } });
  const pending = new Set();
  const lookups = new Map();

  // Join the running or finished lookup for the same input, or start one. Answer within the budget with the
  // result, or with the progress so far while the lookup keeps running for a repeated call to collect.
  async function runLookup(args, buildArgs, rowsFor, render, renderProgress) {
    const started = performance.now();
    let cliArgs;
    let rows;
    try {
      cliArgs = buildArgs(args);
      rows = rowsFor(args);
    } catch (problem) {
      return errorResult(problem.message);
    }
    const key = JSON.stringify(cliArgs);
    let lookup = lookups.get(key);
    if (!lookup) {
      lookup = startLookup(cliArgs, cwd, maxLookup);
      lookups.set(key, lookup);
      lookup.done.then(() => {
        if (lookups.get(key) !== lookup) return;
        // A result nobody was told to collect is delivered by the calls already waiting on it.
        if (!lookup.collect) {
          lookups.delete(key);
          return;
        }
        setTimeout(() => { if (lookups.get(key) === lookup) lookups.delete(key); }, keepFinishedMs).unref();
      });
    }
    if (!await within(lookup, timeout - (performance.now() - started))) {
      lookup.collect = true;
      try {
        return toolResult(renderProgress(lookup.progress, {
          rows, elapsedMs: performance.now() - lookup.started, budgetMs: timeout }));
      } catch {
        return errorResult('Domain Hound could not format the progress.');
      }
    }
    // The repeated call collected the finished result; the next call starts a fresh lookup.
    if (lookups.get(key) === lookup) lookups.delete(key);
    if (lookup.outcome.error) return errorResult(lookup.outcome.error);
    try {
      return toolResult(render(lookup.outcome.data));
    } catch {
      return errorResult('Domain Hound could not format the result.');
    }
  }
  let shortlist;
  let initialized = false;
  let negotiated = false;

  async function handle(line) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return error(null, -32700, 'Parse error');
    }
    if (!isObject(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return error(null, -32600, 'Invalid request');
    }
    const { id, method, params } = request;
    if (!Object.hasOwn(request, 'id')) {
      if (negotiated && method === 'notifications/initialized') initialized = true;
      return;
    }
    if (typeof id !== 'string' && typeof id !== 'number') return error(null, -32600, 'Invalid request ID');
    const reply = result => send({ id, result });
    if (method === 'ping') return reply({});
    if (method === 'initialize') {
      if (negotiated) return error(id, -32600, 'Domain Hound is already negotiating or initialized');
      const version = params?.protocolVersion;
      if (typeof version !== 'string') return error(id, -32602, 'Missing protocol version');
      negotiated = true;
      return reply({
        protocolVersion: versions.includes(version) ? version : versions[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'domain-hound', title: 'Domain Hound', version: serverVersion },
      });
    }
    if (method !== 'tools/list' && method !== 'tools/call') return error(id, -32601, 'Method not found');
    if (!initialized) return error(id, -32000, 'Domain Hound has not been initialized');
    if (method === 'tools/list') return reply({ tools: [checkTool, triageTool, namingTool, legacyTool] });
    const { name, arguments: args } = params ?? {};
    if (name === namingTool.name) {
      if (args !== undefined && (!isObject(args) || Object.keys(args).some(key => key !== 'about') ||
        (Object.hasOwn(args, 'about') && (typeof args.about !== 'string' || !args.about.trim() ||
          args.about.length > namingTool.inputSchema.properties.about.maxLength)))) {
        return reply(errorResult('naming_method accepts an optional about description of up to 512 characters.'));
      }
      shortlist = undefined;
      return reply(toolResult(JSON.stringify({ display: attributed(namingRecipe(args?.about?.slice(0, 160))) })));
    }
    const purchase = isObject(args) && args.purchase === true;
    if (name === triageTool.name) {
      const prior = shortlist && Date.now() - shortlist.at < 120_000 ? shortlist.data : undefined;
      return reply(await runLookup(args, triageArguments, triageRows, data => triageText(data, prior, { purchase, preferred: args.endings }),
        (progress, timing) => progressText(progress, { ...timing, triage: true, purchase })));
    }
    if (name !== checkTool.name && name !== legacyTool.name) return error(id, -32602, 'Unknown tool');
    // An exact lookup always ends with the purchase line, as its finished display does.
    const exact = isObject(args) && typeof args.query === 'string' && args.query.includes('.');
    return reply(await runLookup(args, cliArguments, checkRows, data => {
      if (args.shortlist) shortlist = { at: Date.now(), data };
      return checkText(data, args.shortlist, { purchase, preferred: args.endings });
    }, (progress, timing) => progressText(progress, { ...timing, purchase: purchase || exact })));
  }

  const lines = createInterface({ input, terminal: false, crlfDelay: Infinity });
  for await (const line of lines) {
    const response = handle(line).finally(() => pending.delete(response));
    pending.add(response);
  }
  await Promise.all(pending);
  // The client has gone, so nobody can collect a lookup that is still running.
  for (const lookup of lookups.values()) if (!lookup.finished) lookup.child.kill('SIGKILL');
  await Promise.all([...lookups.values()].map(lookup => lookup.done));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await serve();
