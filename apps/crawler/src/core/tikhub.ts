import { truncateText } from "./strings.ts";

/**
 * TikHub 通用客户端。
 *
 * 只做传输层：鉴权、限流、超时、重试、响应结构校验。
 * 翻页、字段归一化、入库由各评论 fetcher / runner 负责。
 *
 * 和旧项目 instagram-api.ts / tiktok api.ts 的约定保持一致：
 *   - Authorization: Bearer <TIKHUB_API_KEY>
 *   - 全局最小请求间隔（默认 120ms），避免瞬时打满套餐限制
 *   - 429 / 5xx / 网络错误重试；业务失败和响应结构异常不重试
 */

const DEFAULT_BASE_URL = "https://api.tikhub.io";
const DEFAULT_MIN_INTERVAL_MS = 120;
const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1000, 2000, 5000];
const REQUEST_TIMEOUT_MS = 30000;
const ERROR_BODY_LIMIT = 500;

let lastRequestAt = 0;

export type TikHubJsonValidator = (json: any) => string | null;

export type TikHubRequestOptions = {
  /** 日志里的接口名，例如「Instagram 帖子评论」。 */
  label: string;
  /** 返回 null 表示结构合法，返回字符串表示具体问题（不重试）。 */
  validate?: TikHubJsonValidator;
  /** 覆盖客户端的默认重试次数（含第一次）。 */
  maxAttempts?: number;
};

export type TikHubJsonGetter = (url: URL, options: TikHubRequestOptions) => Promise<any>;

export type TikHubClient = {
  apiKey: string;
  baseUrl: string;
  minIntervalMs: number;
  maxAttempts: number;
  enabled: boolean;
  getJson: TikHubJsonGetter;
};

export type TikHubErrorKind = "request_failed" | "http_error" | "business_error" | "invalid_payload";

export class TikHubError extends Error {
  readonly kind: TikHubErrorKind;
  readonly label: string;
  readonly requestUrl: string;
  readonly httpStatus: number | null;
  readonly responseCode: number | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly bodyExcerpt: string;

  constructor(input: {
    kind: TikHubErrorKind;
    label: string;
    requestUrl: string;
    message: string;
    httpStatus?: number | null;
    responseCode?: number | null;
    retryable: boolean;
    retryAfterMs?: number | null;
    bodyExcerpt?: string;
  }) {
    super(input.message);
    this.name = "TikHubError";
    this.kind = input.kind;
    this.label = input.label;
    this.requestUrl = input.requestUrl;
    this.httpStatus = input.httpStatus ?? null;
    this.responseCode = input.responseCode ?? null;
    this.retryable = input.retryable;
    this.retryAfterMs = input.retryAfterMs ?? null;
    this.bodyExcerpt = input.bodyExcerpt ?? "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRateLimit(minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) return;
  const waitMs = lastRequestAt + minIntervalMs - Date.now();
  if (waitMs > 0) await sleep(waitMs);
  lastRequestAt = Date.now();
}

function bodyExcerpt(text: string): string {
  return text.length > ERROR_BODY_LIMIT ? `${truncateText(text, ERROR_BODY_LIMIT)}...<truncated>` : text;
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 60000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 60000));
  return null;
}

function businessMessage(json: any): string {
  return String(
    json?.data?.errorMessage
    || json?.message
    || json?.message_zh
    || json?.detail?.message
    || "",
  ).trim();
}

type TikHubTransport = Pick<TikHubClient, "apiKey" | "minIntervalMs">;

async function requestOnce(client: TikHubTransport, url: URL, options: TikHubRequestOptions): Promise<any> {
  await waitForRateLimit(client.minIntervalMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${client.apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause: any) {
    throw new TikHubError({
      kind: "request_failed",
      label: options.label,
      requestUrl: url.toString(),
      message: `TikHub ${options.label}请求失败：${cause?.message || String(cause)}`,
      retryable: true,
      bodyExcerpt: bodyExcerpt(String(cause?.message || cause)),
    });
  }

  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new TikHubError({
      kind: "invalid_payload",
      label: options.label,
      requestUrl: url.toString(),
      message: `TikHub ${options.label}返回非 JSON 响应：HTTP ${response.status}`,
      httpStatus: response.status,
      // 网关/代理返回 HTML 通常是瞬时的，按可重试处理。
      retryable: response.status === 429 || response.status >= 500,
      bodyExcerpt: bodyExcerpt(text),
    });
  }

  const code = Number(json?.code ?? 200);
  const businessFailed = json?.data?.status === false;
  if (!response.ok || code !== 200 || businessFailed) {
    const message = businessMessage(json);
    throw new TikHubError({
      kind: "business_error",
      label: options.label,
      requestUrl: url.toString(),
      message: `TikHub ${options.label}失败：HTTP ${response.status} code=${json?.code ?? ""} ${message}`.trim(),
      httpStatus: response.status,
      responseCode: Number.isFinite(code) ? code : null,
      // 4xx / 429 按 HTTP 语义处理；业务失败重试通常也不会变好。
      retryable: response.status === 429 || response.status >= 500,
      retryAfterMs: retryAfterMs(response),
      bodyExcerpt: bodyExcerpt(text),
    });
  }

  if (options.validate) {
    const problem = options.validate(json);
    if (problem) {
      throw new TikHubError({
        kind: "invalid_payload",
        label: options.label,
        requestUrl: url.toString(),
        message: `TikHub ${options.label}响应结构异常：${problem}`,
        httpStatus: response.status,
        responseCode: Number.isFinite(code) ? code : null,
        retryable: false,
        bodyExcerpt: bodyExcerpt(text),
      });
    }
  }

  return json;
}

/**
 * 创建客户端。apiKey 为空时 enabled=false，由入口统一报错；
 * 这里不抛异常，方便 dry-run 之类的场景构造客户端。
 */
export function createTikHubClient(
  options: {
    apiKey?: string;
    baseUrl?: string;
    minIntervalMs?: number;
    maxAttempts?: number;
    /** 测试用：覆盖重试等待时间。 */
    retryDelaysMs?: number[];
  } = {},
): TikHubClient {
  const retryDelaysMs = options.retryDelaysMs?.length ? options.retryDelaysMs : RETRY_DELAYS_MS;
  const apiKey = String(options.apiKey ?? process.env.TIKHUB_API_KEY ?? "").trim();
  const baseUrl = String(options.baseUrl ?? process.env.TIKHUB_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const rawInterval = Number(options.minIntervalMs ?? process.env.TIKHUB_MIN_INTERVAL_MS ?? DEFAULT_MIN_INTERVAL_MS);
  const minIntervalMs = Number.isFinite(rawInterval) && rawInterval >= 0 ? rawInterval : DEFAULT_MIN_INTERVAL_MS;
  const rawAttempts = Number(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const maxAttempts = Number.isInteger(rawAttempts) && rawAttempts >= 1 ? rawAttempts : DEFAULT_MAX_ATTEMPTS;

  const clientBase = {
    apiKey,
    baseUrl,
    minIntervalMs,
    maxAttempts,
    enabled: Boolean(apiKey),
  };

  const getJson: TikHubJsonGetter = async (url, request) => {
    if (!clientBase.enabled) {
      throw new TikHubError({
        kind: "request_failed",
        label: request.label,
        requestUrl: url.toString(),
        message: "TikHub 未配置：缺少 TIKHUB_API_KEY",
        retryable: false,
      });
    }
    const attempts = Math.max(1, request.maxAttempts ?? clientBase.maxAttempts);
    for (let attempt = 0; ; attempt++) {
      try {
        return await requestOnce(clientBase, url, request);
      } catch (error) {
        if (!(error instanceof TikHubError) || !error.retryable || attempt + 1 >= attempts) {
          throw error;
        }
        const baseDelay = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)];
        const delayMs = Math.max(baseDelay, error.retryAfterMs ?? 0);
        console.warn(`[tikhub] ${request.label}第 ${attempt + 1} 次失败，${delayMs}ms 后重试：${error.message}`);
        await sleep(delayMs);
      }
    }
  };

  return { ...clientBase, getJson };
}
