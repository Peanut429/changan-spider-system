import assert from "node:assert/strict";
import { test } from "node:test";
import { numberOrNull, textOrNull } from "../../src/core/coerce.ts";
import { contentExternalId, errorCodeForMessage } from "../../src/db/persistence/normalize.ts";

test("numberOrNull parses localized numbers", () => {
  assert.equal(numberOrNull("1,234"), 1234);
  assert.equal(numberOrNull("1.2万"), 12000);
  assert.equal(numberOrNull("1.5K"), 1500);
  assert.equal(numberOrNull(""), null);
  assert.equal(numberOrNull(null), null);
});

test("textOrNull handles strings and object text fields", () => {
  assert.equal(textOrNull(" hi "), "hi");
  assert.equal(textOrNull({ text: "hello" }), "hello");
  assert.equal(textOrNull(""), null);
});

test("contentExternalId falls back through platform fields and url", () => {
  assert.equal(contentExternalId({ tweetId: "t1" }), "t1");
  assert.equal(contentExternalId({ videoId: "v1" }), "v1");
  assert.equal(contentExternalId({ url: "https://example.com/p/1" }), "https://example.com/p/1");
});

test("errorCodeForMessage classifies login and timeout", () => {
  assert.equal(errorCodeForMessage("需要登录"), "LOGIN_REQUIRED");
  assert.equal(errorCodeForMessage("request timeout"), "TIMEOUT");
  assert.equal(errorCodeForMessage("selector missing"), "SCRAPE_ERROR");
  assert.equal(errorCodeForMessage(""), null);
});
