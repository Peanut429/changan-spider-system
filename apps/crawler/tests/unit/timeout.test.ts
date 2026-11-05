import assert from "node:assert/strict";
import { test } from "node:test";
import { withTimeout } from "../../src/core/timeout.ts";

test("withTimeout 正常返回", async () => {
  const value = await withTimeout(Promise.resolve(1), 50, "test");
  assert.equal(value, 1);
});

test("withTimeout 超时抛错", async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 10, "test"),
    /test 超时/,
  );
});
