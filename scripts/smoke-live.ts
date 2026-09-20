import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import * as z from "zod/v4";
const projectsSchema = z.array(
  z.object({ id: z.string(), title: z.string(), workspaceRoot: z.string() }),
);
const harnessesSchema = z.array(
  z.object({
    harnessId: z.string(),
    models: z.array(z.object({ model: z.string(), isDefault: z.boolean() })),
  }),
);
const threadResultSchema = z.object({
  threadId: z.string(),
  url: z.string(),
  reused: z.boolean().optional(),
  timedOut: z.boolean().optional(),
  cancelled: z.boolean().optional(),
  turn: z.object({ state: z.string() }).nullable(),
  reply: z.object({ text: z.string() }).nullish(),
});

type ToolResponse = { isError: true; error: string } | { isError: false; data: unknown };

const argv = process.argv.slice(2);
const createAt = argv.indexOf("--create");
const [projectArg = "", harnessArg = "", modelArg = ""] =
  createAt >= 0 ? argv.slice(createAt + 1) : [];
if (createAt >= 0 && (!projectArg || !harnessArg || !modelArg)) {
  throw new Error(
    "Usage: bun scripts/smoke-live.ts [--create <projectIdOrRoot> <harness> <model>]",
  );
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/cli.ts", "serve"],
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResponse> => {
  const result = await client.callTool({ name, arguments: args });
  const body = result.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n");
  if (result.isError) {
    console.log(`\n== ${name} -> ERROR\n${body}`);
    return { isError: true, error: body };
  }
  console.log(`\n== ${name}\n${body.slice(0, 1200)}${body.length > 1200 ? "\n…" : ""}`);
  return { isError: false, data: JSON.parse(body) };
};
const must = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
  const result = await call(name, args);
  if (result.isError) {
    throw new Error(`${name} failed: ${result.error}`);
  }
  return result.data;
};
const mustFail = async (
  name: string,
  args: Record<string, unknown>,
  pattern: RegExp,
): Promise<void> => {
  const result = await call(name, args);
  if (!result.isError || !pattern.test(result.error)) {
    throw new Error(`${name} should have failed with ${pattern}`);
  }
};

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const projects = projectsSchema.parse(await must("t3_list_projects"));
const harnesses = harnessesSchema.parse(await must("t3_list_harnesses"));
await must("t3_list_harnesses", { includeUnusable: true });
await must("t3_list_threads", { limit: 3 });
if (projects[0]) {
  await must("t3_list_worktrees", { project: projects[0].id });
}
await mustFail("t3_list_worktrees", { project: "definitely-not-a-project" }, /not found/);

if (createAt >= 0) {
  const project =
    projects.find(
      (p) =>
        p.id === projectArg ||
        p.workspaceRoot.toLowerCase() === projectArg.toLowerCase() ||
        p.title === projectArg,
    ) ?? null;
  if (!project) {
    throw new Error(`project ${projectArg} not found`);
  }
  const harness = harnesses.find((h) => h.harnessId === harnessArg);
  if (!harness) {
    throw new Error(`harness ${harnessArg} not usable`);
  }
  const model = modelArg;
  console.log(
    `\nusing project ${project.title} [${project.id}], harness ${harnessArg}, model ${model}`,
  );
  await mustFail(
    "t3_create_thread",
    { project: project.id, harness: "nope", model, title: "x", prompt: "x" },
    /harness "nope" not found/,
  );
  await mustFail(
    "t3_create_thread",
    { project: project.id, harness: harnessArg, model: "not-a-model", title: "x", prompt: "x" },
    /not offered by harness/,
  );
  await mustFail(
    "t3_create_thread",
    {
      project: project.id,
      harness: harnessArg,
      model,
      title: "x",
      prompt: "x",
      worktreePath: "/definitely/not/a/worktree",
    },
    /is not a worktree of project/,
  );

  const key = `smoke-${Date.now()}`;
  const launch = {
    project: project.id,
    harness: harnessArg,
    model,
    title: "[t3code-mcp smoke] ping",
    prompt:
      "Reply with exactly the single word PONG and do nothing else. Do not read files or run tools.",
    context: [{ label: "Why", text: "Automated smoke test of the t3code-mcp server." }],
    runtimeMode: "approval-required",
    idempotencyKey: key,
  };
  const created = threadResultSchema.parse(await must("t3_create_thread", launch));
  const retry = threadResultSchema.parse(await must("t3_create_thread", launch));
  if (retry.threadId !== created.threadId || retry.reused !== true) {
    throw new Error("retry launched a second thread!");
  }

  const first = threadResultSchema.parse(
    await must("t3_wait_for_turn", { threadId: created.threadId, timeoutSeconds: 240 }),
  );
  if (first.timedOut) {
    throw new Error("first turn timed out");
  }

  const followKey = `${key}-follow`;
  const follow = threadResultSchema.parse(
    await must("t3_send_message", {
      threadId: created.threadId,
      prompt: "Now reply with exactly the single word PANG.",
      idempotencyKey: followKey,
      wait: true,
      timeoutSeconds: 240,
    }),
  );
  const followRetry = threadResultSchema.parse(
    await must("t3_send_message", {
      threadId: created.threadId,
      prompt: "Now reply with exactly the single word PANG.",
      idempotencyKey: followKey,
    }),
  );
  if (followRetry.reused !== true) {
    throw new Error("follow-up retry started a second turn!");
  }

  await must("t3_get_thread", { threadId: created.threadId, messageLimit: 6 });
  await call("t3_send_message", {
    threadId: created.threadId,
    prompt: "Count slowly from 1 to 500, one number per line, thinking carefully between each.",
  });
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const cancelled = threadResultSchema.parse(
    await must("t3_cancel_turn", { threadId: created.threadId }),
  );
  console.log("\ncancel result:", cancelled.cancelled, cancelled.turn?.state);
  await call("t3_list_threads", { project: project.id, limit: 3 });

  console.log(
    `\nSMOKE OK — thread ${created.threadId} ${created.url} | first reply: ${JSON.stringify(first.reply?.text)} | follow reply: ${JSON.stringify(follow.reply?.text)}`,
  );
} else {
  console.log("\nSMOKE OK (read-only). Pass --create <project> to launch one real thread.");
}
await client.close();
