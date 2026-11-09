#!/usr/bin/env node
/**
 * TikTok HTTP 方式可行性测试 —— 只回答一个问题：能不能用 HTTP 拿数据。
 *
 * 用法：
 *   node tiktok-test.mjs https://www.tiktok.com/@xxx
 *   node tiktok-test.mjs https://www.tiktok.com/@xxx --proxy http://127.0.0.1:7890
 *
 * 不需要任何环境变量、不需要 profile、不需要数据库。
 * 依赖：playwright（跑 worker 的机器上已经有了）、Chrome、curl。
 * 可选：python + curl_cffi（做 Chrome TLS 重放，没有会提示装一条命令）
 */

import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const url = (process.argv[2] || "").trim();
const proxyArg = process.argv.indexOf("--proxy");
const proxy = proxyArg > 0 ? (process.argv[proxyArg + 1] || "").trim() : "";

if (!/^https?:\/\//.test(url)) {
  console.log("用法: node tiktok-test.mjs https://www.tiktok.com/@xxx [--proxy http://127.0.0.1:7890]");
  process.exit(1);
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function findChrome() {
  const list =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"];
  for (const p of list) if (fs.existsSync(p)) return p;
  return "";
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "buffer", timeout: 60000 });
  return {
    ok: !r.error && r.status === 0,
    out: r.stdout ? r.stdout.toString("utf8") : "",
    err: r.stderr ? r.stderr.toString("utf8") : "",
    error: r.error ? String(r.error.message || r.error) : "",
  };
}

function findPython() {
  for (const py of ["py", "python", "python3"]) {
    const r = run(py, ["-c", "import curl_cffi;print(curl_cffi.__version__)"]);
    if (r.ok && r.out.trim()) return { py, ver: r.out.trim() };
  }
  return null;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tiktok-test-"));

function replay(url, cookies, python) {
  // 1) 普通 curl
  const jar = new Map();
  for (const c of cookies) if (!jar.has(c.name)) jar.set(c.name, c.value);
  const cookieHeader = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const plain = run("curl", [
    "-sS", "--compressed", "-o", path.join(tmp, "body"), "-w", "%{http_code}", "--max-time", "30",
    "-H", `user-agent: ${UA}`, "-H", "accept: application/json, text/plain, */*",
    "-H", `referer: ${url}`, "-H", `cookie: ${cookieHeader}`, url,
  ]);
  const plainBytes = (() => { try { return fs.statSync(path.join(tmp, "body")).size; } catch { return -1; } })();

  // 2) Chrome TLS
  let tlsBytes = null;
  if (python) {
    const script = path.join(tmp, "r.py");
    fs.writeFileSync(
      script,
      `import sys, json, time
from curl_cffi import requests
url, cookie, proxy, ua = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
kw = {"headers": {"accept": "application/json, text/plain, */*", "referer": "https://www.tiktok.com/", "user-agent": ua},
      "cookies": {}, "impersonate": "chrome", "timeout": 30}
if proxy: kw["proxy"] = proxy
for p in cookie.split("; "):
    if "=" in p:
        k, v = p.split("=", 1); kw["cookies"][k] = v
last = ""
for i in range(3):
    try:
        r = requests.get(url, **kw)
        print(json.dumps({"bytes": len(r.content), "orcas": r.headers.get("tt_orcas_res")}))
        break
    except Exception as e:
        last = str(e).replace(chr(10), " ")[:120]
        time.sleep(1.5)
else:
    print(json.dumps({"error": last}))
`,
    );
    const r = run(python.py, [script, url, cookieHeader, proxy, UA]);
    try { tlsBytes = JSON.parse(r.out.trim()); } catch { tlsBytes = { error: r.err.slice(0, 120) }; }
  }
  return { plainBytes, tls: tlsBytes };
}

(async () => {
  const chrome = findChrome();
  log(`浏览器: ${chrome || "Playwright 自带 chromium"}`);
  log(`打开: ${url}`);
  if (proxy) log(`代理: ${proxy}`);
  log("");

  const browser = await chromium.launch({
    headless: false,
    ...(chrome ? { executablePath: chrome } : { channel: "chrome" }),
    ...(proxy ? { proxy: { server: proxy } } : {}),
    args: ["--disable-blink-features=AutomationControlled", "--window-size=1280,800"],
  }).catch((e) => {
    log(`Chrome 起不来: ${e.message.split("\n")[0]}`);
    process.exit(1);
  });

  const ctx = await browser.newContext({
    userAgent: UA,
    locale: "en-US",
    timezoneId: "Asia/Shanghai",
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();

  const calls = [];
  let gotData = false;
  const hit = new Promise((resolve) => {
    page.on("response", async (r) => {
      if (!r.url().includes("/api/post/item_list/")) return;
      let bytes = -1;
      try { bytes = (await r.body()).length; } catch {}
      calls.push({ url: r.url(), bytes, orcas: r.headers()["tt-orcas-res"] || null });
      if (bytes > 1000 && !gotData) { gotData = true; resolve(); }
    });
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await Promise.race([hit, sleep(30000)]);
  if (!gotData) await sleep(4000); // 页面可能连发几个请求，给后面的留点时间

  const captured =
    calls.filter((c) => c.bytes > 1000).sort((a, b) => b.bytes - a.bytes)[0] ||
    calls.sort((a, b) => b.bytes - a.bytes)[0] ||
    null;

  const blocked = await page
    .evaluate(() => {
      const t = document.body?.innerText || "";
      const cap = document.querySelector(".captcha-verify-container, #captcha_close_button");
      return { captcha: !!cap, waf: /Please wait/i.test(t), text: t.replace(/\s+/g, " ").slice(0, 80) };
    })
    .catch(() => ({ captcha: false, waf: false, text: "" }));

  const cookies = await ctx.cookies();
  await browser.close();

  if (!captured) {
    log(blocked.captcha ? "浏览器: 弹人机验证了" : blocked.waf ? "浏览器: 卡在 WAF 页" : "浏览器: 没等到数据请求");
    log(`页面: ${blocked.text}`);
    log("");
    log("结论: 这台机器连浏览器都拿不到数据，HTTP 方式无从谈起。先解决出口 IP / 浏览器环境。");
    process.exit(2);
  }

  const browserOk = captured.bytes > 1000;
  log(`浏览器拿数据: ${captured.bytes} 字节 ${browserOk ? "OK" : `失败 ${captured.orcas ? "(orcas=" + captured.orcas + ")" : ""}`}`);
  if (!browserOk) {
    log("");
    log("结论: 浏览器自己都被 gate（200 但 0 字节），这台机器现在拿不到数据，HTTP 也拿不到。");
    process.exit(2);
  }

  const python = findPython();
  const r = replay(captured.url, cookies, python);

  log("");
  log("用同一个请求换 HTTP 客户端重放：");
  log(`  普通 curl:      ${r.plainBytes} 字节 ${r.plainBytes > 1000 ? "OK" : "失败"}`);
  if (!python) {
    log("  Chrome TLS:     跳过（没装 curl_cffi）");
  } else if (r.tls?.error) {
    log(`  Chrome TLS:     失败 ${r.tls.error}`);
  } else {
    log(`  Chrome TLS:     ${r.tls.bytes} 字节 ${r.tls.bytes > 1000 ? "OK" : `失败${r.tls.orcas ? " (orcas=" + r.tls.orcas + ")" : ""}`}`);
  }

  log("");
  if (r.plainBytes > 1000) {
    log("结论: 行。普通 HTTP 就能拿数据，不用浏览器。");
  } else if (r.tls && r.tls.bytes > 1000) {
    log("结论: 行，但 HTTP 客户端必须是 Chrome TLS（curl_cffi）。");
    log("     做法：浏览器只负责出签名，数据用 curl_cffi 拉。");
  } else if (!python) {
    log("结论: 还差最后一步。先装 curl_cffi 再跑一次本脚本：");
    log("     py -m pip install curl_cffi");
    log("     （装完直接重跑同一条命令，不用改任何东西）");
  } else {
    log("结论: 不行。浏览器能拿数据，但换 HTTP 客户端就被 gate。");
    log("     说明请求和浏览器会话绑得太死，纯 HTTP 这条路成本很高。");
  }
  process.exit(0);
})();
