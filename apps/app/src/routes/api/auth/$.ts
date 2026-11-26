// Better Auth's routes (/api/auth/*). Absent when another identity adapter is active.

import { createIdentityProvider } from "@composable-os/auth";
import { createFileRoute } from "@tanstack/react-router";
import { requestEnv } from "../../../server/request-env.ts";

async function handle({ request }: { request: Request }) {
  const provider = createIdentityProvider(requestEnv());
  return (await provider.handle?.(request)) ?? new Response("Not found", { status: 404 });
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: { GET: handle, POST: handle },
  },
});
