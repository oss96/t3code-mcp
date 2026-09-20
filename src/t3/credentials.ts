import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import * as z from "zod/v4";

import type { FetchFunction } from "./transport/http-client.ts";

const credentialSchema = z.object({
  origin: z.string(),
  accessToken: z.string(),
  scope: z.string(),
  issuedAt: z.string(),
  expiresAt: z.string(),
});
const credentialStoreSchema = z.object({
  version: z.literal(1),
  credentials: z.array(credentialSchema),
});
const tokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number(),
  scope: z.string(),
});
export type Credential = z.infer<typeof credentialSchema>;
type CredentialStore = z.infer<typeof credentialStoreSchema>;

export const PAIR_HINT =
  "Create a pairing link in T3 (Settings → Connections, or `t3 auth pairing create`) and run: t3code-mcp pair <pairing-url-or-code>";

export function credentialsPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  // Keep the previous override working for existing installations.
  return (
    env.T3CODE_MCP_CREDENTIALS?.trim() ||
    env.T3_MCP_CREDENTIALS?.trim() ||
    join(home, ".t3code-mcp", "credentials.json")
  );
}

async function readStore(path: string): Promise<CredentialStore> {
  try {
    const parsed = credentialStoreSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // Missing or unreadable: start a fresh store.
  }
  return { version: 1, credentials: [] };
}

export async function saveCredential(path: string, credential: Credential): Promise<void> {
  const store = await readStore(path);
  store.credentials = [
    ...store.credentials.filter((c) => c.origin !== credential.origin),
    credential,
  ];
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
}

export async function loadCredential(path: string, origin: string): Promise<Credential | null> {
  return (await readStore(path)).credentials.find((c) => c.origin === origin) ?? null;
}

export async function resolveAccessToken(
  origin: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<{ token: string; source: string }> {
  const fromEnv = env.T3_ACCESS_TOKEN?.trim();
  if (fromEnv) {
    return { token: fromEnv, source: "T3_ACCESS_TOKEN" };
  }
  const paths = [credentialsPath(env, home)];
  if (!env.T3CODE_MCP_CREDENTIALS?.trim() && !env.T3_MCP_CREDENTIALS?.trim()) {
    // Read the previous default store so the rename does not require pairing again.
    paths.push(join(home, ".t3-mcp", "credentials.json"));
  }
  for (const path of paths) {
    const stored = await loadCredential(path, origin);
    if (!stored) {
      continue;
    }
    if (Date.parse(stored.expiresAt) < Date.now()) {
      throw new Error(
        `The stored T3 token for ${origin} expired on ${stored.expiresAt}. ${PAIR_HINT}`,
      );
    }
    return { token: stored.accessToken, source: path };
  }
  throw new Error(`No T3 token stored for ${origin}. ${PAIR_HINT}`);
}

export function parsePairingInput(
  input: string,
  fallbackOrigin?: string,
): { code: string; origin?: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Enter a pairing URL or pairing code.");
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return { code: trimmed, origin: fallbackOrigin };
  }
  const url = new URL(trimmed);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  const code = hash.get("token") ?? url.searchParams.get("token");
  if (!code) {
    throw new Error("Pairing URL is missing its token.");
  }
  const host = url.searchParams.get("host");
  if (host) {
    return { code, origin: new URL(host.startsWith("//") ? `https:${host}` : host).origin };
  }
  return { code, origin: url.origin };
}

export async function exchangePairingCode(
  origin: string,
  code: string,
  fetchImpl: FetchFunction = fetch,
): Promise<Credential> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: code,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    client_label: "t3code-mcp",
    client_device_type: "desktop",
  });
  const response = await fetchImpl(new URL("/oauth/token", origin), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Pairing failed (${response.status}): ${text.slice(0, 300)}`);
  }
  const result = tokenResponseSchema.parse(JSON.parse(text));
  if (result.token_type !== "Bearer") {
    throw new Error(`T3 issued a ${result.token_type} token; only Bearer is supported.`);
  }
  const issuedAt = Date.now();
  return {
    origin,
    accessToken: result.access_token,
    scope: result.scope,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(issuedAt + result.expires_in * 1000).toISOString(),
  };
}
