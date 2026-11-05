import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import type { BrowserType } from "playwright";

const defaultChromeExecutable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * 6 个平台共享一个 Chrome profile（user data dir）：
 *   1) 平台独立 env  `${PLATFORM}_USER_DATA_DIR`（一般用不到）
 *   2) 通用 env  `SOCIAL_BROWSER_USER_DATA_DIR`
 *   3) 兜底  `~/.mavis/changan-chrome-profile`
 *
 * 共享 profile 的目的：很多平台支持 Google 登录，一次登录 6 个平台都能用。
 * 6 个平台用各自的 `defaultBrowserOptions` 调用，但读同一个 env / 兜底路径。
 */
const FALLBACK_USER_DATA_DIR = path.join(os.homedir(), ".mavis", "changan-chrome-profile");

export function sharedUserDataDir(envPrefix: string): string {
  return process.env[`${envPrefix}_USER_DATA_DIR`]
    || process.env.SOCIAL_BROWSER_USER_DATA_DIR
    || FALLBACK_USER_DATA_DIR;
}

export function defaultBrowserOptions(workspace, profileName, envPrefix) {
  return {
    browserMode: process.env[`${envPrefix}_BROWSER_MODE`] || process.env.SOCIAL_BROWSER_MODE || "playwright",
    userDataDir: sharedUserDataDir(envPrefix),
    profileDirectory: process.env[`${envPrefix}_BROWSER_PROFILE_DIRECTORY`] || process.env.SOCIAL_BROWSER_PROFILE_DIRECTORY || "",
    executablePath: process.env[`${envPrefix}_BROWSER_EXECUTABLE`] || process.env.SOCIAL_BROWSER_EXECUTABLE || "",
    loginOnly: false,
  };
}

export function expandHome(input) {
  return String(input || "").replace(/^~(?=\/|$)/, process.env.HOME || "");
}

export function browserUsageLines(profileName) {
  return [
    "  --browser-mode <模式>  playwright 或 cdp，默认 playwright",
    "  --user-data-dir <目录> Playwright 用户目录，默认 work/playwright-social-profile",
    "  --browser-profile-directory <目录名> Playwright/Chrome 使用的 profile 目录，例如 Profile 2",
    "  --browser-executable <路径> Playwright 控制的浏览器可执行文件，默认自动使用本机 Chrome 作为兜底",
    "  --login-only           只打开 Playwright 浏览器用于登录，不抓取数据",
  ];
}

export function validateBrowserMode(args) {
  if (!["playwright", "cdp"].includes(args.browserMode)) {
    throw new Error("--browser-mode 只能是 playwright 或 cdp");
  }
}

export async function openBrowserSession(chromium: BrowserType, args, { cdpLabel = "Chrome", pageUrlPattern = null, preferNewPage = false } = {}) {
  if (args.browserMode === "cdp") {
    try {
      const cdp = args.cdp.replace(/\/$/, "");
      const check = await fetch(`${cdp}/json/version`, { signal: AbortSignal.timeout(3000) });
      if (!check.ok) throw new Error(`HTTP ${check.status}`);
      const browser = await chromium.connectOverCDP(args.cdp);
      const context = browser.contexts()[0] || await browser.newContext();
      const pages = context.pages();
      const page = preferNewPage
        ? await context.newPage()
        : ((pageUrlPattern ? pages.find((p) => pageUrlPattern.test(p.url())) : null) || pages[0] || await context.newPage());
      page.setDefaultTimeout(args.waitTimeoutMs || 45000);
      await page.bringToFront().catch(() => {});
      return { page, close: () => browser.close().catch(() => {}) };
    } catch (error) {
      throw new Error([
        `无法连接到 ${cdpLabel}：${args.cdp}。`,
        "默认建议使用 Playwright 隔离浏览器：先运行对应脚本的 --login-only 登录，再运行抓取。",
        `原始错误：${error.message}`,
      ].join("\n"));
    }
  }

  const launchOptions: Record<string, any> = {
    headless: false,
    viewport: null,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
    ],
  };
  if (args.profileDirectory) {
    launchOptions.args.push(`--profile-directory=${args.profileDirectory}`);
  }
  if (args.executablePath) {
    launchOptions.executablePath = args.executablePath;
  } else if (fs.existsSync(defaultChromeExecutable)) {
    launchOptions.executablePath = defaultChromeExecutable;
  }

  const context = await chromium.launchPersistentContext(args.userDataDir, launchOptions);
  const pages = context.pages();
  const page = preferNewPage
    ? await context.newPage()
    : ((pageUrlPattern ? pages.find((p) => pageUrlPattern.test(p.url())) : null) || pages[0] || await context.newPage());
  page.setDefaultTimeout(args.waitTimeoutMs || 45000);
  await page.bringToFront().catch(() => {});
  return { page, close: () => context.close().catch(() => {}) };
}

export async function waitForManualLogin(page, args, { platform, startUrl }) {
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: args.waitTimeoutMs || 45000 }).catch(() => {});
  console.log("");
  console.log(`${platform} Playwright 登录窗口已打开。`);
  console.log(`登录状态会保存到：${args.userDataDir}`);
  console.log("登录完成后，在终端按 Ctrl+C 关闭登录窗口。之后再运行正式抓取命令。");
  await new Promise(() => {});
}
