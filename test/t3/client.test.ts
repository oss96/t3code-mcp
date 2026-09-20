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

const turn = (turnId: string, state: string, assistantMessageId: string | null = null) => ({
  turnId,
  state,
  startedAt: "2026-01-01T00:00:01.000Z",
  completedAt: null,
  assistantMessageId,
});

describe("isTurnSettled", () => {
  it("is false without a turn or while running, true once the reply stopped streaming", () => {
    expect(isTurnSettled(snapshot(null, []))).toBe(false);
    expect(isTurnSettled(snapshot(turn("A", "running"), []))).toBe(false);
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
    const fake = fakeConnection([settled], []);
    const result = await new T3Client(fake.conn).waitForTurn("t1", 1000);
    expect(result.timedOut).toBe(false);
    expect(fake.streams()).toBe(0);
  });

  it("re-reads after a settle hint and keeps one stream open across non-terminal events", async () => {
    const running = snapshot(turn("A", "running"), [], 1);
    const settled = snapshot(turn("A", "completed", "a1"), [message("a1", "assistant", "A")], 2);
    const fake = fakeConnection(
      [running, running, settled],
      [
        { kind: "event", event: { type: "thread.activity-appended" } },
        { kind: "event", event: { type: "thread.message-sent" } },
        { kind: "event", event: { type: "thread.session-set" } },
      ],
    );
    const result = await new T3Client(fake.conn).waitForTurn("t1", 5000);
    expect(result.timedOut).toBe(false);
    expect(result.snapshot.thread.latestTurn?.state).toBe("completed");
    expect(fake.streams()).toBe(1);
    expect(fake.reads()).toBe(3);
  });

  it("reports timedOut when no hint arrives before the deadline", async () => {
    const running = snapshot(turn("A", "running"), []);
    const fake = fakeConnection(
      [running],
      [{ kind: "event", event: { type: "thread.activity-appended" } }],
    );
    const result = await new T3Client(fake.conn).waitForTurn("t1", 120);
    expect(result.timedOut).toBe(true);
  });

  it("asserts the snapshot shape so contract drift fails loudly", async () => {
    const broken = { snapshotSequence: 1, thread: { id: "t1" } };
    const fake = fakeConnection([broken], []);
    await expect(new T3Client(fake.conn).thread("t1")).rejects.toThrow(/contract may have changed/);
  });

  it("rejects malformed message fields instead of trusting their declared types", async () => {
    const valid = snapshot(turn("A", "completed", "a1"), []);
    const broken = {
      ...valid,
      thread: {
        ...valid.thread,
        messages: [{ ...message("a1", "assistant", "A"), streaming: "false" }],
      },
    };
    const fake = fakeConnection([broken], []);
    await expect(new T3Client(fake.conn).thread("t1")).rejects.toThrow(
      /thread.messages.0.streaming/,
    );
  });

  it("accepts additional server fields and future turn states and message roles", async () => {
    const future = { ...snapshot(turn("A", "queued"), [message("m1", "tool", "A")]), extra: true };
    const fake = fakeConnection([future], []);
    const result = await new T3Client(fake.conn).thread("t1");
    expect(result.thread.latestTurn?.state).toBe("queued");
    expect(result.thread.messages[0]?.role).toBe("tool");
  });
});

describe("commands", () => {
  it("wraps thread creation in a bootstrap and follow-ups in a plain turn start", async () => {
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
    await api.startTurn({
      commandId: "c2",
      threadId: "t1",
      messageId: "m2",
      text: "more",
      runtimeMode: "auto",
      interactionMode: "default",
    });
    expect(fake.calls[1]?.payload).toMatchObject({
      type: "thread.turn.start",
      commandId: "c2",
      message: { messageId: "m2", text: "more" },
    });
    expect(fake.calls[1]?.payload).not.toHaveProperty("bootstrap");
    await api.interruptTurn("c3", "t1", "turn-1");
    expect(fake.calls[2]?.payload).toMatchObject({
      type: "thread.turn.interrupt",
      commandId: "c3",
      threadId: "t1",
      turnId: "turn-1",
    });
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
