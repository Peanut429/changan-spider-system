-- 测试/本地验证账号。只在 changan_rpa_test 使用。
insert into platforms(id, code, name, enabled, created_ts_ms)
values
  ('plat-fake', 'fake', 'Fake', true, 1),
  ('plat-youtube', 'youtube', 'YouTube', true, 1),
  ('plat-instagram', 'instagram', 'Instagram', true, 1),
  ('plat-x', 'x', 'X', true, 1),
  ('plat-facebook', 'facebook', 'Facebook', true, 1),
  ('plat-tiktok', 'tiktok', 'TikTok', true, 1),
  ('plat-linkedin', 'linkedin', 'LinkedIn', true, 1)
on conflict (code) do update
set name = excluded.name, enabled = true;

insert into social_accounts(
  id, platform_id, handle, display_name, profile_url, active,
  metadata_json, created_ts_ms, updated_ts_ms, account_type
)
values
  ('account-test-fake', 'plat-fake', 'fake_account', 'fake', 'https://example.com/fake', true, '{}'::jsonb, 1, 1, '总部'),
  ('account-test-yt-byd', 'plat-youtube', 'BYD España', 'BYD España', 'https://www.youtube.com/@BYDAutoSpain', true, '{}'::jsonb, 1, 1, '总部'),
  ('account-test-yt-geely', 'plat-youtube', 'Geely Auto UK', 'Geely Auto UK', 'https://www.youtube.com/@GeelyAutoUK', true, '{}'::jsonb, 1, 1, '总部'),
  ('account-test-ins-byd', 'plat-instagram', 'byd.uk', 'byd.uk', 'https://www.instagram.com/byd.uk', true, '{}'::jsonb, 1, 1, '总部'),
  ('account-test-x-geely', 'plat-x', 'Geely Auto UK', 'Geely Auto UK', 'https://x.com/GeelyAutoUK', true, '{}'::jsonb, 1, 1, '总部'),
  ('account-test-fb-byd', 'plat-facebook', 'BYD UK', 'BYD UK', 'https://www.facebook.com/BYDUnited.Kingdom', true, '{}'::jsonb, 1, 1, '总部'),
  ('account-test-tt-byd', 'plat-tiktok', 'BYD UK', 'BYD UK', 'https://www.tiktok.com/@byd.uk', true, '{}'::jsonb, 1, 1, '总部'),
  ('account-test-li-byd-italia', 'plat-linkedin', 'BYD Italia', 'BYD Italia', 'https://www.linkedin.com/company/byd-italia/posts/?feedView=all', true, '{}'::jsonb, 1, 1, '总部')
on conflict (platform_id, handle) do update
set active = true, account_type = excluded.account_type, profile_url = excluded.profile_url;

-- 本地任务/分类测试数据；不用于生产。
insert into account_categories(id, code, name, active, created_ts_ms, updated_ts_ms)
values ('cat-test-headquarters', 'test-headquarters', '总部账号', true, 1, 1)
on conflict (code) do update
set name = excluded.name, active = true, updated_ts_ms = excluded.updated_ts_ms;

insert into account_category_members(account_id, category_id, created_ts_ms)
select id, 'cat-test-headquarters', 1
from social_accounts
where id like 'account-test-%'
on conflict do nothing;

insert into scrape_tasks(
  id, platform_id, category_id, account_type, params, priority, status,
  scheduled_at_ms, lease_owner, lease_until_ms, attempts, run_id, last_error,
  created_ts_ms, updated_ts_ms
)
values
  ('task-test-youtube-001', 'plat-youtube', 'cat-test-headquarters', null,
   '{"since":"2026-10-20","limit":1}'::jsonb, 100, 'pending',
   (extract(epoch from clock_timestamp())*1000)::bigint, null, null, 0, null, null,
   (extract(epoch from clock_timestamp())*1000)::bigint,
   (extract(epoch from clock_timestamp())*1000)::bigint),
  ('task-test-instagram-001', 'plat-instagram', 'cat-test-headquarters', null,
   '{"since":"2026-10-20","limit":2}'::jsonb, 200, 'pending',
   (extract(epoch from clock_timestamp())*1000)::bigint, null, null, 0, null, null,
   (extract(epoch from clock_timestamp())*1000)::bigint,
   (extract(epoch from clock_timestamp())*1000)::bigint)
on conflict (id) do update
set scheduled_at_ms = excluded.scheduled_at_ms,
    updated_ts_ms = excluded.updated_ts_ms;

-- 本地界面演示：把已有测试 run 挂到任务上，便于查看详情数据。
insert into scrape_tasks(
  id, platform_id, category_id, account_type, params, priority, status,
  scheduled_at_ms, lease_owner, lease_until_ms, attempts, run_id, last_error,
  created_ts_ms, updated_ts_ms
)
select v.task_id, r.platform_id, 'cat-test-headquarters', '总部',
       v.params::jsonb, v.priority, 'success',
       (extract(epoch from to_timestamp(r.task_date_key::text, 'YYYYMMDD'))*1000)::bigint,
       null, null, 1, r.id, null,
       (extract(epoch from to_timestamp(r.task_date_key::text, 'YYYYMMDD'))*1000)::bigint,
       (extract(epoch from to_timestamp(r.task_date_key::text, 'YYYYMMDD'))*1000)::bigint
from (values
  ('task-demo-youtube-001', 'run-b73696dc-43a2-4146-9c54-d3fb6c2dbb59', 10, '{"since":"2026-10-20","limit":0}'),
  ('task-demo-instagram-001', 'run-39fd569e-d907-4242-9ab2-28ff25c906b0', 20, '{"since":"2026-10-20","limit":2}'),
  ('task-demo-x-001', 'run-2e37ce11-a9ce-49e0-8e47-2cc56c5abda5', 30, '{"since":"2026-01-01","limit":1}'),
  ('task-demo-facebook-001', 'run-f22d6f0f-d4b1-4396-98af-0ce5bc7b8836', 40, '{"since":"2026-10-20","limit":0}'),
  ('task-demo-tiktok-001', 'run-d8a637ee-d15b-46c6-8e44-f904e525e404', 50, '{"since":"2026-10-20","limit":1}'),
  ('task-demo-linkedin-001', 'run-a346a452-a415-42c9-86c6-b39e787f8f3d', 60, '{"since":"2026-10-20","limit":1}')
) as v(task_id, run_id, priority, params)
join scrape_runs r on r.id = v.run_id
on conflict (id) do update
set scheduled_at_ms = excluded.scheduled_at_ms,
    updated_ts_ms = excluded.updated_ts_ms;

-- 界面演示：同一天同时有待执行和执行记录。
insert into scrape_tasks(
  id, platform_id, category_id, account_type, params, priority, status,
  scheduled_at_ms, lease_owner, lease_until_ms, attempts, run_id, last_error,
  created_ts_ms, updated_ts_ms
)
values (
  'task-demo-pending-001', 'plat-x', 'cat-test-headquarters', '总部',
  '{"since":"2026-10-20","until":"2026-11-04","limit":1}'::jsonb, 5, 'pending',
  (extract(epoch from timestamptz '2026-11-04 09:30:00+08')*1000)::bigint,
  null, null, 0, null, null,
  (extract(epoch from timestamptz '2026-11-04 09:30:00+08')*1000)::bigint,
  (extract(epoch from timestamptz '2026-11-04 09:30:00+08')*1000)::bigint
)
on conflict (id) do update
set scheduled_at_ms = excluded.scheduled_at_ms,
    updated_ts_ms = excluded.updated_ts_ms;


-- 本地测试账号的展示时间，避免界面出现 1970 年。
update social_accounts
set created_ts_ms = (extract(epoch from timestamptz '2026-11-01 09:00:00+08')*1000)::bigint,
    updated_ts_ms = (extract(epoch from timestamptz '2026-11-01 09:00:00+08')*1000)::bigint
where created_ts_ms = 1;
