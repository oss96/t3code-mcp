import type { T3Connection } from "./connection.ts";
import { dispatchResultSchema } from "./contracts/commands.ts";
import type {
  DispatchResult,
  OrchestrationCommand,
  PrepareWorktree,
  ThreadBootstrap,
} from "./contracts/commands.ts";
import { shellSnapshotSchema } from "./contracts/orchestration.ts";
import type {
  InteractionMode,
  RuntimeMode,
  ShellSnapshot,
  ThreadSnapshot,
} from "./contracts/orchestration.ts";
import { serverConfigSchema } from "./contracts/providers.ts";
import type { ModelSelection, ServerConfig } from "./contracts/providers.ts";
import { vcsListRefsResultSchema } from "./contracts/vcs.ts";
import type { VcsListRefsResult } from "./contracts/vcs.ts";
import { readThreadSnapshot } from "./thread-snapshot.ts";
import { waitForTurn, type WaitForTurnOptions, type WaitForTurnResult } from "./turn-waiter.ts";

export interface NewWorktreeOptions extends PrepareWorktree {
  runSetupScript: boolean;
}

export interface CreateThreadOptions extends StartTurnOptions {
  projectId: string;
  title: string;
  modelSelection: ModelSelection;
  branch: string | null;
  worktreePath: string | null;
  newWorktree?: NewWorktreeOptions;
}

export interface StartTurnOptions {
  commandId: string;
  threadId: string;
  messageId: string;
  text: string;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
}

// RPC expands bootstrap commands and returns typed errors.
export class T3Client {
  constructor(readonly connection: T3Connection) {}

  async shell(): Promise<ShellSnapshot> {
    return shellSnapshotSchema.parse(await this.connection.http.get("/api/orchestration/shell"));
  }

  async thread(threadId: string, turnLimit?: number): Promise<ThreadSnapshot> {
    return readThreadSnapshot(this.connection.http, threadId, turnLimit);
  }

  async config(): Promise<ServerConfig> {
    return serverConfigSchema.parse(await this.connection.rpc.call("server.getConfig", {}));
  }

  async listRefs(cwd: string): Promise<VcsListRefsResult> {
    const refs: VcsListRefsResult["refs"] = [];
    let isRepo = false;
    let cursor: number | undefined;
    for (let page = 0; page < 50; page++) {
      const result = vcsListRefsResultSchema.parse(
        await this.connection.rpc.call("vcs.listRefs", {
          cwd,
          refKind: "local",
          refresh: page === 0,
          limit: 200,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      refs.push(...result.refs);
      isRepo = result.isRepo;
      if (result.nextCursor === null || result.nextCursor === undefined) {
        break;
      }
      cursor = result.nextCursor;
    }
    return { refs, isRepo, nextCursor: null };
  }

  private async dispatch(command: OrchestrationCommand): Promise<DispatchResult> {
    return dispatchResultSchema.parse(
      await this.connection.rpc.call("orchestration.dispatchCommand", command),
    );
  }

  createThread(spec: CreateThreadOptions): Promise<DispatchResult> {
    const createdAt = new Date().toISOString();
    const bootstrap: ThreadBootstrap = {
      createThread: {
        projectId: spec.projectId,
        title: spec.title,
        modelSelection: spec.modelSelection,
        runtimeMode: spec.runtimeMode,
        interactionMode: spec.interactionMode,
        branch: spec.branch,
        worktreePath: spec.worktreePath,
        createdAt,
      },
    };
    if (spec.newWorktree) {
      const { projectCwd, baseBranch, branch, runSetupScript } = spec.newWorktree;
      bootstrap.prepareWorktree = { projectCwd, baseBranch, ...(branch ? { branch } : {}) };
      bootstrap.runSetupScript = runSetupScript;
    }
    return this.dispatch({
      type: "thread.turn.start",
      commandId: spec.commandId,
      threadId: spec.threadId,
      message: { messageId: spec.messageId, role: "user", text: spec.text, attachments: [] },
      modelSelection: spec.modelSelection,
      titleSeed: spec.title,
      runtimeMode: spec.runtimeMode,
      interactionMode: spec.interactionMode,
      bootstrap,
      createdAt,
    });
  }

  startTurn(spec: StartTurnOptions): Promise<DispatchResult> {
    return this.dispatch({
      type: "thread.turn.start",
      commandId: spec.commandId,
      threadId: spec.threadId,
      message: { messageId: spec.messageId, role: "user", text: spec.text, attachments: [] },
      runtimeMode: spec.runtimeMode,
      interactionMode: spec.interactionMode,
      createdAt: new Date().toISOString(),
    });
  }

  interruptTurn(commandId: string, threadId: string, turnId?: string): Promise<DispatchResult> {
    return this.dispatch({
      type: "thread.turn.interrupt",
      commandId,
      threadId,
      ...(turnId ? { turnId } : {}),
      createdAt: new Date().toISOString(),
    });
  }

  waitForTurn(
    threadId: string,
    timeoutMs: number,
    options: WaitForTurnOptions = {},
  ): Promise<WaitForTurnResult> {
    return waitForTurn(this.connection, threadId, timeoutMs, options);
  }
}
