import { T3Client } from "./client.ts";
import { openConnection, type T3Connection } from "./connection.ts";
import { PAIR_HINT, resolveAccessToken } from "./credentials.ts";
import { discoverServer } from "./server-discovery.ts";

const EXPIRY_NOTICE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface ActiveClient {
  client: T3Client;
  token: string;
}

/** Lazily connected T3 client that reconnects when the stored token changes, so one re-pair reaches every running session. */
export class T3Session {
  private pending: Promise<ActiveClient> | null = null;
  private expiresAt: string | undefined;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly onConnect?: (connection: T3Connection) => void,
    private readonly now: () => number = Date.now,
  ) {}

  async getClient(): Promise<T3Client> {
    const pending = (this.pending ??= this.connect());
    const active = await pending;
    const current = await resolveAccessToken(active.client.connection.server.origin, this.env);
    this.expiresAt = current.expiresAt;
    if (current.token === active.token) {
      return active.client;
    }
    if (this.pending === pending) {
      active.client.connection.rpc.close();
      this.pending = this.connect();
    }
    return (await this.pending).client;
  }

  /** Warns while the stored token is within a week of expiring. */
  notice(): string | undefined {
    if (this.expiresAt === undefined) {
      return undefined;
    }
    if (Date.parse(this.expiresAt) - this.now() > EXPIRY_NOTICE_WINDOW_MS) {
      return undefined;
    }
    return `The stored T3 token expires on ${this.expiresAt}. ${PAIR_HINT}`;
  }

  close(): void {
    void this.pending?.then((active) => active.client.connection.rpc.close()).catch(() => {});
  }

  private connect(): Promise<ActiveClient> {
    const attempt = (async () => {
      const server = await discoverServer({ env: this.env });
      const access = await resolveAccessToken(server.origin, this.env);
      const connection = openConnection(server, access);
      this.onConnect?.(connection);
      return { client: new T3Client(connection), token: access.token };
    })();
    attempt.catch(() => {
      if (this.pending === attempt) {
        this.pending = null;
      }
    });
    return attempt;
  }
}
