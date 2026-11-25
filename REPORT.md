STATUS: DONE

`domain-hound` 0.1.0 is ready for release review in this fresh local repository. The package is licensed MIT. Changes are confined to this copy.

## Package

`npm pack --dry-run` reports **30 files, 81,153 bytes compressed, 271,004 bytes unpacked**. The actual tarball matches the file list. The default install adds the small HTML parser used for Google Play. Playwright loads only when installed separately. Declaring it as an npm peer added over six seconds of registry lookup on a clean cache, so the package uses lazy import and the opt-in install command in the README.

```text
.agents/plugins/marketplace.json
.claude-plugin/marketplace.json
.claude-plugin/plugin.json
LICENSE
README.md
bin/domain-hound.mjs
clis/domain-check/cache.mjs
clis/domain-check/com-site.mjs
clis/domain-check/company-search.mjs
clis/domain-check/confirm.mjs
clis/domain-check/google-play.mjs
clis/domain-check/google-search.mjs
clis/domain-check/index.mjs
clis/domain-check/name-search.mjs
clis/domain-check/naming-method.mjs
clis/domain-check/parking.mjs
clis/domain-check/price-catalog.mjs
clis/domain-check/prices.mjs
clis/domain-check/registry.mjs
clis/domain-check/spaceship-feed.mjs
clis/domain-check/terms.json
clis/domain-check/traction.mjs
clis/domain-check/triage-sources.mjs
clis/domain-check/triage.mjs
display.mjs
mcp.json
package.json
plugin.json
server.json
server.mjs
```

The repository and package scan found no secrets, personal emails, hard-coded home paths, caches, check logs, or installed dependencies. Test fixtures remain in the source repository and the tarball excludes them.

## Verification

- Node 20.0.0 and Node 24.11.0 passed 123 tests each. Two tests need optional Playwright. With Playwright and Chromium enabled, all 125 tests passed on Node 24.
- `npm run smoke` checked `example-hound-test` through the vendored CLI, the source bin, and a fresh `npx` install from the packed tarball. Both MCP processes negotiated the protocol, listed four tools, and returned a registrar link and `via domainhound.dev`. Cold `npx` startup took 0.9–1.4 seconds. The lookup took about 2 seconds.
- The packed default install returned a live Google Play match for Telegram without Chromium. The optional Playwright install returned a live Spaceship quote for `example-hound-test.com`.
- Claude Code validated both manifests. Codex discovered the repo marketplace and the portable plugin’s MCP server. The portable plugin files and `server.json` passed their published schemas. [Claude Code marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference), [Codex plugin packaging](https://developers.openai.com/plugins/build/plugins), [MCP Registry schema](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json)

## Open questions before public listing

- The live npm install by name can be checked after release. This validation used the local tarball and a clean npm cache. The MCP Registry name `dev.domainhound/domain-hound` uses domain ownership verification and matches the package’s `mcpName`. [MCP Registry publishing quickstart](https://modelcontextprotocol.io/registry/quickstart), [MCP Registry authentication](https://modelcontextprotocol.io/registry/authentication)
- Anthropic’s directory validator flagged the listing icon and noted the reachable hosts. The repo marketplace passed strict validation. [Claude Code manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference#directory-listing-fields)
- Submission to OpenAI’s public directory for a local MCP plugin requires an approved organization. The repo marketplace and the direct Codex install are separate distribution paths. [OpenAI desktop-only submission](https://developers.openai.com/plugins/deploy/desktop-only)
