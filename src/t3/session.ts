import { T3Client } from "./client.ts";
import { connectToT3, type T3Connection } from "./connection.ts";

export class T3Session {
  private pending: Promise<T3Client> | null = null;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly onConnect?: (connection: T3Connection) => void,
  ) {}

  getClient(): Promise<T3Client> {
    this.pending ??= connectToT3(this.env).then(
      (connection) => {
        this.onConnect?.(connection);
        return new T3Client(connection);
      },
      (error: unknown) => {
        this.pending = null;
        throw error;
      },
    );
    return this.pending;
  }

  close(): void {
    void this.pending?.then((client) => client.connection.rpc.close()).catch(() => {});
  }
}
