import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { loadEnvFile, requiredEnv } from "../config/env.ts";
import { numberArg, parseArgs } from "../config/args.ts";
import { getPlatformDefinition } from "../config/platforms.ts";
import { openDatabase } from "../db/factory.ts";
import {
  createScrapeRun,
  ensurePlatform,
  finalizeRunFromAccounts,
  setScrapeRunCommand,
  writeRunLog,
} from "../db/repositories/runs.ts";
import { resolveDailyWindow } from "../core/daily-window.ts";
import { killProcessTree } from "../core/process.ts";

function commandText(command: string, args: string[]): string {
  return [command, ...args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ");
}

function appendLineBuffer(
  buffer: { value: string },
  chunk: Buffer,
  onLine: (line: string) => void,
): void {
  buffer.value += chunk.toString("utf8");
  const lines = buffer.value.split(/\r?\n/);
  buffer.value = lines.pop() || "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) onLine(trimmed);
  }
}

function waitForClose(child: ChildProcess): Promise<{ exitCode: number | null; error: Error | null }> {
  return new Promise((resolve) => {
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: null, error });
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: code, error: null });
    });
  });
}

async function main(): Promise<void> {
  loadEnvFile();

  const args = parseArgs(process.argv.slice(2));
  const platformsRaw = args.values.get("platforms");
  if (!platformsRaw) {
    throw new Error("当前阶段必须显式传 --platforms（例如 --platforms fake）");
  }
  const platformCodes = platformsRaw.split(",").map((code) => code.trim()).filter(Boolean);
  if (!platformCodes.length) throw new Error("--platforms 不能为空");

  const accountType = args.values.get("account-type")
    || process.env.SCRAPE_ACCOUNT_TYPE
    || "总部";
  const limit = numberArg(args, "limit", 0);
  const platformTimeoutMs = numberArg(args, "platform-timeout-ms", 6 * 60 * 60 * 1000);
  const timeZone = process.env.SCRAPE_TIMEZONE || "Asia/Shanghai";
  const window = resolveDailyWindow(timeZone, args.values.get("until"));

  const handle = openDatabase(requiredEnv("DATABASE_URL"), Number(process.env.DB_POOL_MAX || 10));
  let failed = 0;

  try {
    console.log(`每日抓取开始，平台：${platformCodes.join(", ")}`);
    console.log(`业务时区：${timeZone}，task_date_key=${window.taskDateKey}`);
    console.log(`抓取窗口：${new Date(window.windowSinceTsMs).toISOString()} ~ ${window.untilValue}`);

    for (const code of platformCodes) {
      const definition = getPlatformDefinition(code);
      const platformId = await ensurePlatform(handle.db, { code: definition.code, name: definition.name });
      const runId = await createScrapeRun(handle.db, {
        platformId,
        triggerType: "scheduled",
        windowSinceTsMs: window.windowSinceTsMs,
        windowUntilTsMs: window.windowUntilTsMs,
        taskDateKey: window.taskDateKey,
        command: "",
      });

      const childArgs = [
        "--experimental-strip-types",
        path.join(process.cwd(), "src/main/platform.ts"),
        "--platform", definition.code,
        "--run-id", runId,
        "--task-date-key", String(window.taskDateKey),
        "--since", new Date(window.windowSinceTsMs).toISOString(),
        "--until", new Date(window.windowUntilTsMs).toISOString(),
        "--account-type", accountType,
      ];
      if (limit > 0) childArgs.push("--limit", String(limit));
      if (args.values.get("comment-timeout-ms")) {
        childArgs.push("--comment-timeout-ms", args.values.get("comment-timeout-ms")!);
      }
      if (args.values.get("account")) childArgs.push("--account", args.values.get("account")!);
      if (args.values.get("browser-mode")) childArgs.push("--browser-mode", args.values.get("browser-mode")!);
      if (args.values.get("cdp")) childArgs.push("--cdp", args.values.get("cdp")!);
      if (args.values.get("user-data-dir")) childArgs.push("--user-data-dir", args.values.get("user-data-dir")!);
      if (args.values.get("browser-profile-directory")) {
        childArgs.push("--browser-profile-directory", args.values.get("browser-profile-directory")!);
      }
      if (args.values.get("browser-executable")) {
        childArgs.push("--browser-executable", args.values.get("browser-executable")!);
      }

      const command = commandText(process.execPath, childArgs);
      await setScrapeRunCommand(handle.db, runId, command);
      await writeRunLog(handle.db, {
        runId,
        level: "info",
        step: "platform_start",
        message: `开始执行 ${definition.name} 抓取`,
        context: {
          platform: definition.code,
          command,
          taskDateKey: window.taskDateKey,
          accountType,
        },
      });

      const started = Date.now();
      const child = spawn(process.execPath, childArgs, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SCRAPE_LOCAL_FILES: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });

      const stdoutBuffer = { value: "" };
      const stderrBuffer = { value: "" };
      const pendingLogs: Promise<void>[] = [];
      const pushLog = (level: "info" | "error", step: string, line: string) => {
        pendingLogs.push(writeRunLog(handle.db, {
          runId,
          level,
          step,
          message: line,
          context: { platform: definition.code },
        }));
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        appendLineBuffer(stdoutBuffer, chunk, (line) => pushLog("info", "stdout", line));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        appendLineBuffer(stderrBuffer, chunk, (line) => pushLog("error", "stderr", line));
      });

      let timedOut = false;
      const timer = platformTimeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            void killProcessTree(child);
          }, platformTimeoutMs)
        : null;

      const result = await waitForClose(child);
      if (timer) clearTimeout(timer);

      if (stdoutBuffer.value.trim()) pushLog("info", "stdout", stdoutBuffer.value.trim());
      if (stderrBuffer.value.trim()) pushLog("error", "stderr", stderrBuffer.value.trim());
      await Promise.all(pendingLogs);

      const status = await finalizeRunFromAccounts(handle.db, {
        runId,
        exitCode: result.exitCode,
        timedOut,
        errorMessage: timedOut
          ? `${definition.name} 抓取超时（${platformTimeoutMs}ms）`
          : result.error
            ? `${definition.name} 子进程启动失败：${result.error.message}`
            : `${definition.name} 抓取失败，退出码：${result.exitCode}`,
      });

      await writeRunLog(handle.db, {
        runId,
        level: status === "success" ? "info" : "error",
        step: "platform_finish",
        message: `${definition.name} 抓取结束：${status}`,
        errorCode: status === "success" ? null : "PLATFORM_NOT_SUCCESS",
        context: {
          platform: definition.code,
          exitCode: result.exitCode,
          timedOut,
          status,
          durationMs: Date.now() - started,
        },
      });

      console.log(`${definition.name} 抓取结束：${status}`);
      if (status !== "success") failed += 1;
    }
  } finally {
    await handle.close();
  }

  if (failed) {
    throw new Error(`每日抓取完成，但有 ${failed} 个平台未成功`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
