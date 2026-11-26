import { createHash } from 'node:crypto';
import { normalizeName } from './clis/domain-check/name-search.mjs';
import { localCheckNotice } from './display.mjs';
import { sharePage, shareUrlLimit } from './site/r/share-format.mjs';
import { cardStyle, resultMark } from './results-style.mjs';

const cash = value => Number.isFinite(value) ? '$' + value.toFixed(2) : null;
const watchLink = domain => 'https://domainhound.dev/watch/?domain=' + encodeURIComponent(domain);
export const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export const anchor = (label, url) => '<a href="' + escape(url) + '">' + escape(label) + '</a>';
function summaryHtml(line) {
  return Array.from(line.matchAll(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g)).reduce(({ html, offset }, match) =>
    ({ html: html + escape(line.slice(offset, match.index)) + anchor(match[1], match[2]), offset: match.index + match[0].length }),
  { html: '', offset: 0 });
}
export function paragraph(line) {
  const { html, offset } = summaryHtml(line);
  return '<p>' + html + escape(line.slice(offset)) + '</p>';
}

const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
export const priceDay = value => Number.isFinite(Date.parse(value)) ? day.format(new Date(value)) : null;
const amount = value => cash(value) ?? 'No price';
export const publicShare = value => typeof value === 'string' && value.length < shareUrlLimit
  && value.startsWith(sharePage) && /^#[123]\.[A-Za-z0-9_-]+$/.test(value.slice(sharePage.length)) ? value : null;

// A single fixed script localizes timestamps for the reader, even on a different machine.
// All disclosures, links and prices are usable with scripting disabled.
const readerClock = `const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const hour = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
for (const time of document.querySelectorAll('time[datetime]')) {
  const date = new Date(time.dateTime);
  time.textContent = day.format(date) + ', ' + hour.format(date);
}`;
const clockHash = createHash('sha256').update(readerClock).digest('base64');
function timestamp(value) {
  if (!Number.isFinite(Date.parse(value))) return 'Time unavailable';
  const date = new Date(value);
  return '<time datetime="' + date.toISOString() + '">' + day.format(date) + ', '
    + date.toISOString().slice(11, 16) + ' UTC</time>';
}

function shopTable(domain, quotes, cheapest) {
  const headers = ['Shop', 'Year 1', 'Per year', '3 years'].map(label => '<th scope="col">' + label + '</th>').join('');
  const rows = quotes.map(q => '<tr><th scope="row">' + (q.buyUrl ? anchor(q.shop, q.buyUrl) : escape(q.shop))
    + (q.threeYearUsd != null && q.threeYearUsd === cheapest ? '<small class="lowest">Cheapest</small>' : '')
    + (!q.buyUrl ? '<small>Price only</small>' : '') + '</th>'
    + [q.firstYearUsd, q.renewalUsd, q.threeYearUsd].map(price => '<td>' + amount(price) + '</td>').join('') + '</tr>');
  return '<table class="shop-table" aria-label="Shop prices for ' + escape(domain) + '"><thead><tr>' + headers
    + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>';
}

function endingCard(row, card) {
  const prices = [...row.prices].sort((a, b) => (a.threeYearUsd ?? Infinity) - (b.threeYearUsd ?? Infinity)
    || (a.firstPaymentUsd ?? Infinity) - (b.firstPaymentUsd ?? Infinity));
  const [first] = prices;
  const buy = prices.find(price => price.buyUrl);
  const best = card.pick?.domain === row.domain && Boolean(buy);
  const more = prices.length - 3;
  const labels = [row.domain === card.exact && 'You asked for this', best && 'Hound’s pick'].filter(Boolean);
  return '<section class="offer-row' + (best ? ' best-domain' : '') + '" data-domain="' + escape(row.domain) + '">'
    + '<div class="offer-head"><h3 class="domain-title">' + escape(row.domain) + '</h3><span class="verdict">Available</span></div>'
    + (labels.length ? '<b class="pick-label">' + labels.join(' · ') + '</b>' : '')
    + (best && Number.isFinite(card.cap) && card.pick.threeYearUsd <= card.cap ? '<p class="offer-condition">Preferred ending at '
      + cash(card.cap) + ' or less over 3 years.</p>' : best ? '<p class="offer-condition">Selected for the ending and its three-year cost.</p>' : '')
    + (first ? '<p class="first-price"><strong>' + amount(first.firstYearUsd) + '</strong> first year</p><p class="renewal">'
      + (first.renewalUsd != null ? 'Renewal ' + amount(first.renewalUsd) + '/year' : 'Renewal at shop') + '</p>'
      + (first.threeYearUsd != null ? '<p class="three-year">' + amount(first.threeYearUsd) + ' over 3 years at ' + escape(first.shop) + '</p>' : '')
      + (first.minimumYears > 1 ? '<p class="offer-condition">' + amount(first.firstPaymentUsd) + ' upfront for '
        + escape(first.minimumYears) + ' years.'
        + (Number.isFinite(first.renewalUsd) ? ' Renewal ' + amount(first.renewalPaymentUsd ?? first.minimumYears * first.renewalUsd) + ' per payment.' : '')
        + '</p>' : '') : '<p class="offer-condition">No standard price listed.</p>')
    + (row.note ? '<p class="offer-condition">' + escape(row.note) + '</p>' : '')
    + (buy ? '<a class="action" aria-label="Buy ' + escape(row.domain + ' at ' + buy.shop) + '" href="' + escape(buy.buyUrl)
      + '">Buy at ' + escape(buy.shop) + (buy !== first ? ' · ' + amount(buy.threeYearUsd) + ' for 3 years' : '') + '</a>' : '')
    + (buy?.shop === 'Cloudflare' ? '<p class="offer-condition">Requires Cloudflare DNS.</p>' : '')
    + (buy && Number.isFinite(buy.firstYearUsd) && buy.renewalUsd > 3 * buy.firstYearUsd ? '<p class="renewal-warning">Renewal at '
      + escape(buy.shop) + ' costs more than 3 times the first year.</p>' : '')
    + (first ? shopTable(row.domain, prices.slice(0, 3), first.threeYearUsd) : '')
    + (more > 0 ? '<details class="extra-shops"><summary class="more-shops">+' + more + ' more shop' + (more === 1 ? '' : 's')
      + '</summary>' + shopTable(row.domain, prices.slice(3), first.threeYearUsd) + '</details>' : '') + '</section>';
}

function nameCard(card, index, multi, perNameShare) {
  const available = card.domains.filter(row => row.status === 'available');
  if (card.pick) available.sort((a, b) => Number(b.domain === card.pick.domain) - Number(a.domain === card.pick.domain));
  const taken = card.domains.filter(row => row.status === 'taken');
  const requestedTaken = taken.some(row => row.domain === card.exact);
  const priority = new Map([['com', 0], ['ai', 1], ['io', 2]]);
  const rank = row => priority.get(row.domain.split('.')[1]) ?? priority.size;
  const others = taken.filter(row => row.domain !== card.exact).sort((a, b) => rank(a) - rank(b));
  const unknown = card.domains.filter(row => row.status === 'unknown');
  const count = available.length;
  return '<article class="hunt-card" id="name-' + index + '">'
    + (multi ? '<h2>' + escape(card.name) + '</h2>' : '') + card.warning
    + (card.score ? '<div class="name-score">' + paragraph(card.score) + '</div>' : '')
    + (requestedTaken ? '<p class="requested-actions">' + anchor('Watch ' + card.exact, watchLink(card.exact))
      + ' or ask your agent to draft an offer.</p>' : '')
    + (count ? (requestedTaken ? '<h3 class="alternatives-title">Available instead</h3>' : '<p class="offer-count">'
      + count + ' available domain' + (count === 1 ? '' : 's') + '</p>')
      + '<div class="ending-list">' + available.map(row => endingCard(row, card)).join('') + '</div>'
      : '<p class="ending-summary">' + (card.alternativesFailed ? 'Couldn’t check other endings.' : card.complete !== false && taken.length && !unknown.length
        ? 'All checked endings are taken.' : 'No available endings confirmed.') + '</p>')
    + (card.checks ? '<details class="name-details"><summary>Name checks</summary><div class="local-evidence">'
      + card.checks + '</div></details>' : '')
    + (others.length ? '<div class="taken-group"><p class="taken-list"><b>Taken</b> ' + others.map(row =>
      '<a aria-label="Watch ' + escape(row.domain) + '" href="' + escape(watchLink(row.domain)) + '">'
      + escape(row.domain.startsWith(card.name.toLowerCase().split('.')[0] + '.') || row.domain.startsWith(normalizeName(card.name) + '.')
        ? row.domain.slice(row.domain.indexOf('.')) : row.domain) + '</a>').join(' ')
      + ' <span class="taken-next">Watch an ending, or ask your agent to draft an offer.</span></p></div>' : '')
    + (unknown.length ? '<details class="local-evidence"><summary>' + unknown.length + ' ending' + (unknown.length === 1 ? '' : 's')
      + ' couldn’t be confirmed</summary>' + unknown.map(row => '<p>' + escape(row.domain + ' · ' + (row.note || 'Could not confirm')) + '</p>').join('') + '</details>' : '')
    + '<div class="suggestion-foot">' + (Array.isArray(card.reasons) && card.reasons.length ? '<details><summary>Why this name?</summary><ul class="reason-list">'
      + card.reasons.map(reason => '<li>' + escape(reason) + '</li>').join('') + '</ul></details>' : '')
    + (perNameShare && card.share ? anchor('Share ' + card.name, card.share) : '') + '</div></article>';
}

function priceCaption(cards) {
  const dates = new Set();
  const confirmed = new Set();
  for (const card of cards) {
    for (const row of card.domains.filter(row => row.status === 'available')) {
      const group = row.confirmed ? confirmed : dates;
      for (const quote of row.prices) {
        const date = card.local ? quote.checkedAt ?? card.priceDate : card.priceDate ?? quote.checkedAt;
        group.add(priceDay(date));
      }
    }
  }
  if (!dates.size && !confirmed.size) return '';
  const missing = [dates.delete(null), confirmed.delete(null)].some(Boolean);
  const lines = [
    dates.size && 'Price list dated ' + [...dates].join(' and ') + '.',
    confirmed.size && 'Shop quotes checked ' + [...confirmed].join(' and ') + '.',
    missing && 'Some prices are undated.', 'USD before tax.',
  ];
  return '<p class="quote-caption">' + lines.filter(Boolean).join(' ') + '</p>';
}

export function renderCards({ cards, data, shared, shareLabel, checkedAt, watch, lines, comparison, savings,
  note, sources, refresh, hiddenWarnings }) {
  const single = cards.length === 1 && !data.generation ? cards[0] : null;
  const exactTaken = single?.exact && single.domains.some(row => row.domain === single.exact && row.status === 'taken');
  const title = watch ? 'Domain watch' : data.generation ? 'Name ideas' : single ? single.name + (exactTaken ? ' is taken.' : '') : 'Domain results';
  const status = watch ? lines : [
    data.source === 'local' && localCheckNotice,
    data.pending && (data.hosted ? 'The results page updates when the remaining checks finish.' : 'Still checking trademark, app and web sources. Registry answers so far are on the page.'),
    data.failed && 'Some checks did not finish.',
    !cards.length && (data.pending ? 'Still checking names and domains.' : 'No names passed the checks.'),
  ].filter(Boolean);
  const articles = cards.map((card, index) => nameCard(card, index, !single, !shared));
  const content = data.generation ? '<ol class="hunt-list idea-list">' + articles.map(card => '<li>' + card + '</li>').join('') + '</ol>' : articles.join('');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; style-src &apos;unsafe-inline&apos;; img-src data:; font-src data:; script-src &apos;sha256-' + clockHash + '&apos;; base-uri &apos;none&apos;; form-action &apos;none&apos;">'
    + (refresh ? '<meta http-equiv="refresh" content="8">' : '')
    + '<title>' + escape(title) + ' | Domain Hound</title><style>' + cardStyle + '</style></head><body>'
    + '<header class="mast"><div class="wrap mast-inner"><span class="brand"><img alt="" src="' + resultMark
    + '">Domain Hound</span><span>Checked ' + timestamp(checkedAt) + '</span></div></header>'
    + '<main class="hunt-results"><div class="wrap"><div class="results-head"><h1>' + escape(title) + '</h1>'
    + (shared ? anchor(shareLabel, shared) : '') + '</div>' + status.map(paragraph).join('')
    + (cards.length > 1 && !data.generation ? '<nav class="name-nav" aria-label="Jump to a name">'
      + cards.map((card, index) => anchor(card.name, '#name-' + index)).join(' ') + '</nav>' : '')
    + hiddenWarnings + '<div id="result-pages">' + content + '</div>' + priceCaption(cards)
    + (comparison.length ? '<div class="comparison">' + comparison.map(paragraph).join('') + '</div>' : '')
    + savings.map(paragraph).join('') + (data.generation?.question && !data.pending ? paragraph(data.generation.question) : '')
    + '</div></main><footer><div class="wrap">' + (sources ? paragraph(sources) : '') + (note ? paragraph(note) : '')
    + '</div></footer><script>' + readerClock + '</script></body></html>\n';
}
