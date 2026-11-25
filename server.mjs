import { geoInstruction, googleSearchInstruction, namingRecipe, showAsIs } from './clis/domain-check/naming-method.mjs';
import { normalizeName, restrictedEndings, validEligibility } from './clis/domain-check/name-search.mjs';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { attributed, checkText, errorText, triageText } from './display.mjs';

const runFile = promisify(execFile);
// The capability ships inside the package; tests inject another directory through serve({ cwd }).
export const capabilityDir = fileURLToPath(new URL('./clis/domain-check/', import.meta.url));
// One version for the server, package and manifests; the release workflow checks the tag against it.
const serverVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const timeoutMs = 14_950;
const timeoutMessage = 'Domain Hound timed out after 15 seconds.';
const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const entryPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.(?:[A-Za-z]{2,63}|[xX][nN]--[A-Za-z0-9](?:[A-Za-z0-9-]{0,57}[A-Za-z0-9])?))?$/;
const nameSchema = { type: 'string', minLength: 1, maxLength: 127, pattern: entryPattern.source };
const endingsSchema = {
  type: 'array', minItems: 1, maxItems: 10, uniqueItems: true,
  items: { type: 'string', enum: ['com', 'dev', 'app', 'me', 'si', 'co', 'io', 'no', 'so', 'ai'] },
  description: 'Optional filter. All ten endings, including .ai, are checked by default.',
};
const lookupProperties = {
  ai: { type: 'boolean', description: 'Legacy option. .ai is now included by default.' },
  endings: endingsSchema,
  eligible: { type: 'array', uniqueItems: true, items: { type: 'string', enum: restrictedEndings },
    description: 'Restricted endings the buyer qualifies to register. Pass ["no"] only when the buyer qualifies for .no.' },
};
const checkTool = {
  name: 'check_domains',
  description: 'Use Domain Hound to check domains. Two input forms: query for one name or exact domain, e.g. {"query":"oakenroom.me"} or {"query":"oakenroom"}; names for a batch of up to 20 bare names, exact domains or both, e.g. {"names":["oakenroom","quietbook","oakenroom.me"]}. A dot means an exact domain; a bare name checks all ten endings, including .ai. For a single exact-domain question, call once with query and answer from that result. For a list, make one names call and report the results as returned. An unconfirmed result is enough for an availability answer. An exact quote for a favorite is a separate request. '
    + 'Returns display (ready-to-copy Markdown that accounts for every requested name), then complete, shared checkedAt and priceListDate, optional best (confirmed, with buyUrl), and per name taken, resale, free (cheapest first) and shop_check. Read first payment, minimum term and renewal inline or in listPrices keyed by ending; shopCheckWhy gives the reason an ending needs a shop check. The legend and shop buyUrlTemplate values explain the fields and links. '
    + showAsIs + ' For an exact lookup, copy the entire display including the purchase line. If asked to buy or register, explicitly say you cannot buy domains or complete checkout, including when the domain is taken. Give the price and checkout link only when an offer exists. If a domain is taken, say it is taken. Suggest free endings already in that result. Look up alternatives only if the person asks for alternatives. '
    + 'Returns every option; let the person choose. Never buys. For naming help, call naming_method first when generating new names. Use triage_names alone to screen an existing name for conflicts. When shortlist is true, pass a single DNS label per name (Quiet Otter becomes quietotter).',
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
    },
    additionalProperties: false,
    oneOf: [{ required: ['query'] }, { required: ['names'] }],
  },
};

const legacyTool = { ...checkTool, name: 'broker_find',
  description: 'Legacy alias for the Domain Hound check_domains tool. Same input forms: {"query":"oakenroom.me"} or {"names":["oakenroom","oakenroom.me"]}. ' + showAsIs + ' Returns every option; let the person choose.' };

const triageTool = {
  name: 'triage_names',
  description: 'If asked whether an existing name is safe, call Domain Hound triage_names directly once with that bare name. Use this tool to screen 1 to 20 product names, e.g. {"names":["Quiet Otter","Hush Room"],"about":"book quiet meeting rooms"}. Checks same-name competitors, live US marks, iOS and Android apps, handles, memorability and every domain ending, including .ai. '
    + 'Returns top (up to three ranked names), sources (coverage) and display (ready-to-copy Markdown with the top picks first and one row per name with its verdict and reason exactly, every free ending with today\'s payment and renewal, and a checkout link for the cheapest), then per name verdict, reason, free (endings free at the registry, cheapest first), own (this name\'s prices where they differ), taken, shop_check, buy (checkout link for the cheapest free ending) and competition evidence; prices holds the standard price per ending (now = payment today for term years, renew = renewal). '
    + 'Show the cheapest eligible one-year price in each candidate row. Restricted endings such as .no remain listed with their eligibility note and are excluded from cheapest and Best value unless the buyer qualifies. Best value requires a known renewal at most twice the first payment. '
    + 'Verdicts weigh each same-name rival by its SEO and GEO traction: a strong rival (David vs Goliath) or a same-business rival with traction means Avoid, another business with some traction means Check first, and small or dormant same-name uses are notes after the reason that never lower the verdict. '
    + 'Fill geo for every name from your own memory before calling. ' + googleSearchInstruction + ' Copy the full display in the answer. Update only the Google result. Keep the verdict, reason, same-name notes, and each source on its own line with its direct link. Keep the cheapest eligible payment in every row even when prices match. Use the exact labels Google, App Store (iOS), and Google Play (Android). Do not omit or paraphrase rows. In a dense batch, account for every name in the structured results. Let the person choose.',
  inputSchema: {
    type: 'object',
    properties: {
      ...lookupProperties,
      names: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 100 },
        description: '1 to 20 bare names without endings, e.g. ["Quiet Otter","Hush Room"].' },
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
  description: 'Get the Domain Hound naming recipe when asked to generate new product name ideas. For an existing name, use triage_names directly. Start with the final triage display; the recipe and the name batch are intermediate. '
    + googleSearchInstruction,
  inputSchema: { type: 'object', properties: {
    about: { type: 'string', minLength: 1, maxLength: 160, description: 'An optional brief product description.' },
  }, additionalProperties: false },
};

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });
const errorResult = message => textResult(errorText(message), true);

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
  if (Object.hasOwn(args, 'endings')) {
    const endings = args.endings;
    if (!Array.isArray(endings) || endings.length < 1 || endings.length > 10 ||
        new Set(endings).size !== endings.length || endings.some(ending => !endingsSchema.items.enum.includes(ending))) {
      throw new Error('Choose supported domain endings.');
    }
    flags.push('--endings', endings.join(','));
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

async function runBroker(args, cwd, timeout) {
  let stdout;
  let failed = false;
  try {
    ({ stdout } = await runFile(process.execPath, ['index.mjs', ...args], {
      cwd, timeout, killSignal: 'SIGKILL',
    }));
  } catch (error) {
    if (error.killed) throw new Error(timeoutMessage);
    failed = true;
    stdout = error.stdout;
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

async function runLookup(args, cwd, timeout, buildArgs, render) {
  let data;
  try {
    data = await runBroker(buildArgs(args), cwd, timeout);
  } catch (error) {
    return errorResult(error.message);
  }
  try {
    return textResult(render(data));
  } catch {
    return errorResult('Domain Hound could not format the result.');
  }
}

export async function serve({ input = process.stdin, output = process.stdout, cwd = capabilityDir, timeout = timeoutMs } = {}) {
  const send = response => output.write(JSON.stringify({ jsonrpc: '2.0', ...response }) + '\n');
  const error = (id, code, message) => send({ id, error: { code, message } });
  const pending = new Set();
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
        (Object.hasOwn(args, 'about') && (typeof args.about !== 'string' || !args.about.trim() || args.about.length > 160)))) {
        return reply(errorResult('naming_method accepts only an optional about description of up to 160 characters.'));
      }
      shortlist = undefined;
      return reply(textResult(JSON.stringify({ display: attributed(namingRecipe(args?.about)) })));
    }
    if (name === triageTool.name) {
      const prior = shortlist && Date.now() - shortlist.at < 120_000 ? shortlist.data : undefined;
      return reply(await runLookup(args, cwd, timeout, triageArguments, data => triageText(data, prior)));
    }
    if (name !== checkTool.name && name !== legacyTool.name) return error(id, -32602, 'Unknown tool');
    return reply(await runLookup(args, cwd, timeout, cliArguments, data => {
      if (args.shortlist) shortlist = { at: Date.now(), data };
      return checkText(data, args.shortlist);
    }));
  }

  const lines = createInterface({ input, terminal: false, crlfDelay: Infinity });
  for await (const line of lines) {
    const response = handle(line).finally(() => pending.delete(response));
    pending.add(response);
  }
  await Promise.all(pending);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await serve();
