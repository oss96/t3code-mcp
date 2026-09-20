import { createHash, randomUUID } from "node:crypto";

// This namespace is permanent: changing it would launch duplicates for existing retry keys.
const ID_NAMESPACE = "t3-mcp";

export function deterministicId(namespace: string, key: string): string {
  const hex = createHash("sha256").update(`${ID_NAMESPACE}:${namespace}:${key}`).digest("hex");
  const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface CommandIds {
  idempotencyKey: string;
  threadId: string;
  commandId: string;
  messageId: string;
}

// Include the thread id in the scope so retry keys can be reused across threads.
export function commandIds(scope: string, idempotencyKey?: string): CommandIds {
  const key = idempotencyKey?.trim() || randomUUID();
  return {
    idempotencyKey: key,
    threadId: deterministicId(`thread:${scope}`, key),
    commandId: deterministicId(`command:${scope}`, key),
    messageId: deterministicId(`message:${scope}`, key),
  };
}
