import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPublishTime, describeTimeFields, PublishTimeError } from "../../src/platforms/publish-time.ts";
import { writeRunLog } from "../../src/db/repositories/runs.ts";

test("describeTimeFields 能认出被改名的字段（taken_at → taken_at_ms）", () => {
  const fields = describeTimeFields({
    id: "3412",
    code: "C8xY",
    taken_at_ms: 1763500000000,
    stats: { play_count: 10 },
    nested: { deeper: { creation_time_ms: 1763500000001 } },
  });
  assert.equal(fields["taken_at_ms"], "1763500000000");
  assert.ok(Object.keys(fields).some((key) => key.endsWith("creation_time_ms")));
});

test("assertPublishTime 抛出带完整现场数据的 PublishTimeError", () => {
  const source = { id: "3412", code: "C8xY", taken_at_ms: 1763500000000, like_count: 128 };
  let thrown: any = null;
  try {
    assertPublishTime({
      platform: "instagram",
      account: "byd.spain",
      kind: "reel",
      url: "https://www.instagram.com/reel/C8xY/",
      publishTime: "",
      source,
    });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof PublishTimeError, "应当是 PublishTimeError");
  assert.equal(thrown.errorCode, "PUBLISH_TIME_MISSING");
  assert.equal(thrown.pageUrl, "https://www.instagram.com/reel/C8xY/");
  // 完整原始响应必须原样带上，而不是被截断成一句话
  assert.deepEqual(thrown.context.raw, source);
  assert.equal((thrown.context.timeFields as Record<string, string>)["taken_at_ms"], "1763500000000");
  assert.match(thrown.message, /取不到发布时间/);
});

test("writeRunLog 把 context 原样写进 context_json", async () => {
  const inserted: any[] = [];
  const fakeDb = {
    insert: () => ({ values: async (values: any) => { inserted.push(values); } }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  } as any;

  const raw = { id: "3412", taken_at_ms: 1763500000000, nested: { deep: ["a", "b"] } };
  await writeRunLog(fakeDb, {
    runId: "run-test",
    level: "error",
    step: "publish_time",
    message: "instagram 取不到发布时间",
    errorCode: "PUBLISH_TIME_MISSING",
    errorStack: "Error: ...",
    pageUrl: "https://www.instagram.com/reel/C8xY/",
    context: { platform: "instagram", account: "byd.spain", raw },
  });

  assert.equal(inserted.length, 1);
  const row = inserted[0];
  assert.equal(row.runId, "run-test");
  assert.equal(row.level, "error");
  assert.equal(row.step, "publish_time");
  assert.equal(row.errorCode, "PUBLISH_TIME_MISSING");
  assert.equal(row.pageUrl, "https://www.instagram.com/reel/C8xY/");
  assert.deepEqual(row.contextJson.context ?? row.contextJson, { platform: "instagram", account: "byd.spain", raw });
});
