# Domain Hound

Check whether domains are available, compare the first payment and renewal across registrars, and screen product names for conflicts. Domain Hound runs locally and never buys domains or completes checkout.

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

For optional live shop quotes, run `npm install domain-hound playwright && npx playwright install chromium` in a project directory and start your MCP client there. The default install provides a **Check at shop** link for unconfirmed quotes.

## Tools

- `check_domains` checks one name or exact domain, or up to 20 at once. A bare name checks ten endings.
- `triage_names` screens names against public domain, trademark, app, company, and handle data.
- `naming_method` gives your assistant a recipe for generating and screening new names.

## Privacy

The server has no Domain Hound account or hosted backend. Lookups send the relevant name or domain to public sources. Domain searches use IANA and registry RDAP/WHOIS, public DNS, and registrar pricing and search pages. Name screening may also query the USPTO, Apple App Store, Google Play, Google Search and Trends, Wikidata, public company and package registries, social platforms, Tranco, Common Crawl, and candidate websites. If you configure a search provider via environment variables, queries can also go to Brave Search or Serper. Results may be cached locally.

[MIT license](LICENSE)
