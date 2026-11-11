# Changan RPA Monorepo

## 结构

```text
apps/
  crawler/   # 爬虫 worker，轮询数据库任务；不暴露 API
  web/       # TanStack Start 全栈 Web，直接访问数据库
packages/
  db/        # 共用数据库连接/schema
  shared/    # 共用时间、ID、DTO
```

根目录的 `package.json` 是 monorepo 入口，不是单个应用的启动入口。
不要在 `apps/web` 或 `apps/crawler` 里直接执行根脚本，按下面从根目录启动。

## 安装

```bash
cd /Users/fuhui/outsourcing-projects/changan
pnpm install
```

## 环境变量

Web 和 crawler 各自读取自己目录下的 `.env`：

```text
apps/web/.env
apps/crawler/.env
```

从示例复制后填写：

```bash
cp apps/web/.env.example apps/web/.env
cp apps/crawler/.env.example apps/crawler/.env
```

Web 至少需要：

```text
DATABASE_URL
```

Crawler 还需要：

```text
DATABASE_URL
SOCIAL_BROWSER_MODE
SOCIAL_BROWSER_USER_DATA_DIR
SOCIAL_BROWSER_PROFILE_DIRECTORY
SOCIAL_BROWSER_EXECUTABLE
TIKHUB_API_KEY   # Instagram / TikTok / 评论任务需要
```

YouTube 默认优先走 HTTP 接口（浏览器只用来拿登录态和频道首屏），接口失败会自动降级回纯浏览器页面抓取。
需要强制某一种方式时设置 `YOUTUBE_HTTP_MODE`：

```text
YOUTUBE_HTTP_MODE=auto      # 默认：HTTP 优先，失败降级浏览器
YOUTUBE_HTTP_MODE=http      # 只用 HTTP，失败直接报错
YOUTUBE_HTTP_MODE=browser   # 只用原来的浏览器页面抓取
```

## 启动

在 monorepo 根目录：

### Web

```bash
pnpm dev:web
```

等价于：

```bash
pnpm --filter @changan/web dev
```

默认地址：`http://localhost:3000`。Web 负责页面和同源 `/api`，直接连接数据库。

### Crawler Worker

```bash
pnpm worker
```

等价于：

```bash
pnpm --filter @changan/crawler worker
```

Worker 不开放端口，只轮询 `scrape_tasks`。

不要同时启动两个使用同一个 Chrome profile 的 worker；它们会争抢浏览器 profile。

### 评论任务

评论任务**只走 TikHub HTTP 接口，不启动浏览器**，和上面的 worker 可以同时跑。
支持 `instagram / tiktok / youtube / x`；Facebook / LinkedIn 没有评论接口，不抓。
帖子从库里已有的 `social_contents` 读取，只补评论（含二级回复）。

页面上也可以看：账号管理 → 点账号进「账号详情」→ 帖子列表（按帖子发布时间筛选）→ 点帖子看评论；
帖子列表和帖子详情都支持导出 Excel 评论。

也可以直接在 Web 的「评论抓取」页手动触发（选账号 + 帖子发布时间范围），任务在 Web 进程内后台执行，
不需要额外 worker。首次使用前需要在数据库执行 `apps/crawler/db/comment-jobs-upgrade.sql`，
并给 Web 进程配置 `TIKHUB_API_KEY`；详见 DEPLOY.md 9.2。

```bash
# 看帮助
pnpm comment:help

# 先看范围（不调接口、不写库）
pnpm comment:run -- --dry-run --last-month --account-type 总部

# 跑上月所有接口平台
pnpm comment:run -- --last-month --account-type 总部

# 单账号、指定范围
pnpm comment:run -- --platforms instagram --account byd.uk --since 2026-09-01 --until 2026-09-30
```

账号类型名以库里 `account_categories` 为准；本机测试库当前是 `总部账号`，生产库常见 `总部` / `中南美-月报`。
本地怎么跑（迁移、Key、dry-run、单账号试跑、查结果 SQL）见 [apps/crawler/COMMENTS.md](apps/crawler/COMMENTS.md)；服务器每月 cron 见 [DEPLOY.md](./DEPLOY.md) 第 9.1 节。

## 检查

```bash
pnpm typecheck
pnpm test
pnpm build:web
```

## 部署

Linux 服务器 + pm2 的完整步骤见 [DEPLOY.md](./DEPLOY.md)，配套文件：

- `ecosystem.config.cjs`：pm2 配置示例（单实例，`cwd` 指向产物目录）
- `deploy/nginx.conf`：nginx 反代示例
- `deploy/deploy.sh`：服务器上发布（拉代码 → 构建 → reload → 健康检查）
- `deploy/pack.sh` + `deploy/activate.sh`：本地构建、推产物到服务器发布（服务器不放代码，支持 `--list` / `--rollback`）

两种发布方式的环境和 pm2 配置一致，差别只在产物从哪来，详见 DEPLOY.md 第 10 节。
