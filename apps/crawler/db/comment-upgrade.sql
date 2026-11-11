-- ============================================================
-- 评论任务升级脚本（生产库 changan_social_data）
--
-- 目标：让现有 comment 表能承载评论任务新增的字段：
--   account_id / run_id           —— 哪次抓取、哪个账号
--   like_count / reply_count      —— 评论点赞数、回复数
--   parent_comment_id / root_comment_id —— 二级回复的一级评论归属
--   first_seen_ts_ms / last_seen_ts_ms  —— 首次/最近一次抓到的时间
--
-- 注意：
--   1. 只加可空列、索引和字段注释（comment on ...），不动旧数据、不删列；
--   2. 可重复执行（add column / create index / comment on 都是幂等的）；
--   3. 同时已并入 apps/crawler/db/prod-upgrade.sql 第 4 节；
--      已经跑过 prod-upgrade.sql 的库无需重复执行本文件。
-- ============================================================

begin;

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

-- 表/字段注释：沿用旧 comment 表的注释风格（004_create_comment_table.sql），
-- 让 DBA 和数据消费方直接看表结构就能理解每列含义；旧列注释与生产库保持一致。
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

commit;

-- ============================================================
-- 执行后自检
-- ============================================================
-- 应为 8 行（account_id/run_id/like_count/reply_count/
-- parent_comment_id/root_comment_id/first_seen_ts_ms/last_seen_ts_ms）：
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'comment'
--      and column_name in (
--        'account_id','run_id','like_count','reply_count',
--        'parent_comment_id','root_comment_id','first_seen_ts_ms','last_seen_ts_ms'
--      )
--    order by column_name;
--
-- comment 表所有列都应有注释（下面查询应返回 0 行）：
--   select a.attname
--     from pg_attribute a
--    where a.attrelid = 'public.comment'::regclass
--      and a.attnum > 0 and not a.attisdropped
--      and col_description('public.comment'::regclass, a.attnum) is null;
--
-- 表注释应为「帖子评论」：
--   select obj_description('public.comment'::regclass, 'pg_class');
--
-- 旧数据应该不被改动（数量应与执行前一致）：
--   select count(*) from comment;

-- ============================================================
-- 备注
-- ============================================================
-- Web 端「评论抓取」手动触发还需要 comment_jobs 表：
--   psql "$DATABASE_URL" -f db/comment-jobs-upgrade.sql
-- ============================================================
