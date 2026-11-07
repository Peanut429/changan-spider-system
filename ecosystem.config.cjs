/**
 * PM2 配置：长安 RPA（TanStack Start Web + 爬虫 worker）
 *
 * 常用命令（在仓库根目录执行）：
 *   pm2 start ecosystem.config.cjs                     # 启动 web（worker 是 autostart:false，不会自动起）
 *   pm2 start ecosystem.config.cjs --only changan-worker
 *   pm2 reload ecosystem.config.cjs --update-env       # 改完 .env 或配置后重载
 *   pm2 save                                           # 保存进程列表，配合 pm2 startup 开机自启
 *
 * 为什么要在配置里自己解析 .env：
 *   Nitro 的 node-server 产物在运行时不会加载 .env（构建时才会），
 *   PM2 也不会自动读取 .env，所以这里把 apps/web/.env 和 apps/crawler/.env
 *   读出来注入到进程环境里。这样既保留 README 里“每个 app 一个 .env”的约定，
 *   又不需要把数据库密码写进本文件。
 *
 * 注意：本文件必须是 .cjs，根 package.json 是 "type": "module"，
 * 用 .js 会被当作 ESM 而导致 PM2 的 require 失败。
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;

/** 解析 KEY=VALUE 形式的 .env，支持 export 前缀、引号、行尾注释 */
function readEnvFile(file) {
  const result = {};
  if (!fs.existsSync(file)) return result;

  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      const commentAt = value.indexOf(" #");
      if (commentAt >= 0) value = value.slice(0, commentAt).trim();
    }

    result[key] = value;
  }

  return result;
}

const webEnv = readEnvFile(path.join(ROOT, "apps/web/.env"));
const workerEnv = readEnvFile(path.join(ROOT, "apps/crawler/.env"));

module.exports = {
  apps: [
    {
      name: "changan-web",
      cwd: path.join(ROOT, "apps/web"),
      // vite build 产物：Nitro node-server，监听 PORT，默认 3000
      script: ".output/server/index.mjs",
      exec_mode: "cluster",
      instances: 2,
      autorestart: true,
      // 单个实例内存超限自动重启；SSR 有内存泄漏时兜底
      max_memory_restart: "768M",
      // 给 pm2 reload 留出正在处理的请求时间
      kill_timeout: 10000,
      listen_timeout: 10000,
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 2000,
      merge_logs: true,
      time: true,
      env: {
        ...webEnv,
        NODE_ENV: "production",
        // 只监听回环地址，外部流量统一走 nginx
        HOST: webEnv.HOST || "127.0.0.1",
        PORT: webEnv.PORT || 3000,
      },
    },
    {
      name: "changan-worker",
      cwd: path.join(ROOT, "apps/crawler"),
      // Node 24 直接跑 TS：node --experimental-strip-types src/main/worker.ts
      script: "src/main/worker.ts",
      // 固定用“执行 pm2 的同一个 node”，避免 nvm 多版本时 pm2 守护进程用到旧 node
      interpreter: process.execPath,
      node_args: "--experimental-strip-types",
      exec_mode: "fork",
      instances: 1, // 同一个 Chrome profile 只能有一个 worker，别开多实例
      // 需要爬虫时手动 pm2 start ecosystem.config.cjs --only changan-worker
      autostart: false,
      autorestart: true,
      max_memory_restart: "2G",
      kill_timeout: 15000,
      min_uptime: "30s",
      max_restarts: 10,
      restart_delay: 5000,
      merge_logs: true,
      time: true,
      env: {
        ...workerEnv,
        NODE_ENV: "production",
        // 有头浏览器（headless:false）需要虚拟显示，见 DEPLOY.md 的 Xvfb 一节
        ...(workerEnv.DISPLAY ? { DISPLAY: workerEnv.DISPLAY } : {}),
      },
    },
  ],
};
