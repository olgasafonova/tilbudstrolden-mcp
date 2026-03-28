# TilbudsTrolden

**The deal troll that lives under the bridge between your fridge and your wallet.**

<p align="center">
  <img src="assets/trolden-cooking.png" alt="TilbudsTrolden cooking up deals" width="400" />
</p>

An MCP server that searches Danish grocery chains for current deals, scores your recipes against this week's offers, and builds shopping lists optimized by price and store. You talk to your AI assistant about dinner; the troll does the legwork.

## What can you do with it?

**"What's cheap at Netto right now?"** Browse current offers from any Danish store.

**"Find me the cheapest hakket oksekoed across all stores."** Search deals by keyword and compare unit prices side by side.

**"I want to make osso buco. Where should I buy the ingredients?"** The troll searches for each ingredient across all stores and finds the best match, distinguishing raw cuts from processed deli products. It won't suggest roget laks when you need fresh salmon.

**"Score my recipes against this week's deals."** Save your go-to recipes with Danish search terms per ingredient. The scoring engine checks current offers, ranks recipes by deal coverage, and tells you which meals are cheapest to cook this week.

**"Plan next week's dinners."** Generate an optimized weekly meal plan that minimizes total basket cost while enforcing variety: no protein more than twice, no cuisine more than twice, and a cap on slow-cook nights. Then export a shopping list grouped by store.

**"We already have onions and rice."** Track your pantry. Items you have at home get excluded from shopping lists and scoring.

## Supported stores

Netto, Meny, Lidl, REMA 1000, Foetex, Bilka, Spar, Kvickly, 365discount, and any other chain listed on etilbudsavis.dk.

## Tools

### Deals
- **search_deals** - Search current offers across all Danish stores by keyword
- **get_store_offers** - Browse this week's offers from a specific store
- **list_stores** - List available grocery chains

### Household
- **get_household / update_household** - Configure household members, dietary restrictions, preferred stores, and default servings

### Pantry
- **get_pantry / update_pantry** - Track what you already have at home (excluded from shopping lists)

### Recipes
- **add_recipe / get_recipes / remove_recipe** - Save recipes with ingredients, Danish search terms, complexity, cuisine type, and protein type

### Planning
- **score_recipes** - Score all saved recipes against current deals; optionally generate an optimized weekly meal plan with variety constraints (protein, cuisine, complexity)
- **generate_shopping_list** - Build a deal-optimized shopping list from selected recipes, grouped by store

### Tracking
- **log_meal / get_meal_history** - Record what you cooked and when
- **log_spend / get_spend_log** - Track grocery spending over time

## How deal matching works

Danish grocery deals bundle products in creative ways ("Rejer, kold- eller varmroget laks"). The scoring engine handles this by classifying products as raw or processed using Danish food terminology. Searching for "laks" as a cooking ingredient won't match roget laks or palaeg. Store preferences from your household config influence ranking, so your closest stores get priority.

## Setup

```bash
npm install
npm run build
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tilbudstrolden": {
      "command": "node",
      "args": ["/path/to/tilbudstrolden-mcp/dist/server.js"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add tilbudstrolden node /path/to/tilbudstrolden-mcp/dist/server.js
```

## Data storage

All data (household, recipes, pantry, meal history, spending) lives in `~/.tilbudstrolden.json`. Override the path with the `TILBUDSTROLDEN_DATA` environment variable.

## Powered by

Deal data from [etilbudsavis.dk](https://etilbudsavis.dk). No API key required.
