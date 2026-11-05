-- ============================================================
-- refactor-project 测试库 schema
--
-- 只包含 scrape:daily 爬虫链路用到的表；正式上线前会用生产库
-- `pg_dump --schema-only` 快照校对/替换。
--
-- 仅用于 changan_rpa_test，不要在生产库执行。
-- ============================================================

drop table if exists scrape_tasks cascade;
drop table if exists account_category_members cascade;
drop table if exists account_categories cascade;
drop table if exists scrape_event_logs cascade;
drop table if exists scrape_raw_records cascade;
drop table if exists scrape_run_accounts cascade;
drop table if exists scrape_runs cascade;
drop table if exists content_daily_metrics cascade;
drop table if exists account_daily_metrics cascade;
drop table if exists social_contents cascade;
drop table if exists social_accounts cascade;
drop table if exists comment cascade;
drop table if exists platforms cascade;

-- 1. 平台
create table platforms (
  id text primary key,
  code text not null,
  name text not null,
  enabled boolean not null default true,
  created_ts_ms bigint not null
);
create unique index platforms_code_key on platforms (code);

-- 2. 账号
create table social_accounts (
  id text primary key,
  platform_id text not null,
  handle text not null,
  display_name text,
  profile_url text not null,
  external_account_id text,
  active boolean not null default true,
  metadata_json jsonb not null default '{}'::jsonb,
  created_ts_ms bigint not null,
  updated_ts_ms bigint not null,
  account_type varchar(100),
  constraint uq_social_accounts_platform_handle unique (platform_id, handle)
);
create index idx_social_accounts_platform_id on social_accounts (platform_id);
create index idx_social_accounts_active on social_accounts (active);
create index idx_social_accounts_handle on social_accounts (handle);

-- 3. 内容维表
create table social_contents (
  id text primary key,
  platform_id text not null,
  account_id text not null,
  external_content_id text,
  url text not null,
  content_type text,
  publish_ts_ms bigint,
  first_seen_ts_ms bigint not null,
  last_seen_ts_ms bigint not null,
  title text,
  content_summary text,
  excerpt_fetch_status text not null default 'pending',
  created_ts_ms bigint not null,
  updated_ts_ms bigint not null,
  constraint uq_social_contents_platform_account_external_id
    unique (platform_id, account_id, external_content_id)
);
create index idx_social_contents_platform_id on social_contents (platform_id);
create index idx_social_contents_account_id on social_contents (account_id);
create index idx_social_contents_publish_ts_ms on social_contents (publish_ts_ms desc);
create index idx_social_contents_last_seen_ts_ms on social_contents (last_seen_ts_ms desc);
create index idx_social_contents_type on social_contents (content_type);

-- 4. 账号每日指标
create table account_daily_metrics (
  id text primary key,
  account_id text not null,
  platform_id text not null,
  run_id text not null,
  metric_day_key integer not null,
  captured_ts_ms bigint not null,
  followers_count bigint,
  following_count bigint,
  posts_count bigint,
  content_count_in_window bigint,
  new_content_count bigint,
  error_code text,
  error_message text,
  raw_metric_json jsonb not null default '{}'::jsonb,
  raw_record_id text,
  created_ts_ms bigint not null,
  constraint uq_account_daily_metrics_account_run unique (account_id, run_id)
);
create index idx_account_daily_metrics_account_day on account_daily_metrics (account_id, metric_day_key desc);
create index idx_account_daily_metrics_platform_day on account_daily_metrics (platform_id, metric_day_key desc);
create index idx_account_daily_metrics_run_id on account_daily_metrics (run_id);
create index idx_account_daily_metrics_captured_ts_ms on account_daily_metrics (captured_ts_ms desc);
create index idx_account_daily_metrics_error_code on account_daily_metrics (error_code);
create index idx_account_daily_metrics_raw_record_id on account_daily_metrics (raw_record_id);

-- 5. 内容每日指标
create table content_daily_metrics (
  id text primary key,
  content_id text not null,
  account_id text not null,
  platform_id text not null,
  run_id text not null,
  metric_day_key integer not null,
  captured_ts_ms bigint not null,
  exposure_count bigint,
  read_count bigint,
  play_count bigint,
  like_count bigint,
  comment_count bigint,
  collect_count bigint,
  share_count bigint,
  error_code text,
  error_message text,
  raw_metric_json jsonb not null default '{}'::jsonb,
  raw_record_id text,
  created_ts_ms bigint not null,
  constraint uq_content_daily_metrics_content_run unique (content_id, run_id)
);
create index idx_content_daily_metrics_content_day on content_daily_metrics (content_id, metric_day_key desc);
create index idx_content_daily_metrics_account_day on content_daily_metrics (account_id, metric_day_key desc);
create index idx_content_daily_metrics_platform_day on content_daily_metrics (platform_id, metric_day_key desc);
create index idx_content_daily_metrics_run_id on content_daily_metrics (run_id);
create index idx_content_daily_metrics_captured_ts_ms on content_daily_metrics (captured_ts_ms desc);
create index idx_content_daily_metrics_error_code on content_daily_metrics (error_code);
create index idx_content_daily_metrics_raw_record_id on content_daily_metrics (raw_record_id);

-- 6. 平台级 run
create table scrape_runs (
  id text primary key,
  platform_id text not null,
  parent_run_id text,
  trigger_type text not null,
  status text not null,
  window_since_ts_ms bigint not null,
  window_until_ts_ms bigint not null,
  task_date_key integer not null,
  started_ts_ms bigint not null,
  finished_ts_ms bigint,
  raw_record_count int not null default 0,
  account_metric_count int not null default 0,
  content_metric_count int not null default 0,
  event_log_count int not null default 0,
  total_accounts int not null default 0,
  success_accounts int not null default 0,
  failed_accounts int not null default 0,
  total_contents int not null default 0,
  success_contents int not null default 0,
  failed_contents int not null default 0,
  command text,
  error_code text,
  error_message text,
  created_ts_ms bigint not null,
  constraint ck_scrape_runs_trigger_type check (
    trigger_type in ('scheduled', 'manual', 'retry', 'backfill')
  ),
  constraint ck_scrape_runs_status check (
    status in ('pending', 'running', 'success', 'partial_failed', 'failed', 'cancelled')
  )
);
create index idx_scrape_runs_platform_id on scrape_runs (platform_id);
create index idx_scrape_runs_status on scrape_runs (status);
create index idx_scrape_runs_started_ts_ms on scrape_runs (started_ts_ms desc);
create index idx_scrape_runs_window on scrape_runs (window_since_ts_ms, window_until_ts_ms);
create index idx_scrape_runs_parent_run_id on scrape_runs (parent_run_id);
create index idx_scrape_runs_task_date_key on scrape_runs (task_date_key desc);

-- 7. 账号级 run
create table scrape_run_accounts (
  id text primary key,
  run_id text not null,
  account_id text not null,
  status text not null,
  started_ts_ms bigint,
  finished_ts_ms bigint,
  content_found_count int not null default 0,
  content_saved_count int not null default 0,
  failed_content_count int not null default 0,
  last_step text,
  error_code text,
  error_message text,
  created_ts_ms bigint not null,
  constraint uq_scrape_run_accounts_run_account unique (run_id, account_id),
  constraint ck_scrape_run_accounts_status check (
    status in ('pending', 'running', 'success', 'partial_failed', 'failed', 'skipped')
  )
);
create index idx_scrape_run_accounts_run_id on scrape_run_accounts (run_id);
create index idx_scrape_run_accounts_account_id on scrape_run_accounts (account_id);
create index idx_scrape_run_accounts_status on scrape_run_accounts (status);
create index idx_scrape_run_accounts_error_code on scrape_run_accounts (error_code);

-- 8. 原始抓取记录
create table scrape_raw_records (
  id text primary key,
  run_id text not null,
  account_id text,
  content_id text,
  platform_id text not null,
  record_type text not null,
  source text,
  external_id text,
  url text,
  raw_json jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  captured_ts_ms bigint not null,
  created_ts_ms bigint not null
);
create index idx_scrape_raw_records_run_id on scrape_raw_records (run_id);
create index idx_scrape_raw_records_account_id on scrape_raw_records (account_id);
create index idx_scrape_raw_records_content_id on scrape_raw_records (content_id);
create index idx_scrape_raw_records_platform_id on scrape_raw_records (platform_id);
create index idx_scrape_raw_records_record_type on scrape_raw_records (record_type);
create index idx_scrape_raw_records_external_id on scrape_raw_records (external_id);
create index idx_scrape_raw_records_captured_ts_ms on scrape_raw_records (captured_ts_ms desc);

-- 9. 事件日志
create table scrape_event_logs (
  id text primary key,
  run_id text not null,
  account_run_id text,
  attempt_id text,
  level text not null,
  step text not null,
  message text not null,
  page_url text,
  content_url text,
  selector text,
  duration_ms int,
  error_code text,
  error_stack text,
  context_json jsonb not null default '{}'::jsonb,
  created_ts_ms bigint not null,
  constraint ck_scrape_event_logs_level check (
    level in ('debug', 'info', 'warn', 'error')
  )
);
create index idx_scrape_event_logs_run_id on scrape_event_logs (run_id);
create index idx_scrape_event_logs_level on scrape_event_logs (level);
create index idx_scrape_event_logs_step on scrape_event_logs (step);
create index idx_scrape_event_logs_error_code on scrape_event_logs (error_code);
create index idx_scrape_event_logs_created_ts_ms on scrape_event_logs (created_ts_ms desc);

-- 10. 评论（当前不迁，保留表以便 schema 与生产一致）
create table comment (
  id text primary key,
  username text default '',
  user_id text default '',
  text_content text default '',
  platform varchar(100),
  content_id text,
  create_timestamp bigint default 0
);
create index idx_comment_user_id on comment (user_id);
create index idx_comment_platform on comment (platform);
create index idx_comment_content_id on comment (content_id);
create index idx_comment_create_timestamp on comment (create_timestamp);

-- 11. 账号分类（账号与分类多对多）
create table account_categories (
  id text primary key,
  code text not null unique,
  name text not null,
  active boolean not null default true,
  created_ts_ms bigint not null,
  updated_ts_ms bigint not null
);
create index idx_account_categories_active on account_categories (active);

create table account_category_members (
  account_id text not null references social_accounts(id) on delete cascade,
  category_id text not null references account_categories(id) on delete cascade,
  created_ts_ms bigint not null,
  primary key (account_id, category_id)
);
create index idx_account_category_members_category on account_category_members (category_id);

-- 12. 任务队列（平台/分类/参数都从数据库来）
create table scrape_tasks (
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
    status in ('pending', 'running', 'success', 'failed', 'cancelled')
  ),
  constraint ck_scrape_tasks_priority check (priority between 0 and 1000)
);
create index idx_scrape_tasks_claim on scrape_tasks (status, priority, scheduled_at_ms, created_ts_ms);
create index idx_scrape_tasks_platform on scrape_tasks (platform_id);
create index idx_scrape_tasks_run on scrape_tasks (run_id);
