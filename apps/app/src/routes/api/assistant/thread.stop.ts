// POST /api/assistant/thread/stop: stop the running turn (ADR 0340).

import { createFileRoute } from "@tanstack/react-router";
import { handleStop } from "../../../server/assistant/http.ts";
import { requestEnv } from "../../../server/request-env.ts";

export const Route = createFileRoute("/api/assistant/thread/stop")({
  server: {
    handlers: {
      POST: ({ request, context }) => handleStop(request, requestEnv(), context.principal ?? null),
    },
  },
});
