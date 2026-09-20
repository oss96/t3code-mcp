import { describe, expect, it } from "bun:test";

import { commandIds, deterministicId } from "../../src/t3/command-ids.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("deterministicId", () => {
  it("is stable, UUID-v4 shaped, and distinct per namespace and key", () => {
    const id = deterministicId("thread:launch", "k");
    expect(id).toBe(deterministicId("thread:launch", "k"));
    expect(id).toMatch(UUID_V4);
    expect(id).not.toBe(deterministicId("command:launch", "k"));
    expect(id).not.toBe(deterministicId("thread:launch", "other"));
  });
});

describe("commandIds", () => {
  it("preserves existing retry ids across project renames", () => {
    expect(commandIds("launch", "stable-key")).toEqual({
      idempotencyKey: "stable-key",
      threadId: "9e7db5fc-ec5b-4f79-a1ab-05a2d1f08e84",
      commandId: "98dca36e-eaa5-41a7-89ba-9050a55475e0",
      messageId: "f14a1c0c-9991-474f-aa14-a3461aee9b4a",
    });
  });

  it("derives distinct thread, command, and message ids from one trimmed key", () => {
    const ids = commandIds("launch", " key-1 ");
    expect(ids.idempotencyKey).toBe("key-1");
    expect(new Set([ids.threadId, ids.commandId, ids.messageId]).size).toBe(3);
    expect(commandIds("launch", "key-1")).toEqual(ids);
    expect(commandIds("thread-9", "key-1").messageId).not.toBe(ids.messageId);
  });

  it("falls back to random ids without a key", () => {
    const a = commandIds("launch");
    const b = commandIds("launch", "");
    expect(a.threadId).toMatch(UUID_V4);
    expect(a.threadId).not.toBe(b.threadId);
  });
});
