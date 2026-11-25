export const showAsIs = 'Show `display` to the person as is, then add your advice below it.';

export const googleSearchInstruction = 'Before answering, use your built-in web search for each name marked google.search (up to 3). '
  + 'Search "<name>" and "<name>" app once each. Review the first 10 returned results of each search, or all results if fewer are returned. Fill google.result and update the Google line using its search link. '
  + 'Count exact names only. Say Google: open if you find no same-name brand or product, Google: crowded for several unrelated uses, '
  + 'or Google: owned by <brand> if one brand dominates or a same-business product appears. '
  + 'Use Google results to update the Google line and cite additional same-name uses after the display. Keep the tool’s verdict, full reason, traction and dormant notes in the table. '
  + 'If you cannot search, keep the original Google line. Write the Google result and both app-store results with their links in every name row. '
  + 'Then answer directly. Do not run more searches, generate replacements, or repeat a Domain Hound call.';

export const geoInstruction = 'GEO (presence in AI answers): for each name, answer from your own knowledge only, without searching or calling tools, '
  + 'whether you know a specific brand, company or product by that exact name: "known: <what it is, a few words>" or "unknown". '
  + 'Say unknown for a plain dictionary word or when unsure. Do not guess.';

export const namingRecipe = (about = '') => 'Naming recipe (intermediate). Use the final triage display.\n'
  + (about ? '1. Brief: ' + about.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim()
    + '.\n' : '1. Brief: product, audience and preferences.\n')
  + '2. Generate about 30 words. Pair one with a familiar animal or object. Avoid category-generic names.\n'
  + '3. Check: call check_domains ONCE with seven bare names and shortlist: true (Quiet Otter → quietotter). No spaces or dots.\n'
  + '4. Triage: call triage_names ONCE on only the best FIVE with free endings, a short about and geo from memory. Follow its Google search instructions.\n'
  + '5. Answer: copy the final table. Update only the Google result. Keep every row with all prices and links. Never buy.';
