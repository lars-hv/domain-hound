import { packageJson } from '../../packaged.mjs';
import { foldLatin } from './triage-sources.mjs';

// Bad-meaning screen from the open LDNOOBW lists (CC BY 4.0, see meaning-words.LICENSE.txt), built by
// scripts/build-meaning-words.mjs. A hit is a note and at most "Check first"; it never makes a name Avoid.
// Rules stay narrow to keep false alarms low:
// - is: the whole name, or one word of it ("Kick Ass"), is a listed word of three or more letters;
// - contains: a long listed word that no English dictionary word contains sits inside the glued name;
// - sounds like: the name or one word of it is spelled differently but said the same as one of those long words
//   (ph/f, c/k, doubled letters).
// Words with accents match only with their accents ("göt" never matches "got"), unless five or more letters long.
const data = packageJson('clis/domain-check/meaning-words.json');
const languageNames = { en: 'English', es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German', it: 'Italian',
  no: 'Norwegian', sv: 'Swedish', da: 'Danish', nl: 'Dutch', pl: 'Polish', tr: 'Turkish', 'ja-Latn': 'Japanese',
  'zh-Latn': 'Chinese' };
export const meaningSource = { name: data.source, url: data.url, license: data.license };

const plain = value => value.normalize('NFC').toLowerCase().replace(/ /g, '');
const folded = value => foldLatin(value).replace(/[^a-z]/g, '');
// Said the same: ph/f, ck/c/q/k, soft c/s, x/ks, z/s, and doubled letters.
export const soundKey = value => folded(value).replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/c(?=[eiy])/g, 's')
  .replace(/[cq]/g, 'k').replace(/x/g, 'ks').replace(/z/g, 's').replace(/(.)\1+/g, '$1');

const exact = new Map();
const loose = new Map();
const phrases = new Map();
const sounds = new Map();
const add = (map, key, word, language) => {
  const entry = map.get(key) ?? { word, languages: [] };
  if (!entry.languages.includes(language)) entry.languages.push(language);
  map.set(key, entry);
};
for (const [language, words] of Object.entries(data.words)) {
  for (const word of words) {
    const key = folded(word);
    if (word.includes(' ')) add(phrases, key, word, language);
    else if (plain(word) === key || key.length >= 5) add(loose, key, word, language);
    else add(exact, plain(word), word, language);
  }
}
const strong = data.strong.filter(word => loose.has(word)).sort((a, b) => b.length - a.length);
for (const word of strong) if (!sounds.has(soundKey(word))) sounds.set(soundKey(word), loose.get(word));

function note(how, { word, languages }) {
  const where = languages.slice(0, 2).map(language => languageNames[language] ?? language).join(' and ');
  const text = { is: '“' + word + '” is a rude word in ' + where, contains: 'Contains “' + word + '”, a rude word in ' + where,
    sounds: 'Sounds like “' + word + '”, a rude word in ' + where }[how];
  return { how, word, languages: languages.slice(0, 2).map(language => languageNames[language] ?? language), note: text };
}

// The words of a name as typed: spaces, hyphens, digits and camel case split it.
function words(input) {
  return String(input ?? '').normalize('NFC').replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').toLowerCase()
    .split(/[^\p{L}]+/u).filter(Boolean);
}

export function screenMeaning(input) {
  const parts = words(input);
  if (!parts.length) return null;
  const whole = parts.join('');
  const wholeKey = folded(whole);
  const find = value => exact.get(plain(value)) ?? loose.get(folded(value));
  const named = find(whole) ?? phrases.get(wholeKey);
  if (named && folded(whole).length >= 3) return note('is', named);
  for (const part of parts.length > 1 ? parts : []) {
    const hit = folded(part).length >= 3 && find(part);
    if (hit) return note('contains', hit);
  }
  const inside = strong.find(word => word !== wholeKey && wholeKey.includes(word));
  if (inside) return note('contains', loose.get(inside));
  for (const part of new Set([whole, ...parts])) {
    const key = folded(part);
    const hit = key.length >= 3 && sounds.get(soundKey(part));
    if (hit && folded(hit.word) !== key) return note('sounds', hit);
  }
  return null;
}
