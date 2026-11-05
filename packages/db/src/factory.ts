import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.ts";

export type Database = NodePgDatabase<typeof schema>;

export type DbHandle = {
  db: Database;
  pool: pg.Pool;
  close: () => Promise<void>;
};

export function openDatabase(connectionString: string, max = 10): DbHandle {
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 30000,
    allowExitOnIdle: true,
    keepAlive: true,
    keepAliveInitialDelayMillis: 30000,
  });

  pool.on("error", (error) => {
    console.error("Unexpected pool error:", error.message);
  });

  return {
    db: drizzle(pool, { schema }),
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
