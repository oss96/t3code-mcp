import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveCredential } from "../../src/t3/credentials.ts";
import { T3Session } from "../../src/t3/session.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("T3Session", () => {
  let dir = "";
  let server: ReturnType<typeof Bun.serve> | undefined;
  let opened: T3Session | undefined;
  afterEach(async () => {
    opened?.close();
    await server?.stop(true);
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function setup(now = Date.now) {
    server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ environmentId: "env-1" }),
    });
    const origin = new URL(server.url).origin;
    dir = await mkdtemp(join(tmpdir(), "t3code-mcp-"));
    const path = join(dir, "credentials.json");
    const store = (accessToken: string, expiresAt = "2099-01-01T00:00:00.000Z") =>
      saveCredential(path, {
        origin,
        accessToken,
        scope: "orchestration:read",
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt,
      });
    const connects: string[] = [];
    const session = new T3Session(
      { T3_SERVER_URL: origin, T3CODE_MCP_CREDENTIALS: path },
      (connection) => connects.push(connection.tokenSource),
      now,
    );
    opened = session;
    return { session, store, connects };
  }

  it("reuses the connection while the stored token is unchanged", async () => {
    const { session, store, connects } = await setup();
    await store("first");
    const client = await session.getClient();
    expect(await session.getClient()).toBe(client);
    expect(connects).toHaveLength(1);
  });

  it("reconnects with the new token after pairing again", async () => {
    const { session, store, connects } = await setup();
    await store("revoked");
    const stale = await session.getClient();
    await store("re-paired");
    const fresh = await session.getClient();
    expect(fresh).not.toBe(stale);
    expect(await session.getClient()).toBe(fresh);
    expect(connects).toHaveLength(2);
  });

  it("warns only within a week of the token expiring", async () => {
    const now = Date.now();
    const { session, store } = await setup(() => now);
    await store("token", new Date(now + 8 * DAY_MS).toISOString());
    await session.getClient();
    expect(session.notice()).toBeUndefined();
    const soon = new Date(now + 6 * DAY_MS).toISOString();
    await store("token", soon);
    await session.getClient();
    expect(session.notice()).toContain(`expires on ${soon}`);
  });
});
