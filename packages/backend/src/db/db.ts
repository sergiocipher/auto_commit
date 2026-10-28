import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";

// bigint columns hold epoch milliseconds, which fit exactly in a double.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

/**
 * A pool that survives Postgres closing idle connections (restart, failover,
 * pg_terminate_backend). pg reports those as an "error" event on the pool;
 * without a listener Node treats it as an uncaught exception and the process
 * dies. The pool drops the broken client and connects anew on the next query.
 */
export function createPool(
  connectionString: string,
  opts: { max?: number; onIdleError: (err: Error) => void },
): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 10, idleTimeoutMillis: 30_000 });
  pool.on("error", opts.onIdleError);
  return pool;
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
