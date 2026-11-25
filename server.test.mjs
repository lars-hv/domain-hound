import './test-support/isolated-cache.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeCache } from './clis/domain-check/cache.mjs';
import { triageNames } from './clis/domain-check/triage.mjs';
import { attribution, checkText, errorText as errorJson, md, neverBuys, safeLink, showAsIs, triageText } from './display.mjs';

const server = new URL('./server.mjs', import.meta.url);
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
      env: { ...process.env, ...env }, cwd,
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

function callText(responses, id, isError = false) {
  const result = resultOf(responses, id);
  assert.equal(result.isError, isError);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  return result.content[0].text;
}

// Every display ends with exactly one attribution line after a blank line. Returns the body before it.
function body(display) {
  assert.equal(typeof display, 'string');
  const suffix = '\n\n' + attribution;
  assert.ok(display.endsWith(suffix), 'display ends with the attribution line: ' + JSON.stringify(display.slice(-60)));
  assert.equal(display.split(attribution).length - 1, 1, 'one attribution line');
  return display.slice(0, -suffix.length);
}

// Every tool result is JSON whose first field is the ready-to-copy display; tests compare the body before the attribution.
function callData(responses, id) {
  const data = JSON.parse(callText(responses, id));
  assert.equal(Object.keys(data)[0], 'display');
  return { ...data, display: body(data.display) };
}

// Errors are JSON with only the display.
function errorText(responses, id) {
  const data = JSON.parse(callText(responses, id, true));
  assert.deepEqual(Object.keys(data), ['display']);
  return body(data.display);
}

test('initializes with the client version, accepts notification and replies to ping', async () => {
  const responses = await exchange([...handshake('2024-11-05'), request('ping', 'ping')]);
  assert.deepEqual(responses.map(({ id }) => id), [1, 'ping']);
  assert.deepEqual(resultOf(responses, 1), {
    protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'domain-hound', title: 'Domain Hound', version: '0.1.1' },
  });
  assert.deepEqual(resultOf(responses, 'ping'), {});
});

test('offers its latest protocol for an unsupported version', async () => {
  const responses = await exchange(handshake('2099-01-01'));
  assert.equal(resultOf(responses, 1).protocolVersion, '2025-11-25');
});

test('advertises the three Domain Hound tools and the legacy alias', async () => {
  const responses = await exchange([...handshake(), request(2, 'tools/list')]);
  const { tools } = resultOf(responses, 2);
  assert.deepEqual(tools.map(tool => tool.name), ['check_domains', 'triage_names', 'naming_method', 'broker_find']);
  const [{ description, inputSchema }, triage, naming, alias] = tools;
  assert.ok(tools.every(tool => tool.description.includes('Domain Hound')));
  for (const tool of [tools[0], alias]) assert.ok(tool.description.includes(showAsIs), tool.name);
  for (const tool of [triage, naming]) {
    for (const instruction of ['google.search', '"<name>" and "<name>" app', 'first 10', 'Google: open',
      'Google: crowded', 'Google: owned by <brand>', 'full reason, traction and dormant notes']) {
      assert.ok(tool.description.includes(instruction), instruction);
    }
  }
  assert.equal(showAsIs, 'Show `display` to the person as is, then add your advice below it.');
  assert.match(naming.description, /final triage display; the recipe and the name batch are intermediate/);
  assert.equal(triage.inputSchema.properties.names.maxItems, 20);
  assert.deepEqual(triage.inputSchema.required, ['names']);
  assert.deepEqual(alias.inputSchema, inputSchema);
  assert.match(description, /Never buys\. For naming help, call naming_method first when generating new names\./);
  assert.match(inputSchema.properties.endings.description, /\.ai.*by default/);
  for (const tool of [tools[0], alias]) assert.match(tool.description, /Returns every option; let the person choose\./);
  for (const field of ['display', 'best', 'names', 'taken', 'resale', 'free', 'shop_check', 'listPrices', 'legend', 'buyUrlTemplate']) {
    assert.ok(description.includes(field), field);
  }
  const { query, names } = inputSchema.properties;
  assert.deepEqual(Object.keys(inputSchema.properties), ['ai', 'endings', 'eligible', 'query', 'names', 'shortlist']);
  assert.deepEqual(inputSchema.properties.eligible.items.enum, ['no']);
  assert.deepEqual(triage.inputSchema.properties.eligible, inputSchema.properties.eligible);
  assert.equal(inputSchema.properties.shortlist.type, 'boolean');
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
  // Both input forms and examples come first, so clients pick the right field.
  assert.match(description, /^Use Domain Hound to check domains\. Two input forms: query .*"oakenroom\.me".*names .*\["oakenroom","quietbook","oakenroom\.me"\]/);
  assert.match(query.description, /^One name or exact domain, e\.g\. "oakenroom\.me"/);
  assert.match(names.description, /^1 to 20 bare names, exact domains or both, e\.g\./);
  assert.match(triage.description, /existing name is safe.*triage_names directly once/);
  assert.match(triage.description, /screen 1 to 20 product names, e\.g\. \{"names"/);
  for (const phrase of ['accounts for every requested name', 'cannot buy domains',
    'call once with query and answer from that result',
    'only when an offer exists', 'Suggest free endings already in that result', 'shopCheckWhy']) {
    assert.ok(description.includes(phrase), phrase);
  }
  for (const phrase of ['verdict and reason exactly', 'every free ending', "today's payment and renewal", 'Do not omit or paraphrase rows',
    'buy (checkout link', 'prices holds']) {
    assert.ok(triage.description.includes(phrase), phrase);
  }
  assert.equal(naming.inputSchema.properties.about.maxLength, 160);
  assert.equal(naming.inputSchema.additionalProperties, false);
});

test('passes a normalized query as a separate argument and returns compact JSON', async () => {
  const responses = await exchange([...handshake(), call(2, { query: 'Example.COM' })]);
  const result = callData(responses, 2);
  assert.deepEqual(Object.keys(result), ['display', 'complete', 'checkedAt', 'best', 'names', 'legend', 'buyUrlTemplate']);
  assert.equal(result.display, [
    '**example.com is free.** Exact quote confirmed by Spaceship. Checked 2026-11-24 12:00 UTC.',
    '',
    '| Domain | Today | Renewal | 3 years | Checkout |',
    '|---|---|---|---|---|',
    '| example.com | $9.48 | $10.68/yr | $30.84 | [example.com](https://www.spaceship.com/domain-search/?query=example.com) at Spaceship |',
    '',
    'USD ex. VAT.',
    neverBuys,
  ].join('\n'));
  assert.equal(result.complete, true);
  assert.equal(result.checkedAt, '2026-11-24T12:00:00.000Z');
  assert.deepEqual(result.names, [{ name: 'example.com',
    free: [{ d: 'com', s: 'ok', now: 9.48, renew: 10.68, y3: 30.84, shop: 'Spaceship' }] }]);
  assert.equal(result.best.domain, 'example.com');
  assert.equal(result.buyUrlTemplate.Spaceship.replace('{domain}', 'example.com'), result.best.buyUrl);
  assert.equal(result.legend.ok, 'Free, confirmed by a shop');
});

test('a taken exact domain shows no price or link and still says Domain Hound never buys', async () => {
  const responses = await exchange([...handshake(), call(2, { query: 'taken.me' })]);
  const result = callData(responses, 2);
  assert.deepEqual(result.names, [{ name: 'taken.me', taken: ['me'] }]);
  assert.ok(result.purchaseAdvice);
  const lines = result.display.split('\n');
  assert.match(lines[0], /^\*\*taken\.me is taken\.\*\* It is already registered\./);
  assert.ok(lines.includes(neverBuys), 'standalone never-buys line');
  assert.doesNotMatch(result.display, /\$|https?:/);
});

test('passes 20 names to one native batch invocation and preserves partial compact results', async () => {
  const names = Array.from({ length: 20 }, (_, i) => `Example-${i}`);
  const responses = await exchange([...handshake(), call(2, { names })]);
  const result = callData(responses, 2);
  // Identical outcomes share one table row that still names every input.
  assert.equal(result.display, [
    '**Domain check, 20 names** (USD ex. VAT, today/renewal; estimates unless ✓ shop-confirmed; list price from 2026-11-24; 2y = two-year payments)',
    '',
    '| Names | Free | Taken | Check at shop |',
    '|---|---|---|---|',
    '| ' + names.map(name => name.toLowerCase()).join(', ') + ' | .com $9.48/$10.68 | — | .so |',
    '',
    'Some checks did not finish in time; check those at a shop.',
  ].join('\n'));
  assert.ok(Buffer.byteLength(callText(responses, 2)) < 8000);
  assert.equal(result.complete, false);
  assert.equal(result.best, undefined);
  assert.equal(result.priceListDate, '2026-11-24');
  assert.deepEqual(result.names, names.map(name => ({
    name: name.toLowerCase(),
    free: [{ d: 'com', s: 'nc', now: 9.48, renew: 10.68, y3: 30.84, shop: 'Spaceship' }],
    shop_check: ['so'],
  })));
});

test('passes bare names and exact domains together in one native batch invocation', async () => {
  const responses = await exchange([...handshake(), call(2, { names: ['Oakenroom', 'oakenroom.me', 'QuietBook.AI'] })]);
  const result = callData(responses, 2);
  assert.deepEqual(result.names.map(row => row.name), ['oakenroom', 'oakenroom.me', 'quietbook.ai']);
  assert.match(result.display, /^\| oakenroom, oakenroom\.me, quietbook\.ai \| \.com \$9\.48\/\$10\.68 \|/m);
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

test('naming_method returns the compact recipe as display with an optional description', async () => {
  const responses = await exchange([...handshake(), call(2, undefined, 'naming_method'), call(3, {}, 'naming_method'),
    call(4, { query: 'not used' }, 'naming_method'), call(5, { about: 'Book trips' }, 'naming_method')]);
  const text = callText(responses, 2);
  assert.equal(callText(responses, 3), text);
  assert.match(errorText(responses, 4), /optional about/);
  assert.match(callData(responses, 5).display, /1\. Brief: Book trips\./);
  const data = JSON.parse(text);
  assert.deepEqual(Object.keys(data), ['display']);
  const recipe = data.display;
  assert.ok(Buffer.byteLength(text) < 800, String(Buffer.byteLength(text)));
  for (const phrase of ['intermediate', 'final triage display', 'about 30', 'familiar animal', 'category-generic',
    'shortlist: true', 'Quiet Otter → quietotter', 'No spaces or dots', 'Follow its Google search instructions',
    'copy the final table', 'Keep every row with all prices and links', 'Never buy.']) {
    assert.ok(recipe.includes(phrase), phrase);
  }
  // Brief, generate, one bare-name batch, triage of the best five only, then the answer.
  const order = ['1. Brief', '2. Generate', '3. Check', 'check_domains ONCE', 'bare names', '4. Triage',
    'triage_names ONCE on only the best FIVE', '5. Answer'].map(phrase => recipe.indexOf(phrase));
  assert.ok(order.every(index => index >= 0), String(order));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
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
  assert.match(message({ query: 'a'.repeat(64) }), /^query "a+" is not valid/);
  assert.match(message({ names: Array(21).fill('a') }), /^names must list 1 to 20 names or domains; it has 21\./);
  assert.match(message({ names: [] }), /1 to 20/);
  assert.match(message({ names: ['a b'] }), /^names\[0\] "a b" is not valid/);
  assert.match(message({ names: [null] }), /^names\[0\] is empty/);
  assert.match(message({ names: ['a.b.com'] }), /^names\[0\] "a\.b\.com" is not valid/);
});

test('reports capability errors as one line and detects malformed output', async () => {
  const responses = await exchange([...handshake(), call(2, { query: 'failed' }), call(3, { query: 'broken-json' })]);
  assert.equal(callText(responses, 2, true), '{"display":"Broker lookup failed.\\n\\nvia domainhound.dev"}');
  assert.equal(errorText(responses, 3), 'Domain Hound returned invalid JSON.');
});

test('terminates a slow child and keeps answering pings during a lookup', async () => {
  const responses = await exchange([...handshake(), call(2, { query: 'slow' }), request(3, 'ping')], { fastTimeout: true });
  assert.deepEqual(responses.map(({ id }) => id), [1, 3, 2]);
  assert.equal(errorText(responses, 2), 'Domain Hound timed out after 15 seconds.');
});

test('returns JSON-RPC errors for malformed requests and unknown methods or tools', async () => {
  const responses = await exchange([request('probe', 'server/discover'), ...handshake(), '{bad', request(2, 'unknown'),
    request(3, 'tools/call', { name: 'unknown' })]);
  assert.equal(responses.find(({ id }) => id === 'probe').error.code, -32601);
  assert.equal(responses.find(({ id }) => id === null).error.code, -32700);
  assert.equal(responses.find(({ id }) => id === 2).error.code, -32601);
  assert.equal(responses.find(({ id }) => id === 3).error.code, -32602);
});

test('forwards triage with twenty-name validation, descriptions and requested endings', async () => {
  const responses = await exchange([...handshake(),
    call(2, { names: ['Example One', 'Example Two'], category: 'Calendar app', endings: ['app', 'ai'], eligible: ['no'] }, 'triage_names'),
    call(3, { names: Array(21).fill('Example') }, 'triage_names'),
    call(4, { names: ['Example, injected'] }, 'triage_names'),
    call(5, { names: ['Example One'], about: 'Book appointments for a clinic' }, 'triage_names'),
    call(6, { names: ['Example One'], about: ' '.repeat(160) }, 'triage_names')]);
  const two = callData(responses, 2);
  assert.deepEqual(Object.keys(two), ['display', 'prices', 'names', 'legend', 'flags']);
  assert.deepEqual(two.names.map(row => row.name), ['Example One', 'Example Two']);
  assert.deepEqual(two.flags, ['--compact', '--eligible', 'no', '--endings', 'app,ai', '--category', 'Calendar app']);
  for (const id of [3, 4]) assert.match(errorText(responses, id), /1 to 20/);
  assert.match(errorText(responses, 3), /^names must list 1 to 20 names; it has 21\.$/);
  assert.match(errorText(responses, 4), /^names\[0\] is not valid/);
  const one = callData(responses, 5);
  assert.deepEqual(one.flags, ['--compact', '--about', 'Book appointments for a clinic']);
  // One name keeps all its evidence.
  assert.deepEqual(one.names[0].notes, ['iOS app: Example One (Example Inc., 12 ratings)']);
  assert.ok(one.names[0].memorable);
  assert.equal(one.display, [
    '**Name screen** (USD ex. VAT; list estimates, the shop shows the final price; 2y = each payment covers two years)',
    '',
    '| Name | Verdict and reason | Free endings, today/renewal, cheapest first | Checkout | Search checks |',
    '|---|---|---|---|---|',
    '| Example One | Check first: An exact-name app already exists \\| see \\[x\\](https:\\/\\/example.com) | '
      + '.co $3.11/$31.05, .app $8.28/$14.49, .ai $160.02/$160.02 2y, check at shop: .dev | '
      + '[exampleone.co](https://www.spaceship.com/domain-search/?query=exampleone.co) | '
      + 'Google: not checked · [search](https://www.google.com/search?q=%22Example+One%22)<br>'
      + 'App Store (iOS): not checked · [search](https://apps.apple.com/us/iphone/search?term=Example+One)<br>'
      + 'Google Play (Android): not checked · [search](https://play.google.com/store/search?q=Example+One&c=apps&hl=en&gl=US) |',
    '',
    'Choose a favorite, if you want, and ask for its exact quote.',
  ].join('\n'));
  assert.match(errorText(responses, 6), /product description/);
});

test('keeps both payments in the preliminary batch and flags an earlier estimate when triage is unresolved', async () => {
  const responses = await exchange([...handshake(),
    call(2, { names: ['ExampleOne'], shortlist: true }),
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
  assert.ok(size(recipe) + size(batch) + size(triage) < 8000, [size(recipe), size(batch), size(triage)].join(' + '));
  assert.ok(size(triage) < 6000);
  assert.ok(size(triageText(triagePayload(ten))) < 10_000);
  assert.ok(size(checkText(batchPayload(twenty, 8))) < 8000);
  assert.ok(size(checkText(batchPayload(twenty))) < 8000);
  // Trimming keeps the fields the grader and clients read.
  const shortlist = JSON.parse(triage);
  assert.deepEqual(Object.keys(shortlist), ['display', 'prices', 'names', 'legend']);
  assert.equal(shortlist.names[1].own.me.now, 2.5);
  assert.match(shortlist.display, /Cheapest eligible \/ checkout/);
  assert.match(shortlist.display, /\[hushroom\.me\]\(https:\/\/www\.spaceship\.com\/domain-search\/\?query=hushroom\.me\) \$2\.50\/\$20\.00/);
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

test('renders the triage shortlist as one priced, linked row per candidate', () => {
  const display = body(JSON.parse(triageText(triagePayload(five))).display);
  const lines = display.split('\n');
  assert.equal(lines[2], '| Name | Verdict and reason | Free endings, today/renewal, cheapest first | Checkout | Search checks |');
  const rows = lines.filter(line => /^\| (?!Name|---)/.test(line));
  assert.deepEqual(rows.map(line => line.split(' | ')[0].slice(2)), five);
  assert.ok(rows[1].startsWith('| Hush Room | Check first: Several public sources show same-name use | .me $2.50/$20.00, .co $3.11/$31.05, '
    + '.dev $7.24/$13.45, .app $8.28/$14.49, .si $12.50/$12.50, .no $13.90/$13.90, .so $24.99/$49.99, check at shop: .so | '
    + '[hushroom.me](https://www.spaceship.com/domain-search/?query=hushroom.me) |'));
  for (const row of rows) {
    assert.match(row, /Google: not checked · .*google\.com\/search\?q=/);
    assert.match(row, /App Store \(iOS\): not checked · .*apps\.apple\.com\/us\/iphone\/search\?term=/);
    assert.match(row, /Google Play \(Android\): not checked · .*play\.google\.com\/store\/search\?q=/);
  }
  assert.match(rows[2], /\.ai \$160\.02\/\$160\.02 2y \|/);
  assert.match(lines.at(-1), /^Choose .*if you want/);
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

test('puts ranked picks first and shows all sources for twenty names', async () => {
  const names = Array.from({ length: 20 }, (_, index) => 'Candidate ' + index);
  const responses = await exchange([...handshake(), call(2, { names }, 'triage_names')]);
  const forwarded = callData(responses, 2);
  assert.deepEqual(forwarded.names.map(row => row.name), names);
  assert.ok(size(callText(responses, 2)) < 12_000, String(size(callText(responses, 2))));
  const sample = triagePayload(twenty);
  sample.top = [{ name: twenty[1], verdict: 'Check first', reason: reasons[1], domain: twenty[1] + '.co', ending: 'co', now: 3.11, renew: 31.05 }];
  const text = triageText(sample);
  assert.ok(size(text) < 12_000, String(size(text)));
  const result = JSON.parse(text);
  assert.equal(Object.keys(result)[0], 'top');
  assert.match(result.display, /^\*\*Top picks\*\*\n- .*Check first.*\$3\.11\/\$31\.05/);
  assert.equal(result.names.length, 20);
  for (const host of ['www.google.com/search', 'apps.apple.com/us/iphone/search', 'play.google.com/store/search']) {
    assert.equal(result.display.split(host).length - 1, 20, host);
  }
});

test('shows best value beside the cheapest offer in the top picks and name row', () => {
  const sample = triagePayload(['Quiet Otter']);
  sample.names[0].bestValue = 'dev';
  sample.top = [{ name: 'Quiet Otter', verdict: 'Check first', domain: 'quietotter.co', ending: 'co', now: 3.11,
    renew: 31.05, bestValue: { domain: 'quietotter.dev', now: 7.24, renew: 13.45, term: 1 } }];
  const { display } = JSON.parse(triageText(sample));
  assert.match(display, /quietotter\.co \$3\.11\/\$31\.05.*\n  Best value: quietotter\.dev \$7\.24 now, \$13\.45 renewal/);
  assert.match(display, /^\| Quiet Otter .*<br>Best value: quietotter\.dev \$7\.24 now, \$13\.45 renewal \|/m);
});

test('fits a fully priced twenty-name batch with maximum-length labels and multibyte owners', async t => {
  const labels = Array.from({ length: 20 }, (_, index) => 'example' + String(index).padStart(2, '0') + 'a'.repeat(54));
  const folder = await mkdtemp(join(tmpdir(), 'hound-priced-triage-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const directory = pathToFileURL(folder + '/');
  const now = new Date('2026-11-24T12:00:00Z');
  const checkedAt = now.toISOString();
  const prices = Object.fromEntries(['com', 'ai', 'io', 'me', 'co', 'dev', 'app', 'si', 'so', 'no'].map((tld, index) => [tld, {
    shop: 'Dynadot', firstYear: tld === 'co' ? 3.11 : 6 + index, renewal: tld === 'co' ? 31.05 : 10 + index,
  }]));
  await writeCache(directory, 'prices.json', { checkedAt, catalogs: { dynadot: { checkedAt, prices } } });
  const options = {
    directory, now, cachedOnly: true, budgetMs: 2500, compact: true, resolveNs: async () => [],
    queryWhois: async () => null, launch: async () => { throw Error('Fixture has no browser'); },
    fetcher: async (value, init) => {
      const url = new URL(value);
      if (url.hostname === 'data.iana.org') return Response.json({ services: [[Object.keys(prices), ['https://rdap.example.test/']]] });
      if (url.hostname === 'tmsearch.uspto.gov') {
        const key = JSON.parse(init.body).query.bool.must[0].bool.should[0].match_phrase.wordmark.query;
        return Response.json({ hits: { hits: [{ source: {
          alive: true, wordmark: key.slice(0, -1) + 'e', ownerName: ['株式会社'.repeat(18)],
          internationalClass: Array.from({ length: 10 }, (_, index) => 'IC 0' + (index + 30)),
        } }] } });
      }
      if (url.hostname === 'itunes.apple.com') return Response.json({ results: [] });
      if (url.hostname === 'www.wikidata.org') return Response.json({ search: [] });
      if (url.hostname === 'data.brreg.no') return Response.json({ page: { totalPages: 0 } });
      return new Response(null, { status: 404 });
    },
  };
  const report = await triageNames(labels, options);
  assert.deepEqual(report.names.map(row => row.name), labels);
  for (const row of report.names) {
    assert.match(row.reason, /^Near-identical: ex.*030\/031/);
    assert.equal(row.free.length, 10);
    assert.equal(row.free[0], 'co');
    assert.equal(row.bestValue, 'com');
  }
  assert.ok(size(JSON.stringify(report)) < 13_000, String(size(JSON.stringify(report))));
  const text = triageText(report);
  assert.ok(size(text) < 21_000, String(size(text)));
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed)[0], 'top');
  assert.ok(parsed.display.includes('Best value: ' + labels[0] + '.com $6.00 now, $10.00 renewal'));
  assert.deepEqual(parsed.names.map(row => row.name), labels);
  assert.ok(parsed.names.every(row => typeof row.google.link === 'string' && Array.isArray(row.free)));
  for (const host of ['www.google.com/search', 'apps.apple.com/us/iphone/search', 'play.google.com/store/search']) {
    assert.equal(parsed.display.split(host).length - 1, 20, host);
  }
});

test('shares prices and preserves the three source lines in dense triage', () => {
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
    if (count === 5) assert.match(display, /Standard today\/renewal: .*\.ai \$160\.02\/\$160\.02 2y/);
    for (const row of names.slice(0, count)) assert.ok(display.includes(row.name));
    for (const host of ['www.google.com/search', 'apps.apple.com/us/iphone/search', 'play.google.com/store/search']) {
      assert.equal(display.split(host).length - 1, count, host);
    }
  }
});

test('renders a batch with shared prices, grouped outcomes and one confirmed link', () => {
  const display = body(JSON.parse(checkText(batchPayload(twenty, 8))).display);
  const lines = display.split('\n');
  assert.equal(lines[1], 'Standard prices: .me $2.99/$19.99 · .co $3.11/$31.05 · .dev $7.24/$13.45 · .app $8.28/$14.49 · .si $12.50/$12.50 · '
    + '.no $13.90/$13.90 · .so $24.99/$49.99 · .ai $160.02/$160.02 2y');
  assert.ok(lines.includes('| ' + twenty.slice(0, 8).join(', ') + ' | — | .me .co .dev .app .com .si .no .so .io .ai | — |'));
  for (const name of twenty) assert.ok(display.includes(name), name);
  assert.match(display, /\| \.me \.co \$3\.11\/\$31\.05 ✓ \.dev/);
  assert.equal((display.match(/https:/g) ?? []).length, 1);
  assert.ok(lines.includes('Confirmed: [examplesolace19.co](https://www.spaceship.com/domain-search/?query=examplesolace19.co) $3.11/$31.05 at Spaceship.'));
  assert.equal(lines.at(-1), neverBuys);
});

test('escapes untrusted text and links only to known HTTPS registrars for that domain', () => {
  assert.equal(md('A|B *x* [y](javascript:z) <b> www.evil.test https://evil.test\n#'),
    'A\\|B \\*x\\* \\[y\\](javascript:z) \\<b\\> www\\.evil.test https:\\/\\/evil.test #');
  const good = 'https://www.spaceship.com/domain-search/?query=quietotter.co';
  assert.equal(safeLink(good, 'quietotter.co'), '[quietotter.co](' + good + ')');
  for (const url of ['http://www.spaceship.com/domain-search/?query=quietotter.co', 'https://evil.test/?query=quietotter.co',
    'https://user:pw@www.spaceship.com/?query=quietotter.co', 'https://www.spaceship.com/domain-search/?query=other.co', 'javascript:alert(1)', 42]) {
    assert.equal(safeLink(url, 'quietotter.co'), null, String(url));
  }
  const payload = triagePayload(['Quiet Otter']);
  payload.names[0].buy = 'https://evil.test/?q=quietotter.me';
  payload.names[0].name = 'Quiet | Otter';
  const { display } = JSON.parse(triageText(payload));
  assert.doesNotMatch(display, /evil/);
  assert.match(display, /^\| Quiet \\\| Otter \| Avoid: .* \| — \| Google:/m);
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
  assert.match(triage.description, /David vs Goliath/);
  assert.match(triage.description, /small or dormant same-name uses are notes/);
  assert.match(triage.description, /Fill geo for every name from your own memory/);
  const pattern = new RegExp(geo.additionalProperties.pattern);
  for (const value of ['known: notes app', 'Known (notes app)', 'unknown']) assert.ok(pattern.test(value), value);
  for (const value of ['known', 'maybe', 'unknown brand']) assert.ok(!pattern.test(value), value);
  const flags = callData(responses, 3).flags;
  assert.deepEqual(flags.slice(0, 2), ['--compact', '--geo']);
  assert.deepEqual(JSON.parse(flags[2]), { notion: 'known: all-in-one notes workspace', RouteMender: 'unknown' });
  for (const id of [4, 6, 7]) assert.match(errorText(responses, id), /geo must map each name to "known: <what it is>" or "unknown"/);
  assert.match(errorText(responses, 5), /geo names "Asana", which is not in names/);
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
  // The naming recipe stays a compact intermediate step.
  assert.ok(size(callText(responses, 6)) < 800, String(size(callText(responses, 6))));
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
  for (const text of texts) {
    const { display } = JSON.parse(text);
    assert.equal(attributionCount(display), 1, display.slice(-80));
    assert.ok(display.endsWith('\n\n' + attribution));
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
  assert.match(lines[0], /^\*\*quietotter\.me is free\.\*\* The registry shows it free; prices are list estimates until checkout\./);
  assert.ok(lines.includes('| quietotter.me | $2.99 | $19.99/yr | $42.97 | '
    + '[quietotter.me](https://www.spaceship.com/domain-search/?query=quietotter.me) at Spaceship |'), display);
  assert.ok(lines.includes('Check at shop: [quietotter.me](https://www.spaceship.com/domain-search/?query=quietotter.me). '
    + 'Live shop check unavailable (Playwright is not installed). Any prices shown are list estimates.'), display);
  assert.ok(lines.includes('USD ex. VAT. Estimate: the shop shows the final price.'));
  assert.doesNotMatch(display, /confirmed by|^Confirmed:|✓(?! shop-confirmed)/m);
  assert.equal(lines.at(-1), neverBuys);

  // An unsettled registry row keeps its single shop link and only adds why no live price exists.
  const unsettled = { ...exactLive, names: [{ name: 'quietotter.me', shop_check: ['me'] }],
    shopCheckWhy: { me: 'Registry did not answer in time' } };
  const pending = body(JSON.parse(checkText(unsettled)).display);
  assert.match(pending, /^\*\*quietotter\.me: not settled\.\*\* .*Check at shop: \[quietotter\.me\]\(https:\/\/www\.spaceship\.com\/domain-search\/\?query=quietotter\.me\)\. No price yet\./);
  assert.match(pending, /\nLive shop check unavailable \(Playwright is not installed\)\. Any prices shown are list estimates\.\n/);
  assert.equal(pending.split('](https://').length - 1, 1);

  // A taken domain stays taken; the fallback never adds a link or price.
  const taken = { ...exactLive, names: [{ name: 'quietotter.me', taken: ['me'] }] };
  const shownTaken = body(JSON.parse(checkText(taken)).display);
  assert.match(shownTaken, /^\*\*quietotter\.me is taken\.\*\* It is already registered\./);
  assert.doesNotMatch(shownTaken, /\$|https?:|Live shop check/);

  // A batch keeps the shared list prices and taken rows, and links the candidate to check at the shop.
  const batch = batchPayload(seven);
  delete batch.best;
  batch.names = batch.names.map(row => ({ ...row, free: row.free.map(({ d }) => ({ d, s: 'nc' })) }));
  batch.liveCheck = { domain: 'quietotter.me', status: 'check-at-shop', reason: 'Playwright is not installed',
    checkUrl: 'https://www.spaceship.com/domain-search/?query=quietotter.me' };
  const text = checkText(batch);
  const shown = body(JSON.parse(text).display);
  assert.match(shown, /^Standard prices: \.me \$2\.99\/\$19\.99/m);
  assert.match(shown, /\| \.com \.io \|/);
  assert.ok(shown.endsWith('Check at shop: [quietotter.me](https://www.spaceship.com/domain-search/?query=quietotter.me). '
    + 'Live shop check unavailable (Playwright is not installed). Any prices shown are list estimates.\n' + neverBuys), shown);
  assert.doesNotMatch(shown, /^Confirmed:|✓(?! shop-confirmed)/m);
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
  assert.ok((await stat(bin)).mode & 0o111, 'bin is executable');
  assert.match(await readFile(bin, 'utf8'), /^#!\/usr\/bin\/env node\n/);
  const { capabilityDir } = await import('./server.mjs');
  assert.equal(capabilityDir, fileURLToPath(new URL('./clis/domain-check/', import.meta.url)));
  assert.ok((await stat(join(capabilityDir, 'index.mjs'))).isFile());
  const elsewhere = await mkdtemp(join(tmpdir(), 'hound-cwd-'));
  try {
    for (const entry of [bin, server]) {
      const responses = await runServer([fileURLToPath(entry)],
        [...handshake(), request(2, 'tools/list'), call(3, {}, 'naming_method')], {}, elsewhere);
      assert.deepEqual(resultOf(responses, 1).serverInfo, { name: 'domain-hound', title: 'Domain Hound', version: '0.1.1' });
      assert.deepEqual(resultOf(responses, 2).tools.map(tool => tool.name), ['check_domains', 'triage_names', 'naming_method', 'broker_find']);
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
