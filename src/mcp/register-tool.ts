import type { CallToolResult, McpServer, ToolAnnotations } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { T3Client } from "../t3/client.ts";

export interface ClientSource {
  getClient(): Promise<T3Client>;
}

export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} satisfies ToolAnnotations;
export const MUTATING = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} satisfies ToolAnnotations;

interface JsonToolMetadata<Shape extends z.ZodRawShape> {
  title: string;
  description: string;
  input: Shape;
  annotations: ToolAnnotations;
}

export function registerJsonTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  meta: JsonToolMetadata<Shape>,
  run: (input: z.output<z.ZodObject<Shape>>) => Promise<unknown>,
): void {
  const schema = z.object(meta.input);
  const callback = async (input: unknown): Promise<CallToolResult> => {
    try {
      return {
        content: [{ type: "text", text: JSON.stringify(await run(schema.parse(input)), null, 2) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      };
    }
  };
  server.registerTool(
    name,
    {
      title: meta.title,
      description: meta.description,
      inputSchema: schema,
      annotations: meta.annotations,
    },
    callback,
  );
}
