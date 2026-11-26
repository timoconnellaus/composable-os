// cos-app's Worker entry. Its entries are in src/server/entry.ts: each decides the client first
// (stage 66, ADR 0615; on a single-client deployment, one constant check), then runs as before.
// The desk origin (its own hostname, src/server/http/desk.ts) is answered first and serves
// nothing else; then /support/enter and /support/exit (hosted support access,
// src/server/support.ts) come first; the HTTP surface for client apps (/api/v1/*,
// src/server/http/api.ts) next; OAuth 2.1 and /mcp (src/server/mcp/handler.ts) wrap TanStack
// Start, which handles every other request; the cron trigger in wrangler.jsonc runs the scheduled
// Trash purge and expires pending approvals; a 10-minute one catches up embeddings and the policy
// adjudicator.

import { provideStaffCodes } from "@composable-os/auth";
import { setVideoHost } from "@composable-os/core";
import { servesManyClients } from "@composable-os/db/client-entries";
import { PRODUCT_LABEL_VAR, setProductLabel } from "@composable-os/product";
import handler from "@tanstack/react-start/server-entry";
import { type AppParts, hostFetch, hostQueue, hostScheduled } from "./server/entry.ts";
import { staffCodesFor } from "./server/host-mail.ts";
import type { ApiEnv } from "./server/http/api.ts";
import { createAppHandler } from "./server/mcp/handler.ts";
import { type VideoEnv, videoHostFor } from "./server/media.ts";
import { deploymentEnv } from "./server/request-env.ts";

// A client product's label (issue #155): a deploy-time var, read once per isolate, which every
// surface that shows the product's name uses. Unset: the build's own name.
setProductLabel(
  (deploymentEnv as unknown as Record<string, string | undefined>)[PRODUCT_LABEL_VAR],
);

// Videos in Cloudflare Stream (stage 42, ADR 0475): the account, its token and signing key are
// this Worker's own vars and secrets, read once per isolate.
// On a many-client host there is none yet: the token is every client's videos, and the host that
// stamps each upload with its client and refuses another creator is stage 66 step 5's (ADR 0615),
// so until then video is not configured for any client rather than shared by all of them.
if (!servesManyClients(deploymentEnv)) {
  setVideoHost(videoHostFor(deploymentEnv as unknown as VideoEnv));
}

// Staff sign-in codes go out as the host's own mail (ADR 0455). Given for the module env that
// TanStack Start's routes read (/api/auth/*) as well as the fetch handler's own; a client's
// environment is given them at its entry (src/server/entry.ts).
provideStaffCodes(deploymentEnv, staffCodesFor(deploymentEnv as unknown as ApiEnv));

// Each client's parked messages, counted and capped (stage 66, ADR 0615): bound only on a
// many-client host, by the deploy engine (step 7).
export { ParkingLedger } from "@composable-os/db/client-parking";
// Each person's assistant thread (ADR 0340), bound as ASSISTANT in wrangler.jsonc.
export { AssistantAgent } from "./server/assistant/agent.ts";
// One object per agent (ADR 0344), bound as AGENT_JOB.
export { AgentJob } from "./server/assistant/job.ts";
// The door a company's web app binds to (stage 24, ADR 0421): customers and the public only.
export { ClientApp } from "./server/http/bound.ts";

const parts: AppParts = {
  app: createAppHandler({ fetch: (request) => handler.fetch(request) }),
  start: (request) => handler.fetch(request),
};

export default {
  fetch: (request, env, ctx) => hostFetch(request, env, ctx, parts),
  queue: (batch, env) => hostQueue(batch, env),
  scheduled: (controller, env, ctx) => hostScheduled(controller, env, ctx),
} satisfies ExportedHandler<Env>;
