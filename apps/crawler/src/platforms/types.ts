import type { Database } from "../db/factory.ts";
import type { Logger } from "../core/logger.ts";
import type { SourceAccount } from "../core/accounts.ts";

export type BrowserOptions = {
  browserMode: string;
  cdp?: string;
  userDataDir?: string;
  profileDirectory?: string;
  executablePath?: string;
  waitTimeoutMs?: number;
};

export type PlatformContext = {
  db: Database;
  runId: string;
  taskDateKey: number;
  sinceTsMs: number;
  untilTsMs: number;
  accountType: string;
  limit: number;
  /** 平台可选的单条内容等待时间（目前 YouTube 使用）。 */
  commentTimeoutMs?: number;
  /** runner 本次要抓的账号列表；prepare 阶段需要首账号的平台会用到。 */
  accounts?: SourceAccount[];
  logger: Logger;
  page: any;
  browserOptions: BrowserOptions;
};

export type AccountContext = PlatformContext & {
  account: SourceAccount;
};

export type AccountScrapeResult = {
  accountRow: any;
  contentRows: any[];
};

export type PlatformScraper = {
  code: string;
  name: string;
  /** 默认 true；fake/import 类平台可以设为 false。 */
  requiresBrowser?: boolean;
  prepare?: (ctx: PlatformContext) => Promise<void>;
  scrapeAccount: (ctx: AccountContext) => Promise<AccountScrapeResult>;
  dispose?: () => Promise<void>;
};
