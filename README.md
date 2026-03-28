# smart-shopper-mcp

MCP server for Danish grocery deal hunting. Searches current offers from Netto, Meny, Lidl, Rema 1000, Fotex, Bilka, Aldi, and Spar via the etilbudsavis.dk API.

## What it does

- Search deals across all Danish grocery stores by keyword
- Browse current offers from a specific store
- Save recipes with Danish search terms per ingredient
- Score recipes against current deals (which meals are cheapest this week?)
- Generate deal-optimized shopping lists grouped by store
- Track household members, dietary restrictions, and weekly schedules
- Manage a pantry (items you already have get excluded)
- Log meals and spending for rotation and budget tracking

## Setup

```bash
npm install
npm run build
```

### Claude Desktop

Add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "smart-shopper": {
      "command": "node",
      "args": ["/path/to/smart-shopper-mcp/dist/server.js"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add smart-shopper node /path/to/smart-shopper-mcp/dist/server.js
```

## Tools

### Deals
- `search_deals` - Search current grocery deals by keyword (e.g. "kylling", "maelk")
- `get_store_offers` - List current offers from a specific store
- `list_stores` - List Danish grocery chains with dealer IDs

### Household
- `get_household` / `update_household` - Configure people, dietary restrictions, preferred stores

### Pantry
- `get_pantry` / `update_pantry` - Track what you already have at home

### Recipes
- `get_recipes` / `add_recipe` / `remove_recipe` - Manage recipes with ingredients and Danish search terms

### Planning
- `score_recipes` - Score all recipes against current deals; optionally optimize a weekly meal plan
- `generate_shopping_list` - Build a deal-optimized shopping list from selected recipes

### Tracking
- `log_meal` / `get_meal_history` - Record and review what was cooked
- `log_spend` / `get_spend_log` - Track grocery spending

## Data storage

All data (household, recipes, pantry, meal history, spending) is stored in `~/.smart-shopper.json`. Override with the `SMART_SHOPPER_DATA` environment variable.

## Deal matching

The scoring engine distinguishes raw ingredients from processed products. Searching for "laks" won't match "roget laks" when you need fresh salmon for cooking. Store preferences from your household config influence scoring.
