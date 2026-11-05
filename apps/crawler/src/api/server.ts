import http from "node:http";
import { loadEnvFile, requiredEnv } from "../config/env.ts";
import { openDatabase } from "../db/factory.ts";
import { prefixedId } from "../core/id.ts";
import { endOfDayInTimeZone, scrapeWindowStartTsMs } from "../core/db-time.ts";

const PORT = Number(process.env.API_PORT || 8787);
const TIME_ZONE = process.env.SCRAPE_TIMEZONE || "Asia/Shanghai";

type Json = Record<string, any>;

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.end(text);
}

function setCors(res: http.ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

function fail(res: http.ServerResponse, status: number, message: string): void {
  send(res, status, { error: message });
}

async function readJson(req: http.IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("请求体超过 1MB");
    chunks.push(Buffer.from(chunk));
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("必须是 JSON 对象");
    return parsed;
  } catch (error: any) {
    throw new Error(`JSON 解析失败：${error.message}`);
  }
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function bool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function iso(ms: unknown): string | null {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

function taskWindowValues(row: any): { start: any; end: any } {
  if (row.window_since_ts_ms != null || row.window_until_ts_ms != null) {
    return { start: row.window_since_ts_ms, end: row.window_until_ts_ms };
  }
  const params = row.params || {};
  let start = params.windowStartTsMs ?? null;
  let end = params.windowEndTsMs ?? null;
  if (start == null && /^\d{4}-\d{2}-\d{2}$/.test(String(params.since || ""))) {
    start = scrapeWindowStartTsMs(params.since, TIME_ZONE);
  }
  if (end == null && /^\d{4}-\d{2}-\d{2}$/.test(String(params.until || ""))) {
    end = endOfDayInTimeZone(Number(String(params.until).replace(/-/g, "")), TIME_ZONE);
  }
  return { start, end };
}

function taskRow(row: any): Json {
  const window = taskWindowValues(row);
  return {
    id: row.id,
    platformId: row.platform_id,
    platformCode: row.platform_code,
    platformName: row.platform_name,
    accountType: row.account_type,
    params: row.params || {},
    priority: Number(row.priority),
    status: row.task_status,
    scheduledAt: iso(row.scheduled_at_ms),
    attempts: Number(row.attempts || 0),
    runId: row.run_id,
    lastError: row.last_error,
    runStatus: row.run_status,
    runStartedAt: iso(row.started_ts_ms),
    runFinishedAt: iso(row.finished_ts_ms),
    totalAccounts: Number(row.total_accounts || 0),
    plannedAccounts: Number(row.planned_accounts || 0),
    successAccounts: Number(row.success_accounts || 0),
    failedAccounts: Number(row.failed_accounts || 0),
    accountMetricCount: Number(row.account_metric_count || 0),
    contentMetricCount: Number(row.content_metric_count || 0),
    rawRecordCount: Number(row.raw_record_count || 0),
    runError: row.error_message,
    windowSince: iso(window.start),
    windowUntil: iso(window.end),
  };
}

const taskSelect = `
  select t.id, t.platform_id, p.code as platform_code, p.name as platform_name,
         t.account_type, t.params, t.priority,
         t.status as task_status, t.scheduled_at_ms, t.attempts, t.run_id, t.last_error,
         r.status as run_status, r.started_ts_ms, r.finished_ts_ms,
         r.total_accounts, r.success_accounts, r.failed_accounts,
         r.account_metric_count, r.content_metric_count, r.raw_record_count,
         r.error_message, r.task_date_key, r.window_since_ts_ms, r.window_until_ts_ms,
         (
           select count(*)::int
             from social_accounts a
            where a.platform_id = t.platform_id
              and a.active = true
              and (t.account_type is null or a.account_type = t.account_type)
              and (t.category_id is null or exists (
                select 1 from account_category_members m
                 where m.account_id = a.id and m.category_id = t.category_id
              ))
              and (coalesce(t.params->>'account', '') = '' or a.handle = t.params->>'account')
         ) as planned_accounts
    from scrape_tasks t
    join platforms p on p.id = t.platform_id
    left join scrape_runs r on r.id = t.run_id
`;


async function createTask(pool: any, body: Json): Promise<Json> {
  const platformId = text(body.platformId);
  const accountType = text(body.accountType) || null;
  const scheduledAtRaw = text(body.scheduledAt);
  const windowStart = text(body.windowStart);
  const windowEnd = text(body.windowEnd);
  const limit = Number(body.limit ?? 0);
  const priority = Number(body.priority ?? 100);

  if (!platformId) throw new Error("请选择平台");
  if (!scheduledAtRaw) throw new Error("请选择计划执行时间");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(windowStart) || !/^\d{4}-\d{2}-\d{2}$/.test(windowEnd)) {
    throw new Error("抓取时间范围必须是 YYYY-MM-DD");
  }
  if (windowStart > windowEnd) throw new Error("抓取开始日期不能晚于结束日期");
  if (!Number.isInteger(limit) || limit < 0) throw new Error("内容上限必须是非负整数");
  if (!Number.isInteger(priority) || priority < 0 || priority > 1000) throw new Error("优先级必须是 0~1000 的整数");
  const scheduledAtMs = Date.parse(scheduledAtRaw);
  if (!Number.isFinite(scheduledAtMs)) throw new Error("计划执行时间格式无效");
  const windowStartTsMs = scrapeWindowStartTsMs(windowStart, TIME_ZONE);
  const windowEndTsMs = endOfDayInTimeZone(Number(windowEnd.replace(/-/g, "")), TIME_ZONE);

  const platform = await pool.query("select id from platforms where id = $1 and enabled = true", [platformId]);
  if (!platform.rows.length) throw new Error("平台不存在或已停用");

  const id = prefixedId("task");
  const now = Date.now();
  await pool.query(
    `insert into scrape_tasks(
       id, platform_id, category_id, account_type, params, priority, status,
       scheduled_at_ms, lease_owner, lease_until_ms, attempts, run_id, last_error,
       created_ts_ms, updated_ts_ms
     ) values ($1, $2, $3, $4, $5::jsonb, $6, 'pending', $7, null, null, 0, null, null, $8, $8)`,
    [id, platformId, null, accountType, JSON.stringify({
      since: windowStart,
      until: windowEnd,
      limit,
      timezone: TIME_ZONE,
      windowStartTsMs,
      windowEndTsMs,
    }), priority, scheduledAtMs, now],
  );
  const created = await pool.query(`${taskSelect} where t.id = $1`, [id]);
  return taskRow(created.rows[0]);
}

async function listTasks(pool: any, date: string): Promise<Json> {
  const pendingResult = await pool.query(
    `${taskSelect}
      where t.status = 'pending'
        and (to_timestamp(t.scheduled_at_ms / 1000) at time zone $2)::date = $1::date
      order by t.priority asc, t.scheduled_at_ms asc, t.created_ts_ms asc`,
    [date, TIME_ZONE],
  );
  const executedResult = await pool.query(
    `${taskSelect}
      where t.status in ('running', 'success', 'failed', 'cancelled')
        and (to_timestamp(coalesce(r.started_ts_ms, t.scheduled_at_ms) / 1000) at time zone $2)::date = $1::date
      order by coalesce(r.started_ts_ms, t.scheduled_at_ms) asc, t.priority asc`,
    [date, TIME_ZONE],
  );
  const pending = pendingResult.rows.map(taskRow);
  const executed = executedResult.rows.map(taskRow);
  const summary = {
    pending: pending.length,
    running: executed.filter((task) => task.status === "running").length,
    success: executed.filter((task) => task.status === "success").length,
    failed: executed.filter((task) => task.status === "failed").length,
    cancelled: executed.filter((task) => task.status === "cancelled").length,
    accountsSuccess: executed.reduce((sum, task) => sum + task.successAccounts, 0),
    accountsFailed: executed.reduce((sum, task) => sum + task.failedAccounts, 0),
    contentsSuccess: executed.reduce((sum, task) => sum + task.contentMetricCount, 0),
  };
  return { date, summary, pending, executed };
}

async function taskDetail(pool: any, id: string): Promise<Json | null> {
  const taskResult = await pool.query(`${taskSelect} where t.id = $1`, [id]);
  if (!taskResult.rows.length) return null;
  const task = taskRow(taskResult.rows[0]);
  if (!task.runId) return { task, run: null, accounts: [], contents: [] };

  const runResult = await pool.query(
    `select id, status, trigger_type, window_since_ts_ms, window_until_ts_ms,
            task_date_key, started_ts_ms, finished_ts_ms,
            raw_record_count, account_metric_count, content_metric_count,
            total_accounts, success_accounts, failed_accounts,
            total_contents, success_contents, failed_contents,
            error_code, error_message
       from scrape_runs where id = $1`,
    [task.runId],
  );
  const accountsResult = await pool.query(
    `select ra.id, ra.status, ra.started_ts_ms, ra.finished_ts_ms,
            ra.content_found_count, ra.content_saved_count, ra.failed_content_count,
            ra.error_code, ra.error_message,
            a.id as account_id, a.handle, a.display_name, a.profile_url,
            p.code as platform_code,
            am.followers_count, am.following_count, am.posts_count,
            am.content_count_in_window, am.new_content_count
       from scrape_run_accounts ra
       join social_accounts a on a.id = ra.account_id
       join platforms p on p.id = a.platform_id
       left join account_daily_metrics am
         on am.run_id = ra.run_id and am.account_id = ra.account_id
      where ra.run_id = $1
      order by a.handle`,
    [task.runId],
  );
  const contentsResult = await pool.query(
    `select c.id, c.external_content_id, c.url, c.content_type, c.title,
            c.content_summary, c.publish_ts_ms,
            m.play_count, m.like_count, m.comment_count, m.share_count,
            m.collect_count, m.read_count, m.exposure_count, m.error_message,
            c.account_id, a.handle as account_handle
       from content_daily_metrics m
       join social_contents c on c.id = m.content_id
       join social_accounts a on a.id = c.account_id
      where m.run_id = $1
      order by c.publish_ts_ms desc nulls last`,
    [task.runId],
  );

  const run = runResult.rows[0] || null;
  return {
    task,
    run: run ? {
      id: run.id,
      status: run.status,
      triggerType: run.trigger_type,
      windowSince: iso(run.window_since_ts_ms),
      windowUntil: iso(run.window_until_ts_ms),
      startedAt: iso(run.started_ts_ms),
      finishedAt: iso(run.finished_ts_ms),
      rawRecordCount: Number(run.raw_record_count || 0),
      accountMetricCount: Number(run.account_metric_count || 0),
      contentMetricCount: Number(run.content_metric_count || 0),
      totalAccounts: Number(run.total_accounts || 0),
      successAccounts: Number(run.success_accounts || 0),
      failedAccounts: Number(run.failed_accounts || 0),
      totalContents: Number(run.total_contents || 0),
      successContents: Number(run.success_contents || 0),
      failedContents: Number(run.failed_contents || 0),
      errorCode: run.error_code,
      errorMessage: run.error_message,
    } : null,
    accounts: accountsResult.rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      handle: row.handle,
      displayName: row.display_name,
      profileUrl: row.profile_url,
      platformCode: row.platform_code,
      status: row.status,
      startedAt: iso(row.started_ts_ms),
      finishedAt: iso(row.finished_ts_ms),
      contentFoundCount: Number(row.content_found_count || 0),
      contentSavedCount: Number(row.content_saved_count || 0),
      failedContentCount: Number(row.failed_content_count || 0),
      followersCount: row.followers_count == null ? null : Number(row.followers_count),
      followingCount: row.following_count == null ? null : Number(row.following_count),
      postsCount: row.posts_count == null ? null : Number(row.posts_count),
      contentCountInWindow: row.content_count_in_window == null ? null : Number(row.content_count_in_window),
      newContentCount: row.new_content_count == null ? null : Number(row.new_content_count),
      errorCode: row.error_code,
      errorMessage: row.error_message,
    })),
    contents: contentsResult.rows.map((row) => ({
      id: row.id,
      externalContentId: row.external_content_id,
      url: row.url,
      contentType: row.content_type,
      title: row.title,
      summary: row.content_summary,
      publishTime: iso(row.publish_ts_ms),
      playCount: row.play_count == null ? null : Number(row.play_count),
      likeCount: row.like_count == null ? null : Number(row.like_count),
      commentCount: row.comment_count == null ? null : Number(row.comment_count),
      shareCount: row.share_count == null ? null : Number(row.share_count),
      collectCount: row.collect_count == null ? null : Number(row.collect_count),
      readCount: row.read_count == null ? null : Number(row.read_count),
      exposureCount: row.exposure_count == null ? null : Number(row.exposure_count),
      errorMessage: row.error_message,
      accountId: row.account_id,
      accountHandle: row.account_handle,
    })),
  };
}

async function listAccounts(pool: any, url: URL): Promise<Json> {
  const conditions = ["p.code <> 'fake'"];
  const values: any[] = [];
  const platformId = url.searchParams.get("platformId");
  const accountType = url.searchParams.get("accountType");
  const active = url.searchParams.get("active");
  const q = text(url.searchParams.get("q"));
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("pageSize") || "20", 10) || 20));
  if (platformId) { values.push(platformId); conditions.push(`a.platform_id = $${values.length}`); }
  if (accountType) { values.push(accountType); conditions.push(`a.account_type = $${values.length}`); }
  if (active === "true" || active === "false") {
    values.push(active === "true"); conditions.push(`a.active = $${values.length}`);
  }
  if (q) {
    values.push(`%${q}%`);
    conditions.push(`(a.handle ilike $${values.length} or coalesce(a.display_name, '') ilike $${values.length})`);
  }

  const countResult = await pool.query(
    `select count(*)::int as total,
            count(*) filter (where a.active)::int as active
       from social_accounts a
       join platforms p on p.id = a.platform_id
      where ${conditions.join(" and ")}`,
    values,
  );
  const total = Number(countResult.rows[0]?.total || 0);
  const activeCount = Number(countResult.rows[0]?.active || 0);

  const dataValues = [...values, pageSize, (page - 1) * pageSize];
  const result = await pool.query(
    `select a.id, a.platform_id, p.code as platform_code, p.name as platform_name,
            a.handle, a.display_name, a.profile_url, a.external_account_id,
            a.active, a.account_type, a.created_ts_ms, a.updated_ts_ms
       from social_accounts a
       join platforms p on p.id = a.platform_id
      where ${conditions.join(" and ")}
      order by p.code asc, a.handle asc
      limit $${dataValues.length - 1} offset $${dataValues.length}`,
    dataValues,
  );
  return {
    accounts: result.rows.map((row) => ({
      id: row.id,
      platformId: row.platform_id,
      platformCode: row.platform_code,
      platformName: row.platform_name,
      handle: row.handle,
      displayName: row.display_name,
      profileUrl: row.profile_url,
      externalAccountId: row.external_account_id,
      active: row.active,
      accountType: row.account_type,
      createdAt: iso(row.created_ts_ms),
      updatedAt: iso(row.updated_ts_ms),
    })),
    total,
    activeCount,
    inactiveCount: total - activeCount,
    page,
    pageSize,
  };
}

async function listPlatforms(pool: any): Promise<Json[]> {
  const result = await pool.query("select id, code, name, enabled from platforms where enabled = true and code <> 'fake' order by name");
  return result.rows;
}

async function listAccountTypes(pool: any): Promise<string[]> {
  const result = await pool.query(
    `select account_type from (
       select distinct account_type
         from social_accounts
        where account_type is not null and btrim(account_type) <> ''
     ) types
     order by case when account_type = '总部' then 0 else 1 end, account_type`,
  );
  return result.rows.map((row) => row.account_type);
}

async function importAccounts(pool: any, body: Json): Promise<Json> {
  const rows = Array.isArray(body.accounts) ? body.accounts : [];
  const accountType = text(body.accountType);
  if (!rows.length) throw new Error("没有可导入的账号");
  if (rows.length > 2000) throw new Error("单次最多导入 2000 个账号");
  if (!accountType) throw new Error("请选择账号类型");
  if (accountType.length > 100) throw new Error("账号类型不能超过 100 个字符");

  const client = await pool.connect();
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];
  try {
    await client.query("begin");
    for (const raw of rows) {
      if (!raw || typeof raw !== "object") { skipped += 1; continue; }
      const platformCode = text((raw as Json).platformCode).toLowerCase();
      const handle = text((raw as Json).handle);
      const profileUrl = text((raw as Json).profileUrl);
      const displayName = text((raw as Json).displayName) || handle;
      if (!platformCode || !handle || !profileUrl) {
        errors.push(`账号 ${handle || "(空)"} 缺少平台、标识或链接`);
        skipped += 1;
        continue;
      }
      try {
        const platform = await client.query("select id from platforms where code = $1 and enabled = true", [platformCode]);
        if (!platform.rows.length) {
          errors.push(`${handle} 的平台 ${platformCode} 不存在`);
          skipped += 1;
          continue;
        }
        const platformId = platform.rows[0].id;
        const now = Date.now();
        const existing = await client.query(
          "select id from social_accounts where platform_id = $1 and handle = $2",
          [platformId, handle],
        );
        if (existing.rows.length) {
          await client.query(
            "update social_accounts set account_type = $2, updated_ts_ms = $3 where id = $1",
            [existing.rows[0].id, accountType, now],
          );
          updated += 1;
        } else {
          await client.query(
            `insert into social_accounts(
               id, platform_id, handle, display_name, profile_url, active,
               metadata_json, created_ts_ms, updated_ts_ms, account_type
             ) values ($1, $2, $3, $4, $5, true, '{"source":"excel_import"}'::jsonb, $6, $6, $7)`,
            [prefixedId("account"), platformId, handle, displayName, profileUrl, now, accountType],
          );
          created += 1;
        }
      } catch (error: any) {
        errors.push(`${handle || "(空)"} 导入失败：${error.message}`);
        skipped += 1;
      }
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return { created, updated, skipped, errors };
}

async function saveAccount(
  pool: any,
  body: Json,
  existingId?: string,
): Promise<Json> {
  const platformId = text(body.platformId);
  const handle = text(body.handle);
  const displayName = text(body.displayName) || null;
  const profileUrl = text(body.profileUrl);
  const accountType = text(body.accountType) || null;
  const active = bool(body.active, true);

  if (!existingId && !platformId) throw new Error("缺少 platformId");
  if (!handle) throw new Error("缺少 handle");
  if (!profileUrl) throw new Error("缺少 profileUrl");

  const client = await pool.connect();
  try {
    await client.query("begin");
    let accountId = existingId || "";
    if (existingId) {
      const updated = await client.query(
        `update social_accounts
            set handle = $2, display_name = $3, profile_url = $4,
                account_type = $5, active = $6, updated_ts_ms = $7
          where id = $1
          returning id`,
        [existingId, handle, displayName, profileUrl, accountType, active, Date.now()],
      );
      if (!updated.rows.length) throw new Error("账号不存在");
    } else {
      accountId = prefixedId("account");
      const now = Date.now();
      await client.query(
        `insert into social_accounts(
           id, platform_id, handle, display_name, profile_url, active,
           metadata_json, created_ts_ms, updated_ts_ms, account_type
         ) values ($1, $2, $3, $4, $5, $6, '{}'::jsonb, $7, $7, $8)`,
        [accountId, platformId, handle, displayName, profileUrl, active, now, accountType],
      );
    }

    await client.query("commit");
    const saved = await pool.query(
      `select a.id, a.platform_id, p.code as platform_code, p.name as platform_name,
              a.handle, a.display_name, a.profile_url, a.active, a.account_type
         from social_accounts a
         join platforms p on p.id = a.platform_id
        where a.id = $1`,
      [accountId],
    );

    return saved.rows[0];
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const handle = openDatabase(requiredEnv("DATABASE_URL"), Number(process.env.DB_POOL_MAX || 10));
  const server = http.createServer(async (req, res) => {
    try {
      setCors(res);
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }
      const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
      const path = url.pathname;
      if (req.method === "GET" && path === "/api/health") {
        return send(res, 200, { ok: true });
      }
      if (req.method === "GET" && path === "/api/tasks") {
        const date = text(url.searchParams.get("date"));
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(res, 400, "date 必须是 YYYY-MM-DD");
        return send(res, 200, await listTasks(handle.pool, date));
      }
      const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
      if (req.method === "GET" && taskMatch) {
        const detail = await taskDetail(handle.pool, decodeURIComponent(taskMatch[1]));
        return detail ? send(res, 200, detail) : fail(res, 404, "任务不存在");
      }
      const taskRetryMatch = path.match(/^\/api\/tasks\/([^/]+)\/retry$/);
      if (req.method === "POST" && taskRetryMatch) {
        const id = decodeURIComponent(taskRetryMatch[1]);
        const current = await handle.pool.query("select status from scrape_tasks where id = $1", [id]);
        if (!current.rows.length) return fail(res, 404, "任务不存在");
        if (current.rows[0].status !== "failed") return fail(res, 409, "只有失败任务可以继续执行");
        await handle.pool.query(
          `update scrape_tasks
              set status = 'pending',
                  scheduled_at_ms = $2,
                  lease_owner = null,
                  lease_until_ms = null,
                  last_error = null,
                  updated_ts_ms = $2
            where id = $1`,
          [id, Date.now()],
        );
        const task = await handle.pool.query(`${taskSelect} where t.id = $1`, [id]);
        return send(res, 200, { task: taskRow(task.rows[0]) });
      }
      if (req.method === "DELETE" && taskMatch) {
        const id = decodeURIComponent(taskMatch[1]);
        const current = await handle.pool.query("select status from scrape_tasks where id = $1", [id]);
        if (!current.rows.length) return fail(res, 404, "任务不存在");
        if (current.rows[0].status !== "pending") return fail(res, 409, "只有待执行任务可以删除");
        await handle.pool.query("delete from scrape_tasks where id = $1 and status = 'pending'", [id]);
        return send(res, 200, { ok: true, id });
      }
      if (req.method === "GET" && path === "/api/accounts") {
        return send(res, 200, await listAccounts(handle.pool, url));
      }
      if (req.method === "GET" && path === "/api/platforms") {
        return send(res, 200, { platforms: await listPlatforms(handle.pool) });
      }
      if (req.method === "GET" && path === "/api/account-types") {
        return send(res, 200, { accountTypes: await listAccountTypes(handle.pool) });
      }
      if (req.method === "POST" && path === "/api/tasks") {
        const body = await readJson(req);
        return send(res, 201, { task: await createTask(handle.pool, body) });
      }
      if (req.method === "POST" && path === "/api/accounts") {
        const body = await readJson(req);
        return send(res, 201, { account: await saveAccount(handle.pool, body) });
      }
      if (req.method === "POST" && path === "/api/accounts/import") {
        const body = await readJson(req);
        return send(res, 200, await importAccounts(handle.pool, body));
      }
      const accountMatch = path.match(/^\/api\/accounts\/([^/]+)$/);
      if (req.method === "PUT" && accountMatch) {
        const body = await readJson(req);
        return send(res, 200, { account: await saveAccount(handle.pool, body, decodeURIComponent(accountMatch[1])) });
      }
      const activeMatch = path.match(/^\/api\/accounts\/([^/]+)\/active$/);
      if (req.method === "PATCH" && activeMatch) {
        const body = await readJson(req);
        const id = decodeURIComponent(activeMatch[1]);
        const active = bool(body.active, true);
        const result = await handle.pool.query(
          "update social_accounts set active = $2, updated_ts_ms = $3 where id = $1 returning id",
          [id, active, Date.now()],
        );
        if (!result.rows.length) return fail(res, 404, "账号不存在");
        return send(res, 200, { ok: true, id, active });
      }
      return fail(res, 404, "接口不存在");
    } catch (error: any) {
      const message = error?.message || String(error);
      if (error?.code === "23505") return fail(res, 409, "同一平台下 handle 已存在");
      console.error(`[api] ${req.method} ${req.url} ${message}`);
      return fail(res, 400, message);
    }
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`API 已启动：http://127.0.0.1:${PORT}`);
  });

  const shutdown = async () => {
    server.close();
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
