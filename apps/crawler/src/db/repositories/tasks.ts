import type { PoolClient } from "pg";
import type { DbHandle } from "../factory.ts";

export type ScrapeTask = {
  id: string;
  platformId: string;
  platformCode: string;
  categoryId: string | null;
  categoryName: string | null;
  accountType: string | null;
  params: Record<string, any>;
  priority: number;
  status: string;
  scheduledAtMs: number;
  attempts: number;
  leaseOwner: string | null;
  leaseUntilMs: number | null;
  runId: string | null;
};

export type TaskAccount = {
  id: string;
  handle: string;
  profileUrl: string;
};

function mapTask(row: any): ScrapeTask {
  return {
    id: row.id,
    platformId: row.platform_id,
    platformCode: row.platform_code,
    categoryId: row.category_id,
    categoryName: row.category_name ?? null,
    accountType: row.account_type,
    params: row.params || {},
    priority: Number(row.priority),
    status: row.status,
    scheduledAtMs: Number(row.scheduled_at_ms),
    attempts: Number(row.attempts),
    leaseOwner: row.lease_owner,
    leaseUntilMs: row.lease_until_ms == null ? null : Number(row.lease_until_ms),
    runId: row.run_id,
  };
}

export async function claimNextTask(
  handle: DbHandle,
  workerId: string,
  nowMs = Date.now(),
  leaseMs = 60 * 60 * 1000,
): Promise<ScrapeTask | null> {
  const client: PoolClient = await handle.pool.connect();
  try {
    await client.query("begin");
    const selected = await client.query(
      `select t.*, p.code as platform_code, c.name as category_name
         from scrape_tasks t
         join platforms p on p.id = t.platform_id
         left join account_categories c on c.id = t.category_id
        where t.status = 'pending'
          and t.scheduled_at_ms <= $1
        order by t.priority asc, t.scheduled_at_ms asc, t.created_ts_ms asc
        for update of t skip locked
        limit 1`,
      [nowMs],
    );
    if (!selected.rows.length) {
      await client.query("commit");
      return null;
    }
    const row = selected.rows[0];
    const updated = await client.query(
      `update scrape_tasks
          set status = 'running',
              lease_owner = $2,
              lease_until_ms = $3,
              attempts = attempts + 1,
              updated_ts_ms = $4
        where id = $1
        returning *`,
      [row.id, workerId, nowMs + leaseMs, nowMs],
    );
    await client.query("commit");
    return mapTask({ ...row, ...updated.rows[0], platform_code: row.platform_code, category_name: row.category_name });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function releaseTask(handle: DbHandle, taskId: string, nowMs = Date.now()): Promise<void> {
  await handle.pool.query(
    `update scrape_tasks
        set status = 'pending',
            lease_owner = null,
            lease_until_ms = null,
            updated_ts_ms = $2
      where id = $1 and status = 'running'`,
    [taskId, nowMs],
  );
}

export async function resolveTaskAccounts(handle: DbHandle, task: ScrapeTask): Promise<TaskAccount[]> {
  const conditions = ["a.platform_id = $1", "a.active = true"];
  const values: any[] = [task.platformId];
  if (task.categoryId) {
    values.push(task.categoryId);
    conditions.push(`exists (
      select 1 from account_category_members m
       where m.account_id = a.id and m.category_id = $${values.length}
    )`);
  } else if (task.accountType) {
    // Legacy tasks only have the single account_type string.
    values.push(task.accountType);
    conditions.push(`a.account_type = $${values.length}`);
  }
  const result = await handle.pool.query(
    `select a.id, a.handle, a.profile_url
       from social_accounts a
      where ${conditions.join(" and ")}
      order by a.handle`,
    values,
  );
  return result.rows.map((row) => ({ id: row.id, handle: row.handle, profileUrl: row.profile_url }));
}

