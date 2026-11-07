-- 2026-11-07: allow a pending task to be paused.
-- Run once against every database that already has scrape_tasks.
-- New databases get the same rule from schema.sql / prod-upgrade.sql.

begin;

alter table scrape_tasks
  drop constraint if exists ck_scrape_tasks_status;

alter table scrape_tasks
  add constraint ck_scrape_tasks_status
  check (status in ('pending', 'paused', 'running', 'success', 'failed', 'cancelled'));

commit;

-- Self-check: the definition should contain 'paused'.
-- select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--  where conrelid = 'scrape_tasks'::regclass
--    and conname = 'ck_scrape_tasks_status';
