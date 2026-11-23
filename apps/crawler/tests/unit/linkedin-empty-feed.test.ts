import assert from "node:assert/strict";
import { test } from "node:test";
import { createLinkedInScraper } from "../../src/platforms/linkedin/scraper.ts";

/**
 * 一个“公司页没有动态”的假页面：
 * - 没有排序控件（locator.count() 一直是 0）
 * - DOM 快照直接是空状态（省掉轮询）
 * - 公司页 HTML 用 pageFetch 的 evaluate 返回值模拟
 */
function emptyCompanyPage() {
  const locator: any = {
    filter: () => locator,
    first: () => locator,
    count: async () => 0,
    innerText: async () => "",
    click: async () => {},
    waitFor: async () => null,
  };

  const page: any = {
    on: () => {},
    off: () => {},
    goto: async () => null,
    reload: async () => null,
    waitForTimeout: async () => {},
    waitForFunction: async () => null,
    keyboard: { press: async () => {} },
    mouse: { move: async () => {}, wheel: async () => {} },
    locator: () => locator,
    url: () => "https://www.linkedin.com/company/chery-europe-gmbh/posts/?feedView=all",
    evaluate: async (fn, arg) => {
      if (arg && typeof arg === "object" && "url" in arg) {
        return {
          status: 200,
          url: arg.url,
          text: "<html><head><title>Chery Europe: Posts | LinkedIn</title></head><body>12,345 位关注者</body></html>",
        };
      }
      return { text: "这家公司还没有动态", hasSortControl: false, hasPost: false, hasHeader: true };
    },
  };

  return page;
}

test("没有动态的公司页：prepare 不报错，账号按 0 条记录", async () => {
  const scraper = createLinkedInScraper();
  const page = emptyCompanyPage();
  const account = {
    account: "chery-europe-gmbh",
    link: "https://www.linkedin.com/company/chery-europe-gmbh/posts/",
  };

  // 模板页就是这家空公司：以前这里会抛“未找到排序控件”，现在应该直接跳过模板。
  await scraper.prepare({ page, accounts: [account] } as any);

  const result = await scraper.scrapeAccount({
    page,
    account,
    sinceTsMs: Date.parse("2026-11-01T00:00:00Z"),
    untilTsMs: Date.parse("2026-11-23T00:00:00Z"),
    limit: 0,
  } as any);

  assert.equal(result.contentRows.length, 0);
  assert.equal(result.accountRow.account, "chery-europe-gmbh");
  assert.equal(result.accountRow.displayName, "Chery Europe");
  assert.equal(result.accountRow.followersText, "12,345");
});
