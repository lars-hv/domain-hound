import { attributed } from '../../display.mjs';
import { buyDomain, directPurchaseEnabled, issueQuote, setupOffer, spaceshipMcp, verifyRegistration } from './buy.mjs';
import { missingKeyText, SpaceshipError, spaceshipClient, spaceshipCredentials } from './client.mjs';
import { mailProviders, websiteProviders } from './dns.mjs';
import { exactDomain, offerLine, quoteTimes } from './quote.mjs';
import { applySetup, previewSetup } from './setup.mjs';
import { purchaseDir, stateStore } from './store.mjs';
import { issueTransferQuote, transferDomain, transferOfferLine, transferStatus } from './transfer.mjs';
import { loadCatalog } from '../portfolio/checks.mjs';
import { planFromFacts, planLines, transferRegistryRecord } from '../portfolio/move.mjs';

// The three tools that act in the person's own Spaceship account. server.mjs only registers and dispatches them.
const domainField = { type: 'string', minLength: 3, maxLength: 253, description: 'The exact domain, like example.com.' };

export const quoteTool = {
  name: 'quote_domain',
  description: 'Get a live Spaceship quote with the term, upfront and renewal prices, premium status and registry availability. '
    + 'Show the exact quote, which expires in 10 minutes. Relay the display as written.',
  annotations: { title: 'Quote a domain at Spaceship', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: { type: 'object', properties: {
    domain: domainField,
    years: { type: 'integer', minimum: 1, maximum: 10, description: 'Optional term in years. Omit for the shortest term Spaceship offers.' },
  }, required: ['domain'], additionalProperties: false },
};

export const buyTool = {
  name: 'buy_domain',
  description: 'COSTS MONEY: needs an unexpired quote_id and agreed max_usd. Stop on price changes or above either limit. '
    + 'Preview with Spaceship’s ' + spaceshipMcp.tool + ' by default. Check the quote and limits, stop if price or payment method is missing, '
    + 'and accept the full confirmation only after showing it and getting approval. Direct orders need opt-in, a standard-price minimum term '
    + 'and approved confirm: true. Spaceship sets the charge. Checkout requires a valid quote and no submitted order. '
    + 'Never retry an unclear order. Verify with setup_domain (verify: true) before offering DNS setup. Relay the display as written.',
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
  description: 'Changes DNS at Spaceship. Preview website and mail changes without plan_id. Apply with plan_id and apply: true after approval. '
    + 'Record removal also needs replace: true. Use provider-supplied values. '
    + 'With only verify: true it writes nothing: it looks the domain up at the registry and in the Spaceship account. '
    + 'Verify after a purchase and before DNS setup. Relay the display as written.',
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

export const moveTool = {
  name: 'move_domain',
  description: 'Plan a transfer for an owned domain. Compare three-year costs, check locks and expiry, and get registrar steps. '
    + 'A Spaceship key adds a 10-minute quote. COSTS MONEY with quote_id and max_usd: rechecks the quote and opens a path to checkout. '
    + 'Direct transfer requires server opt-in, approval, confirm: true and the private auth_code. Keep the code private and never retry an unclear transfer. '
    + 'Use status: true to follow a transfer. Relay the display as written.',
  annotations: { title: 'Move a domain (plan; transfer costs money)', readOnlyHint: false, destructiveHint: true, idempotentHint: false,
    openWorldHint: true },
  inputSchema: { type: 'object', properties: {
    domain: domainField,
    quote_id: { type: 'string', maxLength: 40, description: 'The transfer quote ID from the plan.' },
    max_usd: { type: 'number', exclusiveMinimum: 0, maximum: 100000, description: 'The most the person agreed to pay for the transfer, in USD.' },
    confirm: { type: 'boolean', description: 'Direct transfers only: true after the person saw the dry run and said yes.' },
    auth_code: { type: 'string', minLength: 1, maxLength: 50, description: 'Direct transfers only, with confirm: true. Pass the code from '
      + 'the person’s private input. Keep it out of chat, logs and results.' },
    status: { type: 'boolean', description: 'True, alone with domain, to follow a transfer into the person’s Spaceship account.' },
  }, required: ['domain'], additionalProperties: false },
};

export const purchaseTools = [quoteTool, buyTool, setupTool, moveTool];
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
  for (const flag of ['confirm', 'apply', 'replace', 'verify', 'status']) {
    if (Object.hasOwn(args, flag) && typeof args[flag] !== 'boolean') throw Error(flag + ' must be true or false.');
  }
  return domain;
}

// Production dependencies: credentials from the environment or Keychain and the live REST client, which sends a registration
// only when the server environment sets DOMAIN_HOUND_DIRECT_PURCHASE=1. Tests pass a client factory for the local mock.
// The purchase folder comes from the same env and is resolved here, once.
export function purchaseHandlers({ env = process.env, credentials = () => spaceshipCredentials({ env }),
  clientFor = keys => spaceshipClient({ ...keys, env }), store = stateStore(purchaseDir(env)), registry, now = () => new Date(),
  sleep, facts, catalog = () => loadCatalog() } = {}) {
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

  // move_domain: a public plan by default; a live Spaceship transfer quote when a key is set; then the guarded transfer or
  // its status. The auth code is only read in the direct transfer call and never appears in any answer or file.
  async function move(args) {
    const domain = checkInput(moveTool, args);
    const has = key => Object.hasOwn(args, key);
    if (has('auth_code') && typeof args.auth_code !== 'string') throw Error('auth_code must be text.');
    if (has('status')) {
      if (args.status !== true || Object.keys(args).some(key => key !== 'domain' && key !== 'status')) throw Error('status takes only domain and status: true.');
      const api = await client();
      if (!api) return result(missingKeyText('transferStatus'), { domain, transfer: null });
      const { say, ...data } = await transferStatus(domain, { client: api, store });
      return result(say, data);
    }
    if (!has('quote_id')) {
      if (['max_usd', 'confirm', 'auth_code'].some(has)) throw Error('max_usd, confirm and auth_code need the quote_id from the plan.');
      return plan(domain);
    }
    if (typeof args.quote_id !== 'string' || !args.quote_id) throw Error('Give the quote_id from the plan.');
    if (typeof args.max_usd !== 'number' || !Number.isFinite(args.max_usd) || args.max_usd <= 0 || args.max_usd > 100_000) {
      throw Error('Give max_usd, the most the person agreed to pay in USD.');
    }
    if (has('auth_code') && !directPurchaseEnabled(env)) {
      throw Error('Direct transfer is off, so Domain Hound takes no auth code. The person enters it at Spaceship checkout. Nothing was sent.');
    }
    if (has('auth_code') && args.confirm !== true) throw Error('auth_code goes only with confirm: true, after the person approved the dry run.');
    let apiPromise;
    const live = async () => {
      const api = await (apiPromise ??= client());
      if (!api) throw new SpaceshipError(missingKeyText(directPurchaseEnabled(env) ? 'transferDirect' : 'transfer'));
      return api;
    };
    const lazyClient = Object.fromEntries(['pricing', 'info', 'startTransfer', 'transferInfo', 'operation']
      .map(method => [method, async (...rest) => (await live())[method](...rest)]));
    const { say, ...data } = await transferDomain({ domain, quote_id: args.quote_id, max_usd: args.max_usd, confirm: args.confirm === true,
      authCode: args.auth_code }, { client: lazyClient, accountBinding: async () => (await live()).accountBinding, store, facts, env, now,
      ...(sleep && { sleep }) });
    return result(say, { domain, ...data });
  }

  async function plan(domain) {
    const at = now();
    const [record, prices, api] = await Promise.all([transferRegistryRecord(domain, { facts, now: at }), catalog(), client()]);
    let made = planFromFacts(domain, record, prices, at);
    const extra = [];
    let quoteData = null;
    const canQuote = made.current.shop !== 'Spaceship' && made.verdict !== 'blocked';
    if (!api) {
      if (canQuote) extra.push('For a live Spaceship transfer price, set a Spaceship key with domains:read (see the README).');
    } else if (canQuote) {
      try {
        const { offer, quote: issued } = await issueTransferQuote(domain, { client: api, store, record, now: at });
        if (issued) {
          made = planFromFacts(domain, record, prices, at, issued);
          quoteData = { ...issued, amountUsd: issued.amount / 100, renewalUsd: issued.renewal.amount / 100 };
          extra.push(transferOfferLine(issued), quoteTimes(issued) + ' Quote ID ' + issued.id + '.',
            made.target?.id !== 'spaceship' ? 'This quote is for the Spaceship option. Use it only if the person chooses Spaceship.'
              : directPurchaseEnabled(env) ? 'Show the person this quote and use move_domain with quote_id and max_usd for a dry run.'
                : 'Show the person this quote and use move_domain with quote_id and max_usd for the Spaceship checkout handoff.');
        } else {
          extra.push('No live Spaceship transfer quote: ' + (offer.status === 'priced' ? offer.blockers.join('; ') + '.' : offer.reason));
        }
      } catch (problem) {
        extra.push('No live Spaceship transfer quote: ' + (problem instanceof Error ? problem.message : 'Spaceship did not answer.'));
      }
    }
    const say = [...planLines(made), ...extra].join('\n');
    return result(say, { domain, plan: made, quote: quoteData });
  }

  const handlers = { quote_domain: quote, buy_domain: buy, setup_domain: setup, move_domain: move };
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
