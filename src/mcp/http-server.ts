import { networkInterfaces } from "node:os";

import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  originValidationResponse,
  type McpServer,
} from "@modelcontextprotocol/server";

import type { ServeOptions } from "./serve-options.ts";
import { SseServerTransport } from "./sse-transport.ts";

const methodNotAllowed = (allow: string): Response =>
  new Response("Method not allowed.", { status: 405, headers: { Allow: allow } });

export function serveHttp(
  factory: () => McpServer,
  options: ServeOptions & { transport: "http" | "sse" },
  onerror: (error: Error) => void,
): { url: URL; close(): Promise<void> } {
  const handler = options.transport === "http" ? createMcpHandler(factory, { onerror }) : null;
  const sessions = new Map<string, SseServerTransport>();
  const hostnames = localhostAllowedHostnames();
  const hosts =
    options.host === "0.0.0.0" || options.host === "::"
      ? Object.values(networkInterfaces()).flatMap((addresses) =>
          (addresses ?? []).map(({ address }) => address),
        )
      : [options.host];
  hostnames.push(...hosts.map((host) => (host.includes(":") ? `[${host}]` : host)));
  let closing: Promise<void> | undefined;

  const listener = Bun.serve({
    hostname: options.host,
    port: options.port,
    // Tool calls can wait for minutes, and legacy SSE stays open between calls.
    idleTimeout: 0,
    maxRequestBodySize: 4 * 1024 * 1024,
    async fetch(request) {
      if (closing) {
        return new Response("Server is shutting down.", { status: 503 });
      }
      const rejected =
        hostHeaderValidationResponse(request, hostnames) ??
        originValidationResponse(request, hostnames);
      if (rejected) {
        return rejected;
      }
      const url = new URL(request.url);
      if (handler && url.pathname === "/mcp") {
        return handler.fetch(request);
      }
      if (options.transport === "sse" && url.pathname === "/sse") {
        if (request.method !== "GET") {
          return methodNotAllowed("GET");
        }
        const transport = new SseServerTransport(request);
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- SDK Transport callbacks are not EventTarget events.
        transport.onclose = () => {
          sessions.delete(transport.sessionId);
        };
        sessions.set(transport.sessionId, transport);
        try {
          const server = factory();
          // oxlint-disable-next-line unicorn/prefer-add-event-listener -- SDK Protocol exposes an onerror callback, not addEventListener.
          server.server.onerror = onerror;
          await server.connect(transport);
          return transport.response;
        } catch (error) {
          await transport.close();
          throw error;
        }
      }
      if (options.transport === "sse" && url.pathname === "/messages") {
        if (request.method !== "POST") {
          return methodNotAllowed("POST");
        }
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId) {
          return new Response("Missing sessionId.", { status: 400 });
        }
        const transport = sessions.get(sessionId);
        return transport
          ? transport.handleMessage(request)
          : new Response("Unknown SSE session.", { status: 404 });
      }
      return new Response("Not found.", { status: 404 });
    },
    error(error) {
      onerror(error);
      return new Response("Internal server error.", { status: 500 });
    },
  });

  return {
    url: new URL(options.transport === "http" ? "/mcp" : "/sse", listener.url),
    close() {
      closing ??= (async () => {
        try {
          await Promise.all([handler?.close(), ...[...sessions.values()].map((s) => s.close())]);
        } finally {
          await listener.stop(true);
        }
      })();
      return closing;
    },
  };
}
