import './test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { serve } from './server.mjs';
import { hostedClient } from './hosted.mjs';
import { resultPages, resultsLine } from './results.mjs';
import { deadlineClock } from './test-support/deadline-clock.mjs';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeCache } from './clis/domain-check/cache.mjs';
import { defaultEndings } from './clis/domain-check/name-search.mjs';
import { triageNames } from './clis/domain-check/triage.mjs';
import { attribution, checkText, errorText as errorJson, localCheckNotice, md, neverBuys, purchaseLine, safeLink, triageText } from './display.mjs';

const server = new URL('./server.mjs', import.meta.url);
const { version } = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
const capability = fileURLToPath(new URL('./fixtures/', import.meta.url));
const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const handshake = (protocolVersion = '2025-11-25') => [
  request(1, 'initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '1' } }),
  { jsonrpc: '2.0', method: 'notifications/initialized' },
];
const call = (id, args, name = 'check_domains') => request(id, 'tools/call', { name, arguments: args });

// The fixture capability is injected through serve({ cwd }); the shipped server always uses its own package copy.
function exchange(messages, { legacy = false, fastTimeout = false } = {}) {
  const options = JSON.stringify({ cwd: capability, ...(fastTimeout && { timeout: 350 }) });
  const args = ['--input-type=module', '-e', `import { serve } from ${JSON.stringify(server.href)}; await serve(${options});`];
  return runServer(args, messages, { DOMAIN_HOUND_TEST_LEGACY: legacy ? '1' : '0' });
}

function runServer(args, messages, env = {}, cwd = undefined) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, args, {
      env: { ...process.env, DOMAIN_HOUND_LOCAL: '1', ...env, DOMAIN_HOUND_OPEN: 'off' }, cwd,
      timeout: 5000,
    }, (error, stdout) => {
      if (error) return reject(error);
      try {
        resolve(stdout.trim().split('\n').map(line => JSON.parse(line)));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(messages.map(message => typeof message === 'string' ? message : JSON.stringify(message)).join('\n') + '\n');
  });
}

function resultOf(responses, id) {
  const response = responses.find(message => message.id === id);
  assert.equal(response?.jsonrpc, '2.0');
  assert.ok(response.result);
  return response.result;
}

// Every tool result has exactly one text block. Short lookup answers retain the legacy structured display.
function callText(responses, id, isError = false) {
  const result = resultOf(responses, id);
  assert.equal(result.isError, isError);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.equal(typeof result.structuredContent, 'object');
  return result.content[0].text;
}

// The structured result as one JSON text, the shape earlier versions put in the text block.
const callJson = (responses, id, isError = false) => {
  callText(responses, id, isError);
  return JSON.stringify(resultOf(responses, id).structuredContent);
};

// Every display carries exactly one attribution line after a blank line; an exact lookup or a purchase request
// ends with the literal purchase line after it. Returns the body before the attribution.
function body(display) {
  assert.equal(typeof display, 'string');
  const purchase = '\n\n' + purchaseLine;
  const ending = display.endsWith(purchase) ? display.slice(0, -purchase.length) : display;
  const suffix = '\n\n' + attribution;
  assert.ok(ending.endsWith(suffix), 'display ends with the attribution line: ' + JSON.stringify(display.slice(-60)));
  assert.equal(display.split(attribution).length - 1, 1, 'one attribution line');
  assert.equal(display.split(purchaseLine).length - 1, display.endsWith(purchase) ? 1 : 0, 'purchase line only last');
  return ending.slice(0, -suffix.length);
}

// Every tool result is JSON whose first field is the ready-to-copy display; tests compare the body before the attribution.
function callData(responses, id) {
  const data = JSON.parse(callJson(responses, id));
  if (!data.display) return { ...data, display: callText(responses, id) };
  assert.equal(Object.keys(data)[0], 'display');
  if (!data.say) return { ...data, display: body(data.display) };
  assert.equal(data.display, data.say);
  assert.equal(data.say.split('\n')[data.source === 'local' ? 1 : 0], resultsLine(data.resultPage));
  return data;
}

// Errors carry only the display.
function errorText(responses, id) {
  const data = JSON.parse(callJson(responses, id, true));
  assert.deepEqual(Object.keys(data), ['display']);
  return body(data.display);
}

test('initializes with the client version, accepts notification and replies to ping', async () => {
  const responses = await exchange([...handshake('2024-11-05'), request('ping', 'ping')]);
  assert.deepEqual(responses.map(({ id }) => id), [1, 'ping']);
  const { instructions, ...initialized } = resultOf(responses, 1);
  assert.match(instructions, /Include the clickable Results page link/);
  assert.deepEqual(initialized, {
    protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'domain-hound', title: 'Domain Hound', version },
  });
  assert.deepEqual(resultOf(responses, 'ping'), {});
});

test('offers its latest protocol for an unsupported version', async () => {
  const responses = await exchange(handshake('2099-01-01'));
  assert.equal(resultOf(responses, 1).protocolVersion, '2025-11-25');
});

test('advertises ten distinct tools with intent descriptions and complete annotations', async () => {
  const responses = await exchange([...handshake(), request(2, 'tools/list')]);
  const { tools } = resultOf(responses, 2);
  assert.deepEqual(tools.map(tool => tool.name), ['check_domains', 'triage_names', 'naming_guide', 'watch_domain',
    'taken_domain_dossier', 'my_domains', 'quote_domain', 'buy_domain', 'setup_domain', 'move_domain']);
  const [check, triage, naming, watch, , portfolio] = tools;
  const { inputSchema } = check;
  function assertDescriptions(schema) {
    for (const property of Object.values(schema.properties ?? {})) {
      assert.ok(property.description);
      assertDescriptions(property);
    }
    if (schema.items) assertDescriptions(schema.items);
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') assertDescriptions(schema.additionalProperties);
  }
  for (const tool of tools) {
    assert.match(tool.description, /^Use this when /);
    assert.doesNotMatch(tool.description, /clickable Results page link/);
    assert.ok(tool.annotations.title);
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      assert.equal(typeof tool.annotations[hint], 'boolean', tool.name + '.' + hint);
    }
    assertDescriptions(tool.inputSchema);
  }
  for (const name of ['buy_domain', 'move_domain']) {
    const tool = tools.find(tool => tool.name === name);
    assert.match(tool.description, /COSTS MONEY/);
    assert.equal(tool.annotations.destructiveHint, true);
  }
  assert.match(check.description, /purchase: true/);
  assert.match(check.description, /explicit live shop check/);
  assert.match(triage.description, /idea.*website.*name generator/);
  assert.equal(triage.inputSchema.properties.shortlist.type, 'boolean');
  assert.equal(watch.annotations.readOnlyHint, false);
  assert.equal(portfolio.annotations.readOnlyHint, false);
  assert.deepEqual(watch.inputSchema.required, ['domain']);
  assert.equal(inputSchema.properties.budget.type, 'number');
  assert.equal(triage.inputSchema.properties.names.maxItems, 20);
  assert.deepEqual(triage.inputSchema.oneOf, [{ required: ['names'] }, { required: ['idea'] }]);
  assert.deepEqual(triage.inputSchema.properties.endings, inputSchema.properties.endings);
  assert.equal(check._meta['anthropic/maxResultSizeChars'], 40_000);
  const { query, names } = inputSchema.properties;
  assert.deepEqual(Object.keys(inputSchema.properties), ['country', 'ai', 'endings', 'budget', 'eligible', 'detail', 'query', 'names', 'shortlist', 'purchase', 'picked', 'confirm']);
  for (const flag of ['shortlist', 'purchase', 'picked', 'confirm']) assert.equal(inputSchema.properties[flag].type, 'boolean');
  assert.match(inputSchema.properties.confirm.description, /only when the person explicitly asks/);
  assert.deepEqual(inputSchema.properties.eligible.items.enum, ['no', 'eu']);
  assert.deepEqual(triage.inputSchema.properties.eligible, inputSchema.properties.eligible);
  assert.equal(inputSchema.type, 'object');
  assert.equal(inputSchema.additionalProperties, false);
  assert.deepEqual(inputSchema.oneOf, [{ required: ['query'] }, { required: ['names'] }]);
  assert.equal(query.type, 'string');
  assert.equal(query.maxLength, 127);
  assert.match(query.description, /either query or names/);
  assert.equal(names.type, 'array');
  assert.equal(names.minItems, 1);
  assert.equal(names.maxItems, 20);
  assert.equal(names.items.type, 'string');
  const pattern = new RegExp(names.items.pattern);
  assert.equal(pattern.test('Upper-Case'), true);
  assert.equal(pattern.test('example.com'), true);
  assert.equal(pattern.test('a.b.com'), false);
  assert.equal(pattern.test('example.'), false);
  assert.equal(pattern.test('example.x2'), false);
  assert.equal(pattern.test('example.XN--P1AI'), true);
  // Names and domains with non-ASCII letters pass the schema; the server checks them as punycode.
  for (const value of ['Grønnstue', 'grønnstue.com', 'xn--grnnstue-64a.no', 'Café-Ø']) assert.equal(pattern.test(value), true, value);
  for (const value of ['grøn stue', 'grøn—stue', 'a.b.com']) assert.equal(pattern.test(value), false, value);
  assert.match(query.description, /^One name or exact domain, e\.g\. "lanternbay\.me"/);
  assert.match(names.description, /^1 to 20 bare names or exact domains, e\.g\./);
  assert.equal(naming.inputSchema.properties.about.maxLength, 512);
  assert.equal(naming.inputSchema.additionalProperties, false);
});

test('records a score pick only when the person explicitly chooses an exact domain', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const picks = [];
  output.resume();
  const done = serve({ input, output, cwd: capability, scoreLog: {
    picked(domain) { picks.push(domain); },
  } });
  input.end([...handshake(), call(2, { query: 'example.com' }),
    call(3, { query: 'example.com', picked: true }), call(4, { query: 'example', picked: true }),
    call(5, { query: 'failed.com', picked: 'yes' })].map(value => JSON.stringify(value)).join('\n') + '\n');
  await done;
  assert.deepEqual(picks, ['example.com']);
});

test('forwards purchase and the explicit browser confirm flag, and rejects non-boolean flags', async () => {
  const responses = await exchange([...handshake(), call(2, { query: 'example.com', confirm: true }, 'broker_find'),
    call(3, { names: ['oakenroom'], purchase: true }), call(4, { query: 'example.com', confirm: 'yes' }),
    call(5, { names: ['oakenroom'], purchase: 1 }), call(6, { names: ['oakenroom'] })]);
  assert.deepEqual(callData(responses, 2).flags, ['--confirm']);
  const bought = callText(responses, 3);
  assert.match(bought, /This check leaves checkout to you/);
  assert.equal(callData(responses, 3).flags, undefined);
  assert.match(errorText(responses, 4), /^confirm must be a boolean\.$/);
  assert.match(errorText(responses, 5), /^purchase must be a boolean\.$/);
  // Without a purchase request, a batch keeps the ordinary never-buys wording and no purchase line.
  assert.doesNotMatch(callText(responses, 6), /leaves checkout to you(?:\.|; use the link above)/);
});

test('passes a normalized query as a separate argument and returns compact JSON', async () => {
  const responses = await exchange([...handshake(), call(2, { query: 'Example.COM' }, 'broker_find'),
    call(3, { query: 'Example.COM', detail: 'full' }, 'broker_find')]);
  const result = callData(responses, 2);
  assert.match(callText(responses, 2), /^example\.com is available/);
  assert.doesNotMatch(callText(responses, 2), /Available ·|first year/);
  assert.match(callText(responses, 3), /Available · example\.com/);
  assert.match(result.say, /Available · example\.com\n.*\$9\.48 first year · \$10\.68 yearly renewal · \$30\.84 over three years\nConfirmed at the shop\./);
  assert.match(result.say, /https:\/\/www\.spaceship\.com\/domain-search\/\?query=example\.com/);
  assert.equal(result.complete, true);
  assert.equal(result.checkedAt, '2026-11-24T12:00:00.000Z');
  assert.deepEqual(result.names, [{ name: 'example.com',
    free: [{ d: 'com', s: 'ok', now: 9.48, renew: 10.68, y3: 30.84, shop: 'Spaceship' }] }]);
  assert.equal(result.best.domain, 'example.com');
  assert.equal(result.buyUrlTemplate.Spaceship.replace('{domain}', 'example.com'), result.best.buyUrl);
  assert.equal(result.legend.ok, 'Free, confirmed by a shop');
});

test('a taken exact domain links to a watch and retains the purchase limitation when requested', async () => {
  const responses = await exchange([...handshake(), call(2, { query: 'taken.me' }, 'broker_find'),
    call(3, { query: 'taken.me', purchase: true }, 'broker_find')]);
  for (const id of [2, 3]) {
    const result = callData(responses, id);
    assert.deepEqual(result.names, [{ name: 'taken.me', taken: ['me'] }]);
    assert.match(result.say, /^Taken · taken\.me\./m);
    assert.match(result.say, /https:\/\/domainhound\.dev\/watch\/\?domain=taken\.me/);
    assert.doesNotMatch(result.say, /domain-search|\$/);
  }
  assert.match(callText(responses, 3), /This check leaves checkout to you/);
  // A taken domain gets no quote offer.
  assert.doesNotMatch(callText(responses, 3), /quote taken\.me/);
});

test('passes 20 names to one native batch invocation and preserves partial compact results', async () => {
  const names = Array.from({ length: 20 }, (_, i) => `Example-${i}`);
  const responses = await exchange([...handshake(), call(2, { names }, 'broker_find')]);
  const result = callData(responses, 2);
  assert.ok(result.say.split('\n').length <= 8);
  const html = await readFile(new URL(result.resultPage), 'utf8');
  assert.ok(names.every(name => html.includes(name.toLowerCase() + '.com')));
  assert.match(html, /\$9\.48<\/td><td>\$10\.68/);
  assert.equal(result.complete, false);
  assert.equal(result.best, undefined);
  assert.equal(result.priceListDate, '2026-11-24');
  assert.deepEqual(result.names, names.map(name => ({
    name: name.toLowerCase(),
    free: [{ d: 'com', s: 'nc', now: 9.48, renew: 10.68, y3: 30.84, shop: 'Spaceship' }],
    shop_check: ['so'],
    score: { version: 'v1', filtered: 'Numbers or hyphens', kind: 'ban' },
  })));
});

test('passes bare names and exact domains together in one native batch invocation', async () => {
  const responses = await exchange([...handshake(), call(2, { names: ['Oakenroom', 'oakenroom.me', 'QuietBook.AI'] }, 'broker_find')]);
  const result = callData(responses, 2);
  assert.deepEqual(result.names.map(row => row.name), ['oakenroom', 'oakenroom.me', 'quietbook.ai']);
  const receipt = await readFile(new URL(result.resultPage), 'utf8');
  assert.match(receipt, /oakenroom\.com[\s\S]*?\$9\.48<\/td><td>\$10\.68/);
  // An exact domain in a batch is listed as itself.
  assert.match(receipt, /oakenroom\.me[\s\S]*?\$9\.48<\/td><td>\$10\.68/);
  assert.match(receipt, /quietbook\.ai[\s\S]*?\$9\.48<\/td><td>\$10\.68/);
});

test('accepts broker_find and forwards an explicit .ai request', async () => {
  const responses = await exchange([...handshake(), call(2, { query: 'Studio', ai: true }, 'broker_find'),
    call(3, { names: ['One', 'Two'] }, 'broker_find')]);
  const result = callData(responses, 2);
  assert.equal(result.names[0].name, 'studio');
  assert.deepEqual(result.flags, ['--ai']);
  assert.deepEqual(callData(responses, 3).names.map(row => row.name), ['one', 'two']);
});

test('reports native batch errors without a per-name fallback', async () => {
  const responses = await exchange([...handshake(), call(2, { names: ['One', 'Two'] })], { legacy: true });
  assert.equal(errorText(responses, 2), 'Enter a name, such as Example Studio.');
});

test('checks every default ending and shows preferences first for both tools', async () => {
  const endings = ['ai', 'app'];
  const choices = [...endings, ...defaultEndings.filter(ending => !endings.includes(ending))];
  const responses = await exchange([...handshake(), call(2, { query: 'endingsample', endings }, 'broker_find'),
    call(3, { names: ['Ending Sample'], endings }, 'triage_names'),
    call(4, { query: 'example.com', endings }, 'broker_find')]);
  const checked = callData(responses, 2);
  const triaged = callData(responses, 3);
  assert.deepEqual(checked.names[0].free.map(option => option.d), defaultEndings);
  assert.deepEqual(triaged.names[0].free, defaultEndings);
  for (const result of [checked, triaged]) {
    assert.match(result.say, /^Results page: [^\n]+\n\.ai, \.app first/m);
    assert.match(result.say, /endingsample\.ai \$8\.00, then \$12\.50/);
    const receipt = await readFile(new URL(result.resultPage), 'utf8');
    assert.ok(choices.every(ending => receipt.includes('endingsample.' + ending)), receipt);
  }
  assert.deepEqual(callData(responses, 4).names[0].free.map(option => option.d), ['com']);
});

test('an ending on request joins the default endings at the wire and on the page; defaults alone forward nothing', async () => {
  const responses = await exchange([...handshake(), call(2, { query: 'endingsample', endings: ['de', 'com'] }, 'broker_find'),
    call(3, { names: ['Ending Sample'], endings: ['uk'] }, 'triage_names'), call(4, { query: 'endingsample', endings: ['net'] }, 'broker_find'),
    call(5, { query: 'endingsample', endings: ['zz'] })]);
  const checked = callData(responses, 2);
  assert.deepEqual(checked.names[0].free.map(option => option.d), [...defaultEndings, 'de']);
  assert.deepEqual(callData(responses, 3).names[0].free, [...defaultEndings, 'uk']);
  // .net left the defaults in 0.1.8, so asking for it adds it like any ending on request.
  assert.deepEqual(callData(responses, 4).names[0].free.map(option => option.d), [...defaultEndings, 'net']);
  assert.match(errorText(responses, 5), /supported domain endings/);
  const receipt = await readFile(new URL(checked.resultPage), 'utf8');
  assert.ok(receipt.includes('endingsample.de'));
});

test('naming_method serves the four questions in order and describes the checked naming loop', async () => {
  const responses = await exchange([...handshake(), call(2, undefined, 'naming_method'), call(3, {}, 'naming_method'),
    call(4, { query: 'not used' }, 'naming_method'), call(5, { about: 'Book trips' }, 'naming_method')]);
  const text = callJson(responses, 2);
  assert.equal(callJson(responses, 3), text);
  assert.match(errorText(responses, 4), /optional about/);
  assert.match(callData(responses, 5).display, /Brief: Book trips/);
  const data = JSON.parse(text);
  assert.equal(callText(responses, 2), data.display);
  assert.deepEqual(Object.keys(data), ['display']);
  const recipe = data.display;
  assert.ok(Buffer.byteLength(text) < 2600, String(Buffer.byteLength(text)));
  const order = ['1. Best domain', '2. Best alternative', '3. Rebrand', '4. A name that lasts'].map(phrase => recipe.indexOf(phrase));
  assert.ok(order.every(index => index >= 0), String(order));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  for (const phrase of ['six territories', 'familiar anchor', 'say-and-spell', 'up to 20 proposals',
    'final checks', 'exact liked words', 'latest feedback', 'three rounds']) {
    assert.ok(recipe.includes(phrase), phrase);
  }
});

test('naming_method accepts a detailed brief and keeps the recipe concise', async () => {
  const about = 'Schedule quiet training rooms and reserve equipment for staff. '.repeat(5).trim();
  const responses = await exchange([...handshake(), call(2, { about }, 'naming_method')]);
  const { display } = callData(responses, 2);
  assert.match(display, /^Naming recipe/);
  assert.ok(display.includes(about.slice(0, 100)));
  assert.ok(Buffer.byteLength(display) < 2700);
});

test('prints the MCP naming recipe in the CLI and points spaced names to it', async () => {
  const run = promisify(execFile);
  const index = fileURLToPath(new URL('./clis/domain-check/index.mjs', import.meta.url));
  const about = 'Book quiet work rooms';
  const responses = await exchange([...handshake(), call(2, { about }, 'naming_method')]);
  const { stdout } = await run(process.execPath, [index, '--naming-method', '--about', about]);
  assert.equal(stdout.trimEnd(), callData(responses, 2).display);
  for (const args of [['Quiet Room'], ['Quiet', 'Room']]) {
    await assert.rejects(run(process.execPath, [index, '--name', ...args]),
      error => error.code === 1 && /--naming-method/.test(JSON.parse(error.stdout).error));
  }
});

test('rejects invalid inputs before executing the capability', async () => {
  const bad = [undefined, null, [], {}, { query: 'a', names: ['a'] }, { query: '' },
    { query: 'a\n' }, { query: 'a..com' }, { query: 'a'.repeat(64) }, { query: 1 }, { query: 'a', ai: 'yes' }, { query: 'a', endings: ['bogus'] },
    { query: 'a', extra: true }, { names: [] }, { names: Array(21).fill('a') },
    { names: ['a,b'] }, { names: ['a.b.com'] }, { names: ['.com'] }, { names: ['x;ls'] }, { names: ['a b'] }, { names: [null] }];
  const responses = await exchange([...handshake(), ...bad.map((args, i) => call(i + 2, args))]);
  for (let index = 0; index < bad.length; index++) {
    assert.match(errorText(responses, index + 2), /^[^\r\n]+$/);
  }
  const message = args => errorText(responses, bad.findIndex(value => JSON.stringify(value) === JSON.stringify(args)) + 2);
  assert.match(message({ query: '' }), /^query is empty\. Enter one name or exact domain in query/);
  assert.match(message({ query: 'a'.repeat(64) }), /too long.*63 characters/);
  assert.match(message({ names: Array(21).fill('a') }), /^names must list 1 to 20 names or domains; it has 21\./);
  assert.match(message({ names: [] }), /1 to 20/);
  assert.match(message({ names: ['a b'] }), /^names\[0\] "a b" is not valid/);
  assert.match(message({ names: [null] }), /^names\[0\] is empty/);
  assert.match(message({ names: ['a.b.com'] }), /^names\[0\] "a\.b\.com" is not valid/);
});

test('reports capability errors as one line and detects malformed output', async () => {
  const responses = await exchange([...handshake(), call(2, { query: 'failed' }), call(3, { query: 'broken-json' })]);
  assert.equal(callText(responses, 2, true), 'Broker lookup failed.\n\nvia domainhound.dev');
  assert.deepEqual(resultOf(responses, 2).structuredContent, { display: 'Broker lookup failed.\n\nvia domainhound.dev' });
  assert.equal(errorText(responses, 3), 'Domain Hound returned invalid JSON.');
});

// Wait for matching events, including ones that arrived before the test started waiting.
function events() {
  const emitted = [];
  const waiting = new Set();
  return {
    push(event) {
      emitted.push(event);
      for (const waiter of waiting) {
        if (!waiter.matches(event)) continue;
        waiting.delete(waiter);
        waiter.resolve(event);
      }
    },
    next(matches) {
      const existing = emitted.find(matches);
      return existing ? Promise.resolve(existing) : new Promise(resolve => waiting.add({ matches, resolve }));
    },
  };
}

// Run the server on a controlled clock with a real capability subprocess and results files.
async function local(t, options, held) {
  const environment = new Map();
  if (held) {
    for (const [key, value] of Object.entries({ DOMAIN_HOUND_TEST_RUNS: held.runs, DOMAIN_HOUND_TEST_GATE: held.file })) {
      environment.set(key, process.env[key]);
      process.env[key] = value;
    }
  }
  const clock = deadlineClock(t);
  const lookupEvents = events();
  const written = events();
  const realPages = resultPages();
  const pages = async (data, ...rest) => {
    try {
      const page = await realPages(data, ...rest);
      written.push({ data, page });
      return page;
    } catch (error) {
      written.push({ error });
      throw error;
    }
  };
  const input = new PassThrough();
  const output = new PassThrough();
  const served = serve({ input, output, cwd: capability, pages, onLookupEvent: (type, progress) => lookupEvents.push({ type, progress }),
    ...options });
  const replies = new Map();
  const waiting = new Map();
  createInterface({ input: output }).on('line', line => {
    const reply = JSON.parse(line);
    replies.set(reply.id, reply);
    waiting.get(reply.id)?.(reply);
    waiting.delete(reply.id);
  });
  const reply = id => replies.has(id) ? Promise.resolve(replies.get(id)) : new Promise(resolve => waiting.set(id, resolve));
  const send = message => input.write(JSON.stringify(message) + '\n');
  const ask = message => { send(message); return reply(message.id); };
  // Whether a reply has arrived once every pending step that needs no clock or capability has run.
  const answered = async id => {
    await new Promise(resolve => setImmediate(resolve));
    return replies.has(id);
  };
  const progressed = matches => lookupEvents.next(({ type, progress }) => type === 'progress' && matches(progress));
  const started = () => lookupEvents.next(({ type }) => type === 'started');
  const exited = () => lookupEvents.next(({ type }) => type === 'exited');
  const waitForPage = async matches => {
    const { page, error } = await written.next(event => event.error || matches(event.data));
    if (error) throw error;
    return page;
  };
  t.after(async () => {
    try {
      await held?.open();
      input.end();
      clock.tick(120_000);
      await served;
    } finally {
      for (const [key, previous] of environment) {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
      await held?.close();
    }
  });
  for (const message of handshake()) send(message);
  await reply(1);
  return { ask, send, reply, answered, clock, progressed, started, exited, waitForPage };
}

// The slow fixture waits at this gate until the test opens it, so a lookup finishes exactly when the test says.
async function gate() {
  const directory = await mkdtemp(join(tmpdir(), 'hound-gate-'));
  const file = join(directory, 'open');
  return {
    file, runs: join(directory, 'runs.log'),
    open: () => writeFile(file, ''),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

// Check the shape of one MCP response, then return its structured result with the display body.
const structured = response => {
  assert.equal(response.jsonrpc, '2.0');
  return callData([response], response.id);
};
const runsIn = async file => (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
const unanswered = defaultEndings.filter(ending => !['com', 'dev', 'app'].includes(ending));
const threeAnswers = stage => progress => progress.answers.size === 3 && progress.stage === stage;

test('answers a slow lookup with partial progress at the budget, keeps it running and a repeat collects it', { timeout: 30_000 }, async t => {
  const held = await gate();
  const mcp = await local(t, { timeout: 1000 }, held);
  mcp.send(call(2, { query: 'slowroom' }));
  await mcp.progressed(threeAnswers('quotes'));
  // A real race against the budget: no answer a millisecond before it, the progress answer exactly at it.
  mcp.clock.tick(999);
  assert.equal(await mcp.answered(2), false);
  mcp.clock.tick(1);
  const partial = await mcp.reply(2);
  const progress = structured(partial);
  assert.equal(partial.result.isError, false);
  assert.equal(progress.pending, true);
  assert.deepEqual(progress.rows, [{ name: 'slowroom', statuses: { taken: ['com'], available: ['dev', 'app'],
    'still checking': unanswered } }]);
  assert.equal(progress.display, 'slowroom: available .dev .app · taken .com\nStill checking domains.');

  // The repeat joins the running lookup and returns its finished result when it ends, before its own budget.
  mcp.send(call(3, { query: 'slowroom' }));
  assert.equal(await mcp.answered(3), false);
  await held.open();
  const result = structured(await mcp.reply(3));
  assert.equal(mcp.clock.now(), 1000);
  assert.match(result.display, /^slowroom\.dev is your best bet:/);
  assert.equal(await runsIn(held.runs), 1);
  // The same lookup stays stable for the session window.
  const repeated = await mcp.ask(call(4, { query: 'slowroom' }));
  assert.deepEqual(structured(repeated).rows, result.rows);
  assert.equal(await runsIn(held.runs), 1);
});

test('lists all seven requested names in order on a timeout and collects the cached result on repeat', { timeout: 30_000 }, async t => {
  const held = await gate();
  const names = ['quietbook', 'slowroom', 'oakenroom.me', 'hushnook', 'stillowl', 'softnook', 'calmcove'];
  const mcp = await local(t, { timeout: 400 }, held);
  // Two identical calls in flight share one lookup.
  mcp.send(call(2, { names, purchase: true }));
  mcp.send(call(3, { names, purchase: true }));
  await mcp.progressed(threeAnswers('quotes'));
  mcp.clock.tick(400);
  const [first, second] = await Promise.all([mcp.reply(3), mcp.reply(2)]);
  for (const response of [first, second]) {
    const progress = structured(response);
    assert.deepEqual(progress.rows.map(row => row.name), names);
    const lines = progress.display.split('\n');
    // A row without any answer yet shows every default ending; the exact domain stays exact.
    assert.deepEqual(progress.rows[0], { name: 'quietbook', statuses: { 'still checking': defaultEndings } });
    assert.deepEqual(progress.rows[2], { name: 'oakenroom.me', statuses: { 'still checking': ['oakenroom.me'] } });
    assert.equal(lines[1], 'slowroom: available .dev .app · taken .com');
    assert.equal(lines[7], 'Still checking domains.');
    assert.deepEqual(lines.slice(0, 7).map(line => line.split(':')[0]), names);
  }
  // The purchase request keeps its closing line in the progress answer.
  assert.ok(callText([first], 3).endsWith('This check leaves checkout to you.'));
  assert.equal(await runsIn(held.runs), 1);
  // The lookup finishes while nobody waits; the repeat gets it from the kept result without waiting on its budget.
  await held.open();
  await mcp.exited();
  const repeat = await mcp.ask(call(4, { names, purchase: true }));
  assert.equal(mcp.clock.now(), 400);
  const result = structured(repeat);
  assert.deepEqual(result.rows.map(row => row.name), names);
  assert.match(await readFile(new URL(result.resultPage), 'utf8'), /oakenroom\.me[\s\S]*?\$8\.00<\/td><td>\$12\.50/);
  assert.equal(await runsIn(held.runs), 1);
});

test('a slow triage answers with every requested name and its verdict once finished', { timeout: 30_000 }, async t => {
  const held = await gate();
  const mcp = await local(t, { timeout: 400 }, held);
  mcp.send(call(2, { names: ['Slow Room'] }, 'triage_names'));
  await mcp.progressed(threeAnswers('rivals'));
  mcp.clock.tick(400);
  const progress = structured(await mcp.reply(2));
  assert.deepEqual(progress.names, [{ name: 'Slow Room', taken: ['com'], free: ['dev', 'app'],
    checking: unanswered }]);
  assert.equal(progress.stage, 'rivals');
  // The progress page is complete before the reply; the lookup is still held, so nothing rewrites it meanwhile.
  const opened = await readFile(new URL(progress.resultPage), 'utf8');
  assert.match(opened, /Still checking trademark, app and web sources/);
  assert.match(progress.display, /^- Slow Room: available \.dev \.app · taken \.com · still checking .*, ask again$/m);
  assert.match(progress.display, /trademark, app and rival checks are still running/);
  // The page link leads the progress answer, and that page reloads itself while the lookup runs.
  assert.equal(progress.display.split('\n')[1], resultsLine(progress.resultPage));
  assert.match(progress.display, /The results page fills in by itself/);
  assert.match(opened, /<meta http-equiv="refresh" content="8">/);
  // Without any repeat call, the finished verdict reaches the same page.
  await held.open();
  const finished = await mcp.waitForPage(data => data.names?.[0]?.verdict === 'No conflict found');
  assert.equal(finished.resultPage, progress.resultPage);
  const page = await readFile(new URL(progress.resultPage), 'utf8');
  assert.match(page, /No conflict found/);
  assert.doesNotMatch(page, /http-equiv="refresh"/);
  const result = structured(await mcp.ask(call(3, { names: ['Slow Room'] }, 'triage_names')));
  assert.equal(result.names[0].verdict, 'No conflict found');
  assert.equal(result.resultPage, progress.resultPage);
  assert.match(await readFile(new URL(result.resultPage), 'utf8'), /slowroom\.app[\s\S]*?\$8\.28<\/td><td>\$14\.49/);
});

test('a name screen answers first, then re-assesses slow checks on the same page without a repeat call', { timeout: 30_000 }, async t => {
  const held = await gate();
  // The budget is a guard only: the manual clock never reaches it, so the first answer comes from the first line.
  const mcp = await local(t, { timeout: 2000 }, held);
  const first = structured(await mcp.ask(call(2, { names: ['Late Room'] }, 'triage_names')));
  assert.equal(first.names[0].verdict, 'Check first');
  assert.equal(first.followUp, undefined);
  const lines = first.say.split('\n');
  assert.equal(lines[1], resultsLine(first.resultPage));
  assert.ok(lines.includes('Still checking Google Play. The results page updates by itself.'), first.say);
  // The first page is final before the gate opens: the follow-up cannot rewrite it until then.
  const opened = await readFile(new URL(first.resultPage), 'utf8');
  assert.match(opened, /<meta http-equiv="refresh" content="8">/);
  assert.match(opened, /Android: still checking/);
  assert.doesNotMatch(opened, /(?:Android|Apps) check incomplete|Android: check incomplete/);
  // No model call: the follow-up rewrites the same file with the re-assessed verdict and stops reloading.
  await held.open();
  const rewritten = await mcp.waitForPage(data => data.names?.[0]?.verdict === 'Avoid');
  assert.equal(rewritten.resultPage, first.resultPage);
  const page = await readFile(new URL(first.resultPage), 'utf8');
  assert.match(page, /Avoid\. Late Room is an app in the same category/);
  assert.match(page, /Android: Late Room/);
  assert.doesNotMatch(page, /http-equiv="refresh"|still checking/);
  // A repeat call returns the re-assessed result at the same URL from the same capability run.
  const repeat = structured(await mcp.ask(call(3, { names: ['Late Room'] }, 'triage_names')));
  assert.equal(repeat.names[0].verdict, 'Avoid');
  assert.equal(repeat.resultPage, first.resultPage);
  assert.equal(await runsIn(held.runs), 1);
  assert.equal(mcp.clock.now(), 0);
});

test('keeps answering pings during a lookup, stops a lookup at the maximum time and on shutdown', { timeout: 30_000 }, async t => {
  // The real subprocess protocol: a ping is answered while the lookup waits out its (real) 350 ms budget.
  const responses = await exchange([...handshake(), call(2, { query: 'slow' }), request(3, 'ping')], { fastTimeout: true });
  assert.deepEqual(responses.map(({ id }) => id), [1, 3, 2]);
  const progress = callData(responses, 2);
  assert.equal(progress.pending, true);
  assert.deepEqual(progress.rows, [{ name: 'slow', statuses: { 'still checking': defaultEndings } }]);
  // The server exited, so the never-ending lookup was stopped at shutdown.
  const mcp = await local(t, { timeout: 200, maxLookup: 1000 });
  mcp.send(call(2, { query: 'slow' }));
  await mcp.started();
  mcp.clock.tick(200);
  assert.equal(structured(await mcp.reply(2)).pending, true);
  // At the maximum lookup time, one second after the start, the capability is stopped.
  mcp.clock.tick(800);
  await mcp.exited();
  const stopped = await mcp.ask(call(3, { query: 'slow' }));
  assert.equal(errorText([stopped], 3), 'Domain Hound stopped the lookup after 1 second.');
});

test('returns JSON-RPC errors for malformed requests and unknown methods or tools', async () => {
  const responses = await exchange([request('probe', 'server/discover'), ...handshake(), '{bad', request(2, 'unknown'),
    request(3, 'tools/call', { name: 'unknown' })]);
  assert.equal(responses.find(({ id }) => id === 'probe').error.code, -32601);
  assert.equal(responses.find(({ id }) => id === null).error.code, -32700);
  assert.equal(responses.find(({ id }) => id === 2).error.code, -32601);
  assert.equal(responses.find(({ id }) => id === 3).error.code, -32602);
});

test('forwards triage with twenty-name validation and descriptions', async () => {
  const responses = await exchange([...handshake(),
    call(2, { names: ['Example One', 'Example Two'], category: 'Calendar app', endings: ['app', 'ai'], eligible: ['no'] }, 'triage_names'),
    call(3, { names: Array(21).fill('Example') }, 'triage_names'),
    call(4, { names: ['Example, injected'] }, 'triage_names'),
    call(5, { names: ['Example One'], about: 'Book appointments for a clinic' }, 'triage_names'),
    call(6, { names: ['Example One'], about: ' '.repeat(160) }, 'triage_names')]);
  const two = callData(responses, 2);
  assert.deepEqual(two.names.map(row => row.name), ['Example One', 'Example Two']);
  // Requested endings reach the screen so its own picks never demote them to the fallback tier.
  assert.deepEqual(two.flags, ['--compact', '--eligible', 'no', '--endings', [...defaultEndings, 'no'].join(','), '--prefer-endings', 'app,ai', '--category', 'Calendar app']);
  for (const id of [3, 4]) assert.match(errorText(responses, id), /1 to 20/);
  assert.match(errorText(responses, 3), /^names must list 1 to 20 names; it has 21\.$/);
  assert.match(errorText(responses, 4), /^names\[0\] is not valid/);
  const one = callData(responses, 5);
  assert.deepEqual(one.flags, ['--compact', '--about', 'Book appointments for a clinic']);
  // One name keeps all its evidence.
  assert.deepEqual(one.names[0].notes, ['iOS app: Example One (Example Inc., 12 ratings)']);
  assert.ok(one.names[0].memorable);
  assert.match(one.say, /Keep Example One\? Check first/);
  // .co renews at $31.05 ($65.21 over 3 years), so the pick is .app within $60; .co is the cheapest upfront line.
  assert.match(one.say, /^The Hound’s pick is exampleone\.app at Spaceship for \$37\.26 over three years\./m);
  assert.match(one.say, /^Cheapest: \[exampleone\.co\]\([^)]+\) \$3\.11, then \$31\.05 \(renewal jumps\)/m);
  assert.doesNotMatch(one.say, /\[x\]\(/);
  assert.match(await readFile(new URL(one.resultPage), 'utf8'), /exampleone\.ai[\s\S]*?\$160\.02/);
  assert.match(errorText(responses, 6), /product description/);
});

test('keeps both payments in the preliminary batch and flags an earlier estimate when triage is unresolved', async () => {
  const responses = await exchange([...handshake(),
    call(2, { names: ['ExampleOne'], shortlist: true }, 'broker_find'),
    call(3, { names: ['Example One'] }, 'triage_names'),
    call(4, { names: ['example.com'], shortlist: true })]);
  const preliminary = callData(responses, 2);
  assert.equal(preliminary.names[0].free[0].now, 9.48);
  assert.equal(preliminary.names[0].free[0].renew, 10.68);
  assert.match(preliminary.display, /exampleone/);
  assert.match(errorText(responses, 4), /only with bare names/);
  const prior = { names: [{ name: 'exampleone', free: [{ d: 'dev', s: 'nc' }] }],
    listPrices: { dev: { now: 11.99, renew: 12.99 } } };
  const { display, ...triage } = callData(responses, 3);
  assert.doesNotMatch(display, /earlier price/);
  const screened = JSON.parse(triageText(triage, prior));
  assert.match(screened.display, /earlier price, recheck: \.dev \$11\.99\/\$12\.99/);
  assert.ok(screened.names[0].shop_check.includes('dev'));
  assert.ok(!screened.names[0].free.includes('dev'));
});

// Realistic CLI payloads for the size budgets of the naming flow and the 20-name batch.
const endingOrder = ['me', 'co', 'dev', 'app', 'com', 'si', 'no', 'so', 'io', 'ai'];
const listPrices = {
  co: { now: 3.11, renew: 31.05, y3: 65.21, jump: true, shop: 'Spaceship' }, me: { now: 2.99, renew: 19.99, y3: 42.97, shop: 'Spaceship' },
  app: { now: 8.28, renew: 14.49, y3: 37.26, shop: 'Spaceship' }, dev: { now: 7.24, renew: 13.45, y3: 34.14, shop: 'Spaceship' },
  com: { now: 9.48, renew: 10.68, y3: 30.84, shop: 'Spaceship' }, io: { now: 32.98, renew: 52.88, y3: 138.74, shop: 'Spaceship' },
  si: { now: 12.5, renew: 12.5, y3: 37.5, shop: 'Dynadot' }, so: { now: 24.99, renew: 49.99, y3: 124.97, shop: 'Dynadot' },
  no: { now: 13.9, renew: 13.9, y3: 41.7, shop: 'Dynadot' }, ai: { now: 160.02, renew: 160.02, y3: 240.03, term: 2, shop: 'Spaceship' },
};
const cliLegend = { nc: 'Free, not confirmed', ok: 'Free, confirmed by a shop', resale: 'Taken, possible resale',
  shop_check: 'Registry did not settle; check at a shop', d: 'Ending, or full domain for a name variant', now: 'First payment, USD ex. VAT',
  renew: 'Renewal payment, USD ex. VAT', y3: 'Payments due in three years, USD ex. VAT', term: 'Years per payment when more than one',
  jump: 'Renewal over twice the first annual price', listPrices: 'Standard price by ending; use when a free row has no inline price' };

function batchPayload(names, allTaken = 0) {
  const last = names.at(-1);
  return { complete: true, checkedAt: '2026-11-24T12:00:00.000Z', priceListDate: '2026-11-20',
    best: { domain: last + '.co', status: 'free-confirmed', priceNow: 3.11, renewal: 31.05, threeYear: 65.21, shop: 'Spaceship',
      buyUrl: 'https://www.spaceship.com/domain-search/?query=' + last + '.co' },
    names: names.map((name, i) => i < allTaken ? { name, taken: [...endingOrder] } : {
      name, taken: ['com', 'io'], ...(i % 2 && { shop_check: ['so'] }),
      free: endingOrder.filter(d => !['com', 'io'].includes(d)).slice(0, 6 + i % 3)
        .map(d => d === 'co' && name === last ? { d, s: 'ok', ...listPrices.co } : { d, s: 'nc' }),
    }),
    legend: cliLegend,
    buyUrlTemplate: { Spaceship: 'https://www.spaceship.com/domain-search/?query={domain}', Dynadot: 'https://www.dynadot.com/domain/search?domain={domain}' },
    shopCheckWhy: { so: 'Registry did not answer in time' }, listPrices };
}

const reasons = ['An exact-name app already exists; GitHub did not answer', 'Several public sources show same-name use',
  'Example Rooms is an app in the same category with 1200 App Store ratings', 'quiethub.ai is a live business in the same category',
  'A close live US mark exists in another class; GitHub did not answer'];
function triagePayload(names) {
  return { prices: Object.fromEntries(endingOrder.map(d => [d, (({ y3, ...price }) => price)(listPrices[d])])),
    names: names.map((name, i) => ({ name, verdict: i % 2 ? 'Check first' : 'Avoid', reason: reasons[i % 5],
      free: endingOrder.filter(d => !['com', 'io'].includes(d)).slice(0, 6 + i % 3),
      ...(i === 1 && { own: { me: { now: 2.5, renew: 20, shop: 'Dynadot' } } }), taken: ['com', 'io'], ...(i % 2 && { shop_check: ['so'] }),
      buy: 'https://www.spaceship.com/domain-search/?query=' + name.toLowerCase().replace(/ /g, '') + '.me',
      notes: ['iOS app: ' + name + ' Pro (Example Inc., 12 ratings)', 'Same name (some): Example Labs, Example GitHub org, Example store page',
        'Handles taken: github, npm'], memorable: '10 letters (short), ~3 syllables' })),
    legend: 'USD ex. VAT. prices: standard price by ending (absent = price at the shop); now = payment today for term years (1 unless term), '
      + 'renew = renewal payment, jump = renewal over twice the first price. Per name: free = endings free at the registry, cheapest first; '
      + "own = this name's prices where they differ; buy = checkout link for the first free ending; shop_check = check at a shop. Confirm at the shop. "
      + 'For a shortlist, write every full domain and both prices in its candidate row, even when prices match. Link the cheapest in each row. Domain Hound never buys.' };
}

const seven = ['quietotter', 'hushroom', 'stillowl', 'softnook', 'calmcove', 'mutemoth', 'lullbay'];
const five = ['Quiet Otter', 'Hush Room', 'Still Owl', 'Soft Nook', 'Calm Cove'];
const ten = [...five, 'Mute Moth', 'Lull Bay', 'Velvet Fox', 'Hollow Wren', 'Snug Burrow'];
const twenty = Array.from({ length: 20 }, (_, i) => 'example' + ['amber', 'cedar', 'flint', 'moss', 'solace'][i % 5] + i);
const size = text => Buffer.byteLength(text);

test('keeps all three naming calls under 8 KB and each listed tool text under its limit', async () => {
  const responses = await exchange([...handshake(), call(2, {}, 'naming_method')]);
  const recipe = callText(responses, 2);
  const prior = batchPayload(seven);
  const batch = checkText(prior, true);
  const triage = triageText(triagePayload(five), prior);
  // The method skips the check_domains batch, so the naming calls are the method and one screen.
  assert.ok(size(recipe) + size(triage) < 8000, [size(recipe), size(triage)].join(' + '));
  assert.ok(size(batch) < 8000);
  assert.ok(size(triage) < 6000);
  assert.ok(size(triageText(triagePayload(ten))) < 10_000);
  assert.ok(size(checkText(batchPayload(twenty, 8))) < 8000);
  assert.ok(size(checkText(batchPayload(twenty))) < 8000);
  // Trimming keeps the fields the grader and clients read.
  const shortlist = JSON.parse(triage);
  assert.deepEqual(Object.keys(shortlist), ['display', 'prices', 'names', 'legend']);
  assert.equal(shortlist.names[1].own.me.now, 2.5);
  assert.match(shortlist.display, /Cheapest eligible \/ checkout/);
  // The checkout cell links the shop; the price stays once, on the ending's own line.
  assert.match(shortlist.display, /\[hushroom\.me\]\(https:\/\/www\.spaceship\.com\/domain-search\/\?query=hushroom\.me\) \|/);
  assert.match(shortlist.display, /\| Hush Room \| .*\.me \$2\.50, then \$20\.00\/yr, 8x jump<br>/);
  assert.ok(shortlist.names[1].free.includes('co'));
  const checked = JSON.parse(batch);
  assert.equal(Object.keys(checked)[0], 'display');
  assert.deepEqual(checked.names.map(row => row.name), seven);
  assert.ok(checked.names.every(row => row.free.every(option => option.d && (option.s === 'ok' || option.s === undefined))));
  for (const d of ['me', 'co', 'app', 'ai']) assert.equal(checked.listPrices[d].now, listPrices[d].now);
  // One-name triage keeps all its evidence.
  const one = JSON.parse(triageText(triagePayload(['Notion'])));
  assert.equal(one.names[0].notes.length, 3);
  assert.ok(one.names[0].memorable && one.names[0].buy);
});

test('triage keeps the price of an ending that became available after the shortlist', () => {
  const prior = batchPayload(seven);
  prior.names[0].free = prior.names[0].free.filter(option => option.d !== 'app');
  const payload = triagePayload(five);
  const before = JSON.parse(triageText(payload, batchPayload(seven)));
  const after = JSON.parse(triageText(payload, prior));
  assert.equal(before.prices.app, undefined);
  assert.equal(after.prices.app.now, payload.prices.app.now);
  assert.ok(after.names[0].free.includes('app'));
});

test('renders the triage shortlist as one priced, linked row per candidate', () => {
  const display = body(JSON.parse(triageText(triagePayload(five))).display);
  const lines = display.split('\n');
  assert.equal(lines[0], '**Top picks**');
  assert.equal(lines[4], '');
  for (const pick of lines.slice(1, 4)) assert.match(pick, /^- \*\*.+\*\* — .+, pick [a-z]+\.[a-z]+ \$[\d.]+(?:\/\$[\d.]+|, then \$[\d.]+\/yr, \d+x jump)/);
  assert.ok(lines.includes('| Name | Verdict and reason | Available endings, one per line, today/renewal | Checkout | Search checks |'));
  const rows = lines.filter(line => /^\| (?!Name|---)/.test(line));
  assert.deepEqual(rows.map(line => line.split(' | ')[0].slice(2)), five);
  assert.ok(rows[1].startsWith('| Hush Room | Check first: Several public sources show same-name use | .me $2.50, then $20.00/yr, 8x jump<br>.co $3.11, then $31.05/yr, 10x jump<br>'
    + '.dev $7.24/$13.45<br>.app $8.28/$14.49<br>.si $12.50/$12.50<br>.no not eligible: needs Norwegian org/ID<br>'
    + '.so $24.99, then $49.99/yr, 2x jump<br>taken: .com .io<br>check at shop: .so | '
    + '[hushroom.me](https://www.spaceship.com/domain-search/?query=hushroom.me) |'));
  for (const row of rows) {
    assert.match(row, /Google: not checked · .*google\.com\/search\?q=/);
    assert.match(row, /App Store \(iOS\): not checked · .*apps\.apple\.com\/us\/iphone\/search\?term=/);
    assert.match(row, /Google Play has no public search · .*play\.google\.com\/store\/search\?q=/);
  }
  assert.match(rows[2], /\.ai \$160\.02\/\$160\.02 2y/);
  assert.match(lines.at(-1), /^Choose a favorite/);
});

test('keeps heavy five-name traction screens inside the existing MCP size limit', () => {
  const names = Array.from({ length: 5 }, (_, index) => 'synthetic-long-candidate-for-trajectories-' + index);
  const result = triagePayload(names);
  for (const row of result.names) {
    row.verdict = 'Avoid';
    row.reason = 'David vs Goliath: ' + row.name + ' (Tranco #123, Wikipedia article) · ' + 'Example evidence. '.repeat(6);
    row.traction = { rival: row.name, level: 'strong', signals: ['Tranco #123', 'Wikipedia article'],
      geo: 'agent knows it: team workspace' };
  }
  const text = triageText(result);
  const packed = JSON.parse(text);
  assert.ok(size(text) < 6000, String(size(text)));
  assert.equal(packed.names.length, names.length);
  assert.ok(packed.names.every(row => row.verdict === 'Avoid' && Array.isArray(row.free)));
  assert.match(packed.display, /David vs Goliath/);
});

test('puts display first with ranked picks and shows all sources for twenty names', async () => {
  const names = Array.from({ length: 20 }, (_, index) => 'Candidate ' + index);
  const responses = await exchange([...handshake(), call(2, { names }, 'triage_names')]);
  const forwarded = callData(responses, 2);
  assert.deepEqual(forwarded.names.map(row => row.name), names);
  assert.ok(size(callText(responses, 2)) < 8000, String(size(callText(responses, 2))));
  const sample = triagePayload(twenty);
  sample.top = [{ name: twenty[1], verdict: 'Check first', reason: reasons[1], domain: twenty[1] + '.co', ending: 'co', now: 3.11, renew: 31.05 }];
  const text = triageText(sample);
  assert.ok(size(text) < 8000, String(size(text)));
  const result = JSON.parse(text);
  assert.equal(Object.keys(result)[0], 'display');
  assert.match(result.display, /^\*\*Top picks\*\*\n- .*Check first.*\$3\.11, then \$31\.05\/yr, 10x jump/);
  assert.equal(result.names.length, 20);
  for (const source of ['Google', 'App Store (iOS)', 'Search Google Play']) {
    assert.ok(result.display.includes(source), source);
  }
});

test('shows best value beside the cheapest offer in the top picks and name row', () => {
  const sample = triagePayload(['Quiet Otter']);
  sample.names[0].bestValue = 'dev';
  sample.top = [{ name: 'Quiet Otter', verdict: 'Check first', domain: 'quietotter.co', ending: 'co', now: 3.11,
    renew: 31.05, bestValue: { domain: 'quietotter.dev', now: 7.24, renew: 13.45, term: 1 } }];
  const { display } = JSON.parse(triageText(sample));
  // Cheapest now carries the jump in plain words; best value is the lowest three-year total.
  assert.match(display, /pick quietotter\.co \$3\.11, then \$31\.05\/yr, 10x jump.*\n  Best value: quietotter\.dev, \$34\.14 over 3 years/);
  assert.match(display, /^\| Quiet Otter .*<br>Best value: quietotter\.dev, \$34\.14 over 3 years \|/m);
});

test('fits a fully priced twenty-name batch with maximum-length labels and multibyte owners', async t => {
  const labels = Array.from({ length: 20 }, (_, index) => 'example' + String(index).padStart(2, '0') + 'a'.repeat(54));
  const folder = await mkdtemp(join(tmpdir(), 'hound-priced-triage-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const directory = pathToFileURL(folder + '/');
  const now = new Date('2026-11-24T12:00:00Z');
  const checkedAt = now.toISOString();
  const prices = Object.fromEntries(defaultEndings.map((tld, index) => [tld, {
    shop: 'Dynadot', firstYear: tld === 'co' ? 3.11 : 6 + index, renewal: tld === 'co' ? 31.05 : 10 + index,
  }]));
  await writeCache(directory, 'prices.json', { checkedAt, catalogs: { dynadot: { checkedAt, prices } } });
  // This test measures payload size with every fixture answer in. The deadline stays frozen while cache I/O finishes.
  deadlineClock(t);
  const options = {
    directory, now, cachedOnly: true, budgetMs: 2500, compact: true, resolveNs: async () => [],
    queryWhois: async () => null, launch: async () => { throw Error('Fixture has no browser'); },
    fetcher: async (value, init) => {
      const url = new URL(value);
      if (url.hostname === 'data.iana.org') return Response.json({ services: [[Object.keys(prices), ['https://rdap.example.test/']]] });
      if (url.hostname === 'tmsearch.uspto.gov') {
        marksAsked++;
        const key = JSON.parse(init.body).query.bool.must[0].bool.should[0].match_phrase.wordmark.query;
        return Response.json({ hits: { hits: [{ source: {
          alive: true, wordmark: key.slice(0, -1) + 'e', ownerName: ['株式会社'.repeat(18)],
          // Ten classes outside the software classes 009, 035 and 042, so the near mark stays a Check first.
          internationalClass: Array.from({ length: 10 }, (_, index) => 'IC 0' + (index + 10)),
        } }] } });
      }
      if (url.hostname === 'itunes.apple.com') return Response.json({ results: [] });
      if (url.hostname === 'www.wikidata.org') return Response.json({ search: [] });
      if (url.hostname === 'data.brreg.no') return Response.json({ page: { totalPages: 0 } });
      return new Response(null, { status: 404 });
    },
  };
  let marksAsked = 0;
  const report = await triageNames(labels, options);
  assert.deepEqual(report.names.map(row => row.name), labels);
  // Trademarks, apps and rivals screen the first five names; the rest get registry answers and prices only.
  assert.ok(marksAsked >= 5 && marksAsked <= 10, String(marksAsked));
  for (const [index, row] of report.names.entries()) {
    if (index < 5) assert.match(row.reason, /^Near-identical: ex.*010\/011/);
    else assert.match(row.reason, /^Not screened/);
    assert.notEqual(row.verdict, 'No conflict found');
    assert.equal(row.free.length, defaultEndings.length);
    // Free endings follow the quality order (0.1.8), not the cheapest first payment.
    assert.equal(row.free[0], 'com');
    assert.equal(row.bestValue, 'com');
  }
  // Fourteen endings (0.1.5): four more ending codes per name than the 13 000-byte bound of 0.1.4 allowed for.
  assert.ok(size(JSON.stringify(report)) < 14_000, String(size(JSON.stringify(report))));
  const text = triageText(report);
  // display.mjs triageText is not on the MCP path (the server answers with the results-page say). With twelve
  // priced endings for twenty 63-character labels it needs a little more than the 8 KB it had for ten.
  assert.ok(size(text) < 9500, String(size(text)));
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed)[0], 'display');
  assert.ok(report.top.every(row => labels.indexOf(row.name) >= 5));
  assert.ok(parsed.display.includes('Best value: ' + labels[5] + '.com, $26.00 over 3 years'));
  assert.deepEqual(parsed.names.map(row => row.name), labels);
  assert.ok(parsed.names.every(row => row.free.length === defaultEndings.length));
  for (const source of ['Google', 'App Store (iOS)', 'Search Google Play']) {
    assert.ok(parsed.display.includes(source), source);
  }
});

test('preserves each price in dense five-name triage and the three source lines in dense triage', () => {
  const prices = Object.fromEntries(endingOrder.map(ending => [ending, listPrices[ending]]));
  const reason = 'Relevant public source evidence. '.repeat(6).trim();
  const names = ten.map((_, i) => ({
    name: 'Example' + i + 'a'.repeat(37), verdict: 'Check first', reason,
    free: endingOrder, buy: 'https://www.spaceship.com/domain-search/?query=example' + i + '.me',
  }));
  for (const [count, limit] of [[5, 8000], [10, 13_000]]) {
    const text = triageText({ prices, names: names.slice(0, count), legend: 'Fixture' });
    assert.ok(size(text) < limit, String(size(text)));
    const { display } = JSON.parse(text);
    for (const row of names.slice(0, count)) assert.ok(display.includes(row.name));
    if (count === 5) {
      assert.ok(size(display) < 6000, String(size(display)));
      const rows = display.split('\n').filter(line => line.startsWith('| Example'));
      assert.equal(rows.length, count);
      for (const row of rows) for (const ending of endingOrder) {
        const quote = prices[ending];
        const money = value => '$' + value.toFixed(2);
        const expected = ending === 'no' ? '.no not eligible: needs Norwegian org/ID'
          : quote.renew > 2 * quote.now ? '.' + ending + ' ' + money(quote.now) + ', then ' + money(quote.renew) + '/yr, '
            + Math.round(quote.renew / quote.now) + 'x jump'
            : '.' + ending + ' ' + money(quote.now) + '/' + money(quote.renew);
        assert.ok(row.includes(expected), row);
      }
    }
    const checksCount = display.includes('**Search checks for every name**') ? 1 : count;
    for (const label of ['Google', 'App Store (iOS)']) {
      const countLines = display.split('[' + label + '](').length + display.split(label + ':').length - 2;
      assert.equal(countLines, checksCount, label);
    }
    assert.equal(display.split('Google Play has no public search').length - 1, checksCount);
  }
});

test('renders a batch with shared prices, one line per free domain and one confirmed link', () => {
  const display = body(JSON.parse(checkText(batchPayload(twenty, 8))).display);
  const lines = display.split('\n');
  // .no is not offered at a price to a buyer who has not said they qualify.
  assert.equal(lines[1], 'Standard prices: .me $2.99, then $19.99/yr, 7x jump · .co $3.11, then $31.05/yr, 10x jump · .dev $7.24/$13.45 · .app $8.28/$14.49 · '
    + '.si $12.50/$12.50 · .so $24.99, then $49.99/yr, 2x jump · .ai $160.02/$160.02 2y');
  assert.ok(lines.includes('Taken: ' + twenty.slice(0, 8).join(', ') + ' .me .co .dev .app .com .si .no .so .io .ai'
    + ' · ' + twenty.slice(8).join(', ') + ' .com .io'));
  for (const name of twenty) assert.ok(display.includes(name), name);
  // Every free ending of each name has a line under its matching group.
  const payload = batchPayload(twenty, 8);
  for (const row of payload.names) {
    if (!row.free?.length) continue;
    const start = lines.findIndex(line => line.endsWith(':') && line.slice(0, -1).split(', ').includes(row.name));
    assert.ok(start >= 0, row.name);
    for (const { d } of row.free ?? []) {
      assert.ok(lines.slice(start + 1, start + 1 + row.free.length)
        .some(line => line === '- .' + d || line.startsWith('- .' + d + ' ')), row.name + '.' + d);
    }
  }
  assert.ok(lines.includes('- .co $3.11, then $31.05/yr, 10x jump ✓ confirmed at Spaceship'));
  // A batch this large leaves standard prices to the shared line; a confirmed quote keeps its own price and label.
  assert.ok(lines.includes('- .me'));
  assert.equal((display.match(/https:/g) ?? []).length, 1);
  assert.ok(lines.includes('Confirmed at Spaceship: [examplesolace19.co](https://www.spaceship.com/domain-search/?query=examplesolace19.co) $3.11, then $31.05/yr, 10x jump.'));
  assert.equal(lines.at(-1), neverBuys);
});

test('dense batches keep one line per free domain under 8 KB', () => {
  const long = Array.from({ length: 20 }, (_, i) => 'qzxw' + 'abcdefghijklmnopqrst'[i] + 'v'.repeat(40));
  const allFree = { ...batchPayload(long), best: undefined,
    names: long.map(name => ({ name, free: endingOrder.map(d => ({ d, s: 'nc' })) })) };
  const text = checkText(allFree);
  assert.ok(size(text) < 8000, String(size(text)));
  const { display, names } = JSON.parse(text);
  const lines = body(display).split('\n');
  const start = lines.indexOf(long.join(', ') + ':');
  assert.ok(start >= 0);
  assert.deepEqual(lines.slice(start + 1, start + 11), endingOrder.map(d => '- .' + d
    + (d === 'no' ? ' not eligible: needs Norwegian org/ID' : '')));
  // The structured rows still list every ending.
  assert.ok(names.every(row => row.free.length === 10 && row.free.every(option => option.d)));
  // Twenty names with seven free endings each name each name once above its own ending lines.
  const twentyLines = body(JSON.parse(checkText(batchPayload(twenty))).display).split('\n');
  const amber = twentyLines.findIndex(line => line.startsWith('exampleamber0, '));
  assert.deepEqual(twentyLines.slice(amber + 1, amber + 7), ['- .me', '- .co', '- .dev', '- .app', '- .si', '- .no not eligible: needs Norwegian org/ID']);
  assert.ok(twentyLines.includes('- .co $3.11, then $31.05/yr, 10x jump ✓ confirmed at Spaceship'));
});

test('escapes untrusted text and links only to known HTTPS registrars for that domain', () => {
  assert.equal(md('A|B *x* [y](javascript:z) <b> www.evil.test https://evil.test\n#'),
    'A\\|B \\*x\\* \\[y\\](javascript:z) \\<b\\> www\\.evil.test https:\\/\\/evil.test #');
  const good = 'https://www.spaceship.com/domain-search/?query=quietotter.co';
  assert.equal(safeLink(good, 'quietotter.co'), '[quietotter.co](' + good + ')');
  assert.equal(safeLink(good + '.uk', 'quietotter.co.uk'), '[quietotter.co.uk](' + good + '.uk)');
  for (const url of ['http://www.spaceship.com/domain-search/?query=quietotter.co', 'https://evil.test/?query=quietotter.co',
    'https://user:pw@www.spaceship.com/?query=quietotter.co', 'https://www.spaceship.com/domain-search/?query=other.co', 'javascript:alert(1)', 42]) {
    assert.equal(safeLink(url, 'quietotter.co'), null, String(url));
  }
  const payload = triagePayload(['Quiet Otter']);
  payload.names[0].buy = 'https://evil.test/?q=quietotter.me';
  payload.names[0].name = 'Quiet | Otter';
  const { display } = JSON.parse(triageText(payload));
  assert.doesNotMatch(display, /evil/);
  // An untrusted buy link is replaced by the trusted shop search for the same domain, never an empty link.
  assert.match(display, /^\| Quiet \\\| Otter \| Avoid: .* \| \[quietotter\.me\]\(https:\/\/www\.spaceship\.com\/domain-search\/\?query=quietotter\.me\) \| Google:/m);
  assert.doesNotMatch(display, /\]\((?:null|undefined)?\)/);
});

test('forwards per-name GEO from the client memory and rejects anything else', async () => {
  const responses = await exchange([...handshake(), request(2, 'tools/list'),
    call(3, { names: ['Notion', 'Route Mender'], geo: { notion: 'known: all-in-one notes workspace', RouteMender: ' unknown ' } }, 'triage_names'),
    call(4, { names: ['Notion'], geo: { Notion: 'probably a notes app' } }, 'triage_names'),
    call(5, { names: ['Notion'], geo: { Asana: 'known: work management' } }, 'triage_names'),
    call(6, { names: ['Notion'], geo: ['known: notes'] }, 'triage_names'),
    call(7, { names: ['Notion'], geo: { Notion: 'known' } }, 'triage_names')]);
  const triage = resultOf(responses, 2).tools.find(tool => tool.name === 'triage_names');
  const { geo } = triage.inputSchema.properties;
  assert.equal(geo.type, 'object');
  assert.equal(geo.maxProperties, 20);
  assert.match(geo.description, /own knowledge only, without searching/);
  assert.match(triage.description, /Show the tool’s text answer as given\. Offer details only if the user asks/);
  const pattern = new RegExp(geo.additionalProperties.pattern);
  for (const value of ['known: notes app', 'Known (notes app)', 'unknown']) assert.ok(pattern.test(value), value);
  for (const value of ['known', 'maybe', 'unknown brand']) assert.ok(!pattern.test(value), value);
  const flags = callData(responses, 3).flags;
  assert.deepEqual(flags.slice(0, 2), ['--compact', '--geo']);
  assert.deepEqual(JSON.parse(flags[2]), { notion: 'known: all-in-one notes workspace', RouteMender: 'unknown' });
  for (const id of [4, 6, 7]) assert.match(errorText(responses, id), /geo must map each name to "known: <what it is>" or "unknown"/);
  assert.match(errorText(responses, 5), /geo names "Asana", which is not in names/);
});

test('forwards per-name naming evidence for the Name score and rejects anything else', async () => {
  const evidence = { recipe: 'odd-pair', relation: 'direct', spellings: 1, realWord: true, descriptive: false, misspelled: false,
    narrow: false, soundsLike: 'none', badMeaning: 'none', language: 'english' };
  const responses = await exchange([...handshake(), request(2, 'tools/list'),
    call(3, { names: ['Loomfox', 'Mesa'], candidates: { loomfox: evidence, Mesa: { relation: 'none' } } }, 'triage_names'),
    call(4, { names: ['Loomfox'], candidates: { Asana: evidence } }, 'triage_names'),
    call(5, { names: ['Loomfox'], candidates: { Loomfox: { relation: 'close' } } }, 'triage_names'),
    call(6, { names: ['Loomfox'], candidates: { Loomfox: { subjectWord: 'loom' } } }, 'triage_names'),
    call(7, { names: ['Loomfox'], candidates: { Loomfox: { spellings: 0 } } }, 'triage_names'),
    call(8, { names: ['Loomfox'], candidates: ['Loomfox'] }, 'triage_names')]);
  const triage = resultOf(responses, 2).tools.find(tool => tool.name === 'triage_names');
  const { candidates } = triage.inputSchema.properties;
  assert.equal(candidates.maxProperties, 20);
  assert.equal(candidates.additionalProperties.additionalProperties, false);
  assert.deepEqual(candidates.additionalProperties.properties.relation.enum, ['direct', 'loose', 'none']);
  assert.match(candidates.description, /Missing evidence counts as not checked/);
  const naming = resultOf(responses, 2).tools.find(tool => tool.name === 'naming_guide');
  assert.match(naming.description, /before brainstorming/);
  const flags = callData(responses, 3).flags;
  const at = flags.indexOf('--candidates');
  assert.ok(at > 0);
  assert.deepEqual(JSON.parse(flags[at + 1]), { loomfox: evidence, Mesa: { relation: 'none' } });
  assert.match(errorText(responses, 4), /candidates names "Asana", which is not in names/);
  for (const id of [5, 6, 7, 8]) assert.match(errorText(responses, id), /candidates must map each name to naming evidence/);
});

test('shows the rival, its level, two strongest signals and the GEO line in the triage display', () => {
  const row = (reason, traction) => ({ name: 'Notion', verdict: 'Avoid', reason, free: [], taken: ['com'], shop_check: [],
    own: {}, traction, competition: {}, google: { result: 'owned by Notion' } });
  const goliath = { rival: 'Notion at notion.so', level: 'strong', signals: ['Tranco #2,097', 'Wikipedia article'],
    geo: 'stand-in Wikipedia/Wikidata: article Notion (productivity software)' };
  const named = triageText({ names: [row('David vs Goliath: Notion at notion.so (Tranco #2,097, Wikipedia article)', goliath)], prices: {} });
  const display = JSON.parse(named).display;
  assert.ok(display.includes('Avoid: David vs Goliath: Notion at notion.so (Tranco #2,097, Wikipedia article)<br>'
    + 'Rival: Notion at notion.so, strong · GEO stand-in Wikipedia/Wikidata: article Notion (productivity software) |'), display);
  // When a trademark sets the reason, the rival line carries its own signals.
  const marked = JSON.parse(triageText({ names: [row('Exact: NOTION (Notion Labs, 009/042)', goliath)], prices: {} })).display;
  assert.ok(marked.includes('<br>Rival: Notion at notion.so, strong (Tranco #2,097, Wikipedia article) · GEO '), marked);
  const plain = JSON.parse(triageText({ names: [row('No close US mark, app or site overlap · Small same-name use: RouteMender AI (no visible traction)')], prices: {} })).display;
  assert.ok(!plain.includes('Rival:'));
  assert.ok(plain.includes('Small same-name use: RouteMender AI (no visible traction) |'));
  const agent = JSON.parse(triageText({ names: [row('Ok', { geo: 'agent: unknown' })], prices: {} })).display;
  assert.ok(agent.includes('Ok<br>GEO agent: unknown |'));
});

const attributionCount = display => display.split(attribution).length - 1;

test('ends every MCP display, including errors, with one attribution line and keeps the byte limits', async () => {
  const responses = await exchange([...handshake(),
    call(2, { query: 'example.com' }), call(3, { names: ['one', 'two'] }), call(4, { names: ['one'], shortlist: true }),
    call(5, { names: ['Example One'] }, 'triage_names'), call(6, {}, 'naming_method'), call(7, { query: 'failed' }),
    call(8, { query: '' }), call(9, { query: 'x' }, 'broker_find'), call(10, { names: Array(21).fill('a') }, 'triage_names')]);
  for (const id of [2, 3, 4, 5, 6, 9]) callData(responses, id);
  for (const id of [7, 8, 10]) errorText(responses, id);
  // The naming method stays one short read.
  assert.ok(size(callText(responses, 6)) < 2600, String(size(callText(responses, 6))));
  // Direct renderers: exact, batch, shortlist, triage (single, shortlist, shared, dense and data-only fallback) and errors.
  const prior = batchPayload(seven);
  const texts = [
    checkText({ complete: true, checkedAt: '2026-11-24T12:00:00.000Z', names: [{ name: 'solo.co', free: [{ d: 'co', s: 'nc', now: 3.11 }] }] }),
    checkText(batchPayload(twenty)), checkText(batchPayload(twenty, 8)), checkText(prior, true),
    triageText(triagePayload(['Quiet Otter'])), triageText(triagePayload(five), prior), triageText(triagePayload(ten)),
    triageText(triagePayload(twenty)), errorJson('Something failed.'),
  ];
  const long = triagePayload(Array.from({ length: 5 }, (_, index) => 'synthetic-' + 'x'.repeat(90) + index));
  for (const row of long.names) row.reason = 'Example evidence. '.repeat(40);
  texts.push(triageText(long, prior));
  for (const [index, text] of texts.entries()) {
    const { display } = JSON.parse(text);
    assert.equal(attributionCount(display), 1, display.slice(-80));
    // The exact lookup ends with the purchase line right after the attribution.
    assert.ok(display.endsWith('\n\n' + attribution + (index === 0 ? '\n\n' + purchaseLine : '')), display.slice(-80));
  }
  assert.ok(size(checkText(batchPayload(twenty))) < 8000);
  assert.ok(size(triageText(triagePayload(five), prior)) < 6000);
  assert.ok(size(triageText(triagePayload(ten))) < 10_000);
  assert.ok(size(callText(responses, 2)) < 8000);
});

const exactLive = {
  complete: true, checkedAt: '2026-11-24T12:00:00.000Z',
  names: [{ name: 'quietotter.me', free: [{ d: 'me', s: 'nc', now: 2.99, renew: 19.99, y3: 42.97, shop: 'Spaceship' }] }],
  legend: { nc: 'Free, not confirmed' },
  buyUrlTemplate: { Spaceship: 'https://www.spaceship.com/domain-search/?query={domain}' },
  liveCheck: { domain: 'quietotter.me', status: 'check-at-shop', reason: 'Playwright is not installed',
    checkUrl: 'https://www.spaceship.com/domain-search/?query=quietotter.me' },
};

test('without Playwright an unconfirmed free domain says check at shop with a link and keeps its list price', () => {
  const display = body(JSON.parse(checkText(exactLive)).display);
  const lines = display.split('\n');
  assert.match(lines[0], /^\*\*quietotter\.me is available\.\*\* The registry shows it available; the price is a list price, not a shop quote\./);
  assert.ok(lines.includes('| quietotter.me | $2.99 | $19.99/yr, 7x jump | $42.97 | '
    + '[quietotter.me](https://www.spaceship.com/domain-search/?query=quietotter.me) at Spaceship |'), display);
  assert.ok(lines.includes('Check at shop: [quietotter.me](https://www.spaceship.com/domain-search/?query=quietotter.me). '
    + 'Live shop check unavailable (Playwright is not installed). Any prices shown are list estimates.'), display);
  assert.ok(lines.includes('USD ex. VAT. Estimate: the shop shows the final price.'));
  assert.doesNotMatch(display, /confirmed at|^Confirmed|✓/m);
  assert.equal(lines.at(-1), 'USD ex. VAT. Estimate: the shop shows the final price.');

  // An unsettled registry row keeps its single shop link and only adds why no live price exists.
  const unsettled = { ...exactLive, names: [{ name: 'quietotter.me', shop_check: ['me'] }],
    shopCheckWhy: { me: 'Registry did not answer in time' } };
  const pending = body(JSON.parse(checkText(unsettled)).display);
  assert.match(pending, /^\*\*quietotter\.me: not settled\.\*\* .*Check at shop: \[quietotter\.me\]\(https:\/\/www\.spaceship\.com\/domain-search\/\?query=quietotter\.me\)\. No price yet\./);
  assert.match(pending, /\nLive shop check unavailable \(Playwright is not installed\)\. Any prices shown are list estimates\.$/);
  assert.equal(pending.split('](https://').length - 1, 1);

  // A taken domain stays taken; the fallback never adds a link or price.
  const taken = { ...exactLive, names: [{ name: 'quietotter.me', taken: ['me'] }] };
  const shownTaken = body(JSON.parse(checkText(taken)).display);
  assert.match(shownTaken, /^\*\*quietotter\.me is taken\. This check leaves checkout to you\.\*\*/);
  assert.doesNotMatch(shownTaken, /\$|https?:|Live shop check/);

  // A batch keeps the shared list prices and taken rows, and links the candidate to check at the shop.
  const batch = batchPayload(seven);
  delete batch.best;
  batch.names = batch.names.map(row => ({ ...row, free: row.free.map(({ d }) => ({ d, s: 'nc' })) }));
  batch.liveCheck = { domain: 'quietotter.me', status: 'check-at-shop', reason: 'Playwright is not installed',
    checkUrl: 'https://www.spaceship.com/domain-search/?query=quietotter.me' };
  const text = checkText(batch);
  const shown = body(JSON.parse(text).display);
  assert.match(shown, /^Standard prices: \.so \$24\.99, then \$49\.99\/yr, 2x jump$/m);
  assert.match(shown, /^- quietotter\.me \$2\.99, then \$19\.99\/yr, 7x jump \(list price\)$/m);
  assert.match(shown, /^Taken: quietotter \.com \.io · /m);
  assert.ok(shown.endsWith('Check at shop: [quietotter.me](https://www.spaceship.com/domain-search/?query=quietotter.me). '
    + 'Live shop check unavailable (Playwright is not installed). Any prices shown are list estimates.\n' + neverBuys), shown);
  assert.doesNotMatch(shown, /^Confirmed|^- .*✓/m);
  assert.deepEqual(JSON.parse(text).liveCheck, batch.liveCheck);
  // The preliminary shortlist keeps the same check line.
  const preliminary = body(JSON.parse(checkText(batch, true)).display);
  assert.match(preliminary, /\nCheck at shop: \[quietotter\.me\]\(https:\/\/www\.spaceship\.com\/domain-search\/\?query=quietotter\.me\)\. Live shop check unavailable/);

  // Only a trusted shop search link for that exact domain renders as a link.
  const spoofed = { ...exactLive, liveCheck: { ...exactLive.liveCheck, checkUrl: 'https://evil.test/?q=quietotter.me' } };
  const safe = body(JSON.parse(checkText(spoofed)).display);
  assert.doesNotMatch(safe, /evil/);
  assert.match(safe, /\nLive shop check unavailable \(Playwright is not installed\)/);
});

test('starts the MCP server from the executable bin and from server.mjs, from any directory', async () => {
  const bin = new URL('./bin/domain-hound.mjs', import.meta.url);
  const { readFile, stat } = await import('node:fs/promises');
  const binText = await readFile(bin, 'utf8');
  if (process.platform === 'win32') {
    // Windows has no execute bit and a CRLF checkout is valid there: npm runs the bin through a .cmd shim built from this shebang.
    assert.match(binText, /^#!\/usr\/bin\/env node\r?\n/);
  } else {
    assert.ok((await stat(bin)).mode & 0o111, 'bin is executable');
    assert.match(binText, /^#!\/usr\/bin\/env node\n/);
  }
  const { capabilityDir } = await import('./server.mjs');
  assert.equal(capabilityDir, fileURLToPath(new URL('./clis/domain-check/', import.meta.url)));
  assert.ok((await stat(join(capabilityDir, 'index.mjs'))).isFile());
  const elsewhere = await mkdtemp(join(tmpdir(), 'hound-cwd-'));
  try {
    for (const entry of [bin, server]) {
      const responses = await runServer([fileURLToPath(entry)],
        [...handshake(), request(2, 'tools/list'), call(3, {}, 'naming_method')], {}, elsewhere);
      assert.deepEqual(resultOf(responses, 1).serverInfo, { name: 'domain-hound', title: 'Domain Hound', version });
      assert.deepEqual(resultOf(responses, 2).tools.map(tool => tool.name), ['check_domains', 'triage_names', 'naming_guide',
        'watch_domain', 'taken_domain_dossier', 'my_domains', 'quote_domain', 'buy_domain', 'setup_domain', 'move_domain']);
      assert.match(callData(responses, 3).display, /^Naming recipe/);
    }
  } finally {
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test('the package, lockfile, server and every manifest carry one version, and the price snapshot ships', async () => {
  const read = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
  const pkg = await read('./package.json');
  const lock = await read('./package-lock.json');
  const server = await read('./server.json');
  const versions = [lock.version, lock.packages[''].version, server.version, ...server.packages.map(row => row.version),
    (await read('./plugin.json')).version, (await read('./.claude-plugin/plugin.json')).version];
  assert.deepEqual(versions, versions.map(() => pkg.version));
  const responses = await exchange(handshake());
  assert.equal(resultOf(responses, 1).serverInfo.version, pkg.version);
  assert.ok(pkg.files.includes('clis/domain-check/price-snapshot.json'));
});

test('replies before checking handles and collects the completed handle rows with the same call', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'hound-deferred-handles-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const name = 'Paper Heron';
  await writeFile(join(cwd, 'index.mjs'), 'console.log(JSON.stringify(' + JSON.stringify({
    names: [{ name, verdict: 'Check first' }], receiptDetails: [{}], handleTargets: [{ name: 'paperheron', index: 0 }],
  }) + '));');
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = createInterface({ input: output })[Symbol.asyncIterator]();
  let sentFirst = false;
  let calls = 0;
  let finish;
  const lookup = new Promise(resolve => { finish = resolve; });
  output.on('data', chunk => {
    if (JSON.parse(chunk).id === 2) sentFirst = true;
  });
  const completed = serve({ input, output, cwd,
    pages: async data => ({ display: 'Name screen', ...data }),
    socialLookup: async (rows, options) => {
      assert.ok(sentFirst);
      assert.deepEqual(rows, [{ name: 'paperheron', variants: true }]);
      assert.deepEqual(options, { extraPlatforms: ['Discord'], freshRun: true });
      calls++;
      await lookup;
      return new Map([['paperheron', [{ platform: 'GitHub', state: 'taken' }]]]);
    },
  });
  for (const message of handshake()) input.write(JSON.stringify(message) + '\n');
  await lines.next();
  const args = { names: [name], additionalHandles: ['Discord'] };
  input.write(JSON.stringify(call(2, args, 'triage_names')) + '\n');
  const first = JSON.parse((await lines.next()).value).result.structuredContent;
  assert.equal(first.handlesPending, true);
  assert.equal(first.receiptDetails[0].handles.find(row => row.platform === 'GitHub').why, 'still checking');
  finish();
  input.write(JSON.stringify(call(3, args, 'triage_names')) + '\n');
  const second = JSON.parse((await lines.next()).value).result.structuredContent;
  assert.equal(second.handlesPending, undefined);
  assert.deepEqual(second.handles[name].taken, ['GitHub']);
  assert.equal(calls, 1);
  input.end();
  await completed;
  output.end();
  await lines.return();
});


test('keeps a fully priced hosted check and a twenty-name batch within the MCP reply budgets', async t => {
  const offer = { shop: 'Dynadot', firstYearUsd: 5, renewalUsd: 10, firstPaymentUsd: 5,
    threeYearUsd: 25, minimumYears: 1, buyUrl: 'https://example.com/checkout' };
  const shops = ['Dynadot', 'Spaceship', 'Porkbun', 'Namecheap', 'Cloudflare', 'Gandi'];
  const names = Array.from({ length: 20 }, (_, index) => 'lanternotter' + index);
  const mcp = await local(t, { hosted: { async check(name) {
    const domains = defaultEndings.map(ending => ({
      domain: name + '.' + ending, ending, status: 'available',
      prices: shops.map(shop => ({ ...offer, shop })),
    }));
    return { query: { name, exactDomain: null }, domains, complete: true,
      priceSnapshot: { checkedAt: '2026-11-24T12:00:00.000Z' }, choice: { pick: { ...offer, domain: domains[0].domain } } };
  } } });

  for (const [id, input] of [[2, { query: names[0] }], [3, { names }]]) {
    const reply = await mcp.ask(call(id, input));
    const text = callText([reply], id);
    const { rows, resultPage, ...otherFields } = reply.result.structuredContent;
    const expected = input.names ?? [input.query];
    assert.deepEqual(otherFields, {});
    assert.deepEqual(rows, expected.map(name => ({ name, statuses: { available: defaultEndings } })));
    assert.match(text, /^lanternotter0\.com is your best bet:/);
    assert.ok(text.includes(resultsLine(resultPage).replace('Results page:', 'All prices, shops and handles:')));
    assert.ok(expected.every(name => text.includes(name)));
    assert.match(text, /\$5\.00 now, then \$10\.00\/yr \(Dynadot\)/);
    const wire = JSON.stringify(reply);
    assert.ok(id === 2 ? Buffer.byteLength(wire) < 8_000 : wire.length < 40_000, 'Wire size ' + wire.length);
    const receipt = await readFile(new URL(resultPage), 'utf8');
    assert.ok(expected.every(name => receipt.includes(name + '.com')));
    assert.match(receipt, /Gandi/);
  }
});

test('the package entry point defaults to short hosted check, screening and idea replies', async t => {
  const name = 'exampleheron';
  const domain = name + '.dev';
  const offer = { domain, shop: 'Example Shop', firstYearUsd: 5, firstPaymentUsd: 5, renewalUsd: 10, threeYearUsd: 25 };
  const row = { domain, ending: 'dev', status: 'available', prices: [offer] };
  const appStore = { status: 'no_match_found', matches: [] };
  const googlePlay = { status: 'taken' };
  const trademarks = { us: { status: 'no_exact_match_found', marks: [] } };
  const paths = [];
  const api = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const query = url.searchParams.get('name');
    paths.push([url.pathname, query, request.headers['x-domain-hound-client']]);
    let data;
    if (url.pathname === '/v1/check') {
      const exactDomain = query === domain ? domain : null;
      data = { version: 1, query: { name, ascii: name, exactDomain }, complete: true,
        domains: [row], choice: { pick: offer }, appStore,
        ...(exactDomain ? { details: { id: 'fixture-id' } } : { googlePlay, trademarks }) };
    } else if (url.pathname === '/v1/generate') {
      request.resume();
      data = { version: 2, stage: 'final', complete: true,
        names: [{ name, domain: offer, domains: [row], nameChecks: { appStore, googlePlay, trademarks } }] };
    }
    response.writeHead(data ? 200 : 404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(data ?? {}));
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(() => { api.closeAllConnections(); return new Promise(resolve => api.close(resolve)); });

  const check = { query: domain };
  const triage = { names: [name] };
  const idea = { idea: 'An app for planning a library' };
  const responses = await runServer([fileURLToPath(new URL('./bin/domain-hound.mjs', import.meta.url))], [
    ...handshake('2025-06-18'), request(2, 'tools/list'),
    call(3, check), call(4, { ...check, detail: 'full' }),
    call(5, triage, 'triage_names'), call(6, { ...triage, detail: 'full' }, 'triage_names'),
    call(7, idea, 'triage_names'), call(8, { ...idea, detail: 'full' }, 'triage_names'),
    call(9, { query: name }),
  ], { DOMAIN_HOUND_LOCAL: '0', DOMAIN_HOUND_API_URL: 'http://127.0.0.1:' + api.address().port });

  assert.deepEqual(callText(responses, 3).split('\n').slice(0, -1), [
    'exampleheron.dev is available: $5.00 now, then $10.00/yr (Example Shop).',
    'App Store: no app with this name',
    'Still checking Google Play, US trademark.',
  ]);
  assert.match(callText(responses, 9), /^exampleheron\.dev is your best bet: \$5\.00 now, then \$10\.00\/yr \(Example Shop\)\./);
  assert.match(callText(responses, 4), /Ask to quote exampleheron\.dev\./);
  assert.match(callText(responses, 5), /^exampleheron - .* · App Store free · Google Play taken\n/);
  assert.match(callText(responses, 7), /^exampleheron - exampleheron\.dev, \$5\.00 now, then \$10\.00\/yr \(Example Shop\) · App Store free · Google Play taken\n/);
  for (const [short, full] of [[3, 4], [5, 6], [7, 8]]) {
    assert.match(callText(responses, short), /\nAll prices, shops and handles: \[Open results\]/);
    assert.doesNotMatch(callText(responses, short), /Available ·|first year/);
    assert.match(callText(responses, full), /Available · exampleheron\.dev\nExample Shop.*\$5\.00 first year/);
    assert.equal(resultOf(responses, short).structuredContent.resultPage, resultOf(responses, full).structuredContent.resultPage);
  }
  for (const tool of resultOf(responses, 2).tools.slice(0, 2)) assert.equal(tool.inputSchema.properties.detail.default, 'short');
  assert.deepEqual(paths.filter(([path]) => path === '/v1/check').map(([, query]) => query).sort(), [name, name, domain]);
  assert.equal(paths.filter(([path]) => path === '/v1/generate').length, 1);
  assert.ok(paths.every(([, , client]) => client === 'mcp/' + version));
});

test('a local name screen with extra handles stays short unless full detail is requested', async () => {
  const args = { names: ['Example Heron'], additionalHandles: ['Discord'] };
  const responses = await exchange([...handshake(), call(2, args, 'triage_names'),
    call(3, { ...args, detail: 'full' }, 'triage_names')]);
  assert.match(callText(responses, 2), /^Example Heron - /);
  assert.match(callText(responses, 2), /All prices, shops and handles: \[Open results\]/);
  assert.match(callText(responses, 3), /^Results page: /m);
  assert.equal(resultOf(responses, 2).structuredContent.resultPage, resultOf(responses, 3).structuredContent.resultPage);
});

test('the local idea fallback gives a short next step and keeps the recipe in full detail', async () => {
  const args = { idea: 'An app for planning a library' };
  const responses = await exchange([...handshake(), call(2, args, 'triage_names'),
    call(3, { ...args, detail: 'full' }, 'triage_names')]);
  assert.match(callText(responses, 2), /naming_guide/);
  assert.ok(callText(responses, 2).length < 200);
  assert.match(callText(responses, 3), /Use this naming method/);
  assert.ok(callText(responses, 3).length > 1000);
});

test('a hosted check without a results link still shows a short answer', async t => {
  const name = 'exampleheron';
  const domain = name + '.dev';
  const mcp = await local(t, {
    hosted: { async check() {
      return { query: { name, ascii: name, exactDomain: null }, complete: true, choice: { pick: null },
        domains: [{ domain, ending: 'dev', status: 'available', prices: [] }] };
    } },
    pages: async data => ({ ...data, display: 'Available · ' + domain }),
  });
  const reply = await mcp.ask(call(2, { query: name }));
  assert.match(callText([reply], 2), /^exampleheron\.dev is available\./);
});

test('hosted domain checks keep shop order and recover a rate-limited App Store result locally', async t => {
  const paths = [];
  const offer = { shop: 'Dynadot', firstYearUsd: 5, renewalUsd: 10, firstPaymentUsd: 5,
    threeYearUsd: 25, buyUrl: 'https://www.dynadot.com/domain/search?domain=exampleheron.dev' };
  const domain = { domain: 'exampleheron.dev', ending: 'dev', status: 'available', prices: [offer, { ...offer, shop: 'Porkbun', threeYearUsd: 30 }] };
  const appStore = { status: 'unknown', reason: 'rate-limited', matches: [] };
  const host = hostedClient(version, { env: { DOMAIN_HOUND_API_URL: 'https://api.example.test' },
    fetchFn: async (url, init) => {
      const parsed = new URL(url);
      paths.push(parsed.pathname);
      if (parsed.hostname === 'itunes.apple.com') {
        assert.equal(parsed.searchParams.get('term'), 'exampleheron');
        assert.equal(new Headers(init.headers).get('X-Domain-Hound-Client'), null);
        return Response.json({ results: [{ trackName: 'Exampleheron', trackId: 12345 }] });
      }
      assert.equal(init.headers['X-Domain-Hound-Client'], 'mcp/' + version);
      assert.equal(parsed.hostname, 'api.example.test');
      if (parsed.pathname === '/v1/check') return Response.json({
        version: 1, query: { name: 'exampleheron', ascii: 'exampleheron', exactDomain: null }, complete: true,
        domains: [domain, { domain: 'exampleheron.com', ending: 'com', status: 'taken', prices: [] }],
        choice: { pick: { ...offer, domain: domain.domain } }, details: { id: 'fixture-id' },
      });
      assert.equal(parsed.searchParams.get('id'), 'fixture-id');
      return Response.json({ version: 1, appStore, googlePlay: { status: 'not-found', link: 'https://play.google.com/store' },
        handles: ['YouTube', 'X', 'Instagram', 'TikTok', 'Threads', 'Facebook', 'Twitch'].map(platform => ({ platform, state: 'not-found',
          ...(platform === 'Threads' && { why: 'no Instagram account' }) })).concat(
          ['LinkedIn', 'Reddit'].map(platform => ({ platform, state: 'not-seen' }))),
        trademarks: { us: { status: 'exact_match_found', marks: [{ mark: 'EXAMPLEHERON', owner: 'Example Company',
          status: 'applied', url: 'https://tsdr.uspto.gov/' }] } } });
    },
  });
  const mcp = await local(t, { hosted: host });
  const reply = await mcp.ask(call(2, { query: 'exampleheron' }, 'broker_find'));
  assert.match(callText([reply], 2), /^exampleheron\.dev is your best bet: .*Dynadot/);
  assert.doesNotMatch(callText([reply], 2), /Available ·|first year/);
  const full = await mcp.ask(call(3, { query: 'exampleheron', detail: 'full' }, 'broker_find'));
  assert.match(callText([full], 3), /Available · exampleheron\.dev/);
  assert.deepEqual(full.result.structuredContent, reply.result.structuredContent);
  const answer = reply.result.structuredContent;
  assert.deepEqual(paths, ['/v1/check', '/v1/check/details', '/search']);
  assert.equal(answer.checks[0].nameChecks.appStore.source, 'local');
  assert.equal(answer.checks[0].nameChecks.appStore.status, 'taken');
  assert.deepEqual(answer.checks[0].domains[0].prices.map(row => row.shop), ['Dynadot', 'Porkbun']);
  assert.match(answer.display, /The Hound’s pick[\s\S]*App Store \(iOS\)[\s\S]*Google Play \(Android\)[\s\S]*Heads-up[\s\S]*Dynadot.*cheapest over three years[\s\S]*Porkbun/);
  assert.match(answer.display, /App Store \(iOS\) · Taken.*Exampleheron/);
  assert.match(answer.display, /Taken · exampleheron\.com.*Watch.*Draft an offer.*Try a new name/);
  assert.equal(answer.checks[0].details, undefined);
});

for (const [timing, title] of [
  ['first', 'includes a quick local App Store answer in the first reply'],
  ['details', 'includes a local App Store answer when details first report the rate limit'],
  ['repeat', 'collects a late local App Store answer on repeat'],
]) {
  test('check_domains ' + title, async t => {
    const name = 'exampleheron';
    const appStore = { status: 'unknown', reason: 'rate-limited', matches: [] };
    const fallback = Response.json({ results: [{ trackName: 'Exampleheron: Notes', trackId: 12345 }] });
    let releaseApple;
    const apple = new Promise(resolve => { releaseApple = resolve; });
    let releaseDetails;
    const details = new Promise(resolve => { releaseDetails = resolve; });
    t.after(() => { releaseApple(fallback); releaseDetails(); });
    let retries = 0;
    let appleSignal;
    const host = hostedClient(version, { env: { DOMAIN_HOUND_API_URL: 'https://api.example.test', DOMAIN_HOUND_EMBED_CHECKS: 'off' },
      fetchFn: async (input, { signal }) => {
        const url = new URL(input);
        if (url.hostname === 'itunes.apple.com') {
          retries++;
          assert.equal(url.searchParams.get('term'), name);
          appleSignal = signal;
          return apple;
        }
        assert.equal(url.hostname, 'api.example.test');
        if (url.pathname === '/v1/check') return Response.json({
          version: 1, query: { name, ascii: name, exactDomain: null }, domains: [], choice: { pick: null },
          complete: true, ...(timing !== 'details' && { appStore }), details: { id: 'token' },
        });
        await details;
        return Response.json({ version: 1, appStore, googlePlay: { status: 'not-found' },
          trademarks: { us: { status: 'no_exact_match_found', marks: [] } }, handles: [{ platform: 'YouTube', state: 'not-found' }] });
      } });
    const mcp = await local(t, { hosted: host });
    const args = { query: name };
    mcp.send(call(2, args));
    if (timing === 'details') {
      assert.equal(await mcp.answered(2), false);
      assert.equal(retries, 0);
      releaseDetails();
    }
    assert.equal(await mcp.answered(2), false);
    assert.equal(retries, 1);
    const late = timing === 'repeat';
    if (late) mcp.clock.tick(4000);
    else releaseApple(fallback);
    const first = structured(await mcp.reply(2));
    assert.equal(first.pending, true);
    assert.match(first.display, late ? /^Still checking App Store/m : /App Store: taken/);
    const early = await readFile(new URL(first.resultPage), 'utf8');
    assert.match(early, late ? /Still checking/ : /Exampleheron: Notes/);
    mcp.send(call(3, args));
    if (late) {
      assert.equal(await mcp.answered(3), false);
      assert.equal(appleSignal.aborted, false);
    }
    releaseApple(fallback);
    releaseDetails();
    const final = structured(await mcp.reply(3));
    assert.equal(final.resultPage, first.resultPage);
    assert.match(final.display, /App Store: taken/);
    assert.equal(retries, 1);
  });
}

test('the package uses the local check when the hosted request cannot connect', async t => {
  assert.equal(hostedClient(version, { env: { DOMAIN_HOUND_LOCAL: '1' } }), null);
  let attempts = 0;
  const host = hostedClient(version, { env: {}, fetchFn: async () => {
    attempts++;
    throw new Error('connection refused');
  } });
  const mcp = await local(t, { hosted: host });
  const answer = structured(await mcp.ask(call(2, { query: 'oakenroom.me' })));
  assert.equal(attempts, 2);
  assert.equal(answer.rows[0].name, 'oakenroom.me');
  assert.equal(answer.checks, undefined);
  assert.ok(answer.display.split('\n')[0].endsWith(localCheckNotice));
  assert.match(answer.display, /^oakenroom\.me is available/);
});

test('the first tool call retries transient hosted check and details failures', async t => {
  const attempts = new Map();
  const name = 'exampleheron';
  const host = hostedClient(version, { env: { DOMAIN_HOUND_API_URL: 'https://api.example.test',
    DOMAIN_HOUND_EMBED_CHECKS: 'off' }, fetchFn: async url => {
    assert.equal(url.hostname, 'api.example.test');
    const path = url.pathname;
    attempts.set(path, (attempts.get(path) ?? 0) + 1);
    if (attempts.get(path) === 1) return new Response(null, { status: 503 });
    if (path === '/v1/check') return Response.json({
      version: 1, query: { name, ascii: name, exactDomain: null }, domains: [], choice: { pick: null },
      complete: true, details: { id: 'fixture-id' },
    });
    return Response.json({ version: 1, appStore: { status: 'no_match_found', matches: [] },
      googlePlay: { status: 'unknown' }, handles: [{ platform: 'YouTube', state: 'not-found' }],
      trademarks: { us: { status: 'no_exact_match_found', marks: [] } } });
  } });
  const mcp = await local(t, { hosted: host });
  const answer = structured(await mcp.ask(call(2, { query: name }, 'broker_find')));
  assert.equal(answer.checks[0].nameChecks.appStore.status, 'no_match_found');
  assert.equal(answer.source, undefined);
  assert.doesNotMatch(answer.display, /Checked on your machine/);
  assert.deepEqual([...attempts], [['/v1/check', 2], ['/v1/check/details', 2]]);
});

test('a slow hosted lookup stays hosted past the tool response budget and a repeat collects it', async t => {
  const name = 'exampleheron';
  let finish;
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const result = new Promise(resolve => { finish = resolve; });
  let attempts = 0;
  const mcp = await local(t, { timeout: 1000, hosted: { check() {
    attempts++;
    started();
    return result;
  } } });
  const args = { query: name };
  mcp.send(call(2, args));
  await entered;
  mcp.clock.tick(1000);
  const progress = structured(await mcp.reply(2));
  assert.equal(progress.pending, true);
  assert.equal(progress.display, 'Still checking domains.');
  mcp.send(call(3, args));
  finish({ query: { name, ascii: name, exactDomain: null }, domains: [], complete: true, choice: { pick: null } });
  const answer = structured(await mcp.reply(3));
  assert.equal(answer.rows[0].name, name);
  assert.equal(attempts, 1);
});

test('the MCP checks YouTube locally only when the hosted YouTube state is unknown', async t => {
  const calls = [];
  const key = 'fixture-placeholder';
  const host = hostedClient(version, { env: { DOMAIN_HOUND_API_URL: 'https://api.example.test', YOUTUBE_API_KEY: key,
    DOMAIN_HOUND_EMBED_CHECKS: 'off' },
    fetchFn: async (input, init) => {
      const url = new URL(input);
      if (url.hostname === 'www.googleapis.com') {
        assert.equal(new Headers(init.headers).get('x-goog-api-key'), key);
        calls.push(url.searchParams.get('forHandle'));
        return Response.json({ items: [{ id: 'UC0123456789abcdefghijkl' }] });
      }
      assert.equal(url.hostname, 'api.example.test');
      assert.equal(new Headers(init.headers).has('x-goog-api-key'), false);
      const name = url.searchParams.get('name') ?? url.searchParams.get('id');
      if (url.pathname === '/v1/check') return Response.json({
        version: 1, query: { name, ascii: name, exactDomain: null }, complete: true,
        domains: [], choice: { pick: null }, details: { id: name },
      });
      return Response.json({ version: 1, appStore: { status: 'no_match_found', matches: [] },
        googlePlay: { link: 'https://play.google.com/store/search?q=' + name },
        handles: [{ platform: 'YouTube', handle: name, state: name === 'knownbrand' ? 'not-found' : 'unknown',
          link: 'https://www.youtube.com/@' + name, why: 'not connected' }],
        trademarks: { us: { status: 'no_exact_match_found', marks: [] } } });
    },
  });
  const mcp = await local(t, { hosted: host });
  const checked = resultOf([await mcp.ask(call(2, { query: 'localbrand' }, 'broker_find'))], 2).structuredContent;
  assert.match(checked.display, /YouTube · \[Taken\]\(https:\/\/www\.youtube\.com\/@localbrand\)/);
  assert.match(checked.display, /LinkedIn · Couldn't check · \[Search LinkedIn\]/);
  assert.match(checked.display, /Google Play \(Android\) · Couldn’t check · \[Search Google Play\]/);
  assert.equal(checked.checks[0].nameChecks.handles[0].source, 'local');
  assert.doesNotMatch(JSON.stringify(checked), /fixture-placeholder/);
  const known = resultOf([await mcp.ask(call(3, { query: 'knownbrand' }, 'broker_find'))], 3).structuredContent;
  assert.match(known.display, /YouTube · \[No profile found\]/);
  assert.deepEqual(calls, ['@localbrand']);
});

test('triage_names sends the steering to hosted generation and refreshes the same receipt', async t => {
  const requests = [];
  const previous = { name: 'Exampleheron', territory: 'object', anchor: 'heron',
    why: 'A heron watches patiently, like an event host watching the workshop schedule.' };
  const input = { idea: 'A tool for planning workshops', wanted: ['Exampleheron'], avoid: ['Examplefox'], round: 2,
    shown: [previous], feedback: 'Keep heron and make it calmer.',
    taste: [{ id: 'bird', kind: 'keep-word', value: 'heron', source: previous.name }] };
  const initial = { version: 2, stage: 'initial', names: [], round: 2, complete: false, details: { id: 'test-job' } };
  const final = { ...initial, stage: 'final', complete: true, details: null,
    question: 'Which word would you keep, and what do you like about another name?' };
  let finish;
  const followUp = new Promise(resolve => { finish = resolve; });
  const host = {
    generate: async args => { requests.push(args); return initial; },
    finishGeneration: async value => { assert.equal(value, initial); return followUp; },
  };
  const mcp = await local(t, { hosted: host });
  const first = await mcp.ask(call(2, input, 'triage_names')).then(structured).finally(() => finish(final));
  const updated = await mcp.waitForPage(data => data.generation?.stage === 'final');
  assert.deepEqual(requests, [input]);
  assert.equal(first.pending, true);
  assert.equal(first.generation.details, undefined);
  assert.equal(updated.resultPage, first.resultPage);
  assert.match(updated.display, /Which word would you keep/);
});

test('check_domains fills unknown public name checks locally and keeps confirmed hosted answers', async t => {
  const calls = [];
  const name = 'paperheron';
  const fixtures = JSON.parse(await readFile(new URL('./clis/domain-check/fixtures/public-name-checks.json', import.meta.url), 'utf8'));
  const host = hostedClient(version, { env: { DOMAIN_HOUND_API_URL: 'https://api.example.test' }, fetchFn: async (input, init) => {
    const url = new URL(input);
    if (url.hostname === 'api.example.test') {
      if (url.pathname === '/v1/check') return Response.json({
        version: 1, query: { name, ascii: name, exactDomain: null }, complete: true,
        domains: [], choice: { pick: null }, details: { id: name },
      });
      return Response.json({ version: 1, appStore: { status: 'no_match_found', matches: [] }, googlePlay: { status: 'unknown' },
        handles: [{ platform: 'X', handle: name, state: 'not-found', link: 'https://x.com/' + name },
          ...['YouTube', 'Instagram', 'TikTok', 'Threads'].map(platform => ({ platform, handle: name, state: 'unknown' }))],
        trademarks: { us: { status: 'no_exact_match_found', marks: [] } } });
    }
    assert.equal(new Headers(init.headers).has('x-domain-hound-client'), false);
    calls.push(url.hostname);
    if (url.hostname === 'web.archive.org') return new Response(url.searchParams.get('url').startsWith('reddit.com/')
      ? '20180308025019 200\n' : '', { headers: { 'content-type': 'text/plain' } });
    const kind = { 'www.tiktok.com': 'tiktok', 'graph.facebook.com': url.pathname.endsWith('/picture') ? 'facebook' : 'instagram',
      'www.youtube.com': 'youtube', 'www.threads.net': 'threads', 'www.twitch.tv': 'twitch', 'play.google.com': 'googlePlay' }[url.hostname];
    const fixture = fixtures[kind][kind === 'threads' ? 'login' : kind === 'twitch' ? 'not-found' : 'taken'];
    const body = kind === 'googlePlay' ? fixture.body.replace('Paper Heron -', 'PaperHeron -')
      : kind === 'twitch' ? fixture.body.replace('absentbrand', name) : fixture.body;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body),
      { status: fixture.status, headers: { 'content-type': fixture.type } });
  } });
  const mcp = await local(t, { hosted: host });
  const answer = resultOf([await mcp.ask(call(2, { query: name }, 'broker_find'))], 2).structuredContent;
  const checks = answer.checks[0].nameChecks;
  assert.equal(checks.googlePlay.status, 'taken');
  assert.equal(checks.googlePlay.source, 'local');
  assert.deepEqual(Object.fromEntries(checks.handles.map(row => [row.platform, [row.state, row.source]])), {
    X: ['not-found', undefined], YouTube: ['taken', 'local'], Instagram: ['taken', 'local'], TikTok: ['taken', 'local'],
    Threads: ['unknown', undefined], Facebook: ['taken', 'local'], LinkedIn: ['not-seen', 'local'],
    Reddit: ['taken', 'local'], Twitch: ['not-found', 'local'],
  });
  assert.match(answer.display, /Threads · \[Couldn't check\]/);
  assert.match(answer.display, /LinkedIn · No page found in public archives · \[Search LinkedIn\]/);
  assert.match(answer.display, /site:linkedin\.com\/company\/paperheron/);
  assert.match(answer.display, /Reddit · \[Found · seen 2018\]/);
  assert.match(answer.display, /Google Play \(Android\) · Taken · \[Search Google Play\]/);
  assert.deepEqual(calls.sort(), ['graph.facebook.com', 'graph.facebook.com', 'play.google.com', 'web.archive.org', 'web.archive.org',
    'www.threads.net', 'www.tiktok.com', 'www.twitch.tv', 'www.youtube.com']);
});

test('the package first call and saved page show both app stores before an exact US filing', async t => {
  const name = 'exampleheron';
  const domain = name + '.dev';
  const offer = { shop: 'Dynadot', firstYearUsd: 5, renewalUsd: 10, firstPaymentUsd: 5, threeYearUsd: 25,
    buyUrl: 'https://www.dynadot.com/domain/search?domain=' + domain };
  let finish;
  const held = new Promise(resolve => { finish = resolve; });
  t.after(() => finish(new Response(null, { status: 500 })));
  const trademark = { status: 'exact_match_found', marks: [{ mark: 'EXAMPLEHERON', owner: 'Example Studio',
    url: 'https://tsdr.uspto.gov/#caseNumber=12345678' }] };
  const appStore = { status: 'no_match_found', matches: [] };
  const googlePlay = { status: 'taken', link: 'https://play.google.com/store/search?q=exampleheron' };
  const host = hostedClient(version, { env: { DOMAIN_HOUND_API_URL: 'https://api.example.test', DOMAIN_HOUND_EMBED_CHECKS: 'off' },
    fetchFn: async url => {
      if (url.pathname === '/v1/check/details') return held;
      assert.equal(url.pathname, '/v1/check');
      return Response.json({ version: 1, query: { name, ascii: name, exactDomain: null }, complete: true,
        domains: [{ domain, ending: 'dev', status: 'available', prices: [offer] }],
        choice: { pick: { ...offer, domain } }, appStore, googlePlay, trademarks: { us: trademark },
        details: { id: 'token' } });
    } });
  const mcp = await local(t, { hosted: host });
  const first = await mcp.ask(call(2, { query: name }));
  const { resultPage, pending } = structured(first);
  assert.equal(pending, true);
  const lines = first.result.content[0].text.split('\n');
  assert.deepEqual(lines.slice(0, 3), [
    'exampleheron.dev is your best bet: $5.00 now, then $10.00/yr (Dynadot).',
    'App Store: no app with this name · Google Play: taken',
    'Heads-up: EXAMPLEHERON has an exact US trademark match (Example Studio). Matters if you sell in the US.',
  ]);
  assert.equal(lines.length, 4);
  assert.match(lines[3], /^All prices, shops and handles:/);
  const early = await readFile(new URL(resultPage), 'utf8');
  assert.match(early.split('<body>')[1], /Hound’s pick.*App Store \(iOS\).*Google Play \(Android\).*trademark-warning.*Example Studio.*Buy at Dynadot/s);
  finish(Response.json({ version: 1, appStore: { status: 'unknown', matches: [] }, googlePlay: { status: 'unknown' },
    trademarks: { us: { status: 'unknown', marks: [] } }, handles: [] }));
  await mcp.waitForPage(data => data?.hosted && !data.pending);
  const final = await readFile(new URL(resultPage), 'utf8');
  assert.match(final.split('<body>')[1], /No matching app found.*Google Play \(Android\).*Taken.*12345678/s);
});

test('check_domains returns a client-recovered pick before name checks and rewrites the same receipt', async t => {
  const name = 'brightboard';
  const domain = name + '.dev';
  const rdapUrl = 'https://pubapi.registry.google/rdap/domain/' + domain;
  const paths = [];
  let startedDetails;
  const detailsStarted = new Promise(resolve => { startedDetails = resolve; });
  const offer = { shop: 'Dynadot', firstYearUsd: 5, renewalUsd: 10, firstPaymentUsd: 5,
    threeYearUsd: 25, checkedAt: '2026-11-24', source: 'https://prices.example/dynadot',
    buyUrl: 'https://www.dynadot.com/domain/search?domain=' + domain };
  let finish;
  const held = new Promise(resolve => { finish = resolve; });
  const host = hostedClient(version, { env: { DOMAIN_HOUND_API_URL: 'https://api.example.test', DOMAIN_HOUND_EMBED_CHECKS: 'off' },
    fetchFn: async (input, init) => {
      const url = new URL(input);
      paths.push(url.pathname);
      if (url.href === rdapUrl) {
        assert.equal(init.redirect, 'error');
        assert.equal(new Headers(init.headers).get('X-Domain-Hound-Client'), null);
        return Response.json({ errorCode: 404 }, { status: 404, headers: { 'content-type': 'application/rdap+json' } });
      }
      assert.equal(url.hostname, 'api.example.test');
      if (url.pathname === '/v1/check/details') {
        startedDetails();
        return held;
      }
      const seen = url.searchParams.get('seen');
      assert.ok(seen === null || seen === 'dev:available');
      return Response.json({ version: 1, query: { name, ascii: name, exactDomain: null }, complete: true,
        domains: [{ domain, ending: 'dev', status: seen ? 'available' : 'unknown', prices: [offer],
          ...(seen ? { checkedFrom: 'local' } : { rdapUrl }) }],
        choice: { pick: seen ? { ...offer, domain } : null }, details: { id: 'token' },
        appStore: { status: 'pending' }, googlePlay: { status: 'pending' }, trademarks: { us: { status: 'pending', marks: [] } } });
    } });
  const mcp = await local(t, { hosted: host });
  mcp.send(call(2, { query: name }));
  await detailsStarted;
  mcp.clock.tick(4000);
  const first = await mcp.reply(2);
  const { resultPage, pending } = structured(first);
  assert.equal(pending, true);
  assert.match(first.result.content[0].text, /^brightboard\.dev is your best bet:.*Dynadot/);
  assert.match(first.result.content[0].text, /^Still checking App Store, Google Play, US trademark\.$/m);
  assert.ok(first.result.content[0].text.split('\n').length <= 6);
  const early = await readFile(new URL(resultPage), 'utf8');
  assert.match(early, /http-equiv="refresh"/);
  assert.match(early, /class="hunt-results"/);
  assert.match(early, /data-domain="brightboard\.dev"/);
  assert.match(early, /Name checks are still running\./);
  assert.doesNotMatch(early, /same tool with the same input/);
  finish(Response.json({ version: 1, appStore: { status: 'no_match_found', matches: [] },
    googlePlay: { status: 'not-found', link: 'https://play.google.com/' }, handles: [{ platform: 'YouTube', state: 'not-found' }],
    trademarks: { us: { status: 'no_exact_match_found', marks: [] } } }));
  await mcp.waitForPage(data => data?.hosted && !data.pending);
  for (let id = 3; id < 20; id++) {
    await new Promise(resolve => setImmediate(resolve));
    const next = await mcp.ask(call(id, { query: name }));
    if (next.result.structuredContent.pending) continue;
    assert.equal(next.result.structuredContent.resultPage, resultPage);
    assert.match(next.result.content[0].text, /App Store: no app with this name/);
    const updated = await readFile(new URL(resultPage), 'utf8');
    assert.doesNotMatch(updated, /http-equiv="refresh"/);
    assert.match(updated, /class="hunt-results"/);
    assert.match(updated, /data-domain="brightboard\.dev"/);
    assert.match(updated, /class="check-grid"/);
    assert.match(updated, /No matching app found/);
    assert.doesNotMatch(updated, /Name checks are still running/);
    assert.deepEqual(paths, ['/v1/check', '/rdap/domain/brightboard.dev', '/v1/check', '/v1/check/details']);
    return;
  }
  assert.fail('The repeat never collected the finished name checks.');
});

test('local registry recovery ignores mismatched routes, stale negatives and reserved domains', async () => {
  const ascii = 'mapfern';
  for (const [url, status, body, headers] of [
    ['https://not-the-registry.example/rdap/domain/mapfern.dev', 404, { errorCode: 404 }, {}],
    ['https://pubapi.registry.google/rdap/domain/mapfern.dev', 404, { errorCode: 404 }, { age: '5' }],
    ['https://pubapi.registry.google/rdap/domain/mapfern.dev', 404, { errorCode: 404, description: ['Domain is reserved'] }, {}],
    ['https://pubapi.registry.google/rdap/domain/mapfern.dev', 200, { objectClassName: 'domain', ldhName: 'other.dev' }, {}],
  ]) {
    const host = hostedClient(version, { env: { DOMAIN_HOUND_API_URL: 'https://api.example.test' },
      fetchFn: async input => {
        const parsed = new URL(input);
        if (parsed.hostname === 'pubapi.registry.google') return Response.json(body, { status, headers });
        assert.equal(parsed.hostname, 'api.example.test');
        assert.equal(parsed.searchParams.get('seen'), null);
        return Response.json({ version: 1, query: { ascii, name: ascii }, domains: [
          { domain: ascii + '.dev', ending: 'dev', status: 'unknown', prices: [], rdapUrl: url },
        ], choice: { pick: null } });
      } });
    const answer = await host.check(ascii, [], AbortSignal.timeout(2000));
    assert.equal(answer.domains[0].status, 'unknown');
    assert.equal(answer.choice.pick, null);
  }
});


test('a taken exact name offers a priced alternative and detail reuses the same receipt', async t => {
  const offer = { shop: 'Example Shop', firstPaymentUsd: 7.5, renewalUsd: 11.75, threeYearUsd: 31,
    buyUrl: 'https://example.test/shop' };
  const name = 'exampleheron';
  const domain = name + '.ai';
  const dev = { domain: name + '.dev', ending: 'dev', status: 'available', prices: [offer] };
  const exact = { domain, ending: 'ai', status: 'taken', prices: [] };
  const calls = [];
  const host = hostedClient(version, { env: { DOMAIN_HOUND_API_URL: 'https://api.example.test', DOMAIN_HOUND_EMBED_CHECKS: 'off' },
    fetchFn: async url => {
      if (url.pathname === '/v1/check/details') {
        calls.push(url.pathname);
        return Response.json({ version: 1, appStore: { status: 'no_match_found', matches: [] },
          googlePlay: { status: 'taken' }, trademarks: { us: { status: 'no_exact_match_found', marks: [] } },
          handles: [{ platform: 'Instagram', state: 'taken', link: 'https://www.instagram.com/exampleheron/' }] });
      }
      const query = url.searchParams.get('name');
      calls.push(query);
      return Response.json({ version: 1, query: { name, ascii: name, exactDomain: query === domain ? domain : null },
        domains: query === domain ? [exact] : [exact, dev], complete: true,
        choice: { pick: query === domain ? null : { ...offer, domain: dev.domain } },
        appStore: { status: 'no_match_found', matches: [] }, googlePlay: { status: 'taken' },
        trademarks: { us: { status: 'no_exact_match_found', marks: [] } }, details: { id: 'fixture-id' } });
    } });
  const mcp = await local(t, { hosted: host });
  const first = await mcp.ask(call(2, { query: domain }));
  const lines = first.result.content[0].text.split('\n');
  assert.equal(lines[0], 'exampleheron.ai is taken. Best available: exampleheron.dev, $7.50 now, then $11.75/yr (Example Shop).');
  assert.equal(lines[1], 'Taken: .ai');
  assert.ok(lines.length <= 6);
  assert.doesNotMatch(lines.join('\n'), /^Instagram/m);
  assert.deepEqual(first.result.structuredContent.rows, [{ name: domain, statuses: { taken: ['ai'] } }]);
  const full = await mcp.ask(call(3, { query: domain, detail: 'full' }));
  assert.equal(full.result.structuredContent.resultPage, first.result.structuredContent.resultPage);
  assert.match(full.result.content[0].text, /^Instagram ·/m);
  assert.match(full.result.content[0].text, /Available · exampleheron.dev[\s\S]*Example Shop/);
  const html = await readFile(new URL(full.result.structuredContent.resultPage), 'utf8');
  assert.match(html, /exampleheron.dev/);
  assert.match(html, /Example Shop/);
  assert.deepEqual(calls, [domain, name, '/v1/check/details']);
});

test('checks the hidden .inc ending before counting all ten defaults as taken', async t => {
  const name = 'fullharbor';
  const calls = [];
  const host = hostedClient(version, { env: { DOMAIN_HOUND_API_URL: 'https://api.example.test' },
    fetchFn: async url => {
      const query = url.searchParams.get('name');
      calls.push(query);
      const exactDomain = query.endsWith('.inc') ? query : null;
      const endings = exactDomain ? ['inc'] : defaultEndings.filter(ending => ending !== 'inc');
      return Response.json({ version: 1, query: { name, ascii: name, exactDomain }, complete: true,
        domains: endings.map(ending => ({ domain: name + '.' + ending, ending, status: 'taken', prices: [] })),
        appStore: { status: 'taken', matches: [] }, googlePlay: { status: 'taken' },
        trademarks: { us: { status: 'no_exact_match_found', marks: [] } }, choice: { pick: null } });
    } });
  const mcp = await local(t, { hosted: host });
  const first = await mcp.ask(call(2, { query: name }));
  assert.match(first.result.content[0].text, /^All 10 endings are taken\. Want new name ideas\?/);
  assert.deepEqual(first.result.structuredContent.rows[0].statuses.taken, defaultEndings.filter(ending => ending !== 'inc'));
  assert.deepEqual(calls, [name, name + '.inc']);
});

test('an idea shows one line per name, puts confirmed prices first and caps the list at five', async t => {
  const names = Array.from({ length: 6 }, (_, i) => {
    const name = 'Example ' + i;
    const domain = { domain: 'example' + i + '.dev', ending: 'dev', status: 'available',
      shop: 'Example Shop', firstYearUsd: 7, renewalUsd: 12, threeYearUsd: 31 };
    return { name, domain, domains: [{ ...domain, prices: [domain] }],
      nameChecks: { appStore: { status: 'no_match_found' }, googlePlay: { status: 'not-found' } } };
  });
  const mcp = await local(t, { hosted: { generate: async () => ({ version: 2, stage: 'final', complete: true, names }) } });
  const args = { idea: 'An app for planning a library' };
  const first = await mcp.ask(call(2, args, 'triage_names'));
  const lines = first.result.content[0].text.split('\n');
  assert.equal(lines.length, 6);
  assert.equal(lines[0], 'Example 0 - example0.dev, $7.00 now, then $12.00/yr (Example Shop) · apps free');
  assert.match(lines.at(-1), /^All prices, shops and handles:/);
  assert.equal(first.result.structuredContent.checks.length, 6);
  const full = await mcp.ask(call(3, { ...args, detail: 'full' }, 'triage_names'));
  assert.deepEqual(full.result.structuredContent, first.result.structuredContent);
  assert.equal(full.result.content[0].text, full.result.structuredContent.display);
  assert.match(full.result.content[0].text, /Available · example5.dev/);
});
