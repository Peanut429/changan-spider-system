import { and, eq } from "drizzle-orm";
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
  account,
  accountIds,
  limit = 0,
}: {
  db: Database;
  platformCode: string;
  accountType: string;
  account?: string;
  accountIds?: string[];
  limit?: number;
}): Promise<SourceAccount[]> {
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
      eq(socialAccounts.accountType, accountType),
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
