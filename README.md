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
TIKHUB_API_KEY   # 只有跑 Instagram 时需要
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
