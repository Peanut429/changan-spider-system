import { loadEnvFile, requiredEnv } from "../config/env.ts";
import { numberArg, parseArgs, requireArg } from "../config/args.ts";
import { getPlatformDefinition } from "../config/platforms.ts";
import { openDatabase } from "../db/factory.ts";
import { loadPlatformAccounts } from "../core/accounts.ts";
import { consoleLogger } from "../core/logger.ts";
import { runPlatform } from "../platforms/runner.ts";
import type { BrowserOptions } from "../platforms/types.ts";

async function main(): Promise<void> {
  loadEnvFile();

  const args = parseArgs(process.argv.slice(2));
  const platformCode = requireArg(args, "platform");
  const runId = requireArg(args, "run-id");
  const taskDateKey = numberArg(args, "task-date-key", 0);
  if (!Number.isInteger(taskDateKey) || taskDateKey < 19000101 || taskDateKey > 29991231) {
    throw new Error(`--task-date-key 无效：${args.values.get("task-date-key")}`);
  }

  const sinceRaw = requireArg(args, "since");
  const untilRaw = requireArg(args, "until");
  const sinceTsMs = Date.parse(sinceRaw);
  const untilTsMs = Date.parse(untilRaw);
  if (!Number.isFinite(sinceTsMs) || !Number.isFinite(untilTsMs)) {
    throw new Error("--since / --until 必须是可解析的时间");
  }

  const accountType = args.values.get("account-type")
    || process.env.SCRAPE_ACCOUNT_TYPE
    || "总部";
  const limit = numberArg(args, "limit", 0);
  const account = args.values.get("account");
  const commentTimeoutMs = numberArg(args, "comment-timeout-ms", 30000);

  const browserOptions: BrowserOptions = {
    browserMode: args.values.get("browser-mode") || process.env.SOCIAL_BROWSER_MODE || "playwright",
    cdp: args.values.get("cdp") || process.env.SOCIAL_SCRAPER_CDP || "http://127.0.0.1:9222",
    userDataDir: args.values.get("user-data-dir") || process.env.SOCIAL_BROWSER_USER_DATA_DIR || "",
    profileDirectory: args.values.get("browser-profile-directory") || process.env.SOCIAL_BROWSER_PROFILE_DIRECTORY || "",
    executablePath: args.values.get("browser-executable") || process.env.SOCIAL_BROWSER_EXECUTABLE || "",
    waitTimeoutMs: numberArg(args, "wait-timeout-ms", 45000),
  };

  const definition = getPlatformDefinition(platformCode);
  const scraper = await definition.load();
  const needsBrowser = scraper.requiresBrowser !== false;

  if (needsBrowser) {
    if (!["playwright", "cdp"].includes(browserOptions.browserMode)) {
      throw new Error(`--browser-mode 只能是 playwright 或 cdp：${browserOptions.browserMode}`);
    }
    if (browserOptions.browserMode === "playwright") {
      if (!browserOptions.userDataDir) throw new Error("Playwright 模式缺少 SOCIAL_BROWSER_USER_DATA_DIR");
      if (!browserOptions.executablePath) throw new Error("Playwright 模式缺少 SOCIAL_BROWSER_EXECUTABLE");
    }
  }

  const handle = openDatabase(requiredEnv("DATABASE_URL"), Number(process.env.DB_POOL_MAX || 10));
  const logger = consoleLogger(platformCode);

  try {
    const accounts = await loadPlatformAccounts({
      db: handle.db,
      platformCode,
      accountType,
      account,
      limit,
    });
    if (!accounts.length) {
      throw new Error(`平台 ${platformCode} 在 account_type=${accountType} 下没有可抓账号`);
    }

    await runPlatform({
      scraper,
      ctx: {
        db: handle.db,
        runId,
        taskDateKey,
        sinceTsMs,
        untilTsMs,
        accountType,
        limit,
        commentTimeoutMs,
        logger,
        browserOptions,
      },
      accounts,
    });
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
