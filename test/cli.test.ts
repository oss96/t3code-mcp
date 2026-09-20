import { afterEach, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const env = {
  ...process.env,
  T3CODE_MCP_TRANSPORT: "stdio",
  T3CODE_MCP_HOST: "127.0.0.1",
  T3CODE_MCP_PORT: "3001",
  T3_SERVER_URL: "http://127.0.0.1:1",
};
const children: Bun.Subprocess<"pipe", "pipe", "pipe">[] = [];
const clients: Client[] = [];

function spawnCli(args: readonly string[], overrides: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    env: { ...env, ...overrides },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  return child;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode === null) {
        child.kill();
      }
      await child.exited;
    }),
  );
});

describe("CLI", () => {
  it.each([{ args: [] }, { args: ["serve", "--transport", "stdio"] }])(
    "discovers tools over stdio with arguments %j while T3 is unavailable",
    async ({ args }) => {
      const client = new Client({ name: "cli-test", version: "1" });
      clients.push(client);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [cli, ...args],
        env: { T3CODE_MCP_TRANSPORT: "stdio", T3_SERVER_URL: env.T3_SERVER_URL },
        stderr: "pipe",
      });
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe("t3code-mcp");
      expect((await client.listTools()).tools).toHaveLength(9);
    },
  );

  it.each(["http", "sse"] as const)(
    "runs %s without stdin and shuts down on SIGTERM",
    async (transport) => {
      const child = spawnCli(["--transport", transport, "--port", "0"]);
      await child.stdin.end();
      const reader = child.stderr.getReader();
      let startup = "";
      const decoder = new TextDecoder();
      // oxlint-disable-next-line no-await-in-loop -- Read until the complete startup line is available.
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        startup += decoder.decode(chunk.value, { stream: true });
        if (startup.includes("\n")) {
          break;
        }
      }
      reader.releaseLock();
      const address = startup.match(/listening at (http:\/\/\S+)/)?.[1];
      if (!address) {
        throw new Error(`No startup URL: ${startup}`);
      }
      expect(new URL(address).pathname).toBe(transport === "http" ? "/mcp" : "/sse");
      const client = new Client({ name: "cli-test", version: "1" });
      clients.push(client);
      await client.connect(
        transport === "http"
          ? new StreamableHTTPClientTransport(new URL(address))
          : new SSEClientTransport(new URL(address)),
      );
      expect((await client.listTools()).tools).toHaveLength(9);
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stdout).text()).toBe("");
    },
  );

  it("exits when its stdio host closes stdin", async () => {
    const child = spawnCli(["serve"]);
    await child.stdin.end();
    expect(await child.exited).toBe(0);
  });

  it.each([{ args: ["help"] }, { args: ["--help"] }, { args: ["serve", "--help"] }])(
    "documents transport flags in %j",
    async ({ args }) => {
      const child = spawnCli(args);
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(output).toContain("--transport stdio|http|sse");
      expect(output).toContain("T3CODE_MCP_PORT");
    },
  );

  it("reports invalid configuration on stderr without writing to the MCP channel", async () => {
    const child = spawnCli(["serve"], { T3CODE_MCP_TRANSPORT: "invalid" });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(await child.exited).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain('Invalid transport "invalid"');
  });
});
