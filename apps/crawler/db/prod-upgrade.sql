-- ============================================================
-- 生产库（changan_social_data）升级脚本
--
-- 目标：让旧生产库具备新项目（apps/web + apps/crawler worker）
-- 所需的表结构。生产库已有 platforms / social_accounts /
-- social_contents / *_daily_metrics / scrape_runs /
-- scrape_run_accounts / scrape_raw_records / scrape_event_logs，
-- 本脚本只补新表并放宽一列约束。
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
