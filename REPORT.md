STATUS: DONE

Domain Hound 0.1.1 is ready on the local `release/domain-hound-0.1.1` branch. Its first `check_domains` call can show prices with an empty cache. The package includes the November 24, 2026 first-party list prices for all ten endings from Spaceship, Porkbun and Dynadot. The response labels estimates with their date and starts the background refresh without waiting for the price list.

The README includes working GitHub install commands for Claude Code, Codex and JSON-based MCP clients. It identifies npm as the default after publication. The tag workflow verifies the version, runs the tests and publishes with npm Trusted Publishing and provenance once configured. [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)

## Verification

- The packed 0.1.0 reproduced the missing prices in a clean cache. A cold `npx -y file:<tarball>` launch of 0.1.1 showed dated prices for all ten endings on its first MCP call. With network access denied and registries stubbed, the tarball returned a $9.48 Spaceship .com list estimate even when the registry could not settle availability.
- All 130 tests passed on Node 24 with network access denied and optional Playwright installed. The default install passed 128 tests and skipped the two optional Playwright cases.
- A clean-directory launch of `npx -y github:lars-hv/domain-hound` initialized the current GitHub version. The 0.1.1 tarball contains 31 files, including the dated catalog.

The npm publish and OIDC handshake remain unverified until the caller publishes and configures the package. The branch has no remote push or release tag.
