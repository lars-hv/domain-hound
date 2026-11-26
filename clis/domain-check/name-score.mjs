import { foldLatin } from './triage-sources.mjs';
import { scoreBand, scoreLabel } from '../../site/r/share-format.mjs';

// Name score v1 (2026-11-25): how clear the road is for one name, 0 to 100. It is not a probability; it stays a
// ranking of checked evidence until logged outcomes calibrate it.
// Order: bans (in code, before anything is scored), then hard filters on the checked evidence, then the points.
// A check that failed or is missing is never clear: it earns 40% of its component (rounded down) and a reason
// that says "Not checked" (or "Still checking" while the follow-up runs).
export const scoreVersion = 'v1';
export { scoreBand, scoreLabel };
export const scoreWeights = { domain: 22, price: 3, trademark: 25, rivals: 20, apps: 8, handles: 7, quality: 15 };
const componentOrder = Object.keys(scoreWeights);
export const endingPoints = { com: 22, ai: 19, io: 16, dev: 14, app: 12, co: 10, so: 8, me: 6, si: 4, xyz: 2, tech: 2 };
// v1 scores endings within $60 over 3 years; a larger budget the person gave widens the picks, not this filter.
export const scoreCapUsd = 60;
// Until the EU office answers, a clean US screen still leaves the trademark component at 20 of 25.
export const trademarkCapWithoutEu = 20;
// A failed USPTO or rival check, or naming bans the caller left unchecked, keep a name out of Strong.
export const uncheckedCap = 79;
const handleWeights = { GitHub: 3, npm: 2, Bluesky: 2 };
const unknownPart = max => Math.floor(max * 0.4);

// The evidence keys the caller supplies per name, for the bans code cannot decide on its own.
export const candidateFields = {
  recipe: ['odd-pair', 'pun', 'blend', 'insider', 'phrase', 'other'],
  relation: ['direct', 'loose', 'none'],
  spellings: 'integer',
  realWord: 'boolean',
  descriptive: 'boolean',
  misspelled: 'boolean',
  narrow: 'boolean',
  soundsLike: ['none', 'competitor', 'drug', 'pokemon'],
  badMeaning: ['none', 'mild', 'severe'],
  language: ['english', 'asked', 'other'],
};
const banEvidence = ['realWord', 'descriptive', 'misspelled', 'narrow', 'soundsLike'];

export function validCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, field]) => {
    if (!Object.hasOwn(candidateFields, key)) return false;
    const rule = candidateFields[key];
    if (rule === 'boolean') return typeof field === 'boolean';
    if (rule === 'integer') return Number.isInteger(field) && field >= 1 && field <= 5;
    return rule.includes(field);
  });
}

// The words of a name as typed: spaces, hyphens, digits and camel case split it ("LoomAI" -> loom, ai).
function words(input) {
  return String(input ?? '').normalize('NFC').replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export const letterCount = input => foldLatin(input).replace(/[^a-z]/g, '').length;

// Spoken syllables: vowel groups per word, a silent final e dropped, at least one per word.
export function syllableCount(input) {
  const parts = String(input ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
    .normalize('NFKD').replace(/\p{M}/gu, '').match(/[a-z]+/g) ?? [];
  return parts.reduce((total, part) => {
    const spoken = /[^aeiouy]le$/.test(part) ? part : part.replace(/([aeiouy].*[^aeiouy])e$/, '$1');
    return total + Math.max(1, (spoken.match(/[aeiouy]+/g) ?? []).length);
  }, 0);
}

const banned = new Set(['ai', 'gpt', 'bot', 'smart']);
const botWords = new Set(['robot', 'abbot', 'sabot', 'talbot']);
const generic = ['hub', 'base', 'flow', 'labs', 'lab', 'apps', 'app', 'pro'];
const ioWords = new Set(['studio', 'radio', 'patio', 'audio', 'ratio', 'folio', 'polio', 'cheerio', 'portfolio', 'oratorio', 'trio', 'brio']);

// The deterministic bans, then the bans the caller's evidence decides. Returns the first ban, or null.
export function nameBan(input, candidate = {}) {
  const text = String(input ?? '').trim();
  const parts = words(text);
  const key = foldLatin(text).replace(/[^a-z0-9]/g, '');
  const last = parts.at(-1) ?? '';
  if (/[\d_-]/.test(text)) return 'Numbers or hyphens';
  if (candidate.language === 'other' || (/[^\x00-\x7F]/.test(text) && candidate.language !== 'asked')) return 'Not English';
  if (parts.some(part => banned.has(part)) || key.includes('gpt') || key.startsWith('smart')
    || (/bot$/.test(key) && !botWords.has(last))) return 'AI, GPT, bot or smart in the name';
  if (letterCount(text) > 12) return 'Over 12 letters';
  if (syllableCount(text) > 3) return 'Over 3 syllables';
  if ((last.length > 4 && last.endsWith('ify')) || /[bcdghjkmnpqrstvwxz]ly$/.test(last)
    || (last.length >= 4 && last.endsWith('io') && !ioWords.has(last))) return 'Trend ending (-ly, -ify, -io)';
  if (!/[aeiouy]/.test(key) || /[bcdfgklmnpstvz]r$/.test(last)) return 'Dropped vowels';
  if ((parts.length > 1 && parts.some(part => generic.includes(part)))
    || (parts.length === 1 && generic.some(word => key.endsWith(word) && key.length - word.length >= 3))) {
    return 'Subject word plus a generic word';
  }
  if (candidate.descriptive === true) return 'Pure descriptive';
  if (candidate.realWord === false) return 'Pure invented, no real word inside';
  if (candidate.misspelled === true) return 'Deliberate misspelling';
  if (['competitor', 'drug', 'pokemon'].includes(candidate.soundsLike)) {
    return 'Sounds like a ' + (candidate.soundsLike === 'pokemon' ? 'Pokemon' : candidate.soundsLike);
  }
  if (candidate.narrow === true) return 'Too narrow for the product';
  return null;
}

const money = value => '$' + value.toFixed(2);
const listed = items => items.length < 3 ? items.join(' and ') : items.slice(0, -1).join(', ') + ' and ' + items.at(-1);
const unknownText = (state, what) => (state === 'pending' ? 'Still checking: ' : 'Not checked: ') + what;
const known = value => typeof value === 'number' && Number.isFinite(value);

function domainParts(options, cap) {
  const fits = (options ?? []).filter(option => option && known(option.total) && Math.round(option.total * 100) <= Math.round(cap * 100)
    && option.registry === true);
  const scored = fits.map(option => {
    const ending = endingPoints[option.ending] ?? 0;
    const price = option.total <= 30 ? 3 : option.total <= 45 ? 2 : 1;
    return { ...option, ending: option.ending, points: ending, price };
  }).sort((a, b) => b.points + b.price - a.points - a.price || a.total - b.total);
  return scored[0] ?? null;
}

// marks: { us: 'ok' | 'unknown' | 'pending', eu: 'ok' | 'unknown' | 'pending' | 'off', list: [{ tier, sameClass, live }] }
function trademarkPart(marks) {
  const list = Array.isArray(marks?.list) ? marks.list : [];
  const identical = mark => mark.tier === 'Exact';
  // Fuzzy (one edit) counts as near-identical; a mark with no class or no live status counts against the name.
  // A dead mark is skipped. Only an identical mark with a verified live status in your classes is a hard filter; one whose
  // status is unclear scores as the worst scored case instead.
  const marksLeft = list.filter(mark => mark && mark.live !== false);
  if (marksLeft.some(mark => identical(mark) && mark.sameClass === true && mark.live === true)) {
    return { filtered: 'Identical live trademark in your classes' };
  }
  // Unknown classes (null) score as your classes.
  const worst = marksLeft.reduce((low, mark) => Math.min(low, mark.sameClass !== false ? 5 : identical(mark) ? 12 : 18), 25);
  const usState = marks?.us === 'ok' ? 'ok' : marks?.us === 'pending' ? 'pending' : 'unknown';
  const texts = { 5: marksLeft.some(mark => identical(mark) && mark.sameClass !== false) ? 'Identical trademark, status or class unclear'
    : 'Near-identical trademark in your classes', 12: 'Identical trademark in another class',
    18: 'Near-identical trademark in another class' };
  if (usState !== 'ok') {
    // A hit from another office still counts when the US check failed.
    const points = Math.min(worst, unknownPart(25));
    return { points, state: usState, losses: [{ loss: 25 - points, text: unknownText(usState, 'US trademarks'), unknown: true }] };
  }
  const losses = worst < 25 ? [{ loss: 25 - worst, text: texts[worst] }] : [];
  let points = worst;
  const euState = marks?.eu === 'ok' ? 'ok' : marks?.eu === 'pending' ? 'pending' : 'unknown';
  if (euState !== 'ok') {
    losses.push({ loss: Math.max(0, points - trademarkCapWithoutEu), text: unknownText(euState, 'EU trademarks'), unknown: true });
    points = Math.min(points, trademarkCapWithoutEu);
  }
  return { points, state: 'ok', losses, best: worst === 25 ? 'No trademark match found' + (euState === 'ok' ? ' in the US or EU' : ' in the US') : null };
}

// rivals: { state: 'ok' | 'unknown' | 'pending', list: [{ level: 'strong' | 'some' | 'none' | 'dormant', sameSubject }], company }
// list holds the rivals already measured, even when another source failed, so a known strong same-subject rival still
// filters the name. company is true only with evidence of a same-name registered company in the same sector.
function rivalPart(rivals) {
  const state = rivals?.state === 'ok' ? 'ok' : rivals?.state === 'pending' ? 'pending' : 'unknown';
  let points = 20;
  let text = null;
  for (const rival of Array.isArray(rivals?.list) ? rivals.list : []) {
    // Without a subject (no about or category), a rival's subject is unclear and counts as yours, short of the filter.
    const same = rival.sameSubject;
    if (rival.level === 'strong' && same === true) return { filtered: 'Same-name rival with strong traction in your subject' };
    const [value, label] = rival.level === 'strong' ? [4, same === false ? 'Same-name rival with strong traction'
      : 'Same-name rival with strong traction, subject unclear']
      : rival.level === 'some' ? same === false ? [12, 'Same-name use with some traction']
        : [5, same === true ? 'Same-name rival in your subject' : 'Same-name use with some traction, subject unclear']
        : rival.level === 'dormant' ? [18, 'Dormant same-name site'] : [20, null];
    if (value < points) [points, text] = [value, label];
  }
  const losses = text ? [{ loss: 20 - points, text }] : [];
  if (state !== 'ok' && points > unknownPart(20)) {
    losses.push({ loss: points - unknownPart(20), text: unknownText(state, 'rivals'), unknown: true });
    points = unknownPart(20);
  } else if (state !== 'ok') losses.push({ loss: 0, text: unknownText(state, 'rivals'), unknown: true });
  if (rivals?.company === true) losses.push({ loss: 3, text: 'Same-name registered company in your sector' });
  return { points: Math.max(0, points - (rivals?.company === true ? 3 : 0)), state, losses,
    best: state === 'ok' && points === 20 && rivals?.company !== true ? 'No same-name rival found' : null };
}

// apps: { state: 'ok' | 'unknown' | 'pending', list: [{ sameCategory: true | false | null }] }; list keeps the hits
// one store returned even when the other store failed.
function appPart(apps) {
  const state = apps?.state === 'ok' ? 'ok' : apps?.state === 'pending' ? 'pending' : 'unknown';
  const list = Array.isArray(apps?.list) ? apps.list : [];
  const same = list.some(app => app?.sameCategory !== false);
  const unclear = same && !list.some(app => app?.sameCategory === true);
  let points = !list.length ? 8 : same ? 1 : 5;
  const losses = list.length ? [{ loss: 8 - points,
    text: same ? unclear ? 'Same-name app, category unclear' : 'Same-name app in your category' : 'Same-name app in another category' }] : [];
  if (state !== 'ok') {
    losses.push({ loss: Math.max(0, points - unknownPart(8)), text: unknownText(state, 'app stores'), unknown: true });
    points = Math.min(points, unknownPart(8));
  }
  return { points, state, losses, best: state === 'ok' && !list.length ? 'No same-name app' : null };
}

// handles: { GitHub, npm, Bluesky }: 'free' | 'taken' | 'pending' | anything else (not checked).
// The handles not checked earn 40% of their combined weight, rounded down (all three: 2 of 7).
function handlePart(handles = {}) {
  let points = 0;
  let missing = 0;
  const taken = [];
  const unknown = [];
  let pending = false;
  for (const [platform, weight] of Object.entries(handleWeights)) {
    const state = handles?.[platform];
    if (state === 'free') points += weight;
    else if (state === 'taken') taken.push(platform);
    else {
      missing += weight;
      unknown.push(platform);
      if (state === 'pending') pending = true;
    }
  }
  points += unknownPart(missing);
  const losses = [];
  if (taken.length) losses.push({ loss: taken.reduce((sum, platform) => sum + handleWeights[platform], 0),
    text: 'Handle taken: ' + listed(taken) });
  if (unknown.length) losses.push({ loss: missing - unknownPart(missing),
    text: unknownText(pending ? 'pending' : 'unknown', 'handles (' + listed(unknown) + ')'), unknown: true });
  return { points, state: unknown.length ? pending ? 'pending' : 'unknown' : 'ok', losses,
    best: points === 7 ? 'No public profiles found on GitHub, npm or Bluesky' : null };
}

function qualityPart(name, candidate, meaning) {
  const count = letterCount(name);
  const syllables = syllableCount(name);
  const losses = [];
  const length = count <= 6 ? 4 : count <= 9 ? 3 : 1;
  if (length < 4) losses.push({ loss: 4 - length, text: count + ' letters' });
  const sound = syllables <= 2 ? 3 : 2;
  if (sound < 3) losses.push({ loss: 1, text: 'Three syllables' });
  let spelling = 0;
  if (candidate.spellings === 1) spelling = 4;
  else if (Number.isInteger(candidate.spellings)) losses.push({ loss: 4, text: 'More than one spelling when heard' });
  else {
    spelling = unknownPart(4);
    losses.push({ loss: 4 - spelling, text: 'Not checked: spelling by ear', unknown: true });
  }
  let relation = 0;
  if (candidate.relation === 'direct') relation = 4;
  else if (candidate.relation === 'loose') {
    relation = 2;
    losses.push({ loss: 2, text: 'Loose link to the subject' });
  } else if (candidate.relation === 'none') losses.push({ loss: 4, text: 'No link to the subject' });
  else {
    relation = unknownPart(4);
    losses.push({ loss: 4 - relation, text: 'Not checked: subject fit', unknown: true });
  }
  const mild = meaning || candidate.badMeaning === 'mild';
  if (mild) losses.push({ loss: 5, text: 'Mild bad meaning' });
  const points = length + sound + spelling + relation - (mild ? 5 : 0);
  return { points, state: losses.some(loss => loss.unknown) ? 'unknown' : 'ok', losses,
    best: length >= 3 && sound === 3 && !mild ? 'Short and easy to say' : null };
}

// input: { name, candidate, domains: [{ ending, total, registry }], marks, rivals, apps, handles, meaning }
// meaning: the local 14-language screen ({ how }) or null. Returns { value, band, reasons, ... } or { filtered }.
export function scoreName(input) {
  const candidate = validCandidate(input?.candidate) ? input.candidate : {};
  const name = String(input?.name ?? '');
  const ban = nameBan(name, candidate);
  if (ban) return { version: scoreVersion, filtered: ban, kind: 'ban' };
  if (input?.meaning?.how === 'is' || candidate.badMeaning === 'severe') return { version: scoreVersion, filtered: 'Severe bad meaning', kind: 'filter' };
  const domain = domainParts(input?.domains, scoreCapUsd);
  if (!domain) return { version: scoreVersion, filtered: 'No available ending with a known price within ' + money(scoreCapUsd) + ' over 3 years', kind: 'filter' };
  const trademark = trademarkPart(input.marks);
  const rivals = rivalPart(input.rivals);
  for (const part of [trademark, rivals]) if (part.filtered) return { version: scoreVersion, filtered: part.filtered, kind: 'filter' };
  const parts = {
    domain: { points: domain.points, state: 'ok', best: '.' + domain.ending + ' is available, ' + money(domain.total) + ' for 3 years',
      losses: domain.points < 22 ? [{ loss: 22 - domain.points, text: 'Best available ending is .' + domain.ending }] : [] },
    price: { points: domain.price, state: 'ok', losses: domain.price < 3 ? [{ loss: 3 - domain.price, text: money(domain.total) + ' for 3 years' }] : [] },
    trademark, rivals, apps: appPart(input.apps), handles: handlePart(input.handles),
    quality: qualityPart(name, candidate, input.meaning),
  };
  const raw = componentOrder.reduce((sum, key) => sum + parts[key].points, 0);
  const caps = [];
  let value = Math.max(0, Math.min(100, raw));
  const missingBans = banEvidence.filter(key => !Object.hasOwn(candidate, key));
  const extra = [];
  if (trademark.state !== 'ok' || rivals.state !== 'ok') {
    if (value > uncheckedCap) caps.push('sources');
    value = Math.min(value, uncheckedCap);
  }
  if (missingBans.length) {
    if (value > uncheckedCap) caps.push('bans');
    extra.push({ loss: Math.max(0, value - uncheckedCap), text: 'Not checked: naming bans', unknown: true });
    value = Math.min(value, uncheckedCap);
  }
  const items = [...componentOrder.flatMap(key => parts[key].losses.map(item => ({ ...item, key }))), ...extra];
  // Every check that was not done, in plain words, whether or not it cost points.
  const notChecked = [...new Set(items.filter(item => item.unknown).map(item => item.text.replace(/^(?:Not checked|Still checking): /, '')))];
  const losses = items.filter(item => item.loss > 0)
    .sort((a, b) => b.loss - a.loss || Number(Boolean(b.unknown)) - Number(Boolean(a.unknown)));
  const [best] = componentOrder.filter(key => parts[key].best && parts[key].points > 0)
    .sort((a, b) => parts[b].points / scoreWeights[b] - parts[a].points / scoreWeights[a]
      || componentOrder.indexOf(a) - componentOrder.indexOf(b));
  const reasons = best ? [parts[best].best] : [];
  const chosen = losses.slice(0, 3 - reasons.length);
  // An unknown that costs points always takes one of the slots.
  const unknown = losses.find(item => item.unknown);
  if (unknown && !chosen.includes(unknown)) chosen[chosen.length - 1] = unknown;
  reasons.push(...chosen.map(item => item.text));
  const pending = componentOrder.some(key => parts[key].state === 'pending');
  return {
    version: scoreVersion, value, band: scoreBand(value), reasons, ...(pending && { pending: true }),
    components: Object.fromEntries(componentOrder.map(key => [key, parts[key].points])),
    unknown: componentOrder.filter(key => parts[key].state !== 'ok'),
    notChecked,
    ...(missingBans.length && { bansUnchecked: missingBans }),
    ...(caps.length && { caps }),
    ...(input.candidate?.recipe && candidate.recipe && { recipe: candidate.recipe }),
  };
}

// The handle states the score reads: free, taken, pending or (anything else) not checked.
export function scoreHandles(rows) {
  if (!Array.isArray(rows)) return {};
  return Object.fromEntries(['GitHub', 'npm', 'Bluesky'].map(platform => {
    const row = rows.find(entry => entry?.platform === platform);
    return [platform, row?.state === 'taken' ? 'taken' : row?.state === 'not-found' ? 'free'
      : row?.why === 'still checking' ? 'pending' : null];
  }));
}

// The part of a score that travels in tool results and on the page: value, band, reasons, or the filter.
export function compactScore(score) {
  if (!score) return null;
  if (score.filtered) return { filtered: score.filtered };
  return { value: score.value, band: score.band, reasons: score.reasons, ...(score.notChecked?.length && { notChecked: score.notChecked }),
    ...(score.pending && { pending: true }), ...(score.overridesAvoid && { overridesAvoid: true }) };
}

// "Name score 91/100 - how clear the road is"
export function scoreHeadline(score) {
  return score && known(score.value) ? 'Name score ' + score.value + '/100 - ' + scoreLabel : null;
}

// Whether a row may be a pick: the legacy Avoid guard stays, except for a scored name whose only Avoid is a strong rival in
// a different subject (overridesAvoid; the score carries that penalty). Hard filters always rule out the pick.
export function scoreEligible(row) {
  return !row?.score?.filtered && (row?.verdict !== 'Avoid' || (known(row?.score?.value) && row.score.overridesAvoid === true));
}

// Ranking across names: finished scores first, highest first; then scores still waiting on checks; then names
// without a score. Returns 0 when neither has a score, so callers keep their own order.
export function compareScores(a, b) {
  const tier = score => known(score?.value) ? score.pending ? 1 : 0 : 2;
  return tier(a) - tier(b) || (tier(a) < 2 ? b.value - a.value : 0);
}
