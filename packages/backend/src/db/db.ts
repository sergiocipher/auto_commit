import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";

// bigint columns hold epoch milliseconds, which fit exactly in a double.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000 });
}

/**
 * Query helper with ambient transactions: inside `transaction`, every query
 * made through this object (by any callee) runs on the same client.
 */
export class Db {
  private readonly current = new AsyncLocalStorage<pg.PoolClient>();

  constructor(readonly pool: pg.Pool) {}

  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<pg.QueryResult<R>> {
    return (this.current.getStore() ?? this.pool).query<R>(text, params);
  }

  /** Runs fn in a transaction; nested calls join the outer transaction. */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.current.getStore()) return fn();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.current.run(client, fn);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
