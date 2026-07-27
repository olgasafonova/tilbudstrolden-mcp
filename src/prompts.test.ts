/**
 * Unit tests for src/prompts.ts — the three MCP workflow prompts.
 *
 * Prompts are pure template builders, so these tests assert the registration
 * surface (names, descriptions, argument schema) and the rendered message text,
 * including the days-default substitution in meal-plan.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  callPrompt,
  createServerStub,
  promptTextOf,
  type ServerStub,
} from "../test/mcp-harness.js";
import { registerPrompts } from "./prompts.js";

let stub: ServerStub;

beforeEach(() => {
  stub = createServerStub();
  registerPrompts(stub.server);
});

describe("registerPrompts", () => {
  it("registers exactly the three documented prompts", () => {
    expect([...stub.prompts.keys()].sort()).toEqual(["deal-scout", "getting-started", "meal-plan"]);
  });

  it("gives every prompt a non-empty description", () => {
    for (const prompt of stub.prompts.values()) {
      expect(prompt.description.length).toBeGreaterThan(10);
    }
  });

  it("declares no required arguments on any prompt", () => {
    // All prompts must be invocable with no arguments.
    for (const prompt of stub.prompts.values()) {
      expect(() => Object.keys(prompt.schema)).not.toThrow();
    }
    expect(Object.keys(stub.prompts.get("getting-started")?.schema ?? {})).toEqual([]);
    expect(Object.keys(stub.prompts.get("deal-scout")?.schema ?? {})).toEqual([]);
    expect(Object.keys(stub.prompts.get("meal-plan")?.schema ?? {})).toEqual(["days"]);
  });
});

describe("getting-started prompt", () => {
  it("returns a single user message", async () => {
    const result = await callPrompt(stub, "getting-started");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content.type).toBe("text");
  });

  it("walks through the documented setup tools in order", async () => {
    const text = promptTextOf(await callPrompt(stub, "getting-started"));
    const order = [
      "update_household",
      "list_stores",
      "update_pantry",
      "add_recipe",
      "plan_and_shop",
    ];
    let cursor = -1;
    for (const tool of order) {
      const idx = text.indexOf(tool, cursor + 1);
      expect(idx, `${tool} should appear after the previous step`).toBeGreaterThan(cursor);
      cursor = idx;
    }
  });
});

describe("meal-plan prompt", () => {
  it("defaults to 7 days when the argument is omitted", async () => {
    const text = promptTextOf(await callPrompt(stub, "meal-plan"));
    expect(text).toContain("Plan 7 days of dinners");
  });

  it("substitutes the requested number of days", async () => {
    const text = promptTextOf(await callPrompt(stub, "meal-plan", { days: "5" }));
    expect(text).toContain("Plan 5 days of dinners");
    expect(text).not.toContain("Plan 7 days");
  });

  it("falls back to 7 for an empty-string days argument", async () => {
    // days is a string schema, so "" parses; the handler's `days || "7"` guard
    // is what keeps the rendered prompt sensible.
    const text = promptTextOf(await callPrompt(stub, "meal-plan", { days: "" }));
    expect(text).toContain("Plan 7 days of dinners");
  });

  it("rejects a non-string days argument", async () => {
    await expect(callPrompt(stub, "meal-plan", { days: 5 })).rejects.toThrow();
  });

  it("directs the model to plan_and_shop and to flag expiring deals", async () => {
    const text = promptTextOf(await callPrompt(stub, "meal-plan"));
    expect(text).toContain("plan_and_shop");
    expect(text).toContain("expiring soon");
  });
});

describe("deal-scout prompt", () => {
  it("directs the model to deals_this_week and saved recipes", async () => {
    const text = promptTextOf(await callPrompt(stub, "deal-scout"));
    expect(text).toContain("deals_this_week");
    expect(text).toContain("saved recipes");
  });
});
