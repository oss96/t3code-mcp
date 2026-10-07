import * as z from "zod/v4";

import type { InteractionMode, RuntimeMode, Thread } from "./orchestration.ts";
import type { ModelSelection } from "./providers.ts";

interface ThreadCommand {
  commandId: string;
  threadId: string;
}

export interface PrepareWorktree {
  projectCwd: string;
  baseBranch: string;
  branch?: string;
}

export interface ThreadBootstrap {
  createThread: Pick<
    Thread,
    | "projectId"
    | "title"
    | "modelSelection"
    | "runtimeMode"
    | "interactionMode"
    | "branch"
    | "worktreePath"
  > & {
    createdAt: string;
  };
  prepareWorktree?: PrepareWorktree;
  runSetupScript?: boolean;
}

export interface StartTurnCommand extends ThreadCommand {
  type: "thread.turn.start";
  createdAt: string;
  message: {
    messageId: string;
    role: "user";
    text: string;
    attachments: [];
  };
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  modelSelection?: ModelSelection;
  titleSeed?: string;
  bootstrap?: ThreadBootstrap;
}

export interface MessageDispatchCommand extends ThreadCommand {
  type: "message.dispatch";
  createdBy: "user";
  creationSource: "mcp";
  messageId: string;
  text: string;
  attachments: [];
  deliveryIntent: "auto";
  dispatchMode: { type: "start_immediately" };
}

export interface RunInterruptCommand extends ThreadCommand {
  type: "run.interrupt";
  runId: string;
}

export interface RuntimeModeSetCommand extends ThreadCommand {
  type: "thread.runtime-mode.set";
  runtimeMode: RuntimeMode;
}

export interface InteractionModeSetCommand extends ThreadCommand {
  type: "thread.interaction-mode.set";
  interactionMode: InteractionMode;
}

export type OrchestrationCommand =
  | StartTurnCommand
  | MessageDispatchCommand
  | RunInterruptCommand
  | RuntimeModeSetCommand
  | InteractionModeSetCommand;

export const dispatchResultSchema = z.object({ sequence: z.number() });
export type DispatchResult = z.infer<typeof dispatchResultSchema>;
