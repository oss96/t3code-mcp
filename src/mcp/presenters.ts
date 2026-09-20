import type { T3Client } from "../t3/client.ts";
import type { Message, Thread, ThreadSnapshot } from "../t3/contracts/orchestration.ts";
import type { MessageContext } from "./schemas.ts";

export const composeMessage = (prompt: string, context?: MessageContext): string =>
  context?.length
    ? `${prompt}\n\n---\n\n${context.map((c) => `### ${c.label ?? "Context"}\n\n${c.text}`).join("\n\n")}`
    : prompt;

const threadUrl = (client: T3Client, threadId: string): string =>
  `${client.connection.server.origin}/${client.connection.server.environmentId}/${threadId}`;

export const summarizeThread = (client: T3Client, thread: Thread) => ({
  threadId: thread.id,
  title: thread.title,
  projectId: thread.projectId,
  harness: thread.modelSelection.instanceId,
  model: thread.modelSelection.model,
  branch: thread.branch,
  worktreePath: thread.worktreePath,
  runtimeMode: thread.runtimeMode,
  interactionMode: thread.interactionMode,
  turn: thread.latestTurn && {
    turnId: thread.latestTurn.turnId,
    state: thread.latestTurn.state,
    startedAt: thread.latestTurn.startedAt,
    completedAt: thread.latestTurn.completedAt,
  },
  session: thread.session && { status: thread.session.status, lastError: thread.session.lastError },
  archived: thread.archivedAt !== null,
  ...(thread.hasPendingApprovals === undefined
    ? {}
    : {
        needsAttention: {
          pendingApprovals: thread.hasPendingApprovals,
          pendingUserInput: thread.hasPendingUserInput ?? false,
          actionablePlan: thread.hasActionableProposedPlan ?? false,
        },
      }),
  url: threadUrl(client, thread.id),
});

export const renderMessages = (messages: Message[], limit: number, maxChars: number) =>
  messages.slice(-limit).map((m) => ({
    id: m.id,
    role: m.role,
    turnId: m.turnId,
    streaming: m.streaming,
    createdAt: m.createdAt,
    text:
      m.text.length > maxChars
        ? `${m.text.slice(0, maxChars)}\n…[truncated ${m.text.length - maxChars} chars]`
        : m.text,
  }));

const latestReply = (snapshot: ThreadSnapshot): Message | null => {
  const { latestTurn, messages } = snapshot.thread;
  const byTurn = latestTurn?.assistantMessageId
    ? messages.find((m) => m.id === latestTurn.assistantMessageId)
    : undefined;
  return byTurn ?? messages.toReversed().find((m) => m.role === "assistant") ?? null;
};

export const turnResult = (client: T3Client, snapshot: ThreadSnapshot, timedOut: boolean) => {
  const reply = latestReply(snapshot);
  return {
    ...summarizeThread(client, snapshot.thread),
    timedOut,
    reply: reply && { messageId: reply.id, streaming: reply.streaming, text: reply.text },
  };
};
