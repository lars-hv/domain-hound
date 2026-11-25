# Domain Hound

Check whether domains are available, compare the first payment and renewal across registrars, and screen product names for conflicts. Domain Hound runs locally and never buys domains or completes checkout.

## Install

Requires Node.js 20 or later.

### Works now (from GitHub)

**Claude Code**

```sh
claude mcp add domain-hound -- npx -y github:lars-hv/domain-hound
```

**Codex**

```sh
codex mcp add domain-hound -- npx -y github:lars-hv/domain-hound
```

**Other MCP clients**

Add this to the client’s MCP configuration for a local stdio server.

```json
{
  "mcpServers": {
    "domain-hound": {
      "command": "npx",
      "args": ["-y", "github:lars-hv/domain-hound"]
    }
  }
}
```

### From npm (the default once published)

```sh
claude mcp add domain-hound -- npx -y domain-hound
codex mcp add domain-hound -- npx -y domain-hound
```

For other MCP clients, use `"args": ["-y", "domain-hound"]` in the configuration above.

The default install checks the registry and shows dated list prices. For a confirmed price, set `DOMAIN_HOUND_SPACESHIP_KEY` and `DOMAIN_HOUND_SPACESHIP_SECRET` (Spaceship permission `domains:read`), or `DOMAIN_HOUND_DYNADOT_KEY` (a production API key). Dynadot gives its production key account-wide access. Domain Hound only uses it to search. It shows premium pricing when it has a quote and points you to the shop when it has a premium signal without a price.

For the optional browser fallback, run `npm install domain-hound playwright && npx playwright install chromium` in a project directory and start your MCP client there. Ask for a live shop check to set the `confirm` tool flag, or use `--confirm` with the CLI.

## Tools

- `check_domains` checks one name or exact domain, or up to 20 at once. A bare name checks ten endings. The first lookup on a fresh install shows the list prices bundled with the package, labelled with their date, while the local price list refreshes in the background.
- `triage_names` screens names against public domain, trademark, app, company, and handle data.
- `naming_method` gives your assistant a recipe for generating and screening new names.

## Privacy

The server has no Domain Hound account or hosted backend. Lookups send the relevant name or domain to public sources. Domain searches use IANA and registry RDAP/WHOIS, public DNS, and public registrar pricing. When configured, the client sends selected domains to the Spaceship or Dynadot API for a quote. The optional browser check opens a registrar’s public search page. Name screening may also query the USPTO, Apple App Store, Google Play, Google Search and Trends, Wikidata, public company and package registries, social platforms, Tranco, Common Crawl, and candidate websites. If you configure a search provider via environment variables, queries can also go to Brave Search or Serper. Results may be cached locally.

## Daily checks

Run `node scripts/canary.mjs` to check live registries, the Spotify name screen, and the public Dynadot and Porkbun price lists. It prints JSON with the status of each source and exits with a failure when a required check breaks. The GitHub Actions workflow is scheduled for 06:17 UTC and opens or updates an issue for each failing source.

## Releases

`.github/workflows/publish.yml` publishes a matching `v*` version tag to npm with Trusted Publishing and provenance. After the first manual publish, open the package settings on npm and add GitHub Actions as a trusted publisher. Use owner `lars-hv`, repository `domain-hound`, workflow `publish.yml`, and allow `npm publish`. Use the workflow for the next unpublished version. [npm Trusted Publishing setup](https://docs.npmjs.com/trusted-publishers/)

To refresh the bundled list prices before a release, run `npm run snapshot-prices`. It copies only the local `prices.json` price list.

Run `npm run build-mcpb` on a build machine with Node.js, npm, and `zip`. It writes a standalone bundle to `dist/domain-hound-<version>.mcpb` and prints its SHA-256 for the MCPB entry in `server.json`.

[MIT license](LICENSE)
