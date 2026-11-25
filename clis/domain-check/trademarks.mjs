import { anySignal, cacheDir, readCache, writeCache } from './cache.mjs';
import { compactText, day, exactPhrases, letters, markOrder, matchTier, relevantClasses, request } from './triage-sources.mjs';

// Optional EU (EUIPO Trademark Search API 1.1.0) and Norwegian (Patentstyret open data MCP) trademark searches.
// Both need a free key the user sets; without one the office is "off" and the results link to its own search.
// Keys are sent only to the fixed official hosts below. A failed office never reads as clear.
export const officeNames = { EU: 'EUIPO', NO: 'Patentstyret' };
const euipo = {
  production: { api: 'https://api.euipo.europa.eu/trademark-search', token: 'https://euipo.europa.eu/cas-server-webapp/oidc/accessToken' },
  sandbox: { api: 'https://api-sandbox.euipo.europa.eu/trademark-search', token: 'https://auth-sandbox.euipo.europa.eu/oidc/accessToken' },
};
const patentstyretMcp = 'https://api.patentstyret.no/external/open-data/mcp';
const euRecord = number => 'https://euipo.europa.eu/eSearch/#details/trademarks/' + number;
const noRecord = /^https:\/\/services\.patentstyret\.no\/search-details\/trademark\/[\w-]{4,40}$/;
// Live EU statuses: everything except withdrawn, refused, cancelled, surrendered, expired and removed marks.
const euLive = ['RECEIVED', 'UNDER_EXAMINATION', 'APPLICATION_PUBLISHED', 'REGISTRATION_PENDING', 'REGISTERED',
  'OPPOSITION_PENDING', 'APPEALED', 'CANCELLATION_PENDING', 'APPEALABLE', 'START_OF_OPPOSITION_PERIOD',
  'ACCEPTANCE_PENDING', 'ACCEPTED'];
const euDead = new Set(['WITHDRAWN', 'REFUSED', 'CANCELLED', 'SURRENDERED', 'EXPIRED', 'REMOVED_FROM_REGISTER']);
const noDead = /withdr|refus|reject|expir|ended|ceas|cancel|laps|invalid|revok|surrend|abandon|remov|dead|terminat|henlag|avsl|opph|slett|trukket|utg/i;
const noLive = /regist|pend|filed|appli|publish|oppos|appeal|exam|accept|grant|valid|active|søkt|under|innvilg/i;
const staleLimit = 30 * day;
const holds = new Map();
const tokens = new Map();
const sessions = new Map();
let rpcId = 0;

class Failure extends Error {
  constructor(why, retry = false) {
    super(why);
    this.retry = retry;
  }
}

const printable = (value, min) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length >= min && text.length <= 256 && /^[\x21-\x7e]+$/.test(text) ? text : null;
};

// Which offices have keys. EUIPO needs both the client ID and secret of an app subscribed to Trademark Search.
export function trademarkKeys(env = process.env) {
  const id = printable(env?.DOMAIN_HOUND_EUIPO_CLIENT_ID, 8);
  const secret = printable(env?.DOMAIN_HOUND_EUIPO_CLIENT_SECRET, 8);
  const key = printable(env?.DOMAIN_HOUND_PATENTSTYRET_KEY, 16);
  return {
    EU: id && secret ? { id, secret, ...euipo[env.DOMAIN_HOUND_EUIPO_SANDBOX === '1' ? 'sandbox' : 'production'] } : null,
    NO: key ? { key } : null,
  };
}

const budget = options => Math.min(2600, (options.timeLeft?.() ?? Infinity) - 250);

function httpFailure(office, response) {
  if (response.status === 429) {
    const wait = Number(response.headers?.get('retry-after'));
    holds.set(office, Date.now() + (wait > 0 && wait < 3600 ? wait * 1000 : 60_000));
    return new Failure('rate limited');
  }
  if (response.status === 401 || response.status === 403) {
    // A refused key stays refused for the rest of this run; the other names do not ask again.
    holds.set(office, Date.now() + 10 * 60_000);
    return new Failure('key refused');
  }
  return new Failure(response.status >= 500 ? 'unavailable' : 'request refused', response.status >= 500);
}

// One mark row in the same shape as the USPTO rows. Dead marks and loose spellings drop out.
function markRow(key, { office, text, owner, classes, status, live, url }) {
  const mark = letters(text);
  if (!mark || live === false) return [];
  const tier = matchTier(key, mark);
  if (!tier || (tier === 'Fuzzy' && key.length < 5)) return [];
  const codes = [...new Set((Array.isArray(classes) ? classes : []).map(Number)
    .filter(value => Number.isInteger(value) && value >= 1 && value <= 45))].sort((a, b) => a - b)
    .map(value => String(value).padStart(3, '0'));
  return [{ office, name: compactText(text, 65), owner: compactText(owner, 70), classes: codes, tier,
    status: compactText(status, 30).toLowerCase() || 'status unavailable', live: live === true ? true : null,
    registered: /^regist/i.test(String(status)), url }];
}

// Relevance follows the same class rules as USPTO. A mark whose live status is unclear never forces Avoid.
function judged(rows, category) {
  const relevant = relevantClasses(category);
  return rows.map(row => {
    const classes = row.classes.filter(value => relevant.includes(value));
    return { ...row, relevant: row.live === true && classes.length > 0, relevantClasses: classes };
  });
}

function pluralForms(key) {
  return [key + 's', key + 'es', key.replace(/y$/, 'ies'), key.replace(/(?:es|s)$/, ''), key.replace(/ies$/, 'y')]
    .filter(value => value !== key && matchTier(key, value) === 'Near-identical');
}

// Wildcards find candidates for a vowel swap or doubled letter. The shared matcher scores the returned text.
function nearPatterns(key) {
  return [...key].flatMap((letter, index) => {
    const start = key.slice(0, index);
    const end = key.slice(index + 1);
    const forms = [start + letter + '*' + end];
    if ('aeiouy'.includes(letter)) forms.push(start + '*' + end);
    if (letter === key[index - 1]) forms.push(start + end);
    return forms;
  });
}

// RSQL for exact, spaced, split and near spellings in lower, upper and title case.
// Returns the query and whether every spelling fit under the API's 5000-character limit.
export function euipoQuery(key, input) {
  const phrases = [...exactPhrases(key, input), ...pluralForms(key), ...nearPatterns(key)];
  const typed = String(input ?? '').trim();
  const forms = [...(/^[\p{L}\p{N} &'.-]{1,80}$/u.test(typed) ? [typed] : []),
    ...phrases.flatMap(phrase => [phrase, phrase.toUpperCase(), phrase.replace(/(^|\s)([a-z])/g, (_, space, letter) => space + letter.toUpperCase())])];
  const status = ' and status=in=(' + euLive.join(',') + ')';
  const clauses = [];
  let complete = true;
  for (const form of new Set(forms)) {
    const value = form.includes('*') ? form : '"' + form.replace(/["\\]/g, '\\$&') + '"';
    const clause = 'wordMarkSpecification.verbalElement==' + value;
    if ([...clauses, clause].join(' or ').length + status.length + 2 > 4800) {
      complete = false;
      break;
    }
    clauses.push(clause);
  }
  return { query: '(' + clauses.join(' or ') + ')' + status, complete };
}

async function euipoToken(config, options) {
  const cached = tokens.get(config.token + config.id);
  if (cached && cached.until > Date.now()) return cached.promise;
  const entry = { until: Infinity };
  entry.promise = (async () => {
    // The EUIPO security guide sends the client credentials in the form body.
    const response = await request(config.token, options, { method: 'POST', timeout: budget(options),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: config.id, client_secret: config.secret, grant_type: 'client_credentials', scope: 'uid' }) });
    if (!response.ok) {
      await response.body?.cancel();
      // An unknown client or wrong secret answers 400 invalid_client or 401.
      throw httpFailure('EU', { status: response.status === 400 ? 401 : response.status, headers: response.headers });
    }
    const data = await response.json();
    if (typeof data?.access_token !== 'string' || !data.access_token) throw new Failure('no token', true);
    const lifetime = Number(data.expires_in);
    entry.until = Date.now() + Math.max(30, (lifetime > 0 ? lifetime : 600) - 60) * 1000;
    return data.access_token;
  })();
  tokens.set(config.token + config.id, entry);
  entry.promise.catch(() => tokens.delete(config.token + config.id));
  return entry.promise;
}

async function euipoMarks(key, input, config, options) {
  const token = await euipoToken(config, options);
  const { query, complete } = euipoQuery(key, input);
  const response = await request(config.api + '/trademarks?' + new URLSearchParams({ query, page: '0', size: '100' }), options, {
    timeout: budget(options), headers: { Authorization: 'Bearer ' + token, 'X-IBM-Client-Id': config.id, Accept: 'application/json' },
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401) tokens.delete(config.token + config.id);
    throw httpFailure('EU', response);
  }
  const data = await response.json();
  if (!Array.isArray(data?.trademarks)) throw new Failure('unreadable answer', true);
  const { totalElements } = data;
  let partial = !complete || !Number.isSafeInteger(totalElements) || totalElements < 0
    || totalElements !== data.trademarks.length;
  const rows = data.trademarks.flatMap(item => {
    const number = /^(?:\d{9}|W\d{8}[A-Z]?)$/.test(item?.applicationNumber) ? item.applicationNumber : null;
    const status = typeof item?.status === 'string' ? item.status : '';
    if (euDead.has(status)) return [];
    const text = item?.wordMarkSpecification?.verbalElement;
    const live = euLive.includes(status) ? true : null;
    if (live === null || !letters(text) || !number || !Array.isArray(item?.niceClasses)) partial = true;
    return markRow(key, { office: 'EU', text,
      owner: (Array.isArray(item?.applicants) ? item.applicants : []).map(person => person?.name).find(name => typeof name === 'string') ?? '',
      classes: item?.niceClasses, status: status.replace(/_/g, ' '), live,
      url: number ? euRecord(number) : null });
  });
  return { rows, partial };
}

// Patentstyret: the documented MCP search (JSON-RPC over HTTP). The search tool's argument names come from
// its own schema, so a renamed argument is picked up without a release.
async function mcpPost(key, session, body, options) {
  const response = await request(patentstyretMcp, options, { method: 'POST', timeout: budget(options), headers: {
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Ocp-Apim-Subscription-Key': key,
    ...(session?.id && { 'Mcp-Session-Id': session.id }), ...(session?.version && { 'MCP-Protocol-Version': session.version }),
  }, body: JSON.stringify(body) });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404 && session) sessions.delete(key);
    throw response.status === 404 && session ? new Failure('session ended', true) : httpFailure('NO', response);
  }
  return response;
}

function jsonOrNull(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function rpc(key, session, method, params, options) {
  const id = ++rpcId;
  const response = await mcpPost(key, session, { jsonrpc: '2.0', id, method, params }, options);
  const text = await response.text();
  const messages = /text\/event-stream/i.test(response.headers.get('content-type') ?? '')
    ? text.split(/\r?\n\r?\n/).map(event => jsonOrNull(event.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart()).join('\n')))
    : [jsonOrNull(text)];
  const message = messages.flat().find(item => item?.id === id);
  if (!message) throw new Failure('unreadable answer', true);
  if (message.error) throw new Failure('search refused');
  return { result: message.result, response };
}

// The search tool and its text and size arguments, from tools/list.
export function searchTool(tools) {
  const tool = (Array.isArray(tools) ? tools : []).find(item => item?.name === 'search_trademarks');
  const properties = tool?.inputSchema?.properties;
  if (!properties || typeof properties !== 'object') return null;
  const entries = Object.entries(properties);
  const strings = entries.filter(([, schema]) => schema?.type === 'string' || schema?.type?.includes?.('string'));
  const text = strings.find(([name]) => /^(?:query|q|search_?text|search_?term|search|text|term|keywords?|word_?mark|mark_?text|mark|trademark|name)$/i.test(name))?.[0]
    ?? strings.find(([name]) => tool.inputSchema.required?.includes(name))?.[0];
  const [size, sizeSchema] = entries.find(([name, schema]) => ['integer', 'number'].includes(schema?.type)
    && /^(?:size|limit|page_?size|max(?:_?results)?|top|take|count|rows)$/i.test(name)) ?? [];
  return text ? { text, ...(size && { size, limit: Math.max(1, Math.min(50, Number(sizeSchema.maximum) || 50)) }) } : null;
}

async function mcpSession(key, options) {
  if (!sessions.has(key)) {
    const opening = (async () => {
      const { result, response } = await rpc(key, null, 'initialize', {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'domain-hound', version: '0.1' },
      }, options);
      const session = { id: printable(response.headers.get('mcp-session-id'), 1) ?? undefined,
        version: typeof result?.protocolVersion === 'string' ? result.protocolVersion.slice(0, 20) : '2025-06-18' };
      await (await mcpPost(key, session, { jsonrpc: '2.0', method: 'notifications/initialized' }, options)).body?.cancel();
      const tool = searchTool((await rpc(key, session, 'tools/list', {}, options)).result?.tools);
      if (!tool) throw new Failure('search tool not found');
      return { ...session, tool };
    })();
    sessions.set(key, opening);
    opening.catch(() => sessions.delete(key));
  }
  return sessions.get(key);
}

const textOf = value => typeof value === 'string' ? value : typeof value?.$ === 'string' ? value.$ : '';

function partyName(party) {
  const name = party?.contact?.contactTypeChoiceSequence?.name?.entityName ?? party?.contact?.name?.entityName;
  return [name?.transliterationName?.[0], name?.phraseType, name?.organizationStandardName, name].map(textOf).find(Boolean) ?? '';
}

// Cases in WIPO ST.96 JSON, as in Patentstyret's published dummy case, wherever the result list nests them.
export function patentstyretCases(data) {
  const cases = [];
  let visited = 0;
  const walk = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 8 || ++visited > 5000) return;
    if (value.trademarkApplication && typeof value.trademarkApplication === 'object') cases.push(value.trademarkApplication);
    else if (value.trademarkBag && typeof value.trademarkBag === 'object') cases.push(value);
    else for (const child of Array.isArray(value) ? value : Object.values(value)) walk(child, depth + 1);
  };
  walk(data, 0);
  const total = data && typeof data === 'object' && !Array.isArray(data) ? Object.entries(data)
    .find(([name, value]) => /^(?:total(?:_?(?:count|hits|results|elements))?|number_?of_?hits|hit_?count|count)$/i.test(name)
      && Number.isSafeInteger(value))?.[1] : undefined;
  return { cases, total };
}

function caseRow(key, item) {
  const mark = item?.trademarkBag?.trademark?.[0];
  const words = mark?.markRepresentation?.markReproduction?.wordMarkSpecification;
  const number = textOf(mark?.trademarkTypeChoice1?.applicationNumber?.[0]?.applicationNumberText);
  const status = textOf(mark?.markCurrentStatusCode);
  const classes = (Array.isArray(mark?.goodsServicesBag?.goodsServices) ? mark.goodsServicesBag.goodsServices : [])
    .flatMap(goods => (goods?.classDescriptionBag?.classDescription ?? []).map(entry => entry?.classNumber));
  const url = typeof item?.caseUrl === 'string' && noRecord.test(item.caseUrl) ? item.caseUrl
    : /^\d{6,12}$/.test(number) ? 'https://services.patentstyret.no/search-details/trademark/' + number : null;
  return markRow(key, { office: 'NO', text: textOf(words?.markVerbalElementText) || textOf(words?.markSignificantVerbalElementText),
    owner: partyName(item?.holderBag?.holder?.[0]) || partyName(mark?.applicantBag?.applicant?.[0]),
    classes, status, live: !status ? null : noDead.test(status) ? false : noLive.test(status) ? true : null, url });
}

async function patentstyretSearch(key, session, query, options) {
  const { tool } = session;
  const { result } = await rpc(key, session, 'tools/call', { name: 'search_trademarks',
    arguments: { [tool.text]: query, ...(tool.size && { [tool.size]: tool.limit }) } }, options);
  if (result?.isError) throw new Failure('search refused');
  const content = Array.isArray(result?.content) ? result.content : [];
  const data = result?.structuredContent ?? jsonOrNull(content.filter(part => part?.type === 'text').map(part => part.text).join(''));
  if (data == null || typeof data !== 'object') throw new Failure('unreadable answer');
  const { cases, total } = patentstyretCases(data);
  const empty = Array.isArray(data) ? data.length === 0 : Array.isArray(data.results) && data.results.length === 0;
  if (!cases.length && !empty && !(total > 0)) throw new Failure('unreadable answer');
  return { cases, partial: total !== undefined ? total > cases.length : Boolean(tool.size && cases.length >= tool.limit) };
}

async function patentstyretMarks(key, input, config, options) {
  const session = await mcpSession(config.key, options);
  const spaced = input.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const queries = [...new Set([key, spaced].filter(Boolean))];
  const answers = await Promise.all(queries.map(query => patentstyretSearch(config.key, session, query, options)));
  // The glued and spaced searches can return the same case once each.
  const rows = answers.flatMap(answer => answer.cases.flatMap(item => caseRow(key, item)));
  return { rows: [...new Map(rows.map(row => [row.url ?? row.name + row.status, row])).values()],
    partial: answers.some(answer => answer.partial) || rows.some(row => row.live === null || !row.url || !row.classes.length) };
}

const fetchers = { EU: euipoMarks, NO: patentstyretMarks };

// One office for one name. States: off (no key), ok (marks, partial when the answer was cut short) or failed.
// A failed office keeps the marks of an earlier answer, labelled with its date, and is never read as clear.
// One retry, only for a transient failure, and only while the shared time budget lasts.
export async function checkOffice(office, name, input, options = {}) {
  const config = trademarkKeys(options.env ?? process.env)[office];
  if (!config) return { office, state: 'off' };
  const { directory = cacheDir, now = new Date() } = options;
  const key = letters(name);
  const source = config.api === euipo.sandbox.api ? 'eu-sandbox' : office.toLowerCase();
  const filename = 'trademark-' + source + '-' + key + '.json';
  const saved = await readCache(directory, filename);
  const age = now.getTime() - saved?.at;
  const savedRows = Array.isArray(saved?.rows) ? saved.rows : null;
  const finish = (state, rows, extra = {}) => ({ office, state,
    marks: judged(rows, options.category).sort(markOrder(key)), ...extra });
  if (savedRows && age >= 0 && age < day) return finish('ok', savedRows, { partial: false, checkedAt: new Date(saved.at).toISOString() });
  const duration = Math.floor(budget(options));
  const deadline = performance.now() + duration;
  const attempt = async () => {
    if ((holds.get(office) ?? 0) > Date.now()) return { failed: 'rate limited or key refused earlier in this run' };
    if (sourceOptions.signal.aborted || budget(sourceOptions) < 700) return { failed: 'out of time' };
    try {
      return await fetchers[office](key, String(input ?? name), config, sourceOptions);
    } catch (error) {
      return error instanceof Failure ? { failed: error.message, retry: error.retry } : { failed: 'no answer', retry: true };
    }
  };
  const controller = new AbortController();
  const sourceOptions = { ...options, timeLeft: () => deadline - performance.now(),
    signal: anySignal([options.signal, controller.signal].filter(Boolean)) };
  const timer = setTimeout(() => controller.abort(), Math.max(1, duration));
  let answer;
  try {
    answer = await attempt();
    if (answer.retry && !sourceOptions.signal.aborted && budget(sourceOptions) >= 2000) answer = await attempt();
  } finally {
    clearTimeout(timer);
  }
  if (!answer.failed) {
    if (!answer.partial) await writeCache(directory, filename, { at: now.getTime(), rows: answer.rows }).catch(() => {});
    return finish('ok', answer.rows, { partial: answer.partial, checkedAt: now.toISOString() });
  }
  // Marks from an earlier answer keep their date, so an outage never hides a known mark.
  const stale = savedRows && age >= 0 && age < staleLimit
    ? savedRows.map(row => ({ ...row, checkedAt: new Date(saved.at).toISOString().slice(0, 10) })) : [];
  return finish('failed', stale, { why: answer.failed, ...(stale.length && { checkedAt: new Date(saved.at).toISOString() }) });
}

// Only a complete answer can support "no mark found" for that office.
export const officeAnswered = result => result?.state === 'ok' && !result.partial;

// Clears the in-process token, session and hold memory (tests).
export function resetOffices() {
  holds.clear();
  tokens.clear();
  sessions.clear();
}
