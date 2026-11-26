// cos-app's entries (src/server.ts exports them): `fetch`, `queue` and `scheduled`. Each decides
// the client first, then runs as before on that client's environment (stage 66 step 4, ADR 0615).
//
// - fetch: the hostname the request reached, among the registry's verified staff hostnames. An
//   unknown hostname is a plain 404 before any other code; a client paused, moving or whose
//   schema is behind gets "being updated". Then everything below runs on the client's `env`, and
//   code that reads no `env` of its own (TanStack Start's middleware, its server functions, the
//   routes) reads it through `requestEnv()`, held for the request.
// - queue: cos-routine-delivery's messages carry the client the runner's wrapper stamped on
//   them; the fan-out queue's carry one client's cron tick each.
// - scheduled: on a many-client host a cron tick only fans out, one message per client served,
//   and each client's work runs when its message is consumed.
//
// A single-client deployment (no REGISTRY) takes none of these steps: one constant check, then
// the same code as before on the real `env`.
import { provideStaffCodes } from "@composable-os/auth";
import {
  coreInvoker,
  handleMedia,
  isApiPath,
  isMediaPath,
  type RoutineDeliveryMessage,
} from "@composable-os/core";
import {
  consumeByClient,
  consumeDeadLetters,
  consumeFanOut,
  decideRequest,
  fanOutCron,
  isDeadLetterQueue,
  isFanOutQueue,
  servesManyClients,
} from "@composable-os/db/client-entries";
import { runAdjudicatorCron } from "./adjudicator.ts";
import { runEmbeddingCron } from "./ai.ts";
import { type AssistantHttpEnv, handleSocket, SOCKET_PATH } from "./assistant/http.ts";
import { runAgentJobCron } from "./assistant/job-cron.ts";
import { handleRoutineDeliveries } from "./assistant/routines.ts";
import { isDeskRequest } from "./desk.ts";
import { staffCodesFor } from "./host-mail.ts";
import { handleAgreementPdf, isAgreementPdfPath } from "./http/agreement-pdf.ts";
import {
  type ApiEnv,
  apiContext,
  handleApi,
  handleCustomerAuth,
  handlePractitionerAuth,
  isCustomerAuthPath,
  isPractitionerAuthPath,
} from "./http/api.ts";
import { handleBound } from "./http/bound.ts";
import {
  type CustomerFeedEnv,
  handleCustomerFeed,
  isCustomerFeedPath,
} from "./http/customer-feed.ts";
import { type DeskHandlerEnv, handleDesk, isDeskPath } from "./http/desk.ts";
import { type FormPageEnv, handleFormPage, hostVisitor, isFormPagePath } from "./http/form-page.ts";
import { handleNativeStaffSignIn, NATIVE_STAFF_SIGN_IN_PATH } from "./http/native.ts";
import { handleStaffFeed, isStaffFeedPath, type StaffFeedEnv } from "./http/staffing-feed.ts";
import { authorize } from "./identity.ts";
import { type MediaEnv, mediaResizerFor, mediaStoreFor } from "./media.ts";
import { runBlobDeletionCron, runScheduledMaintenance } from "./purge.ts";
import { runInClientEnv } from "./request-env.ts";
import { handleSupportRoute, isSupportRoute } from "./support.ts";

/**
 * The 10-minute cron in wrangler.jsonc: semantic search's embedding catch-up (ADR 0154), the
 * policy adjudicator's sweep (ADR 0204) and the blob deletion queue's retry (ADR 0320).
 */
export const EMBEDDING_CRON = "*/10 * * * *";

/**
 * The surfaces of a client's hostnames this Worker serves on a many-client host: its staff
 * address. A client's web hostnames are its web app's (reached through `cos-front` and the
 * ClientApp binding, step 8) and its desk hostname is step 8's: a request to either here is the
 * same 404 as an unknown hostname.
 */
export const APP_SURFACES = ["staff"] as const;

/** TanStack Start's handler behind OAuth and /mcp (src/server/mcp/handler.ts). */
export interface AppHandler {
  fetch(request: Request, env: never, ctx: ExecutionContext): Response | Promise<Response>;
}

/** What the entries need of the parts this module does not load (TanStack Start's build). */
export interface AppParts {
  /** OAuth, /mcp, then TanStack Start: every request the routes below do not answer. */
  app: AppHandler;
  /** TanStack Start alone: the desk origin's pages, never behind MCP's OAuth wrapper. */
  start: (request: Request) => Response | Promise<Response>;
}

async function assistantSocket(request: Request, env: Env): Promise<Response> {
  const result = await authorize(request, env, { handlerType: "router" });
  if (!result.ok) return result.response;
  return handleSocket(request, env as unknown as AssistantHttpEnv, result.principal);
}

async function apiResponse(request: Request, env: ApiEnv): Promise<Response> {
  return (await handleApi(request, env)) ?? new Response("Not found", { status: 404 });
}

/** One request on its environment: the real `env`, or the client's the entry decided. */
export function dispatch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  parts: AppParts,
): Response | Promise<Response> {
  // Staff sign-in codes go out as the host's own mail (ADR 0455), for whichever route asks.
  provideStaffCodes(env, staffCodesFor(env as unknown as ApiEnv));
  // The desk origin (stage 44 step 6, ADR 0649): its own hostname for this Worker, serving its
  // two pages and its calls and nothing else. The staff origin serves none of the desk's paths.
  if (isDeskRequest(request, env)) {
    // Its pages go straight to TanStack Start: never through MCP's OAuth wrapper (`app`).
    return handleDesk(request, env as unknown as DeskHandlerEnv, async (page) => parts.start(page));
  }
  // Hosted support access (ADR 0212): a 404 unless COS_SUPPORT_PUBLIC_KEY is set.
  const pathname = new URL(request.url).pathname;
  if (isDeskPath(pathname)) return new Response("Not found", { status: 404 });
  if (isSupportRoute(pathname)) return handleSupportRoute(request, env);
  // The assistant thread's WebSocket (ADR 0340) goes straight to the person's object: TanStack
  // Start does not pass a 101 response through. Identity is enforced here the same way.
  if (pathname === SOCKET_PATH) return assistantSocket(request, env);
  // A signed agreement's PDF and a version's blank form (stage 44 step 4, ADR 0645): the
  // operations decide who may have one; the route draws it. Before the surface, as media is.
  if (isAgreementPdfPath(pathname)) {
    const api = env as unknown as ApiEnv;
    return handleAgreementPdf(request, { context: (req) => apiContext(req, api) });
  }
  // The media library's pictures (stage 28, ADR 0444): staff upload, and whoever may see a
  // picture is served it, as media.serve decides. Before the surface: /api/v1/media/<id> is the
  // outside world's address for one (issue #181).
  if (isMediaPath(pathname)) {
    const api = env as unknown as ApiEnv & MediaEnv;
    return handleMedia(request, {
      invoker: coreInvoker,
      context: (req) => apiContext(req, api),
      media: mediaStoreFor(api),
      resizer: mediaResizerFor(api),
      uploads: true,
      // `cos content import` (ADR 0470): a person's staff device token, beside the surface.
      tokenUploads: true,
    });
  }
  // A staff member's private calendar feed (stage 45 step 5, ADR 0628): a calendar app polls
  // it with no sign-in, by the secret token in its address. Before the surface, which never
  // sees these paths: everything under /api/v1/staffing/feed/ is answered there.
  if (isStaffFeedPath(pathname)) return handleStaffFeed(request, env as unknown as StaffFeedEnv);
  // A customer's private calendar feed (stage 62 step 1, ADR 0890): the same, through the shared
  // feed module, by its own token table. Everything under /api/v1/me/feed/ is answered there.
  if (isCustomerFeedPath(pathname)) {
    return handleCustomerFeed(request, env as unknown as CustomerFeedEnv);
  }
  // The HTTP surface for client apps (stage 23, ADR 0403): /api/v1/*. It resolves its own
  // caller (staff, customer or public) from the request's session, so it is not behind the
  // staff-only identity middleware that guards TanStack Start's routes.
  if (isApiPath(pathname)) return apiResponse(request, env as unknown as ApiEnv);
  // A form's own page and a personal link's (stage 29 step 4, ADR 0728): public, drawn as HTML,
  // its calls through the client-app binding's door (a customer or the public, never staff).
  if (isFormPagePath(pathname)) {
    const api = env as unknown as FormPageEnv;
    return handleFormPage(request, api, (call) => handleBound(call, api), hostVisitor(request));
  }
  // Customer sign-in (stage 22's routes, mounted by stage 23): a code by email, then a session.
  if (isCustomerAuthPath(pathname)) return handleCustomerAuth(request, env as unknown as ApiEnv);
  // Practitioner sign-in (stage 43, ADR 0581): the same shape, its own session.
  if (isPractitionerAuthPath(pathname)) {
    return handlePractitionerAuth(request, env as unknown as ApiEnv);
  }
  // A native app's staff sign-in through the system browser (ADR 0455): a staff page.
  if (pathname === NATIVE_STAFF_SIGN_IN_PATH) {
    return handleNativeStaffSignIn(request, env as unknown as ApiEnv);
  }
  return parts.app.fetch(request, env as never, ctx);
}

/** The `fetch` entry: the client from the hostname, then `dispatch` on its environment. */
export async function hostFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  parts: AppParts,
): Promise<Response> {
  if (!servesManyClients(env)) return dispatch(request, env, ctx, parts);
  const decided = await decideRequest(env, request, APP_SURFACES);
  if ("response" in decided) return decided.response;
  const clientEnv = decided.env;
  return runInClientEnv(clientEnv, () => dispatch(request, clientEnv, ctx, parts));
}

/** One cron's work for one environment: the real `env`, or one client's. */
export async function runAppCron(env: Env, cron: string): Promise<void> {
  if (cron === EMBEDDING_CRON) {
    // Each step on its own: one failing does not stop the others (the ctx.waitUntil of before).
    const steps = await Promise.allSettled([
      runEmbeddingCron(env),
      runAdjudicatorCron(env),
      runBlobDeletionCron(env),
      runAgentJobCron(env),
    ]);
    const failed = steps.filter((step) => step.status === "rejected");
    if (failed.length) throw new Error(`${failed.length} of the 10-minute steps failed`);
    return;
  }
  await runScheduledMaintenance(env);
}

/** The `scheduled` entry. */
export function hostScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): void {
  if (servesManyClients(env)) {
    // One message per client served; each client's work runs as its message is consumed.
    ctx.waitUntil(fanOutCron(env, controller));
    return;
  }
  if (controller.cron === EMBEDDING_CRON) {
    ctx.waitUntil(runEmbeddingCron(env));
    ctx.waitUntil(runAdjudicatorCron(env));
    ctx.waitUntil(runBlobDeletionCron(env));
    ctx.waitUntil(runAgentJobCron(env));
    return;
  }
  ctx.waitUntil(runScheduledMaintenance(env));
}

/** The `queue` entry: routine deliveries (ADR 0343) and, on a many-client host, cron fan-outs. */
export async function hostQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  if (!servesManyClients(env)) {
    // A routine's message from cos-runner (ADR 0343), into its owner's thread.
    await handleRoutineDeliveries(
      batch as MessageBatch<RoutineDeliveryMessage>,
      env as unknown as AssistantHttpEnv,
    );
    return;
  }
  // By the queue the batch came from, never by what a message looks like (review of #512, M1).
  if (isFanOutQueue(batch.queue)) {
    await consumeFanOut(env, batch, {
      tick: (clientEnv, tick) =>
        runInClientEnv(clientEnv, () => runAppCron(clientEnv, tick.cron)),
      parked: { [ROUTINE_DELIVERY_QUEUE]: deliverRoutines },
    });
    return;
  }
  if (isDeadLetterQueue(batch.queue)) {
    consumeDeadLetters(batch);
    return;
  }
  await consumeByClient<Env, RoutineDeliveryMessage>(env, batch, deliverRoutines);
}

/** The queue cos-runner sends a routine's messages to (wrangler.jsonc's consumer). */
export const ROUTINE_DELIVERY_QUEUE = "cos-routine-delivery";

/** One client's routine deliveries, in its environment. */
function deliverRoutines(clientEnv: Env, share: MessageBatch<unknown>): Promise<void> {
  return runInClientEnv(clientEnv, () =>
    handleRoutineDeliveries(
      share as MessageBatch<RoutineDeliveryMessage>,
      clientEnv as unknown as AssistantHttpEnv,
    ),
  );
}
