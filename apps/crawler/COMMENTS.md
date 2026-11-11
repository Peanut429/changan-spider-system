# 评论任务：本地运行指南

评论任务**没有页面**，它是一个命令行程序：运行 → 抓取 → 写库 → 退出。
只走 TikHub 接口，不启动浏览器，所以在本机直接跑就行。

> 生产服务器上的每月定时跑法见 [DEPLOY.md](../../DEPLOY.md) 第 9.1 节。

## 最快跑通（复制粘贴）

可以，本地直接跑，不需要服务器。

```bash
cd /Users/fuhui/outsourcing-projects/changan

# 1) 本地库迁移（幂等，可重复跑）
(cd apps/crawler && export DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-)" && psql "$DATABASE_URL" -f db/comment-upgrade.sql)

# 2) 配置 Key（也可以写进 apps/crawler/.env）
export TIKHUB_API_KEY='你的key'

# 3) 看范围（不调接口、不写库）
pnpm comment:run -- --dry-run --last-month --account-type 总部账号

# 4) 单账号、1 个帖子、最多 5 条评论试跑
#    （不用写 --platforms，程序会按账号所在平台跑）
pnpm comment:run -- --account byd.uk --since 2026-11-01 --until 2026-11-02 --max-posts-per-account 1 --max-comments-per-post 5
```

跑通后再按下面步骤看结果、跑整月。注意 `总部账号` 是本机测试库的类型名，
生产库通常是 `总部` / `中南美-月报`，用前先按第 0.1 步查一下。
如果启动时打印的是 `pgm-...aliyuncs.com`，把示例里的 `总部账号` 换成生产库的类型名。

## 页面上查看 / 触发（Web）

Web 端已经有两个查看页面和一个手动触发页面，不需要写 SQL：

1. **账号管理 → 点击账号 / 查看帖子 → 账号详情**
   - 账号信息、粉丝/帖子数、范围内帖子数和已抓评论数
   - 帖子列表，支持按**帖子发布时间**筛选
   - 右上角「下载范围内全部评论」导出 Excel
2. **帖子详情（帖子行点“查看评论”）**
   - 一级评论 + 二级回复（回复缩进显示）
   - 评论列表右上角「下载该帖评论」导出 Excel
3. **评论抓取（导航「评论抓取」）**
   - 选账号 + 帖子发布时间范围，点「开始抓取」，后台在 Web 进程里跑
   - 需要先执行 `apps/crawler/db/comment-jobs-upgrade.sql`，并给 Web 配 `TIKHUB_API_KEY`
   - 任务串行执行，页面实时显示进度；Web 重启会中断未完成任务
   - 失败帖子可查看详情并重试；资源不存在/无权限/评论关闭等永久错误不会重试，避免重复扣费
   - Instagram 评论主用 v2；首屏遇到 5xx、网络错误、响应结构异常或 v2 的
     resource-not-exist 误报时，会自动切 v3（get_post_comments）再取一次。
     429/401/402/403 不切（同一账号限流/鉴权/额度问题，换版本没意义）

规则：**时间范围只筛帖子，不筛评论**。评论来自 `comment` 表，没跑过评论任务的帖子会显示
“还没有抓到评论”。Excel 列包括：平台、账号、帖子标题/链接/发布时间、评论ID、昵称、用户ID、
评论内容、点赞数、回复数、评论层级、父评论ID、根评论ID、评论时间。

## 0. 先确认要写哪个数据库

> ⚠️ 程序启动时会打印 `[comment] 数据库：<库名> @ <host>`。
> host 不是 `localhost` / `127.0.0.1` 时会额外警告——看到 `pgm-...aliyuncs.com`
> 就说明连的是生产 RDS，评论会直接写生产库。

评论任务读 `apps/crawler/.env` 里的 `DATABASE_URL`。

```bash
cd /Users/fuhui/outsourcing-projects/changan
grep '^DATABASE_URL=' apps/crawler/.env
```

仓库示例默认是本地测试库 `changan_rpa_test`（推荐先用它试）。
如果你之前按“连生产”改过 `.env`，以第 0 步查到的为准；想切回本地，把 `DATABASE_URL`
改回本机 `changan_rpa_test` 的连接串即可。

如果要连生产 RDS：把 `apps/web/.env` 的 `DATABASE_URL` 复制到 `apps/crawler/.env`。
**第一次不要直接跑生产**——先本地库跑通，再考虑换库。

### 0.1 查一下账号类型叫什么

```bash
cd /Users/fuhui/outsourcing-projects/changan/apps/crawler
export DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-)"
psql "$DATABASE_URL" -c "
  select c.name, count(m.account_id) as accounts
    from account_categories c
    left join account_category_members m on m.category_id = c.id
   group by 1 order by 2 desc"
```

本机测试库现在只有 `总部账号` 这个分类；生产库常见的是 `总部`、`中南美-月报`、`中东非`、`欧洲`。
**下面的 `--account-type` 用你查出来的名字**，名字对不上会看到
`账号类型 xxx 不在 account_categories 中，回退 social_accounts.account_type 过滤`。

## 1. 装依赖

```bash
cd /Users/fuhui/outsourcing-projects/changan
pnpm install
```

## 2. 在本地库执行迁移（只跑一次）

```bash
cd /Users/fuhui/outsourcing-projects/changan/apps/crawler

export DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-)"
psql "$DATABASE_URL" -f db/comment-upgrade.sql
```

验证新列和注释都在：

```bash
psql "$DATABASE_URL" -c "
  select a.attname, col_description('public.comment'::regclass, a.attnum) as comment
    from pg_attribute a
   where a.attrelid = 'public.comment'::regclass
     and a.attnum > 0 and not a.attisdropped
   order by a.attnum"
```

旧库如果还没跑过 `prod-upgrade.sql`，先跑它再跑 `comment-upgrade.sql`。

## 3. 配置 TikHub Key

编辑 `apps/crawler/.env`：

```text
TIKHUB_API_KEY=你的key
```

或者只在当前终端临时生效：

```bash
export TIKHUB_API_KEY='你的key'
```

没配 Key 时程序会在入口直接报错，不会写脏数据。

## 4. 看帮助

```bash
# 在仓库根目录
pnpm comment:help

# 或者
pnpm comment:run -- --help
```

帮助里列了全部参数、默认值和示例。

## 5. 先 dry-run（不调接口、不写库）

```bash
cd /Users/fuhui/outsourcing-projects/changan
pnpm comment:run -- --dry-run --last-month --account-type 总部账号
```

输出类似（数字是本机测试库的，生产库会大很多）：

```text
[dry-run] 窗口 2026-10-01 ~ 2026-10-31（last-month）
[dry-run] Instagram：账号 1，帖子 2（评论数>0 的 2），0 帖子账号 0
[dry-run] TikTok：账号 1，帖子 0 ...
```

重点看 **0 帖子账号**：
- 账号数正常、帖子数是 0 → 这个账号在库里没有该时间段的帖子，评论任务没东西可抓（先把帖子任务跑一遍，或换个账号/时间）。
- 账号数是 0 → 账号类型写错了，换 `--account 某个handle` 或检查 `account_categories`。

## 6. 单账号试跑（真实调接口）

```bash
cd /Users/fuhui/outsourcing-projects/changan

# 先只抓 1 个帖子、最多 5 条评论、每条一级评论最多 2 条回复
# 不写 --platforms：程序会识别出 byd.uk 是 Instagram，只跑 Instagram
pnpm comment:run -- \
  --account byd.uk \
  --since 2026-11-01 --until 2026-11-02 \
  --max-posts-per-account 1 \
  --max-comments-per-post 5 \
  --max-replies-per-comment 2

# 如果直接用账号 ID 也一样（不用写平台）
pnpm comment:run -- \
  --account-ids account-ee9d5c45-f17d-4d1e-b392-718a7b402bcc \
  --since 2026-10-01 --until 2026-10-31
```

跑完会打印：

```text
[comment] Instagram run=run-xxxx 窗口 2026-11-01 ~ 2026-11-02，账号 byd.uk，账号 1 个
[instagram] 账号 byd.uk：窗口内 1 个帖子
[instagram] 账号 byd.uk 完成：success，帖子 1，成功 1，失败 0

[instagram] Instagram 完成
  账号 1（成功 1，失败 0，跳过 0）
  帖子 1（有评论 1，失败 0，截断 1）
  评论 一级 3 + 回复 2，新增 5，更新 0，跳过 0
  API 请求 2，耗时 12.4s
  run 状态：success
```

把 `run=run-xxxx` 记下来，后面查库/续跑要用。

## 7. 看结果（SQL）

```bash
cd /Users/fuhui/outsourcing-projects/changan/apps/crawler
export DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-)"

# 最近几次评论 run
psql "$DATABASE_URL" -c "
  select id, platform_id, status, to_timestamp(started_ts_ms/1000) at time zone 'Asia/Shanghai' as started
    from scrape_runs
   where exists (select 1 from scrape_raw_records r
                  where r.run_id = scrape_runs.id and r.record_type = 'comment_post')
   order by started_ts_ms desc limit 5"

# 某个 run 抓到的评论（一级 + 回复）
psql "$DATABASE_URL" -c "
  select id, username, left(text_content, 40) as text,
         like_count, parent_comment_id, root_comment_id,
         to_timestamp(create_timestamp/1000) at time zone 'Asia/Shanghai' as created
    from comment
   where run_id = 'run-xxxx'
   order by parent_comment_id nulls first, create_timestamp
   limit 20"

# 每个帖子的抓取进度/错误
psql "$DATABASE_URL" -c "
  select content_id, url, error_code, error_message,
         raw_json->>'topLevelCount' as top_level,
         raw_json->>'replyCount' as replies
    from scrape_raw_records
   where run_id = 'run-xxxx' and record_type = 'comment_post'"
```

`comment.content_id` 是 `social_contents.id`，不是平台帖子 ID。

## 8. 停止、续跑、重跑

- 运行时按 `Ctrl-C`：当前帖子处理完后停止，run 记为 `failed`（`INTERRUPTED`）。
- 续跑失败 run（沿用原窗口，跳过已完成的账号和帖子）：

```bash
pnpm comment:run -- --account byd.uk --run-id run-xxxx
```

- 想重新抓同一个窗口：**不加 `--run-id`**，会新建一个 run；评论按平台评论 ID upsert，
  不会产生重复行，只会更新点赞数/最后出现时间。

## 9. 跑整月

```bash
cd /Users/fuhui/outsourcing-projects/changan

# 建议先 tee 一份日志
pnpm comment:run -- --last-month --account-type 总部账号 2>&1 | tee /tmp/comment-$(date +%F).log
```

- 只抓一级评论：加 `--no-replies`。
- 控制成本：`--max-comments-per-post 200 --max-replies-per-comment 20`。
- 先跑完 `--platforms instagram` 再接 `tiktok`，可以分平台排查。
- 跑太久可以拆成 `--platforms instagram` / `--platforms tiktok,youtube,x` 两次。

## 10. 常见错误

| 现象 | 原因 / 处理 |
|---|---|
| `缺少 TIKHUB_API_KEY` | `apps/crawler/.env` 没填 Key，或当前 shell 没 export |
| `column "account_id" of relation "comment" does not exist` | 没跑第 2 步迁移 |
| `必须指定账号范围` | 加 `--account-type` / `--account` / `--account-ids`，或显式 `--all-accounts` |
| `未知参数：--platfom` | 参数拼错；平台参数是 `--platforms`（也兼容 `--platform`） |
| 只指定了一个账号，却跑了多个平台 | 旧版本问题：不传 `--platforms` 时默认四个平台。现在省略会按账号反推；升级后重试 |
| 启动打印 `数据库：changan_social_data @ pgm-...` | 当前连的是生产 RDS；想本地试跑先改回本机 `changan_rpa_test` |
| `平台 facebook 没有评论接口` | 评论任务只支持 `instagram/tiktok/youtube/x` |
| `账号类型 xxx 下没有可用账号` | 类型名写错，或该类型没有成员账号；先 dry-run 看账号数 |
| `窗口内 0 个帖子` | 该账号在 `social_contents` 里没有这个时间段的帖子；先跑帖子任务 |
| 401 / 403 | TikHub Key 无效、套餐没开对应接口 |
| `psql: invalid percent-encoded token` | RDS 密码里有 `%`，psql 需要 URL 编码；本地库一般不会遇到 |
| 汇总里 `截断 1` | 到了 `--max-comments-per-post` 上限，属正常；要全量就调大 |

## 11. 什么时候需要服务器

- 手动跑、补数据：本机够了。
- 每月自动跑：按 [DEPLOY.md](../../DEPLOY.md) 第 9.1 节挂 cron / pm2 cron_restart，
  不需要第二个常驻 worker，也不需要 Chrome / Xvfb。
