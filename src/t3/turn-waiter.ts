import * as z from "zod/v4";

import type { T3Connection } from "./connection.ts";
import type { ThreadSnapshot } from "./contracts/orchestration.ts";
import { readThreadSnapshot } from "./thread-snapshot.ts";

export interface WaitForTurnOptions {
  /** Only the turn that carries this user message counts as the awaited one. */
  expectedMessageId?: string;
}

export interface WaitForTurnResult {
  snapshot: ThreadSnapshot;
  timedOut: boolean;
}

const threadEventSchema = z.object({
  kind: z.literal("event"),
  event: z.object({ type: z.string() }),
});

const SETTLE_HINTS = new Set([
  "thread.session-set",
  "thread.settled",
  "thread.turn-interrupt-requested",
  "thread.turn-diff-completed",
]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Settlement events can precede HTTP snapshots; reread before accepting a result.
export async function waitForTurn(
  connection: T3Connection,
  threadId: string,
  timeoutMs: number,
  options: WaitForTurnOptions = {},
): Promise<WaitForTurnResult> {
  const deadline = Date.now() + timeoutMs;
  let snapshot = await readThreadSnapshot(connection.http, threadId, 1);
  if (isTurnSettled(snapshot, options)) {
    return { snapshot, timedOut: false };
  }
  while (Date.now() < deadline) {
    let hinted = false;
    await connection.rpc.stream(
      "orchestration.subscribeThread",
      { threadId, turnLimit: 1, afterSequence: snapshot.snapshotSequence },
      (item) => {
        const record = threadEventSchema.safeParse(item);
        if (!record.success || !SETTLE_HINTS.has(record.data.event.type)) {
          return false;
        }
        hinted = true;
        return true;
      },
      Math.max(0, deadline - Date.now()),
    );
    if (!hinted) {
      break;
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      snapshot = await readThreadSnapshot(connection.http, threadId, 1);
      if (isTurnSettled(snapshot, options)) {
        return { snapshot, timedOut: false };
      }
      await sleep(150 * (attempt + 1));
    }
  }
  return { snapshot: await readThreadSnapshot(connection.http, threadId, 1), timedOut: true };
}

export function isTurnSettled(snapshot: ThreadSnapshot, options: WaitForTurnOptions = {}): boolean {
  const { latestTurn: turn, messages } = snapshot.thread;
  if (!turn) {
    return false;
  }
  if (options.expectedMessageId) {
    const own = messages.find((m) => m.id === options.expectedMessageId);
    if (!own) {
      return false;
    }
    // The user message is committed before its turn exists; until then the previous, settled turn is still "latest".
    const belongsToTurn = own.turnId
      ? own.turnId === turn.turnId
      : turn.startedAt !== null && turn.startedAt >= own.createdAt;
    if (!belongsToTurn) {
      return false;
    }
  }
  if (turn.state === "running") {
    return false;
  }
  const assistant = turn.assistantMessageId
    ? messages.find((m) => m.id === turn.assistantMessageId)
    : undefined;
  return !(assistant?.streaming ?? false);
}
