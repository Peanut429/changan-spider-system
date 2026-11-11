# 部署到 Linux 服务器（pm2）

面向本仓库：`apps/web`（TanStack Start + Nitro）和 `apps/crawler`（无端口 worker）。
目标机器以 Ubuntu 22.04 / 24.04 为例，2 核 4G 起步即可跑 Web；要同时跑爬虫建议 4 核 8G。

## 0. 部署形态

```text
浏览器 ──HTTPS──> nginx :443 ──> 127.0.0.1:3000 ──> pm2: changan-web（Nitro node-server，单实例）
                                                          │
                                                          └──> PostgreSQL（本机或阿里云 RDS）

pm2: changan-worker（可选，无端口）──轮询 scrape_tasks──> PostgreSQL
                                    └──> Chrome + 已登录 profile（需要虚拟显示）
```

两个关键事实，决定了下面的所有步骤：

1. **Web 的产物是 `apps/web/.output`**（Nitro `node-server` 预设），启动入口就是 `apps/web/.output/server/index.mjs`，只认 `PORT` / `NITRO_PORT` 和 `HOST` 环境变量。
2. **产物在运行时不会读取 `.env`**，只有构建时才会。所以 `DATABASE_URL` 必须写在 pm2 配置的 `env` 里（或启动前 export），否则 `/changan-data/api/health` 返回 400。

部署方式二选一，后续步骤完全共用（pm2、nginx 配置一样），只是“产物从哪来”不同：

| 方式 | 服务器上要不要代码 | 适合 |
| --- | --- | --- |
| **A. 服务器拉代码构建** | 要，完整仓库 | 想一键 `git pull` 发布；爬虫也跑在服务器上 |
| **B. 本地构建推产物** | 不要，只有 `.output` | 不想在服务器装 Node 构建链；爬虫留在本机 |

方式 A 看第 3~6 节 + 10.1，方式 B 直接看 **10.2**（服务器仍需装 Node 24 和 pm2，不需要装代码和依赖）。

## 1. 服务器准备

```bash
# 以 root 或 sudo 用户执行
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
mkdir -p /srv/changan && chown deploy:deploy /srv/changan

apt update && apt install -y git curl build-essential nginx postgresql-client

# 时区（任务按 Asia/Shanghai 算日期，别用 UTC）
timedatectl set-timezone Asia/Shanghai

# 防火墙：只放 22/80/443，3000 不要暴露
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw --force enable
```

### Node 24（项目要求 `node >= 24`）

```bash
su - deploy
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 24          # 写进 .nvmrc 也行；当前本地是 v24.19.0
node -v                 # v24.x
```

### pnpm 11.22.0 + pm2

```bash
# corepack 会读 package.json 里的 packageManager 字段
corepack enable
corepack prepare pnpm@11.22.0 --activate
pnpm -v                 # 11.22.0

# 如果 corepack 不可用（Node 新版本已移除），改用：
# npm i -g pnpm@11.22.0

npm i -g pm2
pm2 -v
```

## 2. 数据库

`apps/web/.env` 现在指向的是阿里云 RDS（`changan_social_data`）。两种情况：

**A. 继续用已有生产库（推荐）**
新服务器只是多一个客户端，只需：

1. 在 RDS 白名单里加上这台服务器的出口 IP；
2. 用 `prod-upgrade.sql` 补齐新表结构（脚本幂等，可重复执行）：

```bash
psql "$DATABASE_URL" -f apps/crawler/db/prod-upgrade.sql
```

**B. 全新空库**
不要执行 `apps/crawler/db/schema.sql`——文件头写明它是**测试库专用**，开头就是 `drop table ... cascade`。正确做法是从现有库导结构：

```bash
pg_dump --schema-only --no-owner --no-privileges "$OLD_DATABASE_URL" > /tmp/schema.sql
psql "$NEW_DATABASE_URL" -f /tmp/schema.sql
```

## 3. 拉代码（方式 A；方式 B 跳过）

```bash
su - deploy
git clone git@github.com:<your-org>/changan.git /srv/changan
cd /srv/changan
pnpm install --frozen-lockfile
```

仓库根目录的 `package.json` 是 monorepo 入口，**不要**进 `apps/web` 里单独 install 脚本。
只推产物的方式 B 不需要这一节，但**仍然要建目录**：`mkdir -p /srv/changan/apps/web`，`.env` 放这里。

## 4. 环境变量

按仓库约定，每个 app 读自己的 `.env`：

（方式 B 没有仓库，直接 `mkdir -p /srv/changan/apps/web` 后把同样的内容写进 `/srv/changan/apps/web/.env`。）

```bash
cd /srv/changan
cp apps/web/.env.example apps/web/.env
cp apps/crawler/.env.example apps/crawler/.env
chmod 600 apps/web/.env apps/crawler/.env
```

`apps/web/.env` 至少要有：

```dotenv
DATABASE_URL=postgres://user:password@rds-host:5432/changan_social_data
DB_POOL_MAX=10
SCRAPE_TIMEZONE=Asia/Shanghai
# 启用 Web 手动评论抓取时还需要（见 9.2）
TIKHUB_API_KEY=
```

`apps/crawler/.env` 还要补浏览器相关变量，见第 9 节。

> `.env` 只是给人看的模板：Nitro 产物运行时不读它，pm2 也不读。**实际生效的是 `ecosystem.config.cjs` 的 `env` 块**，改完要 `pm2 reload changan-web --update-env`。

## 5. 构建（方式 A 在服务器；方式 B 在本地，见 10.2）

```bash
cd /srv/changan
pnpm build:web          # = pnpm --filter @changan/web build
ls apps/web/.output/server/index.mjs
```

产物约 6MB，自带依赖，运行时不需要 `node_modules`。
构建完可以顺手自测（用假 DB 也能过健康检查，因为 pg 连接池是懒连接）：

```bash
cd apps/web
PORT=3999 HOST=127.0.0.1 DATABASE_URL="postgres://u:p@127.0.0.1:1/x" node .output/server/index.mjs
# 另一个终端：curl http://127.0.0.1:3999/changan-data/api/health   → {"ok":true}
```

## 6. 用 pm2 常驻

`ecosystem.config.cjs` 是单实例 fork，`cwd` 指向产物所在目录（只推产物时是 `/srv/changan/web`，跑整个仓库时是 `/srv/changan/apps/web`）。

```bash
cd /srv/changan
pm2 start ecosystem.config.cjs
pm2 ls
pm2 logs changan-web
curl http://127.0.0.1:3010/changan-data/api/health
```

验证无误后固化开机自启：

```bash
pm2 save
pm2 startup systemd -u deploy --hp /home/deploy   # 按提示复制执行它输出的那条 sudo 命令
pm2 save                                          # 再 save 一次，确保 dump 里是最新进程列表
```

日常操作：

| 目的 | 命令 |
| --- | --- |
| 重载（单实例=重启，约 1 秒中断） | `pm2 reload changan-web --update-env` |
| 重新读取 `ecosystem.config.cjs` | `pm2 delete changan-web && pm2 start ecosystem.config.cjs` |
| 重启 | `pm2 restart changan-web` |
| 停止 / 删除 | `pm2 stop changan-web` / `pm2 delete changan-web` |
| 看状态 | `pm2 ls` / `pm2 monit` |
| 看日志 | `pm2 logs changan-web --lines 200` |
| 日志切割（强烈建议） | `pm2 install pm2-logrotate` |

> 需要 worker 时，在 `ecosystem.config.cjs` 里加第二段（见第 9 节）。

## 7. nginx 反向代理

```bash
sudo cp /srv/changan/deploy/nginx.conf /etc/nginx/sites-available/changan.conf
sudo sed -i 's/example.com/你的域名/' /etc/nginx/sites-available/changan.conf
sudo ln -s ../sites-available/changan.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

配置要点（文件里已写好）：

- `proxy_pass http://changan_web;` 指向 `127.0.0.1:3000`，带 `X-Forwarded-Proto/For`；
- `/assets/` 走 30 天强缓存（文件名带内容哈希）；
- `client_max_body_size 50m`，给账号导入的上传留余量；
- `proxy_read_timeout 300s`，避免报表/导出接口被 60s 掐断；
- SSR 页面不加缓存。

HTTPS：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 你的域名
```

## 7.1 部署在子路径（/changan-data）

nginx 要挂在 `/changan-data/` 下时，**不能靠 nginx 剥前缀**：TanStack Router 的 SSG/SSR 匹配、
客户端路由、静态资源地址、`fetch('/api/...')` 都按根路径硬编码。正确做法是让应用自己知道前缀。

一处配置：

```dotenv
# apps/web/.env
BASE_PATH=/changan-data
```

它会在 `pnpm build:web` 时被读到，同时作用于：

| 位置 | 作用 |
| --- | --- |
| `vite base` | HTML 里的 `/changan-data/assets/xxx.js` |
| `nitro baseURL` | 服务端在 `/changan-data/` 下提供静态资源 |
| `import.meta.env.BASE_URL` → router `basepath` | 页面路由、`Link`、`navigate`、重定向 Location |
| `src/lib/api.ts` | 所有接口请求自动加前缀 |
| `__root.tsx` favicon | 图标路径 |

**前缀是编译期常量**：改 `BASE_PATH` 必须重新 `pnpm build:web`，只重启 pm2 没用。
本地 `pnpm dev:web` 的地址也会变成 `http://localhost:3000/changan-data/`。

nginx 侧原样转发即可，关键是 `proxy_pass` **末尾不要加 `/`**（加了就会剥前缀）：

```nginx
location = /changan-data { return 301 /changan-data/; }

location /changan-data/ {
    proxy_pass http://127.0.0.1:3010;   # 注意没有结尾斜杠
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Prefix /changan-data;
}

location /changan-data/assets/ {
    proxy_pass http://127.0.0.1:3010;
    expires 30d;
    add_header Cache-Control "public, immutable";
}
```

完整文件见 `deploy/nginx.conf`。

验证（不经过 nginx，直接打应用）：

```bash
curl -i http://127.0.0.1:3010/changan-data/api/health    # 200 {"ok":true}
curl -i http://127.0.0.1:3010/changan-data/tasks         # 307 → /changan-data/tasks?date=...
curl -I http://127.0.0.1:3010/changan-data/assets/index-xxx.js   # 200
```

## 8. 验收清单

```bash
curl -I https://你的域名/                      # 200，或 307 跳到 /tasks
curl -s https://你的域名/changan-data/api/health            # {"ok":true}
curl -s "https://你的域名/changan-data/api/platforms"       # 能读到数据 → 服务器到 DB 通
pm2 ls                                        # 2 个 changan-web 实例 online
pm2 logs changan-web --lines 50 --nostream    # 没有 500 / ECONNREFUSED
sudo tail -f /var/log/nginx/changan.error.log
```

## 9. 爬虫 worker（可选）

worker 用 `node --experimental-strip-types` 直接跑 TS，不需要构建，但对浏览器环境有硬要求：

1. **它是有头浏览器**（`apps/crawler/src/core/browser.ts` 里 `headless: false`），Linux 上必须给虚拟显示：

   ```bash
   sudo apt install -y xvfb
   # 用 systemd 常驻一个虚拟屏
   sudo tee /etc/systemd/system/xvfb.service >/dev/null <<'EOF'
   [Unit]
   Description=Virtual framebuffer for Chrome
   After=network.target
   [Service]
   ExecStart=/usr/bin/Xvfb :99 -screen 0 1920x1080x24
   Restart=always
   [Install]
   WantedBy=multi-user.target
   EOF
   sudo systemctl enable --now xvfb
   ```

   然后在 `apps/crawler/.env` 里加 `DISPLAY=:99`。

2. **装 Chrome 和系统依赖**：

   ```bash
   # 方式一：装系统 Chrome，最稳
   wget -qO- https://dl.google.com/linux/linux_signing_key.pub | sudo gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
   echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list
   sudo apt update && sudo apt install -y google-chrome-stable
   # .env: SOCIAL_BROWSER_EXECUTABLE=/usr/bin/google-chrome

   # 方式二：用 Playwright 自带 chromium
   cd /srv/changan && pnpm --filter @changan/crawler exec playwright install --with-deps chromium
   ```

3. **登录态**：`SOCIAL_BROWSER_USER_DATA_DIR` 指向一个持久目录（如 `/srv/changan/data/chrome-profile`），
   登录一次后 cookie 存在里面。在无桌面的服务器上登录比较别扭，两个办法：
   - 在本机（Chrome 同大版本）登录后，把 profile 目录打包上传；
   - 服务器上跑 `xvfb-run` + x11vnc，用 VNC 连进去点登录。
   注意**同一个 profile 同时只能有一个进程在用**，所以 worker 必须 `instances: 1`。

4. 启动并观察：

   ```bash
   cd /srv/changan/apps/crawler
   pm2 start src/main/worker.ts --name changan-worker \
     --interpreter node --node-args="--experimental-strip-types"
   pm2 logs changan-worker --lines 100
   ```

## 9.1 评论任务（TikHub 接口，可选）

> 本地手动跑法见 [apps/crawler/COMMENTS.md](apps/crawler/COMMENTS.md)；下面只讲服务器上的每月自动跑。
> 如果只想在 Web 页面手动触发，见 9.2（不需要额外 worker）。

评论任务和上面的帖子 worker 是两条独立链路：

- **只走 TikHub HTTP 接口，不启动浏览器**，所以服务器上不需要 Xvfb / Chrome，
  也不会和帖子 worker 抢 Chrome profile，两个可以同时跑。
- 支持 `instagram / tiktok / youtube / x`；Facebook / LinkedIn 没有评论接口，本任务不抓。
- 帖子和 worker 一样直接跑 TS，需要服务器上有仓库代码和 `node_modules`（即第 10 节的方式 A）。
- 帖子从库里已有的 `social_contents` 读取（帖子仍由每日任务负责），只补评论。
- 说明：评论任务按「帖子发布时间落在窗口内」取帖，不是按评论时间过滤。
- 已知限制：X 的接口返回扁平 `thread`，不提供父评论信息，所以 X 的 `parent_comment_id`/`root_comment_id`
  为空（回复内容仍会入库），`--no-replies` 对 X 也不生效（thread 里的内容都按一级评论入库）；
  YouTube 接口只给「x天前」这类相对时间，`create_timestamp` 存 0。

1. **先补数据库结构**（只加可空列和索引，可重复执行）：

   ```bash
   cd /srv/changan
   psql "$DATABASE_URL" -f apps/crawler/db/comment-upgrade.sql
   # 或者跑包含第 4 节的完整升级脚本
   psql "$DATABASE_URL" -f apps/crawler/db/prod-upgrade.sql
   ```

2. **配置 API Key**：`apps/crawler/.env` 里填 `TIKHUB_API_KEY`（按接口调用计费）。
   可选 `TIKHUB_MIN_INTERVAL_MS`（默认 120）控制请求间隔。

3. **先 dry-run 看范围**（不调接口、不写评论）：

   ```bash
   cd /srv/changan/apps/crawler
   node --experimental-strip-types src/main/comment-run.ts \
     --dry-run --last-month --account-type 总部
   ```

   输出会列出每个平台的账号数、窗口内帖子数、窗口内 0 帖子的账号。
   0 帖子多说明该账号类型在对应月份没有入库帖子（先跑/post 检查每日任务），
   不是评论任务失败。

4. **配置每月 cron**：用 `deploy/comment-run.sh` 包装脚本，默认跑上月。

   ```bash
   mkdir -p /srv/changan/logs
   crontab -e
   ```

   ```cron
   # 每月 1 号 04:00 跑上月评论；NODE_BIN 用 `which node` 的绝对路径
   0 4 1 * * COMMENT_ACCOUNT_TYPE=总部 NODE_BIN=/home/deploy/.nvm/versions/node/v24.19.0/bin/node /srv/changan/deploy/comment-run.sh >> /srv/changan/logs/comment.log 2>&1
   ```

   先手动触发一次再等 cron：

   ```bash
   COMMENT_ACCOUNT_TYPE=总部 /srv/changan/deploy/comment-run.sh
   tail -50 /srv/changan/logs/comment.log
   ```

   按生产 10 月的量级（4 个平台约 2100 个帖子）估算，完整月跑通常几十分钟到数小时，
   放凌晨 04:00 不会压到白天；默认开启回复抓取，可用 `--no-replies` 先跑一轮再补。

   备选（不用 crontab，交给 pm2 的 cron_restart；同样不需要浏览器）：

   ```bash
   cd /srv/changan/apps/crawler
   pm2 start src/main/comment-run.ts --name changan-comment \
     --interpreter node --node-args="--experimental-strip-types" \
     --cron-restart "0 4 1 * *" --no-autorestart -- \
     --last-month --trigger scheduled --account-type 总部 \
     --platforms instagram,tiktok,youtube,x
   ```

5. **手动补跑 / 控制成本**：

   ```bash
   cd /srv/changan/apps/crawler

   # 单账号、指定范围
   node --experimental-strip-types src/main/comment-run.ts \
     --platforms instagram --account byd.uk --since 2026-09-01 --until 2026-09-30

   # 失败后续跑（沿用原 run 的窗口，跳过已完成账号/帖子）
   node --experimental-strip-types src/main/comment-run.ts \
     --platforms instagram --run-id run-xxxx --account byd.uk

   # 只补一级评论，不抓回复
   node --experimental-strip-types src/main/comment-run.ts \
     --last-month --account-type 总部 --no-replies

   # 单帖上限：一级+回复合计 200 条、每条一级最多 20 条回复
   node --experimental-strip-types src/main/comment-run.ts \
     --last-month --account-type 总部 \
     --max-comments-per-post 200 --max-replies-per-comment 20
   ```

6. **结果在哪看**：

   - 评论：`comment` 表（`content_id` 关联 `social_contents.id`，`parent_comment_id`/`root_comment_id` 表示回复层级）。
   - 每次运行：`scrape_runs`（一个平台一条 run）+ `scrape_run_accounts`（账号级状态）。
   - 帖子级进度/断点：`scrape_raw_records`，`record_type = 'comment_post'`；成功行 `error_code is null`。
   - 失败排查：`scrape_event_logs` 里的 `step = 'comment_error'` / 账号错误信息，
     以及 `scrape_raw_records` 的 `error_message`。

   评论任务不写 `content_daily_metrics`，避免影响每日指标；帖子评论数仍以每日任务为准。

## 9.2 Web 手动触发评论抓取（可选）

评论任务只走 TikHub 接口，所以也可以直接在 Web 进程里后台执行，不需要额外 worker，
也不需要 Chrome / Xvfb。

1. **数据库补一张任务表**：

   ```bash
   cd /srv/changan
   psql "$DATABASE_URL" -f apps/crawler/db/comment-jobs-upgrade.sql
   # 或者跑包含第 5 节的完整升级脚本
   psql "$DATABASE_URL" -f apps/crawler/db/prod-upgrade.sql
   ```

2. **Web 进程配置 TikHub Key**：`TIKHUB_API_KEY` 要进 Web 的运行时环境
   （`ecosystem.config.cjs` 的 `env` 或 `pm2 start/reload --update-env` 的 shell 环境）。
   没有配置时页面会显示警告，任务无法创建。

3. **重新发布 Web**（这次只改 Web，不需要动 crawler）：

   ```bash
   pnpm build:web
   pm2 reload changan-web --update-env
   ```

4. 打开 `/comments`（部署在子路径时是 `/changan-data/comments`）：
   - 选账号（支持平台/类型/搜索筛选，只支持 IG/TikTok/YouTube/X）
   - 选**帖子发布时间范围**（评论本身不按时间筛选）
   - 设置单帖评论/回复上限，点「开始抓取」
   - 任务在 Web 进程内串行执行，页面每 3 秒刷新进度；可以离开页面
   - 完成后去「账号管理 → 账号 → 帖子 → 查看评论」看结果，或下载 Excel
   - 失败帖子可点「失败详情」；「重试失败」只重试可恢复错误（超时/限流等）。
     资源不存在、无权限、评论关闭等会标为「不可重试」，不会再次请求，避免 TikHub 重复扣费
   - Instagram 评论主用 v2；首屏 5xx、网络错误或 v2 的业务误报会自动切 v3 再取一次，
     429/401/402/403 不切。v3 也失败才按错误分类记录

5. 注意：
   - 当前部署是**单个 Web 实例**：任务队列在进程内存里；Web 重启会把未完成任务标记为失败，
     重新触发即可（评论按 ID upsert，不会重复）。
   - 如果要跑几十个账号、积压很多任务，建议还是用 CLI + cron（9.1），或后续改成独立队列。
   - `comment_jobs` 表只记录任务进度，评论数据仍写 `comment` 表。

## 10. 发布

两种方式选一种即可，pm2 / nginx 配置完全相同，区别只是产物从哪来。

### 10.1 方式 A：服务器上拉代码构建

```bash
chmod +x deploy/deploy.sh      # 首次
cd /srv/changan && ./deploy/deploy.sh
```

脚本流程：`git pull` → `pnpm install --frozen-lockfile` → `pnpm build:web` → `pm2 reload --update-env` → 轮询 `/api/health`。
构建失败会在 reload 之前退出，线上旧版本继续服务。

### 10.2 方式 B：本地构建，推产物（服务器不放代码）

`.output` 是自包含的：纯 JS、无原生二进制、运行时只用 Node 内置模块，所以 **Mac 上构建、Linux 上跑没问题**。
唯一约束是产物按 Node 24 打包，服务器也要 Node 24。

服务器上的目录结构（`deploy/pack.sh` 首次运行会自动建好 releases 部分）：

```text
/srv/changan/
├── ecosystem.config.cjs        # 首次自动上传，之后可用 --push-config 覆盖
├── apps/web/.env               # 常驻配置，不随发布覆盖（需手动建一次）
├── current -> releases/20261109-112208
└── releases/
    ├── 20261109-112208/apps/web/.output/...    # 当前版本
    └── 20261108-201000/apps/web/.output/...    # 上一个版本，回滚用
```

首次准备（只做一次）：

```bash
ssh deploy@server 'mkdir -p /srv/changan/apps/web'
ssh deploy@server 'vi /srv/changan/apps/web/.env'    # 参照 4 节填 DATABASE_URL
```

之后每次发布：

```bash
SERVER=deploy@server ./deploy/pack.sh
```

它做的事：本地 `pnpm build:web` → tar 打包 `.output` → ssh 传到 `releases/<时间戳>/`
→ 切 `current` 软链 → `pm2 startOrReload --only changan-web` → 轮询 `/api/health`
→ **健康检查失败自动切回上一个版本** → 清理旧版本（默认保留 5 个）。

| 命令 | 作用 |
| --- | --- |
| `SERVER=... ./deploy/pack.sh` | 构建并发布 |
| `SERVER=... ./deploy/pack.sh --skip-build` | 不重新构建，直接推现有 `.output` |
| `SERVER=... ./deploy/pack.sh --push-config` | 同时覆盖服务器上的 `ecosystem.config.cjs` |
| `SERVER=... ./deploy/pack.sh --list` | 列出服务器上的版本和当前版本 |
| `SERVER=... ./deploy/pack.sh --rollback 20261108-201000` | 切回指定版本（不重新构建） |
| `KEEP=10 SERVER=... ./deploy/pack.sh` | 保留 10 个历史版本 |

必须知道的限制：

- **worker 不能这样部署**。它直接跑 `src/main/worker.ts`（Node 的 TS 类型擦除），没有构建产物，也依赖 workspace 软链和 `node_modules`。
  爬虫要放服务器，就得用方式 A 把仓库放上去，或者 `rsync` 整个仓库后再 `pnpm install`。
- 产物纯 JS 才能跨平台。**以后引入原生模块**（`sharp`、`better-sqlite3`、`bcrypt` 之类）就必须在 Linux 上构建（Docker 或 CI），
  因为 `.node` 二进制和平台绑定，Mac 编出来的在服务器上会 `invalid ELF header`。
- 回滚只切软链 + reload，秒级完成，但**数据库结构变更不会跟着回滚**，改表前先评估。
- 服务器上不需要 `pnpm install`，也就没有 `node_modules`；pm2 启动的就是 `current/apps/web/.output/server/index.mjs`。

### 10.3 CI 里怎么做

`pack.sh` 的每一步都可以拆到 CI：`pnpm install --frozen-lockfile && pnpm build:web`，
然后把 `apps/web/.output` 传到 `releases/<git-sha>/`，最后 `ssh` 执行 `deploy/activate.sh`
（`REMOTE_DIR=... RELEASE=<git-sha> bash activate.sh`）即可，回滚时把 `RELEASE` 换成上一个 sha。

## 11. 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `/changan-data/api/health` 返回 400 `缺少 DATABASE_URL` | pm2 没注入环境变量。确认 `apps/web/.env` 存在且 `pm2 reload ... --update-env`；`pm2 env 0` 可以看到实际环境 |
| 改了 `.env` 不生效 | `.env` 只在 `pm2 start/reload` 读配置时解析，必须带 `--update-env`，或 `pm2 delete` 后重新 start |
| nginx 502 | web 没起来或不在 3000。`pm2 logs changan-web`、`ss -lntp \| grep 3000` |
| `EADDRINUSE` | 本机已有进程占 3000（比如误跑了 `pnpm dev:web`）；或 `.env` 里的 `PORT` 和 nginx upstream 不一致 |
| 页面 200 但静态资源 404 | 检查 `apps/web/.output/public` 是否存在、nginx 是否把 `/assets/` 也转给了 upstream |
| 构建时 OOM / 被 kill | 小内存机器加 swap：`fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile` |
| `pnpm: command not found`（pm2 重启后） | pm2 守护进程 PATH 不含 nvm。用 `pm2 startup` 生成的 systemd 单元启动，或把 pm2/Node 装成系统级 |
| worker 报 `Missing X server or $DISPLAY` | 没装 Xvfb 或没设 `DISPLAY=:99`（见第 9 节） |
| worker 报 Chrome 沙箱错误 | 用非 root 用户跑 pm2；确需 root 才加 `--no-sandbox` |
| 连不上 RDS | 服务器出口 IP 没进 RDS 白名单，或安全组未放行 5432 出方向 |
| 推了产物但页面还是旧的 | 没跑 `activate.sh`（它才切软链 + reload）；或 `pm2 reload` 时 `--only` 写错应用名 |
| 产物在服务器启动报 `invalid ELF header` | 构建时引入了原生模块，改在 Linux/CI 上构建 |
| `/srv/changan/current` 存在但 pm2 进程 cwd 是旧的 | `pm2 describe changan-web \| grep exec cwd` 确认；必要时 `pm2 delete changan-web` 后重新 start |
| 用 nvm 升级 Node 后 pm2 起不来 | pm2 守护进程绑的是旧的 node 路径，`pm2 delete all && pm2 start ecosystem.config.cjs && pm2 save`，再重跑一次 `pm2 startup` |

## 12. 注意

- `pnpm dev:web` 只用于开发（HMR、devtools），线上永远跑 `.output/server/index.mjs`。
- 同一台机器不要再起第二个 worker：会抢同一个 Chrome profile。
- `apps/web/.output` 和 `.env` 都在 `.gitignore` 里，部署后不要指望 `git pull` 带来它们。
- 方式 B 的 `current` 是软链，`releases/` 才是实体目录；排查问题时 `readlink -f /srv/changan/current` 定位真实路径。
- 方式 B 的服务器上直接改 `/srv/changan/apps/web/.env` 即可，不要改到 `releases/*/apps/web/.env`（不存在，也不该存在）。
- 目前没有自动迁移脚本，DB 结构变更仍靠 `apps/crawler/db/*.sql` 手工执行。
