/**
 * Unit tests for src/version.ts — the version string sent in the User-Agent
 * header and reported to MCP clients.
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
  version: string;
};

afterEach(() => {
  vi.doUnmock("node:module");
  vi.resetModules();
});

describe("SERVER_VERSION", () => {
  it("matches the version in package.json", async () => {
    const { SERVER_VERSION } = await import("./version.js");
    expect(SERVER_VERSION).toBe(pkg.version);
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("falls back instead of throwing when package.json cannot be read", async () => {
    vi.resetModules();
    vi.doMock("node:module", () => ({
      createRequire: () => () => {
        throw new Error("Cannot find module '../package.json'");
      },
    }));
    const { SERVER_VERSION } = await import("./version.js");
    expect(SERVER_VERSION).toBe("0.0.0-unknown");
  });
});
