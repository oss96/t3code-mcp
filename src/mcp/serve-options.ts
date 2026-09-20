import { isIP } from "node:net";
import { parseArgs } from "node:util";

export interface ServeOptions {
  transport: "stdio" | "http" | "sse";
  host: string;
  port: number;
}

export function parseServeOptions(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): ServeOptions {
  const { values } = parseArgs({
    args,
    options: {
      transport: { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const transport = values.transport ?? env.T3CODE_MCP_TRANSPORT ?? "stdio";
  if (transport !== "stdio" && transport !== "http" && transport !== "sse") {
    throw new Error(`Invalid transport "${transport}". Use stdio, http, or sse.`);
  }
  const host = (values.host ?? env.T3CODE_MCP_HOST ?? "127.0.0.1").replace(/^\[(.*)\]$/, "$1");
  if (!isIP(host) && !/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(host)) {
    throw new Error(`Invalid host "${host}". Use a hostname or IP address, without a URL or port.`);
  }
  const portText = values.port ?? env.T3CODE_MCP_PORT ?? "3001";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port "${portText}". Use an integer from 0 to 65535.`);
  }
  return { transport, host, port };
}
