# Find a startup name and a domain you can actually buy

Domain Hound checks domain availability, first-year and renewal prices, app names, trademarks and social handles from Claude Code, Codex or any MCP client. It runs locally. Connect your Spaceship account to quote a domain, buy it with your approval, and set up DNS.

![Live Domain Hound results with completed app checks and dated upfront and renewal prices](assets/readme-search.png)

## Install

Requires Node.js 20 or later.

**Claude Code**

```sh
claude mcp add domain-hound -- npx -y domain-hound
```

**Codex**

```sh
codex mcp add domain-hound -- npx -y domain-hound
```

**Other MCP clients**

Add this to the client’s MCP configuration for a local stdio server.

```json
{
  "mcpServers": {
    "domain-hound": {
      "command": "npx",
      "args": ["-y", "domain-hound"]
    }
  }
}
```

Then ask, for example: “Is lanternbay.com available?”, “Find a name for my meeting-room booking app” or “Is the app name Quiet Otter taken?”

## What it checks

- **Domains:** registry RDAP or WHOIS for fourteen endings by default (.com, .ai, .io, .me, .co, .dev, .app, .si, .so, .no, .net, .org, .xyz, .tech) and, on request, .sh, .gg, .inc, .studio, .se, .dk, .de, .uk, .co.uk and .eu. A domain is never called free without a registry or shop answer.
- **Prices:** first payment, renewal and three-year cost from first-party registrar price lists, each with its date and label; renewal jumps and premium risk are flagged.
- **Trademarks:** live US marks (USPTO). EU (EUIPO) and Norwegian (Patentstyret) marks too when you set their free keys; otherwise, and for WIPO, search links to check yourself. Exact and near-identical live marks in the relevant classes (9, 35 and 42 for software) count the same at every office.
- **Meaning:** names that are, contain or sound like a rude word in 14 languages get a note and Check first, never Avoid. Word lists: [LDNOOBW](https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words), © Shutterstock, CC BY 4.0, adapted (see `clis/domain-check/meaning-words.LICENSE.txt`).
- **Apps and rivals:** same-name iOS and Android apps, companies, Wikidata entities and live sites, weighed by their traction.
- **Handles:** GitHub, npm and Bluesky through their public APIs; YouTube, X, Instagram, TikTok, Facebook, LinkedIn and PyPI as links to check yourself. Each handle reads Taken, No public profile found, or Check yourself.

Registry answers and prices cover every name. Trademark, app and rival checks cover the first five. Slow checks and public handles for the top three fill in the same results page after the first answer. A three-year savings line appears when the pick beats the middle price from at least three dated registrar lists.

The default install checks the registry and shows dated list prices. For a confirmed price, set `DOMAIN_HOUND_SPACESHIP_KEY` and `DOMAIN_HOUND_SPACESHIP_SECRET` (Spaceship permission `domains:read`), or `DOMAIN_HOUND_DYNADOT_KEY` (a production API key). Dynadot gives its production key account-wide access. Domain Hound only uses it to search. It shows premium pricing when it has a quote and points you to the shop when it has a premium signal without a price.

GitHub allows 60 anonymous API requests an hour. To check GitHub handles more often, set `DOMAIN_HOUND_GITHUB_TOKEN` to a token with no scopes; Domain Hound sends it only to `api.github.com`.

For the optional browser fallback, run `npm install domain-hound playwright && npx playwright install chromium` in a project directory and start your MCP client there. Ask for a live shop check to set the `confirm` tool flag, or use `--confirm` with the CLI.

## Guides

- [Check domain availability](https://domainhound.dev/guides/how-to-check-domain-availability/)
- [Find an available startup name](https://domainhound.dev/guides/find-an-available-startup-name/)
- [Check whether an app name is taken](https://domainhound.dev/guides/is-my-app-name-available/)

Use `check_domains` for one exact domain or up to 20 names or domains. Use `triage_names` to screen a short list or a name you already have. Ask for `naming_method` to see how a shortlist is generated.

Completed lookups save an HTML page and a Markdown copy in `~/.domain-hound/results/`. The page lists prices, availability and sources for each ending checked. On macOS, naming and batch results open in the background. Windows and Wayland request a background open where the desktop supports it. Exact checks and watch results stay in chat with a file link. Set `DOMAIN_HOUND_OPEN=off` on the MCP server to keep every page closed.

## Share

Use **Share** on the results page to send up to five names. The link carries the names, checked endings, verdicts, prices and check time after the `#`. The browser reads that part locally. Your brief and notes stay out of the link. Anyone with the full link can read the shortlist.

## Taken names

- `taken_domain_dossier` checks the registry record, website and public Atom listings. It shows sources, up to three priced alternatives with a quick name screen, and an inquiry draft when useful. Other marketplaces have manual links. The draft stays in the result.
- `watch_domain` checks the registry, expiry and website. To start a free watch, give your assistant the email it should use. Confirm the watch in your inbox. Optional news requires a separate choice in that confirmation.

## Buy and set up

Get a Spaceship price, buy within your limits, and set up DNS in your own account.

Create a key in Spaceship's API Manager. Use `domains:read` for quotes. Add `dnsrecords:read` and `dnsrecords:write` for DNS. Store the key and secret in the macOS Keychain. Each command prompts for a value.

```sh
security add-generic-password -U -s domain-hound -a spaceship-key -w
security add-generic-password -U -s domain-hound -a spaceship-secret -w
```

Or set `DOMAIN_HOUND_SPACESHIP_KEY` and `DOMAIN_HOUND_SPACESHIP_SECRET` for the MCP server. Never paste the secret into chat.

- `quote_domain` reads the live price: the exact upfront amount for the shortest term (two years for .ai), the exact renewal amount, premium status and a fresh registry check. The quote expires in 10 minutes.
- `buy_domain` needs that quote and a max you agreed to. It checks the price again and stops on any change. It stops when the quote is above your max or above `DOMAIN_HOUND_MAX_USD` (default $30). Only you can raise that cap, in the server settings. These limits apply to the quote: Spaceship sets the actual charge and does not guarantee the quoted price.
- `setup_domain` with `verify: true` writes nothing. It counts a purchase once the registry lists the domain and your Spaceship account holds it.
- `setup_domain` points the domain at your site and mail. Website: GitHub Pages, Vercel, Netlify, Cloudflare Pages (www only), a plain IP or a CNAME. Mail: Google Workspace, Microsoft 365, Fastmail, Proton, iCloud, or forwarding only. It lists every record it will add or remove before it changes anything, removes nothing without `replace: true`, keeps one SPF and one DMARC record, adds new records before it removes the ones they replace wherever DNS allows both at once, and reads the result back, including any partial change. Account-specific values, like a Vercel IP or a DKIM record, come from your provider, never from a guess. It needs Spaceship's own nameservers and never changes them.

**Default: Spaceship's own MCP.** `buy_domain` orders nothing itself. It tells your agent to preview the order with Spaceship's `domain_register` (WHOIS privacy and auto-renew on), stop if the preview is above the quote, your max or the cap, and show you Spaceship's full confirmation with the price and payment method. Only after your yes does the agent accept that exact preview; a new preview needs a new yes. If the outcome is unclear, it stops and sends you to your Spaceship account. Once Domain Hound verifies the purchase, the agent offers DNS setup. Connect Spaceship's MCP once and sign in when asked ([Spaceship's guide](https://www.spaceship.com/knowledgebase/ai-apps-supported-by-spaceship-and-spacemail-mcp/)):

```sh
claude mcp add --transport http spaceship https://mcp.spaceship.com/mcp
codex mcp add spaceship --url https://mcp.spaceship.com/mcp
```

**Opt-in: direct purchase.** Set `DOMAIN_HOUND_DIRECT_PURCHASE=1` and `DOMAIN_HOUND_SPACESHIP_CONTACT_ID` (your owner contact ID from Spaceship, 27 to 32 letters and digits) in the MCP server settings. No tool can set either. The key then also needs `domains:billing` and `asyncoperations:read`. Direct mode buys standard-price domains only, for the registry minimum term (one year; two for .ai), after your yes (`confirm: true`); without it you get a dry run. Each domain gets one order at most. If the result is unclear, Domain Hound never retries and sends you to your Spaceship account. In direct mode the price is checked seconds before the order, but Spaceship does not guarantee it: the amounts in the answer and the local receipt are quoted estimates, and your Spaceship account shows the actual charge.

If Spaceship refuses the order with a documented error (say, insufficient funds or an invalid contact), no order exists: Domain Hound says why and frees the domain for a fresh quote. A timeout, a server error or an answer it cannot read counts as unclear.

Each direct order keeps a claim file in `claims/` in the purchase folder. Its status is `"checking"` during the last price check (nothing sent yet), `"sending"` from just before the order, `"sent"` once Spaceship accepted it, and `"uncertain"` when the outcome is unknown. Any claim blocks another order. While one is `"checking"`, other calls answer that another purchase of this domain is in progress and name the file. If Domain Hound stopped mid-check and no purchase is running, stop every Domain Hound instance that uses that purchase folder, check that the file's status is exactly `"checking"`, move the file out of the folder, and get a fresh quote. Any other status means an order may exist: leave the file and check your Spaceship account.

To find the contact ID, use Spaceship's `contacts_list` or read `contacts.registrant` for a domain that already uses your owner contact. [MCP tools](https://www.spaceship.com/knowledgebase/spaceship-mcp/) · [Domain info API](https://docs.spaceship.dev/#tag/Domain-Management/operation/getDomainInfo)

**Last resort: checkout.** After a valid quote, the answer ends with a Spaceship checkout link, for when Spaceship's MCP cannot be used and nothing was submitted. Check the same term, price limits, privacy and auto-renew before you pay, then ask Domain Hound to verify and set up the domain. After an unclear order there is no checkout link: check your Spaceship account first.

Quotes, DNS plans, order claims and receipts stay in `~/.domain-hound/purchases/`. `DOMAIN_HOUND_PURCHASE_DIR` moves them; a relative path is resolved once, when the server starts.

## Privacy and lookup hosts

Domain Hound uses your brief locally. Availability queries use registries and DNS. The name screen shares candidate names with public evidence sources. Catalog downloads carry no candidate name. With shop keys configured, one pick per lookup goes to the shop for a quote by default. Set `DOMAIN_HOUND_SHOP_QUOTES=top4` to include up to three runners-up. Clicking a results link to a shop or search site sends the name in that link.

| Host or service | What the lookup sends |
| --- | --- |
| `data.iana.org`; `whois.iana.org` | RDAP routing table request with no name; WHOIS referral request with only the ending. |
| The DNS resolvers configured on your device, authoritative DNS servers, and the registry’s RDAP or WHOIS host. RDAP routes come from IANA or use `rdap.registry.co`, `rdap.identitydigital.services`, `rdap.norid.no` and `rdap.nic.so`. WHOIS for .ai, .io and .me goes to `whois.nic.ai`, `whois.nic.io` and `whois.nic.me`. | Candidate or rival domain. A DNS routing query can contain just an ending or a nameserver hostname. Registry referrals and redirects can select another registry host. |
| Candidate website and public hosts it redirects to | The domain in a homepage request; an onward request can include a URL provided by that website. |
| `tmsearch.uspto.gov` | Candidate name, spelling variants and relevant trademark class numbers. |
| `api.euipo.europa.eu` and `euipo.europa.eu` (sandbox: `api-sandbox.euipo.europa.eu` and `auth-sandbox.euipo.europa.eu`) | With EUIPO credentials, the token host gets the client ID and secret. The search host gets the client ID, access token and candidate spellings. |
| `api.patentstyret.no` | With a subscription key, the Norwegian office gets the key and candidate spellings. |
| `mcp.atom.com` | The taken domain for an exact listing lookup. The buyer's ceiling stays local. |
| `itunes.apple.com`, `play.google.com` | Candidate name for US store search; Google Play may also get the ID of a matched app. |
| `www.wikidata.org`, `www.google.com`, `trends.google.com`, `data.brreg.no` | Candidate name; Wikidata also gets entity or class IDs for matches. |
| `api.github.com`, `registry.npmjs.org`, `public.api.bsky.app` | Candidate name or handle, handle variants and public controls. With a GitHub token configured, it goes only to GitHub. |
| `www.sec.gov`, `tranco-list.eu` | Public company and site lists with no candidate name. |
| `index.commoncrawl.org` | Rival domain for a public crawl count. The index list request has no name. |
| `api.porkbun.com`, `www.dynadot.com`, `www.gandi.net` | Public price catalogs, sometimes filtered by ending. The standalone exact-price CLI may also ask `data.norges-bank.no` for USD/NOK with no name. |
| `spaceship.dev`, `api.dynadot.com`; `api.porkbun.com` for the standalone exact-price CLI | With configured credentials, the selected domain and the relevant shop credentials. The Spaceship API also gets quote and purchase details, the owner contact ID on a direct order, or DNS records for approved setup. |
| `mcp.spaceship.com` | When you use Spaceship's own MCP, your assistant passes the domain and the registration options to Spaceship. |
| `www.spaceship.com`, `www.namecheap.com`, `www.dynadot.com`, `www.cloudflare.com` | Optional live browser check sends only the selected domain. Storefront pages can load supporting assets. A manual Spaceship price refresh opens its public catalog without a candidate name. |
| `api.search.brave.com` or `google.serper.dev` | Candidate search when you configure a search provider. |

Results and caches are local. The share viewer receives its shortlist from the URL fragment in the browser. The site receives the page request without that fragment.

Submitting a watch sends the domain, supplied email, optional name and news choice to `domainhound-alerts.domainhound.workers.dev`. An agent’s yes highlights the news choice. The confirmation click records whether you want it. Result pages omit your supplied email and name.

## Optional EU and Norwegian trademark keys

- **EUIPO.** Create an EUIPO account, register an app and subscribe to Trademark Search. Production access requires approval. Set `DOMAIN_HOUND_EUIPO_CLIENT_ID` and `DOMAIN_HOUND_EUIPO_CLIENT_SECRET` for the local CLI or MCP server. Set `DOMAIN_HOUND_EUIPO_SANDBOX=1` to use sandbox data. [EUIPO setup](https://dev.euipo.europa.eu/getting-started)
- **Patentstyret.** Create a developer account, subscribe to the open data product that includes the MCP endpoint, and set `DOMAIN_HOUND_PATENTSTYRET_KEY` for the local CLI or MCP server. [Patentstyret setup](https://developer.patentstyret.no/docs-get-access)

Without keys, or when an office returns an incomplete answer, the results page links to the office's manual search. WIPO is always a manual link.

## Daily checks

Run `node scripts/canary.mjs` to check live registries, the Spotify name screen, and the public Dynadot and Porkbun price lists. It prints JSON with the status of each source and exits with a failure when a required check breaks. The GitHub Actions workflow is scheduled for 06:17 UTC and opens or updates an issue for each failing source.

## Releases

`.github/workflows/publish.yml` publishes a matching `v*` version tag to npm with Trusted Publishing and provenance. It then waits until the npm CDN serves the new tarball, runs `npx -y domain-hound@<version>` as a `tools/list` smoke test, and publishes `server.json` to the MCP Registry. The registry step needs the repository secret `MCP_REGISTRY_PRIVATE_KEY` (the hex Ed25519 private key whose public key is served at `https://domainhound.dev/.well-known/mcp-registry-auth`); without it the run ends with a notice and nothing else changes. Do not open the plain tarball URL before the workflow reports it live: the CDN caches a 404. After the first manual publish, open the package settings on npm and add GitHub Actions as a trusted publisher. Use owner `lars-hv`, repository `domain-hound`, workflow `publish.yml`, and allow `npm publish`. Use the workflow for the next unpublished version. [npm Trusted Publishing setup](https://docs.npmjs.com/trusted-publishers/)

To refresh the bundled list prices before a release, run `npm run snapshot-prices`. It copies only the local `prices.json` price list.

Run `npm run build-mcpb` on a build machine with Node.js, npm, and `zip`. It writes a standalone bundle to `dist/domain-hound-<version>.mcpb` and prints its SHA-256 for the MCPB entry in `server.json`.

Website: [domainhound.dev](https://domainhound.dev) · [Privacy](https://domainhound.dev/privacy/)

[MIT license](LICENSE)
