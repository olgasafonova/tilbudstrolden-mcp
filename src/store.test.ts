/**
 * Unit tests for src/store.ts — the JSON data store, its defaults, its path
 * resolution, and the lock that serialises read-modify-write cycles.
 *
 * Every test points TILBUDSTROLDEN_DATA (or a stubbed home directory) at a
 * fresh temp dir, so nothing is read from or written to the real home folder.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as store from "./store.js";

const ENV = "TILBUDSTROLDEN_DATA";

let tmpDir: string;
let dataFile: string;
let savedEnv: string | undefined;

const EMPTY = {
  household: { people: [], stores: [], defaultServings: 2, country: "DK" },
  pantry: [],
  recipes: [],
  mealHistory: [],
  spendLog: [],
};

async function writeData(contents: string): Promise<void> {
  await fs.writeFile(dataFile, contents, "utf-8");
}

async function readData(file = dataFile): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf-8"));
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tilbudstrolden-store-"));
  dataFile = path.join(tmpDir, "data.json");
  savedEnv = process.env[ENV];
  process.env[ENV] = dataFile;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("empty store defaults", () => {
  it("returns an empty DK store when the file does not exist", async () => {
    expect(await store.load()).toEqual(EMPTY);
  });

  it("returns an empty store for malformed JSON without logging", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await writeData("{ not json");
    expect(await store.load()).toEqual(EMPTY);
    expect(log).not.toHaveBeenCalled();
  });

  it("logs and starts fresh when the file fails schema validation", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await writeData(JSON.stringify({ pantry: "salt" }));
    expect(await store.load()).toEqual(EMPTY);
    expect(log).toHaveBeenCalledWith(
      "Data file validation failed, starting fresh:",
      expect.any(Array),
    );
  });

  it("fills missing sections from defaults and keeps the ones present", async () => {
    await writeData(JSON.stringify({ household: { country: "NO" }, pantry: ["salt"] }));
    const data = await store.load();
    expect(data.household).toEqual({ people: [], stores: [], defaultServings: 2, country: "NO" });
    expect(data.pantry).toEqual(["salt"]);
    expect(data.spendLog).toEqual([]);
  });

  it("hands out a fresh object each time, never a shared default", async () => {
    const a = await store.load();
    a.pantry.push("mutated");
    a.household.people.push({ name: "x", dietaryRestrictions: [], defaultSchedule: {} });
    const b = await store.load();
    expect(b.pantry).toEqual([]);
    expect(b.household.people).toEqual([]);
  });
});

describe("store path", () => {
  it("writes to the path in TILBUDSTROLDEN_DATA", async () => {
    await store.save({ ...EMPTY, pantry: ["olie"] });
    expect(await readData()).toMatchObject({ pantry: ["olie"] });
  });

  it("falls back to ~/.tilbudstrolden.json when the env var is unset", async () => {
    delete process.env[ENV];
    vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
    await store.save({ ...EMPTY, pantry: ["mel"] });
    expect(await readData(path.join(tmpDir, ".tilbudstrolden.json"))).toMatchObject({
      pantry: ["mel"],
    });
  });

  it("treats an empty env var as unset", async () => {
    process.env[ENV] = "";
    vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
    await store.save({ ...EMPTY, pantry: ["gær"] });
    expect(await readData(path.join(tmpDir, ".tilbudstrolden.json"))).toMatchObject({
      pantry: ["gær"],
    });
  });

  it("round-trips data through save and load", async () => {
    const data = {
      ...EMPTY,
      spendLog: [{ date: "2026-06-15", store: "Netto", estimatedTotal: 312, items: 9, notes: "" }],
    };
    await store.save(data);
    expect(await store.load()).toEqual(data);
  });
});

describe("withLock (via modify)", () => {
  it("serialises concurrent writers so no update is lost", async () => {
    const items = Array.from({ length: 25 }, (_, i) => `item-${String(i).padStart(2, "0")}`);
    await Promise.all(items.map((item) => store.updatePantry([item], [])));
    expect(await store.getPantry()).toEqual(items);
  });

  it("runs queued operations in call order", async () => {
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        store.modify(async (s) => {
          // The earliest call waits longest; the lock must still keep order.
          await new Promise((r) => setTimeout(r, (4 - n) * 5));
          order.push(n);
          return s;
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3]);
  });

  it("releases the lock when an operation throws", async () => {
    await expect(
      store.modify(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(store.updatePantry(["salt"], [])).resolves.toEqual(["salt"]);
  });

  it("does not write the file when the update function throws", async () => {
    await store.save({ ...EMPTY, pantry: ["peber"] });
    await expect(
      store.modify((s) => {
        s.pantry = [];
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await store.getPantry()).toEqual(["peber"]);
  });
});

describe("store operations built on the lock", () => {
  it("adds pantry items case-insensitively, removes them, and sorts", async () => {
    await store.updatePantry(["Salt", "Olie"], []);
    expect(await store.updatePantry(["salt", "Mel"], ["OLIE"])).toEqual(["Mel", "Salt"]);
  });

  it("seeds default recipes for a DK household only", async () => {
    expect((await store.getRecipes()).length).toBeGreaterThan(0);
    await store.save({ ...EMPTY, household: { ...EMPTY.household, country: "SE" } });
    expect(await store.getRecipes()).toEqual([]);
  });

  it("replaces a recipe with the same name, ignoring case", async () => {
    await store.save({ ...EMPTY, household: { ...EMPTY.household, country: "NO" } });
    const recipe = {
      name: "Taco",
      ingredients: [],
      servings: 4,
      complexity: "quick" as const,
      cuisineType: "mexican",
      proteinType: "beef",
    };
    await store.addRecipe(recipe);
    await store.addRecipe({ ...recipe, name: "TACO", servings: 6 });
    expect(await store.getRecipes()).toEqual([{ ...recipe, name: "TACO", servings: 6 }]);
    expect(await store.removeRecipe("taco")).toBe(true);
    expect(await store.removeRecipe("taco")).toBe(false);
  });

  it("keeps one meal per recipe per day and filters history by age", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
    try {
      await store.logMeal({ date: "2026-06-14", recipe: "Taco", people: ["A"] });
      await store.logMeal({ date: "2026-06-14", recipe: "taco", people: ["A", "B"] });
      await store.logMeal({ date: "2026-04-01", recipe: "Suppe", people: ["A"] });
      expect(await store.getMealHistory(4)).toEqual([
        { date: "2026-06-14", recipe: "taco", people: ["A", "B"] },
      ]);
      expect(await store.getMealHistory(12)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
