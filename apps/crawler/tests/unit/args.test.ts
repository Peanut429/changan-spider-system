import assert from "node:assert/strict";
import { test } from "node:test";
import { numberArg, parseArgs, requireArg } from "../../src/config/args.ts";

test("parseArgs supports --key value, --key=value, flags and positionals", () => {
  const args = parseArgs(["--platform", "fake", "--limit=3", "pos", "--flag"]);

  assert.equal(args.values.get("platform"), "fake");
  assert.equal(args.values.get("limit"), "3");
  assert.equal(args.flags.has("flag"), true);
  assert.deepEqual(args.positionals, ["pos"]);
});

test("numberArg parses numbers and rejects invalid values", () => {
  const args = parseArgs(["--limit", "10"]);
  assert.equal(numberArg(args, "limit", 0), 10);
  assert.equal(numberArg(args, "missing", 5), 5);

  const bad = parseArgs(["--limit", "abc"]);
  assert.throws(() => numberArg(bad, "limit", 0), /必须是数字/);
});

test("requireArg throws for missing value", () => {
  const args = parseArgs(["--platform", "fake"]);
  assert.equal(requireArg(args, "platform"), "fake");
  assert.throws(() => requireArg(args, "run-id"), /缺少 --run-id/);
});
