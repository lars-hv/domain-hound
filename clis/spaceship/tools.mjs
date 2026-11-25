import { attributed } from '../../display.mjs';
import { buyDomain, directPurchaseEnabled, issueQuote, setupOffer, spaceshipMcp, verifyRegistration } from './buy.mjs';
import { missingKeyText, SpaceshipError, spaceshipClient, spaceshipCredentials } from './client.mjs';
import { mailProviders, websiteProviders } from './dns.mjs';
import { exactDomain, offerLine, quoteTimes } from './quote.mjs';
import { applySetup, previewSetup } from './setup.mjs';
import { purchaseDir, stateStore } from './store.mjs';

// The three tools that act in the person's own Spaceship account. server.mjs only registers and dispatches them.
const domainField = { type: 'string', minLength: 3, maxLength: 253, description: 'The exact domain, like example.com.' };

export const quoteTool = {
  name: 'quote_domain',
  description: 'Get an exact live price for one domain from the person’s own Spaceship account: registration term (.ai is two years), '
    + 'upfront and renewal amounts, premium status and fresh registry availability. Returns a quote ID that expires in 10 minutes. '
    + 'Show the person the exact quote. Relay the display as written.',
  annotations: { title: 'Quote a domain at Spaceship', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: { type: 'object', properties: {
    domain: domainField,
    years: { type: 'integer', minimum: 1, maximum: 10, description: 'Optional term in years. Omit for the shortest term Spaceship offers.' },
  }, required: ['domain'], additionalProperties: false },
};

export const buyTool = {
  name: 'buy_domain',
  description: 'COSTS MONEY: buys a domain in the person’s own Spaceship account. Needs an unexpired quote_id from quote_domain and '
    + 'max_usd, the most the person agreed to pay. It refuses a quote above the max or server cap (DOMAIN_HOUND_MAX_USD, default $30), '
    + 'or any change on a fresh price check. In direct mode Spaceship sets the actual charge. By default it orders nothing and returns '
    + 'a handoff: preview with Spaceship’s own MCP tool ' + spaceshipMcp.tool + ', check '
    + 'the preview against the listed price ceilings, and accept only after the person approves that exact confirmation; follow it step '
    + 'by step, and stop if the price or payment method cannot be seen or the result is unclear. It also gives the command to connect '
    + 'Spaceship’s MCP. Only when the person set DOMAIN_HOUND_DIRECT_PURCHASE=1 in the server settings does it order directly: a '
    + 'standard-price domain for the registry minimum term (one year; two for .ai), with confirm: true after the person saw the exact '
    + 'quote and said yes; without confirm it is a dry run. Never retry an unclear order by any path. Spaceship checkout is the last '
    + 'resort, only after a valid quote when nothing was submitted. After a purchase, call setup_domain with verify: true, and offer '
    + 'DNS setup only after it verifies. Relay the display as written.',
  annotations: { title: 'Buy a domain (costs money)', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema: { type: 'object', properties: {
    domain: domainField,
    quote_id: { type: 'string', maxLength: 40, description: 'The quote ID from quote_domain.' },
    max_usd: { type: 'number', exclusiveMinimum: 0, maximum: 100000, description: 'The most the person agreed to pay upfront, in USD.' },
    confirm: { type: 'boolean', description: 'True only after the person saw the exact quote and said yes. Otherwise omit for a dry run.' },
  }, required: ['domain', 'quote_id', 'max_usd'], additionalProperties: false },
};

const hostField = description => ({ type: 'string', maxLength: 253, description });
export const setupTool = {
  name: 'setup_domain',
  description: 'Changes DNS: sets website and mail records for a domain in the person’s own Spaceship account. First call without plan_id '
    + 'to preview every exact change; nothing is written. Then, after the person says yes, call with plan_id and apply: true. '
    + 'Removing existing records also needs replace: true. Only provider values the person copied from their provider. '
    + 'With only verify: true it writes nothing: it looks the domain up at the registry and in the person’s Spaceship account to '
    + 'confirm a purchase. '
    + 'Use it after any purchase, through Spaceship’s MCP or checkout, before DNS setup. Relay the display as written.',
  annotations: { title: 'Set up domain DNS (changes DNS)', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema: { type: 'object', properties: {
    domain: domainField,
    website: { type: 'object', additionalProperties: false, required: ['provider'], properties: {
      provider: { type: 'string', enum: websiteProviders },
      target: hostField('GitHub Pages user.github.io, Netlify site.netlify.app, Cloudflare Pages project.pages.dev, or a CNAME target.'),
      ipv4: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 15 }, description: 'For ip, or the exact apex IP from Vercel.' },
      ipv6: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 45 }, description: 'For ip only.' },
      www_target: hostField('Vercel only: the unique www CNAME from the project’s Domains page.'),
    } },
    mail: { type: 'object', additionalProperties: false, required: ['provider'], properties: {
      provider: { type: 'string', enum: mailProviders },
      mx: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object', additionalProperties: false, required: ['exchange', 'preference'],
        properties: { exchange: { type: 'string', maxLength: 253 }, preference: { type: 'integer', minimum: 0, maximum: 65535 } } },
      description: 'Provider-supplied MX: required for microsoft-365 (tenant MX) and forward-only; optional custom values for icloud.' },
      records: { type: 'array', maxItems: 10, items: { type: 'object', additionalProperties: false, required: ['type', 'name', 'value'],
        properties: { type: { type: 'string', enum: ['TXT', 'CNAME'] }, name: { type: 'string', maxLength: 190 }, value: { type: 'string', maxLength: 2048 } } },
      description: 'Verification and DKIM records exactly as the mail provider lists them. Never make them up.' },
      dmarc: { type: 'string', enum: ['none', 'quarantine', 'reject'], description: 'Only when the person picks a DMARC policy. Otherwise a valid existing policy stays.' },
    } },
    plan_id: { type: 'string', maxLength: 40, description: 'The plan ID from the preview.' },
    apply: { type: 'boolean', description: 'True only with plan_id, after the person approved the previewed changes.' },
    replace: { type: 'boolean', description: 'True only when the person agreed to remove the existing records the plan lists.' },
    verify: { type: 'boolean', description: 'True, alone with domain, to check a purchase at the registry and in the person’s account. Writes nothing.' },
  }, required: ['domain'], additionalProperties: false },
};

export const purchaseTools = [quoteTool, buyTool, setupTool];
export const purchaseToolNames = new Set(purchaseTools.map(tool => tool.name));

// Replace stale global claims in the check tools with the handoff, whatever the rest of their wording says.
const handoffSentence = 'To buy through the person’s own Spaceship account, use quote_domain, then buy_domain.';
export function currentDescription(text, handoff = true) {
  const updated = String(text)
    .replace(/Domain Hound cannot buy or complete checkout/g, 'This check leaves checkout to you')
    .replace(/\bNever buys\./g, 'This check leaves checkout to you.')
    .replace(/Domain Hound never buys/gi, 'This check leaves checkout to you')
    .replace(/\b(?:cannot|can't|never) buys?\b/gi, 'leaves checkout to you');
  return !handoff || updated.includes(handoffSentence) ? updated : updated.trimEnd() + ' ' + handoffSentence;
}

// The legacy alias stays short, so only check_domains carries the handoff sentence.
export function registeredTools(tools) {
  const updated = tools.map(tool => tool.name === 'check_domains' || tool.name === 'broker_find'
    ? { ...tool, description: currentDescription(tool.description, tool.name === 'check_domains') } : tool);
  return [...updated, ...purchaseTools.filter(tool => !updated.some(other => other.name === tool.name))];
}

// One line that offers the exact quote when a checked or watched domain is free.
export const quoteOfferLine = domain => 'Want the exact price from your own Spaceship account? Ask to quote ' + domain + '.';

export function withWatchQuoteOffer(result) {
  if (result?.status !== 'free' || typeof result.say !== 'string' || !result.domain) return result;
  return { ...result, say: result.say + '\n' + quoteOfferLine(result.domain), quoteOffer: true };
}

// An exact check whose domain is free: insert the offer above the results page link.
export function withCheckQuoteOffer(page, args) {
  const query = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : '';
  const [row, ...rest] = Array.isArray(page?.names) ? page.names : [];
  const domain = exactDomain(query);
  if (!domain || rest.length || !row || exactDomain(row.name) !== domain || !row.free?.length || row.taken?.length) return page;
  const insert = text => {
    if (typeof text !== 'string' || text.includes(quoteOfferLine(domain))) return text;
    const lines = text.split('\n');
    const at = lines.findIndex(line => line.startsWith('All endings: '));
    lines.splice(at < 0 ? lines.length : at, 0, quoteOfferLine(domain));
    return lines.join('\n');
  };
  return { ...page, display: insert(page.display), say: insert(page.say), quoteOffer: true };
}

const result = (say, data = {}, isError = false) => {
  const display = attributed(say);
  return { content: [{ type: 'text', text: display }], structuredContent: { display, ...data }, isError };
};

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function checkInput(tool, args) {
  if (!isObject(args)) throw Error('Supply an object with domain.');
  const properties = tool.inputSchema.properties;
  const extra = Object.keys(args).find(key => !Object.hasOwn(properties, key));
  if (extra) throw Error(tool.name + ' does not take ' + JSON.stringify(extra.slice(0, 40)) + '.');
  const domain = exactDomain(args.domain);
  if (!domain) throw Error('Give one exact domain, such as example.com.');
  for (const flag of ['confirm', 'apply', 'replace', 'verify']) {
    if (Object.hasOwn(args, flag) && typeof args[flag] !== 'boolean') throw Error(flag + ' must be true or false.');
  }
  return domain;
}

// Production dependencies: credentials from the environment or Keychain and the live REST client, which sends a registration
// only when the server environment sets DOMAIN_HOUND_DIRECT_PURCHASE=1. Tests pass a client factory for the local mock.
// The purchase folder comes from the same env and is resolved here, once.
export function purchaseHandlers({ env = process.env, credentials = () => spaceshipCredentials({ env }),
  clientFor = keys => spaceshipClient({ ...keys, env }), store = stateStore(purchaseDir(env)), registry, now = () => new Date(),
  sleep } = {}) {
  async function client() {
    const keys = await credentials();
    return keys ? clientFor(keys) : null;
  }

  async function quote(args) {
    const domain = checkInput(quoteTool, args);
    if (args.years !== undefined && (!Number.isInteger(args.years) || args.years < 1 || args.years > 10)) {
      throw Error('years must be a whole number from 1 to 10.');
    }
    const api = await client();
    if (!api) return result(missingKeyText('quote'), { domain, quote: null });
    const { offer, quote: issued } = await issueQuote(domain, { client: api, store, registry, years: args.years, now: now() });
    if (!issued) {
      return result(domain + ': no quote. ' + offer.reason, { domain, status: offer.status, quote: null });
    }
    return result([offerLine(issued), quoteTimes(issued) + ' Quote ID ' + issued.id + '.',
      directPurchaseEnabled(env) ? 'To buy: show the person this quote and explain that the direct order’s actual charge may differ. '
        + 'After their yes, call buy_domain with quote_id, max_usd and confirm: true.' : 'To buy: show the person this exact quote, '
        + 'then call buy_domain with quote_id and max_usd. It re-checks '
        + 'the price and hands off to Spaceship’s own MCP (' + spaceshipMcp.tool + ') with the price ceilings.'].join('\n'),
    { domain, status: 'available', quote: { ...issued, amountUsd: issued.amount / 100, renewalUsd: issued.renewal.amount / 100 } });
  }

  async function buy(args) {
    const domain = checkInput(buyTool, args);
    if (typeof args.quote_id !== 'string' || !args.quote_id) throw Error('Give the quote_id from quote_domain.');
    if (typeof args.max_usd !== 'number' || !Number.isFinite(args.max_usd) || args.max_usd <= 0 || args.max_usd > 100_000) {
      throw Error('Give max_usd, the most the person agreed to pay in USD.');
    }
    // The earlier-order, quote, max and cap checks need no network. The re-quote needs the key. A missing key never offers
    // checkout: no valid live quote exists to check it against.
    let apiPromise;
    const live = async () => {
      const api = await (apiPromise ??= client());
      if (!api) throw new SpaceshipError(missingKeyText(directPurchaseEnabled(env) ? 'direct' : 'buy'));
      return api;
    };
    const lazyClient = Object.fromEntries(['available', 'pricing', 'info', 'createDomain', 'operation']
      .map(method => [method, async (...rest) => (await live())[method](...rest)]));
    const outcome = await buyDomain({ domain, quote_id: args.quote_id, max_usd: args.max_usd, confirm: args.confirm === true },
      { client: lazyClient, accountBinding: async () => (await live()).accountBinding, store, registry, env, now,
        ...(sleep && { sleep }) });
    const { say, ...data } = outcome;
    return result(say, { domain, ...data });
  }

  // Read-only: the registry lists the domain as registered and the person's own Spaceship account holds it.
  async function verify(domain) {
    const api = await client();
    if (!api) return result(missingKeyText('quote'), { domain, verified: false });
    const { registered, checks, info, registryStatus, accountKnown } = await verifyRegistration(domain, { client: api, registry });
    const data = { domain, verified: registered, checks };
    if (registered) {
      const settings = [checks.privacyHigh ? 'Privacy high' : 'Privacy not high', checks.autoRenew ? 'auto renew on' : 'auto renew off'];
      const custom = info?.nameservers?.provider && info.nameservers.provider !== 'basic';
      return result([domain + ' is yours: registered at the registry and in your Spaceship account. ' + settings.join(', ') + '.',
        custom ? 'It uses custom nameservers, so set DNS records where your DNS is hosted.' : setupOffer(domain)].join('\n'), data);
    }
    const lines = [domain + ' is not verified yet. Do not count it as bought.'];
    if (!accountKnown) lines.push('Spaceship did not answer for your account. Try again in a minute.');
    else if (!checks.account) lines.push('It is not in this Spaceship account.');
    if (registryStatus !== 'taken') lines.push('The registry ' + (registryStatus === 'free' ? 'still lists it as free.' : 'did not answer.'));
    else if (accountKnown && !checks.account) lines.push('The registry lists it as registered, possibly to someone else.');
    lines.push('Check orders in your Spaceship account. Do not order it again until you have.');
    return result(lines.join('\n'), data);
  }

  async function setup(args) {
    const domain = checkInput(setupTool, args);
    if (Object.hasOwn(args, 'verify')) {
      if (args.verify !== true || Object.keys(args).some(key => key !== 'domain' && key !== 'verify')) {
        throw Error('verify takes only domain and verify: true.');
      }
      return verify(domain);
    }
    if (Object.hasOwn(args, 'plan_id')) {
      if (args.website || args.mail) throw Error('With plan_id, pass only domain, apply and replace.');
      if (args.apply !== true) throw Error('Pass apply: true with plan_id, after the person approved the preview.');
      const api = await client();
      if (!api) return result(missingKeyText('setup'), { domain });
      const { say, ...data } = await applySetup(domain, { planId: args.plan_id, replace: args.replace === true }, { client: api, store, now });
      return result(say, { domain, ...data });
    }
    if (args.apply || args.replace) throw Error('Preview first. apply and replace need the plan_id from the preview.');
    for (const part of ['website', 'mail']) {
      if (args[part] === undefined) continue;
      const known = setupTool.inputSchema.properties[part].properties;
      if (!isObject(args[part]) || Object.keys(args[part]).some(key => !Object.hasOwn(known, key))) {
        throw Error(part + ' takes only: ' + Object.keys(known).join(', ') + '.');
      }
    }
    const api = await client();
    if (!api) return result(missingKeyText('setup'), { domain });
    const { say, ...data } = await previewSetup(domain, { website: args.website, mail: args.mail }, { client: api, store, now: now() });
    return result(say, { domain, ...data });
  }

  const handlers = { quote_domain: quote, buy_domain: buy, setup_domain: setup };
  return async function call(name, args) {
    try {
      return await handlers[name](args);
    } catch (problem) {
      return result(problem instanceof Error ? problem.message : 'Domain Hound could not finish.', {}, true);
    }
  };
}

// The server's purchase folder is fixed when the server starts (this module loads), so a later change of working directory
// cannot move the claims.
const startupStore = stateStore(purchaseDir());
let production;
export const callPurchaseTool = (name, args) => (production ??= purchaseHandlers({ store: startupStore }))(name, args);
