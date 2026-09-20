import { afterEach, describe, expect, it } from "bun:test";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { registerTools } from "../../src/mcp/register-tools.ts";
import { T3Client } from "../../src/t3/client.ts";
import { commandIds } from "../../src/t3/command-ids.ts";
import type {
  ShellSnapshot,
  Thread,
  ThreadSnapshot,
} from "../../src/t3/contracts/orchestration.ts";
import type { Provider } from "../../src/t3/contracts/providers.ts";
import type { VcsListRefsResult } from "../../src/t3/contracts/vcs.ts";

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const unexpectedCall = async (): Promise<never> => {
  throw new Error("Unexpected client call");
};
const toolError = (result: unknown): string => z.object({ error: z.string() }).parse(result).error;

async function harness(api: Partial<T3Client>) {
  const fake = Object.assign(
    new T3Client({
      server: { origin: "http://t3", environmentId: "env-9", source: "test", pid: 0 },
      tokenSource: "test",
      http: { get: unexpectedCall },
      rpc: { call: unexpectedCall, stream: unexpectedCall, close() {} },
    }),
    api,
  );
  const server = new McpServer({ name: "test", version: "0" });
  registerTools(server, { getClient: async () => fake });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("");
    return result.isError ? { error: text } : JSON.parse(text);
  };
  return { client, call };
}

const provider: Provider = {
  instanceId: "testHarness",
  driver: "testHarness",
  enabled: true,
  installed: true,
  version: "1",
  status: "ready",
  auth: { status: "authenticated" },
  models: [{ slug: "model-large", name: "Large Model", aliases: ["large"], isDefault: true }],
};
const brokenProvider: Provider = {
  ...provider,
  instanceId: "missingHarness",
  driver: "missingHarness",
  installed: false,
  message: "missingHarness CLI missing",
  models: [],
};

const thread = (
  id: string,
  latestTurn: Thread["latestTurn"],
  extra: Partial<Thread> = {},
): Thread => ({
  id,
  projectId: "p1",
  title: "t",
  modelSelection: { instanceId: "testHarness", model: "model-large" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  latestTurn,
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  session: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...extra,
});

const detail = (
  shell: Thread,
  messages: ThreadSnapshot["thread"]["messages"] = [],
): ThreadSnapshot => {
  const {
    hasPendingApprovals: _a,
    hasPendingUserInput: _b,
    hasActionableProposedPlan: _c,
    ...rest
  } = shell;
  return { snapshotSequence: 1, thread: { ...rest, messages } };
};

const shell = (threads: Thread[]): ShellSnapshot => ({
  snapshotSequence: 1,
  projects: [
    { id: "p1", title: "proj", workspaceRoot: "C:\\code\\proj", defaultModelSelection: null },
  ],
  threads,
});

const refs: VcsListRefsResult = {
  isRepo: true,
  nextCursor: null,
  refs: [
    { name: "main", current: true, isDefault: true, worktreePath: "c:/code/proj" },
    { name: "feat", current: false, isDefault: false, worktreePath: "C:\\code\\proj-feat" },
    { name: "origin/main", current: false, isDefault: false, isRemote: true, worktreePath: null },
  ],
};

const done = (turnId: string, assistantMessageId: string) => ({
  turnId,
  state: "completed",
  startedAt: "2026-01-01T00:00:01.000Z",
  completedAt: "2026-01-01T00:00:02.000Z",
  assistantMessageId,
});
const running = (turnId: string) => ({
  turnId,
  state: "running",
  startedAt: "2026-01-01T00:00:01.000Z",
  completedAt: null,
  assistantMessageId: null,
});
const launch = (key: string, extra: Record<string, unknown> = {}) => ({
  project: "p1",
  harness: "testHarness",
  model: "large",
  title: "T",
  prompt: "go",
  idempotencyKey: key,
  ...extra,
});

describe("tool registry", () => {
  it("exposes the T3 tools with schemas and read-only annotations", async () => {
    const { client } = await harness({});
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).toSorted()).toEqual([
      "t3_cancel_turn",
      "t3_create_thread",
      "t3_get_thread",
      "t3_list_harnesses",
      "t3_list_projects",
      "t3_list_threads",
      "t3_list_worktrees",
      "t3_send_message",
      "t3_wait_for_turn",
    ]);
    const create = tools.find((t) => t.name === "t3_create_thread");
    const schema = z
      .object({
        type: z.string(),
        required: z.array(z.string()),
        properties: z.object({ harness: z.object({ description: z.string() }) }),
      })
      .parse(create?.inputSchema);
    expect(schema.type).toBe("object");
    for (const field of ["project", "harness", "model", "title", "prompt"]) {
      expect(schema.required).toContain(field);
    }
    expect(schema.properties.harness.description).toMatch(/t3_list_harnesses/);
    expect(tools.find((t) => t.name === "t3_list_projects")?.annotations).toMatchObject({
      readOnlyHint: true,
    });
    expect(tools.find((t) => t.name === "t3_cancel_turn")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it("reports schema violations and thrown errors as isError results", async () => {
    const { call } = await harness({ shell: async () => shell([]) });
    expect(toolError(await call("t3_create_thread", { project: "p1" }))).toMatch(
      /validation|Invalid/i,
    );
    expect(toolError(await call("t3_list_worktrees", { project: "zzz" }))).toMatch(
      /project "zzz" not found/,
    );
  });
});

describe("read tools", () => {
  it("lists projects, worktrees, harnesses, and threads", async () => {
    const threads = [
      thread("old", done("A", "a1"), { updatedAt: "2026-01-01T00:00:00.000Z" }),
      thread("new", running("B"), {
        updatedAt: "2026-02-01T00:00:00.000Z",
        hasPendingApprovals: true,
      }),
      thread("gone", null, {
        updatedAt: "2026-03-01T00:00:00.000Z",
        archivedAt: "2026-03-02T00:00:00.000Z",
      }),
    ];
    const { call } = await harness({
      shell: async () => shell(threads),
      listRefs: async () => refs,
      config: async () => ({ providers: [provider, brokenProvider] }),
    });

    expect(await call("t3_list_projects")).toEqual([
      { id: "p1", title: "proj", workspaceRoot: "C:\\code\\proj", defaultModelSelection: null },
    ]);

    const worktrees = await call("t3_list_worktrees", { project: "proj" });
    expect(worktrees).toMatchObject({
      worktrees: [
        { worktreePath: "C:\\code\\proj", branch: "main", isProjectRoot: true },
        { worktreePath: "C:\\code\\proj-feat", branch: "feat", isProjectRoot: false },
      ],
      branches: [{ name: "main" }, { name: "feat" }],
    });

    const usable = await call("t3_list_harnesses");
    expect(usable).toHaveLength(1);
    expect(usable).toMatchObject([
      {
        harnessId: "testHarness",
        usable: true,
        models: [{ model: "model-large", aliases: ["large"], isDefault: true }],
      },
    ]);
    const all = await call("t3_list_harnesses", { includeUnusable: true });
    expect(all).toMatchObject([
      {},
      { harnessId: "missingHarness", usable: false, reason: "missingHarness CLI missing" },
    ]);

    const listed = await call("t3_list_threads", { project: "p1" });
    expect(listed).toMatchObject([
      {
        threadId: "new",
        turn: { state: "running" },
        needsAttention: { pendingApprovals: true },
        url: "http://t3/env-9/new",
      },
      { threadId: "old" },
    ]);
    expect(await call("t3_list_threads", { includeArchived: true, limit: 1 })).toMatchObject([
      { threadId: "gone" },
    ]);
  });

  it("reads a thread window and truncates long messages", async () => {
    const long = "x".repeat(500);
    const snapshot = detail(thread("t1", done("A", "a1")), [
      { id: "u0", role: "user", text: "first", turnId: "A", streaming: false, createdAt: "" },
      { id: "u1", role: "user", text: "hi", turnId: "A", streaming: false, createdAt: "" },
      { id: "a1", role: "assistant", text: long, turnId: "A", streaming: false, createdAt: "" },
    ]);
    const limits: unknown[] = [];
    const { call } = await harness({
      thread: async (_id, turnLimit) => {
        limits.push(turnLimit);
        return snapshot;
      },
    });
    const result = z
      .object({ messages: z.array(z.object({ id: z.string(), text: z.string() })) })
      .parse(await call("t3_get_thread", { threadId: "t1", messageLimit: 2, maxChars: 100 }));
    expect(limits).toEqual([2]);
    expect(result.messages.map((m: { id: string }) => m.id)).toEqual(["u1", "a1"]);
    expect(result.messages[1]?.text).toMatch(/^x{100}\n…\[truncated 400 chars\]$/);
  });
});

describe("t3_create_thread", () => {
  it("bootstraps a thread on the project root and reports the web url", async () => {
    const ids = commandIds("launch", "k1");
    const created: unknown[] = [];
    const { call } = await harness({
      shell: async () => shell([]),
      config: async () => ({ providers: [provider] }),
      listRefs: async () => refs,
      createThread: async (spec) => {
        created.push(spec);
        return { sequence: 1 };
      },
      thread: async () => detail(thread(ids.threadId, null)),
    });
    const result = await call(
      "t3_create_thread",
      launch("k1", { context: [{ label: "Why", text: "because" }] }),
    );
    expect(result).toMatchObject({
      reused: false,
      idempotencyKey: "k1",
      threadId: ids.threadId,
      url: `http://t3/env-9/${ids.threadId}`,
    });
    expect(created[0]).toMatchObject({
      threadId: ids.threadId,
      commandId: ids.commandId,
      messageId: ids.messageId,
      modelSelection: { instanceId: "testHarness", model: "model-large" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      text: "go\n\n---\n\n### Why\n\nbecause",
    });
  });

  it("asks T3 for a fresh worktree from a known local branch", async () => {
    const created: Array<{ newWorktree?: unknown; branch: string | null }> = [];
    const { call } = await harness({
      shell: async () => shell([]),
      config: async () => ({ providers: [provider] }),
      listRefs: async () => refs,
      createThread: async (spec) => {
        created.push(spec);
        return { sequence: 1 };
      },
      thread: async (id) => detail(thread(id, null)),
    });
    expect(
      toolError(
        await call("t3_create_thread", launch("k2", { newWorktree: { baseBranch: "nope" } })),
      ),
    ).toMatch(/baseBranch "nope" is not a local branch.*main, feat/);
    expect(
      toolError(
        await call(
          "t3_create_thread",
          launch("k2", { newWorktree: { baseBranch: "main" }, worktreePath: "x" }),
        ),
      ),
    ).toMatch(/not both/);
    await call(
      "t3_create_thread",
      launch("k2", {
        newWorktree: { baseBranch: "main", branch: "feat/x", runSetupScript: false },
      }),
    );
    expect(created[0]).toMatchObject({
      branch: "feat/x",
      worktreePath: null,
      newWorktree: {
        projectCwd: "C:\\code\\proj",
        baseBranch: "main",
        branch: "feat/x",
        runSetupScript: false,
      },
    });
  });

  it("reuses a launched thread and finishes a half-launched one instead of re-bootstrapping", async () => {
    const ids = commandIds("launch", "k3");
    const started: unknown[] = [];
    const { call } = await harness({
      shell: async () => shell([thread(ids.threadId, null)]),
      config: async () => ({ providers: [provider] }),
      startTurn: async (spec) => {
        started.push(spec);
        return { sequence: 2 };
      },
      createThread: async () => {
        throw new Error("must not re-bootstrap");
      },
      thread: async () => detail(thread(ids.threadId, null)),
    });
    expect(await call("t3_create_thread", launch("k3"))).toMatchObject({
      reused: true,
      threadId: ids.threadId,
    });
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      commandId: ids.commandId,
      messageId: ids.messageId,
      threadId: ids.threadId,
    });

    const complete = await harness({
      shell: async () => shell([thread(ids.threadId, done("A", "a1"))]),
      config: async () => ({ providers: [provider] }),
      startTurn: async () => {
        throw new Error("must not start a turn");
      },
      thread: async () => detail(thread(ids.threadId, done("A", "a1"))),
    });
    expect(await complete.call("t3_create_thread", launch("k3"))).toMatchObject({ reused: true });
  });

  it("refuses unknown or unusable harnesses, models, and worktrees without substituting", async () => {
    const { call } = await harness({
      shell: async () => shell([]),
      config: async () => ({ providers: [provider, brokenProvider] }),
      listRefs: async () => refs,
    });
    expect(
      toolError(await call("t3_create_thread", launch("k4", { harness: "unknownHarness" }))),
    ).toMatch(/harness "unknownHarness" not found.*testHarness, missingHarness/);
    expect(
      toolError(await call("t3_create_thread", launch("k4", { harness: "missingHarness" }))),
    ).toMatch(/not usable right now: missingHarness CLI missing/);
    expect(
      toolError(await call("t3_create_thread", launch("k4", { model: "unknown-model" }))),
    ).toMatch(/not offered by harness "testHarness"/);
    expect(
      toolError(await call("t3_create_thread", launch("k4", { worktreePath: "/elsewhere" }))),
    ).toMatch(/is not a worktree of project "proj"/);
  });

  it("waits for its own turn when asked and returns the reply", async () => {
    const ids = commandIds("launch", "k5");
    const waited: unknown[] = [];
    const settled = detail(thread(ids.threadId, done("A", "a1")), [
      { id: "a1", role: "assistant", text: "PONG", turnId: "A", streaming: false, createdAt: "" },
    ]);
    const { call } = await harness({
      shell: async () => shell([]),
      config: async () => ({ providers: [provider] }),
      listRefs: async () => refs,
      createThread: async () => ({ sequence: 1 }),
      waitForTurn: async (threadId, timeoutMs, options) => {
        waited.push({ threadId, timeoutMs, options });
        return { snapshot: settled, timedOut: false };
      },
    });
    const result = await call("t3_create_thread", launch("k5", { wait: true, timeoutSeconds: 7 }));
    expect(waited).toEqual([
      { threadId: ids.threadId, timeoutMs: 7000, options: { expectedMessageId: ids.messageId } },
    ]);
    expect(result).toMatchObject({ timedOut: false, reply: { messageId: "a1", text: "PONG" } });
  });
});

describe("t3_send_message", () => {
  it("starts a turn with the thread's modes and skips when the message already landed", async () => {
    const ids = commandIds("t1", "f1");
    const started: unknown[] = [];
    const fresh = detail(
      thread("t1", done("A", "a1"), { runtimeMode: "auto", interactionMode: "plan" }),
    );
    const { call } = await harness({
      thread: async () => fresh,
      startTurn: async (spec) => {
        started.push(spec);
        return { sequence: 3 };
      },
    });
    expect(
      await call("t3_send_message", { threadId: "t1", prompt: "more", idempotencyKey: "f1" }),
    ).toMatchObject({ reused: false, threadId: "t1" });
    expect(started[0]).toMatchObject({
      threadId: "t1",
      commandId: ids.commandId,
      messageId: ids.messageId,
      text: "more",
      runtimeMode: "auto",
      interactionMode: "plan",
    });

    const landed = detail(thread("t1", running("B")), [
      {
        id: ids.messageId,
        role: "user",
        text: "more",
        turnId: "B",
        streaming: false,
        createdAt: "",
      },
    ]);
    const again = await harness({
      thread: async () => landed,
      startTurn: async () => {
        throw new Error("must not start twice");
      },
    });
    expect(
      await again.call("t3_send_message", { threadId: "t1", prompt: "more", idempotencyKey: "f1" }),
    ).toMatchObject({ reused: true });
  });
});

describe("t3_cancel_turn and t3_wait_for_turn", () => {
  it("is a no-op without a running turn and interrupts a running one", async () => {
    const idle = await harness({ thread: async () => detail(thread("t1", done("A", "a1"))) });
    expect(await idle.call("t3_cancel_turn", { threadId: "t1" })).toMatchObject({
      cancelled: false,
      reason: "No turn is running.",
    });

    const interrupts: unknown[] = [];
    const busy = await harness({
      thread: async () => detail(thread("t1", running("B"))),
      interruptTurn: async (_commandId, threadId, turnId) => {
        interrupts.push({ threadId, turnId });
        return { sequence: 4 };
      },
      waitForTurn: async () => ({
        snapshot: detail(thread("t1", { ...running("B"), state: "interrupted" })),
        timedOut: false,
      }),
    });
    expect(await busy.call("t3_cancel_turn", { threadId: "t1" })).toMatchObject({
      cancelled: true,
      turn: { state: "interrupted" },
    });
    expect(interrupts).toEqual([{ threadId: "t1", turnId: "B" }]);
  });

  it("returns the latest reply and the timeout flag when waiting", async () => {
    const snapshot = detail(thread("t1", running("B")), [
      { id: "a0", role: "assistant", text: "partial", turnId: "B", streaming: true, createdAt: "" },
    ]);
    const { call } = await harness({ waitForTurn: async () => ({ snapshot, timedOut: true }) });
    expect(await call("t3_wait_for_turn", { threadId: "t1", timeoutSeconds: 1 })).toMatchObject({
      timedOut: true,
      reply: { messageId: "a0", streaming: true, text: "partial" },
    });
  });
});
