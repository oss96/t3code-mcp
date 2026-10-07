import { randomUUID } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { commandIds } from "../../t3/command-ids.ts";
import { ACTIVE_RUN_STATUSES } from "../../t3/contracts/orchestration.ts";
import { composeMessage, summarizeThread, turnResult } from "../presenters.ts";
import { MUTATING, READ_ONLY, registerJsonTool, type ClientSource } from "../register-tool.ts";
import {
  contextSchema,
  interactionModeSchema,
  runtimeModeSchema,
  waitFields,
  waitTimeoutMs,
} from "../schemas.ts";

export function registerTurnTools(server: McpServer, source: ClientSource): void {
  registerJsonTool(
    server,
    "t3_send_message",
    {
      title: "Send a follow-up prompt",
      description:
        "Send another user message to an existing T3 thread with the thread's current harness and model. Works while a turn is running: T3 steers the running turn, or queues the message when the harness cannot steer, exactly as the T3 UI does. A retry with the same idempotencyKey is always safe.",
      input: {
        threadId: z.string(),
        prompt: z.string().min(1),
        context: contextSchema,
        runtimeMode: runtimeModeSchema.optional().describe("Default: the thread's current mode"),
        interactionMode: interactionModeSchema
          .optional()
          .describe("Default: the thread's current mode"),
        idempotencyKey: z
          .string()
          .optional()
          .describe("Stable key; retries with the same key do not start a second turn"),
        ...waitFields,
      },
      annotations: MUTATING,
    },
    async (input) => {
      const client = await source.getClient();
      const before = await client.thread(input.threadId);
      const ids = commandIds(input.threadId, input.idempotencyKey);
      const alreadySent = before.thread.messages.some((m) => m.id === ids.messageId);
      // No "turn is running" guard on purpose: T3 resolves the auto delivery intent to steer or queue mid-turn.
      // Safe even if the message landed after our read: T3 replays the receipt for a repeated commandId.
      if (!alreadySent) {
        const { runtimeMode, interactionMode } = input;
        await client.sendMessage({
          ...ids,
          threadId: input.threadId,
          text: composeMessage(input.prompt, input.context),
          ...(runtimeMode && runtimeMode !== before.thread.runtimeMode ? { runtimeMode } : {}),
          ...(interactionMode && interactionMode !== before.thread.interactionMode
            ? { interactionMode }
            : {}),
        });
      }
      const base = { reused: alreadySent, idempotencyKey: ids.idempotencyKey };
      if (input.wait) {
        const { snapshot, timedOut } = await client.waitForTurn(
          input.threadId,
          waitTimeoutMs(input.timeoutSeconds),
          { expectedMessageId: ids.messageId },
        );
        return { ...base, ...turnResult(client, snapshot, timedOut) };
      }
      return {
        ...base,
        ...summarizeThread(client, (await client.thread(input.threadId, 1)).thread),
      };
    },
  );

  registerJsonTool(
    server,
    "t3_wait_for_turn",
    {
      title: "Wait for the current turn",
      description:
        "Block until the thread's latest turn finishes (or the timeout passes) and return the assistant reply. Prefer wait=true on t3_create_thread / t3_send_message, which know exactly which turn to wait for.",
      input: {
        threadId: z.string(),
        timeoutSeconds: z.number().int().min(1).max(3600).optional().describe("Default 300"),
      },
      annotations: READ_ONLY,
    },
    async ({ threadId, timeoutSeconds }) => {
      const client = await source.getClient();
      const { snapshot, timedOut } = await client.waitForTurn(
        threadId,
        waitTimeoutMs(timeoutSeconds),
      );
      return turnResult(client, snapshot, timedOut);
    },
  );

  registerJsonTool(
    server,
    "t3_cancel_turn",
    {
      title: "Cancel the running turn",
      description:
        "Interrupt the thread's running turn. No-op with a clear message if nothing is running.",
      input: { threadId: z.string() },
      annotations: { ...MUTATING, destructiveHint: true },
    },
    async ({ threadId }) => {
      const client = await source.getClient();
      const before = await client.thread(threadId, 1);
      const turn = before.thread.latestTurn;
      if (!turn || !ACTIVE_RUN_STATUSES.has(turn.state)) {
        return {
          cancelled: false,
          reason: "No turn is running.",
          ...summarizeThread(client, before.thread),
        };
      }
      await client.interruptTurn(randomUUID(), threadId, turn.turnId);
      const { snapshot } = await client.waitForTurn(threadId, 15_000);
      return { cancelled: true, ...summarizeThread(client, snapshot.thread) };
    },
  );
}
