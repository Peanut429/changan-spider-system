-- ============================================================
-- 评论抓取任务表（Web 手动触发）
--
-- 评论任务只走 TikHub 接口，可以直接在 Web 进程里后台执行。
-- 这张表用来保存每次手动触发的任务、范围和实时进度。
--
-- 注意：
--   1. 只新建表，不修改现有表；
--   2. 可重复执行（create ... if not exists / comment on 幂等）；
--   3. 同时已并入 apps/crawler/db/prod-upgrade.sql 第 5 节。
-- ============================================================

begin;

create table if not exists comment_jobs (
  id text primary key,
  status text not null default 'pending',
  account_ids jsonb not null default '[]'::jsonb,
  platform_codes jsonb not null default '[]'::jsonb,
  window_since_ts_ms bigint not null,
  window_until_ts_ms bigint not null,
  options jsonb not null default '{}'::jsonb,
  total_accounts int not null default 0,
  processed_accounts int not null default 0,
  success_accounts int not null default 0,
  failed_accounts int not null default 0,
  total_posts int not null default 0,
  processed_posts int not null default 0,
  fetched_comments int not null default 0,
  inserted_comments int not null default 0,
  updated_comments int not null default 0,
  failed_posts int not null default 0,
  run_ids jsonb not null default '[]'::jsonb,
  error_message text,
  created_ts_ms bigint not null,
  started_ts_ms bigint,
  finished_ts_ms bigint,
  updated_ts_ms bigint not null,
  constraint ck_comment_jobs_status check (
    status in ('pending', 'running', 'success', 'partial_failed', 'failed', 'cancelled')
  )
);
create index if not exists idx_comment_jobs_status on comment_jobs (status, created_ts_ms desc);
create index if not exists idx_comment_jobs_created on comment_jobs (created_ts_ms desc);

comment on table comment_jobs is '评论抓取任务（Web 手动触发，纯 TikHub 接口）';
comment on column comment_jobs.id is '任务id';
comment on column comment_jobs.status is '任务状态：pending/running/success/partial_failed/failed/cancelled';
comment on column comment_jobs.account_ids is '本次选择的账号id数组（social_accounts.id）';
comment on column comment_jobs.platform_codes is '本次涉及的平台code数组';
comment on column comment_jobs.window_since_ts_ms is '帖子发布时间范围的开始（毫秒，含）';
comment on column comment_jobs.window_until_ts_ms is '帖子发布时间范围的结束（毫秒，含）';
comment on column comment_jobs.options is '抓取选项：includeReplies/maxCommentsPerPost/maxRepliesPerComment/maxPostsPerAccount/includeZeroComments';
comment on column comment_jobs.total_accounts is '本次任务账号数';
comment on column comment_jobs.processed_accounts is '已处理账号数';
comment on column comment_jobs.success_accounts is '成功账号数';
comment on column comment_jobs.failed_accounts is '失败账号数';
comment on column comment_jobs.total_posts is '已发现帖子数（账号加载后累计）';
comment on column comment_jobs.processed_posts is '已处理帖子数';
comment on column comment_jobs.fetched_comments is '已抓取评论数（一级+回复）';
comment on column comment_jobs.inserted_comments is '新写入评论数';
comment on column comment_jobs.updated_comments is '更新已有评论数';
comment on column comment_jobs.failed_posts is '失败帖子数';
comment on column comment_jobs.run_ids is '本次任务创建的 scrape_runs.id 数组（每个平台一条）';
comment on column comment_jobs.error_message is '任务级错误信息';
comment on column comment_jobs.created_ts_ms is '创建时间（毫秒）';
comment on column comment_jobs.started_ts_ms is '开始执行时间（毫秒）';
comment on column comment_jobs.finished_ts_ms is '结束时间（毫秒）';
comment on column comment_jobs.updated_ts_ms is '最近更新时间（毫秒），用于判断任务是否卡住';

comment on index idx_comment_jobs_status is 'Web 页面按状态查询任务';
comment on index idx_comment_jobs_created is 'Web 页面按创建时间倒序查询任务';

commit;

-- ============================================================
-- 执行后自检
-- ============================================================
-- 应返回 1 行：
--   select table_name from information_schema.tables
--    where table_schema = 'public' and table_name = 'comment_jobs';
--
-- 应返回 0 行（所有列都有注释）：
--   select a.attname
--     from pg_attribute a
--    where a.attrelid = 'public.comment_jobs'::regclass
--      and a.attnum > 0 and not a.attisdropped
--      and col_description('public.comment_jobs'::regclass, a.attnum) is null;
