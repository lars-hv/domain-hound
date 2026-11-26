export const showAsIs = 'Show `display` exactly as written, then add at most two sentences of advice below it.';
export const purchaseLine = 'This check leaves checkout to you; use the link above.';

export const googleSearchInstruction = 'Before answering, use your built-in web search for each name marked google.search (up to 3). '
  + 'Search "<name>" and "<name>" app once each. Review the first 10 returned results of each search, or all results if fewer are returned. '
  + 'Count exact names only. Say Google: open if you find no same-name brand or product, Google: crowded for several unrelated uses, '
  + 'or Google: owned by <brand> if one brand dominates or a same-business product appears. '
  + 'Put any Google findings below the display. Keep the tool’s verdict, reason, traction and search links in the display. '
  + 'Then answer directly. Do not run more searches or generate replacement names.';

export const geoInstruction = 'GEO (presence in AI answers): for each name, answer from your own knowledge only, without searching or calling tools, '
  + 'whether you know a specific brand, company or product by that exact name: "known: <what it is, a few words>" or "unknown". '
  + 'Say unknown for a plain dictionary word or when unsure. Do not guess.';

// Real names by naming type, from the 2026-11-25 naming reference (213 names). Types and patterns only: the method never
// tells or invents origin stories. The last three show types the bans exclude.
export const referenceExamples = [
  ['real word, repurposed', 'Stripe'], ['real word, repurposed', 'Linear'], ['compound', 'GitHub'], ['compound', 'Datadog'],
  ['blend', 'Instagram'], ['blend', 'Vercel'], ['phrase', 'Hugging Face'], ['phrase', 'Liquid Death'], ['metaphor', 'Mistral'],
  ['invented (banned here)', 'Figma'], ['misspelling (banned here)', 'Lyft'], ['acronym (not a recipe)', 'Redis'],
];
export const steeringQuestion = 'Which two do you love, and which one do you hate?';
const exampleLine = () => {
  const types = new Map();
  for (const [type, name] of referenceExamples) types.set(type, [...types.get(type) ?? [], name]);
  return [...types].map(([type, names]) => type + ': ' + names.join(', ')).join('; ');
};

// Naming skill v1, the same method as the Claude Code plugin skill (skills/naming/SKILL.md). One screening call:
// triage_names checks every ending for all the names it gets and screens the first five, so the recipe skips the
// preliminary check_domains batch (check_domains with shortlist still works for existing callers).
export const namingRecipe = (about = '') => 'Naming recipe (naming skill v1). English names unless asked. The name must last.\n'
  + (about ? '1. Brief: ' + about.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim()
    + '.\n' : '1. Brief: what it does, for whom, the feel in two words, names to avoid. At most three questions.\n')
  + '2. Subject words: about 30 (objects, verbs, tools, places, roles, jargon, sounds). Pick 6 territories of meaning or sound; aim for the gap competitors leave.\n'
  + '3. Generate 150, 25 per territory, every recipe. Each name contains or puns on a subject word. No judging yet.\n'
  + '4. Filter: drop bans, over 12 letters or 3 syllables, more than one spelling by ear, hard to say, near-twins.\n'
  + '5. Screen: call triage_names ONCE with your best EIGHT, strongest first (the first five get marks, apps and rivals). '
  + 'Add about, geo from memory, any endings or budget, and candidates: per name recipe, relation (direct/loose/none), spellings, '
  + 'realWord, descriptive, misspelled, narrow, soundsLike, badMeaning, language. Missing evidence counts as not checked. Skip check_domains.\n'
  + '6. Answer: Show the tool’s answer as given. Keep the results link. Offer details only if the user asks. '
  + 'If fewer than five pass, never pad. '
  + 'The results page updates as checks finish.\n'
  + '7. Steer: ask exactly "' + steeringQuestion + '" Find what the two loved names share and what the hated one signals; '
  + 'generate the next round that way. Never re-show a rejected name.\n'
  + 'Recipes (suggestive or arbitrary, never descriptive): odd pair (default), subject word + unexpected concrete word, Loomfox; '
  + 'pun, a familiar phrase with a subject word swapped in by sound, Grepvine; blend on a shared syllable, both words audible, Inboxer; '
  + 'insider term outsiders hear as an image, Cold Kerf; phrase or character, Captain Diff.\n'
  + 'Bans (code drops them before scoring): two subject words, or one + hub/base/flow/labs/app/pro; no real word inside; '
  + '-ly, -ify, -io, dropped vowels, misspellings, numbers, hyphens; AI, GPT, bot, smart; sounds like a competitor, drug or Pokemon; '
  + 'names one feature; invented origin stories or claims about real brands.\n'
  + 'Real names by type (patterns only): ' + exampleLine() + '.';
