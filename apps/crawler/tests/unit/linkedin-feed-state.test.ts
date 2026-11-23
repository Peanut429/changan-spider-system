import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCompanyFeed } from "../../src/platforms/linkedin/scraper.ts";

test("有排序控件的公司页是正常 feed，即使正文里出现空状态词", () => {
  assert.equal(
    classifyCompanyFeed({ text: "", hasSortControl: true, hasPost: true, hasHeader: true }),
    "control",
  );
  assert.equal(
    classifyCompanyFeed({ text: "还没有动态", hasSortControl: true, hasPost: true, hasHeader: true }),
    "control",
  );
});

test("没有动态的公司页判成 empty，不当错误", () => {
  assert.equal(
    classifyCompanyFeed({ text: "这家公司还没有动态", hasSortControl: false, hasPost: false, hasHeader: true }),
    "empty",
  );
  assert.equal(
    classifyCompanyFeed({ text: "This Page No posts yet", hasSortControl: false, hasPost: false, hasHeader: true }),
    "empty",
  );
});

test("有帖子但没有排序控件仍然是页面结构问题", () => {
  assert.equal(
    classifyCompanyFeed({ text: "", hasSortControl: false, hasPost: true, hasHeader: true }),
    "posts",
  );
});

test("什么都没认出来是 blank", () => {
  assert.equal(
    classifyCompanyFeed({ text: "", hasSortControl: false, hasPost: false, hasHeader: false }),
    "blank",
  );
});
