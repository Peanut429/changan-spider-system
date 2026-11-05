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
  limit = 0,
}: {
  db: Database;
  platformCode: string;
  accountType: string;
  account?: string;
  limit?: number;
}): Promise<SourceAccount[]> {
  const rows = await db
    .select({
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

  const filtered = rows
    .map((row) => ({ account: row.account, link: row.link }))
    .filter((row) => row.account && row.link)
    .filter((row) => !account || row.account === account);

  return limit > 0 ? filtered.slice(0, limit) : filtered;
}
