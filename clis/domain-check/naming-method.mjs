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

export const steeringQuestion = 'Which word would you keep, and what do you like about another name?';
const shortText = text => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim();

export const namingRecipe = (about = '') => [
  'Naming recipe from Domain Hound',
  about ? 'Brief: ' + shortText(about) : 'Ask once if the brief is missing: What does it do, for whom, in one sentence?',
  '1. Best domain: check the exact name and report the best ending, upfront price and renewal.',
  '2. Best alternative: try other suitable endings for the same name and choose the strongest available one.',
  '3. Rebrand: picture a real customer moment. Explore six territories: the job, result, familiar metaphor, object or place, role, and real-word twist.',
  'A compound can work in any territory if both words add meaning. Write 12–18 ideas across all six territories and put the strongest first. Try Glean’s verb, Sentry’s watchful role or Dropbox’s everyday action as patterns.',
  'Cut names that fail truth, recognition, connection, say-and-spell or recall. Prefer two syllables. Reject category mash-ups, forced spelling and generic endings such as -ify or -hub.',
  'Give each name a plain reason of at most 16 words naming the familiar anchor and its link to the work.',
  'Make one triage_names call with idea and up to 60 proposals. The territory field must be exactly one of: job, result, metaphor, object, role, twist.',
  'Set anchor to a familiar word appearing in the name, and repeat it in why. Send name, territory, anchor, why and optional parents. Use the original business brief as idea.',
  'Answer from that one result; do not call again to collect late checks. They fill in on the results page.',
  'Show the tool’s table as given: up to five names from different territories, each with why, domain, price now and at renewal, and settled checks.',
  '4. A name that lasts: pick an easy-to-recall checked name that can grow beyond the first feature. Name any screen still needed for the audience.',
  'When the founder is still exploring, ask: ' + steeringQuestion,
  'Keep exact liked words and remember sounds, images, tone, rejected patterns, parent names and all ideas already shown.',
  'Send updated taste, shown names, and the latest feedback on the next call. Keep one word intact and borrow the other idea’s feeling or shape. Give up to three fresh names.',
  'After three rounds compare the best three checked names. If asked to choose sooner, send pick with the selected name and its shown details to recheck it.',
].join('\n');
