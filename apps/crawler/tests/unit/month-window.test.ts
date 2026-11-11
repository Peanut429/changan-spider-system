import assert from "node:assert/strict";
import { test } from "node:test";
import { lastMonthRange, resolveCommentWindow } from "../../src/core/month-window.ts";

test("lastMonthRange：跨年取上年 12 月", () => {
  const now = Date.parse("2026-01-05T10:00:00+08:00");
  assert.deepEqual(lastMonthRange(now, "Asia/Shanghai"), {
    sinceText: "2025-12-01",
    untilText: "2025-12-31",
  });
});

test("lastMonthRange：平年 2 月", () => {
  const now = Date.parse("2026-03-31T23:30:00+08:00");
  assert.deepEqual(lastMonthRange(now, "Asia/Shanghai"), {
    sinceText: "2026-02-01",
    untilText: "2026-02-28",
  });
});

test("lastMonthRange：闰年 2 月", () => {
  const now = Date.parse("2024-03-15T12:00:00+08:00");
  assert.deepEqual(lastMonthRange(now, "Asia/Shanghai"), {
    sinceText: "2024-02-01",
    untilText: "2024-02-29",
  });
});

test("resolveCommentWindow：显式日期按上海时区取整天", () => {
  const window = resolveCommentWindow({
    since: "2026-10-01",
    until: "2026-10-31",
    timeZone: "Asia/Shanghai",
  });
  assert.equal(window.source, "range");
  assert.equal(window.sinceTsMs, Date.parse("2026-09-30T16:00:00.000Z"));
  assert.equal(window.untilTsMs, Date.parse("2026-10-31T15:59:59.999Z"));
});

test("resolveCommentWindow：--last-month 自动算上月", () => {
  const window = resolveCommentWindow({
    lastMonth: true,
    now: Date.parse("2026-11-01T04:00:00+08:00"),
    timeZone: "Asia/Shanghai",
  });
  assert.equal(window.source, "last-month");
  assert.equal(window.sinceText, "2026-10-01");
  assert.equal(window.untilText, "2026-10-31");
  assert.equal(window.sinceTsMs, Date.parse("2026-09-30T16:00:00.000Z"));
  assert.equal(window.untilTsMs, Date.parse("2026-10-31T15:59:59.999Z"));
});

test("resolveCommentWindow：参数组合和格式校验", () => {
  assert.throws(
    () => resolveCommentWindow({ since: "2026-10-01", until: "2026-10-31", lastMonth: true }),
    /不能和/,
  );
  assert.throws(() => resolveCommentWindow({}), /--since\/--until/);
  assert.throws(
    () => resolveCommentWindow({ since: "2026-10-01" }),
    /--since\/--until/,
  );
  assert.throws(
    () => resolveCommentWindow({ since: "2026/10/01", until: "2026-10-31" }),
    /YYYY-MM-DD/,
  );
  assert.throws(
    () => resolveCommentWindow({ since: "2026-02-30", until: "2026-03-01" }),
    /YYYY-MM-DD/,
  );
  assert.throws(
    () => resolveCommentWindow({ since: "2026-13-01", until: "2026-13-31" }),
    /YYYY-MM-DD/,
  );
  assert.throws(
    () => resolveCommentWindow({ since: "2026-11-01", until: "2026-10-01" }),
    /不能晚于/,
  );
});
