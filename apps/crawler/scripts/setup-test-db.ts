import fs from "node:fs/promises";
import path from "node:path";
import { loadEnvFile } from "../src/config/env.ts";
import { getTestDatabaseUrl } from "../src/config/test-db.ts";
import { openDatabase } from "../src/db/factory.ts";

async function main(): Promise<void> {
  loadEnvFile();
  const url = getTestDatabaseUrl();
  const schemaPath = path.join(process.cwd(), "db", "schema.sql");
  const sql = await fs.readFile(schemaPath, "utf8");

  const handle = openDatabase(url, 5);
  try {
    await handle.pool.query(sql);
    console.log(`测试库 schema 已重建：${url}`);
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
