/**
 * Test-only harness for exercising MCP tool and prompt handlers directly.
 *
 * The register* functions in src/tools/ take an McpServer and call
 * server.registerTool(name, { description, inputSchema, annotations }, handler).
 * This stub captures those registrations so tests can run a handler in
 * isolation, with the module's external dependencies (api.js, store.js) mocked.
 *
 * Lives outside src/ on purpose: tsconfig compiles src/** only, so nothing
 * here reaches dist/, and biome (files.includes: src/**) skips it.
 */

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export interface PromptResult {
  messages: Array<{ role: string; content: { type: string; text: string } }>;
}

export interface CapturedTool {
  name: string;
  description: string;
  schema: ZodRawShape;
  annotations: ToolAnnotations | undefined;
  handler: (
    args: Record<string, unknown>,
    extra: unknown,
  ) => Promise<ToolResult> | ToolResult;
}

export interface CapturedPrompt {
  name: string;
  description: string;
  schema: ZodRawShape;
  handler: (
    args: Record<string, unknown>,
    extra: unknown,
  ) => Promise<PromptResult> | PromptResult;
}

export interface ServerStub {
  /** Cast to McpServer at the call site; only .tool and .prompt are used. */
  // biome-ignore lint/suspicious/noExplicitAny: stub stands in for McpServer
  server: any;
  tools: Map<string, CapturedTool>;
  prompts: Map<string, CapturedPrompt>;
}

export function createServerStub(): ServerStub {
  const tools = new Map<string, CapturedTool>();
  const prompts = new Map<string, CapturedPrompt>();

  const server = {
    registerTool(
      name: string,
      config: {
        description: string;
        inputSchema?: ZodRawShape;
        annotations?: ToolAnnotations;
      },
      handler: CapturedTool["handler"],
    ) {
      tools.set(name, {
        name,
        description: config.description,
        schema: config.inputSchema ?? {},
        annotations: config.annotations,
        handler,
      });
    },
    prompt(
      name: string,
      description: string,
      schema: ZodRawShape,
      handler: CapturedPrompt["handler"],
    ) {
      prompts.set(name, { name, description, schema, handler });
    },
  };

  return { server, tools, prompts };
}

function requireTool(stub: ServerStub, name: string): CapturedTool {
  const tool = stub.tools.get(name);
  if (!tool) {
    throw new Error(
      `Tool "${name}" was not registered. Registered: ${[...stub.tools.keys()]}`,
    );
  }
  return tool;
}

function requirePrompt(stub: ServerStub, name: string): CapturedPrompt {
  const prompt = stub.prompts.get(name);
  if (!prompt) {
    throw new Error(
      `Prompt "${name}" was not registered. Registered: ${[...stub.prompts.keys()]}`,
    );
  }
  return prompt;
}

/**
 * Parse raw args through the tool's own zod schema (applying declared defaults
 * and rejecting invalid input, exactly as the MCP SDK does) and run the handler.
 * Throws ZodError on invalid args, which is the real validation path.
 */
export async function callTool(
  stub: ServerStub,
  name: string,
  rawArgs: unknown = {},
): Promise<ToolResult> {
  const tool = requireTool(stub, name);
  const args = z.object(tool.schema).parse(rawArgs) as Record<string, unknown>;
  return await tool.handler(args, {});
}

/** Parse args through the schema without running the handler. */
export function parseToolArgs(
  stub: ServerStub,
  name: string,
  rawArgs: unknown,
): unknown {
  return z.object(requireTool(stub, name).schema).parse(rawArgs);
}

export async function callPrompt(
  stub: ServerStub,
  name: string,
  rawArgs: unknown = {},
): Promise<PromptResult> {
  const prompt = requirePrompt(stub, name);
  const args = z.object(prompt.schema).parse(rawArgs) as Record<
    string,
    unknown
  >;
  return await prompt.handler(args, {});
}

/** Concatenated text of every content block in a tool result. */
export function textOf(result: ToolResult): string {
  return result.content.map((c) => c.text).join("\n");
}

/** Concatenated text of every message in a prompt result. */
export function promptTextOf(result: PromptResult): string {
  return result.messages.map((m) => m.content.text).join("\n");
}
