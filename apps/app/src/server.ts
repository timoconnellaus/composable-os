// cos-app's Worker entry. /support/enter and /support/exit (hosted support access,
// src/server/support.ts) come first; the HTTP surface for client apps (/api/v1/*,
// src/server/http/api.ts) next; OAuth 2.1 and /mcp (src/server/mcp/handler.ts) wrap TanStack
// Start, which handles every other request; the cron trigger in wrangler.jsonc runs the scheduled
// Trash purge and expires pending approvals; a 10-minute one catches up embeddings and the policy
// adjudicator.

import { isApiPath, type RoutineDeliveryMessage } from "@composable-os/core";
import handler from "@tanstack/react-start/server-entry";
import { runAdjudicatorCron } from "./server/adjudicator.ts";
import { runEmbeddingCron } from "./server/ai.ts";

// Each person's assistant thread (ADR 0340), bound as ASSISTANT in wrangler.jsonc.
export { AssistantAgent } from "./server/assistant/agent.ts";
// One object per agent (ADR 0344), bound as AGENT_JOB.
export { AgentJob } from "./server/assistant/job.ts";

import { type AssistantHttpEnv, handleSocket, SOCKET_PATH } from "./server/assistant/http.ts";
import { runAgentJobCron } from "./server/assistant/job-cron.ts";
import { handleRoutineDeliveries } from "./server/assistant/routines.ts";
import {
  type ApiEnv,
  handleApi,
  handleCustomerAuth,
  isCustomerAuthPath,
} from "./server/http/api.ts";
import { authorize } from "./server/identity.ts";
import { createAppHandler } from "./server/mcp/handler.ts";
import { runBlobDeletionCron, runScheduledMaintenance } from "./server/purge.ts";
import { handleSupportRoute, isSupportRoute } from "./server/support.ts";

/**
 * The 10-minute cron in wrangler.jsonc: semantic search's embedding catch-up (ADR 0154), the
 * policy adjudicator's sweep (ADR 0204) and the blob deletion queue's retry (ADR 0320).
 */
const EMBEDDING_CRON = "*/10 * * * *";

const app = createAppHandler({ fetch: (request) => handler.fetch(request) });

async function assistantSocket(request: Request, env: Env): Promise<Response> {
  const result = await authorize(request, env, { handlerType: "router" });
  if (!result.ok) return result.response;
  return handleSocket(request, env as unknown as AssistantHttpEnv, result.principal);
}

async function apiResponse(request: Request, env: ApiEnv): Promise<Response> {
  return (await handleApi(request, env)) ?? new Response("Not found", { status: 404 });
}

export default {
  fetch(request, env, ctx) {
    // Hosted support access (ADR 0212): a 404 unless COS_SUPPORT_PUBLIC_KEY is set.
    const pathname = new URL(request.url).pathname;
    if (isSupportRoute(pathname)) return handleSupportRoute(request, env);
    // The assistant thread's WebSocket (ADR 0340) goes straight to the person's object: TanStack
    // Start does not pass a 101 response through. Identity is enforced here the same way.
    if (pathname === SOCKET_PATH) return assistantSocket(request, env);
    // The HTTP surface for client apps (stage 23, ADR 0403): /api/v1/*. It resolves its own
    // caller (staff, customer or public) from the request's session, so it is not behind the
    // staff-only identity middleware that guards TanStack Start's routes.
    if (isApiPath(pathname)) return apiResponse(request, env as unknown as ApiEnv);
    // Customer sign-in (stage 22's routes, mounted by stage 23): a code by email, then a session.
    if (isCustomerAuthPath(pathname)) return handleCustomerAuth(request, env as unknown as ApiEnv);
    return app.fetch(request, env, ctx);
  },
  // A routine's message from cos-runner (ADR 0343), into its owner's thread.
  async queue(batch, env) {
    await handleRoutineDeliveries(
      batch as MessageBatch<RoutineDeliveryMessage>,
      env as unknown as AssistantHttpEnv,
    );
  },
  scheduled(controller, env, ctx) {
    if (controller.cron === EMBEDDING_CRON) {
      ctx.waitUntil(runEmbeddingCron(env));
      ctx.waitUntil(runAdjudicatorCron(env));
      ctx.waitUntil(runBlobDeletionCron(env));
      ctx.waitUntil(runAgentJobCron(env));
      return;
    }
    ctx.waitUntil(runScheduledMaintenance(env));
  },
} satisfies ExportedHandler<Env>;
