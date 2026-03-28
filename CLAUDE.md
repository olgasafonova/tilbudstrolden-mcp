# tilbudstrolden-mcp

TypeScript MCP server for Danish grocery deal hunting via etilbudsavis.dk API.

## Architecture

- `src/server.ts` - MCP server with all tool definitions and scoring logic
- `src/api.ts` - etilbudsavis.dk v2 API client (offers, dealers)
- `src/store.ts` - JSON file data store with async mutex for household, recipes, pantry, history

## API

Base URL: `https://api.etilbudsavis.dk/v2`. No auth required. Endpoints used:
- `GET /offers/search?query=...&limit=...`
- `GET /offers?dealer_id=...&limit=...`
- `GET /dealers?country_id=DK&limit=100`

## Deal scoring

`scoreDealMatch()` in server.ts handles raw vs processed product matching. `PROCESSED_INDICATORS` and `RAW_INDICATORS` arrays contain Danish terms. Scoring favors preferred stores and penalizes processed products when searching for cooking ingredients.

## Data file

`~/.tilbudstrolden.json` (override: `TILBUDSTROLDEN_DATA` env var). Contains household config, pantry, recipes, meal history, spend log. All writes use an async mutex to prevent corruption.

## Build

```bash
npm run build   # tsc -> dist/
npm run dev     # tsx watch
```
