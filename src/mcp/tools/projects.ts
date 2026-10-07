import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { normalizePath, resolveProject } from "../../t3/selection.ts";
import { READ_ONLY, registerJsonTool, type ClientSource } from "../register-tool.ts";

export function registerProjectTools(server: McpServer, source: ClientSource): void {
  registerJsonTool(
    { server, source },
    "t3_list_projects",
    {
      title: "List T3 projects",
      description:
        "List the projects the running T3 server knows about, with ids, titles, and workspace roots.",
      input: {},
      annotations: READ_ONLY,
    },
    async () => {
      const client = await source.getClient();
      const { projects } = await client.shell();
      return projects.map(({ id, title, workspaceRoot, defaultModelSelection }) => ({
        id,
        title,
        workspaceRoot,
        defaultModelSelection,
      }));
    },
  );

  registerJsonTool(
    { server, source },
    "t3_list_worktrees",
    {
      title: "List worktrees of a project",
      description:
        "List the git worktrees and local branches of a T3 project. The project root is always a valid worktreePath. Pass the project id, exact title, or workspace root.",
      input: { project: z.string().describe("Project id, exact title, or workspace root path") },
      annotations: READ_ONLY,
    },
    async ({ project }) => {
      const client = await source.getClient();
      const resolved = resolveProject((await client.shell()).projects, project);
      const { refs, isRepo } = await client.listRefs(resolved.workspaceRoot);
      const root = normalizePath(resolved.workspaceRoot);
      return {
        projectId: resolved.id,
        isRepo,
        worktrees: [
          {
            worktreePath: resolved.workspaceRoot,
            branch: refs.find((r) => r.current && !r.isRemote)?.name ?? null,
            isProjectRoot: true,
          },
          ...refs
            .filter((r) => r.worktreePath && normalizePath(r.worktreePath) !== root)
            .map((r) => ({ worktreePath: r.worktreePath, branch: r.name, isProjectRoot: false })),
        ],
        branches: refs
          .filter((r) => !r.isRemote)
          .map((r) => ({ name: r.name, isDefault: r.isDefault, worktreePath: r.worktreePath })),
      };
    },
  );
}
