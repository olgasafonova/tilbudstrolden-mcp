# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/).

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

[0.5.0]: https://github.com/olgasafonova/tilbudstrolden-mcp/releases/tag/v0.5.0
[0.4.0]: https://github.com/olgasafonova/tilbudstrolden-mcp/releases/tag/v0.4.0
