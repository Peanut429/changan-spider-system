import type { Database } from "../factory.ts";
import { scrapeRawRecords } from "../schema.ts";
import { nowTsMs } from "../../core/db-time.ts";
import { prefixedId } from "../../core/id.ts";
import { errorCodeForMessage } from "../persistence/normalize.ts";

export async function insertRawRecord(
  db: Database,
  {
    runId,
    platformId,
    accountId,
    contentId,
    recordType,
    source,
    externalId,
    url,
    rawJson,
    errorMessage,
    errorCode,
    capturedTsMs,
  }: {
    runId: string;
    platformId: string;
    accountId?: string | null;
    contentId?: string | null;
    recordType: "account" | "content" | "metric" | "error" | "page_state" | "comment_post";
    source: string;
    externalId?: string | null;
    url?: string | null;
    rawJson: Record<string, any>;
    errorMessage?: string | null;
    /** 需要区分具体错误码时显式传入（例如 TIKHUB_API_FAILED）；不传则按消息推断。 */
    errorCode?: string | null;
    capturedTsMs: number;
  },
): Promise<string> {
  const id = prefixedId("raw");
  await db.insert(scrapeRawRecords).values({
    id,
    runId,
    accountId: accountId || null,
    contentId: contentId || null,
    platformId,
    recordType,
    source,
    externalId: externalId || null,
    url: url || null,
    rawJson,
    errorCode: errorCode === undefined ? errorCodeForMessage(errorMessage) : errorCode,
    errorMessage: errorMessage || null,
    capturedTsMs,
    createdTsMs: nowTsMs(),
  });
  return id;
}
