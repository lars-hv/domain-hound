import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canRecommend, defaultEndings, normalizeName } from './clis/domain-check/name-search.mjs';
import { shopSearchUrl, shops } from './clis/domain-check/prices.mjs';
import { safeLink } from './display.mjs';
import { receiptStyle } from './results-style.mjs';

const cash = value => Number.isFinite(value) ? '$' + value.toFixed(2) : null;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const plain = value => String(value ?? '').replace(/[\r\n\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s*[—–]\s*/g, '. ').trim();
const evidenceText = value => plain(value).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/https?:\/\/[^\s)]+/gi, '').replace(/[\[\]<>]/g, '').replace(/\s{2,}/g, ' ').trim();
const markdown = value => plain(value).replace(/[\\|<>\[\]`*]/g, '\\$&');
const shopIds = new Map(Object.entries(shops).map(([id, { name }]) => [name, id]));
const endingOf = value => value.split('.').at(-1);
const fallbackShop = ending => ending === 'no' ? 'dynadot' : ending === 'so' ? 'namecheap' : 'spaceship';
const markOf = row => row.competition?.US;
const marksText = row => {
  const mark = markOf(row);
  return 'US marks: ' + (typeof mark === 'string' ? evidenceText(mark) : mark == null ? 'not checked' : 'no match found');
};
const watchLink = domain => 'https://domainhound.dev/watch/?domain=' + encodeURIComponent(domain);
const verdictOrder = { 'No conflict found': 0, 'Check first': 1, Avoid: 2 };

function resultGroups(data) {
  return data.names.map((row, index) => {
    const detail = data.receiptDetails?.[index] ?? {};
    const exact = row.name.includes('.');
    const label = exact ? row.name : normalizeName(row.name);
    const variants = [...(row.free ?? []), ...(row.taken ?? []), ...(row.shop_check ?? []), ...(row.resale ?? [])]
      .map(value => value.d ?? value).filter(value => value.includes('.'));
    const targets = exact ? [row.name] : [...new Set([...defaultEndings.map(ending => label + '.' + ending), ...variants])];
    const records = targets.map(domain => {
      const ending = endingOf(domain);
      const lookupKey = domain === label + '.' + ending || exact ? ending : domain;
      const match = list => list?.find(value => (value.d ?? value) === domain || (value.d ?? value) === lookupKey);
      const option = match(row.free);
      const raw = detail.endings?.find(item => item.domain === domain);
      const confirmed = option?.s === 'ok';
      const quote = confirmed ? option : { ...data.listPrices?.[ending], ...data.listPrices?.[domain],
        ...data.prices?.[ending], ...row.own?.[ending], ...(typeof option === 'object' ? option : {}) };
      const taken = Boolean(match(row.taken) || match(row.resale));
      const reserved = Boolean(match(row.reserved));
      const risk = Boolean(option?.risk || raw?.risk);
      const premium = Boolean(match(row.premium) || option?.s === 'prem' || option?.prem || risk);
      const includePrice = !reserved && (!premium || confirmed) && (!taken || exact);
      const likely = match(row.likely_free) ? 'likely free by DNS' : match(row.likely_taken) ? 'likely taken by DNS' : null;
      const state = taken ? 'taken' : premium ? 'premium' : option ? 'free' : 'check';
      const status = taken ? (match(row.resale) ? 'Taken, possible resale' : 'Taken')
        : reserved ? 'Not offered for registration' : confirmed ? 'Confirmed at shop'
          : premium ? (risk ? 'May be premium, price at shop' : 'Premium, price at shop')
          : option ? 'Free at the registry' : likely ? 'Check at shop, ' + likely : 'Check at shop';
      const usd = includePrice ? { now: quote.now, renew: quote.renew, y3: quote.y3, term: quote.term,
        jump: quote.jump, shop: quote.shop } : {};
      const term = usd.term ?? 1;
      const total = usd.y3 ?? (usd.now != null && usd.renew != null ? usd.now + (Math.ceil(3 / term) - 1) * usd.renew : null);
      const source = ({ web: 'Live site', dns: 'DNS', rdap: 'Registry RDAP', whois: 'Registry WHOIS',
        shop: 'Shop', list: 'Price list' })[raw?.source] ?? (confirmed ? 'Shop' : likely ? 'DNS' : 'Registry');
      const shop = usd.shop ?? raw?.shop ?? shops[fallbackShop(ending)]?.name;
      const eligible = canRecommend(ending, data.eligible);
      const shopUrl = shopSearchUrl(shopIds.get(shop) ?? fallbackShop(ending), domain);
      const checkout = taken || reserved || !eligible ? null : [raw?.checkout, shopUrl].find(url => safeLink(url, domain)) ?? null;
      return { domain, ending, state, status, ...usd, total, shop, checkout, eligible, source,
        priceLabel: usd.now != null || usd.renew != null ? (confirmed ? 'Shop quote' : taken ? 'Standard list price benchmark' : 'List price') : '',
        checkedAt: raw?.checkedAt ?? data.checkedAt, priceAt: raw?.priceAt ?? option?.at ?? data.priceListDate,
        site: raw?.site ?? detail.details?.sites?.[ending] ?? row.details?.sites?.[ending] };
    });
    records.sort((a, b) => Number(b.state === 'free' || b.priceLabel === 'Shop quote')
      - Number(a.state === 'free' || a.priceLabel === 'Shop quote') || (a.now ?? Infinity) - (b.now ?? Infinity));
    return { row: { ...row, ...detail, name: row.name }, records };
  });
}

function offerText(offer, linked = false) {
  const { domain, checkout, now, renew, term, jump, priceLabel } = offer;
  const price = now != null ? cash(now) + (renew != null ? ', then ' + cash(renew) : ', renewal at shop')
    : renew != null ? cash(renew) + ' renewal' : 'price at shop';
  return (linked && checkout ? '[' + domain + '](' + checkout + ')' : domain) + ' ' + price
    + (term > 1 ? ' every ' + term + ' years' : '') + (jump ? ' (renewal jumps)' : '')
    + (priceLabel ? ' ' + priceLabel.toLowerCase() : '');
}

function appFinding(value) {
  if (value == null) return 'check incomplete';
  return Array.isArray(value) && !value.length ? 'no app with this name' : 'same-name app found';
}

function signals(group) {
  const { row, records } = group;
  const comp = row.competition ?? {};
  const site = records.map(record => record.site).find(site => site?.state === 'live')?.host;
  const states = records.map(record => typeof record.site === 'string' ? record.site : record.site?.state).filter(Boolean);
  const checked = states.some(state => /^(?:live|parked|for.sale|no(?:-site| site found))/i.test(state));
  const web = site ? 'live site at ' + plain(site) : states.some(state => /live/i.test(state)) ? 'live site'
    : states.some(state => /parked|for sale|for-sale/i.test(state)) ? 'parked'
      : row.traction?.domain ? 'rival listed at ' + plain(row.traction.domain)
        : checked ? 'no live site found on checked endings' : 'not checked';
  return 'iOS: ' + appFinding(comp.AppStore) + ' | Android: ' + appFinding(comp.GooglePlay) + ' | web: ' + web;
}

function summary(groups, args, triage) {
  const [wanted] = groups;
  const preferred = args.endings ?? [];
  const budget = args.budget;
  const isExact = !triage && groups.length === 1 && wanted.row.name.includes('.');
  const constraints = [...(!isExact && preferred.length ? [preferred.map(ending => '.' + ending).join(', ') + ' first'] : []),
    ...(budget != null ? ['Up to ' + cash(budget) + ' today'] : [])];
  const inScope = record => record.eligible && (!preferred.length || preferred.includes(record.ending))
    && (budget == null || (record.now ?? Infinity) <= budget);
  const candidates = groups.flatMap(group => group.row.verdict === 'Avoid' ? [] : group.records
    .filter(record => inScope(record) && (record.state === 'free' || record.priceLabel === 'Shop quote'))
    .map(record => ({ group, record })));
  const cost = item => item.record.now ?? Infinity;
  const compareCost = (a, b) => cost(a) - cost(b);
  const position = item => preferred.length ? preferred.indexOf(item.record.ending) : 0;
  candidates.sort((a, b) => (verdictOrder[a.group.row.verdict] ?? 0) - (verdictOrder[b.group.row.verdict] ?? 0)
    || position(a) - position(b) || compareCost(a, b) || a.record.domain.localeCompare(b.record.domain));
  const best = candidates[0];
  const picks = [...new Map(candidates.toReversed().map(item => [item.group, item])).values()].reverse().slice(0, 3);
  const cheapest = candidates.filter(item => item.record.now != null).sort(compareCost)[0];
  const value = candidates.filter(item => item.record.total != null)
    .sort((a, b) => a.record.total - b.record.total || compareCost(a, b))[0];
  const target = wanted.records.find(record => record.ending === (preferred[0] ?? 'com')) ?? wanted.records[0];
  const watch = target?.state === 'taken' ? 'Want it anyway? [Watch ' + target.domain + '](' + watchLink(target.domain) + ').' : null;
  if (isExact) {
    const picked = wanted.records[0];
    const hasPrice = picked.now != null || picked.renew != null;
    let price = hasPrice ? ' ' + offerText(picked).slice(picked.domain.length + 1) + '.' : '';
    if (picked.state === 'taken' && picked.renew != null) {
      price = ' Standard list renewal: ' + cash(picked.renew) + (picked.term > 1
        ? ' every ' + picked.term + ' years (' + cash(picked.renew / picked.term) + ' a year)' : ' a year') + '.';
    }
    const overBudget = budget != null && picked.now != null && picked.now > budget && picked.state !== 'taken';
    const intro = picked.domain + ': ' + picked.status.toLowerCase() + '.' + price + (overBudget ? ' Over budget.' : '');
    const step = overBudget ? 'Next: try a cheaper domain.' : picked.checkout
      ? 'Next: [check at ' + plain(picked.shop) + '](' + picked.checkout + ').' : watch ?? 'Next: check another domain.';
    return [...constraints, intro, ...(args.purchase ? ['Domain Hound cannot buy or complete checkout.'] : []), step];
  }
  const reason = evidenceText(wanted.row.reason).replace('David vs Goliath: ', 'Established rival: ');
  const keep = triage ? 'Keep ' + evidenceText(wanted.row.name) + '? ' + plain(wanted.row.verdict) + '. '
    + reason.replaceAll(' · ', '. ') + '.'
    + (typeof markOf(wanted.row) === 'string' && reason.includes(markOf(wanted.row)) ? ' US trademark screen.' : ' ' + marksText(wanted.row) + '.')
    + (wanted.row.verdict === 'Avoid' && best ? (best.group.row.verdict === 'No conflict found' ? ' Best free rename: ' : ' Next name to check: ')
      + plain(best.group.row.name) + '.' : '')
    + (picks.some(item => item.group === wanted) ? '' : ' | ' + signals(wanted)) : null;
  const next = watch ?? (args.shortlist ? 'Next: screen the best names.' : best ? 'Next: check your pick at the shop.' : 'Next: try another name.');
  const caution = item => item.group.row.verdict === 'Check first' ? ' (Check first)' : '';
  const label = item => offerText(item.record, true) + caution(item);
  const offerLines = picks.map(({ group, record }, index) =>
    (budget != null && index === 0 ? 'Pick: ' : (index + 1) + '. ') + offerText(record) + ' (' + plain(record.status.toLowerCase()) + ') | '
    + (triage ? plain(group.row.verdict) + ' | ' + marksText(group.row) + ' | ' : '') + signals(group));
  const scope = constraints.length ? constraints.join(' | ') + '. ' : '';
  const leadPick = scope && offerLines.length ? scope + offerLines.shift() : null;
  const eligibility = args.eligible?.includes('no') || cheapest?.record.ending === 'no'
    || value?.record.ending === 'no' || preferred.includes('no')
    ? ' .no needs a Norwegian address and organization or personal ID.' : '';
  const lines = [
    leadPick || (scope ? scope + 'All endings are on the page.' : null),
    keep,
    ...offerLines,
    'Cheapest: ' + (cheapest ? label(cheapest) : 'none found in scope.'),
    'Best value: ' + (value ? value.record.domain + ', ' + cash(value.record.total) + ' in payments due in 3 years'
      + caution(value) : 'needs a shop quote') + '.',
    (args.purchase ? 'Domain Hound cannot buy or complete checkout. ' : '') + next + eligibility,
  ];
  return lines.filter(Boolean);
}

function httpsLink(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function details(group) {
  const { row } = group;
  const comp = row.competition ?? {};
  const titleAndLink = value => value && typeof value === 'object'
    ? [plain(value.name ?? value.domain ?? value.title), httpsLink(value.url)] : [plain(value)];
  const ios = Array.isArray(comp.AppStore) ? comp.AppStore : comp.AppStore ? [comp.AppStore] : [];
  const android = Array.isArray(comp.GooglePlay) ? comp.GooglePlay : comp.GooglePlay ? [comp.GooglePlay] : [];
  const matches = [
    ['US marks: ' + (typeof markOf(row) === 'string' ? plain(markOf(row)) : markOf(row) == null ? 'check incomplete' : 'no match found'), httpsLink(comp.mark)],
    ...ios.map(value => ['iOS: ' + titleAndLink(value)[0], titleAndLink(value)[1]]),
    ...android.map(value => ['Android: ' + titleAndLink(value)[0], titleAndLink(value)[1]]),
    ...[...(comp.sameName?.Norway ?? []), ...(comp.sameName?.EDGAR ?? [])].map(company => [plain(
      [company.name, company.employees != null ? company.employees + ' employees' : null].filter(Boolean).join(', ')), httpsLink(company.url)]),
    ...group.records.filter(row => row.site).map(({ domain, site }) => [
      (site.host ?? domain) + ': ' + plain(site.state ?? site) + (site.title ? ', ' + plain(site.title) : ''),
      httpsLink('https://' + (site.host ?? domain))]),
    ['Web search: ' + plain(row.google?.result ?? 'check incomplete'), httpsLink(row.google?.link)],
    ['iOS search', 'https://apps.apple.com/us/iphone/search?term=' + encodeURIComponent(row.name)],
    ['Android search', 'https://play.google.com/store/search?q=' + encodeURIComponent(row.name) + '&c=apps'],
    ...(row.traction ? [[plain(row.traction.rival ?? row.traction.name ?? ''),
      httpsLink(row.traction.domain && 'https://' + row.traction.domain)],
    ...Object.values(row.traction).flat().filter(value => typeof value === 'string').map(value => [plain(value)])] : []),
    ...(typeof row.reason === 'string' ? row.reason.split(' · ').slice(1).map(value => [plain(value)]) : []),
  ];
  return matches.filter(([text, href]) => text && (href || !/ search$/.test(text)));
}

const anchor = (label, url) => '<a href="' + escape(url) + '">' + escape(label) + '</a>';
function summaryHtml(line) {
  return Array.from(line.matchAll(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g)).reduce(({ html, offset }, match) =>
    ({ html: html + escape(line.slice(offset, match.index)) + anchor(match[1], match[2]), offset: match.index + match[0].length }),
  { html: '', offset: 0 });
}
function paragraph(line) {
  const { html, offset } = summaryHtml(line);
  return '<p>' + html + escape(line.slice(offset)) + '</p>';
}
const amountsFor = ({ now, renew }) => [cash(now) ?? 'No price', cash(renew) ?? 'No price'];

function rowNote(row) {
  return [row.status, row.priceLabel, row.term > 1 ? row.term + ' years per payment' : null,
    row.jump ? 'Renewal jumps' : null, !row.eligible ? '.no buyer eligibility required' : null,
    row.source, row.checkedAt, row.priceAt ? 'Price checked ' + row.priceAt : null].filter(Boolean).join(' · ');
}

function render(groups, lines, checkedAt, coverage, watch) {
  const title = watch ? 'Domain watch' : 'Domain results';
  const [intro, ...body] = lines;
  const comparison = body.filter(line => /^(?:Cheapest|Best value):/.test(line));
  const before = body.filter(line => !comparison.includes(line)).slice(0, comparison.length ? -1 : undefined);
  const after = comparison.length ? body.slice(-1) : [];
  const sources = watch?.source ? 'Registry: ' + String(watch.source).toUpperCase() :
    Object.entries(coverage ?? {}).map(([name, count]) => name + ' ' + count + '% answered').join(' · ');
  const articles = groups.map((group, index) => {
    const { row } = group;
    const rows = group.records.map(record => {
      const [now, renew] = amountsFor(record);
      return '<tr><th scope="row"><code>' + escape(record.domain) + '</code><small>' + escape(rowNote(record))
        + (record.checkout ? ' · ' + anchor(record.shop ?? 'Check at shop', record.checkout) : '')
        + '</small></th><td>' + escape(now) + '</td><td>' + escape(renew) + '</td></tr>';
    });
    return '<article id="name-' + index + '"><h2>' + escape(row.name) + '</h2>'
      + (row.verdict ? paragraph(plain(row.verdict) + '. ' + evidenceText(row.reason).split(' · ')[0]) + paragraph(signals(group)) : '')
      + '<table><caption>Endings · USD before tax</caption><thead><tr><th scope="col">Ending</th><th scope="col">Today</th><th scope="col">Renewal</th></tr></thead><tbody>'
      + rows.join('') + '</tbody></table>'
      + (row.verdict ? '<details><summary>Trademark, app and web evidence</summary><ul>'
        + details(group).map(([label, url]) => '<li>' + (url ? anchor(label, url) : escape(label)) + '</li>').join('') + '</ul></details>' : '')
      + '</article>';
  });
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">'
    + '<title>' + title + ' | Domain Hound</title><style>' + receiptStyle + '</style></head><body><main>'
    + '<header><small>Domain Hound</small><h1>' + title + '</h1><time>' + escape(checkedAt) + '</time></header><section>'
    + [intro, ...before].filter(Boolean).map(paragraph).join('')
    + (comparison.length ? '<div class="comparison">' + comparison.map(paragraph).join('') + '</div>' : '')
    + after.map(paragraph).join('') + '</section>'
    + (groups.length > 1 ? '<nav aria-label="Jump to a name">' + groups.map(({ row }, index) => anchor(row.name, '#name-' + index)).join(' ') + '</nav>' : '')
    + articles.join('') + '<footer>' + (sources ? paragraph(sources) : '') + '<p>You hold the leash.</p></footer></main></body></html>\n';
  const md = ['# ' + title, '', 'Domain Hound · ' + checkedAt, '', ...lines, '',
    ...groups.flatMap(group => ['## ' + markdown(group.row.name), '',
      ...(group.row.verdict ? [markdown(group.row.verdict + '. ' + group.row.reason), markdown(signals(group)), ''] : []),
      '| Ending | Today (USD) | Renewal (USD) | Evidence | Shop |', '| --- | --- | --- | --- | --- |',
      ...group.records.map(record => '| ' + [record.domain, ...amountsFor(record), markdown(rowNote(record)),
        record.checkout ? '[' + markdown(record.shop ?? 'Check at shop') + '](' + record.checkout + ')' : ''].join(' | ') + ' |'),
      '', ...(group.row.verdict ? details(group).map(([label, url]) => '- ' + (url ? '[' + markdown(label) + '](' + url + ')' : markdown(label))) : []), '']),
    ...(sources ? [markdown(sources), ''] : []), 'You hold the leash.', ''].join('\n');
  return { html, md };
}

export async function backgroundCommand(filename, env = process.env, platform = process.platform) {
  if (env.DOMAIN_HOUND_OPEN === 'off' || env.CI || env.DOMAIN_HOUND_HEADLESS || env.SSH_CONNECTION || env.SSH_TTY) return null;
  if (platform === 'darwin') {
    const console = await stat('/dev/console').catch(() => null);
    if (console?.uid === userInfo().uid) return ['/usr/bin/open', ['-g', filename]];
  }
  if (platform === 'win32' && /^(?:Console|RDP-Tcp#\d+)$/i.test(env.SESSIONNAME ?? '')) {
    // SW_SHOWNOACTIVATE is forwarded to the file association handler. The existing browser may ignore it.
    const path = Buffer.from(filename, 'utf8').toString('base64');
    const script = `Add-Type -Namespace DomainHound -Name Shell -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("shell32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode, ExactSpelling=true)]
public static extern System.IntPtr ShellExecuteW(System.IntPtr parent, string verb, string file, string args, string directory, int show);
'@
$file = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${path}'))
$result = [DomainHound.Shell]::ShellExecuteW([IntPtr]::Zero, 'open', $file, $null, $null, 4)
if ($result.ToInt64() -le 32) { exit 1 }`;
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]];
  }
  if (platform === 'linux' && env.WAYLAND_DISPLAY && env.DBUS_SESSION_BUS_ADDRESS) {
    // Leave activation to the compositor without giving the browser a startup or activation token.
    const { XDG_ACTIVATION_TOKEN, DESKTOP_STARTUP_ID, ...backgroundEnv } = env;
    return ['gio', ['open', pathToFileURL(filename).href], backgroundEnv];
  }
  return null;
}

async function writePrivate(filename, content) {
  const temporary = filename + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function prune(directory, current) {
  const owned = /^(?:\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z0-9-]+-[a-f0-9]{8}\.(?:html|md)|session-[a-f0-9]{8}\.html)$/;
  const files = (await readdir(directory)).filter(file => owned.test(file));
  const groups = new Map();
  for (const file of files) {
    const base = file.slice(0, file.lastIndexOf('.'));
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(file);
  }
  const ranked = await Promise.all([...groups].map(async ([base, entries]) => ({ base, entries,
    at: (await stat(join(directory, entries[0])).catch(() => null))?.mtimeMs ?? 0,
  })));
  ranked.sort((a, b) => Number(b.base === current) - Number(a.base === current) || b.at - a.at || b.base.localeCompare(a.base));
  let slots = 20;
  for (const { base, entries, at } of ranked) {
    // A second MCP process may be committing a twin. Leave a recent incomplete pair alone.
    if (!base.startsWith('session-') && entries.length === 1 && Date.now() - at < 60_000) continue;
    if (entries.length <= slots) {
      slots -= entries.length;
      continue;
    }
    await Promise.all(entries.map(file => unlink(join(directory, file)).catch(() => {})));
  }
}

export function resultPages({ env = process.env,
  directory = env.DOMAIN_HOUND_RESULTS_DIR || join(homedir(), '.domain-hound', 'results') } = {}) {
  const session = randomUUID().slice(0, 8);
  let writes = Promise.resolve();
  return (data, args, { triage = false, watch = false } = {}) => {
    const work = writes.then(async () => {
      const at = data.checkedAt ?? new Date().toISOString();
      const groups = watch ? [] : resultGroups(data);
      const lines = watch ? data.say.split('\n') : summary(groups, args, triage);
      const title = watch ? data.domain : groups[0]?.row.name;
      const slug = (normalizeName(String(title).split('.')[0]) ?? 'results').slice(0, 30);
      const base = new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + slug + '-' + randomUUID().slice(0, 8);
      const filename = resolve(directory, base + '.html');
      const page = render(groups, lines, at, data.sources, watch ? data : null);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const markdownPath = resolve(directory, base + '.md');
      await writePrivate(markdownPath, page.md);
      try {
        await writePrivate(filename, page.html);
      } catch (error) {
        await unlink(markdownPath).catch(() => {});
        throw error;
      }
      const exact = !triage && groups.length === 1 && groups[0].row.name.includes('.');
      if (!watch && !exact) {
        const latest = resolve(directory, 'session-' + session + '.html');
        await backgroundCommand(latest, env).then(async command => {
          if (!command) return;
          await writePrivate(latest, page.html);
          const [executable, args, launchEnv] = command;
          const browser = spawn(executable, args, { stdio: 'ignore', windowsHide: true, env: launchEnv });
          browser.on('error', () => {});
          browser.unref();
        }).catch(() => {});
      }
      await prune(directory, base).catch(() => {});
      const url = pathToFileURL(filename).href.replaceAll('(', '%28').replaceAll(')', '%29');
      const say = [...lines, 'All endings: [Results page](' + url + ')'].join('\n');
      const { receiptDetails, say: priorSay, display: priorDisplay, ...structured } = data;
      if (triage && receiptDetails) structured.names = structured.names.map((row, index) => ({
        ...row, details: { ...row.details, sites: receiptDetails[index]?.details?.sites ?? {} },
      }));
      return { display: say, say, ...structured, checkedAt: at, resultPage: url };
    });
    writes = work.catch(() => {});
    return work;
  };
}
