import { describe, expect, it } from "bun:test";

import { parseServeOptions } from "../../src/mcp/serve-options.ts";

describe("MCP transport options", () => {
  it("keeps stdio as the default and binds HTTP to loopback", () => {
    expect(parseServeOptions([], {})).toEqual({
      transport: "stdio",
      host: "127.0.0.1",
      port: 3001,
    });
  });

  it("uses environment settings and lets flags override them", () => {
    const env = {
      T3CODE_MCP_TRANSPORT: "sse",
      T3CODE_MCP_HOST: "localhost",
      T3CODE_MCP_PORT: "9000",
    };
    expect(parseServeOptions([], env)).toEqual({ transport: "sse", host: "localhost", port: 9000 });
    expect(parseServeOptions(["--transport=http", "--host", "[::1]", "--port", "0"], env)).toEqual({
      transport: "http",
      host: "::1",
      port: 0,
    });
    expect(parseServeOptions(["--transport", "stdio"], env).transport).toBe("stdio");
  });

  it.each(["", "-1", "65536", "3.5", "3001oops", "NaN"])("rejects invalid port %j", (port) => {
    expect(() => parseServeOptions([`--port=${port}`], {})).toThrow(/Invalid port/);
  });

  it("rejects invalid transports, hosts, unknown flags, and extra arguments", () => {
    expect(() => parseServeOptions(["--transport", "websocket"], {})).toThrow(
      /stdio, http, or sse/,
    );
    expect(() => parseServeOptions(["--host", "http://localhost:3001"], {})).toThrow(
      /Invalid host/,
    );
    expect(() => parseServeOptions(["--host", ""], {})).toThrow(/Invalid host/);
    expect(() => parseServeOptions(["--port"], {})).toThrow();
    expect(() => parseServeOptions(["--typo"], {})).toThrow();
    expect(() => parseServeOptions(["http"], {})).toThrow();
  });
});
