import { openBrowserSession } from "../core/browser.ts";
import { FatalPlatformError } from "./errors.ts";
import { writeRunLog } from "../db/repositories/runs.ts";
import { isRunAccountCompleted, startScrapeRunAccount } from "../db/repositories/run-accounts.ts";
import { persistScrapeAccountResult } from "../db/persistence/persist-account-result.ts";
import type { SourceAccount } from "../core/accounts.ts";
import type { PlatformContext, PlatformScraper } from "./types.ts";

export type RunPlatformInput = {
  scraper: PlatformScraper;
  ctx: Omit<PlatformContext, "page">;
  accounts: SourceAccount[];
};

/**
 * 通用平台 runner：
 * - 打开/关闭浏览器（平台可以声明 requiresBrowser=false）
 * - 账号循环、断点跳过
 * - 调用平台 scrapeAccount
 * - 统一入库、失败入库
 *
 * 不负责创建/收口 run，那是 main/daily.ts 的职责。
 */
export async function runPlatform({
  scraper,
  ctx,
  accounts,
}: RunPlatformInput): Promise<void> {
  const needsBrowser = scraper.requiresBrowser !== false;
  let session: { page: any; close: () => Promise<void> } | null = null;

  if (needsBrowser) {
    const { chromium } = await import("playwright");
    session = await openBrowserSession(chromium, ctx.browserOptions, {
      cdpLabel: scraper.name,
    });
  }

  const platformCtx: PlatformContext = {
    ...ctx,
    accounts,
    page: session?.page ?? null,
  };

  try {
    await scraper.prepare?.(platformCtx);

    for (const account of accounts) {
      if (await isRunAccountCompleted(ctx.db, {
        platformCode: scraper.code,
        runId: ctx.runId,
        account: account.account,
      })) {
        ctx.logger.info(`跳过数据库已完成账号：${account.account}`);
        continue;
      }

      const { accountId } = await startScrapeRunAccount(ctx.db, {
        platformCode: scraper.code,
        platformName: scraper.name,
        runId: ctx.runId,
        accountRow: { ...account, profileUrl: account.link },
      });

      try {
        const result = await scraper.scrapeAccount({ ...platformCtx, account });

        await persistScrapeAccountResult(ctx.db, {
          platformCode: scraper.code,
          platformName: scraper.name,
          runId: ctx.runId,
          accountId,
          accountRow: result.accountRow,
          contentRows: result.contentRows,
          taskDateKey: ctx.taskDateKey,
        });
      } catch (error: any) {
        const message = error?.message || String(error);

        // 把"当时的现场数据"落库：终端日志会滚掉，error_message 只有一句话。
        if (error?.context && typeof error.context === "object") {
          await writeRunLog(ctx.db, {
            runId: ctx.runId,
            accountRunId: null,
            level: "error",
            step: error.name === "PublishTimeError" ? "publish_time" : "scrape_error",
            message,
            errorCode: error?.errorCode || null,
            errorStack: error?.stack || null,
            pageUrl: error?.pageUrl || null,
            context: error.context as Record<string, unknown>,
          }).catch((logError: any) => {
            ctx.logger.error(`账号 ${account.account} 诊断日志写入失败：${logError?.message || logError}`);
          });
        }

        ctx.logger.error(`账号 ${account.account} 失败：${message}`);

        await persistScrapeAccountResult(ctx.db, {
          platformCode: scraper.code,
          platformName: scraper.name,
          runId: ctx.runId,
          accountId,
          accountRow: {
            account: account.account,
            profileUrl: account.link,
            error: message,
          },
          contentRows: [],
          taskDateKey: ctx.taskDateKey,
        });

        if (error instanceof FatalPlatformError) {
          ctx.logger.error(`账号 ${account.account} 平台级错误，终止平台：${message}`);
          throw error;
        }
      }
    }
  } finally {
    await scraper.dispose?.();
    if (session) await session.close();
  }
}
