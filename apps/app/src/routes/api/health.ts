import { createFileRoute } from "@tanstack/react-router";
import { healthResponse } from "../../server/health.ts";
import { requestEnv } from "../../server/request-env.ts";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: () => healthResponse(requestEnv()),
    },
  },
});
