-- ============================================================
-- 账号类型改为多对多（生产库 changan_social_data）
--
-- 背景：
--   账号原来只用一个 social_accounts.account_type 字符串表示类型，
--   一个账号只能属于一个类型。新需求允许一个账号同时属于多个类型
--   （例如中南美的 5 个 CAOA 账号同时进入周报和月报）。
--
-- 目标结构（表已在 prod-upgrade.sql 中创建）：
--   account_categories        类型字典（code 唯一）
--   account_category_members  账号 <-> 类型，多对多
--
-- 兼容策略：
--   social_accounts.account_type 继续保留，作为“主类型”给旧代码/旧
--   报表读取；Web 端以 account_category_members 为准。
--
-- 本次数据变更：
--   1. 把现有 account_type 的 distinct 值落成分类；
--   2. 为所有账号补 membership；
--   3. 把 5 个「中南美-all」账号加入「中南美-周报」「中南美-月报」，
--      然后移除「中南美-all」归属并下线该类型；
--   4. 清理「港澳」类型（当前库没有该类型/账号，纯兜底）；
--   5. 把已有任务的 account_type 对应到 category_id。
--
-- 可重复执行；建议低峰期执行，执行前备份。
-- ============================================================

begin;

-- 1. 现有 account_type 落成分类 --------------------------------
insert into account_categories (id, code, name, active, created_ts_ms, updated_ts_ms)
select
  'cat-' || substr(md5(t.account_type), 1, 24),
  t.account_type,
  t.account_type,
  true,
  (extract(epoch from clock_timestamp()) * 1000)::bigint,
  (extract(epoch from clock_timestamp()) * 1000)::bigint
from (
  select distinct btrim(account_type) as account_type
    from social_accounts
   where account_type is not null and btrim(account_type) <> ''
  union
  select distinct btrim(account_type)
    from scrape_tasks
   where account_type is not null and btrim(account_type) <> ''
) t
where not exists (
  select 1 from account_categories c
   where c.code = t.account_type or c.name = t.account_type
);

-- 2. 每个账号按当前 account_type 补一条归属 --------------------
insert into account_category_members (account_id, category_id, created_ts_ms)
select a.id, c.id, (extract(epoch from clock_timestamp()) * 1000)::bigint
  from social_accounts a
  join account_categories c on c.code = btrim(a.account_type)
 where a.account_type is not null and btrim(a.account_type) <> ''
on conflict (account_id, category_id) do nothing;

-- 3. 中南美-all 的账号同时加入周报、月报 ----------------------
insert into account_category_members (account_id, category_id, created_ts_ms)
select a.id, c.id, (extract(epoch from clock_timestamp()) * 1000)::bigint
  from social_accounts a
  join account_categories c on c.code in ('中南美-周报', '中南美-月报')
 where btrim(a.account_type) = '中南美-all'
on conflict (account_id, category_id) do nothing;

-- 4. 移除中南美-all 归属，主类型落到周报，然后下线该类型 ------
delete from account_category_members m
 using account_categories c, social_accounts a
 where m.category_id = c.id
   and m.account_id = a.id
   and c.code = '中南美-all'
   and btrim(a.account_type) = '中南美-all';

update social_accounts
   set account_type = '中南美-周报',
       updated_ts_ms = (extract(epoch from clock_timestamp()) * 1000)::bigint
 where btrim(account_type) = '中南美-all';

-- 先解除任务对分类的引用，否则外键会阻止删除分类。
update scrape_tasks t
   set category_id = null
 where t.category_id in (
   select id from account_categories where code = '中南美-all' or name = '中南美-all'
 );

delete from account_categories
 where code = '中南美-all' or name = '中南美-all';

-- 5. 港澳类型不再需要（当前库没有数据，这里做兜底清理） --------
delete from account_category_members m
 using account_categories c
 where m.category_id = c.id
   and (c.code like '%港澳%' or c.name like '%港澳%');

update scrape_tasks t
   set category_id = null
 where t.category_id in (
   select id from account_categories
    where code like '%港澳%' or name like '%港澳%'
 );

delete from account_categories
 where code like '%港澳%' or name like '%港澳%';

-- 6. 已有任务补 category_id（保留 account_type 给旧代码读取） --
update scrape_tasks t
   set category_id = c.id
  from account_categories c
 where t.category_id is null
   and t.account_type is not null
   and c.code = btrim(t.account_type);

commit;

-- ============================================================
-- 执行后自检
-- ============================================================
-- 1) 应只剩 7 个类型：总部、new、中东非、中南美-周报、中南美-月报、临时、欧洲
--    select code, name from account_categories order by name;
--
-- 2) 5 个 CAOA 账号应各有两条归属（周报 + 月报）：
--    select a.handle, array_agg(c.name order by c.name) as types
--      from social_accounts a
--      join account_category_members m on m.account_id = a.id
--      join account_categories c on c.id = m.category_id
--     where a.id in (select id from social_accounts where account_type = '中南美-周报' and handle ilike '%caoa%')
--     group by a.handle;
--
-- 3) 周报任务账号数应为 54（49 + 5），月报应为 88（83 + 5）：
--    select c.name, count(*)::int
--      from account_category_members m
--      join account_categories c on c.id = m.category_id
--     where c.name in ('中南美-周报', '中南美-月报')
--     group by c.name;
