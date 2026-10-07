import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { unusableReason } from "../../t3/selection.ts";
import { READ_ONLY, registerJsonTool, type ClientSource } from "../register-tool.ts";

export function registerHarnessTools(server: McpServer, source: ClientSource): void {
  registerJsonTool(
    { server, source },
    "t3_list_harnesses",
    {
      title: "List harnesses and models",
      description:
        "List the coding-agent harnesses configured in T3 (T3 calls them providers; harnessId is the provider instanceId) and the models each offers. Entries with usable=false carry a reason and cannot start threads.",
      input: {
        includeUnusable: z
          .boolean()
          .optional()
          .describe("Also list harnesses that cannot start threads right now"),
      },
      annotations: READ_ONLY,
    },
    async ({ includeUnusable }) => {
      const client = await source.getClient();
      const { providers } = await client.config();
      return providers
        .map((provider) => ({ provider, reason: unusableReason(provider) }))
        .filter(({ reason }) => includeUnusable || reason === null)
        .map(({ provider: p, reason }) => ({
          harnessId: p.instanceId,
          driver: p.driver,
          displayName: p.displayName ?? p.instanceId,
          usable: reason === null,
          reason: reason ?? undefined,
          status: p.status,
          auth: p.auth.status,
          version: p.version,
          models: p.models.map((m) => ({
            model: m.slug,
            name: m.name,
            aliases: m.aliases,
            isDefault: m.isDefault ?? false,
            isLegacy: m.isLegacy ?? false,
          })),
        }));
    },
  );
}
