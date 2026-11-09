import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../factory.ts";
import { socialAccounts } from "../schema.ts";
import { nowTsMs } from "../../core/db-time.ts";
import { prefixedId } from "../../core/id.ts";
import { textOrNull } from "../../core/coerce.ts";

/**
 * 把平台侧真实 ID 缓存到 social_accounts：
 *   external_account_id = TikTok user_id
 *   metadata_json.tiktok = { userId, secUid, resolvedAt }
 * 下次抓取直接读，不再调「用户名 → sec_user_id」的付费接口。
 */
export async function saveTikTokIdentity(
  db: Database,
  { platformId, handle, userId, secUid }: { platformId: string; handle: string; userId?: string; secUid: string },
): Promise<void> {
  const now = nowTsMs();
  const cached = JSON.stringify({
    userId: userId || "",
    secUid,
    resolvedAt: new Date(now).toISOString(),
  });
  const values: Record<string, any> = {
    metadataJson: sql`coalesce(${socialAccounts.metadataJson}, '{}'::jsonb) || jsonb_build_object('tiktok', ${cached}::jsonb)`,
    updatedTsMs: now,
  };
  if (userId) values.externalAccountId = userId;

  await db
    .update(socialAccounts)
    .set(values)
    .where(and(
      eq(socialAccounts.platformId, platformId),
      eq(socialAccounts.handle, handle),
    ));
}

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
