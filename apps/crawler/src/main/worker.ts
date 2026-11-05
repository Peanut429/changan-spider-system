import { loadEnvFile, requiredEnv } from "../config/env.ts";
import { numberArg, parseArgs } from "../config/args.ts";
import { getPlatformDefinition } from "../config/platforms.ts";
import { openDatabase } from "../db/factory.ts";
import { loadPlatformAccounts } from "../core/accounts.ts";
import { consoleLogger } from "../core/logger.ts";
import { dayKeyInTimeZone, endOfDayInTimeZone, scrapeWindowStartTsMs } from "../core/db-time.ts";
import { runPlatform } from "../platforms/runner.ts";
import type { BrowserOptions } from "../platforms/types.ts";
import { claimNextTask } from "../db/repositories/tasks.ts";
import {
  createScrapeRun,
  ensurePlatform,
  finalizeRunFromAccounts,
  setScrapeRunCommand,
  writeRunLog,
} from "../db/repositories/runs.ts";

const TIME_ZONE = process.env.SCRAPE_TIMEZONE || "Asia/Shanghai";

function taskWindow(params: Record<string, any>): { start: number; end: number } {
  const start = Number(params.windowStartTsMs);
  const end = Number(params.windowEndTsMs);
  if (Number.isFinite(start) && start > 0 && Number.isFinite(end) && end > 0) {
    return { start, end };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(params.since || "")) && /^\d{4}-\d{2}-\d{2}$/.test(String(params.until || ""))) {
    return {
      start: scrapeWindowStartTsMs(params.since, TIME_ZONE),
      end: endOfDayInTimeZone(Number(String(params.until).replace(/-/g, "")), TIME_ZONE),
    };
  }
  throw new Error("任务缺少有效的抓取时间范围");
}

async function markTask(
  handle: ReturnType<typeof openDatabase>,
  taskId: string,
  status: "running" | "success" | "failed",
  runId: string | null,
  error: string | null,
): Promise<void> {
  await handle.pool.query(
    `update scrape_tasks
        set status = $2,
            run_id = $3,
            last_error = $4,
            lease_owner = null,
            lease_until_ms = null,
            updated_ts_ms = $5
      where id = $1`,
    [taskId, status, runId, error, Date.now()],
  );
}

async function runTask(handle: ReturnType<typeof openDatabase>, task: Awaited<ReturnType<typeof claimNextTask>>): Promise<void> {
  if (!task) return;
  const accountType = String(task.accountType || "").trim();
  if (!accountType) {
    await markTask(handle, task.id, "failed", null, "任务缺少账号类型");
    return;
  }
  const params = task.params || {};
  let window = taskWindow(params);
  const limit = Number(params.limit || 0);
  const account = String(params.account || "").trim() || undefined;
  const definition = getPlatformDefinition(task.platformCode);
  const scraper = await definition.load();
  const accounts = await loadPlatformAccounts({
    db: handle.db,
    platformCode: task.platformCode,
    accountType,
    account,
    limit: 0,
  });
  if (!accounts.length) {
    await markTask(handle, task.id, "failed", null, `账号类型 ${accountType} 下没有可用账号`);
    return;
  }

  const platformId = await ensurePlatform(handle.db, { code: definition.code, name: definition.name });
  let taskDateKey = dayKeyInTimeZone(Date.now(), TIME_ZONE);
  const browserOptions: BrowserOptions = {
    browserMode: process.env.SOCIAL_BROWSER_MODE || "playwright",
    cdp: process.env.SOCIAL_SCRAPER_CDP || "http://127.0.0.1:9222",
    userDataDir: process.env.SOCIAL_BROWSER_USER_DATA_DIR || "",
    profileDirectory: process.env.SOCIAL_BROWSER_PROFILE_DIRECTORY || "",
    executablePath: process.env.SOCIAL_BROWSER_EXECUTABLE || "",
    waitTimeoutMs: Number(process.env.SOCIAL_BROWSER_WAIT_TIMEOUT_MS || 45000),
  };
  let runId = task.runId || "";
  if (runId) {
    const existing = await handle.pool.query(
      `select status, window_since_ts_ms, window_until_ts_ms, task_date_key
         from scrape_runs where id = $1`,
      [runId],
    );
    const run = existing.rows[0];
    if (run && ["failed", "partial_failed", "running"].includes(run.status)) {
      window = { start: Number(run.window_since_ts_ms), end: Number(run.window_until_ts_ms) };
      taskDateKey = Number(run.task_date_key);
      await handle.pool.query(
        `update scrape_runs
            set status = 'running',
                trigger_type = 'retry',
                finished_ts_ms = null,
                error_code = null,
                error_message = null
          where id = $1`,
        [runId],
      );
      console.log(`[worker] 任务 ${task.id} 复用 run ${runId}，跳过已成功账号`);
    } else {
      runId = "";
    }
  }
  if (!runId) {
    runId = await createScrapeRun(handle.db, {
      platformId,
      triggerType: "scheduled",
      windowSinceTsMs: window.start,
      windowUntilTsMs: window.end,
      taskDateKey,
      command: "",
    });
  }
  await handle.pool.query("update scrape_tasks set run_id = $2, updated_ts_ms = $3 where id = $1", [task.id, runId, Date.now()]);
  await setScrapeRunCommand(handle.db, runId, `worker ${task.id} ${definition.code}`);
  await writeRunLog(handle.db, {
    runId,
    level: "info",
    step: "task_start",
    message: `任务 ${task.id} 开始执行 ${definition.name}`,
    context: { taskId: task.id, platform: definition.code, accountType, account, accounts: accounts.length, limit },
  });
  console.log(`[worker] 任务 ${task.id} -> ${definition.name} / ${accountType}，账号 ${accounts.length} 个`);

  const started = Date.now();
  let errorMessage: string | null = null;
  try {
    await runPlatform({
      scraper,
      ctx: {
        db: handle.db,
        runId,
        taskDateKey,
        sinceTsMs: window.start,
        untilTsMs: window.end,
        accountType,
        limit,
        commentTimeoutMs: Number(params.commentTimeoutMs || 30000),
        logger: consoleLogger(definition.code),
        browserOptions,
      },
      accounts,
    });
  } catch (error: any) {
    errorMessage = error?.message || String(error);
    console.error(`[worker] 任务 ${task.id} 执行失败：${errorMessage}`);
  }

  const status = await finalizeRunFromAccounts(handle.db, {
    runId,
    exitCode: errorMessage ? 1 : 0,
    errorMessage,
  });
  await markTask(handle, task.id, status === "success" ? "success" : "failed", runId, status === "success" ? null : errorMessage || `run ${status}`);
  await writeRunLog(handle.db, {
    runId,
    level: status === "success" ? "info" : "error",
    step: "task_finish",
    message: `任务 ${task.id} 结束：${status}`,
    context: { taskId: task.id, status, durationMs: Date.now() - started },
  });
  console.log(`[worker] 任务 ${task.id} 结束：${status}`);
}

async function main(): Promise<void> {
  loadEnvFile();
  const args = parseArgs(process.argv.slice(2));
  const handle = openDatabase(requiredEnv("DATABASE_URL"), Number(process.env.DB_POOL_MAX || 10));
  const once = args.flags.has("once");
  const pollMs = Math.max(1000, numberArg(args, "poll-ms", 5000));
  const workerId = `worker-${process.pid}`;
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    while (!stopped) {
      const task = await claimNextTask(handle, workerId, Date.now(), 6 * 60 * 60 * 1000);
      if (!task) {
        if (once) break;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }
      try {
        await runTask(handle, task);
      } catch (error: any) {
        const message = error?.message || String(error);
        console.error(`[worker] 任务 ${task.id} 处理异常：${message}`);
        await markTask(handle, task.id, "failed", task.runId, message).catch(() => {});
      }
      if (once) break;
    }
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
