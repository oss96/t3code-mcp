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
export const shellSnapshotSchema = z.object({
  snapshotSequence: z.number(),
  projects: z.array(projectSchema),
  threads: z.array(threadSchema),
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
export const threadSnapshotSchema = z.object({
  snapshotSequence: z.number(),
  thread: threadDetailSchema,
});

export type Project = z.infer<typeof projectSchema>;
export type LatestTurn = z.infer<typeof latestTurnSchema>;
export type Thread = z.infer<typeof threadSchema>;
export type ShellSnapshot = z.infer<typeof shellSnapshotSchema>;
export type Message = z.infer<typeof messageSchema>;
export type ThreadDetail = z.infer<typeof threadDetailSchema>;
export type ThreadSnapshot = z.infer<typeof threadSnapshotSchema>;
