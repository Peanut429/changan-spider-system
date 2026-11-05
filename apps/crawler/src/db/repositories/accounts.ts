import { and, eq } from "drizzle-orm";
import type { Database } from "../factory.ts";
import { socialAccounts } from "../schema.ts";
import { nowTsMs } from "../../core/db-time.ts";
import { prefixedId } from "../../core/id.ts";
import { textOrNull } from "../../core/coerce.ts";

export async function ensureAccount(db: Database, platformId: string, row: any): Promise<string> {
  const now = nowTsMs();
  const handle = String(row.account || row.handle || row.username || "").trim();
  if (!handle) throw new Error("账号行缺少 account 字段");

  const profileUrl = String(row.profileUrl || row.link || row.url || "").trim() || `unknown:${handle}`;
  const inserted = await db
    .insert(socialAccounts)
    .values({
      id: prefixedId("account"),
      platformId,
      handle,
      displayName: textOrNull(row.displayName || row.channel || row.account),
      profileUrl,
      externalAccountId: textOrNull(row.externalAccountId || row.channelId || row.tikhubUserId),
      active: true,
      metadataJson: {
        source: "scrape_result",
      },
      createdTsMs: now,
      updatedTsMs: now,
    })
    .onConflictDoNothing({
      target: [socialAccounts.platformId, socialAccounts.handle],
    })
    .returning({ id: socialAccounts.id });

  if (inserted[0]?.id) return inserted[0].id;

  const existing = await db
    .select({ id: socialAccounts.id })
    .from(socialAccounts)
    .where(and(
      eq(socialAccounts.platformId, platformId),
      eq(socialAccounts.handle, handle),
    ))
    .limit(1);

  if (!existing[0]?.id) {
    throw new Error(`未找到已存在账号：platformId=${platformId} handle=${handle}`);
  }
  return existing[0].id;
}
