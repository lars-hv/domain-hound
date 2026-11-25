import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldLatin } from '../clis/domain-check/triage-sources.mjs';

// Builds clis/domain-check/meaning-words.json from a local copy of the LDNOOBW lists (CC BY 4.0).
// Usage: node scripts/build-meaning-words.mjs <folder with the LDNOOBW language files> <commit>
// The English dictionary (/usr/share/dict/web2 and propernames on macOS) is used for two rules only:
// a non-English entry that is also an ordinary English word or name is dropped, and a word that no
// dictionary word contains may match inside a glued name ("strong"). No brand or name is listed by hand.
const [folder, commit] = process.argv.slice(2);
if (!folder || !/^[0-9a-f]{40}$/.test(commit ?? '')) {
  throw new Error('Usage: node scripts/build-meaning-words.mjs <LDNOOBW folder> <40-character commit>');
}
const languages = ['en', 'es', 'pt', 'fr', 'de', 'it', 'no', 'sv', 'da', 'nl', 'pl', 'tr'];
const read = async file => (await readFile(join(folder, file), 'utf8')).split('\n').map(line => line.trim()).filter(Boolean);
const dictionary = new Set([
  ...(await readFile('/usr/share/dict/web2', 'utf8')).split('\n'),
  ...(await readFile('/usr/share/dict/propernames', 'utf8')).split('\n'),
].map(word => word.trim().toLowerCase()).filter(Boolean));

// Entries keep one space between words; a multi-word entry only ever matches a whole name.
const clean = value => value.normalize('NFC').toLowerCase().replace(/['’.-]+/g, '').replace(/\s+/g, ' ').trim();
const latin = value => /^[\p{Script=Latin} ]+$/u.test(value);
const glued = value => foldLatin(value).replace(/ /g, '');

// Kana to Hepburn-style romaji, for the Japanese entries written only in kana.
const kana = Object.fromEntries(Object.entries({
  a: 'あア', i: 'いイ', u: 'うウ', e: 'えエ', o: 'おオ', ka: 'かカ', ki: 'きキ', ku: 'くク', ke: 'けケ', ko: 'こコ',
  sa: 'さサ', shi: 'しシ', su: 'すス', se: 'せセ', so: 'そソ', ta: 'たタ', chi: 'ちチ', tsu: 'つツ', te: 'てテ', to: 'とト',
  na: 'なナ', ni: 'にニ', nu: 'ぬヌ', ne: 'ねネ', no: 'のノ', ha: 'はハ', hi: 'ひヒ', fu: 'ふフ', he: 'へヘ', ho: 'ほホ',
  ma: 'まマ', mi: 'みミ', mu: 'むム', me: 'めメ', mo: 'もモ', ya: 'やヤ', yu: 'ゆユ', yo: 'よヨ',
  ra: 'らラ', ri: 'りリ', ru: 'るル', re: 'れレ', ro: 'ろロ', wa: 'わワ', wo: 'をヲ', n: 'んン',
  ga: 'がガ', gi: 'ぎギ', gu: 'ぐグ', ge: 'げゲ', go: 'ごゴ', za: 'ざザ', ji: 'じジ', zu: 'ずズ', ze: 'ぜゼ', zo: 'ぞゾ',
  da: 'だダ', de: 'でデ', do: 'どド', ba: 'ばバ', bi: 'びビ', bu: 'ぶブ', be: 'べベ', bo: 'ぼボ',
  pa: 'ぱパ', pi: 'ぴピ', pu: 'ぷプ', pe: 'ぺペ', po: 'ぽポ', vu: 'ゔヴ',
}).flatMap(([romaji, chars]) => [...chars].map(char => [char, romaji])));
const small = { ゃ: 'ya', ャ: 'ya', ゅ: 'yu', ュ: 'yu', ょ: 'yo', ョ: 'yo', ぁ: 'a', ァ: 'a', ぃ: 'i', ィ: 'i', ぅ: 'u', ゥ: 'u',
  ぇ: 'e', ェ: 'e', ぉ: 'o', ォ: 'o' };
function romaji(word) {
  let out = '';
  let double = false;
  for (const char of word) {
    if (char === 'っ' || char === 'ッ') { double = true; continue; }
    if (char === 'ー') { out += out.at(-1) ?? ''; continue; }
    if (small[char]) {
      const glide = small[char];
      if (glide.length === 2 && out.endsWith('i')) {
        // きゃ kya, しゃ sha, ちゃ cha, じゃ ja.
        const base = out.slice(0, -1);
        out = /(?:sh|ch|j)$/.test(base) ? base + glide[1] : base + glide;
      } else if (glide.length === 1 && /[aeiou]$/.test(out)) {
        // ファ fa, ティ ti, ディ di.
        out = out.replace(/(?:su|u|e|o|i)$/, match => match === 'su' ? 's' : '') + glide;
      } else out += glide;
      continue;
    }
    const value = kana[char];
    if (!value) return null;
    out += (double ? value[0] === 'c' ? 't' : value[0] : '') + value;
    double = false;
  }
  return out;
}

// Readings for kanji entries of the LDNOOBW Japanese list; each key must exist in that list.
const kanjiReadings = {
  糞: 'kuso', 変態: 'hentai', 巨乳: 'kyonyuu', 巨根: 'kyokon', 中出し: 'nakadashi', 淫乱: 'inran', 射精: 'shasei',
  精液: 'seieki', 輪姦: 'rinkan', 乳首: 'chikubi', 手コキ: 'tekoki', 獣姦: 'juukan', 売春婦: 'baishunfu', 肛門: 'koumon',
  膣: 'chitsu', 強姦犯: 'goukanhan', 近親相姦: 'kinshinsoukan', 緊縛: 'kinbaku', 陰毛: 'inmou', 乱交: 'rankou',
};
// Pinyin without tones for multi-character entries of the LDNOOBW Chinese list; each key must exist in that list.
const pinyin = {
  傻逼: 'shabi', 傻比: 'shabi', 他妈的: 'tamade', 你妈的: 'nimade', 操你妈: 'caonima', 操你: 'caoni', 日你妈: 'rinima',
  王八蛋: 'wangbadan', 婊子: 'biaozi', 婊子养的: 'biaoziyangde', 狗日: 'gouri', 狗屁: 'goupi', 杂种: 'zazhong',
  贱人: 'jianren', 贱货: 'jianhuo', 骚货: 'saohuo', 骚逼: 'saobi', 白痴: 'baichi', 笨蛋: 'bendan', 屁眼: 'piyan',
  强奸: 'qiangjian', 轮奸: 'lunjian', 阴道: 'yindao', 阴茎: 'yinjing', 龟头: 'guitou', 做爱: 'zuoai', 口交: 'koujiao',
  肛交: 'gangjiao', 打飞机: 'dafeiji', 打炮: 'dapao', 吃屎: 'chishi', 瘪三: 'biesan', 下贱: 'xiajian', 烂货: 'lanhuo',
  荡妇: 'dangfu', 淫妇: 'yinfu', 淫荡: 'yindang', 三级片: 'sanjipian', 干你娘: 'ganniniang', 龟儿子: 'guierzi',
  瓜娃子: 'guawazi', 鸡巴: 'jiba', 妈逼: 'mabi', 卖淫: 'maiyin', 嫖娼: 'piaochang', 妓女: 'jinv', 仆街: 'pujie',
};

const words = {};
for (const language of languages) {
  words[language] = [...new Set((await read(language)).map(clean).filter(word => latin(word)
    && glued(word).length >= 3 && (language === 'en' || !dictionary.has(word.replace(/ /g, '')))))].sort();
}
const ja = new Set(await read('ja'));
const zh = new Set(await read('zh'));
for (const [entries, readings] of [[ja, kanjiReadings], [zh, pinyin]]) {
  for (const key of Object.keys(readings)) if (!entries.has(key)) throw new Error('Not in the source list: ' + key);
}
const kanaWords = [...ja].map(entry => /^[\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u.test(entry) ? romaji(entry) : null);
words['ja-Latn'] = [...new Set([...kanaWords, ...Object.values(kanjiReadings)].filter(word => word?.length >= 4
  && !dictionary.has(word)))].sort();
words['zh-Latn'] = [...new Set(Object.values(pinyin).filter(word => word.length >= 4 && !dictionary.has(word)))].sort();

// A single word may match inside a glued name only when it has five letters or more (four in English) and no
// ordinary dictionary word contains it.
const listed = new Set(Object.values(words).flat().map(glued));
const innocent = [...dictionary].filter(word => !listed.has(word));
const strong = [...new Set(Object.entries(words).flatMap(([language, list]) => list
  .filter(word => !word.includes(' ') && glued(word).length >= (language === 'en' ? 4 : 5)).map(glued)))]
  .filter(word => !innocent.some(entry => entry.includes(word))).sort();

const target = fileURLToPath(new URL('../clis/domain-check/meaning-words.json', import.meta.url));
await writeFile(target, JSON.stringify({
  source: 'List of Dirty, Naughty, Obscene, and Otherwise Bad Words, © 2012–2020 Shutterstock, Inc.',
  url: 'https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/tree/' + commit,
  license: 'CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/)',
  changes: 'Selected 12 languages; lowercased entries and removed hyphens, apostrophes and dots; dropped non-Latin entries, entries under three '
    + 'letters and non-English entries that are ordinary English words or names; added romaji for Japanese kana and '
    + 'kanji entries and toneless pinyin for multi-character Chinese entries; marked single words of five or more letters (four in English) that no English dictionary word contains.',
  words, strong,
}, null, 1) + '\n');
console.log(Object.entries(words).map(([language, list]) => language + ' ' + list.length).join(', ') + '; strong ' + strong.length);
