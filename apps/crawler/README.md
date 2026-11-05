# changan-rpa refactor

`scrape:daily` 链路的迁移目标项目。当前阶段只做爬虫，不包含评论、任务队列、定时调度和页面。

## 状态

- [x] 独立 package / tsconfig / env
- [x] core / db schema / browser 冻结复制
- [x] 测试库 schema + test-db guard
- [x] 平台 runner + fake 平台（跑通建 run → 账号循环 → 入库 → run 收口）
- [x] YouTube（真实账号 + 旧/新 run 对比通过）
- [x] X（真实账号内容验证通过）
- [x] Instagram（TikHub API；真实账号验证通过；旧/新对比待做）
- [x] Facebook（真实账号验证通过）
- [x] TikTok（真实账号验证通过）
- [x] LinkedIn（RSC；真实账号验证通过）
- [x] 六平台真实账号 + 旧/新 run 对比
- [ ] 灰度切换 / 文档

## 安装

```bash
cd refactor-project
pnpm install
cp .env.example .env
```

## 测试库

```bash
createdb changan_rpa_test
# .env 里设置 TEST_DATABASE_URL
pnpm run db:test:setup
pnpm run db:test:seed   # fake + YouTube/Instagram/X 测试账号
```

`db/schema.sql` 只包含爬虫用到的表；正式上线前会用生产 `pg_dump --schema-only` 快照替换/校对。

## 命令

```bash
pnpm run typecheck
pnpm test                 # 单元测试，不连数据库
pnpm run test:integration # 需要 TEST_DATABASE_URL
pnpm run test:all

# 只跑 fake 平台，验证编排/入库/收口
pnpm run scrape:daily -- --platforms fake --account-type 总部
```

## 约定

- 新项目不写本地 Excel / raw.json / CSV。
- 不改数据库表结构，不改 `task_date_key` 计算，不改平台选择器/解析逻辑。
- 平台模块只操作浏览器和解析数据；DB 入库、run 状态、浏览器生命周期由 runner/main 负责。
- run 最终状态由 daily 统一收口；平台脚本不再写 `scrape_runs.status`。
- 平台级/账号级超时可在 daily 参数中配置；账号超时会终止整个平台，避免复用卡死的页面。
