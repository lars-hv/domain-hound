# Find a startup name and a domain you can actually buy

Domain Hound checks domain availability, first-year and renewal prices, app names, trademarks and social handles from Claude Code, Codex or any MCP client. It runs locally and leaves checkout to you.

![Live Domain Hound results with dated registration and renewal prices](assets/readme-search.png)

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
- **Trademarks:** live US marks (USPTO), with search links for the EU, WIPO and Norway.
- **Apps and rivals:** same-name iOS and Android apps, companies, Wikidata entities and live sites, weighed by their traction.
- **Handles:** GitHub, npm and Bluesky through their public APIs; YouTube, X, Instagram, TikTok, Facebook, LinkedIn and PyPI as links to check yourself. Each handle reads Taken, No public profile found, or Check yourself.

Registry answers and prices cover every name. Trademark, app and rival checks cover the first five names. Public handle checks start after the name screen for the top three. A repeat lookup can collect the completed checks.

The default install checks the registry and shows dated list prices. For a confirmed price, set `DOMAIN_HOUND_SPACESHIP_KEY` and `DOMAIN_HOUND_SPACESHIP_SECRET` (Spaceship permission `domains:read`), or `DOMAIN_HOUND_DYNADOT_KEY` (a production API key). Dynadot gives its production key account-wide access. Domain Hound only uses it to search. It shows premium pricing when it has a quote and points you to the shop when it has a premium signal without a price.

GitHub allows 60 anonymous API requests an hour. To check GitHub handles more often, set `DOMAIN_HOUND_GITHUB_TOKEN` to a token with no scopes; Domain Hound sends it only to `api.github.com`.

For the optional browser fallback, run `npm install domain-hound playwright && npx playwright install chromium` in a project directory and start your MCP client there. Ask for a live shop check to set the `confirm` tool flag, or use `--confirm` with the CLI.

## Guides

- [Check domain availability](https://domainhound.dev/guides/how-to-check-domain-availability/)
- [Find an available startup name](https://domainhound.dev/guides/find-an-available-startup-name/)
- [Check whether an app name is taken](https://domainhound.dev/guides/is-my-app-name-available/)

## Tools

- `check_domains` checks one name or exact domain, or up to 20 at once. A bare name checks fourteen endings. The first lookup on a fresh install shows the list prices bundled with the package, labelled with their date, while the local price list refreshes in the background.
- `triage_names` screens names against public domain, trademark, app, company, and handle data.
- `naming_method` gives your assistant a recipe for generating and screening new names.
- `watch_domain` checks the registry, expiry and website. To start a free watch, give your assistant the email it should use. Confirm the watch in your inbox. Optional news requires a separate choice in that confirmation.

- `quote_domain`, `buy_domain` and `setup_domain` work in your own Spaceship account. See below.

Completed lookups save an HTML page and a Markdown copy in `~/.domain-hound/results/`. The page lists prices, availability and sources for each ending checked. On macOS, naming and batch results open in the background. Windows and Wayland request a background open where the desktop supports it. Exact checks and watch results stay in chat with a file link. Set `DOMAIN_HOUND_OPEN=off` on the MCP server to keep every page closed.

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
- `setup_domain` points the domain at your site and mail. Website: GitHub Pages, Vercel, Netlify, Cloudflare Pages (www only), a plain IP or a CNAME. Mail: Google Workspace, Microsoft 365, Fastmail, Proton, iCloud, or forwarding only. It lists every record it will add or remove before it changes anything, removes nothing without `replace: true`, keeps one SPF and one DMARC record, and reads the result back. Account-specific values, like a Vercel IP or a DKIM record, come from your provider, never from a guess. It needs Spaceship's own nameservers and never changes them.

**Default: Spaceship's own MCP.** `buy_domain` orders nothing itself. It tells your agent to preview the order with Spaceship's `domain_register` (WHOIS privacy and auto-renew on), stop if the preview is above the quote, your max or the cap, and show you Spaceship's full confirmation with the price and payment method. Only after your yes does the agent accept that exact preview; a new preview needs a new yes. If the outcome is unclear, it stops and sends you to your Spaceship account. Once Domain Hound verifies the purchase, the agent offers DNS setup. Connect Spaceship's MCP once and sign in when asked ([Spaceship's guide](https://www.spaceship.com/knowledgebase/ai-apps-supported-by-spaceship-and-spacemail-mcp/)):

```sh
claude mcp add --transport http spaceship https://mcp.spaceship.com/mcp
codex mcp add spaceship --url https://mcp.spaceship.com/mcp
```

**Opt-in: direct purchase.** Set `DOMAIN_HOUND_DIRECT_PURCHASE=1` and `DOMAIN_HOUND_SPACESHIP_CONTACT_ID` (your owner contact ID from Spaceship, 27 to 32 letters and digits) in the MCP server settings. No tool can set either. The key then also needs `domains:billing` and `asyncoperations:read`. Direct mode buys standard-price domains only, for the registry minimum term (one year; two for .ai), after your yes (`confirm: true`); without it you get a dry run. Each domain gets one order at most. If the result is unclear, Domain Hound never retries and sends you to your Spaceship account. In direct mode the price is checked seconds before the order, but Spaceship does not guarantee it: the amounts in the answer and the local receipt are quoted estimates, and your Spaceship account shows the actual charge.

To find the contact ID, use Spaceship's `contacts_list` or read `contacts.registrant` for a domain that already uses your owner contact. [MCP tools](https://www.spaceship.com/knowledgebase/spaceship-mcp/) · [Domain info API](https://docs.spaceship.dev/#tag/Domain-Management/operation/getDomainInfo)

**Last resort: checkout.** After a valid quote, the answer ends with a Spaceship checkout link, for when Spaceship's MCP cannot be used and nothing was submitted. Check the same term, price limits, privacy and auto-renew before you pay, then ask Domain Hound to verify and set up the domain. After an unclear order there is no checkout link: check your Spaceship account first.

Quotes, DNS plans, order claims and receipts stay in `~/.domain-hound/purchases/`.

You hold the leash.

## Privacy

Lookups need no Domain Hound account. They send the relevant name or domain to public sources. Domain searches use IANA and registry RDAP/WHOIS, public DNS, and public registrar pricing. When configured, the client sends selected domains to the Spaceship or Dynadot API for a quote. The Spaceship tools send the domain and, for setup, its DNS records to your own Spaceship account. A direct purchase also sends your owner contact ID with the order. The optional browser check opens a registrar’s public search page. Name screening may also query the USPTO, Apple App Store, Google Play, Google Search and Trends, Wikidata, public company registries, the GitHub, npm and Bluesky public APIs, Tranco, Common Crawl, and candidate websites. Other social platforms are only linked, never queried. If you configure a search provider via environment variables, queries can also go to Brave Search or Serper. Results may be cached locally.

Submitting a watch sends the domain, supplied email, optional name and news choice to the Domain Hound watch service. An agent’s yes highlights the news choice. The confirmation click records whether you want it. Result pages omit your supplied email and name.

## Daily checks

Run `node scripts/canary.mjs` to check live registries, the Spotify name screen, and the public Dynadot and Porkbun price lists. It prints JSON with the status of each source and exits with a failure when a required check breaks. The GitHub Actions workflow is scheduled for 06:17 UTC and opens or updates an issue for each failing source.

## Releases

`.github/workflows/publish.yml` publishes a matching `v*` version tag to npm with Trusted Publishing and provenance. It then waits until the npm CDN serves the new tarball, runs `npx -y domain-hound@<version>` as a `tools/list` smoke test, and publishes `server.json` to the MCP Registry. The registry step needs the repository secret `MCP_REGISTRY_PRIVATE_KEY` (the hex Ed25519 private key whose public key is served at `https://domainhound.dev/.well-known/mcp-registry-auth`); without it the run ends with a notice and nothing else changes. Do not open the plain tarball URL before the workflow reports it live: the CDN caches a 404. After the first manual publish, open the package settings on npm and add GitHub Actions as a trusted publisher. Use owner `lars-hv`, repository `domain-hound`, workflow `publish.yml`, and allow `npm publish`. Use the workflow for the next unpublished version. [npm Trusted Publishing setup](https://docs.npmjs.com/trusted-publishers/)

To refresh the bundled list prices before a release, run `npm run snapshot-prices`. It copies only the local `prices.json` price list.

Run `npm run build-mcpb` on a build machine with Node.js, npm, and `zip`. It writes a standalone bundle to `dist/domain-hound-<version>.mcpb` and prints its SHA-256 for the MCPB entry in `server.json`.

Website: [domainhound.dev](https://domainhound.dev) · [Privacy](https://domainhound.dev/privacy/)

[MIT license](LICENSE)
