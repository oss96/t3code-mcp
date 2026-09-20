import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const image = process.argv[2] ?? "t3code-mcp:local";
const name = `t3code-mcp-smoke-${crypto.randomUUID()}`;
const client = new Client({ name: "docker-smoke-test", version: "1" });
const transport = new StdioClientTransport({
  command: "docker",
  args: ["run", "--rm", "--interactive", "--name", name, image, "serve", "--transport", "stdio"],
  env: Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
  stderr: "inherit",
});

try {
  await client.connect(transport, { timeout: 30_000 });
  const { tools } = await client.listTools();
  if (client.getServerVersion()?.name !== "t3code-mcp" || tools.length !== 9) {
    throw new Error("The Docker image did not expose the expected t3code-mcp tool registry.");
  }
  console.log(`Docker MCP initialization and all ${tools.length} tools: ok (${image})`);
} finally {
  await client.close();
  // Also remove the container if a failed handshake left docker run attached.
  const cleanup = Bun.spawn(["docker", "rm", "--force", name], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await cleanup.exited;
}
