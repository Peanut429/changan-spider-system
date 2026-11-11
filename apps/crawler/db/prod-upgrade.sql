-- ============================================================
-- 生产库（changan_social_data）升级脚本
--
-- 目标：让旧生产库具备新项目（apps/web + apps/crawler worker）
-- 所需的表结构。生产库已有 platforms / social_accounts /
-- social_contents / *_daily_metrics / scrape_runs /
-- scrape_run_accounts / scrape_raw_records / scrape_event_logs，
-- 本脚本补新表、放宽一列约束，并给 comment 表补评论任务需要的列。
--
-- 注意：
--   1. 只补缺失结构，不删旧表、不改旧数据；
--   2. 可重复执行（if not exists / drop not null 幂等）；
--   3. 建议在业务低峰执行，执行前先备份；
--   4. alert_events、scrape_attempts 是旧项目遗留表，新代码不用，
--      保留即可，确认不再需要后再单独删除。
-- ============================================================

begin;

-- 1. 账号分类 -------------------------------------------------
create table if not exists account_categories (
  id text primary key,
  code text not null unique,
  name text not null,
  active boolean not null default true,
  created_ts_ms bigint not null,
  updated_ts_ms bigint not null
);
create index if not exists idx_account_categories_active on account_categories (active);

create table if not exists account_category_members (
  account_id text not null references social_accounts(id) on delete cascade,
  category_id text not null references account_categories(id) on delete cascade,
  created_ts_ms bigint not null,
  primary key (account_id, category_id)
);
create index if not exists idx_account_category_members_category on account_category_members (category_id);

-- 2. 任务队列（Web 建任务、crawler worker 抢任务）-------------
create table if not exists scrape_tasks (
  id text primary key,
  platform_id text not null references platforms(id),
  category_id text references account_categories(id),
  account_type text,
  params jsonb not null default '{}'::jsonb,
  priority int not null default 100,
  status text not null default 'pending',
  scheduled_at_ms bigint not null,
  lease_owner text,
  lease_until_ms bigint,
  attempts int not null default 0,
  run_id text references scrape_runs(id),
  last_error text,
  created_ts_ms bigint not null,
  updated_ts_ms bigint not null,
  constraint ck_scrape_tasks_status check (
    status in ('pending', 'paused', 'running', 'success', 'failed', 'cancelled')
  ),
  constraint ck_scrape_tasks_priority check (priority between 0 and 1000)
);
create index if not exists idx_scrape_tasks_claim on scrape_tasks (status, priority, scheduled_at_ms, created_ts_ms);
create index if not exists idx_scrape_tasks_platform on scrape_tasks (platform_id);
create index if not exists idx_scrape_tasks_run on scrape_tasks (run_id);

-- 3. 放宽 account_type 约束 -----------------------------------
-- 生产库原来是 not null default ''，测试库是 nullable。
-- 新 Web 的账号保存接口在未传类型时会写入 null，生产上会被
-- NOT NULL 拒绝（23502）。这里只去掉 NOT NULL，保留 default ''，
-- 旧项目/爬虫不传该列时仍然写 ''。
alter table social_accounts alter column account_type drop not null;

-- 4. 评论任务（2026-11）-------------------------------------------
-- 现有 comment 表补齐账号/批次/点赞/回复关系，评论任务写这张表。
alter table comment add column if not exists account_id text;
alter table comment add column if not exists run_id text;
alter table comment add column if not exists like_count bigint;
alter table comment add column if not exists reply_count bigint;
alter table comment add column if not exists parent_comment_id text;
alter table comment add column if not exists root_comment_id text;
alter table comment add column if not exists first_seen_ts_ms bigint;
alter table comment add column if not exists last_seen_ts_ms bigint;

create index if not exists idx_comment_account_id on comment (account_id);
create index if not exists idx_comment_run_id on comment (run_id);
create index if not exists idx_comment_parent on comment (parent_comment_id);
create index if not exists idx_comment_root on comment (root_comment_id);

-- 评论任务按「账号 + 发布时间」取帖子，避免月跑时全表扫 social_contents。
create index if not exists idx_social_contents_account_publish
  on social_contents (account_id, publish_ts_ms);

-- 帖子级断点：只索引评论进度行，不增加大表整体索引负担。
create index if not exists idx_raw_comment_post_progress
  on scrape_raw_records (run_id, content_id)
  where record_type = 'comment_post';

-- 表/字段注释：沿用旧 comment 表的注释风格，新增列必须有注释。
comment on table comment is '帖子评论';
-- 旧列注释：生产库已有（见 004_create_comment_table.sql）；这里一并写上，
-- 保证从测试库 schema 重建的库也保持同样的注释，避免字段说明缺失。
comment on column comment.id is '对应平台的评论数据id';
comment on column comment.username is '评论用户昵称';
comment on column comment.user_id is '评论用户id';
comment on column comment.text_content is '评论内容';
comment on column comment.platform is '平台';
comment on column comment.content_id is '评论对应的帖子id';
comment on column comment.create_timestamp is '评论的发布时间';
comment on column comment.account_id is '评论所属账号id（social_accounts.id）';
comment on column comment.run_id is '最后写入该评论的评论任务 run id（scrape_runs.id）';
comment on column comment.like_count is '评论点赞数（平台不提供时为空）';
comment on column comment.reply_count is '评论的回复数（一级评论的回复总数；平台不提供时为空）';
comment on column comment.parent_comment_id is '直接父评论id；一级评论为空';
comment on column comment.root_comment_id is '所属一级评论id；一级评论为空';
comment on column comment.first_seen_ts_ms is '首次抓取到该评论的时间（毫秒）';
comment on column comment.last_seen_ts_ms is '最近一次抓取到该评论的时间（毫秒）';

-- 索引注释：标明这些索引是评论任务加的，避免后续误删。
comment on index idx_comment_account_id is '评论任务：按账号查询评论';
comment on index idx_comment_run_id is '评论任务：按 run 查询评论';
comment on index idx_comment_parent is '评论任务：按父评论查询回复';
comment on index idx_comment_root is '评论任务：按一级评论查询整条回复链';
comment on index idx_social_contents_account_publish is '评论任务：按账号 + 发布时间取帖子';
comment on index idx_raw_comment_post_progress is '评论任务：帖子级断点（只索引 comment_post 行）';

-- 5. 评论抓取任务（Web 手动触发）--------------------------------
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
-- 应返回 3 张新表：
--   select table_name from information_schema.tables
--    where table_schema = 'public'
--      and table_name in ('account_categories','account_category_members','scrape_tasks');
--
-- 应为 YES：
--   select is_nullable from information_schema.columns
--    where table_schema = 'public' and table_name = 'social_accounts'
--      and column_name = 'account_type';
--
-- 平台数据应已存在（6 行，id 形如 plat-youtube）：
--   select id, code, name, enabled from platforms order by code;
--
-- comment 表新增列应为 8 行（评论任务用）：
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'comment'
--      and column_name in (
--        'account_id','run_id','like_count','reply_count',
--        'parent_comment_id','root_comment_id','first_seen_ts_ms','last_seen_ts_ms'
--      );
--
-- comment_jobs 表应已存在（Web 手动触发评论任务）：
--   select table_name from information_schema.tables
--    where table_schema = 'public' and table_name = 'comment_jobs';
--
-- comment_jobs 所有列都应有注释（下面查询应返回 0 行）：
--   select a.attname
--     from pg_attribute a
--    where a.attrelid = 'public.comment_jobs'::regclass
--      and a.attnum > 0 and not a.attisdropped
--      and col_description('public.comment_jobs'::regclass, a.attnum) is null;
--
-- comment 表所有列都应有注释（下面查询应返回 0 行）：
--   select a.attname
--     from pg_attribute a
--    where a.attrelid = 'public.comment'::regclass
--      and a.attnum > 0 and not a.attisdropped
--      and col_description('public.comment'::regclass, a.attnum) is null;
