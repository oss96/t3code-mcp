import type { McpServer } from "@modelcontextprotocol/server";

import type { ClientSource } from "./register-tool.ts";
import { registerHarnessTools } from "./tools/harnesses.ts";
import { registerProjectTools } from "./tools/projects.ts";
import { registerThreadTools } from "./tools/threads.ts";
import { registerTurnTools } from "./tools/turns.ts";

export function registerTools(server: McpServer, source: ClientSource): void {
  registerProjectTools(server, source);
  registerHarnessTools(server, source);
  registerThreadTools(server, source);
  registerTurnTools(server, source);
}
