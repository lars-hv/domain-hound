import { geoInstruction, namingRecipe } from './clis/domain-check/naming-method.mjs';
import { asciiDomain, defaultEndings, domainEnding, normalizeName, restrictedEndings, supportedEndings, validEligibility } from './clis/domain-check/name-search.mjs';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkSocialHandles, handlePriorities, pendingHandleRows, requestPlatforms } from './clis/domain-check/handles.mjs';
import { progressPrefix } from './clis/domain-check/progress.mjs';
import { attributed, errorText, localCheckNotice, md, progressText } from './display.mjs';
import { resultPages, resultsLine, shortPresentation } from './results.mjs';
import { watchDomain, watchTool } from './watch.mjs';
import { domainDossier, dossierTool } from './dossier.mjs';
import { myDomains, portfolioTool } from './clis/portfolio/portfolio.mjs';
import { callPurchaseTool, purchaseToolNames, registeredTools, withCheckQuoteOffer, withWatchQuoteOffer } from './clis/spaceship/tools.mjs';
import { candidateFields, compactScore, compareScores, scoreEligible, scoreHandles, scoreName, validCandidate } from './clis/domain-check/name-score.mjs';
import { scoreLogger } from './clis/domain-check/score-log.mjs';
import { alternativeEndings, HostedRateLimit, hostedClient, hostedDebug } from './hosted.mjs';
import { checkLines, generatedChecks, hostedChecks, hostedResult, visibleChecks } from './hosted-results.mjs';
import { shortDomainAnswer, shortIdeaAnswer } from './short-answer.mjs';

// The capability ships inside the package; tests inject another directory through serve({ cwd }).
export const capabilityDir = fileURLToPath(new URL('./clis/domain-check/', import.meta.url));
// One version for the server, package and manifests; the release workflow checks the tag against it.
const serverVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
// Each call answers within this budget, leaving a second under the clients' 15-second limit for formatting and
// transport. A lookup that needs longer keeps running, and a repeated call with the same input collects it.
const timeoutMs = 14_000;
// A lookup still running after this long is stopped.
const maxLookupMs = 120_000;
const hostedLookupMs = 34_000;
const hostedFirstAnswerMs = 4_000;
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
  description: 'Preferred endings and any extra endings to check, e.g. ["com","de"]. The ten defaults are still checked for bare names.',
};
const countryEnding = {
  SH: 'sh', GG: 'gg', SE: 'se', DK: 'dk', DE: 'de', GB: 'co.uk', UK: 'co.uk', EU: 'eu',
};
const europeanCountries = new Set('AT BE BG HR CY CZ EE FI FR GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES IS LI NO'.split(' '));
function regionalEnding(country) {
  const code = country?.toUpperCase();
  return Object.hasOwn(countryEnding, code) ? countryEnding[code] : europeanCountries.has(code) ? 'eu' : null;
}
const selectedEndings = args => [...new Set([...(args.endings ?? []), ...(args.eligible ?? []), regionalEnding(args.country), ...defaultEndings].filter(Boolean))];
const lookupProperties = {
  country: { type: 'string', pattern: '^[A-Za-z]{2}$', description: 'Buyer country code if supplied, such as SE, DK, DE or GB for .co.uk. Do not infer it from language alone.' },
  ai: { type: 'boolean', description: 'Legacy flag, e.g. true. .ai is already checked by default.' },
  endings: endingsSchema,
  budget: { type: 'number', minimum: 0, maximum: 1000000,
    description: 'User-supplied upfront USD budget, e.g. 30. Overrides the default $60 three-year cap.' },
  eligible: { type: 'array', uniqueItems: true, items: { type: 'string', enum: restrictedEndings },
    description: 'Restricted endings the buyer qualifies for, e.g. ["no"].' },
};
const searchAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const batchResultMeta = { 'anthropic/maxResultSizeChars': 40_000 };
const showAnswer = 'Show the tool’s text answer as given. Offer details only if the user asks.';
const detailSchema = { type: 'string', enum: ['short', 'full'], default: 'short',
  description: 'Defaults to "short". Use "full" for all shops and handles.' };
const serverInstructions = 'Use Domain Hound for domains and product, company or app names, including availability, registration and renewal prices, trademarks, buying and watches. '
  + 'Start with check_domains for availability or prices, triage_names for naming or trademark screening, and watch_domain for a release watch. '
  + showAnswer + ' Include the clickable Results page link whenever one is returned. '
  + 'To buy, set purchase: true on check_domains, then use quote_domain, buy_domain after approval, and setup_domain with verify: true. '
  + 'Use my_domains to review renewals of domains the person already owns.';

const checkTool = {
  name: 'check_domains',
  description: 'Use this when checking whether a name or exact domain is available, what an ending such as .ai costs, or where to register. '
    + 'Use query for one exact domain or bare name ({"query":"lanternbay.dev"}), or names for a batch ({"names":["lanternbay.dev","lanternbay"]}). '
    + 'Use purchase: true to start a purchase and confirm: true only for an explicit live shop check. '
    + 'Checks domains, app names and exact US trademark matches. Repeat to collect pending checks. Use triage_names for name ideas and quote_domain for a live Spaceship purchase quote. ' + showAnswer,
  annotations: { title: 'Check domain availability and prices', ...searchAnnotations },
  _meta: batchResultMeta,
  inputSchema: {
    type: 'object',
    properties: {
      ...lookupProperties,
      detail: detailSchema,
      query: { ...nameSchema,
        description: 'One name or exact domain, e.g. "lanternbay.me" or "lanternbay". Supply either query or names.' },
      names: { type: 'array', minItems: 1, maxItems: 20,
        items: nameSchema,
        description: '1 to 20 bare names or exact domains, e.g. ["lanternbay","lanternbay.me"]. Use names or query.' },
      shortlist: { type: 'boolean', description: 'Legacy preliminary bare-name check, e.g. true.' },
      purchase: { type: 'boolean', description: 'Set true when asked to buy or register. Relays checkout guidance.' },
      picked: { type: 'boolean', description: 'Set true on an exact query after the user explicitly picks a result. Used by the opt-in score log.' },
      confirm: { type: 'boolean', description: 'Set true only when the person explicitly asks for a live shop check.' },
    },
    additionalProperties: false,
    oneOf: [{ required: ['query'] }, { required: ['names'] }],
  },
};

const candidateDescriptions = {
  recipe: 'Naming recipe, e.g. "odd-pair".',
  relation: 'Link to the subject, e.g. "direct".',
  spellings: 'Plausible spellings when heard, e.g. 1.',
  realWord: 'Contains a real word, e.g. true.',
  descriptive: 'Uses two subject words or adds a generic word, e.g. false.',
  misspelled: 'Uses a deliberate misspelling, e.g. false.',
  narrow: 'Names only one feature, e.g. false.',
  soundsLike: 'Recognizable sound-alike, e.g. "competitor".',
  badMeaning: 'Severity of a bad meaning, e.g. "none".',
  language: 'Name language, e.g. "english".',
};

const namingTerritories = ['job', 'result', 'metaphor', 'object', 'role', 'twist'];
const namingText = maxLength => ({ type: 'string', minLength: 1, maxLength });
const namingCandidate = {
  type: 'object', additionalProperties: false, required: ['name', 'territory', 'anchor', 'why'],
  properties: {
    name: { ...namingText(40), description: 'Name as it should appear.' },
    territory: { type: 'string', enum: namingTerritories, description: 'Creative direction from the naming guide.' },
    why: { ...namingText(180), description: 'In at most 16 words, connect the anchor to the business.' },
    anchor: { ...namingText(36), description: 'Familiar word or phrase in the name.' },
    parents: { type: 'array', maxItems: 3, items: namingText(40), description: 'Previously shown names that supplied a part.' },
  },
};
const namingContext = {
  customer: { ...namingText(160), description: 'Who the business serves.' },
  feedback: { ...namingText(400), description: 'Latest feedback in the founder’s own words.' },
  pick: { ...namingText(40), description: 'One previously shown name to recheck.' },
  shown: { type: 'array', maxItems: 15, items: namingCandidate, description: 'Earlier shown names, projected to name, territory, anchor, why and parents.' },
  proposals: { type: 'array', minItems: 1, maxItems: 20, items: namingCandidate, description: 'Host-written naming ideas to check against the brief.' },
  taste: { type: 'array', maxItems: 20, items: {
    type: 'object', required: ['id', 'kind'], additionalProperties: false, properties: {
      id: { type: 'string', pattern: '^[a-z0-9-]{1,24}$', description: 'Stable ID for this preference.' },
      kind: { type: 'string', enum: ['keep-word', 'keep-trait', 'keep-name', 'ban-word', 'ban-territory', 'ban-trait', 'forget'],
        description: 'What to keep, avoid, or remove from the notes.' },
      value: { ...namingText(80), description: 'The exact preferred word, trait or pattern.' },
      source: { ...namingText(40), description: 'Earlier name the preference refers to.' },
      role: { ...namingText(32), description: 'Role of the named part, such as product or action.' },
      count: { type: 'integer', minimum: 1, maximum: 20, description: 'Times the founder picked the part.' },
    },
  }, description: 'Remembered likes, banned patterns and their sources. Reuse an ID when a preference changes.' },
};

const triageTool = {
  name: 'triage_names',
  description: 'Use this when naming a product, company or app, or checking existing names for trademarks, competing apps and handles. '
    + 'Pass idea to use the website’s name generator ({"idea":"A room booking app"}) or names to screen candidates ({"names":["Quiet Otter"]}). '
    + 'Repeat with the same input to collect pending checks. For a domain-only lookup or registrar prices, use check_domains. ' + showAnswer,
  annotations: { title: 'Find and screen product names', ...searchAnnotations, idempotentHint: false },
  _meta: batchResultMeta,
  inputSchema: {
    type: 'object',
    properties: {
      idea: { type: 'string', minLength: 3, maxLength: 400, description: 'Product idea, e.g. "A trip planner for families". Use idea or names.' },
      wanted: { type: 'array', maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 40 },
        description: 'Names liked last round, e.g. ["Quiet Otter"].' },
      avoid: { type: 'array', maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 40 },
        description: 'Names rejected last round, e.g. ["Hush Room"].' },
      round: { type: 'integer', minimum: 1, maximum: 3, description: 'Naming round, e.g. 2.' },
      ...namingContext,
      ...lookupProperties,
      detail: detailSchema,
      names: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 100 },
        description: '1 to 20 bare names without endings, e.g. ["Quiet Otter","Hush Room"].' },
      shortlist: { type: 'boolean', description: 'Set true for a short naming shortlist.' },
      purchase: { type: 'boolean', description: 'Set true when asked to buy or register.' },
      companyType: { type: 'string', enum: Object.keys(handlePriorities),
        description: 'Business type for handle priorities, e.g. "developer".' },
      additionalHandles: { type: 'array', uniqueItems: true, items: { type: 'string', enum: requestPlatforms.map(platform => platform.id) },
        description: 'Extra handle links only on request, e.g. ["reddit"].' },
      category: { type: 'string', minLength: 1, maxLength: 100, description: 'Category for trademark and rival checks, e.g. "travel".' },
      about: { type: 'string', minLength: 1, maxLength: 160, description: 'What the product does, e.g. "Book group travel", for rival and app checks.' },
      candidates: { type: 'object', maxProperties: 20,
        additionalProperties: { type: 'object', additionalProperties: false, properties: Object.fromEntries(Object.entries(candidateFields)
          .map(([key, rule]) => {
            const schema = rule === 'boolean' ? { type: 'boolean' }
              : rule === 'integer' ? { type: 'integer', minimum: 1, maximum: 5 } : { type: 'string', enum: rule };
            return [key, { ...schema, description: candidateDescriptions[key] }];
          })) },
        description: 'Your naming evidence by name, e.g. {"Loomfox":{"recipe":"odd-pair","relation":"direct","spellings":1,"realWord":true}}. '
          + 'Missing evidence counts as not checked. One spelling means one obvious spelling when heard.' },
      geo: { type: 'object', maxProperties: 20,
        additionalProperties: { type: 'string', minLength: 1, maxLength: 160, pattern: '^\\s*(?:[Kk]nown\\b.*\\S.*|[Uu]nknown)\\s*$' },
        description: geoInstruction + ' Example: {"ExampleBoard":"known: a team notes workspace","QuietOtter":"unknown"}.' },
    },
    oneOf: [{ required: ['names'] }, { required: ['idea'] }],
    additionalProperties: false,
  },
};

const namingTool = {
  name: 'naming_guide',
  description: 'Use this when someone asks for a method before brainstorming, to find a domain alternative, to rebrand or to choose a name that lasts. '
    + 'Use triage_names to generate ideas or screen names.',
  annotations: { title: 'Product naming guide', ...searchAnnotations, openWorldHint: false },
  inputSchema: { type: 'object', properties: {
    about: { type: 'string', minLength: 1, maxLength: 512, description: 'Optional product description, e.g. "A room booking app".' },
  }, additionalProperties: false },
};

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// The legacy display stays in structured results. Lookup tools can supply their own text.
function toolResult(json, isError = false) {
  const structured = JSON.parse(json);
  return { content: [{ type: 'text', text: structured.display }], structuredContent: structured, isError };
}
const errorResult = message => toolResult(errorText(message), true);

// Keep the existing compact structured response, including the complete batch status list.
function compactCheckResult(result) {
  if (result.isError) return result;
  const { names, resultPage, pending } = result.structuredContent;
  const rows = (names ?? []).map(({ name, free, taken, reserved, resale, likely_free, likely_taken, shop_check, checking }) => {
    const statuses = [
      ['available', free?.filter(row => row.s !== 'prem' && !row.prem).map(row => row.d)],
      ['premium', free?.filter(row => row.s === 'prem' || row.prem).map(row => row.d)],
      ['taken', taken], ['reserved', reserved], ['listed for resale', resale], ['possibly available (DNS)', likely_free],
      ['likely taken (DNS)', likely_taken], ['check at shop', shop_check?.filter(ending =>
        !likely_free?.includes(ending) && !likely_taken?.includes(ending))], ['still checking', checking],
    ];
    return { name, statuses: Object.fromEntries(statuses.filter(([, endings]) => endings?.length)) };
  });
  const structuredContent = {
    ...(resultPage && { resultPage }), ...(pending && { pending }),
    ...(rows.length && { rows }),
  };
  return { ...result, structuredContent };
}

function lookupResult(page, args, triage = false) {
  const result = toolResult(JSON.stringify(page));
  if (args.detail === 'full') {
    const alternatives = triage ? [] : (page.checks ?? []).flatMap(check => {
      const options = check.query.exactDomain && check[alternativeEndings];
      return options ? checkLines({ ...options, domains: options.domains.filter(row => row.domain !== check.query.exactDomain) },
        page.pending, { local: true }) : [];
    });
    if (alternatives.length) result.content[0].text += '\n\nOther endings\n' + alternatives.join('\n');
    return result;
  }
  const link = page.resultPage && resultsLine(page.resultPage).replace(/^Results page:/, 'All prices, shops and handles:');
  const local = page[shortPresentation];
  const checks = page.checks ?? local;
  if (!checks && page.pending) {
    const names = page.names ?? [];
    const progressRows = (triage ? names.slice(0, 5) : names).map(({ name, free, taken, premium }) => {
      const show = values => values.map(value => {
        const ending = value.d ?? value;
        return ending === name ? ending : '.' + ending;
      }).join(' ');
      const available = (free ?? []).filter(value => value.s !== 'prem');
      const extras = premium ?? free?.filter(value => value.s === 'prem');
      const verdict = [
        available.length ? 'available ' + show(available) : '',
        taken?.length ? 'taken ' + show(taken) : '',
        extras?.length ? 'premium ' + show(extras) : '',
      ].filter(Boolean).join(' · ');
      return md(name) + (verdict ? (triage ? ' - ' : ': ') + verdict : '');
    });
    result.content[0].text = [...progressRows, 'Still checking ' + (triage ? 'names and domains.' : 'domains.'),
      args.purchase && !triage ? 'This check leaves checkout to you.' : '', link].filter(Boolean).join('\n');
    return result;
  }
  if (!triage && !checks?.length) {
    result.content[0].text = ['No domain results to show.', link].filter(Boolean).join('\n');
    return result;
  }

  const options = { pending: Boolean(page.pending), link };
  const short = triage
    ? shortIdeaAnswer(visibleChecks(checks ?? [], args, page.generation), options)
    : checks.map(check => shortDomainAnswer({ ...check, alternatives: check[alternativeEndings] }, {
      ...options, link: checks.length === 1 ? link : undefined,
    })).join('\n\n');
  const notes = [
    ...(args.purchase && !triage ? [page.quoteOffer ? 'Ask for a live Spaceship quote.' : 'This check leaves checkout to you.'] : []),
    ...(local && !triage ? [localCheckNotice] : []),
  ];
  const text = triage ? short : [
    short.replace(/^[^\n]+/, first => [first, ...notes].join(' ')),
    ...(checks.length !== 1 ? [link] : []),
  ].filter(Boolean).join('\n');
  return { ...result, content: [{ type: 'text', text }] };
}

function localProgress(json) {
  const progress = JSON.parse(json);
  return JSON.stringify({ ...progress, source: 'local', display: localCheckNotice + '\n' + progress.display });
}

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
  validateDetail(args);
  const flags = lookupFlags(args);
  if (args.endings) flags.push('--prefer-endings', args.endings.join(','));
  if (args.budget !== undefined) flags.push('--upfront-cap', String(args.budget));
  const hasQuery = Object.hasOwn(args, 'query');
  if (hasQuery === Object.hasOwn(args, 'names')) throw new Error('Supply exactly one of query or names.');
  if (Object.hasOwn(args, 'shortlist') && typeof args.shortlist !== 'boolean') {
    throw new Error('shortlist must be a boolean.');
  }
  if (Object.hasOwn(args, 'picked') && (typeof args.picked !== 'boolean'
    || (args.picked && (!hasQuery || typeof args.query !== 'string' || !args.query.includes('.'))))) {
    throw new Error('picked must be a boolean and requires an exact domain query when true.');
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

// Naming evidence per screened name; the keys must be names in the list, like geo.
function candidatesValue(candidates, names) {
  const valid = isObject(candidates) && Object.keys(candidates).length <= 20
    && Object.entries(candidates).every(([name, entry]) => name.length >= 1 && name.length <= 100 && validCandidate(entry));
  if (!valid) throw new Error('candidates must map each name to naming evidence with the supported fields and values.');
  const screened = new Set(names.map(normalizeName).filter(Boolean));
  const extra = Object.keys(candidates).find(name => !screened.has(normalizeName(name)));
  if (extra !== undefined) throw new Error('candidates names ' + showValue(extra) + ', which is not in names.');
  return candidates;
}

function triageArguments(args) {
  if (!isObject(args) || Object.keys(args).some(key => !Object.hasOwn(triageTool.inputSchema.properties, key))) {
    throw new Error('Supply an object with names and an optional about.');
  }
  if (!Array.isArray(args.names) || args.names.length < 1 || args.names.length > 20) {
    throw new Error('names must list 1 to 20 names' + (Array.isArray(args.names) ? '; it has ' + args.names.length : '') + '.');
  }
  if (['idea', 'wanted', 'avoid', 'round'].some(key => Object.hasOwn(args, key))) {
    throw new Error('Use wanted, avoid and round only with idea.');
  }
  const bad = args.names.findIndex(name => typeof name !== 'string' || !name.trim() || name.length > 100 || /[,.\p{Cc}]/u.test(name));
  if (bad >= 0) {
    throw new Error('names[' + bad + '] is not valid. Supply 1 to 20 bare names of up to 100 characters, without commas or domain endings.');
  }
  validateDetail(args);
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
  if (Object.hasOwn(args, 'candidates')) flags.push('--candidates', JSON.stringify(candidatesValue(args.candidates, args.names)));
  return ['--triage', args.names.join(','), '--compact', '--receipt', ...flags];
}

function validateDetail(args) {
  if (Object.hasOwn(args, 'detail') && !detailSchema.enum.includes(args.detail)) throw new Error('Choose short or full detail.');
}

function generationArguments(args) {
  validateDetail(args);
  if (Object.keys(args).some(key => !['idea', 'wanted', 'avoid', 'round', 'detail', ...Object.keys(namingContext)].includes(key))) {
    throw new Error('Supply an idea and any naming preferences or proposals.');
  }
  const { idea, wanted, avoid, round } = args;
  if (typeof idea !== 'string' || idea.trim().length < 3 || idea.length > 400 || !/\p{L}/u.test(idea) || /[\p{Cc}\p{Cf}]/u.test(idea)) {
    throw new Error('Give a product idea between 3 and 400 characters.');
  }
  for (const value of [wanted, avoid]) {
    if (value !== undefined && (!Array.isArray(value) || value.length > 5
      || value.some(name => typeof name !== 'string' || !name.trim() || name.length > 40 || !/^[\p{L}\p{M}\p{N} '.-]+$/u.test(name)))) {
      throw new Error('Wanted and avoid can list up to five names, each up to 40 characters.');
    }
  }
  if (round !== undefined && (!Number.isInteger(round) || round < 1 || round > 3)) throw new Error('Choose a round from 1 to 3.');
  const context = Object.fromEntries(Object.entries(args).filter(([key]) => Object.hasOwn(namingContext, key)));
  if (Buffer.byteLength(JSON.stringify(context)) > (context.proposals ? 11_000 : 3500)) {
    throw new Error('Keep the current brief, taste notes and shown names short enough for one round.');
  }
  return { idea: idea.trim(), ...(wanted && { wanted }), ...(avoid && { avoid }), ...(round && { round }), ...context };
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
    cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DOMAIN_HOUND_OPEN: 'off', DOMAIN_HOUND_PROGRESS: '1', DOMAIN_HOUND_MCP_OUTPUT: '1',
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
  onLookupEvent, scoreLog = scoreLogger(), hosted = cwd === capabilityDir ? hostedClient(serverVersion) : null,
} = {}) {
  const send = response => output.write(JSON.stringify({ jsonrpc: '2.0', ...response }) + '\n');
  const error = (id, code, message) => send({ id, error: { code, message } });
  const pending = new Set();
  const lookups = new Map();
  const hostedLookups = new Map();
  const hostedShutdown = new AbortController();
  const generations = new Map();
  const background = new Set();

  // Join the running or finished lookup for the same input, or start one. Answer within the budget with the
  // result, or with the progress so far while the lookup keeps running for a repeated call to collect.
  async function runLookup(args, buildArgs, rowsFor, render, renderProgress, onLookup = () => {}, started = performance.now()) {
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
        const snapshot = await renderProgress(lookup.progress, {
          rows, elapsedMs: performance.now() - lookup.started, budgetMs: timeout }, lookup);
        return lookupResult(JSON.parse(snapshot), args, buildArgs === triageArguments);
      } catch {
        return errorResult('Domain Hound could not format the progress.');
      }
    }
    if (lookup.outcome.error) {
      if (lookups.get(key) === lookup) lookups.delete(key);
      return errorResult(lookup.outcome.error);
    }
    try {
      const page = await render(lookup.outcome.data, lookup);
      return lookupResult(page, args, buildArgs === triageArguments);
    } catch {
      return errorResult('Domain Hound could not format the result.');
    }
  }
  const track = task => {
    const tracked = Promise.resolve(task).catch(() => {}).finally(() => background.delete(tracked));
    background.add(tracked);
    return tracked;
  };

  async function hostedLookup(args, triage, started, { streamDomains = !triage } = {}) {
    if (!hosted || args?.confirm === true || (triage && args?.additionalHandles?.length)) return null;
    let rows;
    try {
      (triage ? triageArguments : cliArguments)(args);
      rows = (triage ? triageRows : checkRows)(args);
      if (!rows.length || (triage && args.names.some(name => !normalizeName(name)))) return null;
    } catch (problem) {
      return errorResult(problem.message);
    }
    const { detail, ...lookupArgs } = args;
    const key = JSON.stringify([triage, streamDomains, Object.entries(lookupArgs).sort(([a], [b]) => a.localeCompare(b))]);
    let lookup = hostedLookups.get(key);
    const repeat = Boolean(lookup);
    if (!lookup) {
      const extra = selectedEndings(args).filter(ending => !defaultEndings.includes(ending));
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, hostedShutdown.signal, AbortSignal.timeout(hostedLookupMs)]);
      const job = { result: null, first: null };
      const early = new Array(rows.length);
      const firstChecks = [];
      let received = 0;
      let canStream = false;
      let ready;
      job.ready = new Promise(resolve => { ready = resolve; });
      const receive = (answer, index, qualifies = false, apple, alternatives) => {
        if (!streamDomains || early[index]) return;
        early[index] = { ...answer };
        if (apple) firstChecks.push(apple.then(appStore => { if (appStore) early[index].appStore = appStore; }));
        if (alternatives) firstChecks.push(alternatives.then(comparison => { early[index][alternativeEndings] = comparison; }));
        received += 1;
        if (qualifies) canStream = true;
        if (received === rows.length && canStream) {
          // Keep the domain answer available at the deadline, even while Apple's retry runs in the background.
          job.first = within({ done: Promise.all(firstChecks) }, Math.min(timeout, hostedFirstAnswerMs) - (performance.now() - started))
            .then(() => renderHostedLookup(early.map(answer => ({ ...answer })), lookupArgs, triage, { pending: true }));
          ready();
        }
      };
      job.done = Promise.all(rows.map(async ({ name }, index) => {
        const answer = await hosted.check(name, name.includes('.') ? [] : extra, signal,
          streamDomains ? (value, apple, alternatives) => receive(value, index, true, apple, alternatives) : undefined);
        receive(answer, index);
        return answer;
      })).then(async answers => {
        const first = await job.first;
        return renderHostedLookup(answers, lookupArgs, triage, { reuse: first?.resultPage });
      }, problem => {
          if (problem instanceof HostedRateLimit) return errorResult('The Hound needs a breather. Try again in a few minutes.');
          hostedDebug('Hosted domain lookup could not finish; using the local check.');
          return null;
        }).then(result => {
          job.result = result;
          job.finished = true;
          ready(result);
          setTimeout(() => { if (hostedLookups.get(key) === job) hostedLookups.delete(key); }, keepFinishedMs).unref();
        }).finally(() => controller.abort());
      lookup = job;
      hostedLookups.set(key, job);
    }
    const ready = repeat || detail === 'full' ? lookup.done : lookup.ready;
    if (!await within({ done: ready }, timeout - (performance.now() - started))) {
      if (lookup.first && streamDomains && !repeat) {
        const page = await lookup.first;
        if (page) return lookupResult(page, args);
      }
      hostedDebug('Hosted check exceeded the tool response budget; it is still running.');
      return lookupResult({
        display: attributed('The hosted check is still running. Call the same tool again with the same input to collect it.'),
        complete: false, pending: true,
      }, args, triage);
    }
    const page = lookup.finished ? lookup.result : await lookup.first;
    if (!page || page.isError) return page;
    return lookupResult(page, args, triage);
  }

  async function renderHostedLookup(checks, args, triage, { pending = false, reuse } = {}) {
    try {
      const evidence = hostedChecks(checks, args, triage);
      const page = await pages(hostedResult(evidence, args, null, { pending }), args, { triage, reuse, refresh: pending });
      if (triage && scoreLog?.enabled) {
        const scored = evidence.filter(check => Number.isInteger(check.score?.value))
          .sort((a, b) => compareScores(a.score, b.score));
        track(scoreLog.shown(scored.slice(0, args.shortlist ? 8 : scored.length).map(({ query, score }) => ({
          label: query.ascii, name: query.name, score,
        }))));
      }
      return triage ? page : withCheckQuoteOffer(page, args);
    } catch {
      return errorResult('Domain Hound could not format the result.');
    }
  }

  async function generateNames(args, started) {
    let input;
    try {
      input = generationArguments(args);
    } catch (problem) {
      return errorResult(problem.message);
    }
    const local = () => toolResult(JSON.stringify({
      display: attributed(args.detail === 'full'
        ? 'Use this naming method, then send your candidates to triage_names with names and shortlist: true.\n\n' + namingRecipe(input.idea)
        : 'Name generation is unavailable. Use naming_guide, then send your candidates to triage_names.'),
      source: 'local',
    }));
    if (!hosted) return local();
    const key = JSON.stringify(input);
    let job = generations.get(key);
    if (!job) {
      job = { page: null };
      generations.set(key, job);
      const write = (generation, pending = false, failed = false) => pages(
        hostedResult(generatedChecks(generation), {}, generation, { pending, failed }), {},
        { triage: true, reuse: job.page?.resultPage, refresh: pending },
      ).then(page => { job.page = page; });
      job.initial = (async () => {
        const initial = await hosted.generate(input, AbortSignal.timeout(Math.max(1, Math.floor(timeout - 750))));
        const pending = initial.stage === 'initial' && typeof initial.details?.id === 'string';
        await write(initial, pending);
        if (pending) job.finish = track(hosted.finishGeneration(initial).then(final => write(final), () => write(initial, false, true)));
      })();
      job.initial.then(() => {
        setTimeout(() => { if (generations.get(key) === job) generations.delete(key); }, keepFinishedMs).unref();
      }, () => generations.delete(key));
    }
    try {
      await job.initial;
      if (args.detail === 'full' && job.finish) await within({ done: job.finish }, timeout - (performance.now() - started));
      return lookupResult(job.page, args, true);
    } catch (problem) {
      return problem instanceof HostedRateLimit
        ? errorResult('The Hound needs a breather. Try again in a few minutes.') : local();
    }
  }

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
      const page = await pages({ ...data, source: 'local' }, args, { triage: true, reuse: lookup.page, refresh });
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
        not_seen: rows.filter(row => row.state === 'not-seen').map(row => row.platform),
        check: rows.filter(row => row.state === 'unknown').map(row => row.platform),
      }]));
      if (!check.rows) {
        evidence.handlesPending = true;
        running = true;
      }
      rescore(evidence, handleRows);
    }
    const page = await writeTriagePage(lookup, evidence, args, running);
    if (!running && !lookup.scoreLogged) {
      lookup.scoreLogged = true;
      logShown(evidence, args.shortlist);
    }
    return page;
  }

  // The screen scored names before the handle checks; score again with GitHub, npm and Bluesky as they land, and
  // put the top picks back in score order.
  function rescore(evidence, handleRows) {
    evidence.receiptDetails = evidence.receiptDetails.map((detail, index) => {
      const rows = handleRows.get(evidence.names[index].name);
      if (!detail?.scoreInput || !rows) return detail;
      const score = scoreName({ ...detail.scoreInput, handles: scoreHandles(rows) });
      if (detail.score?.overridesAvoid && score.value != null) score.overridesAvoid = true;
      evidence.names[index] = { ...evidence.names[index], score: compactScore(score) };
      return { ...detail, score };
    });
    if (Array.isArray(evidence.top)) {
      const scoreOf = name => evidence.names.find(row => row.name === name)?.score;
      evidence.top = evidence.top.map((row, index) => ({ row, index }))
        .sort((a, b) => compareScores(scoreOf(a.row.name), scoreOf(b.row.name)) || a.index - b.index).map(({ row }) => row);
    }
  }

  // One log line per scored name, once its checks are done; only when the person turned the local log on.
  function logShown(evidence, shortlist) {
    if (!scoreLog?.enabled) return;
    const rows = (evidence.receiptDetails ?? []).flatMap((detail, index) => {
      const row = evidence.names[index];
      const score = detail?.score;
      return !Number.isInteger(score?.value) || score.pending || (shortlist && !scoreEligible({ ...row, ...detail }))
        ? [] : [{ label: normalizeName(row.name), name: row.name, score }];
    });
    track(scoreLog.shown(rows.sort((a, b) => compareScores(a.score, b.score))));
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
        instructions: serverInstructions,
      });
    }
    if (method !== 'tools/list' && method !== 'tools/call') return error(id, -32601, 'Method not found');
    if (!initialized) return error(id, -32000, 'Domain Hound has not been initialized');
    if (method === 'tools/list') return reply({ tools: registeredTools([checkTool, triageTool, namingTool, watchTool, dossierTool, portfolioTool]) });
    const { name, arguments: args } = params ?? {};
    if (purchaseToolNames.has(name)) return reply(await callPurchaseTool(name, args));
    if (name === namingTool.name || name === 'naming_method') {
      if (args !== undefined && (!isObject(args) || Object.keys(args).some(key => key !== 'about') ||
        (Object.hasOwn(args, 'about') && (typeof args.about !== 'string' || !args.about.trim() ||
          args.about.length > namingTool.inputSchema.properties.about.maxLength)))) {
        return reply(errorResult('naming_guide accepts an optional about description of up to 512 characters.'));
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
    const started = performance.now();
    if (name === triageTool.name) {
      if (isObject(args) && Object.hasOwn(args, 'idea')) return reply(await generateNames(args, started));
      const fromHost = await hostedLookup(args, true, started);
      if (fromHost) return reply(fromHost);
      let current;
      const result = await runLookup(args, triageArguments, triageRows, (data, lookup) => triageReceipt(lookup, args, data),
        async (progress, timing, lookup) => {
          const summary = progressText(progress, { ...timing, triage: true, purchase });
          // Without a repeat call, the finished result still reaches the same page when the lookup ends.
          if (!progress.answers.size) {
            finishInBackground(lookup, args);
            return localProgress(summary);
          }
          const progressPage = pendingTriage(progress, timing.rows);
          const { resultPage } = await writeTriagePage(lookup, progressPage, args, true);
          finishInBackground(lookup, args, progressPage);
          const shown = JSON.parse(summary);
          shown.display = resultsLine(resultPage) + '\n' + shown.display;
          return localProgress(JSON.stringify({ ...shown, resultPage }));
        }, lookup => { current = lookup; }, started);
      reply(result);
      if (!result.isError && current?.finished && current.outcome?.data) followUp(current);
      return;
    }
    // The old advertised name remains callable for pinned tool references and scripts.
    if (name !== checkTool.name && name !== 'broker_find') return error(id, -32602, 'Unknown tool');
    // An exact lookup includes the purchase line while its registration status is unsettled.
    const exact = isObject(args) && typeof args.query === 'string' && args.query.includes('.');
    const legacy = name === 'broker_find';
    const result = await hostedLookup(args, false, started, { streamDomains: !legacy }) ?? await runLookup(
      args, cliArguments, checkRows, data => pages({ ...data, source: 'local' }, args).then(page => withCheckQuoteOffer(page, args)),
      (progress, timing) => localProgress(progressText(progress, { ...timing, purchase: purchase || exact })), undefined, started,
    );
    if (exact && args.picked === true && !result.isError && result.structuredContent?.resultPage) {
      track(scoreLog?.picked(args.query, 'check_domains'));
    }
    return reply(legacy ? result : compactCheckResult(result));
  }

  const lines = createInterface({ input, terminal: false, crlfDelay: Infinity });
  for await (const line of lines) {
    const response = handle(line).finally(() => pending.delete(response));
    pending.add(response);
  }
  await Promise.all(pending);
  hostedShutdown.abort();
  while (background.size) await Promise.all(background);
  // The client has gone, so nobody can collect a lookup that is still running.
  for (const lookup of lookups.values()) if (!lookup.exited) lookup.child.kill('SIGKILL');
  await Promise.all([...lookups.values()].flatMap(lookup => [lookup.done, lookup.later]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await serve();
