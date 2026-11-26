---
name: naming
description: Name a product, company, tool or domain. Use for any "what should we call it" request. Gives distinctive, protectable names with an available domain, ranked by Name score.
---

# Naming

The same method as Domain Hound's `naming_guide` tool. English names unless asked otherwise. The name must last: no rebrand later.

## Process

1. **Brief.** Read the repo or README if there is one. Otherwise ask at most three questions: what it does and for whom; the feel in two adjectives; competitors or names to avoid.
2. **Subject words.** List about 30 words from the subject: objects, verbs, tools, places, roles, jargon, sounds.
3. **Territories.** Pick 6 directions of meaning or sound (for example craft, animal, weather, mischief, speed, kitchen). Note which name types competitors use and aim for the gap.
4. **Generate.** 150 names per round, 25 per territory, mixing every recipe below. No judging yet. Every name contains or puns on a subject word.
5. **Filter before checking.** Drop hard bans, names over 12 letters or 3 syllables, names with more than one plausible spelling when heard, names that are hard to say aloud, and near-twins. Keep about 40.
6. **Check and score.** Call the Domain Hound `triage_names` tool once with your best eight, strongest first, a short `about`, and `candidates` evidence for each name (recipe, relation, spellings, realWord, descriptive, misspelled, narrow, soundsLike, badMeaning, language). It checks domains, trademarks, rivals, apps, handles and bad meanings, runs the bans in code, and returns a Name score v1 per name. Missing evidence and failed checks read "not checked", never clear. Repeat in batches for more names.
7. **Show.** Only names with an available domain, ranked by score, top 8, at least three recipes represented. If fewer than 5 pass, say so and run another round; never pad.
8. **Steer.** Ask the steering question. Work out what the two loved names share (recipe, territory, sound, length) and what the hated one signals. Run a new round of 150 in that direction. Never re-show a rejected name.

## Recipes

Aim for suggestive or arbitrary: the name hints at the subject and never describes it.

| Recipe | Pattern | Example shapes |
|---|---|---|
| Odd pair (default) | subject word + unexpected concrete real word (animal, object, weather) | Loomfox, Ledgermoth |
| Pun | familiar word or phrase with a subject word swapped in by sound | Grepvine, Lintroller |
| Blend | subject word fused with a real word on a shared syllable; both stay audible | Inboxer, Schemantis |
| Insider term | vivid jargon from the subject that outsiders hear as an image | Second Proof, Cold Kerf |
| Phrase or character | short command or persona built on a subject word | Hush Inbox, Captain Diff |

Prefer concrete imagery, hard consonants, two syllables and a story you can tell in one sentence.

## Hard bans

- Pure descriptive: two subject words, or subject word + generic word (hub, base, flow, labs, app, pro).
- Pure invented: no real word inside.
- Trend marks: -ly, -ify, -io, dropped vowels, deliberate misspellings, numbers, hyphens.
- "AI", "GPT", "bot" or "smart" in the name.
- Sounds like a competitor, a drug or a Pokemon.
- Too narrow: names one feature, not the product.
- Invented origin stories or claims about real brands.

## Red flags (penalise, note)

Easy to mock; mild bad meaning; a dormant site with the same name; needs spelling out on the phone; three syllables.

## What to show

For each name, use this format. The price and score below are from a fixture.

**Loomfox** · Name score 91/100, Strong · loomfox.com, $29 for 3 years
- Best point first (for example ".com is available")
- Biggest loss
- Second loss, or "not checked: <what>"

Label the score "how clear the road is". It is not a probability.

Then ask exactly: **"Which two do you love, and which one do you hate?"**

## Compact prompt (small model)

You name products. Input: a subject and its subject words.
Write 20 English names, one per line, format `Name | recipe | subject word used`.
Rules:
- Every name contains or puns on one subject word.
- Use these recipes in turn: (1) subject word + unexpected concrete real word, like Loomfox; (2) pun on a familiar word, like Grepvine; (3) blend on a shared syllable, like Inboxer; (4) short phrase or character, like Captain Diff.
- At most 12 letters and 3 syllables, one obvious spelling, easy to say.
- Never: two subject words together; made-up words with no real word inside; -ly, -ify, -io, hub, base, flow, labs, AI, bot; misspellings, numbers, hyphens.
- No explanations, no duplicates.
Fallback when the model fails: pair each subject word with a fixed list of concrete nouns (animals, tools, weather) and apply the same bans.

## Name score v1

0 to 100, labelled "how clear the road is". Points: best available ending 22, 3-year price 3, trademark 25, rivals 20, apps 8, handles 7 (GitHub 3, npm 2, Bluesky 2), name quality 15. A failed check earns 40% of its points and says "not checked". Trademark stays at 20 or less until the EU office answers; a failed US trademark or rival check, or missing ban evidence, keeps the total at 79 or less. Bands: 80+ Strong, 60 to 79 Workable, 40 to 59 Risky, under 40 Advise against. Bans and hard filters (no available ending within $60 over 3 years, identical live trademark in your classes, a strong same-name rival in your subject, a severe bad meaning, not English unless asked) remove a name before scoring.
