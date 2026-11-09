#!/usr/bin/env node
/**
 * TikTok 抓取链路诊断探针（只读，不写业务数据）
 *
 * 目的：把「人机验证」拆成四层分别测，定位到底是 IP、指纹、WAF 还是 TLS 的问题。
 *
 *   1) 出口信息      —— 当前出口 IP / 地区 / ASN（多台服务器对比用）
 *   2) 纯 HTTP 层    —— 不启动浏览器，看能不能过 WAF、能不能拿到游客 cookie
 *   3) 浏览器层      —— 真实 Chrome 打开主页，看是正常页、WAF 页还是人机验证
 *   4) 重放层        —— 用浏览器签好的 URL，分别用「普通 curl」和「Chrome TLS」重放
 *
 * 全程约 5~8 个请求，刻意压得很低，避免把出口 IP 打进冷却。
 *
 * 用法：
 *   node tiktok-probe.mjs --handle tiktok
 *   node tiktok-probe.mjs --handle tiktok --proxy http://127.0.0.1:7890
 *   node tiktok-probe.mjs --handle tiktok --profile "/path/to/chrome-profile"   # 用线上那个暖 profile
 *   node tiktok-probe.mjs --handle tiktok --headless                            # 对比 headless
 *
 * 依赖：Node >= 20、playwright、curl；可选 python3 + curl_cffi（做 TLS 对比）
 *
 * Linux 服务器没有桌面时，不要直接 --headless（headless 本身会带指纹特征）：
 *   xvfb-run -a node tiktok-probe.mjs --handle tiktok
 *
 * 建议的三组对比（每组都跑一遍，把 --json 产物发回来）：
 *   A. 好服务器 / 坏服务器，同一份参数
 *   B. 同一台坏服务器：默认（全新 profile）vs --profile 线上暖 profile
 *   C. 同一台坏服务器：默认（有头）vs --headless
 */

import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------- 参数 ----------

function parseArgs(argv) {
  const out = {
    handle: "tiktok",
    proxy: process.env.TIKTOK_PROBE_PROXY || "",
    profile: "",
    profileDirectory: "",
    headless: process.env.TIKTOK_PROBE_HEADLESS === "1",
    executable: process.env.SOCIAL_BROWSER_EXECUTABLE || "",
    python: process.env.TIKTOK_PROBE_PYTHON || "",
    json: "",
    screenshot: "",
    pauseMs: 1500,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--handle") out.handle = String(next() || "").replace(/^@/, "");
    else if (a === "--proxy") out.proxy = next() || "";
    else if (a === "--profile") out.profile = next() || "";
    else if (a === "--profile-directory") out.profileDirectory = next() || "";
    else if (a === "--headless") out.headless = true;
    else if (a === "--headful") out.headless = false;
    else if (a === "--executable") out.executable = next() || "";
    else if (a === "--python") out.python = next() || "";
    else if (a === "--json") out.json = next() || "";
    else if (a === "--pause") out.pauseMs = Math.max(0, Number(next()) || 0);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
args.executable = detectChrome(args.executable);

if (!run("curl", ["--version"]).ok) {
  console.log("[FATAL] 找不到 curl。Windows 10 1803+ 自带 C:\\Windows\\System32\\curl.exe，请确认它在 PATH 里。");
  process.exit(1);
}
if (args.help) {
  console.log(`TikTok 抓取链路诊断探针

用法：
  node tiktok-probe.mjs --handle tiktok [选项]

选项：
  --handle <name>       要探测的账号，默认 tiktok
  --proxy <url>         代理，例如 http://127.0.0.1:7890
  --profile <dir>       使用持久化 Chrome profile（测线上暖 profile）
  --profile-directory <name>  配合 --profile，例如 "Profile 3"
  --headless            用 headless 跑浏览器（默认有头）
  --executable <path>   指定 Chrome 路径（默认自动找系统 Chrome）
  --python <path>       指定装了 curl_cffi 的 python
  --json <path>         报告输出路径
  --pause <ms>          阶段之间的间隔，默认 1500
  -h, --help            显示本帮助

Linux 无桌面时建议：xvfb-run -a node tiktok-probe.mjs --handle tiktok`);
  process.exit(0);
}

// Linux 上没有 DISPLAY 时，有头 Chrome 起不来，自动降级并大声提示
if (process.platform === "linux" && !process.env.DISPLAY && !args.headless) {
  console.log("[WARN] 当前没有 DISPLAY，自动切到 --headless。");
  console.log("[WARN] 注意：headless 的签名会带指纹特征，可能直接影响 API 结果，结论要打折看。");
  args.headless = true;
}

// ---------- 小工具 ----------

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};
const hasColor = process.stdout.isTTY;
function paint(color, text) { return hasColor ? `${C[color]}${text}${C.reset}` : text; }
function section(title) { console.log(`\n${paint("bold", "=== " + title + " ===")}`); }
function line(label, value) { console.log(`  ${String(label).padEnd(26)} ${value}`); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tiktok-probe-"));

function run(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, { encoding: "buffer", timeout: opts.timeout || 45000 });
  return {
    ok: !res.error && res.status === 0,
    status: res.status,
    stdout: res.stdout ? res.stdout.toString("utf8") : "",
    stderr: res.stderr ? res.stderr.toString("utf8") : "",
    error: res.error ? String(res.error.message || res.error) : "",
  };
}

function detectChrome(explicit) {
  if (explicit) return explicit;
  if (process.env.SOCIAL_BROWSER_EXECUTABLE) return process.env.SOCIAL_BROWSER_EXECUTABLE;
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
      : process.platform === "win32"
        ? [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  const which = spawnSync("which", ["google-chrome"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  return "";
}

/** 用 curl 发一个请求，刻意不用 Node 自带 TLS —— 这就是「最朴素的纯 HTTP 客户端」 */
function curlFetch(url, { headers = {}, cookie = "", proxy = args.proxy, follow = true } = {}) {
  const tag = Math.random().toString(36).slice(2, 8);
  const bodyFile = path.join(tmpRoot, `body-${tag}`);
  const headFile = path.join(tmpRoot, `head-${tag}`);
  const cmdArgs = ["-sS", "--compressed", "-D", headFile, "-o", bodyFile, "-w", "%{http_code}", "--max-time", "30"];
  if (follow) cmdArgs.push("-L");
  if (proxy) cmdArgs.push("--proxy", proxy);
  cmdArgs.push("-H", `user-agent: ${UA}`, "-H", "accept-language: en-US,en;q=0.9");
  if (headers.accept) cmdArgs.push("-H", `accept: ${headers.accept}`);
  if (headers.referer) cmdArgs.push("-H", `referer: ${headers.referer}`);
  if (cookie) cmdArgs.push("-H", `cookie: ${cookie}`);
  cmdArgs.push(url);

  const r = run("curl", cmdArgs);
  let body = Buffer.alloc(0);
  let rawHead = "";
  try { body = fs.readFileSync(bodyFile); } catch {}
  try { rawHead = fs.readFileSync(headFile, "utf8"); } catch {}
  fs.rmSync(bodyFile, { force: true });
  fs.rmSync(headFile, { force: true });

  const status = Number.parseInt(r.stdout.trim(), 10) || 0;
  const headerBlocks = rawHead.split(/\r?\n\r?\n/).filter((b) => /^HTTP\//i.test(b.trim()));
  const lastBlock = headerBlocks.length ? headerBlocks[headerBlocks.length - 1] : "";
  const setCookies = [];
  const cookieValues = {};
  for (const l of lastBlock.split(/\r?\n/)) {
    const m = /^set-cookie:\s*([^=;\s]+)=([^;]*)/i.exec(l.trim());
    if (m) {
      setCookies.push(m[1].trim());
      if (m[2]) cookieValues[m[1].trim()] = m[2].trim();
    }
  }
  const orcas = /^tt[-_]orcas[-_]res:\s*(\S+)/im.exec(lastBlock)?.[1] || null;
  return { status, bytes: body.length, body, setCookies, cookieValues, orcas, err: r.ok ? "" : r.stderr.trim() };
}

function classifyHtml(r) {
  const text = r.body.toString("utf8");
  if (!r.status) return { kind: "error", note: r.err || "no status" };
  if (r.status === 403 && r.body.length === 0) return { kind: "blocked", note: "403 空响应（WAF token 通常没被接受，多半是 IP 已进冷却）" };
  if (r.body.length === 0) return { kind: "blocked", note: `${r.status} 空响应` };
  if (/id="wci"/.test(text) || /SlardarWAF/.test(text)) {
    return {
      kind: "waf",
      note: `${r.body.length} 字节 WAF 挑战页`,
      wci: /<p id="wci" class="([^"]*)"/.exec(text)?.[1] || "",
      cs: /<p id="cs" class="([^"]*)"/.exec(text)?.[1] || "",
      rci: /<p id="rci" class="([^"]*)"/.exec(text)?.[1] || "",
    };
  }
  if (text.includes("__UNIVERSAL_DATA_FOR_REHYDRATION__")) {
    let stats = null;
    let itemListLen = -1;
    let secUid = "";
    try {
      const m = /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/.exec(text);
      const data = JSON.parse(m[1]);
      const ud = data?.__DEFAULT_SCOPE__?.["webapp.user-detail"];
      stats = ud?.userInfo?.stats || null;
      itemListLen = Array.isArray(ud?.itemList) ? ud.itemList.length : -1;
      secUid = ud?.userInfo?.user?.secUid || "";
    } catch {}
    return { kind: "ok", note: `${r.body.length} 字节正常页`, stats, itemListLen, secUid };
  }
  return { kind: "unknown", note: `${r.body.length} 字节，${r.status}` };
}

function cookiesToHeader(cookies) {
  // Chrome 会同时带 .tiktok.com 和 www.tiktok.com；同名时后写的生效，和浏览器一致
  const order = [".tiktok.com", "www.tiktok.com", ".www.tiktok.com"];
  const sorted = [...cookies].sort((a, b) => {
    const ai = order.indexOf(a.domain); const bi = order.indexOf(b.domain);
    return (ai < 0 ? 9 : ai) - (bi < 0 ? 9 : bi);
  });
  const jar = new Map();
  for (const c of sorted) {
    if (!String(c.domain).replace(/^\./, "").endsWith("tiktok.com")) continue;
    jar.set(c.name, c.value);
  }
  return { header: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), names: [...jar.keys()] };
}

// ---------- 1. 出口信息 ----------

async function probeEgress() {
  section("1. 出口信息");
  const out = { ip: "", country: "", region: "", org: "", raw: null };
  for (const url of ["https://ipinfo.io/json", "https://ipwho.is/", "https://api.ipify.org?format=json"]) {
    const r = curlFetch(url, { headers: { accept: "application/json" } });
    if (r.status !== 200 || !r.body.length) continue;
    try {
      const j = JSON.parse(r.body.toString("utf8"));
      out.ip = j.ip || out.ip;
      out.country = j.country || j.country_code || out.country;
      out.region = j.region || out.region;
      out.org = j.org || j.connection?.org || j.isp || out.org;
      out.raw = j;
      if (out.ip) break;
    } catch {}
  }
  line("出口 IP", out.ip || paint("red", "获取失败"));
  line("国家 / 地区", `${out.country || "-"} / ${out.region || "-"}`);
  line("ASN / 运营商", out.org || "-");
  line("代理", args.proxy || "(直连)");
  return out;
}

// ---------- 2. 纯 HTTP 层 ----------

async function probeHttp(handle) {
  section("2. 纯 HTTP 层（不启动浏览器）");
  const url = `https://www.tiktok.com/@${handle}`;
  const result = { url, first: null, solved: null, cookies: {}, api: null };

  const first = curlFetch(url, { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" }, follow: false });
  const c1 = classifyHtml(first);
  result.first = { kind: c1.kind, note: c1.note, status: first.status, bytes: first.bytes };
  line("GET /@handle", `${first.status} · ${c1.note}`);

  if (c1.kind === "waf") {
    line("WAF cookie 名", c1.wci || "(没解析到)");
    if (c1.wci && c1.cs) {
      await sleep(args.pauseMs);
      const cookie = `${c1.wci}=${c1.cs}` + (c1.rci ? `; ${c1.rci}=` : "");
      const second = curlFetch(url, { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" }, cookie, follow: false });
      const c2 = classifyHtml(second);
      result.solved = { kind: c2.kind, note: c2.note, status: second.status, bytes: second.bytes, setCookies: second.setCookies, secUid: c2.secUid || "" };
      line("带上 WAF cookie 重试", `${second.status} · ${c2.note}`);
      line("下发的 cookie", second.setCookies.join(", ") || "(无)");
      if (c2.kind === "ok") {
        line("页面统计", c2.stats ? `粉丝 ${c2.stats.followerCount} / 作品 ${c2.stats.videoCount}` : "解析失败");
        line("HTML 内 itemList", c2.itemListLen >= 0 ? `${c2.itemListLen} 条` : "无（作品走 XHR）");
        Object.assign(result.cookies, second.cookieValues);
      }
    }
  } else if (c1.kind === "ok") {
    line("页面统计", c1.stats ? `粉丝 ${c1.stats.followerCount} / 作品 ${c1.stats.videoCount}` : "解析失败");
  }

  // 用纯 HTTP 拿到的 cookie 直接打 API（不带签名）
  const cookieHeader = Object.entries(result.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  if (cookieHeader) {
    await sleep(args.pauseMs);
    const secUid = result.solved?.secUid || "";
    const api =
      "https://www.tiktok.com/api/post/item_list/?aid=1988&count=10&cursor=0" +
      `&secUid=${encodeURIComponent(secUid)}&device_platform=web_pc&region=US&app_language=en&app_name=tiktok_web` +
      "&channel=tiktok_web&os=mac&cookie_enabled=true";
    const r = curlFetch(api, { headers: { accept: "application/json", referer: url }, cookie: cookieHeader });
    result.api = { status: r.status, bytes: r.bytes, orcas: r.orcas };
    line("API（无签名 + 纯 HTTP）", `${r.status} · ${r.bytes} 字节${r.orcas ? ` · orcas=${r.orcas}` : ""}`);
    if (r.bytes === 0) line("", paint("yellow", "→ 0 字节就是被 gate，不是网络问题"));
  } else {
    line("API", paint("yellow", "没拿到 cookie，跳过"));
  }

  return result;
}

// ---------- 3. 浏览器层 ----------

async function probeBrowser(handle) {
  section("3. 浏览器层");
  line("模式", args.headless ? "headless" : "有头");
  line("Chrome", args.executable || "channel: chrome");
  line("profile", args.profile ? `${args.profile}${args.profileDirectory ? " / " + args.profileDirectory : ""}` : "(全新临时 profile)");

  const launchOptions = {
    headless: args.headless,
    proxy: args.proxy ? { server: args.proxy } : undefined,
    args: ["--disable-blink-features=AutomationControlled", "--window-position=-3000,-3000", "--window-size=1280,800"],
  };
  if (args.profileDirectory) launchOptions.args.push(`--profile-directory=${args.profileDirectory}`);
  if (args.executable) launchOptions.executablePath = args.executable;
  else launchOptions.channel = "chrome";

  const contextOptions = {
    userAgent: UA,
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    viewport: { width: 1280, height: 800 },
  };

  let browser = null;
  let context = null;
  const started = Date.now();
  async function launch(options) {
    if (args.profile) {
      context = await chromium.launchPersistentContext(args.profile, { ...options, ...contextOptions });
    } else {
      browser = await chromium.launch(options);
      context = await browser.newContext(contextOptions);
    }
  }
  try {
    await launch(launchOptions);
  } catch (e) {
    // 没装系统 Chrome 时，退回 Playwright 自带 chromium（可用但更容易被识别）
    if (!args.executable) {
      console.log(paint("yellow", "  系统 Chrome 没起来，退回 Playwright 自带 chromium（指纹更差，结果要打折看）"));
      const fallback = { ...launchOptions };
      delete fallback.channel;
      try {
        await launch(fallback);
      } catch (e2) {
        console.log(paint("red", `  Chrome 启动失败：${e2.message.split("\n")[0]}`));
        return { ok: false, error: e2.message };
      }
    } else {
      console.log(paint("red", `  Chrome 启动失败：${e.message.split("\n")[0]}`));
      return { ok: false, error: e.message };
    }
  }

  const page = await context.newPage();
  const apiCalls = [];
  page.on("response", (resp) => {
    if (!resp.url().includes("/api/post/item_list/")) return;
    const rec = { url: resp.url(), status: resp.status(), bytes: -1, orcas: null };
    const h = resp.headers();
    rec.orcas = h["tt-orcas-res"] || h["tt_orcas_res"] || null;
    apiCalls.push(rec);
    resp.body().then((b) => { rec.bytes = b.length; }).catch(() => {});
  });

  const url = `https://www.tiktok.com/@${handle}`;
  let navError = "";
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => { navError = e.message; });

  await page
    .waitForFunction(
      () => {
        const t = document.body?.innerText || "";
        return (
          !!document.querySelector('a[href*="/video/"]') ||
          !!document.querySelector("#captcha_close_button, .captcha-verify-container, #captcha-verify-container-main-page") ||
          /Please wait/i.test(t)
        );
      },
      null,
      { timeout: 25000 },
    )
    .catch(() => {});
  await sleep(6000); // 给 XHR 一点时间

  const state = await page.evaluate(() => {
    const vis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const capModal = document.querySelector("#captcha_close_button, .captcha-verify-container, #captcha-verify-container-main-page");
    const iframes = [...document.querySelectorAll("iframe")]
      .map((i) => i.getAttribute("src") || "")
      .filter((s) => /captcha|verify|arkose|hcaptcha|challenge|secsdk/i.test(s));
    const text = (document.body?.innerText || "").slice(0, 400);
    const hasUniversal = !!document.querySelector('script#__UNIVERSAL_DATA_FOR_REHYDRATION__');
    const stats = (() => {
      try {
        const el = document.querySelector("script#__UNIVERSAL_DATA_FOR_REHYDRATION__");
        const d = JSON.parse(el.textContent);
        const ud = d?.__DEFAULT_SCOPE__?.["webapp.user-detail"];
        return { stats: ud?.userInfo?.stats || null, itemListLen: Array.isArray(ud?.itemList) ? ud.itemList.length : -1 };
      } catch { return { stats: null, itemListLen: -1 }; }
    })();
    return {
      title: document.title,
      url: location.href,
      captcha: capModal ? vis(capModal) : false,
      captchaText: /verification|verify to continue|not a robot|安全验证|人机验证|拖动|滑块/i.test(text),
      iframes,
      hasUniversal,
      waf: /Please wait/i.test(text),
      text,
      ...stats,
    };
  });

  const fingerprint = await page
    .evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl");
      const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
      return {
        webglVendor: dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : "",
        webglRenderer: dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "",
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory ?? null,
        platform: navigator.platform,
        languages: (navigator.languages || []).join(","),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        screen: `${screen.width}x${screen.height}`,
        webdriver: navigator.webdriver,
      };
    })
    .catch(() => null);

  const kind = state.captcha || state.captchaText ? "captcha" : state.waf ? "waf" : state.hasUniversal ? "ok" : "unknown";
  line("页面判定", `${kind} · ${state.title || "(无标题)"}`);
  if (state.captcha || state.captchaText) line("验证弹窗", paint("red", "出现了人机验证"));
  if (state.iframes.length) line("验证 iframe", state.iframes.map((s) => s.slice(0, 80)).join(" | "));
  if (state.waf) line("", paint("red", "还是 Slardar WAF 的 Please wait 页"));
  if (state.stats) line("页面统计", `粉丝 ${state.stats.followerCount} / 作品 ${state.stats.videoCount}`);
  line("HTML 内 itemList", state.itemListLen >= 0 ? `${state.itemListLen} 条` : "无（作品走 XHR）");
  if (fingerprint) {
    line("WebGL 渲染器", fingerprint.webglRenderer || "(空)");
    line("CPU / 内存", `${fingerprint.hardwareConcurrency ?? "?"} 核 / ${fingerprint.deviceMemory ?? "?"} GB`);
    line("时区 / 语言", `${fingerprint.timezone} / ${fingerprint.languages}`);
    line("屏幕 / webdriver", `${fingerprint.screen} / ${fingerprint.webdriver}`);
  }
  line("页面片段", JSON.stringify(state.text.replace(/\s+/g, " ").slice(0, 100)));

  const shot = args.screenshot || path.join(os.tmpdir(), `tiktok-probe-${Date.now()}.png`);
  await page.screenshot({ path: shot }).catch(() => {});
  line("截图", shot);

  await sleep(1000);
  for (const c of apiCalls) line("XHR item_list", `${c.status} · ${c.bytes} 字节${c.orcas ? ` · orcas=${c.orcas}` : ""}`);

  const cookies = await context.cookies();
  const { header, names } = cookiesToHeader(cookies);
  line("cookie 数量", `${names.length} 个（${names.slice(0, 12).join(", ")}）`);

  const signed = [...apiCalls].reverse().find((c) => c.bytes > 1000) || apiCalls[0] || null;

  if (browser) await browser.close();
  else await context.close();

  return {
    ok: true,
    kind,
    headless: args.headless,
    elapsedMs: Date.now() - started,
    navError,
    state,
    fingerprint,
    apiCalls,
    signed,
    cookies: { header, names },
    screenshot: shot,
  };
}

// ---------- 4. 重放层 ----------

function replayWithChromeTls(python, url, cookieHeader) {
  const py = path.join(tmpRoot, "replay.py");
  fs.writeFileSync(
    py,
    `import sys, json, time
from curl_cffi import requests
url, cookie, proxy, ua = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
h = {"accept": "application/json, text/plain, */*", "referer": "https://www.tiktok.com/", "user-agent": ua}
kw = {"headers": h, "cookies": {}, "impersonate": "chrome", "timeout": 30}
if proxy: kw["proxy"] = proxy
for part in cookie.split("; "):
    if "=" in part:
        k, v = part.split("=", 1); kw["cookies"][k] = v
last = ""
for i in range(3):
    try:
        r = requests.get(url, **kw)
        print(json.dumps({"status": r.status_code, "bytes": len(r.content), "orcas": r.headers.get("tt_orcas_res")}))
        break
    except Exception as e:
        last = str(e).replace(chr(10), " ")[:160]
        time.sleep(1.5)
else:
    print(json.dumps({"error": "TLS 连接被重置（数据中心 IP 常见，重试 3 次仍失败）：" + last}))
`,
  );
  const r = run(python, [py, url, cookieHeader, args.proxy || "", UA], { timeout: 60000 });
  if (!r.ok) return { ok: false, error: (r.stderr || r.error || "").split("\n").slice(-3).join(" ") };
  try { return { ok: true, ...JSON.parse(r.stdout.trim()) }; } catch (e) { return { ok: false, error: "解析失败: " + r.stdout }; }
}

function findCurlCffiPython() {
  const candidates = [
    args.python,
    process.env.VIRTUAL_ENV ? path.join(process.env.VIRTUAL_ENV, "bin", "python") : "",
    "/usr/bin/python3",
    process.platform === "win32" ? "py" : "python3",
    "python3",
    "python",
  ].filter(Boolean);
  for (const py of candidates) {
    const r = run(py, ["-c", "import curl_cffi;print(curl_cffi.__version__)"]);
    if (r.ok && r.stdout.trim()) return { python: py, version: r.stdout.trim() };
  }
  return null;
}

async function probeReplay(browserResult, handle) {
  section("4. 重放层（浏览器签名 → 纯 HTTP）");
  const out = { signedUrl: "", plain: null, chromeTls: null };
  const signed = browserResult?.signed;
  if (!signed?.url) {
    line("结果", paint("yellow", "浏览器没抓到 item_list 请求，跳过"));
    return out;
  }
  out.signedUrl = signed.url;
  const cookieHeader = browserResult.cookies.header;

  await sleep(args.pauseMs);
  const plain = curlFetch(signed.url, {
    headers: { accept: "application/json", referer: `https://www.tiktok.com/@${handle}` },
    cookie: cookieHeader,
  });
  out.plain = { status: plain.status, bytes: plain.bytes, orcas: plain.orcas };
  line("普通 curl 重放", `${plain.status} · ${plain.bytes} 字节${plain.orcas ? ` · orcas=${plain.orcas}` : ""}`);

  const py = findCurlCffiPython();
  if (!py) {
    line("Chrome TLS 重放", paint("yellow", "没找到装了 curl_cffi 的 python，跳过（pip install curl_cffi 或 --python 指定）"));
    return out;
  }
  await sleep(args.pauseMs);
  const tls = replayWithChromeTls(py.python, signed.url, cookieHeader);
  if (!tls.ok || tls.error) {
    out.chromeTls = { error: tls.error || "解析失败" };
    line("Chrome TLS 重放", paint("red", tls.error || "解析失败"));
    return out;
  }
  out.chromeTls = { status: tls.status, bytes: tls.bytes, orcas: tls.orcas };
  line("Chrome TLS 重放", `${tls.status} · ${tls.bytes} 字节${tls.orcas ? ` · orcas=${tls.orcas}` : ""}（${py.python} · curl_cffi ${py.version}）`);
  return out;
}

// ---------- 5. 判定 ----------

function verdict(report) {
  section("5. 判定");
  const b = report.browser || {};
  const replay = report.replay || {};
  const http = report.http || {};
  const captcha = b.kind === "captcha";
  const browserData = (b.apiCalls || []).some((c) => c.bytes > 1000);
  const tlsOk = (replay.chromeTls?.bytes || 0) > 1000;
  const plainOk = (replay.plain?.bytes || 0) > 1000;

  const notes = [];
  if (!b.ok) notes.push(["红", "Chrome 没起来，后面的结论都不成立，先解决浏览器环境。"]);
  else if (captcha) notes.push(["红", "浏览器直接弹人机验证 → 这台服务器（IP / 指纹 / 会话）已被判定。"]);

  if (b.kind === "waf") notes.push(["红", "浏览器里还是 Slardar WAF 的 Please wait 页 → 连 HTML 都没放行。"]);
  if (b.kind === "ok" && !browserData) notes.push(["黄", "页面正常但 API 全是 0 字节 → 风控在 XHR 层，不是页面层。"]);
  if (browserData) notes.push(["绿", "浏览器正常拿到了 item_list 数据。"]);
  if (plainOk) notes.push(["绿", "普通 curl 重放就通了 → 签名和 cookie 是唯一门槛，TLS 不是问题。"]);
  if (!plainOk && tlsOk) notes.push(["黄", "普通 curl 被 gate、Chrome TLS 通 → 卡在 TLS 指纹，不是 IP。"]);
  if (!plainOk && !tlsOk && browserData) notes.push(["黄", "两种 HTTP 重放都失败 → 签名和浏览器会话强绑定，只能就地发请求。"]);
  if (!browserData && !tlsOk && !captcha && b.kind === "ok") notes.push(["黄", "浏览器和 HTTP 都不出数据 → 该出口 IP 大概率已进冷却。"]);
  if (http.first?.kind === "waf" && http.solved?.kind === "ok") notes.push(["绿", "纯 HTTP 能过 WAF 并拿到游客 cookie。"]);
  if (http.first?.kind === "blocked") notes.push(["红", "连 HTML 都直接空响应/403 → 出口 IP 被硬拦。"]);

  if (!notes.length) notes.push(["黄", "没有明确信号，把 --json 发回来一起看。"]);
  for (const [color, text] of notes) {
    const c = color === "绿" ? "green" : color === "黄" ? "yellow" : "red";
    console.log(`  ${paint(c, "[" + color + "]")} ${text}`);
  }

  section("建议的下一步");
  if (captcha) {
    console.log("  1. 同一台机器加 --profile 指向线上那个能出数据的 profile，再跑一次：");
    console.log("     如果暖 profile 不弹验证 → 是 cookie/会话历史；还弹 → 是 IP 或机器指纹。");
    console.log("  2. 换一个出口 IP（住宅/移动）再跑，对比出口信息里的 ASN。");
    console.log("  3. 用 --headless 再跑一次，看验证是否与 headless 相关。");
  } else if (!browserData && b.kind === "ok") {
    console.log("  1. 等 10~30 分钟让出口冷却，再跑一次，确认是不是频率问题。");
    console.log("  2. 换出口 IP 再跑，若立刻出数据 → 是 IP 信誉，不是代码。");
    console.log("  3. 若换 IP 仍 0 字节，检查 region / tz 是否和出口匹配。");
  } else if (browserData) {
    console.log("  1. 这台机器基础链路是通的，可以按「浏览器出签名 + HTTP 发请求」做 POC。");
    console.log("  2. 把 --profile 换成线上 profile 再跑，确认线上那个 profile 是否拖后腿。");
  }
  console.log("  把 --json 文件发回来，我按这份数据给你定方案。");
}

// ---------- main ----------

const report = {
  startedAt: new Date().toISOString(),
  args: { handle: args.handle, headless: args.headless, profile: args.profile || null, proxy: args.proxy || null },
  node: process.version,
  platform: process.platform,
};

report.egress = await probeEgress();
await sleep(args.pauseMs);
report.http = await probeHttp(args.handle);
await sleep(args.pauseMs);
report.browser = await probeBrowser(args.handle);
await sleep(args.pauseMs);
report.replay = await probeReplay(report.browser, args.handle);
report.finishedAt = new Date().toISOString();

verdict(report);

const jsonPath = args.json || path.join(process.cwd(), `tiktok-probe-${Date.now()}.json`);
const printable = { ...report };
if (printable.browser?.cookies) printable.browser = { ...printable.browser, cookies: { count: printable.browser.cookies.names?.length || 0 } };
if (printable.http?.solved) delete printable.http.solved.body;
if (printable.replay?.signedUrl) printable.replay.signedUrl = printable.replay.signedUrl.slice(0, 120) + "…";
fs.writeFileSync(jsonPath, JSON.stringify(printable, null, 2));
console.log(`\n报告已写入：${jsonPath}`);
