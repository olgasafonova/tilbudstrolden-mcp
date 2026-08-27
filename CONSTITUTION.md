# TilbudsTrolden Constitution

This document holds the governance articles for tilbudstrolden-mcp. These articles are **non-negotiable** and **not subject to per-feature override**. They apply to every commit, pull request, and release regardless of urgency or scope.

This document does not change without an explicit constitutional amendment: a dedicated pull request that modifies only this file, reviewed by the maintainer. A feature pull request that would violate an article does not get an exception; it either changes to comply, or it waits behind an amendment.

**Every article below codifies something the repository already does.** No article invents a new requirement. Each names the file or pattern it is drawn from, and each states honestly whether a linter, a test, or a CI job enforces it, or whether it rests on review alone. An article that claims enforcement it does not have is worse than one that admits it has none, because the false claim stops anyone from adding the missing check.

This is the one TypeScript server in a portfolio of Go MCP servers, so the portfolio's Go machinery translates rather than copies: golangci-lint becomes Biome plus `tsc --noEmit`, the panic-recovery wrapper becomes per-handler structured errors, and gofmt becomes Biome's formatter, which runs inside the same `biome check` the lint script calls.

Written 27-08-2026 against `main` at `@modelcontextprotocol/sdk` ^1.30.0, 18 registered tools and 3 prompts.

---

## Article I: Tool registration is declarative, per-domain, and tested through the real path

Adding a tool means one `server.registerTool(name, { description, inputSchema, annotations }, handler)` call inside the matching domain module in `src/tools/` (deals, household, recipes, scoring, shopping, tracking), whose `register*Tools` function `src/server.ts` calls once at startup (shape amended 27-08-2026 with Article XII; previously the deprecated 4-arg `server.tool` overload, which carried no annotations). Tests do not re-implement registration: `test/mcp-harness.ts` captures the same `registerTool` calls through a stub — annotations included — and its `callTool` parses raw arguments through `z.object(tool.schema)` — the same validation the SDK applies — before running the handler. The harness lives outside `src/` on purpose, so it never reaches `dist/` and Biome (scoped to `src/**`) never lints it.

Codifies: `src/server.ts`, `src/tools/*.ts` (each ends in a `register*Tools` function), `test/mcp-harness.ts`.

**Enforcement: mechanically checked per module, with one hole.** `deals.test.ts` "registers the four deal tools", `household.test.ts:43` "registers the four household and pantry tools", `recipes.test.ts:50` "registers the three recipe tools", `tracking.test.ts:50` "registers the four tracking tools", all under `npm test` in CI. The hole: the tests import the register functions directly, so no test pins the total of 18 or fails if a `register*Tools` call is dropped from `src/server.ts`. That wiring rests on review.

---

## Article II: Every tool argument is validated by a Zod schema, and defaults live in the schema

Every tool declares its arguments as a Zod shape with constraints, descriptions, and defaults declared in the schema itself — `limit` defaults to 20 on `search_deals`, 50 on `get_store_offers`, 30 on `deals_this_week`; `weeks` to 4 and 8 on the history tools; `excludePantry` to true. A handler never invents a fallback for a value the schema already defaults, and invalid input is rejected before the handler runs.

Codifies: the Zod shapes in every `server.tool` call across `src/tools/*.ts`; `test/mcp-harness.ts` `callTool`, which routes test input through the same schemas.

**Enforcement: mechanically checked.** `deals.test.ts` "defaults the limit to 20 via the schema" and "rejects a call with no query"; `household.test.ts:191` "defaults both add and remove to empty arrays"; equivalents across the other module test files. `tsc --noEmit` under `strict: true` backs the types; both run in CI.

---

## Article III: A tool call never throws; failures return structured errors that name the operation

Every handler wraps its body in try/catch and returns `errorResult(...)` from `src/tools/shared.ts` — an `isError: true` MCP result whose text names what failed ("Failed to search deals: ...") — including when the thrown value is not an `Error`. This is the TypeScript counterpart of the portfolio's Go panic-recovery article: there is no generic wrapper here, so the guarantee is per-handler, and each handler's test file carries the tests that keep it true.

Codifies: `errorResult` in `src/tools/shared.ts`; the try/catch in every `handle*` function in `src/tools/*.ts`.

**Enforcement: mechanically checked per existing handler.** `deals.test.ts` "returns a structured error instead of throwing when the API fails", "still reports something useful when a non-Error value is thrown", "returns a structured error when the household lookup itself fails"; parallel tests in the other module suites. Nothing forces a newly added handler to carry the try/catch except the convention of writing the matching test; that gap rests on review.

---

## Article IV: Every response is bounded and counted, and zero results are said in words

No tool returns an unbounded or uncounted payload. List responses carry an explicit count in the header ("Found N deals", "N stores", "Pantry (N items)", "# Recipe scores (N recipes)"). Caps are real numbers: search overfetches at `limit * 3` to survive filtering, then slices to `limit`; `deals_this_week` shows at most 10 best-savings offers and 5 expiring offers per store; the store directory fetch caps at 100. An empty result is a sentence, not an empty body: "No offers found.", "No recipes to score. Add recipes first.", "Pantry is empty. Use update_pantry ...". Raising a default cap is a change to this article's terms and belongs in an amendment.

Codifies: `formatOfferList` in `src/tools/shared.ts` ("No offers found."), `topSavings` and `formatExpiringSoon` in `src/tools/deals.ts`, the `limit * 3` overfetch in `src/api.ts` `searchDeals`, `NO_RECIPES_TEXT` in `src/tools/recipes.ts`, the pantry counts in `src/tools/household.ts`.

**Enforcement: mechanically checked for the count and zero-result half.** `deals.test.ts` "says so explicitly when there are no hits" and "returns a zero count rather than an empty body for a no-match filter"; `scoring.test.ts:308` asserts the empty-library sentence; `household.test.ts:212` pins "Pantry (0 items): (empty)". No test asserts that a future list tool has a cap; that half rests on review.

---

## Article V: A tool description tells the model when not to use the tool

Every description opens with what the tool does, then `USE WHEN:` naming the situations it serves, and — on every tool with a confusable sibling — `NOT FOR:` naming the sibling to use instead (`search_deals` vs `get_store_offers` vs `deals_this_week`; `score_recipes` vs `generate_shopping_list` vs `plan_and_shop`). Those cross-references are load-bearing disambiguation and MUST NOT be dropped when a description is shortened. The server-level `instructions` block in `src/server.ts` carries the same tool-group map for connecting agents. Removing a `NOT FOR` cross-reference or renaming a tool is a breaking change under Article X, whatever happened to the code behind it.

Codifies: every `server.tool` description in `src/tools/*.ts`; the `instructions` field in `src/server.ts` (added in 0.5.1 per `CHANGELOG.md`).

**Enforcement: mechanically checked for three of six modules.** `deals.test.ts` "tells the model when not to use each tool" (asserts `USE WHEN` plus `/NOT FOR|Requires/` on all four), `shopping.test.ts:103` the same for both shopping tools, `scoring.test.ts:301` asserts `NOT FOR` on `score_recipes`. The household, recipes, and tracking modules have no description-shape test, and their read/log tools carry `USE WHEN` without `NOT FOR`; on those the shape rests on review.

---

## Article VI: All outbound HTTP goes through one chokepoint with timeout, retry, and a concurrency cap

Every request to the etilbudsavis.dk API goes through `fetchJson` in `src/http.ts`: an 8-second `AbortSignal.timeout` per attempt, up to 3 attempts with exponential backoff (500 ms base) on 429 and 5xx only, any other non-OK status failing immediately because retrying will not help, and a versioned `User-Agent` (`tilbudstrolden-mcp/<version>`). Batch fanout goes through `withConcurrencyLimit` with `MAX_CONCURRENT = 4`. A new endpoint call that reaches for `fetch` directly bypasses all of it and MUST NOT be merged. Verified while writing this: `fetch(` appears nowhere in `src/` outside `src/http.ts:26`.

Stated honestly rather than aspirationally: the repository does not propagate a caller-side abort signal from the MCP request into handlers. The per-request timeout is the actual cancellation bound, and this article claims nothing more.

Codifies: `src/http.ts` (`fetchJson`, `attemptFetch`, `withConcurrencyLimit`, `MAX_CONCURRENT`); `src/api.ts`, which imports only `fetchJson` for transport.

**Enforcement: none mechanical.** There is no `http.test.ts`, and no test asserts the retry or timeout behaviour. The article rests on `src/api.ts` being the only API surface and on review of anything that imports `node:http` or calls `fetch`.

---

## Article VII: Deal-aware tools fail closed, and every refusal names the tool that fixes it

A tool that needs configuration the user has not provided refuses with instructions rather than guessing. `deals_this_week` with no preferred stores returns "No preferred stores configured. Use update_household to add stores first (use list_stores to find dealer IDs)." An empty recipe library points at `add_recipe`; an empty pantry points at `update_pantry`; `get_household` on an unconfigured household returns onboarding guidance. The error is a route to recovery, not a dead end.

Codifies: `handleDealsThisWeek` in `src/tools/deals.ts`, `NO_RECIPES_TEXT` in `src/tools/recipes.ts`, the pantry and household onboarding text in `src/tools/household.ts`.

**Enforcement: mechanically checked.** `deals.test.ts:300` "refuses to guess when no preferred stores are configured", `household.test.ts:217` "points at update_pantry when the pantry is empty", `scoring.test.ts:304-308` "says there is nothing to score when the library is empty" ("No recipes to score. Add recipes first."). All run under `npm test` in CI.

---

## Article VIII: The data file is the only mutable state, and every write goes through the mutex

All persistent state — household, pantry, recipes, meal history, spend log — lives in one JSON file at `~/.tilbudstrolden.json` (override: `TILBUDSTROLDEN_DATA`), validated with a Zod schema on every load. Every write goes through the async mutex in `src/store.ts`: `save` and `modify` wrap `withLock`, and `modify` is the read-modify-write path that keeps concurrent tool calls from corrupting the file. `saveRaw` is module-private; nothing else in `src/` calls `fs.writeFile` (verified). The data file is gitignored.

Stated honestly: when the file exists but fails schema validation, `loadRaw` logs the issues and returns an empty store, and the next save overwrites the corrupt file. Recovery here favours availability over preservation. That is the current, deliberate behaviour — this article records it so nobody mistakes the store for a preservation guarantee.

Codifies: `src/store.ts` (`withLock`, `modify`, `DataStoreSchema`, `getStorePath`); `.gitignore` (`.tilbudstrolden.json`).

**Enforcement: none mechanical.** There is no `store.test.ts`; the tool test suites mock `store.js` entirely. The mutex discipline rests on `saveRaw` being unexported and on review.

---

## Article IX: Country coverage is probed live before it is claimed

A country, chain, or dealer ID is never added on documentation or guesswork. The 0.5.0 release records the standard: all 12 Finnish chains were probed against the live etilbudsavis.dk API with native-language queries before Finland was claimed, against the explicit commitment "to never claim API coverage for a country without first probing it." The country-specific quirks that probing surfaced are encoded in `src/api.ts`: DK uses the `/dealers` allowlist because the endpoint works there; NO/SE/FI filter on `dealer.country` from the raw response because upstream ignores `country_id` on `/dealers`.

Codifies: `CHANGELOG.md` 0.5.0 "Verification"; the DK-vs-non-DK branches in `src/api.ts` `searchDeals` and the curated `knownStores` per locale in `src/locales.ts`.

**Enforcement: partially mechanical.** `src/integration.test.ts` runs a "locale completeness" suite per country over `SUPPORTED_COUNTRIES` (indicators, synonyms, dealer IDs, currency), so a half-filled locale fails CI. The live-probe half is process, not code: nothing mechanical re-probes a chain, and that half rests on the changelog discipline.

---

## Article X: Semantic versioning, one version source, and the changelog is part of the change

The version lives in `package.json` and nowhere else: `src/version.ts` reads it at runtime (falling back to `0.0.0-unknown` rather than crashing), the `User-Agent` carries it, and the `Dockerfile` copies `package.json` into the runtime stage specifically so that read works in the container. Releases are tagged (`v0.3.0` through `v0.5.2`, each with a GitHub release) and recorded in `CHANGELOG.md` in Keep a Changelog form.

On this surface, "breaking" means: removing a tool, renaming a tool, making an optional argument required, narrowing accepted values, or removing a `NOT FOR` disambiguation from a description (Article V). None of these ship in a patch or minor release.

Stated honestly: the discipline has already slipped once. `v0.5.2` was released on 10-08-2026 and `CHANGELOG.md`'s latest entry is 0.5.1. Nothing mechanical catches a release without a changelog entry, and this article exists partly because that gap is now on record.

Codifies: `src/version.ts`, `package.json`, `Dockerfile` (the runtime-stage `COPY package.json` comment), `CHANGELOG.md`, the tag and release history.

**Enforcement: none.** No CI job checks that a release commit touched `CHANGELOG.md`.

---

## Article XI: CI runs the full quality gate on every push and pull request

`.github/workflows/ci.yml` runs, on every push to `main` and every pull request: `npm ci`, `npm run lint` (Biome check over `src/` — linting, formatting, and import organization in one pass), `npm run typecheck` (`tsc --noEmit`, strict), `npm test` (Vitest), and `npm run build`, on Node 22 pinned to match the Dockerfile. `CODEOWNERS` requires maintainer approval on workflow changes. Dependabot runs weekly with majors ungrouped — the rationale is written in `.github/dependabot.yml` itself: a grouped bump once carried TypeScript 5.3 to 7.0.2 unlabelled and broke typecheck.

Verified locally on 27-08-2026 at `7ae6131`: lint exits 0 with one warning (`noExcessiveCognitiveComplexity`, level `warn`, in `src/locales.ts`), typecheck clean under TypeScript 7.0.2, 380 of 380 tests pass in 11 files, build clean.

Two honest limits. Biome's cognitive-complexity rule is set to `warn` in `biome.json`, so it can never fail CI. And coverage has no threshold gate — what the config does guarantee is honest reporting: `vitest.config.ts` sets `coverage.all: true` so an untested module shows as 0% instead of vanishing from the report, with the reasoning in a comment at that line.

Codifies: `.github/workflows/ci.yml`, `.github/CODEOWNERS`, `.github/dependabot.yml`, `biome.json`, `vitest.config.ts`, the `scripts` block in `package.json`.

**Enforcement: mechanically checked by definition** — this article describes the enforcement layer itself. Its own weak points are the two limits named above.

---

## Article XII: Annotations tell the truth about what a tool does

Every registration goes through `server.registerTool(name, { description, inputSchema, annotations }, handler)` and declares `ToolAnnotations` that match the handler's actual behaviour: pure lookups carry `readOnlyHint: true`, `remove_recipe` carries `destructiveHint: true`, upsert-style writers (`add_recipe`, `log_meal`, `update_household`, `update_pantry`) carry `idempotentHint: true`, and `log_spend` — a pure append that duplicates on replay — carries `destructiveHint: false, idempotentHint: false`. A hint that cannot be argued from the handler stays unset so the client falls back to the spec's conservative defaults; no tool claims both read-only and destructive. Ratified by amendment 27-08-2026, closing the gap previously recorded under "Articles considered and rejected".

Codifies: the `annotations` object in every `server.registerTool` call across `src/tools/*.ts`; `test/mcp-harness.ts`, which captures annotations through the same registration path.

**Enforcement: mechanically checked.** `src/tools/annotations.test.ts` pins the truth per tool: all 18 tools declare annotations, every pure-lookup tool is read-only, no writer claims read-only, `remove_recipe` is destructive, `log_spend` is non-idempotent, and no tool is both read-only and destructive. Runs under `npm test` in CI. The remaining judgment — whether a *new* tool's hints match its handler — rests on review, but a new tool with no annotations at all fails the coverage assertion.

---

## Articles considered and rejected

**Handlers never panic out via a generic recovery wrapper.** There is no `makeHandler` equivalent and no named-return machinery to translate. The actual practice — per-handler try/catch returning structured errors — is Article III. Writing the Go article's shape here would describe machinery that does not exist.

**Caller cancellation propagates into every I/O call.** The Go portfolio's `context.Context` article. This repository does not thread an `AbortSignal` from the MCP request into handlers or the API client; the real bound is the per-attempt timeout in `src/http.ts`, and Article VI records exactly that instead of inventing propagation.

**Operations that grant durable access fail closed.** No tool shares, invites, grants a role, or writes a credential. The upstream API is unauthenticated and every mutation is local to the user's own data file. There is nothing for the article to guard.

**No credentials in version control.** The server holds no credentials: no API keys, no tokens, no auth of any kind (the README says so as a feature). An article would guard an empty set. The one file with privacy weight, the household data file, is gitignored and covered by Article VIII.

**The supply chain is verified on every pull request.** CI installs against the lockfile via `npm ci` and Dependabot files weekly bumps, but nothing verifies checksums beyond npm's own lockfile integrity, nothing audits, and the `path-to-regexp` override in `package.json` is a manual pin. Writing the portfolio's supply-chain article would claim more than the workflow does. The honest fragment — Dependabot's major-versions-stand-alone rule and its incident rationale — lives in Article XI.

**A coverage threshold on new code.** No threshold is configured anywhere, and inventing one in prose would be the unenforced-wish failure mode this document exists to avoid. The piece worth keeping — `coverage.all: true` so untested modules report as 0% rather than disappearing — is recorded in Article XI.

---

## Amendment log

| Date | Change |
|------|--------|
| 27-08-2026 | Ratified. Eleven articles, adapted from the `CONSTITUTION.md` in `gridctl/gridctl` (Apache-2.0, github.com/gridctl/gridctl) via the portfolio template, translated for TypeScript. |
| 27-08-2026 | Article XII ratified: tool annotations moved from "considered and rejected" to an article, after all 18 registrations gained truthful `ToolAnnotations` (via `server.registerTool`) pinned by `src/tools/annotations.test.ts`. |
