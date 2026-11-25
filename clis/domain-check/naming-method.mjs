export const showAsIs = 'Show `display` exactly as written, then add at most two sentences of advice below it.';
export const purchaseLine = 'Domain Hound cannot buy or complete checkout; use the link above.';

export const googleSearchInstruction = 'Before answering, use your built-in web search for each name marked google.search (up to 3). '
  + 'Search "<name>" and "<name>" app once each. Review the first 10 returned results of each search, or all results if fewer are returned. '
  + 'Count exact names only. Say Google: open if you find no same-name brand or product, Google: crowded for several unrelated uses, '
  + 'or Google: owned by <brand> if one brand dominates or a same-business product appears. '
  + 'Put any Google findings below the display. Keep the tool’s verdict, reason, traction and search links in the display. '
  + 'Then answer directly. Do not run more searches or generate replacement names.';

export const geoInstruction = 'GEO (presence in AI answers): for each name, answer from your own knowledge only, without searching or calling tools, '
  + 'whether you know a specific brand, company or product by that exact name: "known: <what it is, a few words>" or "unknown". '
  + 'Say unknown for a plain dictionary word or when unsure. Do not guess.';

export const namingRecipe = (about = '') => 'Naming recipe (intermediate). Use the final triage display.\n'
  + (about ? '1. Brief: ' + about.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim()
    + '.\n' : '1. Brief: product, audience and preferences.\n')
  + '2. Generate about 30 words. Pair one with a familiar animal or object. Avoid category-generic names.\n'
  + '3. Check: call check_domains ONCE with seven bare names and shortlist: true (Quiet Otter → quietotter). No spaces or dots.\n'
  + '4. Triage: call triage_names ONCE on only the best FIVE with free endings, a short about and geo from memory. Follow its Google search instructions.\n'
  + '5. Answer: ' + showAsIs + ' Keep all five candidates and let the person choose.';
