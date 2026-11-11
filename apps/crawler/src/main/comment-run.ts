/**
 * 评论任务一次性入口（没有页面，命令行运行）。
 *
 * 本地快速开始：
 *   cd apps/crawler
 *   pnpm run comment:help
 *   pnpm run comment:run -- --dry-run --last-month --account-type 总部
 *   pnpm run comment:run -- --platforms instagram --account byd.uk --since 2026-09-01 --until 2026-09-30
 *
 * 只走 TikHub 接口，不启动浏览器；帖子从 social_contents 读取，评论写入 comment 表。
 * 完整说明见 apps/crawler/COMMENTS.md。
 */
import { loadEnvFile, requiredEnv } from "../config/env.ts";
import { numberArg, parseArgs } from "../config/args.ts";
import type { ParsedArgs } from "../config/args.ts";
import { loadPlatformAccounts } from "../core/accounts.ts";
import { dayKeyInTimeZone } from "../core/db-time.ts";
import { consoleLogger } from "../core/logger.ts";
import { resolveCommentWindow } from "../core/month-window.ts";
import { createTikHubClient } from "../core/tikhub.ts";
import { COMMENT_PLATFORM_CODES, getCommentFetcher } from "../comments/registry.ts";
import { loadCommentPosts } from "../comments/posts.ts";
import { runCommentPlatform, RunInterruptedError } from "../comments/runner.ts";
import type { CommentRunnerOptions, PlatformCommentSummary, StopSignal } from "../comments/runner.ts";
import { openDatabase } from "../db/factory.ts";
import type { DbHandle } from "../db/factory.ts";
import {
  createScrapeRun,
  ensurePlatform,
  finalizeRunFromAccounts,
  finishScrapeRun,
  setScrapeRunCommand,
  writeRunLog,
} from "../db/repositories/runs.ts";

const DEFAULT_TIME_ZONE = "Asia/Shanghai";

type RunWindow = {
  sinceText: string;
  untilText: string;
  sinceTsMs: number;
  untilTsMs: number;
  source: "range" | "last-month" | "resume";
};

const HELP_TEXT = `
评论任务（只走 TikHub 接口，不启动浏览器）

用法：
  pnpm run comment:run -- [参数]

账号范围（至少给一个，除非显式 --all-accounts）：
  --account-type <name>       账号类型，对应 account_categories 的 code/name
                              常见值：总部、中南美-月报、中东非、欧洲
  --account <handle>          单个账号，例如 byd.uk
  --account-ids <id,id>       指定 social_accounts.id
  --all-accounts              显式放开全部账号（慎用）

时间范围（二选一）：
  --last-month                上月整月（按 SCRAPE_TIMEZONE，默认 Asia/Shanghai）
  --since <YYYY-MM-DD>        开始日期（含当天 00:00:00）
  --until <YYYY-MM-DD>        结束日期（含当天 23:59:59）

平台：
  --platforms <list>          可省略；省略时自动判断：
                              - 指定 --account / --account-ids → 只跑账号所在平台
                              - 指定 --run-id → 跑该 run 所属平台
                              - 只给 --account-type → 跑下面四个平台
                              可选：instagram,tiktok,youtube,x（兼容 --platform）
                              Facebook / LinkedIn 没有评论接口，不能选；未知参数会直接报错

抓取控制：
  --no-replies                    只抓一级评论（默认抓二级回复）
  --max-pages-per-post <n>        一级评论最多翻页数（默认 10）
  --max-reply-pages-per-comment <n>  每条一级评论的回复最多翻页数（默认 3）
  --max-replies-per-comment <n>   每条一级评论最多抓多少条回复（默认 50）
  --max-comments-per-post <n>     单帖一级+回复总数上限（默认 500，超出记 truncated）
  --max-posts-per-account <n>     每个账号最多处理多少帖子（默认 0=不限，调试用）
  --include-zero-comments         连每日指标评论数为 0 的帖子也抓
  --limit <n>                     每个平台最多处理多少账号（调试用）

运行方式：
  --dry-run                       只打印账号/帖子数量，不调接口、不写库
  --run-id <run-xxx>              续跑失败 run（沿用原窗口，跳过已完成账号/帖子）
  --trigger manual|scheduled      写入 scrape_runs.trigger_type（默认 manual）

示例：
  # 1) 先看范围（不调接口、不写库）
  pnpm run comment:run -- --dry-run --last-month --account-type 总部

  # 2) 单账号小窗口试跑
  pnpm run comment:run -- --platforms instagram --account byd.uk --since 2026-09-01 --until 2026-09-30 --max-comments-per-post 5

  # 3) 跑上月某个账号类型
  pnpm run comment:run -- --last-month --account-type 中南美-月报

  # 4) 只指定账号时不用写平台，程序按账号所在平台跑
  pnpm run comment:run -- --account-ids account-xxxx --since 2026-10-01 --until 2026-10-31

  # 5) 失败后续跑（run id 在运行输出里）
  pnpm run comment:run -- --account byd.uk --run-id run-xxxx

环境变量（apps/crawler/.env）：
  DATABASE_URL           数据库连接
  TIKHUB_API_KEY         TikHub Key（必填）
  TIKHUB_BASE_URL        可选，默认 https://api.tikhub.io
  TIKHUB_MIN_INTERVAL_MS 可选，请求最小间隔，默认 120ms
  SCRAPE_TIMEZONE        可选，默认 Asia/Shanghai

结果：
  comment 表（content_id 关联 social_contents.id；parent_comment_id/root_comment_id 表示回复层级）
  scrape_runs / scrape_run_accounts / scrape_raw_records（record_type = 'comment_post'，帖子级断点）

完整说明：apps/crawler/COMMENTS.md
`;

function printHelp(): void {
  console.log(HELP_TEXT.trim());
}

const ALLOWED_VALUE_ARGS = new Set([
  "platforms",
  "platform", // 兼容单数写法
  "account-type",
  "account",
  "account-ids",
  "since",
  "until",
  "max-pages-per-post",
  "max-reply-pages-per-comment",
  "max-replies-per-comment",
  "max-comments-per-post",
  "max-posts-per-account",
  "limit",
  "run-id",
  "trigger",
]);

const ALLOWED_FLAGS = new Set([
  "", // pnpm run -- 会传一个裸 "--"
  "dry-run",
  "last-month",
  "no-replies",
  "all-accounts",
  "include-zero-comments",
  "help",
]);

/**
 * 未知参数直接报错。
 * 之前 --platform 拼错会被静默忽略，导致默认四个平台全跑，非常危险。
 */
function validateArgs(args: ParsedArgs): void {
  const unknownValues = [...args.values.keys()].filter((key) => !ALLOWED_VALUE_ARGS.has(key));
  const unknownFlags = [...args.flags].filter((key) => !ALLOWED_FLAGS.has(key));
  const unknownPositionals = args.positionals.filter((value) => value !== "help");
  const unknown = [
    ...unknownValues.map((key) => `--${key}`),
    ...unknownFlags.map((key) => `--${key}`),
    ...unknownPositionals,
  ];
  if (unknown.length) {
    throw new Error(`未知参数：${unknown.join(" ")}。运行 pnpm comment:help 查看用法`);
  }
}

function describeDatabaseTarget(url: string): { host: string; database: string; remote: boolean } {
  const match = String(url || "").match(/^postgres(?:ql)?:\/\/[^@]*@([^/:?]+)(?::\d+)?\/([^?]+)/i);
  if (!match) return { host: "(无法解析)", database: "(无法解析)", remote: true };
  const host = match[1];
  const database = match[2];
  const remote = !/^(localhost|127\.0\.0\.1|::1)$/i.test(host);
  return { host, database, remote };
}

function splitList(value: string | undefined): string[] {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function commandText(): string {
  return [process.execPath, ...process.argv.slice(1)]
    .map((part) => (/\s/.test(part) ? `"${part}"` : part))
    .join(" ");
}

function dateText(ms: number, timeZone: string): string {
  return new Date(ms).toLocaleDateString("sv-SE", { timeZone });
}

function positiveInt(args: ParsedArgs, key: string, fallback: number, min = 1): number {
  const value = numberArg(args, key, fallback);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`--${key} 必须是不小于 ${min} 的整数：${value}`);
  }
  return value;
}

async function resolveCategoryId(handle: DbHandle, accountType: string): Promise<string | null> {
  const result = await handle.pool.query(
    `select id
       from account_categories
      where active = true
        and (code = $1 or name = $1)
      limit 1`,
    [accountType],
  );
  return result.rows[0]?.id || null;
}

async function loadAccountsForPlatform(
  handle: DbHandle,
  platformCode: string,
  scope: {
    accountType?: string;
    categoryId: string | null;
    account?: string;
    accountIds?: string[];
    limit: number;
  },
) {
  const legacyAccountType = scope.accountType && !scope.categoryId ? scope.accountType : undefined;
  return loadPlatformAccounts({
    db: handle.db,
    platformCode,
    categoryId: scope.categoryId || undefined,
    accountType: legacyAccountType,
    account: scope.account,
    accountIds: scope.accountIds,
    limit: scope.limit,
  });
}

/**
 * 只给了 --account / --account-ids、没给 --platforms 时，从账号反推平台。
 * 账号是 YouTube 的就只跑 YouTube，不会默认四个平台全跑。
 */
async function inferPlatformCodesFromAccounts(
  handle: DbHandle,
  account: string,
  accountIds: string[],
): Promise<string[]> {
  const result = await handle.pool.query(
    `select distinct p.code
       from social_accounts a
       join platforms p on p.id = a.platform_id
      where a.active = true
        and p.enabled = true
        and (cardinality($1::text[]) = 0 or a.id = any($1::text[]))
        and ($2 = '' or a.handle = $2)`,
    [accountIds, account],
  );
  const codes = [...new Set(result.rows.map((row: any) => String(row.code || "").toLowerCase()).filter(Boolean))];
  if (!codes.length) {
    throw new Error("指定的账号不存在、已停用，或查不到所属平台；用 --account-ids/--account 核对一下");
  }
  const supported = codes.filter((code) => COMMENT_PLATFORM_CODES.includes(code));
  const unsupported = codes.filter((code) => !COMMENT_PLATFORM_CODES.includes(code));
  if (!supported.length) {
    throw new Error(
      `账号所在平台（${unsupported.join(", ")}）没有评论接口；评论任务只支持 ${COMMENT_PLATFORM_CODES.join(", ")}`,
    );
  }
  if (unsupported.length) {
    console.warn(`账号所在平台 ${unsupported.join(", ")} 没有评论接口，已跳过`);
  }
  return supported;
}

function scopeLabel(scope: {
  accountType?: string;
  account?: string;
  accountIds?: string[];
  allAccounts: boolean;
}): string {
  if (scope.accountType) return `账号类型 ${scope.accountType}`;
  if (scope.account) return `账号 ${scope.account}`;
  if (scope.accountIds?.length) return `账号 ${scope.accountIds.join(", ")}`;
  return scope.allAccounts ? "全部账号" : "(未指定)";
}

function printSummary(summary: PlatformCommentSummary): void {
  console.log(`\n[${summary.platformCode}] ${summary.platformName} 完成`);
  console.log(
    `  账号 ${summary.accounts}（成功 ${summary.successAccounts}，失败 ${summary.failedAccounts}，跳过 ${summary.skippedAccounts}）`,
  );
  console.log(
    `  帖子 ${summary.posts}（有评论 ${summary.postsWithComments}，失败 ${summary.failedPosts}，截断 ${summary.truncatedPosts}）`,
  );
  console.log(
    `  评论 一级 ${summary.topLevelComments} + 回复 ${summary.replyComments}，`
    + `新增 ${summary.inserted}，更新 ${summary.updated}，跳过 ${summary.skippedComments}`,
  );
  console.log(`  API 请求 ${summary.apiCalls}，耗时 ${(summary.durationMs / 1000).toFixed(1)}s`);
  if (summary.zeroPostAccounts.length) {
    const preview = summary.zeroPostAccounts.slice(0, 20).join("、");
    const more = summary.zeroPostAccounts.length > 20 ? ` 等 ${summary.zeroPostAccounts.length} 个` : "";
    console.log(`  窗口内 0 帖子账号：${preview}${more}`);
  }
}

async function dryRun(
  handle: DbHandle,
  platformCodes: string[],
  scope: Parameters<typeof loadAccountsForPlatform>[2],
  window: RunWindow,
  options: CommentRunnerOptions,
): Promise<void> {
  console.log(`[dry-run] 窗口 ${window.sinceText} ~ ${window.untilText}（${window.source}）`);
  for (const code of platformCodes) {
    const fetcher = getCommentFetcher(code);
    const accounts = await loadAccountsForPlatform(handle, code, scope);
    let posts = 0;
    let postsWithComments = 0;
    let zeroAccountCount = 0;
    for (const account of accounts) {
      if (!account.id) continue;
      const rows = await loadCommentPosts(handle, {
        accountId: account.id,
        windowSinceTsMs: window.sinceTsMs,
        windowUntilTsMs: window.untilTsMs,
        includeZeroComments: options.includeZeroComments,
        limit: options.maxPostsPerAccount,
      });
      posts += rows.length;
      postsWithComments += rows.filter((row) => (row.commentCount ?? 0) > 0).length;
      if (!rows.length) zeroAccountCount += 1;
    }
    console.log(
      `[dry-run] ${fetcher.name}：账号 ${accounts.length}，帖子 ${posts}（评论数>0 的 ${postsWithComments}），`
      + `0 帖子账号 ${zeroAccountCount}`,
    );
  }
}

async function main(): Promise<void> {
  loadEnvFile();

  const timeZone = process.env.SCRAPE_TIMEZONE || DEFAULT_TIME_ZONE;
  const rawArgs = process.argv.slice(2);
  const args = parseArgs(rawArgs);
  if (!rawArgs.length || args.flags.has("help") || args.positionals.includes("help")) {
    printHelp();
    return;
  }
  validateArgs(args);
  const dryRunMode = args.flags.has("dry-run");
  const lastMonth = args.flags.has("last-month");
  const includeReplies = !args.flags.has("no-replies");
  const allAccounts = args.flags.has("all-accounts");

  const accountType = String(args.values.get("account-type") || "").trim();
  const account = String(args.values.get("account") || "").trim();
  const accountIds = splitList(args.values.get("account-ids"));
  if (!accountType && !account && !accountIds.length && !allAccounts) {
    throw new Error(
      "必须指定账号范围：--account-type / --account / --account-ids，"
      + "或显式传 --all-accounts",
    );
  }

  const explicitPlatforms = [...new Set(
    splitList(args.values.get("platforms") || args.values.get("platform")).map((code) => code.toLowerCase()),
  )];
  // 显式传的平台提前校验，避免跑到一半才发现平台不支持。
  for (const code of explicitPlatforms) getCommentFetcher(code);

  const resumeRunId = String(args.values.get("run-id") || "").trim();

  const triggerRaw = String(args.values.get("trigger") || "manual").trim().toLowerCase();
  if (triggerRaw !== "manual" && triggerRaw !== "scheduled") {
    throw new Error("--trigger 只能是 manual 或 scheduled");
  }
  const triggerType = triggerRaw === "scheduled" ? "scheduled" : "manual";

  const options: CommentRunnerOptions = {
    includeReplies,
    maxPagesPerPost: positiveInt(args, "max-pages-per-post", 10),
    maxReplyPagesPerComment: positiveInt(args, "max-reply-pages-per-comment", 3, 0),
    maxRepliesPerComment: positiveInt(args, "max-replies-per-comment", 50, 0),
    maxCommentsPerPost: positiveInt(args, "max-comments-per-post", 500),
    maxPostsPerAccount: positiveInt(args, "max-posts-per-account", 0, 0),
    includeZeroComments: args.flags.has("include-zero-comments"),
  };

  if (resumeRunId && (lastMonth || args.values.get("since") || args.values.get("until"))) {
    console.warn("续跑模式使用 run 上记录的窗口，--last-month/--since/--until 会被忽略");
  }
  // 续跑时窗口以 run 上记录的为准，不需要再解析 --since/--until。
  const window = resumeRunId
    ? null
    : resolveCommentWindow({
        since: args.values.get("since"),
        until: args.values.get("until"),
        lastMonth,
        timeZone,
      });

  const databaseUrl = requiredEnv("DATABASE_URL");
  const target = describeDatabaseTarget(databaseUrl);
  console.log(`[comment] 数据库：${target.database} @ ${target.host}`);
  if (target.remote) {
    console.warn(
      "[comment] 注意：DATABASE_URL 指向远程库，评论会写入该库。"
      + "生产库请先 --dry-run，并用 --account/--account-ids 小范围确认。",
    );
  }
  const handle = openDatabase(databaseUrl, Number(process.env.DB_POOL_MAX || 10));
  const stop: StopSignal = { stopped: false };
  process.on("SIGINT", () => {
    stop.stopped = true;
    console.warn("收到 SIGINT：当前帖子处理完后停止，可用 --run-id 续跑");
  });
  process.on("SIGTERM", () => {
    stop.stopped = true;
    console.warn("收到 SIGTERM：当前帖子处理完后停止");
  });

  try {
    const categoryId = accountType ? await resolveCategoryId(handle, accountType) : null;
    if (accountType && !categoryId) {
      console.warn(`账号类型 ${accountType} 不在 account_categories 中，回退 social_accounts.account_type 过滤`);
    }
    const scope = {
      accountType: accountType || undefined,
      categoryId,
      account: account || undefined,
      accountIds: accountIds.length ? accountIds : undefined,
      limit: positiveInt(args, "limit", 0, 0),
    };

    // 平台优先级：--run-id 所属平台 > 显式 --platforms > 指定账号反推 > 默认四个平台。
    let platformCodes: string[];
    if (resumeRunId) {
      const runPlatform = await handle.pool.query(
        `select p.code
           from scrape_runs r
           join platforms p on p.id = r.platform_id
          where r.id = $1`,
        [resumeRunId],
      );
      if (!runPlatform.rows.length) throw new Error(`run ${resumeRunId} 不存在`);
      const runCode = String(runPlatform.rows[0].code || "").toLowerCase();
      if (explicitPlatforms.length && !explicitPlatforms.includes(runCode)) {
        throw new Error(`run ${resumeRunId} 属于平台 ${runCode}，和 --platforms 不一致`);
      }
      platformCodes = [runCode];
    } else if (explicitPlatforms.length) {
      platformCodes = explicitPlatforms;
    } else if (account || accountIds.length) {
      platformCodes = await inferPlatformCodesFromAccounts(handle, account, accountIds);
    } else {
      platformCodes = [...COMMENT_PLATFORM_CODES];
    }
    for (const code of platformCodes) getCommentFetcher(code);

    if (dryRunMode) {
      if (!window) throw new Error("--dry-run 不能和 --run-id 一起使用");
      await dryRun(handle, platformCodes, scope, window, options);
      return;
    }

    const client = createTikHubClient();
    if (!client.enabled) {
      throw new Error("缺少 TIKHUB_API_KEY：评论任务只走 TikHub 接口，请先在 apps/crawler/.env 配置");
    }

    let failedPlatforms = 0;
    let attemptedPlatforms = 0;
    const runWindow: RunWindow = window
      ? { ...window }
      : { sinceText: "", untilText: "", sinceTsMs: 0, untilTsMs: 0, source: "resume" };

    for (const code of platformCodes) {
      if (stop.stopped) {
        failedPlatforms += 1;
        break;
      }

      const fetcher = getCommentFetcher(code);
      const platformId = await ensurePlatform(handle.db, { code: fetcher.code, name: fetcher.name });
      const accounts = await loadAccountsForPlatform(handle, code, scope);

      // 默认四平台/账号类型场景下，某平台没有账号是正常的：跳过，不建失败 run。
      if (!accounts.length && !resumeRunId) {
        console.warn(`[comment] ${fetcher.name}：当前账号范围下没有账号，跳过`);
        continue;
      }
      attemptedPlatforms += 1;

      let platformWindow: RunWindow = runWindow;
      let runId = resumeRunId;

      if (runId) {
        const result = await handle.pool.query(
          `select id, platform_id, status, window_since_ts_ms, window_until_ts_ms
             from scrape_runs where id = $1`,
          [runId],
        );
        const run = result.rows[0];
        if (!run) throw new Error(`run ${runId} 不存在`);
        if (run.platform_id !== platformId) throw new Error(`run ${runId} 不属于平台 ${code}`);
        if (["success", "cancelled"].includes(run.status)) {
          throw new Error(`run ${runId} 已结束（${run.status}），不需要续跑`);
        }
        platformWindow = {
          sinceText: dateText(Number(run.window_since_ts_ms), timeZone),
          untilText: dateText(Number(run.window_until_ts_ms), timeZone),
          sinceTsMs: Number(run.window_since_ts_ms),
          untilTsMs: Number(run.window_until_ts_ms),
          source: "resume",
        };
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
        console.log(`[comment] 续跑 run ${runId}，窗口 ${platformWindow.sinceText} ~ ${platformWindow.untilText}`);
      } else {
        runId = await createScrapeRun(handle.db, {
          platformId,
          triggerType,
          windowSinceTsMs: platformWindow.sinceTsMs,
          windowUntilTsMs: platformWindow.untilTsMs,
          taskDateKey: dayKeyInTimeZone(Date.now(), timeZone),
          command: commandText(),
        });
      }

      const scopeText = scopeLabel({ ...scope, allAccounts });
      await setScrapeRunCommand(handle.db, runId, commandText());
      await writeRunLog(handle.db, {
        runId,
        level: "info",
        step: "comment_start",
        message: `评论任务开始：${fetcher.name} / ${scopeText}`,
        context: {
          platform: fetcher.code,
          scope: scopeText,
          since: platformWindow.sinceText,
          until: platformWindow.untilText,
          accounts: accounts.length,
          includeReplies: options.includeReplies,
          maxCommentsPerPost: options.maxCommentsPerPost,
          includeZeroComments: options.includeZeroComments,
        },
      });
      console.log(
        `\n[comment] ${fetcher.name} run=${runId} 窗口 ${platformWindow.sinceText} ~ ${platformWindow.untilText}`
        + `，${scopeText}，账号 ${accounts.length} 个`,
      );

      if (!accounts.length) {
        const message = `按当前账号范围（${scopeText}）在 ${fetcher.name} 没有可用账号`;
        await finalizeRunFromAccounts(handle.db, { runId, exitCode: 1, errorMessage: message });
        await writeRunLog(handle.db, {
          runId,
          level: "error",
          step: "comment_finish",
          message,
          context: { platform: code },
        });
        console.error(`[comment] ${fetcher.name}：${message}`);
        failedPlatforms += 1;
        continue;
      }

      try {
        const summary = await runCommentPlatform({
          handle,
          runId,
          platformId,
          platformCode: fetcher.code,
          fetcher,
          accounts,
          client,
          windowSinceTsMs: platformWindow.sinceTsMs,
          windowUntilTsMs: platformWindow.untilTsMs,
          options,
          logger: consoleLogger(fetcher.code),
          stop,
        });

        const status = await finalizeRunFromAccounts(handle.db, { runId, exitCode: 0 });
        await writeRunLog(handle.db, {
          runId,
          level: status === "success" ? "info" : "error",
          step: "comment_finish",
          message: `评论任务结束：${status}`,
          context: {
            platform: fetcher.code,
            status,
            accounts: summary.accounts,
            successAccounts: summary.successAccounts,
            failedAccounts: summary.failedAccounts,
            posts: summary.posts,
            failedPosts: summary.failedPosts,
            topLevelComments: summary.topLevelComments,
            replyComments: summary.replyComments,
            inserted: summary.inserted,
            updated: summary.updated,
            apiCalls: summary.apiCalls,
            durationMs: summary.durationMs,
          },
        });
        printSummary(summary);
        console.log(`  run 状态：${status}`);
        if (status !== "success") failedPlatforms += 1;
      } catch (error: any) {
        const interrupted = error instanceof RunInterruptedError;
        const message = interrupted
          ? "收到中断信号，评论任务停止"
          : (error?.message || String(error));
        if (interrupted) {
          await finishScrapeRun(handle.db, {
            runId,
            status: "failed",
            errorCode: "INTERRUPTED",
            errorMessage: message,
          });
        } else {
          await finalizeRunFromAccounts(handle.db, { runId, exitCode: 1, errorMessage: message });
        }
        await writeRunLog(handle.db, {
          runId,
          level: "error",
          step: "comment_error",
          message: `评论任务异常：${message}`,
          context: { platform: code },
        });
        console.error(`[comment] ${fetcher.name} 异常：${message}`);
        failedPlatforms += 1;
        if (interrupted) break;
      }
    }

    if (attemptedPlatforms === 0 && failedPlatforms === 0) {
      console.error("\n[comment] 所有平台在当前账号范围下都没有账号，没有执行任何抓取");
      process.exitCode = 1;
    } else if (failedPlatforms) {
      console.error(`\n[comment] 完成，但有 ${failedPlatforms} 个平台/中断未成功`);
      process.exitCode = 1;
    } else {
      console.log("\n[comment] 全部平台完成");
    }
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
