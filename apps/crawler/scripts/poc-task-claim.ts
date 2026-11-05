import { getTestDatabaseUrl } from "../src/config/test-db.ts";
import { openDatabase } from "../src/db/factory.ts";
import { claimNextTask, releaseTask, resolveTaskAccounts } from "../src/db/repositories/tasks.ts";

async function main(): Promise<void> {
  const handle = openDatabase(getTestDatabaseUrl(), 5);
  try {
    const task = await claimNextTask(handle, "local-poc", Date.now());
    if (!task) {
      console.log("没有到期的 pending 任务");
      return;
    }
    const accounts = await resolveTaskAccounts(handle, task);
    console.log(JSON.stringify({
      task: task.id,
      platform: task.platformCode,
      category: task.categoryId,
      params: task.params,
      priority: task.priority,
      accounts: accounts.map((account) => account.handle),
    }, null, 2));
    await releaseTask(handle, task.id);
    console.log("已释放回 pending");
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
