import * as z from "zod/v4";

import { modelSelectionSchema } from "./providers.ts";

export const RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const;
export const INTERACTION_MODES = ["default", "plan"] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];
export type InteractionMode = (typeof INTERACTION_MODES)[number];

export const projectSchema = z.object({
  id: z.string(),
  title: z.string(),
  workspaceRoot: z.string(),
  defaultModelSelection: modelSelectionSchema.nullable(),
});
export const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);
export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);

export const latestTurnSchema = z.object({
  turnId: z.string(),
  state: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  assistantMessageId: z.string().nullable(),
});
export const threadSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  modelSelection: modelSelectionSchema,
  runtimeMode: z.enum(RUNTIME_MODES),
  interactionMode: z.enum(INTERACTION_MODES),
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  latestTurn: latestTurnSchema.nullable(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  session: z.object({ status: z.string(), lastError: z.string().nullable() }).nullable(),
  // Attention flags appear only in shell snapshots.
  hasPendingApprovals: z.boolean().optional(),
  hasPendingUserInput: z.boolean().optional(),
  hasActionableProposedPlan: z.boolean().optional(),
});
export const messageSchema = z.object({
  id: z.string(),
  role: z.string(),
  text: z.string(),
  turnId: z.string().nullable(),
  streaming: z.boolean(),
  createdAt: z.string(),
});
export const threadDetailSchema = threadSchema.extend({ messages: z.array(messageSchema) });

const threadBaseWireSchema = threadSchema.pick({
  id: true,
  projectId: true,
  title: true,
  modelSelection: true,
  runtimeMode: true,
  interactionMode: true,
  branch: true,
  worktreePath: true,
  updatedAt: true,
  archivedAt: true,
});
const shellThreadWireSchema = threadBaseWireSchema
  .extend({
    latestRunId: z.string().nullable(),
    latestRunStartedAt: z.string().nullish(),
    latestRunCompletedAt: z.string().nullish(),
    status: z.string(),
    lastError: z.string().nullish(),
    pendingRuntimeRequest: z.object({ kind: z.string() }).nullable(),
    hasActionableProposedPlan: z.boolean(),
  })
  .transform(
    ({
      latestRunId,
      latestRunStartedAt,
      latestRunCompletedAt,
      status,
      lastError,
      pendingRuntimeRequest,
      ...thread
    }): Thread => ({
      ...thread,
      latestTurn: latestRunId
        ? {
            turnId: latestRunId,
            state: status,
            startedAt: latestRunStartedAt ?? null,
            completedAt: latestRunCompletedAt ?? null,
            assistantMessageId: null,
          }
        : null,
      session: { status, lastError: lastError ?? null },
      hasPendingApprovals:
        pendingRuntimeRequest !== null && pendingRuntimeRequest.kind !== "user_input",
      hasPendingUserInput: pendingRuntimeRequest?.kind === "user_input",
    }),
  );
export const shellSnapshotSchema = z.object({
  snapshotSequence: z.number(),
  projects: z.array(projectSchema),
  threads: z.array(shellThreadWireSchema),
});

const runWireSchema = z.object({
  id: z.string(),
  ordinal: z.number(),
  status: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
const providerSessionWireSchema = z.object({
  status: z.string(),
  lastError: z.string().nullable(),
  updatedAt: z.string(),
});
const messageWireSchema = messageSchema
  .omit({ turnId: true })
  .extend({ runId: z.string().nullable() })
  .transform(({ runId, ...message }): Message => ({ ...message, turnId: runId }));
export const threadSnapshotSchema = z
  .object({
    snapshotSequence: z.number(),
    projection: z.object({
      thread: threadBaseWireSchema,
      runs: z.array(runWireSchema),
      providerSessions: z.array(providerSessionWireSchema),
      messages: z.array(messageWireSchema),
    }),
  })
  .transform(({ snapshotSequence, projection }): ThreadSnapshot => {
    const { thread, runs, providerSessions, messages } = projection;
    const newestFirst = runs.toSorted((a, b) => b.ordinal - a.ordinal);
    const run = newestFirst.find((r) => ACTIVE_RUN_STATUSES.has(r.status)) ?? newestFirst[0];
    const session = providerSessions.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const reply = run
      ? messages.toReversed().find((m) => m.role === "assistant" && m.turnId === run.id)
      : undefined;
    return {
      snapshotSequence,
      thread: {
        ...thread,
        latestTurn: run
          ? {
              turnId: run.id,
              state: run.status,
              startedAt: run.startedAt,
              completedAt: run.completedAt,
              assistantMessageId: reply?.id ?? null,
            }
          : null,
        session: session ? { status: session.status, lastError: session.lastError } : null,
        messages,
      },
    };
  });

export type Project = z.infer<typeof projectSchema>;
export type LatestTurn = z.infer<typeof latestTurnSchema>;
export type Thread = z.infer<typeof threadSchema>;
export type ShellSnapshot = z.output<typeof shellSnapshotSchema>;
export type Message = z.infer<typeof messageSchema>;
export type ThreadDetail = z.infer<typeof threadDetailSchema>;
export interface ThreadSnapshot {
  snapshotSequence: number;
  thread: ThreadDetail;
}
