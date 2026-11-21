// Test helpers for the HTTP surface (stage 23): a surface over a registry, and a way to call it
// as a given caller. The caller's context is found from a bearer token the test hands out, the
// way cos-app's adapter finds it from the session it verified: never from the body.
import {
  type AnyInvocationContext,
  createHttpSurface,
  createInvoker,
  type HttpSurfaceOptions,
  OperationError,
  type OperationRegistry,
} from "../src/index.ts";
import { fixtureRegistry, type Outcome } from "./customer-fixtures.ts";

export const ORIGIN = "https://host.example";

const sessions = new Map<string, AnyInvocationContext>();

/** A credential for `ctx`: what a signed-in session would be. */
export function tokenFor(ctx: AnyInvocationContext): string {
  const token = crypto.randomUUID();
  sessions.set(token, ctx);
  return token;
}

/** The context a request's credential stands for; the public without one. */
function contextOf(request: Request, publicCtx: AnyInvocationContext): AnyInvocationContext {
  const header = request.headers.get("authorization");
  if (!header) return publicCtx;
  const ctx = sessions.get(header.replace(/^Bearer /, ""));
  if (!ctx) throw new OperationError("forbidden", "Sign in again");
  return ctx;
}

export function surfaceOver(
  // biome-ignore lint/suspicious/noExplicitAny: any registry's operations
  registry: OperationRegistry<any>,
  publicCtx: AnyInvocationContext,
  options: Partial<HttpSurfaceOptions> = {},
) {
  return createHttpSurface({
    invoker: createInvoker(registry),
    context: async (request) => contextOf(request, publicCtx),
    ...options,
  });
}

export interface Sent {
  headers?: Record<string, string>;
  /** Default: a fresh key per call. Null: none. */
  key?: string | null;
  method?: string;
  body?: string;
}

/** A request to POST /api/v1/op/<name> as `ctx`'s caller (none: the public). */
export function opRequest(
  name: string,
  input: unknown,
  ctx: AnyInvocationContext | null,
  sent: Sent = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json", ...sent.headers };
  if (ctx && ctx.principal?.kind !== "public") headers.authorization = `Bearer ${tokenFor(ctx)}`;
  const key = sent.key === undefined ? crypto.randomUUID() : sent.key;
  if (key !== null) headers["idempotency-key"] = key;
  return new Request(`${ORIGIN}/api/v1/op/${name}`, {
    method: sent.method ?? "POST",
    headers,
    ...(sent.method === "GET" ? {} : { body: sent.body ?? JSON.stringify(input) }),
  });
}

/** What a response says, as the `call` outcome of customer-fixtures.ts does. */
export async function outcomeOf(response: Response): Promise<Outcome> {
  const body = (await response.json()) as { data?: unknown; error?: Record<string, unknown> };
  if (response.status === 200 && "data" in body) return { ok: true, value: body.data };
  return { ok: false, error: body.error ?? { status: response.status } };
}

/** `call` over HTTP, on the fixture registry: the stage 22 suite's calls as requests. */
export function httpCaller(
  // biome-ignore lint/suspicious/noExplicitAny: any registry's operations
  registry: OperationRegistry<any> = fixtureRegistry,
) {
  return async (name: string, input: unknown, ctx: AnyInvocationContext): Promise<Outcome> => {
    const publicCtx: AnyInvocationContext =
      ctx.principal?.kind === "public" ? ctx : { principal: { kind: "public" }, db: ctx.db };
    const surface = surfaceOver(registry, publicCtx);
    const response = await surface.handle(opRequest(name, input, ctx));
    if (!response) throw new Error("not an API path");
    return outcomeOf(response);
  };
}
