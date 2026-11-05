import { sql } from "drizzle-orm";
import type { Database } from "../factory.ts";
import { socialContents } from "../schema.ts";
import { nowTsMs } from "../../core/db-time.ts";
import { prefixedId } from "../../core/id.ts";
import { textOrNull, timestampOrNull } from "../../core/coerce.ts";
import { contentExternalId, contentSummary, contentTitle, contentUrl } from "../persistence/normalize.ts";

export async function upsertContent(
  db: Database,
  {
    platformId,
    accountId,
    row,
    capturedTsMs,
  }: {
    platformId: string;
    accountId: string;
    row: any;
    capturedTsMs: number;
  },
): Promise<string | null> {
  const url = contentUrl(row);
  if (!url) return null;

  const now = nowTsMs();
  const externalId = contentExternalId(row) || url;
  const contentType = textOrNull(row.type);
  const publishTsMs = timestampOrNull(
    row.publishTsMs || row.networkPublishTsMs || row.publishTime || row.publishDate || row.uploadDate,
  );
  const title = contentTitle(row);
  const summary = contentSummary(row);

  const rows = await db
    .insert(socialContents)
    .values({
      id: prefixedId("cont"),
      platformId,
      accountId,
      externalContentId: externalId,
      url,
      contentType,
      publishTsMs,
      firstSeenTsMs: capturedTsMs,
      lastSeenTsMs: capturedTsMs,
      title,
      contentSummary: summary,
      excerptFetchStatus: summary ? "fetched" : "pending",
      createdTsMs: now,
      updatedTsMs: now,
    })
    .onConflictDoUpdate({
      target: [socialContents.platformId, socialContents.accountId, socialContents.externalContentId],
      set: {
        accountId,
        url,
        contentType: sql`coalesce(excluded.content_type, ${socialContents.contentType})`,
        publishTsMs: sql`coalesce(excluded.publish_ts_ms, ${socialContents.publishTsMs})`,
        lastSeenTsMs: capturedTsMs,
        title: sql`coalesce(excluded.title, ${socialContents.title})`,
        contentSummary: sql`coalesce(excluded.content_summary, ${socialContents.contentSummary})`,
        excerptFetchStatus: sql`case when excluded.content_summary is not null then 'fetched' else ${socialContents.excerptFetchStatus} end`,
        updatedTsMs: now,
      },
    })
    .returning({ id: socialContents.id });

  return rows[0].id;
}
