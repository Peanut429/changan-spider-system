import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createTikHubClient, TikHubError } from "../../src/core/tikhub.ts";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function withServer(handler: Handler, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

test("TikHub 客户端带 Bearer 头并返回 JSON", async () => {
  let authorization = "";
  let requestUrl = "";
  await withServer((req, res) => {
    authorization = String(req.headers.authorization || "");
    requestUrl = String(req.url || "");
    jsonResponse(res, 200, { code: 200, data: { ok: true } });
  }, async (baseUrl) => {
    const client = createTikHubClient({ apiKey: "test-key", baseUrl, minIntervalMs: 0 });
    const json = await client.getJson(new URL(`${baseUrl}/api/v1/demo?x=1`), { label: "演示" });
    assert.deepEqual(json.data, { ok: true });
    assert.equal(authorization, "Bearer test-key");
    assert.equal(requestUrl, "/api/v1/demo?x=1");
  });
});

test("TikHub 客户端对 5xx 重试", async () => {
  let calls = 0;
  await withServer((_req, res) => {
    calls += 1;
    if (calls < 3) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("upstream error");
      return;
    }
    jsonResponse(res, 200, { code: 200, data: { ok: true } });
  }, async (baseUrl) => {
    const client = createTikHubClient({
      apiKey: "test-key",
      baseUrl,
      minIntervalMs: 0,
      maxAttempts: 3,
      retryDelaysMs: [0, 0],
    });
    const json = await client.getJson(new URL(`${baseUrl}/api/v1/demo`), { label: "演示" });
    assert.deepEqual(json.data, { ok: true });
    assert.equal(calls, 3);
  });
});

test("TikHub 客户端对 429 重试", async () => {
  let calls = 0;
  await withServer((_req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "rate limited" }));
      return;
    }
    jsonResponse(res, 200, { code: 200, data: { ok: true } });
  }, async (baseUrl) => {
    const client = createTikHubClient({
      apiKey: "test-key",
      baseUrl,
      minIntervalMs: 0,
      retryDelaysMs: [0],
    });
    await client.getJson(new URL(`${baseUrl}/api/v1/demo`), { label: "演示" });
    assert.equal(calls, 2);
  });
});

test("TikHub 客户端对 4xx 不重试", async () => {
  let calls = 0;
  await withServer((_req, res) => {
    calls += 1;
    jsonResponse(res, 404, { detail: "not found" });
  }, async (baseUrl) => {
    const client = createTikHubClient({
      apiKey: "test-key",
      baseUrl,
      minIntervalMs: 0,
      retryDelaysMs: [0, 0],
    });
    await assert.rejects(
      () => client.getJson(new URL(`${baseUrl}/api/v1/demo`), { label: "演示" }),
      (error: unknown) => {
        assert.ok(error instanceof TikHubError);
        assert.equal(error.kind, "business_error");
        assert.equal(error.retryable, false);
        assert.equal(error.httpStatus, 404);
        return true;
      },
    );
    assert.equal(calls, 1);
  });
});

test("TikHub 业务 code 非 200 不重试", async () => {
  let calls = 0;
  await withServer((_req, res) => {
    calls += 1;
    jsonResponse(res, 200, { code: 400, message: "invalid parameter" });
  }, async (baseUrl) => {
    const client = createTikHubClient({
      apiKey: "test-key",
      baseUrl,
      minIntervalMs: 0,
      retryDelaysMs: [0, 0],
    });
    await assert.rejects(
      () => client.getJson(new URL(`${baseUrl}/api/v1/demo`), { label: "演示" }),
      (error: unknown) => {
        assert.ok(error instanceof TikHubError);
        assert.equal(error.kind, "business_error");
        assert.equal(error.responseCode, 400);
        assert.equal(error.retryable, false);
        assert.match(error.message, /invalid parameter/);
        return true;
      },
    );
    assert.equal(calls, 1);
  });
});

test("TikHub 响应结构异常不重试", async () => {
  let calls = 0;
  await withServer((_req, res) => {
    calls += 1;
    jsonResponse(res, 200, { code: 200, data: {} });
  }, async (baseUrl) => {
    const client = createTikHubClient({
      apiKey: "test-key",
      baseUrl,
      minIntervalMs: 0,
      retryDelaysMs: [0, 0],
    });
    await assert.rejects(
      () => client.getJson(new URL(`${baseUrl}/api/v1/demo`), {
        label: "演示",
        validate: (json) => (Array.isArray(json?.data?.items) ? null : "缺少 data.items"),
      }),
      (error: unknown) => {
        assert.ok(error instanceof TikHubError);
        assert.equal(error.kind, "invalid_payload");
        assert.equal(error.retryable, false);
        assert.match(error.message, /缺少 data.items/);
        return true;
      },
    );
    assert.equal(calls, 1);
  });
});

test("TikHub 未配置 Key 时不发请求", async () => {
  let calls = 0;
  await withServer((_req, res) => {
    calls += 1;
    jsonResponse(res, 200, { code: 200 });
  }, async (baseUrl) => {
    const client = createTikHubClient({ apiKey: "", baseUrl, minIntervalMs: 0 });
    assert.equal(client.enabled, false);
    await assert.rejects(
      () => client.getJson(new URL(`${baseUrl}/api/v1/demo`), { label: "演示" }),
      /缺少 TIKHUB_API_KEY/,
    );
    assert.equal(calls, 0);
  });
});
