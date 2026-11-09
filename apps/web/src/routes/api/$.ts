import { createFileRoute } from "@tanstack/react-router";
import { handleApiRequest } from "../../server/api.server.ts";

// 部署在子路径（BASE_PATH=/changan-data）时，进来的 URL 也可能已经带前缀，
// 交给 handleApiRequest 之前统一剥掉，这样 /api/health 这种匹配逻辑不用改。
const base = import.meta.env.BASE_URL.replace(/\/$/, "");

function normalize(request: Request): Request {
  if (!base) return request;
  const url = new URL(request.url);
  if (url.pathname === base || url.pathname.startsWith(`${base}/`)) {
    url.pathname = url.pathname.slice(base.length) || "/";
    return new Request(url, request);
  }
  return request;
}

const handler = ({ request }: { request: Request }) => handleApiRequest(normalize(request));

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      GET: handler,
      POST: handler,
      PUT: handler,
      PATCH: handler,
      DELETE: handler,
      OPTIONS: handler,
    },
  },
});
