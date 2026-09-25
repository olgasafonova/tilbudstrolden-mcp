# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/).

## [0.5.3] - 2026-09-25

### Added

- **MCP tool annotations on all 18 tools.** Every tool now registers through `server.registerTool()` with a `ToolAnnotations` object judged from what its handler actually does. The 12 lookups are `readOnlyHint: true`. `remove_recipe` is `destructiveHint: true` and `idempotentHint: true`, so clients that confirm before destructive tools now prompt before a recipe is deleted; before this they never did. `add_recipe`, `log_meal`, `update_household` and `update_pantry` are `idempotentHint: true`. `log_spend` is marked non-idempotent, because replaying it duplicates the row. Names, descriptions, schemas and handlers are unchanged, and `src/tools/annotations.test.ts` pins the annotations.
- **A Dockerfile** (#28). Glama was guessing one and its builds were failing. Adds the `bin` entry and shebang as well.

### Fixed

- **Startup crash when only `dist/` is deployed** (#28). The version was read with `require("../package.json")` in two places, which throws with `Cannot find module` in an image without `package.json`. It is now read once in `src/version.ts` and falls back to `0.0.0-unknown` instead of taking the server down.

### Security

- **All 9 Dependabot alerts cleared** (#42): `fast-uri` 3.1.8 (4 high), `hono` 4.13.9 and `qs` 6.16.0 (5 moderate). All three come in through the MCP SDK, whose declared ranges already allowed the patched versions, so this is a lockfile refresh with no `overrides`.

### Changed

- `src/api.ts` split by responsibility, reaching CodeScene Code Health 10 (#29). Pure refactor.
- Toolchain: TypeScript 7, Vitest 5 (#40), zod 4.6, Biome 2.5, `@types/node` 26. CI runs on Node 22 to match the Dockerfile (#30).
- Dependabot enabled. Minor and patch updates are grouped, majors get their own PR, and `vitest` + `@vitest/*` majors arrive together because they pin each other as exact peers.
- `CONSTITUTION.md` added, codifying the repository's existing conventions as governance articles.

### Compatibility

No tool names, schemas or behaviour change. Drop-in upgrade from v0.5.2.

## [0.5.2] - 2026-08-10

A maintenance release with no changes to tools, schemas, or behavior.

### Security

- **All Dependabot alerts cleared.** Two rounds of dependency work: hono 4.12.27 + vite 8.1.0 (#14), then MCP SDK 1.30.0 with a full lockfile refresh clearing all 8 remaining alerts (#23, #27).

### Changed

- **`server.ts` split into per-domain tool modules** (#17), each with its own test file (#21).
- **Shopping-list builder extracted from `shopping.ts`** into `src/tools/shopping-list.ts`. Pure refactor.
- **Scoring internals decomposed** (#11, #25): `findOptimalBrute` split into focused helpers, `MatchContext` introduced for deal scoring, greedy tallies folded into `GreedyState`. CodeScene average-health badge added to the README (#26).
- Vitest coverage provider and config added (#22).

### Not in this release

- The Weekly Meal Plan MCP App widget (#18) was merged and then reverted (#19).

## [0.5.1] - 2026-05-03

### Added

- **Server-level `instructions` field on the MCP `initialize` response.** Connecting agents now receive a brief overview, country support notes, tool-group index, common-query examples, and caveats up front, instead of having to infer the server's purpose from individual tool descriptions. No tool behavior changes; this is purely additive at the protocol layer.

### Fixed

- Stale inline comment in `src/api.ts`: the `/dealers` post-hoc-filter branch listed `NO/SE` as the affected countries, but Finland goes through the same code path. Comment now reads `NO/SE/FI`. No behavior change.

## [0.5.0] - 2026-04-19

### Added

- **Finland (FI) as a fourth supported market.** Finnish households can now set `country="FI"` and receive deal data from 12 grocery chains: S-market, K-Market, K-Supermarket, K-Citymarket, Prisma, Lidl, Tokmanni, Alepa, Sale, Halpahalli, Minimani, and Saiturinpörssi.
- Finnish locale in `src/locales.ts` with processed/raw meat indicators (savustettu, marinoitu, jauheliha, tuore, …), synonym map (kana ↔ broileri, sianliha ↔ possu), dietary ingredient tags, non-food filters, and dealer IDs.
- Finnish usage example in README and a Finnish search term hint (`jauheliha`) in `search_deals` tool description.
- 19 new FI test cases across `src/integration.test.ts` and `src/scenarios.test.ts` covering scoring, synonym expansion, dietary exclusions, preferred-store filtering, and EUR currency propagation end-to-end.

### Changed

- **Currency formatting is now locale-aware.** `pricePerUnit` in parsed offers derives its symbol from the offer's currency field (€ for EUR, kr for DKK/NOK/SEK). Shopping list pack pricing, ingredient totals, spend log, and the estimated register total now use `locale.currencySymbol` instead of a hardcoded `kr`.
- Tool descriptions (`search_deals`, `list_stores`, `update_household`, startup prompt) reference all four supported countries.
- `package.json` description and README header now mention Denmark, Norway, Sweden, and Finland.

### Verification

Finnish dealer IDs were not hand-coded. Each of the 12 chains was probed against the live [etilbudsavis.dk/Tjek API](https://api.etilbudsavis.dk/v2/offers/search) using native-language queries (leipä, liha, kahvi, kana, maito, juusto). This addresses the prior commitment to never claim API coverage for a country without first probing it.

## [0.4.0] - 2026-03-18

### Added

- Norway (NO) and Sweden (SE) support: Norwegian and Swedish locales, known grocery chains, language-specific scoring indicators, and synonym maps.
- Cross-country integration and scenario test suites.

### Fixed

- Case-sensitive store matching (fixes [#1](https://github.com/olgasafonova/tilbudstrolden-mcp/issues/1)). Preferred store names now match offer store names case-insensitively.

## [0.3.0] - earlier

Initial public release. Danish-only deal search, recipe library, meal planning, shopping list generation, pantry, and spend tracking via the etilbudsavis.dk API.

[0.5.1]: https://github.com/olgasafonova/tilbudstrolden-mcp/releases/tag/v0.5.1
[0.5.0]: https://github.com/olgasafonova/tilbudstrolden-mcp/releases/tag/v0.5.0
[0.4.0]: https://github.com/olgasafonova/tilbudstrolden-mcp/releases/tag/v0.4.0
