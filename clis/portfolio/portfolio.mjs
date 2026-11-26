// my_domains: one view of every domain the person owns, wherever they bought it. Read-only toward the world: public
// registry, DNS, site and certificate checks plus dated list prices. The confirmed list lives only in a local file.
import { attributed, md } from '../../display.mjs';
import { resultsLine } from '../../results.mjs';
import { anySignal } from '../domain-check/cache.mjs';
import { checkDomain, expiringSoonDays, loadCatalog, sortByUrgency, urgency } from './checks.mjs';
import { maxPaths, projectCandidates, spaceshipDomains } from './discover.mjs';
import { portfolioPages } from './page.mjs';
import { maxSavedDomains, portfolioDomain, portfolioFile, readList, updateList, writeList } from './store.mjs';

export const totalBudgetMs = 11_000;
const listLocation = '~/.domain-hound/portfolio.json';
const domainList = description => ({ type: 'array', minItems: 1, maxItems: maxSavedDomains, uniqueItems: true,
  items: { type: 'string', minLength: 3, maxLength: 254 }, description });

export const portfolioTool = {
  name: 'my_domains',
  description: 'Use this when checking expiry, renewal prices, DNS, site, TLS or email for domains the person owns. '
    + 'Use domains to save confirmed domains locally, remove to drop them, or no arguments to recheck. '
    + 'Use find: true to preview candidates from project files and Spaceship. Show the candidates and add only the domains the person confirms. Use check_domains to look at a new domain.',
  annotations: { title: 'My domains', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      domains: domainList('Exact domains the person confirmed they own, like ["example.com"]. They join the saved list, then the whole list is checked.'),
      find: { type: 'boolean', description: 'True to list candidate domains for the person to confirm. Saves and checks nothing.' },
      paths: { type: 'array', minItems: 1, maxItems: maxPaths, items: { type: 'string', minLength: 1, maxLength: 1024 },
        description: 'With find only: project folders to look in. For example ["./web"]. Defaults to the current folder.' },
      remove: domainList('Domains to drop from the saved list, e.g. ["example.com"].'),
    },
    additionalProperties: false,
  },
};

function domainsFrom(values, field) {
  return values.map((value, index) => {
    const domain = portfolioDomain(value);
    if (!domain) throw Error(field + '[' + index + '] is not an exact domain. Use a domain like example.com.');
    return domain;
  });
}

function validate(input) {
  const args = input ?? {};
  if (typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).some(key => !Object.hasOwn(portfolioTool.inputSchema.properties, key))) {
    throw Error('Pass domains, find: true, remove, or nothing to recheck the saved list.');
  }
  const modes = ['domains', 'remove'].filter(key => Object.hasOwn(args, key)).concat(args.find === true ? ['find'] : []);
  if (modes.length > 1) throw Error('Use one of domains, find or remove per call.');
  if (Object.hasOwn(args, 'find') && typeof args.find !== 'boolean') throw Error('find must be true or false.');
  if (Object.hasOwn(args, 'paths') && args.find !== true) throw Error('paths works only with find: true.');
  for (const key of ['domains', 'remove']) {
    if (Object.hasOwn(args, key) && (!Array.isArray(args[key]) || !args[key].length || args[key].length > maxSavedDomains)) {
      throw Error(key + ' must list 1 to ' + maxSavedDomains + ' domains.');
    }
  }
  if (Object.hasOwn(args, 'paths') && (!Array.isArray(args.paths) || !args.paths.length || args.paths.length > maxPaths
    || args.paths.some(path => typeof path !== 'string' || !path.trim() || path.length > 1024 || /\p{Cc}/u.test(path)))) {
    throw Error('paths must list 1 to ' + maxPaths + ' folders.');
  }
  return { mode: modes[0] ?? 'recheck', args };
}

const unreadable = 'Your saved list at ' + listLocation + ' could not be read. Fix or move that file, then try again.';
const money = value => '$' + value.toFixed(2).replace(/\.00$/, '');
const day = value => String(value).slice(0, 10);

// What needs doing for one domain, most urgent first. Unknown checks are left to the page.
export function issues(row) {
  const r = row.registry;
  const found = [...(r.problems ?? [])];
  if (r.state === 'problem' && !r.problems?.length) found.push(r.reason);
  if (r.daysLeft !== null && r.daysLeft >= 0 && r.daysLeft <= expiringSoonDays) {
    found.push('expires in ' + r.daysLeft + (r.daysLeft === 1 ? ' day' : ' days') + ' (' + day(r.expires) + ')'
      + (r.registrar ? ' at ' + r.registrar : '') + (r.autoRenewGrace ? '; registry shows auto-renew grace' : ''));
  }
  if (row.site.state === 'problem') found.push('site ' + row.site.reason);
  if (row.tls.state === 'problem') found.push(row.tls.reason);
  if (row.email.state === 'problem') found.push(row.email.reason);
  if (row.money.move) found.push('save ' + money(row.money.move.saving) + ' over 3 years at ' + row.money.move.to + ' list prices');
  return found;
}

// The short answer: the page link, a count, up to four urgent domains and up to two next steps. At most eight lines.
export function sayLines(rows) {
  const flagged = rows.filter(row => urgency(row) <= 3);
  const unknown = rows.reduce((count, row) => count + [row.registry, row.site, row.tls, row.email]
    .filter(check => check.state === 'unknown').length, 0);
  const lines = [rows.length + (rows.length === 1 ? ' domain' : ' domains') + ': '
    + (flagged.length === 1 ? '1 needs attention' : flagged.length ? flagged.length + ' need attention' : 'nothing urgent')
    + (unknown ? '. ' + unknown + (unknown === 1 ? ' check' : ' checks') + ' had no answer (see the page)' : '') + '.'];
  for (const row of flagged.slice(0, 4)) lines.push(md(row.domain) + ': ' + md(issues(row).join('; ')).replace(/\.$/, '') + '.');
  if (flagged.length > 4) lines.push((flagged.length - 4) + ' more on the page.');
  const best = rows.filter(row => row.money.move).sort((a, b) => b.money.move.saving - a.money.move.saving)[0];
  if (best) {
    const move = best.money.move;
    lines.push('Next: move to save ' + money(move.saving) + ' over 3 years on ' + md(best.domain) + '. [' + md(move.to) + ' transfer](' + move.url + '). '
      + (move.estimate ? 'Snapshot' : 'List') + ' prices from ' + day(move.checkedAt) + '. Ask to plan the move with move_domain.');
  }
  const soonest = rows.filter(row => row.registry.daysLeft !== null && row.registry.daysLeft >= 0)
    .sort((a, b) => a.registry.daysLeft - b.registry.daysLeft)[0];
  if (soonest) {
    lines.push('Next: watch expiry by email for ' + md(soonest.domain) + ' (' + day(soonest.registry.expires) + ').');
  }
  return lines.slice(0, 7);
}

// Check every domain side by side within one budget. A domain that runs out of time is shown with unknown checks.
export async function checkAll(domains, { checker = checkDomain, now = new Date(), budgetMs = totalBudgetMs, catalog } = {}) {
  const started = performance.now();
  const controller = new AbortController();
  const signal = anySignal([controller.signal, AbortSignal.timeout(budgetMs)]);
  const prices = catalog ?? await loadCatalog();
  const late = domain => {
    const unknown = { state: 'unknown', reason: 'no answer in time' };
    return { domain, checkedAt: now.toISOString(),
      registry: { state: 'unknown', reason: 'no answer in time', registrar: null, expires: null, daysLeft: null, status: [], nameservers: [] },
      dnsHost: null, site: unknown, tls: unknown, email: unknown,
      money: { currentShop: null, current: null, cheapest: null, move: null } };
  };
  let timer;
  const cutoff = new Promise(resolve => { timer = setTimeout(resolve, budgetMs + 500); });
  try {
    return await Promise.all(domains.map(domain => Promise.race([
      checker(domain, { signal, now, catalog: prices, deadline: started + budgetMs }).catch(() => late(domain)),
      cutoff.then(() => late(domain)),
    ])));
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

const note = 'Checks use public registry records (RDAP or WHOIS), DNS, your sites over HTTPS and HTTP, and dated list prices. '
  + 'An unknown result means the source did not answer. Registry auto-renew grace describes the current registration status. '
  + 'Your list stays on this computer at ' + listLocation + '.';

// One page writer per server process, so the page opens in the background once, not on every call.
let sharedPages;

export async function myDomains(input, { env = process.env, file = portfolioFile(env), checker,
  pages = (sharedPages ??= portfolioPages({ env })),
  now = () => new Date(), budgetMs = totalBudgetMs, catalog, find = projectCandidates, spaceship = spaceshipDomains,
  cwd = () => process.cwd() } = {}) {
  const { mode, args } = validate(input);

  if (mode === 'find') {
    const paths = args.paths?.map(path => path.trim()) ?? [cwd()];
    const [local, account, saved] = await Promise.all([find(paths), spaceship(), readList(file)]);
    const known = new Set(saved.domains);
    const merged = new Map();
    for (const row of local) merged.set(row.domain, { domain: row.domain, sources: [...row.sources] });
    for (const domain of account.domains ?? []) {
      if (!merged.has(domain)) merged.set(domain, { domain, sources: [] });
      merged.get(domain).sources.unshift('your Spaceship account');
    }
    const candidates = [...merged.values()].map(row => ({ ...row, saved: known.has(row.domain) }));
    const fresh = candidates.filter(row => !row.saved);
    const accountLine = account.state === 'ok' ? 'Spaceship account: ' + account.domains.length + ' domains listed (read-only).'
      : account.state === 'not-connected' ? 'Spaceship account: not connected. Optional: a key with only domains:read lists your domains there.'
        : 'Spaceship account: ' + account.reason + '.';
    const lines = [fresh.length
      ? 'Found ' + fresh.length + ' candidate ' + (fresh.length === 1 ? 'domain' : 'domains') + '. Nothing is saved until you confirm which are yours.'
      : 'No new candidate domains found.',
    ...fresh.slice(0, 25).map(row => '- ' + md(row.domain) + ' (' + md(row.sources.join(', ') || 'found') + ')'),
    ...(fresh.length > 25 ? ['- and ' + (fresh.length - 25) + ' more'] : []),
    ...(candidates.length > fresh.length ? [candidates.length - fresh.length + ' already saved.'] : []),
    accountLine,
    ...(fresh.length ? ['Confirm which domains should go on your list.'] : [])];
    const say = attributed(lines.join('\n'));
    return { display: say, say, candidates, spaceship: account.state };
  }

  if (mode === 'remove') {
    const drop = new Set(domainsFrom(args.remove, 'remove'));
    const { removed, kept } = await updateList(file, async saved => {
      if (saved.state === 'unreadable') throw Error(unreadable);
      const removed = saved.domains.filter(domain => drop.has(domain));
      const kept = saved.domains.filter(domain => !drop.has(domain));
      if (removed.length) await writeList(kept, file, now());
      return { removed, kept };
    });
    const lines = [removed.length ? 'Removed ' + removed.map(md).join(', ') + ' from your saved list.' : 'None of those domains were saved.',
      kept.length ? kept.length + ' saved: ' + kept.map(md).join(', ') + '.' : 'Your saved list is empty.'];
    return { display: attributed(lines.join('\n')), removed, domains: kept };
  }

  const given = mode === 'domains' ? domainsFrom(args.domains, 'domains') : [];
  const merge = async saved => {
    if (saved.state === 'unreadable') throw Error(unreadable);
    const domains = [...new Set([...saved.domains, ...given])];
    if (domains.length > maxSavedDomains) {
      throw Error('The saved list holds up to ' + maxSavedDomains + ' domains; it has ' + saved.domains.length
        + '. Remove some first with remove.');
    }
    const added = domains.filter(domain => !saved.domains.includes(domain));
    if (added.length) await writeList(domains, file, now());
    return { domains, added };
  };
  const { domains, added } = given.length ? await updateList(file, merge) : await merge(await readList(file));
  if (!domains.length) {
    return { display: attributed('No saved domains yet. Name the domains you own, or ask me to find them in this project.'), domains: [] };
  }

  const checkedAt = now().toISOString();
  const rows = sortByUrgency(await checkAll(domains, { checker, now: new Date(checkedAt), budgetMs, catalog }));
  const lines = sayLines(rows);
  const resultPage = await pages(rows, lines, checkedAt, note);
  const say = [resultsLine(resultPage), ...lines].join('\n');
  return { display: say, say, checkedAt, resultPage, added, domains: rows };
}
