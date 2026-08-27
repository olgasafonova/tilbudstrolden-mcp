/**
 * Annotation-truth tests for every registered tool.
 *
 * Pins the ToolAnnotations declared in each register*Tools function against the
 * actual behaviour of the handlers: pure lookups are read-only, remove_recipe is
 * destructive, log_spend appends (so it is not idempotent), and no tool claims
 * to be both read-only and destructive.
 *
 * No handler runs here — registration alone is exercised — so no mocks are
 * needed; the store and API modules are imported but never called.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createServerStub, type ServerStub } from "../../test/mcp-harness.js";
import { registerDealTools } from "./deals.js";
import { registerHouseholdTools } from "./household.js";
import { registerRecipeTools } from "./recipes.js";
import { registerScoringTools } from "./scoring.js";
import { registerShoppingTools } from "./shopping.js";
import { registerTrackingTools } from "./tracking.js";

/** Tools whose handlers never write to the store or anywhere else. */
const READ_ONLY_TOOLS = [
  "get_recipes",
  "get_household",
  "get_pantry",
  "get_meal_history",
  "get_spend_log",
  "search_deals",
  "get_store_offers",
  "list_stores",
  "deals_this_week",
  "score_recipes",
  "generate_shopping_list",
  "plan_and_shop",
] as const;

/** Tools whose handlers write to the store. */
const WRITER_TOOLS = [
  "add_recipe",
  "remove_recipe",
  "update_household",
  "update_pantry",
  "log_meal",
  "log_spend",
] as const;

let stub: ServerStub;

beforeEach(() => {
  stub = createServerStub();
  registerDealTools(stub.server);
  registerHouseholdTools(stub.server);
  registerRecipeTools(stub.server);
  registerScoringTools(stub.server);
  registerShoppingTools(stub.server);
  registerTrackingTools(stub.server);
});

function annotationsOf(name: string) {
  const tool = stub.tools.get(name);
  if (!tool) {
    throw new Error(`Tool "${name}" was not registered. Registered: ${[...stub.tools.keys()]}`);
  }
  return tool.annotations;
}

describe("tool annotations", () => {
  it("registers all 18 tools, and the lists here cover every one of them", () => {
    expect(stub.tools.size).toBe(18);
    const listed = [...READ_ONLY_TOOLS, ...WRITER_TOOLS].sort();
    expect([...stub.tools.keys()].sort()).toEqual(listed);
  });

  it("declares annotations on every tool", () => {
    for (const name of stub.tools.keys()) {
      expect(annotationsOf(name), `${name} has no annotations`).toBeDefined();
    }
  });

  it("marks every pure-lookup tool read-only", () => {
    for (const name of READ_ONLY_TOOLS) {
      expect(annotationsOf(name)?.readOnlyHint, `${name} should be readOnlyHint: true`).toBe(true);
    }
  });

  it("never marks a writer tool read-only", () => {
    for (const name of WRITER_TOOLS) {
      expect(annotationsOf(name)?.readOnlyHint, `${name} must not claim readOnlyHint`).not.toBe(
        true,
      );
    }
  });

  it("marks remove_recipe destructive and idempotent (deleting twice is a no-op)", () => {
    expect(annotationsOf("remove_recipe")).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
    });
  });

  it("never marks a tool both read-only and destructive", () => {
    for (const [name, tool] of stub.tools) {
      const a = tool.annotations;
      const contradictory = a?.readOnlyHint === true && a?.destructiveHint === true;
      expect(contradictory, `${name} claims readOnlyHint and destructiveHint at once`).toBe(false);
    }
  });

  it("never asserts idempotentHint on a read-only tool", () => {
    for (const name of READ_ONLY_TOOLS) {
      expect(
        annotationsOf(name)?.idempotentHint,
        `${name} is read-only; idempotentHint is meaningless there`,
      ).toBeUndefined();
    }
  });

  it("marks the upsert-style writers idempotent", () => {
    // add_recipe replaces by name, log_meal dedupes by date + recipe,
    // update_household patches, update_pantry has set semantics.
    for (const name of ["add_recipe", "log_meal", "update_household", "update_pantry"]) {
      expect(annotationsOf(name)?.idempotentHint, `${name} should be idempotentHint: true`).toBe(
        true,
      );
    }
  });

  it("marks log_spend as an additive, non-idempotent append", () => {
    // store.logSpend pushes a new row every call: replaying duplicates the entry.
    expect(annotationsOf("log_spend")).toMatchObject({
      destructiveHint: false,
      idempotentHint: false,
    });
  });
});
