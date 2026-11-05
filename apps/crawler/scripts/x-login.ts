import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { loadEnvFile } from "../src/config/env.ts";
import { numberArg, parseArgs } from "../src/config/args.ts";
import { openBrowserSession } from "../src/core/browser.ts";

/**
 * 打开 X 登录窗口，轮询到登录成功后关闭，让 Playwright profile 持久化登录态。
 * 只用于本地/服务器首次登录，不属于 daily 任务。
 */
async function main(): Promise<void> {
  loadEnvFile();
  const args = parseArgs(process.argv.slice(2));
  const profileDir = path.resolve(
    args.values.get("profile")
      || process.env.SOCIAL_BROWSER_USER_DATA_DIR
      || path.join(process.cwd(), ".tmp-profile-x-auth"),
  );
  const executablePath = args.values.get("browser-executable")
    || process.env.SOCIAL_BROWSER_EXECUTABLE
    || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!fs.existsSync(executablePath)) {
    throw new Error(`Chrome 不存在：${executablePath}`);
  }

  const url = args.values.get("url") || "https://x.com/home";
  const timeoutMs = numberArg(args, "timeout-ms", 10 * 60 * 1000);

  const session = await openBrowserSession(chromium, {
    browserMode: "playwright",
    userDataDir: profileDir,
    executablePath,
    waitTimeoutMs: 60000,
  }, { cdpLabel: "X Login" });

  try {
    await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    console.log(`请在弹出的 Chrome 窗口里登录 X。登录成功后会自动保存 profile：${profileDir}`);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (session.page.isClosed()) {
        throw new Error("登录窗口被关闭，但还没有检测到登录成功");
      }
      const loggedIn = await session.page.evaluate(() => {
        const nav = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]') as HTMLElement | null;
        return nav ? Boolean(nav.offsetWidth || nav.offsetHeight || nav.getClientRects().length) : false;
      }).catch(() => false);
      if (loggedIn) {
        console.log("X 登录成功，保存 profile...");
        await session.page.waitForTimeout(3000);
        await session.close();
        console.log("X 登录态已保存");
        return;
      }
      await session.page.waitForTimeout(2000);
    }

    throw new Error(`等待 X 登录超时（${timeoutMs}ms）`);
  } finally {
    await session.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
