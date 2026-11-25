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

// One screening call: triage_names checks every ending for all the names it gets and screens the first five, so the
// recipe skips the preliminary check_domains batch (check_domains with shortlist still works for existing callers).
export const namingRecipe = (about = '') => 'Naming recipe (intermediate). Use the final triage display.\n'
  + (about ? '1. Brief: ' + about.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim()
    + '.\n' : '1. Brief: product, audience and preferences.\n')
  + '2. Generate about 30 words. Pair one with a familiar animal or object. Default to English unless the person asked for another language. Avoid category-generic names.\n'
  + '3. Screen: call triage_names ONCE with your best EIGHT names, strongest first (all get domains; the first five get marks, apps and rivals). '
  + 'Add a short about, geo from memory, and any endings or budget the person gave. Skip check_domains.\n'
  + '4. Answer: Relay say as written, starting with its results page line. Do not call again; the complete local results page fills in by itself.';
