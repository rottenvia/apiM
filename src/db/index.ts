import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

/**
 * Whether a database connection string is available.
 *
 * NOTE: this module must NEVER throw at import time. Route handlers import
 * `db` at the top level, so a module-scope throw prevents the route from
 * loading at all — Next.js then responds with its HTML error page instead of
 * JSON, which surfaces in the browser as:
 *   "Unexpected token '<', "<!DOCTYPE "... is not valid JSON"
 * Instead we fail lazily, so handlers can catch the error and degrade.
 */
export const isDatabaseConfigured = Boolean(databaseUrl);

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super(
      "DATABASE_URL is not set — database features (chat history) are disabled."
    );
    this.name = "DatabaseNotConfiguredError";
  }
}

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
  __arenaNextJsPostgresqlDb?: NodePgDatabase<Record<string, never>>;
};

export function getPool(): Pool {
  if (!databaseUrl) throw new DatabaseNotConfiguredError();

  if (!globalForDb.__arenaNextJsPostgresqlPool) {
    const pool = new Pool({ connectionString: databaseUrl });
    // An idle client error (e.g. the DB restarting) must not take down the
    // whole Node process — log it and let the pool recycle the connection.
    pool.on("error", (err) => {
      console.error("Unexpected postgres pool error:", err);
    });
    globalForDb.__arenaNextJsPostgresqlPool = pool;
  }

  return globalForDb.__arenaNextJsPostgresqlPool;
}

function getDb(): NodePgDatabase<Record<string, never>> {
  if (!globalForDb.__arenaNextJsPostgresqlDb) {
    globalForDb.__arenaNextJsPostgresqlDb = drizzle(getPool());
  }
  return globalForDb.__arenaNextJsPostgresqlDb;
}

/**
 * Lazily-initialised drizzle client. The connection is only established on
 * first actual use, so importing this module is always safe.
 */
export const db = new Proxy({} as NodePgDatabase<Record<string, never>>, {
  get(_target, prop, receiver) {
    const value = Reflect.get(
      getDb() as unknown as object,
      prop,
      receiver
    ) as unknown;
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(getDb())
      : value;
  },
});
