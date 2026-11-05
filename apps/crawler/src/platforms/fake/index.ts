import type { PlatformScraper } from "../types.ts";

/**
 * 只用于验证 runner / 入库 / run 收口的假平台。
 * 不访问网络，不启动浏览器。
 */
export function createFakeScraper(): PlatformScraper {
  return {
    code: "fake",
    name: "Fake",
    requiresBrowser: false,
    async scrapeAccount({ account }) {
      if (account.account === "fail") {
        throw new Error("fake 平台按约定失败");
      }

      return {
        accountRow: {
          account: account.account,
          profileUrl: account.link,
          followersText: "1,234",
          followingText: "56",
          postsText: "7",
        },
        contentRows: [
          {
            account: account.account,
            externalContentId: "fake-content-1",
            url: `${account.link}/p/fake-content-1`,
            type: "post",
            title: "fake content",
            publishTime: "2026-01-01T00:00:00.000Z",
            playText: "100",
            likeText: "10",
            commentText: "2",
            collectText: "1",
            shareText: "0",
          },
        ],
      };
    },
  };
}
