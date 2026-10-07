import { describe, expect, it } from "bun:test";

import { T3Client } from "../../src/t3/client.ts";
import type { T3Connection } from "../../src/t3/connection.ts";
import type { Message, ThreadSnapshot } from "../../src/t3/contracts/orchestration.ts";
import { isTurnSettled } from "../../src/t3/turn-waiter.ts";

const message = (
  id: string,
  role: Message["role"],
  turnId: string | null,
  extra: Partial<Message> = {},
): Message => ({
  id,
  role,
  text: role === "user" ? "hi" : "reply",
  turnId,
  streaming: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});

const snapshot = (
  latestTurn: ThreadSnapshot["thread"]["latestTurn"],
  messages: Message[],
  snapshotSequence = 1,
): ThreadSnapshot => ({
  snapshotSequence,
  thread: {
    id: "t1",
    projectId: "p1",
    title: "t",
    modelSelection: { instanceId: "testHarness", model: "m" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn,
    updatedAt: "",
    archivedAt: null,
    session: null,
    messages,
  },
});

const wire = ({ snapshotSequence, thread }: ThreadSnapshot) => {
  const { latestTurn, session: _session, messages, ...base } = thread;
  return {
    snapshotSequence,
    projection: {
      thread: base,
      runs: latestTurn
        ? [
            {
              id: latestTurn.turnId,
              ordinal: 1,
              status: latestTurn.state,
              startedAt: latestTurn.startedAt,
              completedAt: latestTurn.completedAt,
            },
          ]
        : [],
      providerSessions: [],
      messages: messages.map(({ turnId, ...m }) => Object.assign(m, { runId: turnId })),
    },
  };
};

const turn = (turnId: string, state: string, assistantMessageId: string | null = null) => ({
  turnId,
  state,
  startedAt: "2026-01-01T00:00:01.000Z",
  completedAt: null,
  assistantMessageId,
});

describe("isTurnSettled", () => {
  it("treats a thread without runs as settled unless a specific message is awaited", () => {
    expect(isTurnSettled(snapshot(null, []))).toBe(true);
    expect(isTurnSettled(snapshot(null, []), { expectedMessageId: "u1" })).toBe(false);
  });

  it("is false until the run is terminal and the reply stopped streaming", () => {
    for (const state of ["preparing", "queued", "starting", "running", "waiting", "future"]) {
      expect(isTurnSettled(snapshot(turn("A", state), []))).toBe(false);
    }
    for (const state of ["failed", "cancelled", "interrupted", "rolled_back"]) {
      expect(isTurnSettled(snapshot(turn("A", state), []))).toBe(true);
    }
    expect(
      isTurnSettled(
        snapshot(turn("A", "completed", "a1"), [
          message("a1", "assistant", "A", { streaming: true }),
        ]),
      ),
    ).toBe(false);
    expect(
      isTurnSettled(snapshot(turn("A", "completed", "a1"), [message("a1", "assistant", "A")])),
    ).toBe(true);
  });

  it("with expectedMessageId ignores the previous settled turn until the new one exists", () => {
    const previous = turn("A", "completed", "a1");
    expect(
      isTurnSettled(snapshot(previous, [message("a1", "assistant", "A")]), {
        expectedMessageId: "u2",
      }),
    ).toBe(false);
    const ours = message("u2", "user", null, { createdAt: "2026-01-01T00:00:05.000Z" });
    expect(
      isTurnSettled(snapshot(previous, [message("a1", "assistant", "A"), ours]), {
        expectedMessageId: "u2",
      }),
    ).toBe(false);
    const done = { ...turn("B", "completed", "a2"), startedAt: "2026-01-01T00:00:06.000Z" };
    expect(
      isTurnSettled(snapshot(done, [ours, message("a2", "assistant", "B")]), {
        expectedMessageId: "u2",
      }),
    ).toBe(true);
    const later = snapshot(turn("C", "completed", "a3"), [
      message("u2", "user", "B"),
      message("a3", "assistant", "C"),
    ]);
    expect(isTurnSettled(later, { expectedMessageId: "u2" })).toBe(false);
  });
});

function fakeConnection(
  snapshots: unknown[],
  events: Array<{ kind: string; event?: { type: string } }>,
) {
  let reads = 0;
  let streams = 0;
  const calls: Array<{ tag: string; payload: unknown }> = [];
  const conn: T3Connection = {
    server: { origin: "http://x", source: "", pid: 0, environmentId: "e" },
    tokenSource: "test",
    http: {
      get: async () => {
        const current = snapshots[Math.min(reads, snapshots.length - 1)];
        reads++;
        return current;
      },
    },
    rpc: {
      call: async (tag: string, payload: unknown) => {
        calls.push({ tag, payload });
        return { sequence: calls.length };
      },
      stream: async (_tag, _payload, onChunk, timeoutMs) => {
        streams++;
        for (const event of events) {
          if (onChunk(event) === true) {
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs ?? 0, 50)));
      },
      close: () => {},
    },
  };
  return { conn, calls, reads: () => reads, streams: () => streams };
}

describe("waitForTurn", () => {
  it("returns at once when already settled without opening a stream", async () => {
    const settled = snapshot(turn("A", "completed", "a1"), [message("a1", "assistant", "A")]);
    const fake = fakeConnection([wire(settled)], []);
    const result = await new T3Client(fake.conn).waitForTurn("t1", 1000);
    expect(result.timedOut).toBe(false);
    expect(fake.streams()).toBe(0);
  });

  it("polls the projection until the run is terminal without subscribing to events", async () => {
    const running = snapshot(turn("A", "running"), [], 1);
    const settled = snapshot(turn("A", "completed", "a1"), [message("a1", "assistant", "A")], 2);
    const fake = fakeConnection([wire(running), wire(running), wire(settled)], []);
    const result = await new T3Client(fake.conn).waitForTurn("t1", 5000, { pollIntervalMs: 5 });
    expect(result.timedOut).toBe(false);
    expect(result.snapshot.thread.latestTurn?.state).toBe("completed");
    expect(fake.streams()).toBe(0);
    expect(fake.reads()).toBe(3);
  });

  it("reports timedOut when the run is still active at the deadline", async () => {
    const running = snapshot(turn("A", "running"), []);
    const fake = fakeConnection([wire(running)], []);
    const result = await new T3Client(fake.conn).waitForTurn("t1", 120, { pollIntervalMs: 20 });
    expect(result.timedOut).toBe(true);
    expect(fake.reads()).toBeGreaterThan(1);
  });

  it("tracks the active run rather than a newer queued one, and links replies by runId", async () => {
    const base = wire(snapshot(null, []));
    const projection = {
      ...base.projection,
      runs: [
        { id: "R1", ordinal: 1, status: "running", startedAt: "s1", completedAt: null },
        { id: "R2", ordinal: 2, status: "queued", startedAt: null, completedAt: null },
      ],
      providerSessions: [
        { status: "stopped", lastError: null, updatedAt: "2026-01-01T00:00:00.000Z" },
        { status: "running", lastError: null, updatedAt: "2026-01-02T00:00:00.000Z" },
      ],
      messages: [
        { ...message("a1", "assistant", null), runId: "R1" },
        { ...message("a2", "assistant", null), runId: "R1", streaming: true },
      ],
    };
    const fake = fakeConnection([{ ...base, projection }], []);
    const { thread } = await new T3Client(fake.conn).thread("t1");
    expect(thread.latestTurn).toEqual({
      turnId: "R1",
      state: "running",
      startedAt: "s1",
      completedAt: null,
      assistantMessageId: "a2",
    });
    expect(thread.session).toEqual({ status: "running", lastError: null });
    expect(thread.messages.map((m) => m.turnId)).toEqual(["R1", "R1"]);
  });

  it("asserts the snapshot shape so contract drift fails loudly", async () => {
    const broken = { snapshotSequence: 1, thread: { id: "t1" } };
    const fake = fakeConnection([broken], []);
    await expect(new T3Client(fake.conn).thread("t1")).rejects.toThrow(/contract may have changed/);
  });

  it("rejects malformed message fields instead of trusting their declared types", async () => {
    const valid = wire(snapshot(turn("A", "completed", "a1"), []));
    const broken = {
      ...valid,
      projection: {
        ...valid.projection,
        messages: [{ ...message("a1", "assistant", "A"), runId: "A", streaming: "false" }],
      },
    };
    const fake = fakeConnection([broken], []);
    await expect(new T3Client(fake.conn).thread("t1")).rejects.toThrow(
      /projection.messages.0.streaming/,
    );
  });

  it("accepts additional server fields and future turn states and message roles", async () => {
    const future = {
      ...wire(snapshot(turn("A", "queued"), [message("m1", "tool", "A")])),
      extra: true,
    };
    const fake = fakeConnection([future], []);
    const result = await new T3Client(fake.conn).thread("t1");
    expect(result.thread.latestTurn?.state).toBe("queued");
    expect(result.thread.messages[0]?.role).toBe("tool");
  });
});

describe("commands", () => {
  it("wraps thread creation in a bootstrap", async () => {
    const fake = fakeConnection([], []);
    const api = new T3Client(fake.conn);
    await api.createThread({
      commandId: "c1",
      threadId: "t1",
      messageId: "m1",
      projectId: "p1",
      title: "T",
      modelSelection: { instanceId: "missingHarness", model: "test-model" },
      runtimeMode: "auto",
      interactionMode: "plan",
      branch: null,
      worktreePath: null,
      text: "go",
      newWorktree: { projectCwd: "/repo", baseBranch: "main", runSetupScript: false },
    });
    expect(fake.calls[0]?.tag).toBe("orchestration.dispatchCommand");
    expect(fake.calls[0]?.payload).toMatchObject({
      type: "thread.turn.start",
      commandId: "c1",
      threadId: "t1",
      titleSeed: "T",
      message: { messageId: "m1", role: "user", text: "go", attachments: [] },
      bootstrap: {
        createThread: {
          projectId: "p1",
          title: "T",
          modelSelection: { instanceId: "missingHarness", model: "test-model" },
          runtimeMode: "auto",
          interactionMode: "plan",
        },
        prepareWorktree: { projectCwd: "/repo", baseBranch: "main" },
        runSetupScript: false,
      },
    });
  });

  it("sends follow-ups as protocol-2 message.dispatch with server-resolved delivery", async () => {
    const fake = fakeConnection([], []);
    const api = new T3Client(fake.conn);
    await api.sendMessage({ commandId: "c2", threadId: "t1", messageId: "m2", text: "more" });
    expect(fake.calls).toEqual([
      {
        tag: "orchestration.dispatchCommand",
        payload: {
          type: "message.dispatch",
          commandId: "c2",
          threadId: "t1",
          createdBy: "user",
          creationSource: "mcp",
          messageId: "m2",
          text: "more",
          attachments: [],
          deliveryIntent: "auto",
          dispatchMode: { type: "start_immediately" },
        },
      },
    ]);
  });

  it("sets overridden modes with their own derived command ids before dispatching", async () => {
    const fake = fakeConnection([], []);
    await new T3Client(fake.conn).sendMessage({
      commandId: "c2",
      threadId: "t1",
      messageId: "m2",
      text: "more",
      runtimeMode: "auto",
      interactionMode: "plan",
    });
    expect(fake.calls.map((c) => c.payload)).toEqual([
      {
        type: "thread.runtime-mode.set",
        commandId: "c2:runtime-mode",
        threadId: "t1",
        runtimeMode: "auto",
      },
      {
        type: "thread.interaction-mode.set",
        commandId: "c2:interaction-mode",
        threadId: "t1",
        interactionMode: "plan",
      },
      expect.objectContaining({ type: "message.dispatch", commandId: "c2" }),
    ]);
  });

  it("interrupts a run with run.interrupt", async () => {
    const fake = fakeConnection([], []);
    await new T3Client(fake.conn).interruptTurn("c3", "t1", "run-1");
    expect(fake.calls).toEqual([
      {
        tag: "orchestration.dispatchCommand",
        payload: { type: "run.interrupt", commandId: "c3", threadId: "t1", runId: "run-1" },
      },
    ]);
  });

  it("follows vcs.listRefs cursors until the last page", async () => {
    const fake = fakeConnection([], []);
    let page = 0;
    fake.conn.rpc.call = async () => {
      page++;
      return {
        refs: [
          { name: page === 1 ? "a" : "b", current: false, isDefault: false, worktreePath: null },
        ],
        isRepo: true,
        nextCursor: page === 1 ? 200 : null,
      };
    };
    const result = await new T3Client(fake.conn).listRefs("/repo");
    expect(result.refs.map((r) => r.name)).toEqual(["a", "b"]);
    expect(result.nextCursor).toBeNull();
    expect(page).toBe(2);
  });
});
