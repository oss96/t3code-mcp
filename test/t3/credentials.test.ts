import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as z from "zod/v4";

import {
  credentialsPath,
  exchangePairingCode,
  loadCredential,
  parsePairingInput,
  resolveAccessToken,
  saveCredential,
} from "../../src/t3/credentials.ts";
import type { FetchFunction } from "../../src/t3/transport/http-client.ts";

const reject: FetchFunction = async () => new Response("invalid_grant", { status: 400 });
const mac: FetchFunction = async () =>
  Response.json({ access_token: "t", token_type: "MAC", expires_in: 1, scope: "" });

describe("parsePairingInput", () => {
  it("accepts a bare code and keeps the fallback origin", () => {
    expect(parsePairingInput("  ABC123  ", "http://127.0.0.1:3773")).toEqual({
      code: "ABC123",
      origin: "http://127.0.0.1:3773",
    });
  });

  it("reads a direct /pair link with the token in the hash", () => {
    expect(parsePairingInput("http://127.0.0.1:3773/pair#token=ABCD1234")).toEqual({
      code: "ABCD1234",
      origin: "http://127.0.0.1:3773",
    });
  });

  it("reads a hosted link and points at the host param", () => {
    expect(
      parsePairingInput(
        "https://pair.example.test/pair?host=https%3A%2F%2Fserver.example.test%3A44342%2F#token=abc",
      ),
    ).toEqual({
      code: "abc",
      origin: "https://server.example.test:44342",
    });
  });

  it("rejects empty input and links without a token", () => {
    expect(() => parsePairingInput(" ")).toThrow(/Enter a pairing URL/);
    expect(() => parsePairingInput("http://127.0.0.1:3773/pair")).toThrow(/missing its token/);
  });
});

describe("credentialsPath", () => {
  it("honours T3CODE_MCP_CREDENTIALS and defaults under the home directory", () => {
    expect(credentialsPath({ T3CODE_MCP_CREDENTIALS: " /x/creds.json " }, "/test-home")).toBe(
      "/x/creds.json",
    );
    expect(credentialsPath({}, "/test-home")).toBe("/test-home/.t3code-mcp/credentials.json");
  });

  it("supports the previous override while preferring the current one", () => {
    expect(
      credentialsPath({ T3_MCP_CREDENTIALS: " /legacy/credentials.json " }, "/test-home"),
    ).toBe("/legacy/credentials.json");
    expect(
      credentialsPath(
        {
          T3CODE_MCP_CREDENTIALS: "/current/credentials.json",
          T3_MCP_CREDENTIALS: "/legacy/credentials.json",
        },
        "/test-home",
      ),
    ).toBe("/current/credentials.json");
  });
});

describe("credential store", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  const base = {
    scope: "orchestration:read",
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };

  it("reads earlier credentials and prefers the current store after pairing again", async () => {
    dir = await mkdtemp(join(tmpdir(), "t3code-mcp-"));
    const legacy = join(dir, ".t3-mcp", "credentials.json");
    const current = credentialsPath({}, dir);
    await saveCredential(legacy, { origin: "http://a", accessToken: "legacy-token", ...base });
    expect(await resolveAccessToken("http://a", {}, dir)).toEqual({
      token: "legacy-token",
      source: legacy,
      expiresAt: base.expiresAt,
    });
    await expect(
      resolveAccessToken("http://a", { T3CODE_MCP_CREDENTIALS: current }, dir),
    ).rejects.toThrow(/No T3 token stored/);
    await saveCredential(current, { origin: "http://a", accessToken: "current-token", ...base });
    expect(await resolveAccessToken("http://a", {}, dir)).toEqual({
      token: "current-token",
      source: current,
      expiresAt: base.expiresAt,
    });
  });

  it("saves with mode 0600, replaces per origin, and loads", async () => {
    dir = await mkdtemp(join(tmpdir(), "t3code-mcp-"));
    const path = join(dir, "nested", "credentials.json");
    await saveCredential(path, { origin: "http://a", accessToken: "one", ...base });
    await saveCredential(path, { origin: "http://b", accessToken: "two", ...base });
    await saveCredential(path, { origin: "http://a", accessToken: "three", ...base });
    expect((await loadCredential(path, "http://a"))?.accessToken).toBe("three");
    expect((await loadCredential(path, "http://b"))?.accessToken).toBe("two");
    expect(await loadCredential(path, "http://c")).toBeNull();
    expect(
      z
        .object({ credentials: z.array(z.unknown()) })
        .parse(JSON.parse(await readFile(path, "utf8"))).credentials,
    ).toHaveLength(2);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("prefers T3_ACCESS_TOKEN, then the store, and explains a missing or expired token", async () => {
    dir = await mkdtemp(join(tmpdir(), "t3code-mcp-"));
    const path = join(dir, "credentials.json");
    const env = { T3CODE_MCP_CREDENTIALS: path };
    expect(await resolveAccessToken("http://a", { ...env, T3_ACCESS_TOKEN: "env-token" })).toEqual({
      token: "env-token",
      source: "T3_ACCESS_TOKEN",
    });
    await expect(resolveAccessToken("http://a", env)).rejects.toThrow(
      /No T3 token stored for http:\/\/a.*pair/,
    );
    await saveCredential(path, { origin: "http://a", accessToken: "stored", ...base });
    expect(await resolveAccessToken("http://a", env)).toEqual({
      token: "stored",
      source: path,
      expiresAt: base.expiresAt,
    });
    await saveCredential(path, {
      origin: "http://a",
      accessToken: "old",
      ...base,
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    await expect(resolveAccessToken("http://a", env)).rejects.toThrow(
      /expired on 2000-01-01.*pair/,
    );
  });
});

describe("exchangePairingCode", () => {
  it("posts the token-exchange grant and turns the reply into a stored credential", async () => {
    const requests: Array<{ url: string; body: string; method?: string }> = [];
    const fetchImpl: FetchFunction = async (url, init) => {
      const request =
        url instanceof Request ? new Request(url, init) : new Request(url.toString(), init);
      requests.push({ url: request.url, body: await request.text(), method: request.method });
      return new Response(
        JSON.stringify({
          access_token: "tok",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "orchestration:read",
        }),
        { status: 200 },
      );
    };
    const credential = await exchangePairingCode("http://127.0.0.1:3773", "CODE1", fetchImpl);
    expect(requests[0]?.url).toBe("http://127.0.0.1:3773/oauth/token");
    expect(requests[0]?.method).toBe("POST");
    const body = new URLSearchParams(requests[0]?.body);
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(body.get("subject_token")).toBe("CODE1");
    expect(body.get("subject_token_type")).toBe(
      "urn:t3:params:oauth:token-type:environment-bootstrap",
    );
    expect(body.get("client_label")).toBe("t3code-mcp");
    expect(credential.accessToken).toBe("tok");
    expect(credential.origin).toBe("http://127.0.0.1:3773");
    expect(Date.parse(credential.expiresAt) - Date.parse(credential.issuedAt)).toBe(3_600_000);
  });

  it("surfaces T3's rejection and refuses non-Bearer tokens", async () => {
    await expect(exchangePairingCode("http://x", "bad", reject)).rejects.toThrow(
      /Pairing failed \(400\): invalid_grant/,
    );
    await expect(exchangePairingCode("http://x", "c", mac)).rejects.toThrow(/only Bearer/);
  });
});
