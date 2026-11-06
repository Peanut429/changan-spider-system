import { openDatabase } from "@changan/db";
import { prefixedId, endOfDayInTimeZone, scrapeWindowStartTsMs } from "@changan/shared";

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
  };
}

const ACCOUNT_FAILURE_CODES = new Set(["PARTIAL_ACCOUNTS_FAILED", "ALL_ACCOUNTS_FAILED"]);

type CoverageLike = {
  total?: number;
  success?: number;
  failed?: number;
  newAccounts?: number;
  running?: number;
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
  const resolved = resolveTaskStatus(task, coverage);
  task.status = resolved.status;
  task.runStatus = resolved.runStatus;
  return task;
}

const taskSelect = `
  select t.id, t.platform_id, p.code as platform_code, p.name as platform_name,
         t.account_type, t.params, t.priority,
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
        and t.params->>'parentTaskId' is null
        and (to_timestamp(t.scheduled_at_ms / 1000) at time zone $2)::date = $1::date
      order by t.priority asc, t.scheduled_at_ms asc, t.created_ts_ms asc`,
    [date, TIME_ZONE],
  );
  const executedResult = await pool.query(
    `${taskSelect}
      where t.status in ('running', 'success', 'failed', 'cancelled')
        and t.params->>'parentTaskId' is null
        and (to_timestamp(coalesce(r.started_ts_ms, t.scheduled_at_ms) / 1000) at time zone $2)::date = $1::date
      order by coalesce(r.started_ts_ms, t.scheduled_at_ms) asc, t.priority asc`,
    [date, TIME_ZONE],
  );
  const pendingRows = await Promise.all(pendingResult.rows.map(async (row: any) => {
    const task = taskRow(row);
    const { coverage } = await loadTaskCoverage(pool, row);
    return applyCoverage(task, coverage);
  }));
  const executedRows = await Promise.all(executedResult.rows.map(async (row: any) => {
    const task = taskRow(row);
    const { coverage } = await loadTaskCoverage(pool, row);
    return applyCoverage(task, coverage);
  }));
  const pending = pendingRows;
  const executed = executedRows;
  const summary = {
    pending: pending.length,
    running: executed.filter((task: any) => task.status === "running").length,
    success: executed.filter((task: any) => task.status === "success").length,
    failed: executed.filter((task: any) => task.status === "failed").length,
    cancelled: executed.filter((task: any) => task.status === "cancelled").length,
    accountsSuccess: executed.reduce((sum: number, task: any) => sum + task.successAccounts, 0),
    accountsFailed: executed.reduce((sum: number, task: any) => sum + task.failedAccounts, 0),
    contentsSuccess: executed.reduce((sum: number, task: any) => sum + task.contentMetricCount, 0),
  };
  return { date, summary, pending, executed };
}


async function loadTaskCoverage(pool: any, task: any): Promise<Json> {
  const params = task.params || {};
  const scopeAccountIds = Array.isArray(params.accountIds)
    ? params.accountIds.map((value: unknown) => String(value)).filter(Boolean)
    : null;
  const accountFilter = text(params.account);
  const accountsResult = await pool.query(
    `select a.id, a.handle, a.display_name, a.profile_url, a.active,
            a.account_type, a.metadata_json->>'source' as source,
            to_char(to_timestamp(a.created_ts_ms/1000) at time zone 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS') as created_at,
            to_char(to_timestamp(a.updated_ts_ms/1000) at time zone 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS') as updated_at,
            p.code as platform_code
       from social_accounts a
       join platforms p on p.id = a.platform_id
      where a.platform_id = $1
        and ($2::text is null or a.account_type = $2)
        and ($3::text = '' or a.handle = $3)
        and ($4::boolean = false or a.id = any($5::text[]))
      order by a.handle`,
    [task.platform_id, task.account_type, accountFilter, Boolean(scopeAccountIds), scopeAccountIds || []],
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

  const accounts = accountsResult.rows.map((account: any) => {
    const history = byAccount.get(account.id) || [];
    const latest = history.length ? history[history.length - 1] : null;
    const latestSuccess = [...history].reverse().find((row) => row.status === "success") || null;
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
    };
  });

  const active = accounts.filter((account: any) => account.status !== "disabled");
  const coverage = {
    total: active.length,
    success: active.filter((account: any) => account.status === "success").length,
    failed: active.filter((account: any) => account.status === "failed" || account.status === "partial").length,
    newAccounts: active.filter((account: any) => account.status === "pending").length,
    running: active.filter((account: any) => account.status === "running").length,
    zeroContent: active.filter((account: any) => account.status === "success" && Number(account.contentCountInWindow || 0) === 0).length,
    disabled: accounts.length - active.length,
  };

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
    runId: row.run_id,
    runStatus: row.run_status,
    runStartedAt: iso(row.started_ts_ms),
    runFinishedAt: iso(row.finished_ts_ms),
  }));

  return { accounts, contents, coverage, childTasks };
}

async function taskDetail(pool: any, id: string): Promise<Json | null> {
  const taskResult = await pool.query(`${taskSelect} where t.id = $1`, [id]);
  if (!taskResult.rows.length) return null;
  const rawTask = taskResult.rows[0];
  const coverageData = await loadTaskCoverage(pool, rawTask);
  const task = applyCoverage(taskRow(rawTask), coverageData.coverage);

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
    accounts: result.rows.map((row: any) => ({
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
  return result.rows.map((row: any) => row.account_type);
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
      const body = await readJson(request);
      const mode = text(body.mode);
      if (!["failed", "new", "selected"].includes(mode)) return fail(400, "mode 必须是 failed、new 或 selected");

      const busy = await handle.pool.query(
        "select id from scrape_tasks where params->>'parentTaskId' = $1 and status in ('pending','running') limit 1",
        [parentId],
      );
      if (busy.rows.length) return fail(409, "已有补跑任务正在等待或执行");

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
    if (method === "DELETE" && taskMatch) {
      const id = decodeURIComponent(taskMatch[1]);
      const current = await handle.pool.query("select status from scrape_tasks where id = $1", [id]);
      if (!current.rows.length) return fail(404, "任务不存在");
      if (current.rows[0].status !== "pending") return fail(409, "只有待执行任务可以删除");
      await handle.pool.query("delete from scrape_tasks where id = $1 and status = 'pending'", [id]);
      return json(200, { ok: true, id });
    }
    if (method === "GET" && path === "/api/accounts") {
      return json(200, await listAccounts(handle.pool, url));
    }
    if (method === "GET" && path === "/api/platforms") {
      return json(200, { platforms: await listPlatforms(handle.pool) });
    }
    if (method === "GET" && path === "/api/account-types") {
      return json(200, { accountTypes: await listAccountTypes(handle.pool) });
    }
    if (method === "POST" && path === "/api/tasks") {
      const body = await readJson(request);
      return json(201, { task: await createTask(handle.pool, body) });
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
