// GET /api/assistant/thread/stream?after=N: resume the running turn's events (ADR 0340).

import { createFileRoute } from "@tanstack/react-router";
import { handleStream } from "../../../server/assistant/http.ts";
import { requestEnv } from "../../../server/request-env.ts";

export const Route = createFileRoute("/api/assistant/thread/stream")({
  server: {
    handlers: {
      GET: ({ request, context }) =>
        handleStream(
          requestEnv(),
          context.principal ?? null,
          Number.parseInt(new URL(request.url).searchParams.get("after") ?? "0", 10),
        ),
    },
  },
});
