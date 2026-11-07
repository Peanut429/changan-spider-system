import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/factory.ts";
import { platforms, socialAccounts } from "../db/schema.ts";

export type SourceAccount = {
  account: string;
  link: string;
};

export async function loadPlatformAccounts({
  db,
  platformCode,
  accountType,
  categoryId,
  account,
  accountIds,
  limit = 0,
}: {
  db: Database;
  platformCode: string;
  accountType?: string;
  categoryId?: string;
  account?: string;
  accountIds?: string[];
  limit?: number;
}): Promise<SourceAccount[]> {
  // A category task selects accounts through the many-to-many membership;
  // old tasks still carry the single account_type string.
  const typeScope = categoryId
    ? sql`exists (
        select 1 from account_category_members m
         where m.account_id = ${socialAccounts.id}
           and m.category_id = ${categoryId}
      )`
    : accountType
      ? eq(socialAccounts.accountType, accountType)
      : sql`true`;

  const rows = await db
    .select({
      id: socialAccounts.id,
      account: socialAccounts.handle,
      link: socialAccounts.profileUrl,
    })
    .from(socialAccounts)
    .innerJoin(platforms, eq(platforms.id, socialAccounts.platformId))
    .where(and(
      eq(platforms.code, platformCode),
      eq(platforms.enabled, true),
      eq(socialAccounts.active, true),
      typeScope,
    ))
    .orderBy(socialAccounts.handle);

  const neededIds = accountIds?.length ? new Set(accountIds) : null;
  const filtered = rows
    .filter((row) => !neededIds || neededIds.has(row.id))
    .map((row) => ({ account: row.account, link: row.link }))
    .filter((row) => row.account && row.link)
    .filter((row) => !account || row.account === account);

  return limit > 0 ? filtered.slice(0, limit) : filtered;
}
