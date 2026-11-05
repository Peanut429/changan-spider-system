import {
  createInstagramApiClient,
  fetchInstagramApiUserInfo,
  mergeInstagramApiUserInfo,
  scrapeInstagramApiPosts,
  scrapeInstagramApiReels,
  tikHubErrorDetails,
} from "./api.ts";
import type { InstagramApiClient, RawState } from "./api.ts";
import { FatalPlatformError } from "../errors.ts";
import type { AccountContext, AccountScrapeResult, PlatformScraper } from "../types.ts";

/**
 * Instagram 走 TikHub API，不启动浏览器。
 * 账号信息、帖子列表、Reels 列表都通过 API 获取；没有 API key 直接报错，不回退 browser。
 */
export function createInstagramScraper(): PlatformScraper {
  let client: InstagramApiClient | null = null;

  return {
    code: "instagram",
    name: "Instagram",
    requiresBrowser: false,

    async prepare() {
      client = await createInstagramApiClient({
        workspace: process.cwd(),
        source: "api",
      });
      if (!client.enabled) {
        throw new FatalPlatformError("Instagram API 未启用：缺少 TIKHUB_API_KEY");
      }
      console.log("已启用 Instagram API 数据源：TikHub");
    },

    async scrapeAccount(ctx: AccountContext): Promise<AccountScrapeResult> {
      if (!client) throw new Error("Instagram API client 未初始化");

      const source = ctx.account;
      const userInfo = await fetchInstagramApiUserInfo(source.account, client);
      if (userInfo.tikhubError) {
        throw new Error(`Instagram API 用户信息获取失败：${source.account} ${userInfo.tikhubError}`);
      }

      const accountRow = mergeInstagramApiUserInfo({
        account: source.account,
        profileUrl: source.link,
        followersText: "",
        followingText: "",
        postsText: "",
        error: "",
      }, userInfo);
      accountRow.tikhubPostsPageResponses = [];
      accountRow.tikhubReelsPageResponses = [];

      const rawState: RawState = { contents: [] };
      const args = {
        sinceTime: ctx.sinceTsMs,
        untilTime: ctx.untilTsMs,
        rangeTimeZone: process.env.SCRAPE_TIMEZONE || "Asia/Shanghai",
        limit: ctx.limit,
        stopAfterBeforeRange: 1,
      };

      try {
        const postStats = await scrapeInstagramApiPosts({
          account: source.account,
          userId: accountRow.tikhubUserId,
          client,
          args,
          rawState,
          rawPath: "",
          responseCollector: accountRow.tikhubPostsPageResponses,
        });
        const reelStats = await scrapeInstagramApiReels({
          account: source.account,
          userId: accountRow.tikhubUserId,
          client,
          args,
          rawState,
          rawPath: "",
          responseCollector: accountRow.tikhubReelsPageResponses,
        });
        console.log(
          `账号 ${source.account} API 完成：帖子 ${postStats.pages} 页/保留 ${postStats.kept}，`
          + `Reels ${reelStats.pages} 页/保留 ${reelStats.kept}。`,
        );
      } catch (error: any) {
        accountRow.error = error?.message || String(error);
        accountRow.tikhubListError = tikHubErrorDetails(error);
        console.error(`Instagram API 内容列表获取失败：${source.account} ${accountRow.error}`);
      }

      return { accountRow, contentRows: rawState.contents };
    },
  };
}
