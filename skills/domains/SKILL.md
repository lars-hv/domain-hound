---
name: domains
description: Use when someone asks “is X.com taken?”, “find a domain”, “buy a domain”, “cheapest .ai”, or wants renewal prices or a release watch.
when_to_use: "Domain availability, exact domain lookups, cheapest place to register, .ai renewal costs, buy or register a domain, watch a taken domain, or manage domains already owned."
---

# Domains

- Start with `check_domains` for an exact domain or up to 20 names, including price comparisons. Pass the requested endings, eligibility and budget when given. Keep registry status, dated list prices, live quotes and premium prices distinct. Only use `confirm: true` for an explicit live shop check.
- For product, company or app names or trademark screening, start with `triage_names`. Use `naming_guide` when asked for the naming method. Use `my_domains` for expirations and renewal costs on owned domains.
- To buy, set `purchase: true` on `check_domains`, then get a live `quote_domain`. Show the domain, term, upfront amount and renewal. Use `buy_domain` with the unexpired quote and the approved upfront limit. Show the exact Spaceship confirmation and get approval before accepting it. Stop if the price changes or the outcome is unclear. After purchase, call `setup_domain` with `verify: true`. Get separate approval before applying DNS changes.
- Use `taken_domain_dossier` for public evidence or an offer draft. Leave any sending to the person. Use `watch_domain` only when asked for a release watch. Preview without an email. Use the email the person provides and follow the tool’s optional news consent instructions.
- Follow the server’s instructions for presenting results.
