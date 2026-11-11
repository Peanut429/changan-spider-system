# scrape:daily 迁移计划

> 状态：骨架阶段完成。只迁移 `scrape:daily` 的六个平台，评论、队列、定时调度、页面全部暂不做。
>
> 原则：**行为优先**。选择器、解析、翻页、字段映射、DB 表结构、`task_date_key` 计算都不改；先做到新旧一致，再做优化。
>
> 2026-11 补充：评论任务已实现（只走 TikHub 接口，支持 IG/TikTok/YouTube/X，含二级回复），
> 入口 `pnpm comment:run`，见 README 与 DEPLOY.md 9.1；每日抓取链路行为不受影响。

## 1. 已确认的决策

| 项 | 决策 |
|---|---|
| 目录 | 当前仓库子目录 `refactor-project/`，独立 `package.json` |
| 导入账号 | 新爬虫不做；过渡期继续用旧项目 `pnpm db:import-accounts` 写同一个库；页面做好后移到页面 |
| 测试库 | `changan_rpa_test`，测试 helper 校验库名，拒绝生产库 |
| 平台顺序 | 运行顺序以后由任务编排决定；迁移开发顺序按风险排，不影响最终业务顺序 |
| 浏览器 | 服务器上的真实 Chrome；Playwright 每个平台 run 启停；旧 daily 继续 CDP + profile A，新项目用 profile B |
| run 收口 | 加。平台脚本不再写 `scrape_runs.status`，daily 按 `scrape_run_accounts` 统一收口 |
| 超时 | 加。平台级默认 6 小时，账号级默认 60 分钟，可配置；账号超时会终止整个平台，避免复用卡死的页面 |
| 本地文件 | 不迁 Excel / raw.json / CSV 账号模式 |
| 评论 | 不迁。评论按内容+时间范围设计，和 run 无关；等后续需求恢复再做 |

## 2. 范围

### 迁移

| 平台 | 旧入口 | 相关文件 |
|---|---|---|
| YouTube | `src/platforms/youtube.ts` | `youtube-jsonld.ts`、`youtube-shorts.ts` |
| X | `src/platforms/x-network.ts` | — |
| Instagram | `src/platforms/instagram.ts` | `instagram-api.ts` |
| Facebook | `src/jobs/facebook-http-scrape.ts` | `facebook-ufi.ts` |
| LinkedIn | `src/platforms/linkedin-auto.ts` | `linkedin-network.ts`、`linkedin-rsc.ts`、`linkedin-rsc-parser.ts`、`linkedin-company-followers.ts` |
| TikTok | `src/platforms/tiktok.ts` | `core/tiktok-page-state.ts` |

共享：`daily-scrape.ts`、`persist-scrape-result.ts`、`repositories/scrape-runs.ts`、`core/account-source.ts`、`core/browser.ts`、`core/time.ts`、`core/db-time.ts`、`core/numbers.ts`、`core/strings.ts`、`core/id.ts`、`db/schema.ts`、`db/client.ts`、`config/env.ts`。

### 不迁移

- 本地文件/Excel：`core/excel.ts`、`core/checkpoint.ts`、`core/local-files.ts`、`core/csv.ts`
- 旧 DOM 版入口：`platforms/x.ts`、`platforms/facebook.ts`、`platforms/linkedin.ts`
- 评论：6 个 comment job、comment 平台文件、`repositories/comments.ts`
- `retry-scrape.ts`、`import-accounts.ts`、`linkedin-excerpt-fetcher.ts`
- `repositories/linkedin-organizations.ts`
- `scrape_attempts` / `alert_events`（旧项目里也没有代码使用）

## 3. 当前骨架

```text
refactor-project/
  src/
    main/daily.ts          # 编排：窗口、平台顺序、建 run、spawn、日志、收口、超时
    main/platform.ts       # 子进程入口：加载平台、账号，交给 runner
    config/                # env / args / 平台注册表 / 测试库守卫
    core/                  # time / db-time / numbers / strings / id / coerce / browser / logger / timeout / process / accounts / daily-window
    db/                    # factory / schema / repositories / persistence
    platforms/             # types / runner / fake / youtube
  db/schema.sql            # 测试库 schema（爬虫链路表）
  tests/unit
  tests/integration
```

已实现：

- 独立 package、tsconfig、typecheck
- `db/factory.ts` 依赖注入数据库（测试不再连生产）
- core/db/schema 冻结复制
- `persistScrapeAccountResult` 账号级入库（账号/内容/指标/raw/run_accounts/计数刷新）
- `runner` 通用账号循环 + 断点跳过 + 失败入库 + 浏览器开关
- `fake` 平台跑通：建 run → 账号循环 → 入库 → run 收口
- run 收口：全成功 / 部分失败 / 全失败 / 空账号 / 超时
- 平台级 + 账号级超时框架
- 测试库 schema + `TEST_DATABASE_URL` 守卫
- 单元测试 9 个、集成测试 3 个通过
- 端到端 `pnpm run scrape:daily -- --platforms fake` 通过
- YouTube 已迁入 `src/platforms/youtube/`，真实账号验证 + 旧/新 run 对比通过
- X 已迁入 `src/platforms/x/`；使用 `work/playwright-social-profile` 的 `Profile 3` 登录态完成真实内容验证（1 个账号、1 条帖子）
- Instagram 已迁入 `src/platforms/instagram/`，只走 TikHub API，不启动浏览器；真实账号验证通过
- Facebook 已迁入 `src/platforms/facebook/`，HTTP GraphQL 翻页；真实账号验证通过
- TikTok 已迁入 `src/platforms/tiktok/`，item_list 接口 + 页面状态恢复；真实账号验证通过
- LinkedIn 已迁入 `src/platforms/linkedin/`，RSC 分页；真实账号验证通过

### 2026-11-03 YouTube 真实账号验证

测试库：本机 PostgreSQL `changan_rpa_test`；窗口分别设为 2026-10-20 / 2026-10-27 到 2026-11-02。

| 账号 | run 状态 | 账号指标 | 内容 |
|---|---|---|---|
| BYD España | success | 2960 粉丝 / 336 视频 | 5 条（2 视频 + 3 Shorts），播放/点赞/评论正常 |
| Geely Auto UK | success | 1390 粉丝 / 62 视频 | 0 条（该窗口内没有新内容） |

验证通过：频道指标、视频/Shorts 列表、详情指标、`scrape_run_accounts`、`account_daily_metrics`、`content_daily_metrics`、`scrape_raw_records`、run 收口都正常。

登录态说明：从 ego 浏览器导出的 Google/YouTube cookie 注入 Playwright profile 后，`ytcfg.LOGGED_IN` 仍为 false（Google 服务端没有认可移植的登录态）。本次测试是**未登录访问公开频道**，数据抓取正常。需要登录的平台不要依赖 cookie JSON 移植，应该使用真实登录过的 Chrome profile（生产上用专用 profile B，手动登录一次）；`auth:seed` 脚本保留，但只作为普通 cookie 注入工具，Google/YouTube 可能拒绝。

### 2026-11-03 YouTube 旧/新 run 对比

同一测试库、同一窗口（2026-10-20 ~ 2026-11-02）、同一组两个账号，旧 `daily-scrape.ts` 与新 `scrape:daily` 各跑一次：

| 指标 | 旧 run | 新 run |
|---|---|---|
| run 状态 | success | success |
| 账号数 / 成功 / 失败 | 2 / 2 / 0 | 2 / 2 / 0 |
| raw 记录 | 7 | 7 |
| 账号指标 | 2 | 2 |
| 内容指标 | 5 | 5 |
| BYD 内容 | 5（2 视频 + 3 Shorts） | 5（2 视频 + 3 Shorts） |
| Geely 内容 | 0 | 0 |
| metric_day_key | 20261102 | 20261102 |

逐条对比内容字段：播放/点赞/评论基本一致，只有 1 条 Shorts 的播放/点赞因为两次抓取时间不同有极小漂移（21293/620 vs 21320/619），属于实时数据变化，不是解析差异。

### 2026-11-03 Instagram API 验证

- 账号：`byd.uk`（`links/instagram.csv`）
- 数据源：TikHub API，`requiresBrowser: false`，不启动浏览器
- 窗口：2026-10-20 ~ 2026-11-02，`--limit 2`
- 结果：run success，账号 114204 粉丝，3 条内容（1 post + 2 reel），点赞/评论/播放正常
- 说明：posts 和 reels 是两段独立列表，`--limit 2` 合计保留 3 条（各段循环结束时才检查上限），内容量很小，不影响测试。

### 2026-11-03 X 验证

- 已接入 `src/platforms/x/`，使用页面捕获的真实 GraphQL 模板按 cursor 翻页。
- 无登录运行时，能正确识别登录墙：账号标记 `LOGIN_REQUIRED`，run 收口 `failed`，没有卡死或静默跳过。
- 之前把 ego 的 X cookies 注入新 Playwright profile，X 会把会话重定向到 `/i/jf/onboarding/web?mode=login`，说明 X 不接受跨浏览器 cookie 移植。
- 改用项目里的 `work/playwright-social-profile` + `Profile 3`（真实登录过的 profile）后，X 时间线接口正常：
  - 账号：`Geely Auto UK`
  - 窗口：2026-01-01 ~ 2026-11-02，`--limit 1`
  - 结果：run success，180 粉丝 / 3 关注，1 条图片帖
  - 内容：`https://x.com/GeelyAutoUK/status/2006697143248048401`，点赞 3、评论 3、阅读 1818，发布时间 2026-01-01 20:00:56
- 先用 2026-10-20 窗口跑时是 0 条，因为该账号 2026-10-20 之后没有新帖；放宽到 2026-01-01 后拿到 1 条，说明不是抓取问题。
- `Profile 3` 同时登录了 Facebook；LinkedIn 页面也显示已登录导航（有付款提示，但登录态在）。后续 Facebook/LinkedIn 可以复用这个 profile。

### 2026-11-04 Facebook / TikTok / LinkedIn 验证

统一使用 `work/playwright-social-profile` + `Profile 3`，每个平台 1 个账号、`--limit 1`、窗口 2026-10-20 ~ 2026-11-03。

| 平台 | 账号 | run | 账号指标 | 内容 |
|---|---|---|---|---|
| Facebook | BYD UK | success | 68000 粉丝 / 8 关注 | 3 条视频（页面批次一起返回，maxContents 在页末检查） |
| TikTok | BYD UK | success | 28780 粉丝 / 242 帖子 | 1 条视频：播放 29200、点赞 312、评论 4、收藏 36、分享 10 |
| LinkedIn | BYD Italia | success | 25000 粉丝 | 1 条帖子：点赞 59、评论 1、转发 14 |

细节：

- Facebook 的 feed 请求模板、GraphQL 翻页、UFI 指标解析、入库都正常；`BYD UK` 页面正常。
- TikTok 的 Profile 3 **没有登录 TikTok**，但公开主页 `item_list` 接口可以抓到数据；`BYD UK` 1 条视频指标完整。登录态不是本次必需。
- LinkedIn 的 `BYD UK` 公司页当前是 `/company/unavailable/`，旧 auto 探测和 graph 版都会失败；改用 `BYD Italia`（`company/byd-italia`）后 RSC 分页正常。新模块只迁了 RSC 实现，当前页面也确实是 RSC/sdui。
- LinkedIn 旧 `linkedin-auto.ts` 的接口探测在新页面上找不到排序控件，直接跑 `linkedin-rsc.ts` 反而成功；新模块因此以 RSC 为入口，不再做 auto 探测。

六个平台的真实账号测试到此全部通过：YouTube、X、Instagram、Facebook、TikTok、LinkedIn。

### 2026-11-04 五平台旧/新 run 对比

同一测试库、同一窗口（2026-10-20 ~ 2026-11-03）、同一账号、同一 limit，旧 `daily-scrape.ts` 与新 `scrape:daily` 各跑一次：

| 平台 | 旧 run 内容 | 新 run 内容 | 结果 |
|---|---|---|---|
| X | 1 | 1 | 一致 |
| Instagram | 3 | 3 | 一致 |
| Facebook | 11 | 11 | 一致（新 run 用 `--limit 0` 复跑对齐） |
| TikTok | 1 | 1 | 一致 |
| LinkedIn | 1 | 1 | 一致 |

逐条对比 17 条内容（URL、点赞、评论、分享、收藏、播放、`metric_day_key`）：全部一致。唯一的差异是 1 条 Instagram reel 的播放数 16297 → 16306，属于两次抓取之间的实时数据漂移，不是解析差异。

账号指标对比：

| 平台 | 账号 | 旧 | 新 |
|---|---|---|---|
| X | Geely Auto UK | 180 粉丝 / 3 关注 | 180 / 3 |
| Instagram | byd.uk | 114217 粉丝 / 312 关注 | 114217 / 312 |
| Facebook | BYD UK | 68000 粉丝 / 8 关注 | 68000 / 8 |
| TikTok | BYD UK | 28787 粉丝 / 22 关注 / 242 帖子 | 28780 / 22 / 242 |
| LinkedIn | BYD Italia | 25000 粉丝 | 25000 |

TikTok 粉丝 28787 → 28780 也是实时漂移。

Facebook 补充说明：新 run 第一次用 `--limit 1`，因为 limit 在页末检查，页面一批返回了 3 条；旧 run 没有内容 limit，保留了 11 条。补跑一次新 run `--limit 0` 后，raw 12 / 账号指标 1 / 内容指标 11 与旧 run 完全一致。

结论：**六个平台全部完成真实账号测试 + 旧/新 run 对比**。

## 4. 目标结构

### 平台模块边界

平台模块只做两件事：**操作浏览器 + 解析数据**。

不允许出现：

- `process.env`
- DB / drizzle 导入
- `persistScrapeAccountResult`
- `finalizeScrapeRunStatus`
- `fs` / Excel / raw.json
- `process.exit`

这些由 `platforms/runner.ts` 和 `main/daily.ts` 负责。

### 数据流

```text
main/daily.ts
  ├─ resolveDailyWindow（原样复制，不改）
  ├─ createScrapeRun
  ├─ spawn main/platform.ts --platform <code> --run-id ...
  │    ├─ loadPlatformAccounts
  │    └─ runPlatform
  │         ├─ openBrowserSession（requiresBrowser=false 时跳过）
  │         ├─ for account:
  │         │    ├─ isRunAccountCompleted → 跳过
  │         │    ├─ startScrapeRunAccount
  │         │    ├─ scraper.scrapeAccount
  │         │    └─ persistScrapeAccountResult
  │         └─ dispose / close browser
  └─ finalizeRunFromAccounts（按 scrape_run_accounts 统计）
```

### run 收口规则

- 子进程超时 → `failed` / `PLATFORM_TIMEOUT`
- 子进程退出码非 0 → `failed` / `PLATFORM_SCRIPT_FAILED`
- 账号总数 0 → `failed` / `NO_ACCOUNTS`
- 失败 + 未完成 = 总数 → `failed`
- 有失败但未全失败 → `partial_failed`
- 全部成功 → `success`

## 5. 平台迁移顺序

| 顺序 | 平台 | 约行数 | 风险 | 状态 |
|---|---|---|---|---|
| 1 | YouTube | 1.4k | 中 | 已迁移；真实账号 + 旧/新对比通过 |
| 2 | X | 0.6k | 中 | 已迁移；真实账号内容验证通过 |
| 3 | Instagram | 1.7k | 中高 | 已迁移（API only）；真实账号验证通过；待旧/新对比 |
| 4 | Facebook | 0.6k | 中 | 已迁移；真实账号验证通过 |
| 5 | TikTok | 1.3k | 高 | 已迁移；真实账号验证通过 |
| 6 | LinkedIn | 2.7k | 最高 | 已迁移（RSC）；真实账号验证通过 |

LinkedIn 最终以 RSC 为入口：旧 `linkedin-auto.ts` 的接口探测在当前页面找不到排序控件，直接跑 `linkedin-rsc.ts` 可以正常翻页；新模块不再做 auto 探测。

### 每个平台的迁移清单

- [ ] 抽出纯解析函数，用旧 `scrape_raw_records.raw_json` 做 fixture 单测
- [ ] 浏览器流程搬进 `scrapeAccount`，去掉本地文件/Excel/参数解析/DB 写入
- [ ] 接入 `config/platforms.ts`
- [ ] 测试库 `--platforms <p>` 跑通
- [ ] 旧/新各跑一次，对比账号数、内容数、指标字段、错误、run_accounts 状态
- [ ] 登录失效、单账号失败、部分内容失败、断点跳过
- [ ] 平台结束后 Chrome 退出，无残留进程 / profile 锁
- [ ] 代码 review：平台模块里没有 `process.env` / DB / `fs` / `process.exit`

## 6. 灰度切换

- 新 daily 支持 `--platforms`，旧 daily 用 `SCRAPE_PLATFORM_ORDER`。
- 按平台分组灰度：新 daily 跑已迁移平台，旧 daily 跑剩余平台；两组平台不重叠，串行执行。
- 新项目用 profile B + Playwright；旧 daily 用 profile A + CDP，避免 profile 锁。
- **灰度期间暂停旧 `scrape:retry`**：新 daily 会产生 `partial_failed`，旧 retry 可能用旧脚本重跑。新 daily 的失败先手工用 `--platforms` 重跑。
- 出问题改回旧 bat；旧代码不动。
- 六个平台都切完后观察几天，再归档旧 `src/`。

## 7. 测试

```bash
cd refactor-project
pnpm install
pnpm run typecheck
pnpm test                    # 单元测试，不连数据库

# 测试库
TEST_DATABASE_URL='postgres://<user>:<password>@localhost:5432/changan_rpa_test' pnpm run db:test:setup
TEST_DATABASE_URL='postgres://<user>:<password>@localhost:5432/changan_rpa_test' pnpm run db:test:seed
TEST_DATABASE_URL='postgres://<user>:<password>@localhost:5432/changan_rpa_test' pnpm run test:integration

# fake 端到端
DATABASE_URL='postgres://<user>:<password>@localhost:5432/changan_rpa_test' \
  pnpm run scrape:daily -- --platforms fake --account-type 总部 --account fake_account

# YouTube 真实账号（需 Chrome profile 已登录；公开频道可不登录）
DATABASE_URL='postgres://<user>:<password>@localhost:5432/changan_rpa_test' \
SOCIAL_BROWSER_MODE=playwright \
SOCIAL_BROWSER_USER_DATA_DIR='/path/to/chrome-profile' \
SOCIAL_BROWSER_EXECUTABLE='/path/to/Google Chrome' \
SCRAPE_WINDOW_START='2026-10-20' \
  pnpm run scrape:daily -- --platforms youtube --account-type 总部 \
  --account 'BYD España' --comment-timeout-ms 3000

# Instagram API（需要 TIKHUB_API_KEY）
TIKHUB_API_KEY='<key>' DATABASE_URL='postgres://<user>:<password>@localhost:5432/changan_rpa_test' \
SCRAPE_WINDOW_START='2026-10-20' \
  pnpm run scrape:daily -- --platforms instagram --account-type 总部 \
  --account 'byd.uk' --limit 2

# X（使用已登录的 work profile / Profile 3）
DATABASE_URL='postgres://<user>:<password>@localhost:5432/changan_rpa_test' \
SOCIAL_BROWSER_MODE=playwright \
SOCIAL_BROWSER_USER_DATA_DIR='/path/to/changan-rpa/work/playwright-social-profile' \
SOCIAL_BROWSER_PROFILE_DIRECTORY='Profile 3' \
SOCIAL_BROWSER_EXECUTABLE='/path/to/Google Chrome' \
SCRAPE_WINDOW_START='2026-01-01' \
  pnpm run scrape:daily -- --platforms x --account-type 总部 \
  --account 'Geely Auto UK' --limit 1
```

`db/schema.sql` 目前是爬虫链路表的测试快照；正式上线前用生产库 `pg_dump --schema-only` 校对。

## 8. 待办

- [ ] 用生产 `pg_dump --schema-only` 校对/替换 `db/schema.sql`
- [ ] 新 profile B 登录一次
- [ ] daily 支持 SIGINT/SIGTERM：杀当前子进程树，标记 run cancelled/failed
- [ ] 账号超时后的页面恢复（重启 page/browser）；当前先直接终止平台
- [x] YouTube（真实账号验证 + 旧/新 run 对比通过）
- [x] X（真实账号内容验证通过）
- [x] Instagram（API only，真实账号验证通过）
- [x] Facebook（真实账号验证通过）
- [x] TikTok（真实账号验证通过）
- [x] LinkedIn（RSC；真实账号验证通过）
- [x] Instagram / X / Facebook / TikTok / LinkedIn 旧/新 run 对比
- [ ] 灰度切换 / 回滚演练
- [ ] README/runbook 更新
- [ ] 旧项目归档（确认页面账号导入可用之后）
