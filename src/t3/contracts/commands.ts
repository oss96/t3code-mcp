import * as z from "zod/v4";

import type { InteractionMode, RuntimeMode, Thread } from "./orchestration.ts";
import type { ModelSelection } from "./providers.ts";

interface ThreadCommand {
  commandId: string;
  threadId: string;
  createdAt: string;
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

export interface InterruptTurnCommand extends ThreadCommand {
  type: "thread.turn.interrupt";
  turnId?: string;
}

export type OrchestrationCommand = StartTurnCommand | InterruptTurnCommand;

export const dispatchResultSchema = z.object({ sequence: z.number() });
export type DispatchResult = z.infer<typeof dispatchResultSchema>;
