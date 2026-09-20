import {
  isJsonContentType,
  parseJSONRPCMessage,
  type JSONRPCMessage,
  type Transport,
} from "@modelcontextprotocol/server";

// Legacy MCP uses one GET event stream and a separate POST endpoint per client.
// The v2 SDK no longer supplies a server transport for this wire format.
export class SseServerTransport implements Transport {
  readonly sessionId = crypto.randomUUID();
  readonly response: Response;
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];

  private controller?: ReadableStreamDefaultController<Uint8Array>;
  private readonly encoder = new TextEncoder();
  private heartbeat?: ReturnType<typeof setInterval>;
  private started = false;
  private closed = false;
  private readonly onAbort = (): void => void this.close();

  constructor(private readonly request: Request) {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => this.close(),
    });
    this.response = new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  async start(): Promise<void> {
    if (this.started || this.closed) {
      throw new Error("SSE transport is already started or closed.");
    }
    this.started = true;
    this.request.signal.addEventListener("abort", this.onAbort, { once: true });
    if (this.request.signal.aborted) {
      await this.close();
      return;
    }
    this.write(`event: endpoint\ndata: /messages?sessionId=${this.sessionId}\n\n`);
    this.heartbeat = setInterval(() => this.write(": keepalive\n\n"), 15_000);
    this.heartbeat.unref();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.started || this.closed) {
      throw new Error("SSE transport is not connected.");
    }
    this.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  }

  async handleMessage(request: Request): Promise<Response> {
    if (!isJsonContentType(request.headers.get("content-type"))) {
      return new Response("Content-Type must be application/json.", { status: 415 });
    }
    let message: JSONRPCMessage;
    try {
      message = parseJSONRPCMessage(await request.json());
    } catch {
      return new Response("Invalid JSON-RPC message.", { status: 400 });
    }
    if (this.closed) {
      return new Response("SSE session is closed.", { status: 404 });
    }
    this.onmessage?.(message, { request });
    return new Response(null, { status: 202 });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.heartbeat);
    this.request.signal.removeEventListener("abort", this.onAbort);
    try {
      this.controller?.close();
    } catch {
      // A cancelled response stream is already closed by the runtime.
    }
    this.onclose?.();
  }

  private write(frame: string): void {
    if (this.closed) {
      return;
    }
    try {
      this.controller?.enqueue(this.encoder.encode(frame));
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      void this.close();
    }
  }
}
