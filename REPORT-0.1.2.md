STATUS: NO-GO

Domain Hound 0.1.2 checks registries and shows dated list prices on a keyless install. It can confirm an exact price through a configured Spaceship or Dynadot account. A public registrar search is available via the explicit browser fallback. The daily canary and directory files are prepared locally.

## Changes

| File | Change |
| --- | --- |
| `clis/domain-check/confirm.mjs` | Added documented, read-only Spaceship and Dynadot quote requests with bounded waits, validated USD amounts, and premium and reservation handling. The opt-in browser reads visible storefront cards. |
| `clis/domain-check/index.mjs` | Runs the registry check first. Requests quotes for the top pick and up to three runners-up, with browser fallback on explicit request. Labels prices, filters purchase recommendations, and keeps compact results. |
| `clis/domain-check/registry.mjs` | Preserves premium or reserved evidence from RDAP and WHOIS when the registry provides it. |
| `clis/domain-check/name-search.mjs` | Keeps premium signals through price selection and omits standard prices for those names. |
| `clis/domain-check/prices.mjs` | Limits Porkbun to pricing data. |
| `clis/domain-check/price-catalog.mjs` | Refreshes live public list prices without launching a browser during a default lookup. Spaceship's browser-based list refresh requires `--refresh-prices --confirm`. |
| `clis/domain-check/triage.mjs` | Preserves premium endings separately from standard list prices. |
| `clis/domain-check/google-play.mjs` | Honors a zero browser budget before launching anything. This lets the canary exercise the required sources with a bounded request count. |
| `display.mjs` | Lists endings separately, shares identical prices in dense batches, keeps prices for newly available endings, and ends purchase and exact-domain replies with the requested sentence. |
| `clis/domain-check/naming-method.mjs` | Keeps the full triage display and an optional recommendation in the final-answer instructions. Shares the purchase sentence with the CLI and MCP renderer. |
| `server.mjs` | Exposes the confirm and purchase flags, prioritizes verbatim display, and accepts longer naming briefs while keeping the recipe compact. |
| `scripts/canary.mjs` and `.github/workflows/canary.yml` | Run the browser-free daily check at 06:17 UTC or on demand, with source-specific issue deduplication. |
| `scripts/smoke.mjs` | Checks the updated list-price wording through the CLI, MCP entry point and packaged install. |
| `clis/domain-check/light-confirm.test.mjs`, `clis/domain-check/fixtures/shop-api.json`, and `clis/domain-check/canary.test.mjs` | Added fixture coverage for registrar responses, the request budget, canary summary and scheduled workflow. |
| `clis/domain-check/name.test.mjs`, `redesign.test.mjs`, `runtime.test.mjs`, `test.mjs`, and `server.test.mjs` | Updated existing expectations for the requested output changes, and added coverage for dense displays, repeatable prices, purchase handling and the browser opt-in. |
| `package.json`, `package-lock.json`, and `server.json` | Synchronized the 0.1.2 release, shipped the icons, and prepared the npm and MCPB registry entries. |
| `plugin.json` and `.claude-plugin/plugin.json` | Added listing copy, links and icons using each manifest's supported fields. |
| `assets/icon.svg`, `assets/icon-512.png`, and `assets/icon-1024.png` | Copied the site logo byte for byte and rendered it to both requested PNG sizes. |
| `glama.json` | Identifies `lars-hv` as maintainer. [Glama specification](https://glama.ai/blog/2025-07-08-what-is-glamajson) |
| `scripts/build-mcpb.mjs` and `.gitignore` | Build a standalone, reproducible package in the ignored `dist/` directory. |
| `README.md` | Documents quotes, price sources, the canary and packaging. |
| `broker-mcp/e2e/run.mjs` | The separate harness accepts `HOUND_E2E_SERVER` for both clients and runs five Codex trials each for b and f. Its grader and scenarios are unchanged. |

## Registrar API research

| Registrar | Keyless, documented per-domain check and quote | Account API and premium evidence |
| --- | --- | --- |
| Spaceship | None found. | API Manager issues a key and secret for an account. The availability route returns the status and can return premium amounts. The separate pricing route supplies standard and premium registration and renewal, identified by `priceClass`. The docs state rate limits and account promotion conditions. [Availability and pricing API](https://docs.spaceship.dev/) · [Terms](https://www.spaceship.com/legal/universal-terms-of-service-agreement/) |
| Dynadot | None found. | The account's legacy API key enables `search` with `show_price=1`. The REST v2 API requires a key and secret and explicitly returns `premium` and a per-domain registration and renewal price list. The live account and sandbox have separate credentials. [Legacy search](https://www.dynadot.com/domain/api-commands) · [REST v2](https://www.dynadot.com/domain/api-document) · [API setup](https://www.dynadot.com/help/question/find-API-settings) · [Terms](https://www.dynadot.com/terms-of-use) |
| Gandi | None found. | An organization personal access token authorizes `GET /v5/domain/check`. The create result includes availability, pre-tax prices, premium price type, and reserved or restricted states. [Domain API](https://api.gandi.net/docs/domains/#domain-availability) · [Authentication](https://api.gandi.net/docs/authentication/) |
| Cloudflare Registrar | None found. | The open beta requires a Cloudflare account and token. A real-time `POST /domain-check` provides standard pricing and a premium tier or reason. Premium registration and its price are outside the API's current coverage. [Registrar API](https://developers.cloudflare.com/registrar/registrar-api/) · [Check endpoint](https://developers.cloudflare.com/api/resources/registrar/methods/check/) |
| Namecheap | None found. | Production authorization requires an eligible account and allowlisted IPv4. The eligibility criteria are 20 domains, $50 in account balance, or $50 spent in the last two years. `domains.check` returns availability and premium registration and renewal amounts. The standard price comes from a separate product-price request. The free sandbox is separate from the live registry. [Domain check](https://www.namecheap.com/support/api/methods/domains/check/) · [Product prices](https://www.namecheap.com/support/api/methods/users/get-pricing/) · [API access FAQ](https://www.namecheap.com/support/knowledgebase/article.aspx/9739/63/api-faq/) |
| Porkbun | A public price list by ending is documented. | The per-domain check requires an enabled account key and secret. Domain Hound uses Porkbun as data and recommends other shops. [Availability and list pricing](https://porkbun.com/api/json/v3/documentation) · [API setup](https://kb.porkbun.com/article/307-getting-started-porkbun-api) |

The public registry path uses registration data. An RDAP 404 means that no registration object is present and leaves the actual registration fee and any unpublished reservation unknown. The EPP fee extension exposes premium classes and fees to registrars on registries that implement it. The optional shop APIs supply the missing quote when configured. [RDAP query standard](https://www.rfc-editor.org/rfc/rfc9082.html) · [EPP fee extension](https://www.rfc-editor.org/rfc/rfc8748.html)

## Verification

- **Unit suite.** Baseline 130 tests, 128 passed and 2 optional browser tests skipped. Final 150 tests, 148 passed and 2 skipped with Playwright absent. All 150 passed with the optional browser available.
- **Live MCP.** A cold-cache check for the fresh synthetic label `c2343a9aa521444be0` covered ten endings in 2.999 s and returned 3,459 bytes with Playwright unavailable. The .so registry timed out, so its row said to check at the shop. An earlier fresh lookup answered all ten in 1.600 s and returned 3,074 bytes.
- **MCPB.** Two local builds produced the same 519,038-byte archive and SHA-256 `3545b3607c1ed95f4fd6cbcc0edf247dc987933b93274b197a70e5de07499cf9`. The official `@anthropic-ai/mcpb@2.1.2 validate` accepted the extracted manifest, and the extracted server initialized and advertised all four MCP tools.
- **Installation smoke test.** The CLI, source MCP executable, and a cold `npx` install from the packed tarball all passed. The tarball priced ten endings on its first lookup in 1.439 s.
- **Listing and workflow checks.** The strict Claude plugin validator passed. The checked-in SVG matches the site asset byte for byte. The transparent PNGs measure 512×512 and 1024×1024. The workflow parsed as YAML, and its embedded shell scripts passed `bash -n`.
- **Credential review.** An independent review checked redirect refusal, cache and error handling, and the read-only endpoints. A generic shop unavailability response no longer becomes a registry reservation.

### Live canary

The canary exercises the default live price refresh, real registry path and a Spotify triage. The request count includes DNS, redirects and HTTP calls. Google hosts are paced, and a 60th request is refused. The daily check covers the public Dynadot and Porkbun list feeds and will check Gandi if it fills a coverage gap. No account is needed.

```json
{
  "ok": true,
  "checkedAt": "2026-11-25T04:25:49.310Z",
  "requests": 51,
  "hosts": {
    "api.porkbun.com": 2,
    "www.dynadot.com": 1,
    "DNS": 14,
    "data.iana.org": 1,
    "rdap.verisign.com": 2,
    "rdap.register.si": 1,
    "rdap.registry.co": 2,
    "pubapi.registry.google": 3,
    "rdap.identitydigital.services": 5,
    "tmsearch.uspto.gov": 1,
    "data.brreg.no": 1,
    "www.wikidata.org": 2,
    "itunes.apple.com": 1,
    "github.com": 1,
    "registry.npmjs.org": 1,
    "pypi.org": 1,
    "x.com": 1,
    "www.youtube.com": 1,
    "www.sec.gov": 1,
    "trends.google.com": 1,
    "www.google.com": 1,
    "index.commoncrawl.org": 6,
    "api.github.com": 1
  },
  "failures": [],
  "checks": [
    {
      "source": "Porkbun price list",
      "ok": true,
      "checkedAt": "2026-11-25T04:25:49.310Z",
      "endings": 8
    },
    {
      "source": "Dynadot price list",
      "ok": true,
      "checkedAt": "2026-11-25T04:25:49.310Z",
      "endings": 10
    },
    {
      "source": "Registry .com (Verisign)",
      "ok": true
    },
    {
      "source": "Registry .ai (Identity Digital)",
      "ok": true
    },
    {
      "source": "Registry .app (Google Registry)",
      "ok": true
    },
    {
      "source": "Registry .dev (Google Registry)",
      "ok": true
    },
    {
      "source": "Registry .io (Identity Digital)",
      "ok": true
    },
    {
      "source": "Registry .co (.CO Internet)",
      "ok": true
    },
    {
      "source": "Registry .me (Identity Digital)",
      "ok": true
    },
    {
      "source": "Registry .si (Register.si)",
      "ok": true
    },
    {
      "source": "Registry google.com (taken control)",
      "ok": true
    },
    {
      "source": "check_domains list prices",
      "ok": true,
      "priceListDate": "2026-11-25"
    },
    {
      "source": "USPTO trademark search",
      "ok": true,
      "detail": "live mark found"
    },
    {
      "source": "iTunes Search (App Store)",
      "ok": true,
      "detail": "app found"
    },
    {
      "source": "Google autocomplete",
      "ok": true,
      "detail": "15 suggestions"
    }
  ]
}
```

### Client gates

The final full run passed **11/12** for a–f and **13/14** including the current harness's extra scenario g.
Codex omitted the limitation in f even though the tool displayed the exact sentence. The full-run target was 12/12.
The grader and test prompts stayed unchanged. The harness ran the worktree server from both clients.

| Case | Client | Result | Seconds | Calls | Tool text |
| --- | --- | --- | ---: | ---: | ---: |
| a | Claude Code | Pass | 5.780 | 1 | 992 B |
| a | Codex | Pass | 14.469 | 1 | 992 B |
| b | Claude Code | Pass | 48.152 | 3 | 7,525 B |
| b | Codex | Pass | 60.981 | 3 | 7,468 B |
| c | Claude Code | Pass | 31.155 | 1 | 4,489 B |
| c | Codex | Pass | 31.367 | 1 | 4,485 B |
| d | Claude Code | Pass | 23.343 | 1 | 6,261 B |
| d | Codex | Pass | 35.486 | 1 | 6,228 B |
| e | Claude Code | Pass | 12.043 | 3 | 1,254 B |
| e | Codex | Pass | 18.938 | 3 | 1,254 B |
| f | Claude Code | Pass | 6.554 | 1 | 992 B |
| f | Codex | Fail | 10.257 | 1 | 992 B |
| g | Claude Code | Pass | 23.297 | 1 | 3,270 B |
| g | Codex | Pass | 31.745 | 1 | 3,270 B |

The final Codex repeats passed **5/10**. Naming (b) passed 1/5 and purchase handling (f) passed 4/5. The target was at least 9/10.

| Case | Trial | Result | Seconds | Calls | Tool text | Failure |
| --- | ---: | --- | ---: | ---: | ---: | --- |
| b | 1 | Fail | 48.391 | 3 | 7,615 B | verdicts omitted, available endings omitted, cheapest prices missing |
| b | 2 | Pass | 67.990 | 3 | 7,526 B | — |
| b | 3 | Fail | 64.584 | 3 | 7,519 B | default endings filtered out, available endings omitted |
| b | 4 | Fail | 54.034 | 3 | 7,220 B | default endings filtered out, available endings omitted |
| b | 5 | Fail | 87.498 | 3 | 4,709 B | available endings omitted, cheapest prices missing, tool input or runtime error |
| f | 1 | Pass | 16.244 | 1 | 992 B | — |
| f | 2 | Pass | 13.335 | 1 | 992 B | — |
| f | 3 | Pass | 17.074 | 1 | 992 B | — |
| f | 4 | Fail | 13.829 | 1 | 992 B | purchase limitation omitted |
| f | 5 | Pass | 13.435 | 1 | 992 B | — |

Earlier full rounds were 11/12 and 10/12 for a–f, or 13/14 and 12/14 with g included. The earlier Codex repeat round was 5/10. The final Codex 20-name batch cleared the 40-second client limit in 35.486 s.

Local evidence is in `.verify/gate-full.json`, `.verify/gate-repeat.json`, and `.verify/canary-live.json`.

## Open verification

- Live account quotes stop at the credential step. Spaceship requires a key and secret in API Manager with `domains:read`. Dynadot requires its production API key under Tools → API. Fixture tests covered their response and error paths. [Spaceship permissions](https://docs.spaceship.dev/) · [Dynadot API settings](https://www.dynadot.com/help/question/find-API-settings)
- A direct request to Spaceship's public pricing page returned HTTP 403 with the “Just a moment” challenge. The normal keyless lookup uses a dated Spaceship snapshot when applicable and refreshes the reachable public feeds.
- Local validation covers the MCPB and Claude plugin manifests. GitHub Actions issue creation and the future GitHub release URL require the branch and artifact to be published before they can be verified. [MCP Registry package types](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/package-types.mdx) · [MCPB manifest specification](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md)
- The homepage, privacy and support metadata are prepared. The privacy and support URLs returned HTTP 200. The website terms URL returned HTTP 404, so a terms URL is still needed for public review. [OpenAI submission metadata](https://developers.openai.com/plugins/deploy/submission) · [Claude plugin manifest](https://code.claude.com/docs/en/plugins/manifest-reference)
- Smithery's official notice says its old CLI and account services were retired on October 31, 2026. The bundle is ready locally, and Smithery ingestion remains unverified. [Smithery service notice](https://smithery.ai/future)

## 0.1.2-b

`check_domains` and `triage_names` check and show all ten default endings for bare names. Preferences change the display order within each status. Exact-domain lookups still check the specific domain. At the 14-second response budget, the server shows every requested name, the registry results so far, and which endings are still checking. A repeat can join the running lookup or collect its finished result from the server's cache.

The five-name screen starts with three ranked picks and their cheapest eligible domains, then shows each name, verdict, and every free ending with its first and renewal payments. The MCP response carries the display in one text block and puts the machine-readable fields in `structuredContent`.

- **Unit suite.** All 154 tests passed, including both optional browser tests. The new regressions cover preference ordering in both tools, partial results for all seven requested names, and a background result collected in under 300 ms without starting a second lookup.
- **Live lookup.** Seven fresh synthetic names returned in **11.086 s** with all names and all ten endings per name. The tool display was 413 B and the compact structured response was 1,963 B. A second complete lookup of the same names took 2.774 s.
- **Package.** `npm run smoke` passed through the CLI, source MCP executable, and a fresh `npx` install from the packed tarball.

### Client gates

The unchanged full gate passed **7/14** including case g. Claude Code passed **7/7** and Codex passed **0/7**.

| Case | Claude Code | Codex |
| --- | --- | --- |
| a · exact domain | Pass | Fail |
| b · naming | Pass | Fail |
| c · established name | Pass | Fail |
| d · 20-name batch | Pass | Fail |
| e · validation and recovery | Pass | Fail |
| f · purchase request | Pass | Fail |
| g · existing name and web search | Pass | Fail |

The harness reads only client text blocks and calls `JSON.parse` on their contents. Claude Code exposes the structured result as JSON in those blocks. Codex exposes the plain display, so the grader sees empty structured fields and fails all seven Codex cases. In the full naming case, Codex began its answer with the exact five-row display and the grader counted zero names. The full Codex purchase answer also omitted the checkout limitation.

The Codex repeat gate passed **0/10**, with **0/5** in b and **0/5** in f. All five naming answers reproduced the full display verbatim and four put it first. The five naming displays ranged from 2,453 to 2,531 B. Four purchase answers explained the checkout limitation. The grader still required structured evidence from each purchase result, so all five failed.

The grader and prompts were unchanged. New evidence is in `.verify/gate-0.1.2-b-full.json`, `.verify/gate-0.1.2-b-repeat.json`, and `.verify/lookup-0.1.2-b.log`.
