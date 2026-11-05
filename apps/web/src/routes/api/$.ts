import { createFileRoute } from "@tanstack/react-router";
import { handleApiRequest } from "../../server/api.server.ts";

const handler = ({ request }: { request: Request }) => handleApiRequest(request);

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
