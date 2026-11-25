import { geoInstruction, namingRecipe } from './clis/domain-check/naming-method.mjs';
import { asciiDomain, defaultEndings, domainEnding, normalizeName, requestEndings, restrictedEndings, supportedEndings, validEligibility } from './clis/domain-check/name-search.mjs';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkSocialHandles, handlePriorities, pendingHandleRows, requestPlatforms } from './clis/domain-check/handles.mjs';
import { progressPrefix } from './clis/domain-check/progress.mjs';
import { attributed, errorText, progressText } from './display.mjs';
import { resultPages, resultsLine } from './results.mjs';
import { watchDomain, watchTool } from './watch.mjs';
import { domainDossier, dossierTool } from './dossier.mjs';
import { myDomains, portfolioTool } from './clis/portfolio/portfolio.mjs';
import { callPurchaseTool, purchaseToolNames, registeredTools, withCheckQuoteOffer, withWatchQuoteOffer } from './clis/spaceship/tools.mjs';

// The capability ships inside the package; tests inject another directory through serve({ cwd }).
export const capabilityDir = fileURLToPath(new URL('./clis/domain-check/', import.meta.url));
// One version for the server, package and manifests; the release workflow checks the tag against it.
const serverVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
// Each call answers within this budget, leaving a second under the clients' 15-second limit for formatting and
// transport. A lookup that needs longer keeps running, and a repeated call with the same input collects it.
const timeoutMs = 14_000;
// A lookup still running after this long is stopped.
const maxLookupMs = 120_000;
// Keep completed evidence stable for repeated calls during a short naming session.
const keepFinishedMs = 120_000;
const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// Letters may be non-ASCII (æøå, é): such a name or domain is checked as its punycode form. The ranges skip
// spaces, punctuation and symbols without needing a Unicode-aware regular expression in the client.
const letter = 'A-Za-z0-9\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u1FFF\\u3040-\\uD7FF\\uF900-\\uFDCF';
const entryPattern = new RegExp('^[' + letter + '](?:[' + letter + '-]{0,61}[' + letter + '])?'
  + '(?:\\.(?:[cC][oO]\\.[uU][kK]|[A-Za-z]{2,63}|[xX][nN]--[A-Za-z0-9](?:[A-Za-z0-9-]{0,57}[A-Za-z0-9])?))?$');
const nameSchema = { type: 'string', minLength: 1, maxLength: 127, pattern: entryPattern.source };
const endingsSchema = {
  type: 'array', minItems: 1, maxItems: supportedEndings.length, uniqueItems: true,
  items: { type: 'string', enum: supportedEndings },
  description: 'Endings to consider for the recommendation, in preference order; listed endings rank first. For .com only use ["com"]. The page still shows all twelve default endings for bare names. '
    + 'On request only (add them here when the person asks or names a country): ' + requestEndings.map(ending => '.' + ending).join(', ') + '.',
};
const countryEnding = {
  SH: 'sh', GG: 'gg', SE: 'se', DK: 'dk', DE: 'de', GB: 'co.uk', UK: 'co.uk', EU: 'eu',
};
const europeanCountries = new Set('AT BE BG HR CY CZ EE FI FR GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES IS LI NO'.split(' '));
function regionalEnding(country) {
  const code = country?.toUpperCase();
  return Object.hasOwn(countryEnding, code) ? countryEnding[code] : europeanCountries.has(code) ? 'eu' : null;
}
const selectedEndings = args => [...new Set([...(args.endings ?? []), regionalEnding(args.country), ...defaultEndings].filter(Boolean))];
const lookupProperties = {
  country: { type: 'string', pattern: '^[A-Za-z]{2}$', description: 'Buyer country code if supplied, such as SE, DK, DE or GB for .co.uk. Do not infer it from language alone.' },
  ai: { type: 'boolean', description: 'Legacy option. .ai is now included by default.' },
  endings: endingsSchema,
  budget: { type: 'number', minimum: 0, maximum: 1000000,
    description: 'The person\'s budget in USD, only when they gave one. Endings that cost more upfront are left out, and it replaces the $60 three-year cap of the default pick (highest-quality ending within the cap, else the least paid over 3 years; .ai only when asked for or within this budget). Carry it from the registry screen into triage.' },
  eligible: { type: 'array', uniqueItems: true, items: { type: 'string', enum: restrictedEndings },
    description: 'Restricted endings the buyer qualifies to register. Pass no or eu only when the buyer qualifies for that ending.' },
};
const relay = 'The answer starts with the clickable Markdown link on the first line of say. Then give the relevant facts from say.';
const checkTool = {
  name: 'check_domains',
  description: 'Check availability and dated prices for up to 20 names or domains. Use triage_names for product names. '
    + 'For purchase requests, set purchase: true and relay the checkout guidance. Use confirm: true only for an explicit live shop check. '
    + 'Keep list, shop-confirmed and premium prices distinct. ' + relay,
  inputSchema: {
    type: 'object',
    properties: {
      ...lookupProperties,
      query: { ...nameSchema,
        description: 'One name or exact domain, e.g. "lanternbay.me" or "lanternbay". Supply either query or names.' },
      names: { type: 'array', minItems: 1, maxItems: 20,
        items: nameSchema,
        description: '1 to 20 bare names, exact domains or both, e.g. ["lanternbay","quietbook","lanternbay.me"]. Use one DNS label for a bare name, with no spaces or dots. A dot means an exact domain. Supply either names or query.' },
      shortlist: { type: 'boolean', description: 'Legacy: true for a preliminary bare-name batch. The naming recipe now goes straight to triage_names.' },
      purchase: { type: 'boolean', description: 'Pass true when asked to buy or register, even for an exact domain that may be taken. State the checkout limitation from the display in the answer.' },
      confirm: { type: 'boolean', description: 'True only when the person explicitly asks for a live shop check. Uses an optional headless browser and is slower.' },
    },
    additionalProperties: false,
    oneOf: [{ required: ['query'] }, { required: ['names'] }],
  },
};

const legacyTool = { ...checkTool, name: 'broker_find',
  description: 'Legacy alias for check_domains. This check leaves checkout to you. ' + relay };

const triageTool = {
  name: 'triage_names',
  description: 'Find or vet a product name before any other search. For naming, generate five distinct, easy-to-say names, with the supplied name first. '
    + 'Call triage_names once with those names, a short about description and shortlist: true. Checks domains, trademarks, apps, rivals and meanings. '
    + 'Use the returned verdicts and label unfinished checks as pending. ' + relay,
  inputSchema: {
    type: 'object',
    properties: {
      ...lookupProperties,
      names: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 100 },
        description: '1 to 20 bare names without endings, e.g. ["Quiet Otter","Hush Room"].' },
      shortlist: { type: 'boolean', description: 'True when generating names. Returns a short chat answer and a full receipt.' },
      purchase: { type: 'boolean', description: 'True when the person asks to buy or register a domain.' },
      companyType: { type: 'string', enum: Object.keys(handlePriorities),
        description: 'Use developer, consumer, b2b or media when it fits, to highlight the handles that matter.' },
      additionalHandles: { type: 'array', uniqueItems: true, items: { type: 'string', enum: requestPlatforms.map(platform => platform.id) },
        description: 'Extra check links only when requested. Snapchat, Reddit, Twitch, Threads, Pinterest or Discord.' },
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
  description: 'Read the naming recipe when the person asks for the method. To find or screen names directly, use triage_names.',
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

// The DNS form of a valid entry: a bare name as one label, an exact domain as itself, both in punycode when needed.
const dnsForm = value => value.includes('.') ? asciiDomain(value) : normalizeName(value);

function queryValue(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('query is empty. Enter one name or exact domain in query, such as lanternbay or lanternbay.me.');
  }
  const query = value.toLowerCase();
  if (query.split('.')[0].length > 63) throw new Error('This name is too long. A DNS label can have up to 63 characters.');
  if (!entryPattern.test(query) || !dnsForm(query)) {
    throw new Error('query ' + showValue(value) + ' is not valid. Give a name like lanternbay or a domain like lanternbay.me in query.');
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
      throw new Error('names[' + index + '] is empty. Use a bare name such as lanternbay or an exact domain such as lanternbay.me.');
    }
    const name = value.toLowerCase();
    if (name.split('.')[0].length > 63) throw new Error('names[' + index + '] is too long. A DNS label can have up to 63 characters.');
    if (!entryPattern.test(name) || !dnsForm(name)) {
      throw new Error('names[' + index + '] ' + showValue(value) + ' is not valid. Give a name like lanternbay or a domain like lanternbay.me in names.');
    }
    return name;
  });
}

function lookupFlags(args) {
  const flags = [];
  if (Object.hasOwn(args, 'budget') && (!Number.isFinite(args.budget) || args.budget < 0 || args.budget > 1_000_000)) {
    throw new Error('The upfront budget must be a dollar amount between 0 and 1,000,000.');
  }
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
  if (Object.hasOwn(args, 'country') && (typeof args.country !== 'string' || !/^[A-Za-z]{2}$/.test(args.country))) {
    throw new Error('Use a two-letter country code.');
  }
  if (Object.hasOwn(args, 'endings')) {
    const endings = args.endings;
    if (!Array.isArray(endings) || endings.length < 1 || endings.length > supportedEndings.length ||
        new Set(endings).size !== endings.length || endings.some(ending => !endingsSchema.items.enum.includes(ending))) {
      throw new Error('Choose supported domain endings.');
    }
  }
  const extra = selectedEndings(args).filter(ending => !defaultEndings.includes(ending));
  if (extra.length) flags.push('--endings', [...defaultEndings, ...extra].join(','));
  return flags;
}

function cliArguments(args) {
  if (!isObject(args) || Object.keys(args).some(key => !Object.hasOwn(checkTool.inputSchema.properties, key))) {
    throw new Error('Supply an object with query or names.');
  }
  const flags = lookupFlags(args);
  if (args.endings) flags.push('--prefer-endings', args.endings.join(','));
  if (args.budget !== undefined) flags.push('--upfront-cap', String(args.budget));
  const hasQuery = Object.hasOwn(args, 'query');
  if (hasQuery === Object.hasOwn(args, 'names')) throw new Error('Supply exactly one of query or names.');
  if (Object.hasOwn(args, 'shortlist') && typeof args.shortlist !== 'boolean') {
    throw new Error('shortlist must be a boolean.');
  }
  const names = hasQuery ? [] : batchNames(args.names);
  if (args.shortlist && (hasQuery || names.some(name => name.includes('.')))) {
    throw new Error('Use shortlist only with bare names in names.');
  }
  if (hasQuery) return ['--agent', queryValue(args.query), '--receipt', ...flags];
  return ['--agent', '--names', names.join(','), '--receipt', ...flags];
}

// The rows a progress answer lists, in input order: a bare name with every requested ending, an exact domain as itself.
function checkRows(args) {
  const names = (Object.hasOwn(args, 'query') ? [queryValue(args.query)] : batchNames(args.names)).map(dnsForm);
  const endings = selectedEndings(args);
  return [...new Set(names)].map(name => name.includes('.')
    ? { name, domains: [name] } : { name, domains: endings.map(ending => name + '.' + ending) });
}

function triageRows(args) {
  const endings = selectedEndings(args);
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
  // Requested endings rank first in the screen's own picks, and a budget applies there as on the receipt.
  if (args.endings) flags.push('--prefer-endings', args.endings.join(','));
  if (args.budget !== undefined) flags.push('--upfront-cap', String(args.budget));
  if (Object.hasOwn(args, 'shortlist') && typeof args.shortlist !== 'boolean') throw new Error('shortlist must be a boolean.');
  const { companyType, additionalHandles } = args;
  if (companyType !== undefined && !Object.hasOwn(handlePriorities, companyType)) throw new Error('Choose a supported company type.');
  if (additionalHandles !== undefined && (!Array.isArray(additionalHandles) ||
    new Set(additionalHandles).size !== additionalHandles.length ||
    additionalHandles.some(id => !requestPlatforms.some(platform => platform.id === id)))) {
    throw new Error('Choose supported extra handle platforms.');
  }
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
  return ['--triage', args.names.join(','), '--compact', '--receipt', ...flags];
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
  const { _mcpResult, ...payload } = data;
  return payload;
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
// A name screen answers first with the checks done so far ({"followUp":true} on its first line) and keeps running
// the slow checks; the re-assessed result on its next line resolves lookup.later (null when there is none).
function startLookup(args, cwd, maxMs, onLookupEvent) {
  const triage = args[0] === '--triage';
  const lookup = { started: performance.now(), progress: { answers: new Map(), stage: null }, finished: false, exited: false,
    collect: false, outcome: null };
  const child = spawn(process.execPath, ['index.mjs', ...args], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DOMAIN_HOUND_PROGRESS: '1', DOMAIN_HOUND_MCP_OUTPUT: '1',
      DOMAIN_HOUND_DEFER_HANDLES: triage ? '1' : '', DOMAIN_HOUND_FOLLOW_UP: triage ? '1' : '' },
  });
  lookup.child = child;
  const chunks = [];
  let size = 0;
  let firstLine = null;
  let answer;
  let later;
  lookup.done = new Promise(resolve => { answer = resolve; });
  lookup.later = new Promise(resolve => { later = resolve; });
  const settle = read => {
    if (lookup.finished) return;
    try {
      lookup.outcome = { data: read() };
    } catch (problem) {
      lookup.outcome = { error: problem.message };
    }
    lookup.finished = true;
    answer();
  };
  child.stdout.on('data', chunk => {
    size += chunk.length;
    if (size <= 4_000_000) chunks.push(chunk);
    if (firstLine !== null) return;
    const text = Buffer.concat(chunks).toString('utf8');
    const end = text.indexOf('\n');
    if (end < 0) return;
    firstLine = text.slice(0, end);
    let first;
    try { first = JSON.parse(firstLine); } catch { return; }
    if ((first?._mcpResult === true || triage && first?.followUp === true) && Array.isArray(first.names)) {
      settle(() => parseOutput(firstLine, false, 0));
    }
  });
  createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', line => {
    readProgress(lookup.progress, line);
    onLookupEvent?.('progress', lookup.progress);
  });
  let stopped = false;
  const limit = setTimeout(() => {
    stopped = true;
    child.kill('SIGKILL');
  }, maxMs);
  let closed = false;
  const finish = failed => {
    if (closed) return;
    closed = true;
    lookup.exited = true;
    clearTimeout(limit);
    const text = Buffer.concat(chunks).toString('utf8');
    if (!lookup.finished) {
      settle(() => parseOutput(text, failed, stopped && maxMs));
      later(null);
      return;
    }
    let next = null;
    try {
      if (!failed && !stopped) next = parseOutput(text.slice(firstLine.length + 1), false, 0);
    } catch { /* The first answer stands; the follow-up did not finish. */ }
    later(next);
  };
  child.once('error', () => finish(true));
  child.once('close', code => {
    finish(code !== 0);
    onLookupEvent?.('exited');
  });
  onLookupEvent?.('started');
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

function pendingTriage(progress, rows) {
  return {
    pending: true,
    checkedAt: new Date().toISOString(),
    names: rows.map(({ name, domains }) => {
      const endings = state => domains.filter(domain => progress.answers.get(domain) === state).map(domainEnding);
      return { name, taken: endings('taken'), premium: endings('premium'), reserved: endings('reserved'),
        free: endings('probably-free').map(d => ({ d })), shop_check: endings('check-at-shop') };
    }),
  };
}

export async function serve({
  input = process.stdin, output = process.stdout, cwd = capabilityDir, timeout = timeoutMs, maxLookup = maxLookupMs,
  pages = resultPages(), watch = watchDomain, socialLookup = checkSocialHandles, dossier = domainDossier, portfolio = myDomains,
  onLookupEvent,
} = {}) {
  const send = response => output.write(JSON.stringify({ jsonrpc: '2.0', ...response }) + '\n');
  const error = (id, code, message) => send({ id, error: { code, message } });
  const pending = new Set();
  const lookups = new Map();
  const background = new Set();

  // Join the running or finished lookup for the same input, or start one. Answer within the budget with the
  // result, or with the progress so far while the lookup keeps running for a repeated call to collect.
  async function runLookup(args, buildArgs, rowsFor, render, renderProgress, onLookup = () => {}) {
    const started = performance.now();
    let cliArgs;
    let rows;
    try {
      cliArgs = buildArgs(args);
      rows = rowsFor(args);
    } catch (problem) {
      return errorResult(problem.message);
    }
    const presentation = buildArgs === triageArguments
      ? [args.endings, args.budget, args.purchase, args.shortlist, args.companyType, args.additionalHandles?.toSorted()] : null;
    const key = JSON.stringify([cliArgs, presentation]);
    let lookup = lookups.get(key);
    if (!lookup) {
      lookup = startLookup(cliArgs, cwd, maxLookup, onLookupEvent);
      lookups.set(key, lookup);
      lookup.done.then(() => {
        if (lookups.get(key) !== lookup) return;
        if (lookup.outcome.error && !lookup.collect) {
          lookups.delete(key);
          return;
        }
        setTimeout(() => { if (lookups.get(key) === lookup) lookups.delete(key); }, keepFinishedMs).unref();
      });
    }
    onLookup(lookup);
    if (!await within(lookup, timeout - (performance.now() - started))) {
      lookup.collect = true;
      try {
        return toolResult(await renderProgress(lookup.progress, {
          rows, elapsedMs: performance.now() - lookup.started, budgetMs: timeout }, lookup));
      } catch {
        return errorResult('Domain Hound could not format the progress.');
      }
    }
    if (lookup.outcome.error) {
      if (lookups.get(key) === lookup) lookups.delete(key);
      return errorResult(lookup.outcome.error);
    }
    try {
      return toolResult(JSON.stringify(await render(lookup.outcome.data, lookup)));
    } catch {
      return errorResult('Domain Hound could not format the result.');
    }
  }
  const track = task => {
    const tracked = Promise.resolve(task).catch(() => {}).finally(() => background.delete(tracked));
    background.add(tracked);
    return tracked;
  };

  // The handle rows for one set of extra platforms, shared by every call on the same lookup.
  function handleCheck(lookup, args) {
    const extraPlatforms = args.additionalHandles ?? [];
    const key = JSON.stringify(extraPlatforms.slice().sort());
    lookup.handleChecks ??= new Map();
    if (!lookup.handleChecks.has(key)) lookup.handleChecks.set(key, { rows: null, task: null, extraPlatforms });
    return lookup.handleChecks.get(key);
  }

  function writeTriagePage(lookup, data, args, refresh) {
    const work = (lookup.pageWork ?? Promise.resolve()).then(async () => {
      const page = await pages(data, args, { triage: true, reuse: lookup.page, refresh });
      lookup.page = page.resultPage;
      return page;
    });
    lookup.pageWork = work.catch(() => {});
    return work;
  }

  // Write the name screen's page with the handle rows known so far. The page keeps one URL per lookup, and it
  // reloads itself while the follow-up or the handle checks are still running.
  async function triageReceipt(lookup, args, data) {
    lookup.args = args;
    const { handleTargets, followUp: more, ...evidence } = data;
    let running = Boolean(more) && !lookup.laterDone;
    if (handleTargets?.length) {
      const check = handleCheck(lookup, args);
      const targets = new Map(handleTargets.map(({ name, index }) => [index, name]));
      const entries = evidence.names.flatMap((row, index) => {
        const target = targets.get(index);
        if (!target) return [];
        const rows = check.rows?.get(target) ?? pendingHandleRows(target, check.extraPlatforms);
        return [[row.name, rows]];
      });
      const handleRows = new Map(entries);
      evidence.receiptDetails = evidence.receiptDetails.map((detail, index) => ({
        ...detail, handles: handleRows.get(evidence.names[index].name),
      }));
      evidence.handles = Object.fromEntries(entries.map(([name, rows]) => [name, {
        taken: rows.filter(row => row.state === 'taken').map(row => row.platform),
        not_found: rows.filter(row => row.state === 'not-found').map(row => row.platform),
        check: rows.filter(row => row.state === 'check').map(row => row.platform),
      }]));
      if (!check.rows) {
        evidence.handlesPending = true;
        running = true;
      }
    }
    return writeTriagePage(lookup, evidence, args, running);
  }

  // After the answer: run the handle checks and collect the follow-up, rewriting the same page as each one lands.
  function followUp(lookup) {
    if (lookup.following) return;
    lookup.following = true;
    const rewrite = () => lookup.outcome?.data && triageReceipt(lookup, lookup.args, lookup.outcome.data);
    const { handleTargets } = lookup.outcome.data;
    if (handleTargets?.length) {
      const check = handleCheck(lookup, lookup.args);
      if (!check.task) {
        const rows = [...new Set(handleTargets.map(({ name }) => name))].map(name => ({ name, variants: true }));
        check.task = socialLookup(rows, { extraPlatforms: check.extraPlatforms, freshRun: true })
          .then(answers => { check.rows = answers; }, () => {
            check.rows = new Map(rows.map(({ name }) => [name,
              pendingHandleRows(name, check.extraPlatforms).map(row => ({ ...row, why: 'no clear answer in time' }))]));
          });
        track(check.task.then(rewrite));
      }
    }
    if (lookup.outcome.data.followUp) {
      track(lookup.later.then(next => {
        lookup.laterDone = true;
        // The re-assessed result replaces the first answer for the page and for any repeat call.
        if (next) lookup.outcome = { data: next };
        else {
          const data = lookup.outcome.data;
          const finish = row => {
            if (!row) return row;
            const { waiting, reason, ...rest } = row;
            return { ...rest, ...(reason && { reason: reason.replace(/still checking [^·]+/g, 'one or more checks did not finish ') }) };
          };
          lookup.outcome = { data: { ...data, followUp: false, names: data.names.map(finish),
            receiptDetails: data.receiptDetails?.map(finish) } };
        }
        return rewrite();
      }));
    }
  }

  // A lookup that outlived its call writes its finished page anyway, then continues as above.
  function finishInBackground(lookup, args, progressPage) {
    lookup.args = args;
    if (lookup.background) return;
    lookup.background = true;
    track(lookup.done.then(async () => {
      if (!lookup.outcome?.data) {
        if (progressPage) await writeTriagePage(lookup, { ...progressPage, failed: true }, args, false);
        return;
      }
      await triageReceipt(lookup, lookup.args, lookup.outcome.data);
      followUp(lookup);
    }));
  }

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
        instructions: 'When you use Domain Hound, include its clickable Results page link in your final answer, including for a single exact domain. Copy the first line of say for the link, then give your short answer. For a new product name, generate five candidates and call triage_names once with shortlist: true.',
      });
    }
    if (method !== 'tools/list' && method !== 'tools/call') return error(id, -32601, 'Method not found');
    if (!initialized) return error(id, -32000, 'Domain Hound has not been initialized');
    if (method === 'tools/list') return reply({ tools: registeredTools([checkTool, triageTool, namingTool, legacyTool, watchTool, dossierTool, portfolioTool]) });
    const { name, arguments: args } = params ?? {};
    if (purchaseToolNames.has(name)) return reply(await callPurchaseTool(name, args));
    if (name === namingTool.name) {
      if (args !== undefined && (!isObject(args) || Object.keys(args).some(key => key !== 'about') ||
        (Object.hasOwn(args, 'about') && (typeof args.about !== 'string' || !args.about.trim() ||
          args.about.length > namingTool.inputSchema.properties.about.maxLength)))) {
        return reply(errorResult('naming_method accepts an optional about description of up to 512 characters.'));
      }
      return reply(toolResult(JSON.stringify({ display: attributed(namingRecipe(args?.about?.slice(0, 160))) })));
    }
    if (name === watchTool.name) {
      let result;
      try {
        result = withWatchQuoteOffer(await watch(args));
      } catch (problem) {
        return reply(errorResult(problem.message));
      }
      // Preserve a successful submission response even if disk space or local permissions prevent a receipt.
      const data = await pages(result, {}, { watch: true }).catch(() => ({ ...result, display: result.say }));
      return reply(toolResult(JSON.stringify(data)));
    }
    if (name === dossierTool.name) {
      try {
        return reply(toolResult(JSON.stringify(await dossier(args))));
      } catch (problem) {
        return reply(errorResult(problem.message));
      }
    }
    if (name === portfolioTool.name) {
      try {
        return reply(toolResult(JSON.stringify(await portfolio(args))));
      } catch (problem) {
        return reply(errorResult(problem.message));
      }
    }
    const purchase = isObject(args) && args.purchase === true;
    if (name === triageTool.name) {
      let current;
      const result = await runLookup(args, triageArguments, triageRows, (data, lookup) => triageReceipt(lookup, args, data),
        async (progress, timing, lookup) => {
          const summary = progressText(progress, { ...timing, triage: true, purchase });
          // Without a repeat call, the finished result still reaches the same page when the lookup ends.
          if (!progress.answers.size) {
            finishInBackground(lookup, args);
            return summary;
          }
          const progressPage = pendingTriage(progress, timing.rows);
          const { resultPage } = await writeTriagePage(lookup, progressPage, args, true);
          finishInBackground(lookup, args, progressPage);
          const shown = JSON.parse(summary);
          shown.display = resultsLine(resultPage) + '\n' + shown.display;
          return JSON.stringify({ ...shown, resultPage });
        }, lookup => { current = lookup; });
      reply(result);
      if (!result.isError && current?.finished && current.outcome?.data) followUp(current);
      return;
    }
    if (name !== checkTool.name && name !== legacyTool.name) return error(id, -32602, 'Unknown tool');
    // An exact lookup includes the purchase line while its registration status is unsettled.
    const exact = isObject(args) && typeof args.query === 'string' && args.query.includes('.');
    return reply(await runLookup(args, cliArguments, checkRows, data => pages(data, args).then(page => withCheckQuoteOffer(page, args)),
      (progress, timing) => progressText(progress, { ...timing, purchase: purchase || exact })));
  }

  const lines = createInterface({ input, terminal: false, crlfDelay: Infinity });
  for await (const line of lines) {
    const response = handle(line).finally(() => pending.delete(response));
    pending.add(response);
  }
  await Promise.all(pending);
  while (background.size) await Promise.all(background);
  // The client has gone, so nobody can collect a lookup that is still running.
  for (const lookup of lookups.values()) if (!lookup.exited) lookup.child.kill('SIGKILL');
  await Promise.all([...lookups.values()].flatMap(lookup => [lookup.done, lookup.later]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await serve();
