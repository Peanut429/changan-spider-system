import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { loadEnvFile } from "../src/config/env.ts";
import { parseArgs, requireArg } from "../src/config/args.ts";
import { openBrowserSession } from "../src/core/browser.ts";

/**
 * 把从 ego/Chrome 导出的 cookies 注入 Playwright 持久化 profile。
 *
 * cookies 文件格式：{ "cookies": [Playwright Cookie, ...] }。
 * profile 目录会被真实 Chrome 持久化，后续平台任务直接复用登录态。
 */
async function main(): Promise<void> {
  loadEnvFile();
  const args = parseArgs(process.argv.slice(2));
  const cookiesPath = path.resolve(requireArg(args, "cookies"));
  const profileDir = path.resolve(
    args.values.get("profile")
      || process.env.SOCIAL_BROWSER_USER_DATA_DIR
      || "",
  );
  if (!profileDir) throw new Error("缺少 --profile 或 SOCIAL_BROWSER_USER_DATA_DIR");

  const executablePath = args.values.get("browser-executable")
    || process.env.SOCIAL_BROWSER_EXECUTABLE
    || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const url = args.values.get("url") || "https://www.youtube.com/";

  const payload = JSON.parse(await fs.readFile(cookiesPath, "utf8"));
  const cookies = Array.isArray(payload) ? payload : payload.cookies;
  if (!Array.isArray(cookies) || !cookies.length) {
    throw new Error(`cookies 文件里没有 cookies：${cookiesPath}`);
  }

  const session = await openBrowserSession(chromium, {
    browserMode: "playwright",
    userDataDir: profileDir,
    executablePath,
    waitTimeoutMs: 60000,
  }, { cdpLabel: "SeedAuth" });

  try {
    // 先访问一次目标站点，让 cookie 以第一方上下文写入，再 reload 验证。
    await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await session.page.waitForTimeout(1000);
    await session.page.context().addCookies(cookies);
    await session.page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    await session.page.waitForTimeout(5000);

    const loggedIn = await session.page.evaluate(() => {
      const button = document.querySelector('button[aria-label="账号菜单"], #avatar-btn') as HTMLElement | null;
      const visible = button
        ? Boolean(button.offsetWidth || button.offsetHeight || button.getClientRects().length)
        : false;
      let youtubeLoggedIn: unknown = null;
      try {
        youtubeLoggedIn = (window as any).ytcfg?.get?.("LOGGED_IN");
      } catch {
        youtubeLoggedIn = null;
      }
      return youtubeLoggedIn === true || visible;
    });
    if (!loggedIn) {
      throw new Error(`登录态未生效：${url}（title=${await session.page.title()}）`);
    }

    console.log(`登录态已写入 profile：${profileDir}（cookies=${cookies.length}）`);
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
