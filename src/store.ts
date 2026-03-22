// Unified JSON data store for household, recipes, pantry, history, and spend tracking

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// --- Types ---

export interface Person {
  name: string;
  dietaryRestrictions: string[];
  defaultSchedule: Record<string, boolean>; // monday..sunday → home or not
}

export interface StorePreference {
  name: string;
  dealerId: string;
  priority: number; // 1 = closest/default
}

export interface Household {
  people: Person[];
  stores: StorePreference[];
  defaultServings: number;
}

export interface Ingredient {
  name: string;
  quantity: string;
  searchTerms: string[];
  category: string; // meat, dairy, produce, bakery, frozen, pantry, drinks, other
}

export interface Recipe {
  name: string;
  ingredients: Ingredient[];
  servings: number;
  complexity: "quick" | "medium" | "slow";
  cuisineType: string; // asian, danish, italian, mexican, etc.
  proteinType: string; // chicken, beef, pork, fish, vegetarian, etc.
}

export interface MealLogEntry {
  date: string; // YYYY-MM-DD
  recipe: string;
  people: string[];
}

export interface SpendLogEntry {
  date: string; // YYYY-MM-DD
  store: string;
  estimatedTotal: number;
  items: number;
  notes: string;
}

export interface DataStore {
  household: Household;
  pantry: string[];
  recipes: Recipe[];
  mealHistory: MealLogEntry[];
  spendLog: SpendLogEntry[];
}

// --- Defaults ---

function emptyStore(): DataStore {
  return {
    household: {
      people: [],
      stores: [],
      defaultServings: 2,
    },
    pantry: [],
    recipes: [],
    mealHistory: [],
    spendLog: [],
  };
}

// --- File I/O with mutex ---

function getStorePath(): string {
  const custom = process.env.SMART_SHOPPER_DATA;
  if (custom) return custom;
  return path.join(os.homedir(), ".smart-shopper.json");
}

// Simple async mutex to prevent concurrent read-modify-write corruption
let lockPromise: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = lockPromise;
  let resolve: () => void;
  lockPromise = new Promise<void>((r) => {
    resolve = r;
  });
  return prev.then(fn).finally(() => resolve!());
}

async function loadRaw(): Promise<DataStore> {
  const filePath = getStorePath();
  try {
    const data = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(data);
    const defaults = emptyStore();
    return { ...defaults, ...parsed };
  } catch {
    return emptyStore();
  }
}

async function saveRaw(store: DataStore): Promise<void> {
  const filePath = getStorePath();
  await fs.writeFile(filePath, JSON.stringify(store, null, 2), "utf-8");
}

export async function load(): Promise<DataStore> {
  return withLock(() => loadRaw());
}

export async function save(store: DataStore): Promise<void> {
  return withLock(() => saveRaw(store));
}

// Run a read-modify-write operation atomically
export async function modify(
  fn: (store: DataStore) => DataStore | Promise<DataStore>,
): Promise<DataStore> {
  return withLock(async () => {
    const data = await loadRaw();
    const updated = await fn(data);
    await saveRaw(updated);
    return updated;
  });
}

// --- Household ---

export async function getHousehold(): Promise<Household> {
  const store = await load();
  return store.household;
}

export async function updateHousehold(
  updates: Partial<Household>,
): Promise<Household> {
  const result = await modify((s) => {
    s.household = { ...s.household, ...updates };
    if (updates.people) s.household.people = updates.people;
    if (updates.stores) s.household.stores = updates.stores;
    return s;
  });
  return result.household;
}

// --- Pantry ---

export async function getPantry(): Promise<string[]> {
  const store = await load();
  return store.pantry;
}

export async function updatePantry(
  add: string[],
  remove: string[],
): Promise<string[]> {
  const result = await modify((s) => {
    const removeSet = new Set(remove.map((r) => r.toLowerCase()));
    s.pantry = s.pantry.filter((item) => !removeSet.has(item.toLowerCase()));
    for (const item of add) {
      if (!s.pantry.some((p) => p.toLowerCase() === item.toLowerCase())) {
        s.pantry.push(item);
      }
    }
    s.pantry.sort();
    return s;
  });
  return result.pantry;
}

// --- Recipes ---

export async function getRecipes(): Promise<Recipe[]> {
  const store = await load();
  return store.recipes;
}

export async function addRecipe(recipe: Recipe): Promise<void> {
  await modify((s) => {
    const idx = s.recipes.findIndex(
      (r) => r.name.toLowerCase() === recipe.name.toLowerCase(),
    );
    if (idx >= 0) {
      s.recipes[idx] = recipe;
    } else {
      s.recipes.push(recipe);
    }
    return s;
  });
}

export async function removeRecipe(name: string): Promise<boolean> {
  let removed = false;
  await modify((s) => {
    const idx = s.recipes.findIndex(
      (r) => r.name.toLowerCase() === name.toLowerCase(),
    );
    if (idx >= 0) {
      s.recipes.splice(idx, 1);
      removed = true;
    }
    return s;
  });
  return removed;
}

// --- Meal History ---

export async function getMealHistory(weeks = 4): Promise<MealLogEntry[]> {
  const store = await load();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - weeks * 7);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return store.mealHistory
    .filter((m) => m.date >= cutoffStr)
    .sort((a, b) => b.date.localeCompare(a.date));
}

export async function logMeal(entry: MealLogEntry): Promise<void> {
  await modify((s) => {
    const idx = s.mealHistory.findIndex(
      (m) =>
        m.date === entry.date &&
        m.recipe.toLowerCase() === entry.recipe.toLowerCase(),
    );
    if (idx >= 0) {
      s.mealHistory[idx] = entry;
    } else {
      s.mealHistory.push(entry);
    }
    return s;
  });
}

// --- Spend Log ---

export async function getSpendLog(weeks = 8): Promise<SpendLogEntry[]> {
  const store = await load();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - weeks * 7);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return store.spendLog
    .filter((s) => s.date >= cutoffStr)
    .sort((a, b) => b.date.localeCompare(a.date));
}

export async function logSpend(entry: SpendLogEntry): Promise<void> {
  await modify((s) => {
    s.spendLog.push(entry);
    return s;
  });
}
