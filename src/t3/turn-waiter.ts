import type { T3Connection } from "./connection.ts";
import { TERMINAL_RUN_STATUSES, type ThreadSnapshot } from "./contracts/orchestration.ts";
import { readThreadSnapshot } from "./thread-snapshot.ts";

export interface WaitForTurnOptions {
  /** Only the turn that carries this user message counts as the awaited one. */
  expectedMessageId?: string;
  pollIntervalMs?: number;
}

export interface WaitForTurnResult {
  snapshot: ThreadSnapshot;
  timedOut: boolean;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls the thread projection until the awaited run reaches a terminal status, as T3's own wait does. */
export async function waitForTurn(
  connection: T3Connection,
  threadId: string,
  timeoutMs: number,
  options: WaitForTurnOptions = {},
): Promise<WaitForTurnResult> {
  const deadline = Date.now() + timeoutMs;
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let snapshot = await readThreadSnapshot(connection.http, threadId, 1);
  while (!isTurnSettled(snapshot, options)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { snapshot, timedOut: true };
    }
    await sleep(Math.min(interval, remaining));
    snapshot = await readThreadSnapshot(connection.http, threadId, 1);
  }
  return { snapshot, timedOut: false };
}

export function isTurnSettled(snapshot: ThreadSnapshot, options: WaitForTurnOptions = {}): boolean {
  const { latestTurn: turn, messages } = snapshot.thread;
  if (!turn) {
    return options.expectedMessageId === undefined;
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
  if (!TERMINAL_RUN_STATUSES.has(turn.state)) {
    return false;
  }
  const assistant = turn.assistantMessageId
    ? messages.find((m) => m.id === turn.assistantMessageId)
    : undefined;
  return !(assistant?.streaming ?? false);
}
