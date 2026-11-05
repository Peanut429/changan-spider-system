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
    capturedTsMs,
  }: {
    runId: string;
    platformId: string;
    accountId?: string | null;
    contentId?: string | null;
    recordType: "account" | "content" | "metric" | "error" | "page_state";
    source: string;
    externalId?: string | null;
    url?: string | null;
    rawJson: Record<string, any>;
    errorMessage?: string | null;
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
    errorCode: errorCodeForMessage(errorMessage),
    errorMessage: errorMessage || null,
    capturedTsMs,
    createdTsMs: nowTsMs(),
  });
  return id;
}
