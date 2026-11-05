export type PageFetchOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
  attempts?: number;
};

export type PageFetchResult = {
  status: number;
  url: string;
  text: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 在登录态页面里发 HTTP 请求。只做请求级超时/重试，不限制账号或任务总时长。
 * 超时、网络错误、429、5xx 会重试；其他状态交给调用方判断业务错误。
 */
export async function pageFetch(
  page: any,
  url: string,
  {
    method = "GET",
    headers = {},
    body = null,
    timeoutMs = 60000,
    attempts = 3,
  }: PageFetchOptions = {},
): Promise<PageFetchResult> {
  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let result: any = null;
    try {
      result = await page.evaluate(async ({ url, method, headers, body, timeoutMs }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(url, {
            method,
            headers,
            body,
            credentials: "include",
            redirect: "follow",
            signal: controller.signal,
          });
          const text = await response.text();
          return { status: response.status, url: response.url, text };
        } catch (error: any) {
          const message = error?.name === "AbortError"
            ? `请求超时（${timeoutMs}ms 未返回）`
            : String(error?.message || error);
          return { error: message };
        } finally {
          clearTimeout(timer);
        }
      }, { url, method, headers, body, timeoutMs });
    } catch (error: any) {
      result = { error: String(error?.message || error) };
    }

    if (!result?.error && result.status !== 429 && result.status < 500) {
      return result;
    }
    lastError = result?.error || `HTTP ${result?.status}`;
    if (attempt < attempts) {
      console.warn(`[http] 请求失败，第 ${attempt} 次重试：${lastError}`);
      await sleep(1000 * attempt);
    }
  }
  throw new Error(`请求失败（已重试 ${attempts} 次）：${lastError}`);
}

export async function gotoWithRetry(
  page: any,
  url: string,
  options: { waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit"; timeout?: number } = {},
  attempts = 2,
): Promise<void> {
  let lastError: any = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await page.goto(url, options);
      return;
    } catch (error: any) {
      lastError = error;
      if (attempt < attempts) {
        console.warn(`[http] 页面打开失败，第 ${attempt} 次重试：${error?.message || error}`);
        await sleep(1000 * attempt);
      }
    }
  }
  throw lastError || new Error("页面打开失败");
}
