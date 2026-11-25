import { readShareFragment } from './share-format.mjs';

const receipt = document.getElementById('receipt');
const groups = document.getElementById('groups');
const checkedAt = document.getElementById('checked-at');
const unavailable = document.getElementById('unavailable');
const copyButton = document.getElementById('copy-link');
const feedback = document.getElementById('copy-feedback');
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const timestamp = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC'
});

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function price(label, amount) {
  const pair = element('div');
  pair.append(element('dt', '', label), element('dd', '', amount == null ? 'No quote' : usd.format(amount)));
  return pair;
}

function domainRow(record) {
  const item = element('li', 'domain-row');
  const identity = element('div');
  identity.append(element('strong', 'domain', record.domain), element('span', 'status', record.status));
  const prices = element('dl', 'quotes');
  prices.append(price('Upfront', record.now), price('Renewal', record.renew));
  item.append(identity, prices);
  if (record.term > 1) item.append(element('p', 'term', record.term + ' years per payment'));
  return item;
}

function nameGroup({ name, verdict, records }) {
  const card = element('article', 'paper');
  const heading = element('header', 'group-heading');
  heading.append(element('h2', '', name));
  if (verdict) heading.append(element('p', 'verdict', verdict));
  card.append(heading);
  if (!records.length) {
    card.append(element('p', 'group-foot', 'No domains checked.'));
    return card;
  }

  const rows = element('ul', 'domain-list');
  rows.setAttribute('aria-label', 'Domain prices in USD');
  for (const record of records) rows.append(domainRow(record));

  const target = records.find(record => /^taken\b/i.test(record.status)) ?? records[0];
  const foot = element('div', 'group-foot');
  const watch = element('a', 'watch-link', 'Watch this domain');
  watch.href = '/watch/?domain=' + encodeURIComponent(target.domain);
  watch.setAttribute('aria-label', 'Watch this domain: ' + target.domain);
  foot.append(watch, element('span', 'watch-target', target.domain));
  card.append(foot, rows);
  return card;
}

async function showReceipt() {
  const hash = location.hash;
  receipt.hidden = true;
  unavailable.hidden = true;
  copyButton.hidden = true;
  feedback.textContent = '';
  groups.replaceChildren();
  try {
    const data = await readShareFragment(hash);
    if (hash !== location.hash) return;
    if (!data?.groups.length) {
      unavailable.hidden = false;
      return;
    }
    checkedAt.dateTime = data.checkedAt;
    checkedAt.textContent = timestamp.format(new Date(data.checkedAt)) + ' UTC';
    groups.replaceChildren(...data.groups.map(nameGroup));
    receipt.hidden = false;
    copyButton.hidden = false;
  } catch {
    if (hash === location.hash) unavailable.hidden = false;
  }
}

copyButton.addEventListener('click', async () => {
  const url = location.href;
  feedback.textContent = '';
  try {
    await navigator.clipboard.writeText(url);
    if (url === location.href) feedback.textContent = 'Share link copied.';
  } catch {
    if (url === location.href) feedback.textContent = 'Copy the full link from your address bar.';
  }
});

window.addEventListener('hashchange', showReceipt);
showReceipt();
