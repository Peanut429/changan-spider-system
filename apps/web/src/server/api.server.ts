import { openDatabase } from "@changan/db";
import {
  createCommentJob,
  getCommentJob,
  listCommentJobs,
  listFailedCommentPosts,
  retryFailedCommentJob,
} from "./comment-jobs.server.ts";
import { prefixedId, endOfDayInTimeZone, scrapeWindowStartTsMs, dayKeyInTimeZone } from "@changan/shared";

const TIME_ZONE = process.env.SCRAPE_TIMEZONE || "Asia/Shanghai";

type Json = Record<string, any>;

let dbHandle: ReturnType<typeof openDatabase> | null = null;

function getDb() {
  if (!dbHandle) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("缺少 DATABASE_URL");
    dbHandle = openDatabase(url, Number(process.env.DB_POOL_MAX || 10));
  }
  return dbHandle;
}

function json(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function fail(status: number, message: string): Response {
  return json(status, { error: message });
}

async function readJson(request: Request): Promise<Json> {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 1024 * 1024) throw new Error("请求体超过 1MB");
  const text = await request.text();
  if (!text) return {};
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

function databaseTarget(): { database: string; host: string; remote: boolean } {
  const url = String(process.env.DATABASE_URL || "");
  const match = url.match(/^postgres(?:ql)?:\/\/[^@]*@([^/:?]+)(?::\d+)?\/([^?]+)/i);
  if (!match) return { database: "(无法解析)", host: "(无法解析)", remote: true };
  const remote = !/^(localhost|127\.0\.0\.1|::1)$/i.test(match[1]);
  return { database: match[2], host: match[1], remote };
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
    parentTaskId: row.params?.parentTaskId || null,
    taskKind: row.params?.taskKind || null,
    priority: Number(row.priority),
    status: row.task_status,
    scheduledAt: iso(row.scheduled_at_ms),
    attempts: Number(row.attempts || 0),
    runId: row.run_id,
    lastError: row.last_error,
    runStatus: row.run_status,
    runErrorCode: row.error_code,
    runStartedAt: iso(row.started_ts_ms),
    runFinishedAt: iso(row.finished_ts_ms),
    totalAccounts: Number(row.total_accounts || 0),
    plannedAccounts: Number(row.planned_accounts || 0),
    successAccounts: Number(row.success_accounts || 0),
    failedAccounts: Number(row.failed_accounts || 0),
    newAccounts: 0,
    coverageTotal: Number(row.planned_accounts || 0),
    accountMetricCount: Number(row.account_metric_count || 0),
    contentMetricCount: Number(row.content_metric_count || 0),
    rawRecordCount: Number(row.raw_record_count || 0),
    runError: row.error_message,
    windowSince: iso(window.start),
    windowUntil: iso(window.end),
    yesterday: null,
  };
}

const ACCOUNT_FAILURE_CODES = new Set(["PARTIAL_ACCOUNTS_FAILED", "ALL_ACCOUNTS_FAILED"]);

/**
 * Account types are a many-to-many relation. The array is read on the account
 * row so list/save share one shape; `a` is the account table alias.
 */
const accountTypesSelect = `
  coalesce((
    select array_agg(c.name order by case when c.name = '总部' then 0 else 1 end, c.name)
      from account_category_members m
      join account_categories c on c.id = m.category_id
     where m.account_id = a.id and c.active
  ), array[]::text[]) as account_types
`;

function accountDto(row: any): Json {
  const types: string[] = Array.isArray(row.account_types) ? row.account_types : [];
  return {
    id: row.id,
    platformId: row.platform_id,
    platformCode: row.platform_code,
    platformName: row.platform_name,
    handle: row.handle,
    displayName: row.display_name,
    profileUrl: row.profile_url,
    externalAccountId: row.external_account_id ?? null,
    active: row.active,
    accountType: types[0] || row.account_type || null,
    accountTypes: types.length ? types : row.account_type ? [row.account_type] : [],
    createdAt: iso(row.created_ts_ms),
    updatedAt: iso(row.updated_ts_ms),
  };
}

/** Resolve a type name to a category, creating the dictionary entry if needed. */
async function ensureCategory(client: any, rawName: string): Promise<{ id: string; name: string }> {
  const name = text(rawName).trim();
  if (!name) throw new Error("账号类型不能为空");
  if (name.length > 100) throw new Error("账号类型不能超过 100 个字符");
  const existing = await client.query(
    "select id, name, active from account_categories where code = $1 or name = $1 order by active desc limit 1",
    [name],
  );
  if (existing.rows.length) {
    const row = existing.rows[0];
    if (!row.active) {
      await client.query(
        "update account_categories set active = true, updated_ts_ms = $2 where id = $1",
        [row.id, Date.now()],
      );
    }
    return { id: row.id, name: row.name };
  }
  const id = prefixedId("cat");
  const now = Date.now();
  await client.query(
    `insert into account_categories(id, code, name, active, created_ts_ms, updated_ts_ms)
     values ($1, $2, $3, true, $4, $4)
     on conflict (code) do nothing`,
    [id, name, name, now],
  );
  const created = await client.query("select id, name from account_categories where code = $1", [name]);
  return { id: created.rows[0].id, name: created.rows[0].name };
}

type CoverageLike = {
  total?: number;
  success?: number;
  failed?: number;
  newAccounts?: number;
  running?: number;
  queued?: number;
  contentCount?: number;
  yesterday?: Json | null;
  /** The child task that is currently queued for a rerun, if any. */
  activeRerun?: Json | null;
};

/**
 * A retry is stored as a child task with its own run, so the parent task and its
 * first run keep the status of that first attempt. That leaves a task saying
 * "partial_failed" forever after a retry fixes every account. Resolve the status
 * from the latest result of each account instead, but only when the original
 * failure was account-level: timeouts and script crashes keep their own status.
 */
function resolveTaskStatus(task: Json, coverage: CoverageLike): { status: string; runStatus: string | null } {
  const status = String(task.status || "");
  const runStatus = (task.runStatus as string | null) ?? null;

  if (status !== "success" && status !== "failed") return { status, runStatus };

  const accountFailure = runStatus === "partial_failed" || ACCOUNT_FAILURE_CODES.has(String(task.runErrorCode || ""));
  if (!accountFailure) return { status, runStatus };

  const total = Number(coverage.total || 0);
  const success = Number(coverage.success || 0);
  const failed = Number(coverage.failed || 0);
  const running = Number(coverage.running || 0);
  const newAccounts = Number(coverage.newAccounts || 0);

  // Accounts that were never attempted say nothing about the outcome.
  if (total - newAccounts <= 0) return { status, runStatus };
  if (running > 0) return { status: "running", runStatus: "running" };
  if (failed === 0) return { status: "success", runStatus: "success" };
  if (success === 0) return { status: "failed", runStatus: "failed" };
  return { status: "failed", runStatus: "partial_failed" };
}

function applyCoverage(task: Json, coverage: CoverageLike): Json {
  task.successAccounts = Number(coverage.success || 0);
  task.failedAccounts = Number(coverage.failed || 0);
  task.newAccounts = Number(coverage.newAccounts || 0);
  task.coverageTotal = Number(coverage.total || 0);
  // Accounts can be successful (their last attempt worked) and still be waiting
  // for a rerun. The coverage counts stay based on the last completed attempt;
  // the queue is a separate overlay so the list never claims a queued rerun has
  // already produced fresh data.
  task.queuedAccounts = Number(coverage.queued || 0);
  task.activeRerun = coverage.activeRerun ?? null;
  // A retry lives in a child task with its own run, so the parent run's
  // content_metric_count stays at whatever the first attempt saved. The rows
  // the detail page shows come from every run, so the list has to use that
  // same count instead of the stale first-run value.
  if (coverage.contentCount != null) task.contentMetricCount = Number(coverage.contentCount);
  task.yesterday = coverage.yesterday ?? null;
  const resolved = resolveTaskStatus(task, coverage);
  task.status = resolved.status;
  task.runStatus = resolved.runStatus;
  return task;
}

const taskSelect = `
  select t.id, t.platform_id, p.code as platform_code, p.name as platform_name,
         t.category_id, coalesce(c.name, t.account_type) as account_type,
         t.params, t.priority,
         t.status as task_status, t.scheduled_at_ms, t.attempts, t.run_id, t.last_error,
         r.status as run_status, r.started_ts_ms, r.finished_ts_ms,
         r.total_accounts, r.success_accounts, r.failed_accounts,
         r.account_metric_count, r.content_metric_count, r.raw_record_count,
         r.error_message, r.error_code, r.task_date_key, r.window_since_ts_ms, r.window_until_ts_ms,
         (
           select count(*)::int
             from social_accounts a
            where a.platform_id = t.platform_id
              and a.active = true
              and (
                (t.category_id is not null and exists (
                  select 1 from account_category_members m
                   where m.account_id = a.id and m.category_id = t.category_id
                ))
                or (t.category_id is null and (t.account_type is null or a.account_type = t.account_type))
              )
              and (coalesce(t.params->>'account', '') = '' or a.handle = t.params->>'account')
         ) as planned_accounts
    from scrape_tasks t
    join platforms p on p.id = t.platform_id
    left join account_categories c on c.id = t.category_id
    left join scrape_runs r on r.id = t.run_id
`;


/** Fields shared by every task in a batch; platforms are validated separately. */
function parseTaskFields(body: Json) {
  const accountType = text(body.accountType) || null;
  const scheduledAtRaw = text(body.scheduledAt);
  const windowStart = text(body.windowStart);
  const windowEnd = text(body.windowEnd);
  const limit = Number(body.limit ?? 0);
  const priority = Number(body.priority ?? 100);

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

  return {
    accountType,
    scheduledAtMs,
    since: windowStart,
    until: windowEnd,
    limit,
    priority,
    windowStartTsMs,
    windowEndTsMs,
  };
}

/**
 * Create one task per selected platform in a single transaction. A task only
 * ever targets one platform (that is the unit the worker claims and executes),
 * so "all platforms" means a batch of sibling tasks created together.
 */
async function createTasks(pool: any, body: Json): Promise<Json[]> {
  const fields = parseTaskFields(body);

  const rawIds = Array.isArray(body.platformIds)
    ? body.platformIds
    : body.platformId
      ? [body.platformId]
      : [];
  const platformIds = [...new Set(rawIds.map(text).filter(Boolean))];
  if (!platformIds.length) throw new Error("请选择平台");
  if (platformIds.length > 50) throw new Error("一次最多创建 50 个平台任务");

  const platformResult = await pool.query(
    "select id, name, enabled from platforms where id = any($1::text[])",
    [platformIds],
  );
  const byId = new Map<string, any>(platformResult.rows.map((row: any) => [row.id, row]));
  const unavailable = platformIds.filter((id) => {
    const platform = byId.get(id);
    return !platform || !platform.enabled;
  });
  if (unavailable.length) {
    throw new Error(`平台不存在或已停用：${unavailable.map((id) => byId.get(id)?.name || id).join("、")}`);
  }

  const params = {
    since: fields.since,
    until: fields.until,
    limit: fields.limit,
    timezone: TIME_ZONE,
    windowStartTsMs: fields.windowStartTsMs,
    windowEndTsMs: fields.windowEndTsMs,
  };

  const client = await pool.connect();
  const taskIds: string[] = [];
  try {
    await client.query("begin");
    // Tasks target one type, but the type is resolved to the category so task
    // account selection follows memberships (an account can be in several types).
    const category = fields.accountType ? await ensureCategory(client, fields.accountType) : null;
    const now = Date.now();
    for (const platformId of platformIds) {
      const id = prefixedId("task");
      taskIds.push(id);
      await client.query(
        `insert into scrape_tasks(
           id, platform_id, category_id, account_type, params, priority, status,
           scheduled_at_ms, lease_owner, lease_until_ms, attempts, run_id, last_error,
           created_ts_ms, updated_ts_ms
         ) values ($1, $2, $3, null, $4::jsonb, $5, 'pending', $6, null, null, 0, null, null, $7, $7)`,
        [id, platformId, category?.id ?? null, JSON.stringify(params), fields.priority, fields.scheduledAtMs, now],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const created = await pool.query(`${taskSelect} where t.id = any($1::text[])`, [taskIds]);
  const rows = new Map(created.rows.map((row: any) => [row.id, row]));
  return taskIds.map((id) => taskRow(rows.get(id))).filter(Boolean);
}

type UpdateTaskResult =
  | { kind: "not_found" }
  | { kind: "conflict"; message: string }
  | { kind: "task"; task: Json };

async function updateTask(pool: any, id: string, body: Json): Promise<UpdateTaskResult> {
  const existingResult = await pool.query("select * from scrape_tasks where id = $1", [id]);
  if (!existingResult.rows.length) return { kind: "not_found" };
  const existing = existingResult.rows[0];
  if (existing.params?.parentTaskId) return { kind: "conflict", message: "补跑任务不能编辑" };
  if (existing.status !== "pending" && existing.status !== "paused") {
    return { kind: "conflict", message: "只有未执行的任务可以编辑" };
  }

  const fields = parseTaskFields(body);
  const platformId = text(body.platformId);
  if (!platformId) throw new Error("请选择平台");
  const platform = await pool.query("select id from platforms where id = $1 and enabled = true", [platformId]);
  if (!platform.rows.length) throw new Error("平台不存在或已停用");
  const category = fields.accountType ? await ensureCategory(pool, fields.accountType) : null;

  // Keep fields the edit form does not expose (for example an account filter),
  // and keep the original priority unless the caller explicitly overrides it.
  const params = {
    ...(existing.params || {}),
    since: fields.since,
    until: fields.until,
    limit: fields.limit,
    timezone: TIME_ZONE,
    windowStartTsMs: fields.windowStartTsMs,
    windowEndTsMs: fields.windowEndTsMs,
  };
  const priority = body.priority === undefined ? Number(existing.priority) : fields.priority;
  const now = Date.now();
  const updated = await pool.query(
    `update scrape_tasks
        set platform_id = $2,
            category_id = $3,
            account_type = null,
            params = $4::jsonb,
            priority = $5,
            scheduled_at_ms = $6,
            last_error = null,
            updated_ts_ms = $7
      where id = $1 and status in ('pending','paused')
      returning id`,
    [id, platformId, category?.id ?? null, JSON.stringify(params), priority, fields.scheduledAtMs, now],
  );
  if (!updated.rows.length) return { kind: "conflict", message: "任务已经开始执行，无法编辑" };

  const task = await pool.query(`${taskSelect} where t.id = $1`, [id]);
  return { kind: "task", task: taskRow(task.rows[0]) };
}

async function listTasks(pool: any, date: string): Promise<Json> {
  // Paused tasks stay in the pending section; the worker only claims 'pending',
  // so they are visible to the operator but will not run until resumed.
  const pendingResult = await pool.query(
    `${taskSelect}
      where t.status in ('pending', 'paused')
        and t.params->>'parentTaskId' is null
        and (to_timestamp(t.scheduled_at_ms / 1000) at time zone $2)::date = $1::date
      order by t.priority asc, t.scheduled_at_ms asc, t.created_ts_ms asc, p.name`,
    [date, TIME_ZONE],
  );
  // Group by the day the task was planned for, exactly like pending. If a task
  // starts late (or after midnight), bucketing by run time would move it to a
  // different day the moment it is claimed, so it would vanish from both lists
  // on the page the operator is looking at.
  const executedResult = await pool.query(
    `${taskSelect}
      where t.status in ('running', 'success', 'failed', 'cancelled')
        and t.params->>'parentTaskId' is null
        and (to_timestamp(t.scheduled_at_ms / 1000) at time zone $2)::date = $1::date
      order by coalesce(r.started_ts_ms, t.scheduled_at_ms) asc, t.priority asc, p.name`,
    [date, TIME_ZONE],
  );
  const pendingRows = await Promise.all(pendingResult.rows.map(async (row: any) => {
    const task = taskRow(row);
    const { coverage, yesterday, activeRerun } = await loadTaskCoverage(pool, row);
    return applyCoverage(task, { ...coverage, yesterday, activeRerun });
  }));
  const executedRows = await Promise.all(executedResult.rows.map(async (row: any) => {
    const task = taskRow(row);
    const { coverage, yesterday, activeRerun } = await loadTaskCoverage(pool, row);
    return applyCoverage(task, { ...coverage, yesterday, activeRerun });
  }));

  // Child tasks are hidden from the day lists (the parent row already reports
  // their result), but a queued or running child is an operator action waiting
  // to happen. Return them separately so the page can show a queue with the
  // same pause/cancel controls as a normal pending task.
  const rerunsResult = await pool.query(
    `select t.id, t.params->>'parentTaskId' as parent_task_id,
            t.params->>'taskKind' as task_kind,
            case when jsonb_typeof(t.params->'accountIds') = 'array'
                 then jsonb_array_length(t.params->'accountIds') else 0 end as account_count,
            t.platform_id, p.code as platform_code, p.name as platform_name,
            coalesce(c.name, t.account_type, parent.account_type) as account_type,
            t.status, t.priority, t.scheduled_at_ms, t.created_ts_ms, t.run_id,
            parent.scheduled_at_ms as parent_scheduled_at_ms,
            r.status as run_status, r.started_ts_ms, r.finished_ts_ms,
            r.success_accounts, r.failed_accounts, r.total_accounts
       from scrape_tasks t
       join platforms p on p.id = t.platform_id
       left join scrape_tasks parent on parent.id = t.params->>'parentTaskId'
       left join account_categories c on c.id = coalesce(t.category_id, parent.category_id)
       left join scrape_runs r on r.id = t.run_id
      where t.params->>'parentTaskId' is not null
        and t.status in ('pending', 'paused', 'running')
      order by case t.status when 'running' then 0 when 'pending' then 1 else 2 end,
               t.priority asc, t.scheduled_at_ms asc, t.created_ts_ms asc
      limit 100`,
  );
  const reruns = rerunsResult.rows.map((row: any) => ({
    id: row.id,
    parentTaskId: row.parent_task_id,
    kind: row.task_kind || "manual_rerun",
    accountCount: Number(row.account_count || 0),
    platformId: row.platform_id,
    platformCode: row.platform_code,
    platformName: row.platform_name,
    accountType: row.account_type || null,
    status: row.status,
    priority: Number(row.priority || 0),
    scheduledAt: iso(row.scheduled_at_ms),
    createdAt: iso(row.created_ts_ms),
    parentScheduledAt: iso(row.parent_scheduled_at_ms),
    runId: row.run_id,
    runStatus: row.run_status,
    runStartedAt: iso(row.started_ts_ms),
    runFinishedAt: iso(row.finished_ts_ms),
    successAccounts: Number(row.success_accounts || 0),
    failedAccounts: Number(row.failed_accounts || 0),
  }));

  const pending = pendingRows;
  const executed = executedRows;
  const summary = {
    pending: pending.length,
    paused: pending.filter((task: any) => task.status === "paused").length,
    running: executed.filter((task: any) => task.status === "running").length,
    success: executed.filter((task: any) => task.status === "success").length,
    failed: executed.filter((task: any) => task.status === "failed").length,
    cancelled: executed.filter((task: any) => task.status === "cancelled").length,
    reruns: reruns.length,
    accountsSuccess: executed.reduce((sum: number, task: any) => sum + task.successAccounts, 0),
    accountsFailed: executed.reduce((sum: number, task: any) => sum + task.failedAccounts, 0),
    contentsSuccess: executed.reduce((sum: number, task: any) => sum + task.contentMetricCount, 0),
  };
  return { date, summary, pending, executed, reruns };
}


/** Business day key (YYYYMMDD) of the day a task was planned for. */
function taskDayKey(task: any): number | null {
  const fromRun = Number(task.task_date_key);
  if (Number.isInteger(fromRun) && fromRun >= 19000101 && fromRun <= 29991231) return fromRun;
  const scheduled = Number(task.scheduled_at_ms);
  if (Number.isFinite(scheduled) && scheduled > 0) return dayKeyInTimeZone(scheduled, TIME_ZONE);
  return null;
}

/**
 * Move a YYYYMMDD day key by whole days. UTC arithmetic keeps this immune to
 * daylight-saving jumps in the business time zone.
 */
function shiftDayKey(dayKey: number, days: number): number {
  const text = String(dayKey).padStart(8, "0");
  const shifted = new Date(Date.UTC(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8)) + days));
  return shifted.getUTCFullYear() * 10000 + (shifted.getUTCMonth() + 1) * 100 + shifted.getUTCDate();
}

function dayKeyText(dayKey: number): string {
  const text = String(dayKey).padStart(8, "0");
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

/**
 * Yesterday's account rows, one per account. Retries write one metric row per
 * run, so take the latest successful account run: that is the same rule the
 * current-day numbers use, which keeps the two sides directly comparable.
 */
async function loadYesterdayMetrics(
  pool: any,
  accountIds: string[],
  yesterdayKey: number,
): Promise<Map<string, any>> {
  const byAccount = new Map<string, any>();
  if (!accountIds.length) return byAccount;
  const result = await pool.query(
    `select distinct on (am.account_id)
            am.account_id, am.content_count_in_window,
            am.followers_count, am.posts_count,
            r.started_ts_ms
       from account_daily_metrics am
       join scrape_run_accounts ra
         on ra.run_id = am.run_id and ra.account_id = am.account_id
       join scrape_runs r on r.id = am.run_id
      where am.account_id = any($1::text[])
        and am.metric_day_key = $2
        and ra.status = 'success'
      order by am.account_id, r.started_ts_ms desc nulls last, am.captured_ts_ms desc`,
    [accountIds, yesterdayKey],
  );
  for (const row of result.rows) byAccount.set(row.account_id, row);
  return byAccount;
}

function yesterdayMetricDto(row: any, date: string): Json {
  return {
    date,
    runStartedAt: iso(row.started_ts_ms),
    followersCount: row.followers_count == null ? null : Number(row.followers_count),
    postsCount: row.posts_count == null ? null : Number(row.posts_count),
    contentCountInWindow: row.content_count_in_window == null ? null : Number(row.content_count_in_window),
  };
}

async function loadTaskCoverage(pool: any, task: any): Promise<Json> {
  const params = task.params || {};
  const scopeAccountIds = Array.isArray(params.accountIds)
    ? params.accountIds.map((value: unknown) => String(value)).filter(Boolean)
    : null;
  const accountFilter = text(params.account);
  const conditions = ["a.platform_id = $1"];
  const values: any[] = [task.platform_id];
  const categoryId = text(task.category_id) || null;
  if (categoryId) {
    values.push(categoryId);
    conditions.push(`exists (
      select 1 from account_category_members m
       where m.account_id = a.id and m.category_id = $${values.length}
    )`);
  } else if (task.account_type) {
    values.push(task.account_type);
    conditions.push(`a.account_type = $${values.length}`);
  }
  if (accountFilter) {
    values.push(accountFilter);
    conditions.push(`a.handle = $${values.length}`);
  }
  if (scopeAccountIds) {
    values.push(scopeAccountIds);
    conditions.push(`a.id = any($${values.length})`);
  }
  const accountsResult = await pool.query(
    `select a.id, a.handle, a.display_name, a.profile_url, a.active,
            a.account_type, a.metadata_json->>'source' as source,
            to_char(to_timestamp(a.created_ts_ms/1000) at time zone 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS') as created_at,
            to_char(to_timestamp(a.updated_ts_ms/1000) at time zone 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS') as updated_at,
            p.code as platform_code
       from social_accounts a
       join platforms p on p.id = a.platform_id
      where ${conditions.join(" and ")}
      order by a.handle`,
    values,
  );

  const childTasksResult = await pool.query(
    `select t.id, t.status, t.run_id, t.params->>'taskKind' as task_kind,
            t.params->'accountIds' as account_ids,
            t.scheduled_at_ms, t.created_ts_ms,
            r.status as run_status, r.started_ts_ms, r.finished_ts_ms,
            r.total_accounts, r.success_accounts, r.failed_accounts, r.content_metric_count
       from scrape_tasks t
       left join scrape_runs r on r.id = t.run_id
      where t.params->>'parentTaskId' = $1
      order by coalesce(r.started_ts_ms, t.created_ts_ms) asc`,
    [task.id],
  );

  const runIds: string[] = [];
  if (task.run_id) runIds.push(task.run_id);
  for (const row of childTasksResult.rows) {
    if (row.run_id && !runIds.includes(row.run_id)) runIds.push(row.run_id);
  }

  let runAccountRows: any[] = [];
  if (runIds.length) {
    const result = await pool.query(
      `select ra.run_id, ra.account_id, ra.status, ra.started_ts_ms, ra.finished_ts_ms,
              ra.content_found_count, ra.content_saved_count, ra.failed_content_count,
              ra.error_code, ra.error_message,
              r.started_ts_ms as run_started_ts_ms, r.status as run_status,
              am.followers_count, am.following_count, am.posts_count,
              am.content_count_in_window, am.new_content_count
         from scrape_run_accounts ra
         join scrape_runs r on r.id = ra.run_id
         left join account_daily_metrics am
           on am.run_id = ra.run_id and am.account_id = ra.account_id
        where ra.run_id = any($1::text[])
        order by r.started_ts_ms asc nulls first, ra.started_ts_ms asc nulls first`,
      [runIds],
    );
    runAccountRows = result.rows;
  }

  const byAccount = new Map<string, any[]>();
  for (const row of runAccountRows) {
    const list = byAccount.get(row.account_id) || [];
    list.push(row);
    byAccount.set(row.account_id, list);
  }

  // A queued rerun has no scrape_runs row yet, so run_accounts alone would keep
  // showing the previous attempt ("成功") while the account sits in the queue.
  // Build the queue from the child task's accountIds instead. Accounts already
  // started by a running child are not queued any more; their run_account row
  // reports "running" and wins below.
  const activeChildRows = childTasksResult.rows.filter((row: any) =>
    ["pending", "paused", "running"].includes(row.status),
  );
  const startedByRun = new Map<string, Set<string>>();
  for (const row of runAccountRows) {
    if (!row.run_id) continue;
    const started = startedByRun.get(row.run_id) || new Set<string>();
    started.add(row.account_id);
    startedByRun.set(row.run_id, started);
  }
  const queuedByAccount = new Map<string, Json>();
  for (const row of activeChildRows) {
    const ids: string[] = Array.isArray(row.account_ids)
      ? row.account_ids.map((value: unknown) => String(value)).filter(Boolean)
      : [];
    if (!ids.length) continue;
    const started = row.status === "running" ? startedByRun.get(row.run_id) : null;
    for (const accountId of ids) {
      if (started?.has(accountId)) continue;
      // Rows arrive in creation order; a later queue entry replaces an older one.
      queuedByAccount.set(accountId, {
        taskId: row.id,
        status: row.status,
        kind: row.task_kind || "manual_rerun",
        scheduledAt: iso(row.scheduled_at_ms),
        createdAt: iso(row.created_ts_ms),
        accountCount: ids.length,
      });
    }
  }

  const statusRank: Record<string, number> = { running: 0, pending: 1, paused: 2 };
  const activeChild = [...activeChildRows].sort((a: any, b: any) => {
    const rank = (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9);
    if (rank !== 0) return rank;
    return Number(b.created_ts_ms || 0) - Number(a.created_ts_ms || 0);
  })[0] || null;
  const activeRerun = activeChild
    ? {
        id: activeChild.id,
        status: activeChild.status,
        kind: activeChild.task_kind || "manual_rerun",
        accountCount: Array.isArray(activeChild.account_ids) ? activeChild.account_ids.length : 0,
        scheduledAt: iso(activeChild.scheduled_at_ms),
        createdAt: iso(activeChild.created_ts_ms),
        runStartedAt: iso(activeChild.started_ts_ms),
        runFinishedAt: iso(activeChild.finished_ts_ms),
        successAccounts: Number(activeChild.success_accounts || 0),
        failedAccounts: Number(activeChild.failed_accounts || 0),
      }
    : null;

  // The day before this task's business day is the comparison baseline. Pending
  // tasks have no run yet, so they skip the extra query and show no comparison.
  const dayKey = taskDayKey(task);
  const yesterdayKey = dayKey && task.run_id ? shiftDayKey(dayKey, -1) : null;
  const yesterdayDate = yesterdayKey ? dayKeyText(yesterdayKey) : null;
  const yesterdayByAccount = yesterdayKey
    ? await loadYesterdayMetrics(pool, accountsResult.rows.map((account: any) => account.id), yesterdayKey)
    : new Map<string, any>();

  const accounts = accountsResult.rows.map((account: any) => {
    const history = byAccount.get(account.id) || [];
    const latest = history.length ? history[history.length - 1] : null;
    const latestSuccess = [...history].reverse().find((row) => row.status === "success") || null;
    const yesterdayRow = yesterdayByAccount.get(account.id);
    let status = "pending";
    if (!account.active) status = "disabled";
    else if (!latest) status = "pending";
    else if (latest.status === "running") status = "running";
    else if (latest.status === "success") status = "success";
    else if (latest.status === "partial_failed") status = "partial";
    else status = "failed";

    return {
      id: account.id,
      accountId: account.id,
      handle: account.handle,
      displayName: account.display_name,
      profileUrl: account.profile_url,
      platformCode: account.platform_code,
      source: account.source,
      createdAt: account.created_at,
      updatedAt: account.updated_at,
      status,
      // Display overlay only: `status` stays the last completed attempt so
      // coverage, filters and retry buttons keep their existing meaning.
      queue: account.active && status !== "running" ? queuedByAccount.get(account.id) || null : null,
      latestRunId: latest?.run_id || null,
      latestRunStatus: latest?.run_status || null,
      latestRunStartedAt: iso(latest?.run_started_ts_ms),
      latestSuccessRunId: latestSuccess?.run_id || null,
      isNew: !latest,
      startedAt: iso(latest?.started_ts_ms),
      finishedAt: iso(latest?.finished_ts_ms),
      contentFoundCount: Number(latestSuccess?.content_found_count || 0),
      contentSavedCount: Number(latestSuccess?.content_saved_count || 0),
      failedContentCount: Number(latest?.failed_content_count || 0),
      followersCount: latestSuccess?.followers_count == null ? null : Number(latestSuccess.followers_count),
      followingCount: latestSuccess?.following_count == null ? null : Number(latestSuccess.following_count),
      postsCount: latestSuccess?.posts_count == null ? null : Number(latestSuccess.posts_count),
      contentCountInWindow: latestSuccess?.content_count_in_window == null ? null : Number(latestSuccess.content_count_in_window),
      newContentCount: latestSuccess?.new_content_count == null ? null : Number(latestSuccess.new_content_count),
      errorCode: status === "failed" || status === "partial" ? latest?.error_code || null : null,
      errorMessage: status === "failed" || status === "partial" ? latest?.error_message || null : null,
      yesterday: yesterdayRow ? yesterdayMetricDto(yesterdayRow, yesterdayDate as string) : null,
    };
  });

  const active = accounts.filter((account: any) => account.status !== "disabled");
  const coverage = {
    total: active.length,
    success: active.filter((account: any) => account.status === "success").length,
    failed: active.filter((account: any) => account.status === "failed" || account.status === "partial").length,
    newAccounts: active.filter((account: any) => account.status === "pending").length,
    running: active.filter((account: any) => account.status === "running").length,
    queued: active.filter((account: any) => Boolean(account.queue)).length,
    zeroContent: active.filter((account: any) => account.status === "success" && Number(account.contentCountInWindow || 0) === 0).length,
    disabled: accounts.length - active.length,
  };

  // Yesterday is aggregated over today's account scope, so "5/5 today vs 4/5
  // yesterday" reads as the same set of accounts on two days.
  const activeWithYesterday = active.filter((account: any) => account.yesterday);
  const yesterday = yesterdayKey
    ? {
        date: yesterdayDate,
        total: active.length,
        accountsWithData: activeWithYesterday.length,
        contentCount: activeWithYesterday.reduce(
          (sum: number, account: any) => sum + Number(account.yesterday.contentCountInWindow || 0),
          0,
        ),
      }
    : null;

  const authoritativeRuns = new Map<string, string>();
  for (const account of accounts) {
    if (account.latestSuccessRunId) authoritativeRuns.set(account.accountId, account.latestSuccessRunId);
  }

  let contents: any[] = [];
  if (runIds.length) {
    const contentsResult = await pool.query(
      `select c.id, c.external_content_id, c.url, c.content_type, c.title,
              c.content_summary, c.publish_ts_ms,
              m.play_count, m.like_count, m.comment_count, m.share_count,
              m.collect_count, m.read_count, m.exposure_count, m.error_message,
              to_char(to_timestamp(m.captured_ts_ms/1000) at time zone 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS') as captured_at,
              c.account_id, m.run_id, a.handle as account_handle
         from content_daily_metrics m
         join social_contents c on c.id = m.content_id
         join social_accounts a on a.id = c.account_id
        where m.run_id = any($1::text[])
        order by c.publish_ts_ms desc nulls last`,
      [runIds],
    );
    contents = contentsResult.rows
      .filter((row: any) => authoritativeRuns.get(row.account_id) === row.run_id)
      .map((row: any) => ({
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
        capturedAt: row.captured_at,
        runId: row.run_id,
        accountId: row.account_id,
        accountHandle: row.account_handle,
      }));
  }

  const childTasks = childTasksResult.rows.map((row: any) => ({
    kind: row.task_kind || "backfill",
    accountCount: Array.isArray(row.account_ids) ? row.account_ids.length : 0,
    plannedAccounts: Number(row.total_accounts || 0),
    successAccounts: Number(row.success_accounts || 0),
    failedAccounts: Number(row.failed_accounts || 0),
    contentMetricCount: Number(row.content_metric_count || 0),
    id: row.id,
    status: row.status,
    scheduledAt: iso(row.scheduled_at_ms),
    createdAt: iso(row.created_ts_ms),
    runId: row.run_id,
    runStatus: row.run_status,
    runStartedAt: iso(row.started_ts_ms),
    runFinishedAt: iso(row.finished_ts_ms),
  }));

  return {
    accounts,
    contents,
    coverage: { ...coverage, contentCount: contents.length },
    childTasks,
    yesterday,
    activeRerun,
  };
}

async function taskDetail(pool: any, id: string): Promise<Json | null> {
  const taskResult = await pool.query(`${taskSelect} where t.id = $1`, [id]);
  if (!taskResult.rows.length) return null;
  const rawTask = taskResult.rows[0];
  const coverageData = await loadTaskCoverage(pool, rawTask);
  const task = applyCoverage(taskRow(rawTask), {
    ...coverageData.coverage,
    yesterday: coverageData.yesterday,
    activeRerun: coverageData.activeRerun,
  });

  let run: Json | null = null;
  if (task.runId) {
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
    const row = runResult.rows[0];
    if (row) {
      run = {
        id: row.id,
        status: row.status,
        triggerType: row.trigger_type,
        windowSince: iso(row.window_since_ts_ms),
        windowUntil: iso(row.window_until_ts_ms),
        startedAt: iso(row.started_ts_ms),
        finishedAt: iso(row.finished_ts_ms),
        rawRecordCount: Number(row.raw_record_count || 0),
        accountMetricCount: Number(row.account_metric_count || 0),
        contentMetricCount: Number(row.content_metric_count || 0),
        totalAccounts: Number(row.total_accounts || 0),
        successAccounts: Number(row.success_accounts || 0),
        failedAccounts: Number(row.failed_accounts || 0),
        totalContents: Number(row.total_contents || 0),
        successContents: Number(row.success_contents || 0),
        failedContents: Number(row.failed_contents || 0),
        errorCode: row.error_code,
        errorMessage: row.error_message,
      };
    }
  }

  return {
    task,
    run,
    accounts: coverageData.accounts,
    contents: coverageData.contents,
    coverage: coverageData.coverage,
    childTasks: coverageData.childTasks,
    yesterday: coverageData.yesterday,
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
  if (accountType) {
    values.push(accountType);
    conditions.push(`exists (
      select 1 from account_category_members m
      join account_categories c on c.id = m.category_id
      where m.account_id = a.id and c.active and (c.code = $${values.length} or c.name = $${values.length})
    )`);
  }
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
            a.active, a.account_type, a.created_ts_ms, a.updated_ts_ms,
            ${accountTypesSelect}
       from social_accounts a
       join platforms p on p.id = a.platform_id
      where ${conditions.join(" and ")}
      order by p.code asc, a.handle asc
      limit $${dataValues.length - 1} offset $${dataValues.length}`,
    dataValues,
  );
  return {
    accounts: result.rows.map(accountDto),
    total,
    activeCount,
    inactiveCount: total - activeCount,
    page,
    pageSize,
  };
}


/** 账号详情页用：账号本身 + 最近一次账号指标。 */
function accountMetrics(row: any): Json | null {
  if (row.metrics_captured_ts_ms == null) return null;
  return {
    followersCount: row.followers_count == null ? null : Number(row.followers_count),
    followingCount: row.following_count == null ? null : Number(row.following_count),
    postsCount: row.posts_count == null ? null : Number(row.posts_count),
    capturedAt: iso(row.metrics_captured_ts_ms),
  };
}

async function findAccountDetail(pool: any, accountId: string): Promise<Json | null> {
  const result = await pool.query(
    `select a.id, a.platform_id, p.code as platform_code, p.name as platform_name,
            a.handle, a.display_name, a.profile_url, a.external_account_id,
            a.active, a.account_type, a.created_ts_ms, a.updated_ts_ms,
            ${accountTypesSelect},
            am.followers_count, am.following_count, am.posts_count,
            am.captured_ts_ms as metrics_captured_ts_ms
       from social_accounts a
       join platforms p on p.id = a.platform_id
       left join lateral (
         select followers_count, following_count, posts_count, captured_ts_ms
           from account_daily_metrics
          where account_id = a.id
          order by captured_ts_ms desc
          limit 1
       ) am on true
      where a.id = $1`,
    [accountId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...accountDto(row), metrics: accountMetrics(row) };
}

function isDateKeyText(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** 帖子列表/评论导出的时间范围；空表示不限。 */
function parseAccountRange(url: URL): {
  sinceText: string | null;
  untilText: string | null;
  sinceTsMs: number | null;
  untilTsMs: number | null;
} {
  const since = text(url.searchParams.get("since"));
  const until = text(url.searchParams.get("until"));
  if (since && !isDateKeyText(since)) throw new Error("since 必须是有效的 YYYY-MM-DD 日期");
  if (until && !isDateKeyText(until)) throw new Error("until 必须是有效的 YYYY-MM-DD 日期");
  if (since && until && since > until) throw new Error("since 不能晚于 until");
  return {
    sinceText: since || null,
    untilText: until || null,
    sinceTsMs: since ? scrapeWindowStartTsMs(since, TIME_ZONE) : null,
    untilTsMs: until ? endOfDayInTimeZone(Number(until.replace(/-/g, "")), TIME_ZONE) : null,
  };
}

const latestContentCommentJoin = `
  left join lateral (
    select comment_count
      from content_daily_metrics
     where content_id = c.id
       and comment_count is not null
     order by captured_ts_ms desc
     limit 1
  ) m on true`;

const contentCommentAggregateJoin = `
  left join lateral (
    select count(*)::int as comment_count,
           count(*) filter (where parent_comment_id is null)::int as top_level_count,
           count(*) filter (where parent_comment_id is not null)::int as reply_count,
           max(last_seen_ts_ms) as last_seen_ts_ms
      from comment
     where content_id = c.id
  ) cc on true`;

const contentRangeCondition = `
  c.account_id = $1
  and ($2::bigint is null or (c.publish_ts_ms is not null and c.publish_ts_ms >= $2))
  and ($3::bigint is null or (c.publish_ts_ms is not null and c.publish_ts_ms <= $3))`;

function postDto(row: any): Json {
  return {
    id: row.id,
    externalContentId: row.external_content_id ?? null,
    url: row.url,
    contentType: row.content_type ?? null,
    title: row.title ?? null,
    summary: row.content_summary ?? null,
    publishTime: iso(row.publish_ts_ms),
    platformCommentCount: row.platform_comment_count == null ? null : Number(row.platform_comment_count),
    fetchedCommentCount: Number(row.fetched_comment_count || 0),
    topLevelCommentCount: Number(row.top_level_comment_count || 0),
    replyCommentCount: Number(row.reply_comment_count || 0),
    lastCommentSeenAt: iso(row.last_comment_seen_ts_ms),
  };
}

function commentExportDto(row: any): Json {
  return {
    id: row.id,
    username: row.username || "",
    userId: row.user_id || "",
    text: row.text_content || "",
    likeCount: row.like_count == null ? null : Number(row.like_count),
    replyCount: row.reply_count == null ? null : Number(row.reply_count),
    parentCommentId: row.parent_comment_id ?? null,
    rootCommentId: row.root_comment_id ?? null,
    createdAt: iso(row.create_timestamp),
    runId: row.run_id ?? null,
    postId: row.content_id,
    postUrl: row.post_url,
    postTitle: row.post_title ?? null,
    postPublishTime: iso(row.post_publish_ts_ms),
  };
}

function postCommentDto(row: any): Json {
  return {
    id: row.id,
    username: row.username || "",
    userId: row.user_id || "",
    text: row.text_content || "",
    likeCount: row.like_count == null ? null : Number(row.like_count),
    replyCount: row.reply_count == null ? null : Number(row.reply_count),
    parentCommentId: row.parent_comment_id ?? null,
    rootCommentId: row.root_comment_id ?? null,
    createdAt: iso(row.create_timestamp),
    runId: row.run_id ?? null,
    lastSeenAt: iso(row.last_seen_ts_ms),
  };
}

/**
 * 账号帖子列表：帖子按发布时间倒序，评论数区分「平台指标」和「已抓评论」。
 * 时间范围只作用于帖子发布时间，不作用于评论。
 */
async function listAccountPosts(pool: any, accountId: string, url: URL): Promise<Json | null> {
  const account = await findAccountDetail(pool, accountId);
  if (!account) return null;

  const range = parseAccountRange(url);
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("pageSize") || "50", 10) || 50));
  const params = [accountId, range.sinceTsMs, range.untilTsMs];

  const summaryResult = await pool.query(
    `select count(*)::int as post_count,
            count(*) filter (where coalesce(cc.comment_count, 0) > 0)::int as posts_with_comments,
            coalesce(sum(cc.comment_count), 0)::bigint as fetched_comments,
            coalesce(sum(cc.top_level_count), 0)::bigint as top_level_comments,
            coalesce(sum(cc.reply_count), 0)::bigint as reply_comments,
            coalesce(sum(m.comment_count), 0)::bigint as platform_comments
       from social_contents c
       ${contentCommentAggregateJoin}
       ${latestContentCommentJoin}
      where ${contentRangeCondition}`,
    params,
  );
  const summaryRow = summaryResult.rows[0] || {};

  const result = await pool.query(
    `select c.id, c.external_content_id, c.url, c.content_type, c.title, c.content_summary,
            c.publish_ts_ms,
            m.comment_count as platform_comment_count,
            coalesce(cc.comment_count, 0)::int as fetched_comment_count,
            coalesce(cc.top_level_count, 0)::int as top_level_comment_count,
            coalesce(cc.reply_count, 0)::int as reply_comment_count,
            cc.last_seen_ts_ms as last_comment_seen_ts_ms
       from social_contents c
       ${contentCommentAggregateJoin}
       ${latestContentCommentJoin}
      where ${contentRangeCondition}
      order by c.publish_ts_ms desc nulls last, c.id desc
      limit $4 offset $5`,
    [...params, pageSize, (page - 1) * pageSize],
  );

  return {
    account,
    window: { since: range.sinceText, until: range.untilText },
    posts: result.rows.map(postDto),
    total: Number(summaryRow.post_count || 0),
    page,
    pageSize,
    summary: {
      posts: Number(summaryRow.post_count || 0),
      postsWithComments: Number(summaryRow.posts_with_comments || 0),
      fetchedComments: Number(summaryRow.fetched_comments || 0),
      topLevelComments: Number(summaryRow.top_level_comments || 0),
      replyComments: Number(summaryRow.reply_comments || 0),
      platformComments: Number(summaryRow.platform_comments || 0),
    },
  };
}

/** 账号范围内所有帖子的评论（Excel 导出用），评论本身不按时间过滤。 */
async function listAccountComments(pool: any, accountId: string, url: URL): Promise<Json | null> {
  const account = await findAccountDetail(pool, accountId);
  if (!account) return null;

  const range = parseAccountRange(url);
  const requested = Number.parseInt(url.searchParams.get("limit") || "50000", 10) || 50000;
  const limit = Math.min(200000, Math.max(1, requested));
  const params = [accountId, range.sinceTsMs, range.untilTsMs];

  const totalResult = await pool.query(
    `select count(*)::int as total
       from comment cm
       join social_contents c on c.id = cm.content_id
      where ${contentRangeCondition}`,
    params,
  );
  const total = Number(totalResult.rows[0]?.total || 0);

  const result = await pool.query(
    `select cm.id, cm.username, cm.user_id, cm.text_content,
            cm.like_count, cm.reply_count,
            cm.parent_comment_id, cm.root_comment_id, cm.create_timestamp, cm.run_id,
            c.id as content_id, c.url as post_url, c.title as post_title,
            c.publish_ts_ms as post_publish_ts_ms
       from comment cm
       join social_contents c on c.id = cm.content_id
      where ${contentRangeCondition}
      order by c.publish_ts_ms desc nulls last,
               coalesce(cm.root_comment_id, cm.id),
               cm.parent_comment_id nulls first,
               cm.create_timestamp asc nulls last
      limit $4`,
    [...params, limit],
  );

  return {
    account,
    window: { since: range.sinceText, until: range.untilText },
    comments: result.rows.map(commentExportDto),
    total,
    truncated: total > result.rows.length,
  };
}

/** 单个帖子 + 所有评论（不按评论时间过滤）。 */
async function getPostDetail(pool: any, contentId: string): Promise<Json | null> {
  const postResult = await pool.query(
    `select c.id, c.external_content_id, c.url, c.content_type, c.title, c.content_summary,
            c.publish_ts_ms,
            c.account_id, a.handle, a.display_name, a.profile_url, a.active as account_active,
            p.id as platform_id, p.code as platform_code, p.name as platform_name,
            m.comment_count as platform_comment_count,
            coalesce(cc.comment_count, 0)::int as fetched_comment_count,
            coalesce(cc.top_level_count, 0)::int as top_level_comment_count,
            coalesce(cc.reply_count, 0)::int as reply_comment_count,
            cc.last_seen_ts_ms as last_comment_seen_ts_ms
       from social_contents c
       join social_accounts a on a.id = c.account_id
       join platforms p on p.id = a.platform_id
       ${contentCommentAggregateJoin}
       ${latestContentCommentJoin}
      where c.id = $1`,
    [contentId],
  );
  const row = postResult.rows[0];
  if (!row) return null;

  const commentsResult = await pool.query(
    `select id, username, user_id, text_content, like_count, reply_count,
            parent_comment_id, root_comment_id, create_timestamp, run_id, last_seen_ts_ms
       from comment
      where content_id = $1
      order by parent_comment_id nulls first, create_timestamp asc nulls last, id`,
    [contentId],
  );
  const comments = commentsResult.rows.map(postCommentDto);
  const topLevel = comments.filter((comment: Json) => comment.parentCommentId == null).length;

  return {
    post: {
      ...postDto(row),
      platformId: row.platform_id,
      platformCode: row.platform_code,
      platformName: row.platform_name,
      account: {
        id: row.account_id,
        handle: row.handle,
        displayName: row.display_name ?? null,
        profileUrl: row.profile_url,
        active: row.account_active,
        platformCode: row.platform_code,
        platformName: row.platform_name,
      },
    },
    comments,
    counts: {
      total: comments.length,
      topLevel,
      replies: comments.length - topLevel,
      platform: row.platform_comment_count == null ? null : Number(row.platform_comment_count),
    },
  };
}

async function listPlatforms(pool: any): Promise<Json[]> {
  const result = await pool.query("select id, code, name, enabled from platforms where enabled = true and code <> 'fake' order by name");
  return result.rows;
}

async function listAccountTypes(pool: any): Promise<string[]> {
  const result = await pool.query(
    `select c.name
       from account_categories c
      where c.active = true
        and exists (select 1 from account_category_members m where m.category_id = c.id)
      order by case when c.name = '总部' then 0 else 1 end, c.name`,
  );
  return result.rows.map((row: any) => row.name);
}

/**
 * Active account count per account type × platform. The create dialog uses it
 * to select every platform that actually has accounts for the chosen type, so
 * "all platforms" does not queue tasks that would immediately fail empty.
 * Shape: { [accountType]: { [platformId]: count } }
 */
async function listAccountTypePlatformCounts(pool: any): Promise<Json> {
  const result = await pool.query(
    `select c.name as type_name, a.platform_id, count(*)::int as account_count
       from account_category_members m
       join social_accounts a on a.id = m.account_id and a.active = true
       join account_categories c on c.id = m.category_id and c.active = true
       join platforms p on p.id = a.platform_id and p.enabled = true
      group by c.name, a.platform_id`,
  );
  const counts: Json = {};
  for (const row of result.rows) {
    const byPlatform = counts[row.type_name] || (counts[row.type_name] = {});
    byPlatform[row.platform_id] = Number(row.account_count);
  }
  return counts;
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
    const category = await ensureCategory(client, accountType);
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
        const accountId = existing.rows.length ? existing.rows[0].id : prefixedId("account");
        if (existing.rows.length) {
          await client.query(
            `update social_accounts
                set account_type = case
                      when account_type is null or btrim(account_type) = '' then $2
                      else account_type
                    end,
                    updated_ts_ms = $3
              where id = $1`,
            [accountId, accountType, now],
          );
          updated += 1;
        } else {
          await client.query(
            `insert into social_accounts(
               id, platform_id, handle, display_name, profile_url, active,
               metadata_json, created_ts_ms, updated_ts_ms, account_type
             ) values ($1, $2, $3, $4, $5, true, '{"source":"excel_import"}'::jsonb, $6, $6, $7)`,
            [accountId, platformId, handle, displayName, profileUrl, now, accountType],
          );
          created += 1;
        }
        // Excel import adds the batch type; other memberships stay intact so a
        // re-import cannot silently drop a type such as 中南美-月报.
        await client.query(
          "insert into account_category_members(account_id, category_id, created_ts_ms) values ($1, $2, $3) on conflict (account_id, category_id) do nothing",
          [accountId, category.id, now],
        );
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
  const rawTypes = Array.isArray(body.accountTypes)
    ? body.accountTypes
    : body.accountType
      ? [body.accountType]
      : [];
  const accountTypes = [...new Set(rawTypes.map((value: unknown) => text(value).trim()).filter(Boolean))];
  const active = bool(body.active, true);

  if (!existingId && !platformId) throw new Error("缺少 platformId");
  if (!handle) throw new Error("缺少 handle");
  if (!profileUrl) throw new Error("缺少 profileUrl");
  if (!accountTypes.length) throw new Error("请选择至少一个账号类型");
  if (accountTypes.some((type) => type.length > 100)) throw new Error("账号类型不能超过 100 个字符");

  const primaryType = accountTypes[0];
  const client = await pool.connect();
  try {
    await client.query("begin");
    const categories: { id: string; name: string }[] = [];
    for (const type of accountTypes) {
      const category = await ensureCategory(client, type);
      if (!categories.some((item) => item.id === category.id)) categories.push(category);
    }

    let accountId = existingId || "";
    if (existingId) {
      const updated = await client.query(
        `update social_accounts
            set handle = $2, display_name = $3, profile_url = $4,
                account_type = $5, active = $6, updated_ts_ms = $7
          where id = $1
          returning id`,
        [existingId, handle, displayName, profileUrl, primaryType, active, Date.now()],
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
        [accountId, platformId, handle, displayName, profileUrl, active, now, primaryType],
      );
    }

    await client.query("delete from account_category_members where account_id = $1", [accountId]);
    const now = Date.now();
    for (const category of categories) {
      await client.query(
        "insert into account_category_members(account_id, category_id, created_ts_ms) values ($1, $2, $3)",
        [accountId, category.id, now],
      );
    }

    await client.query("commit");
    const saved = await pool.query(
      `select a.id, a.platform_id, p.code as platform_code, p.name as platform_name,
              a.handle, a.display_name, a.profile_url, a.external_account_id,
              a.active, a.account_type, a.created_ts_ms, a.updated_ts_ms,
              ${accountTypesSelect}
         from social_accounts a
         join platforms p on p.id = a.platform_id
        where a.id = $1`,
      [accountId],
    );

    return accountDto(saved.rows[0]);
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function handleApiRequest(request: Request): Promise<Response> {
  try {
    const handle = getDb();
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    if (method === "OPTIONS") return new Response(null, { status: 204 });
    if (method === "GET" && path === "/api/health") {
      return json(200, { ok: true });
    }
    if (method === "GET" && path === "/api/tasks") {
      const date = text(url.searchParams.get("date"));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(400, "date 必须是 YYYY-MM-DD");
      return json(200, await listTasks(handle.pool, date));
    }
    const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
    if (method === "GET" && taskMatch) {
      const detail = await taskDetail(handle.pool, decodeURIComponent(taskMatch[1]));
      return detail ? json(200, detail) : fail(404, "任务不存在");
    }
    const taskRerunMatch = path.match(/^\/api\/tasks\/([^/]+)\/rerun$/);
    if (method === "POST" && taskRerunMatch) {
      const parentId = decodeURIComponent(taskRerunMatch[1]);
      const parentResult = await handle.pool.query("select * from scrape_tasks where id = $1", [parentId]);
      if (!parentResult.rows.length) return fail(404, "任务不存在");
      const parent = parentResult.rows[0];
      if (parent.params?.parentTaskId) return fail(409, "请从主任务发起补跑");
      if (parent.status === "paused") return fail(409, "任务已暂停，请先继续执行");
      // A rerun of a task that has not produced its first result (or is still
      // producing it) would duplicate the same accounts in two runs.
      if (parent.status === "pending") return fail(409, "任务尚未执行，不能补跑");
      if (parent.status === "running") return fail(409, "任务正在执行，请等执行结束后再补跑");
      const body = await readJson(request);
      const mode = text(body.mode);
      if (!["failed", "new", "selected"].includes(mode)) return fail(400, "mode 必须是 failed、new 或 selected");

      const busy = await handle.pool.query(
        "select id from scrape_tasks where params->>'parentTaskId' = $1 and status in ('pending','paused','running') limit 1",
        [parentId],
      );
      if (busy.rows.length) return fail(409, "已有补跑任务在等待、暂停或执行中");

      const coverageData = await loadTaskCoverage(handle.pool, parent);
      let targets: any[] = [];
      if (mode === "failed") {
        targets = coverageData.accounts.filter((account: any) => account.status === "failed" || account.status === "partial");
      } else if (mode === "new") {
        targets = coverageData.accounts.filter((account: any) => account.status === "pending");
      } else {
        const requested = Array.isArray(body.accountIds)
          ? [...new Set(body.accountIds.map((value: unknown) => String(value)).filter(Boolean))]
          : [];
        if (!requested.length) return fail(400, "请选择要重跑的账号");
        const accountMap = new Map(coverageData.accounts.map((account: any) => [account.accountId, account]));
        targets = requested.map((accountId: string) => accountMap.get(accountId)).filter(Boolean);
        if (targets.length !== requested.length) return fail(400, "包含不属于该任务的账号");
        if (targets.some((account: any) => account.status === "disabled")) return fail(409, "禁用账号不能重跑");
      }

      if (!targets.length) {
        return fail(409, mode === "failed" ? "没有失败账号需要重试" : mode === "new" ? "没有新增账号需要补数据" : "没有可重跑的账号");
      }

      const taskKind = mode === "failed" ? "retry_failed" : mode === "new" ? "backfill_new" : "manual_rerun";
      const childId = prefixedId("task");
      const now = Date.now();
      const childParams = {
        ...(parent.params || {}),
        accountIds: targets.map((account: any) => account.accountId),
        parentTaskId: parentId,
        taskKind,
      };
      await handle.pool.query(
        `insert into scrape_tasks(
           id, platform_id, category_id, account_type, params, priority, status,
           scheduled_at_ms, lease_owner, lease_until_ms, attempts, run_id, last_error,
           created_ts_ms, updated_ts_ms
         ) values ($1, $2, $3, $4, $5::jsonb, $6, 'pending', $7, null, null, 0, null, null, $8, $8)`,
        [childId, parent.platform_id, parent.category_id, parent.account_type, JSON.stringify(childParams), Number(parent.priority || 100), now, now],
      );
      const created = await handle.pool.query(`${taskSelect} where t.id = $1`, [childId]);
      return json(201, { task: taskRow(created.rows[0]), accountCount: targets.length, mode });
    }
    const taskRetryMatch = path.match(/^\/api\/tasks\/([^/]+)\/retry$/);
    if (method === "POST" && taskRetryMatch) {
      const id = decodeURIComponent(taskRetryMatch[1]);
      const current = await handle.pool.query("select status from scrape_tasks where id = $1", [id]);
      if (!current.rows.length) return fail(404, "任务不存在");
      if (current.rows[0].status !== "failed") return fail(409, "只有失败任务可以继续执行");
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
      return json(200, { task: taskRow(task.rows[0]) });
    }
    const taskCancelMatch = path.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
    if (method === "POST" && taskCancelMatch) {
      const id = decodeURIComponent(taskCancelMatch[1]);
      const now = Date.now();
      // Cancelling keeps the row (and its child relationship) for the audit
      // trail, unlike DELETE which removes the task entirely.
      const updated = await handle.pool.query(
        `update scrape_tasks
            set status = 'cancelled',
                lease_owner = null,
                lease_until_ms = null,
                updated_ts_ms = $2
          where id = $1 and status in ('pending', 'paused')
          returning id`,
        [id, now],
      );
      if (!updated.rows.length) {
        const current = await handle.pool.query("select status from scrape_tasks where id = $1", [id]);
        if (!current.rows.length) return fail(404, "任务不存在");
        const status = current.rows[0].status;
        if (status === "cancelled") return json(200, { ok: true, id, status, already: true });
        if (status === "running") return fail(409, "任务正在执行，无法取消");
        return fail(409, "任务已结束，无法取消");
      }
      return json(200, { ok: true, id, status: "cancelled" });
    }
    const taskPauseMatch = path.match(/^\/api\/tasks\/([^/]+)\/pause$/);
    if (method === "POST" && taskPauseMatch) {
      const id = decodeURIComponent(taskPauseMatch[1]);
      const now = Date.now();
      const updated = await handle.pool.query(
        `update scrape_tasks
            set status = 'paused',
                updated_ts_ms = $2
          where id = $1 and status = 'pending'
          returning id`,
        [id, now],
      );
      if (!updated.rows.length) {
        const current = await handle.pool.query("select status from scrape_tasks where id = $1", [id]);
        if (!current.rows.length) return fail(404, "任务不存在");
        const status = current.rows[0].status;
        if (status === "paused") return json(200, { ok: true, id, status, already: true });
        if (status === "running") return fail(409, "任务正在执行，无法暂停");
        return fail(409, "只有待执行任务可以暂停");
      }
      return json(200, { ok: true, id, status: "paused" });
    }
    const taskResumeMatch = path.match(/^\/api\/tasks\/([^/]+)\/resume$/);
    if (method === "POST" && taskResumeMatch) {
      const id = decodeURIComponent(taskResumeMatch[1]);
      const now = Date.now();
      const updated = await handle.pool.query(
        `update scrape_tasks
            set status = 'pending',
                updated_ts_ms = $2
          where id = $1 and status = 'paused'
          returning id, scheduled_at_ms`,
        [id, now],
      );
      if (!updated.rows.length) {
        const current = await handle.pool.query("select status, scheduled_at_ms from scrape_tasks where id = $1", [id]);
        if (!current.rows.length) return fail(404, "任务不存在");
        const status = current.rows[0].status;
        if (status === "pending") {
          return json(200, {
            ok: true,
            id,
            status,
            already: true,
            immediate: Number(current.rows[0].scheduled_at_ms) <= now,
          });
        }
        return fail(409, "只有已暂停任务可以继续");
      }
      return json(200, {
        ok: true,
        id,
        status: "pending",
        immediate: Number(updated.rows[0].scheduled_at_ms) <= now,
      });
    }
    if (method === "PUT" && taskMatch) {
      const id = decodeURIComponent(taskMatch[1]);
      const result = await updateTask(handle.pool, id, await readJson(request));
      if (result.kind === "not_found") return fail(404, "任务不存在");
      if (result.kind === "conflict") return fail(409, result.message);
      return json(200, { task: result.task });
    }
    if (method === "DELETE" && taskMatch) {
      const id = decodeURIComponent(taskMatch[1]);
      const current = await handle.pool.query("select status from scrape_tasks where id = $1", [id]);
      if (!current.rows.length) return fail(404, "任务不存在");
      if (!["pending", "paused"].includes(current.rows[0].status)) {
        return fail(409, "只有待执行或已暂停任务可以删除");
      }
      await handle.pool.query("delete from scrape_tasks where id = $1 and status in ('pending','paused')", [id]);
      return json(200, { ok: true, id });
    }
    if (method === "GET" && path === "/api/accounts") {
      return json(200, await listAccounts(handle.pool, url));
    }
    const accountDetailMatch = path.match(/^\/api\/accounts\/([^/]+)$/);
    if (method === "GET" && accountDetailMatch) {
      const account = await findAccountDetail(handle.pool, decodeURIComponent(accountDetailMatch[1]));
      return account ? json(200, { account }) : fail(404, "账号不存在");
    }
    const accountPostsMatch = path.match(/^\/api\/accounts\/([^/]+)\/posts$/);
    if (method === "GET" && accountPostsMatch) {
      const result = await listAccountPosts(handle.pool, decodeURIComponent(accountPostsMatch[1]), url);
      return result ? json(200, result) : fail(404, "账号不存在");
    }
    const accountCommentsMatch = path.match(/^\/api\/accounts\/([^/]+)\/comments$/);
    if (method === "GET" && accountCommentsMatch) {
      const result = await listAccountComments(handle.pool, decodeURIComponent(accountCommentsMatch[1]), url);
      return result ? json(200, result) : fail(404, "账号不存在");
    }
    const postDetailMatch = path.match(/^\/api\/posts\/([^/]+)$/);
    if (method === "GET" && postDetailMatch) {
      const result = await getPostDetail(handle.pool, decodeURIComponent(postDetailMatch[1]));
      return result ? json(200, result) : fail(404, "帖子不存在");
    }
    if (method === "GET" && path === "/api/platforms") {
      return json(200, { platforms: await listPlatforms(handle.pool) });
    }
    if (method === "GET" && path === "/api/account-types") {
      const [accountTypes, platformCounts] = await Promise.all([
        listAccountTypes(handle.pool),
        listAccountTypePlatformCounts(handle.pool),
      ]);
      return json(200, { accountTypes, platformCounts });
    }
    if (method === "POST" && path === "/api/comment-jobs") {
      const body = await readJson(request);
      const job = await createCommentJob(handle, {
        accountIds: Array.isArray(body.accountIds) ? body.accountIds.map((id: unknown) => String(id)) : [],
        since: text(body.since),
        until: text(body.until),
        includeReplies: body.includeReplies !== false,
        maxCommentsPerPost: body.maxCommentsPerPost,
        maxRepliesPerComment: body.maxRepliesPerComment,
        maxPostsPerAccount: body.maxPostsPerAccount,
        includeZeroComments: Boolean(body.includeZeroComments),
      });
      return json(201, { job });
    }
    if (method === "GET" && path === "/api/comment-jobs") {
      const limit = Number.parseInt(url.searchParams.get("limit") || "20", 10) || 20;
      return json(200, {
        jobs: await listCommentJobs(handle, limit),
        tikHubConfigured: Boolean(process.env.TIKHUB_API_KEY),
        database: databaseTarget(),
      });
    }
    const commentJobFailedMatch = path.match(/^\/api\/comment-jobs\/([^/]+)\/failed-posts$/);
    if (method === "GET" && commentJobFailedMatch) {
      const posts = await listFailedCommentPosts(handle, decodeURIComponent(commentJobFailedMatch[1]));
      return json(200, { posts });
    }
    const commentJobRetryMatch = path.match(/^\/api\/comment-jobs\/([^/]+)\/retry-failed$/);
    if (method === "POST" && commentJobRetryMatch) {
      const job = await retryFailedCommentJob(handle, decodeURIComponent(commentJobRetryMatch[1]));
      return json(201, { job });
    }
    const commentJobMatch = path.match(/^\/api\/comment-jobs\/([^/]+)$/);
    if (method === "GET" && commentJobMatch) {
      const job = await getCommentJob(handle, decodeURIComponent(commentJobMatch[1]));
      return job ? json(200, { job }) : fail(404, "评论任务不存在");
    }
    if (method === "POST" && path === "/api/tasks") {
      const body = await readJson(request);
      const tasks = await createTasks(handle.pool, body);
      return json(201, { task: tasks[0], tasks });
    }
    if (method === "POST" && path === "/api/accounts") {
      const body = await readJson(request);
      return json(201, { account: await saveAccount(handle.pool, body) });
    }
    if (method === "POST" && path === "/api/accounts/import") {
      const body = await readJson(request);
      return json(200, await importAccounts(handle.pool, body));
    }
    const accountMatch = path.match(/^\/api\/accounts\/([^/]+)$/);
    if (method === "PUT" && accountMatch) {
      const body = await readJson(request);
      return json(200, { account: await saveAccount(handle.pool, body, decodeURIComponent(accountMatch[1])) });
    }
    const activeMatch = path.match(/^\/api\/accounts\/([^/]+)\/active$/);
    if (method === "PATCH" && activeMatch) {
      const body = await readJson(request);
      const id = decodeURIComponent(activeMatch[1]);
      const active = bool(body.active, true);
      const result = await handle.pool.query(
        "update social_accounts set active = $2, updated_ts_ms = $3 where id = $1 returning id",
        [id, active, Date.now()],
      );
      if (!result.rows.length) return fail(404, "账号不存在");
      return json(200, { ok: true, id, active });
    }
    return fail(404, "接口不存在");
  } catch (error: any) {
    const message = error?.message || String(error);
    if (error?.code === "23505") return fail(409, "同一平台下 handle 已存在");
    console.error(`[api] ${request.method} ${request.url} ${message}`);
    return fail(400, message);
  }
}
