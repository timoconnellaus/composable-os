// POST /api/assistant/turn (ADR 0200): send a message to the assistant; the reply streams back
// as server-sent events, to the person's one thread (ADR 0340).

import { createFileRoute } from "@tanstack/react-router";
import { handleTurn } from "../../../server/assistant/http.ts";
import { requestEnv } from "../../../server/request-env.ts";

export const Route = createFileRoute("/api/assistant/turn")({
  server: {
    handlers: {
      POST: ({ request, context }) => handleTurn(request, requestEnv(), context.principal ?? null),
    },
  },
});
