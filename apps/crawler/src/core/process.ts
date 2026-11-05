import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";

/**
 * 杀掉子进程及其派生进程。
 *
 * Windows 下 Node 的 child.kill() 只杀直接子进程，Playwright 启动的 Chrome 会残留并锁住 profile，
 * 所以必须用 taskkill /T。非 Windows 下如果子进程是 detached 启动的，按进程组杀。
 */
export async function killProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => resolve());
    });
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}
