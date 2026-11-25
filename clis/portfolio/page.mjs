// The local results page for my_domains, in the same receipt style as the name results: one row per domain,
// most urgent first. One fixed file pair (portfolio.html and portfolio.md) is rewritten on each check.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backgroundCommand } from '../../results.mjs';
import { receiptStyle } from '../../results-style.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const plain = value => String(value ?? '').replace(/[\r\n\p{Cc}\p{Cf}]+/gu, ' ').trim();
const markdown = value => plain(value).replace(/[\\|<>\[\]`*_]/g, '\\$&');
const anchor = (label, url) => '<a href="' + escape(url) + '">' + escape(label) + '</a>';
const cash = value => Number.isFinite(value) ? '$' + value.toFixed(2) : 'No price';
const day = value => typeof value === 'string' ? value.slice(0, 10) : null;
const https = value => typeof value === 'string' && /^https:\/\/[^\s<>"]+$/.test(value) ? value : null;

// Inline [label](https://...) links from the say lines become anchors; everything else is escaped text.
function paragraph(line) {
  let html = '';
  let offset = 0;
  for (const match of line.matchAll(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g)) {
    html += escape(line.slice(offset, match.index).replace(/\\(.)/g, '$1')) + anchor(match[1], match[2]);
    offset = match.index + match[0].length;
  }
  return '<p>' + html + escape(line.slice(offset).replace(/\\(.)/g, '$1')) + '</p>';
}

const checkText = (label, check, ok) => {
  if (!check) return null;
  if (check.state === 'ok') return label + ': ' + ok(check);
  if (check.state === 'none') return label + ': ' + (check.reason ?? 'none');
  if (check.state === 'unknown') return label + ': unknown (' + (check.reason ?? 'no answer') + ')';
  return label + ': ' + (check.reason ?? 'problem');
};

// The facts under one domain, in reading order. Unknown checks say so; they are never shown as failures.
export function rowFacts(row) {
  const r = row.registry;
  const registry = r.state === 'unknown' ? 'Registry: unknown (' + (r.reason ?? 'no answer') + ')'
    : r.state === 'problem' && !r.expires ? 'Registry: ' + (r.reason ?? r.problems?.join('; ') ?? 'problem')
      : ['Registrar: ' + (r.registrar ?? 'not shown'), r.created && 'created ' + day(r.created),
        r.problems?.length ? r.problems.join('; ') : null,
        r.autoRenewGrace ? 'registry shows auto-renew grace' : null].filter(Boolean).join(' · ');
  const site = row.site.httpStatus
    ? 'Site: HTTP ' + row.site.httpStatus + (row.site.redirect ? ', redirects to ' + row.site.redirect : '')
      + (row.site.note ? ' (' + row.site.note + ')' : '')
    : checkText('Site', row.site, () => 'up');
  const tls = checkText('Certificate', row.tls, check => check.expires
    ? 'valid until ' + day(check.expires) + (check.issuer ? ' (' + check.issuer + ')' : '') : 'expiry not available');
  const email = row.email?.mx === 'unknown' || row.email?.state === 'unknown' ? checkText('Email', row.email)
    : 'Email: ' + (row.email.mx === true ? 'MX yes' : row.email.mx === 'null' ? 'declares no mail' : 'no MX')
      + ' · SPF ' + (row.email.spf === 'unknown' ? 'unknown' : row.email.spf ? 'yes' : 'no')
      + ' · DMARC ' + (row.email.dmarc === 'unknown' ? 'unknown' : row.email.dmarc ? 'yes' : 'no');
  const m = row.money;
  const dated = price => cash(price.renewal) + '/yr at ' + price.shop + ', ' + (price.estimate ? 'snapshot ' : 'list ') + day(price.checkedAt);
  const money = [m.current ? 'Renewal ' + dated(m.current) : m.currentShop ? 'Renewal at ' + m.currentShop + ': no list price'
    : 'Renewal at this registrar: not in our price list',
  m.cheapest && m.cheapest.shop !== m.current?.shop ? 'lowest listed renewal ' + dated(m.cheapest) : null].filter(Boolean).join(' · ');
  const nameservers = row.nameservers ?? r.nameservers;
  return [registry, r.status?.length && 'Registry status: ' + r.status.join(', '),
    'DNS: ' + (row.dnsHost ?? 'name servers unknown'),
    nameservers?.length && 'Name servers: ' + nameservers.join(', '), site, tls, email, money,
    m.move && 'Move to ' + m.move.to + ' to save ' + cash(m.move.saving) + ' over 3 years at list prices'].filter(Boolean);
}

export function renderPage(rows, lines, checkedAt, note) {
  const expiry = row => row.registry.expires
    ? day(row.registry.expires) + (row.registry.daysLeft !== null ? ' (' + row.registry.daysLeft + ' d)' : '') : 'Unknown';
  const renewal = row => row.money.current ? cash(row.money.current.renewal) : 'No price';
  const body = rows.map(row => {
    const facts = rowFacts(row);
    const current = row.money.current;
    const lowest = row.money.cheapest;
    const links = [https(row.registry.source?.url) ? anchor('Registry source', row.registry.source.url) : null,
      https(current?.source) ? anchor(current.shop + ' prices', current.source) : null,
      lowest?.source !== current?.source && https(lowest?.source) ? anchor(lowest.shop + ' prices', lowest.source) : null,
      row.money.move && https(row.money.move.url) ? anchor('Transfer to ' + row.money.move.to, row.money.move.url) : null].filter(Boolean);
    const date = day(row.registry.expires);
    const deadline = date ? '<time datetime="' + escape(row.registry.expires) + '">' + escape(date) + '</time>'
      + (row.registry.daysLeft !== null ? '<br>' + escape(String(row.registry.daysLeft) + ' d') : '') : 'Unknown';
    return '<tr><th scope="row"><code>' + escape(row.domain) + '</code><small>' + escape(row.registry.registrar ?? 'Registrar unknown')
      + '</small><details><summary>Details</summary><small>' + facts.map(escape).join('<br>')
      + (links.length ? '<br>' + links.join(' · ') : '') + '</small></details></th><td>' + deadline + '</td><td>'
      + escape(renewal(row)) + '</td></tr>';
  });
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">'
    + '<title>Your domains | Domain Hound</title><style>' + receiptStyle
    + 'tbody details{border:0} tbody summary{padding:.2rem 0;font-size:.9rem} td time{font-size:.8rem;white-space:nowrap}'
    + '</style></head><body><main>'
    + '<header><small>Domain Hound</small><h1>Your domains</h1><time datetime="' + escape(checkedAt) + '">'
    + escape(checkedAt.slice(0, 16).replace('T', ' ') + ' UTC') + '</time></header><section>'
    + lines.map(paragraph).join('') + '</section><article><table><caption>Most urgent first · USD list prices before tax</caption>'
    + '<thead><tr><th scope="col">Domain</th><th scope="col">Expires</th><th scope="col">Renewal</th></tr></thead><tbody>'
    + body.join('') + '</tbody></table></article><footer>' + paragraph(note) + '</footer></main></body></html>\n';
  const md = ['# Your domains', '', 'Domain Hound · ' + checkedAt, '', ...lines, '',
    '| Domain | Expires | Renewal (USD) | Facts |', '| --- | --- | --- | --- |',
    ...rows.map(row => '| ' + [markdown(row.domain), markdown(expiry(row)), markdown(renewal(row)),
      rowFacts(row).map(markdown).join('<br>')].join(' | ') + ' |'),
    '', markdown(note), ''].join('\n');
  return { html, md };
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

// A page writer for one server process. It opens the page in the background the first time only.
export function portfolioPages({ env = process.env,
  directory = env.DOMAIN_HOUND_RESULTS_DIR || join(homedir(), '.domain-hound', 'results') } = {}) {
  let opened = false;
  return async (rows, lines, checkedAt, note) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const page = renderPage(rows, lines, checkedAt, note);
    const filename = resolve(directory, 'portfolio.html');
    await writePrivate(resolve(directory, 'portfolio.md'), page.md);
    await writePrivate(filename, page.html);
    if (!opened) {
      opened = true;
      await backgroundCommand(filename, env).then(command => {
        if (!command) return;
        const [executable, args, launchEnv] = command;
        const browser = spawn(executable, args, { stdio: 'ignore', windowsHide: true, env: launchEnv });
        browser.on('error', () => {});
        browser.unref();
      }).catch(() => {});
    }
    return pathToFileURL(filename).href.replaceAll('(', '%28').replaceAll(')', '%29');
  };
}
