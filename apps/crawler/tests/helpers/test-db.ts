import fs from "node:fs/promises";
import path from "node:path";
import { loadEnvFile } from "../../src/config/env.ts";
import { getTestDatabaseUrl } from "../../src/config/test-db.ts";
import { openDatabase } from "../../src/db/factory.ts";
import type { DbHandle } from "../../src/db/factory.ts";

export function testDatabaseAvailable(): boolean {
  loadEnvFile();
  return Boolean(process.env.TEST_DATABASE_URL);
}

export function openTestDatabase(): DbHandle {
  loadEnvFile();
  return openDatabase(getTestDatabaseUrl(), 5);
}

export async function resetTestDb(handle: DbHandle): Promise<void> {
  const schemaPath = path.join(process.cwd(), "db", "schema.sql");
  const sql = await fs.readFile(schemaPath, "utf8");
  await handle.pool.query(sql);
}
