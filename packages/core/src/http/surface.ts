// The HTTP surface (stage 23, ADR 0403, ADR 0415): a fourth way to call operations, beside the
// UI's server functions, MCP and the host module, for phones, TVs and a company's own Worker.
//
//   POST /api/v1/op/<operation name>   the input as JSON → `{ "data": <output> }` or the envelope
//   GET  /api/v1/manifest              what this caller may call, with JSON Schema for each
//
// Framework-free: the adapter (cos-app's `src/server/http/`) builds the call's context from the
// session it verified (staff, a customer, or nobody: the public) and passes it in. Every call
// goes through the invoker's `invokeByName`, which is `invoke()`: there is no other path to the
// database here. The only statements this module writes are an idempotency key's (idempotency.ts),
// and those commit in the write's own batch.
//
// - An operation that does not exist and one not open to the caller give the same answer.
// - Every write needs an Idempotency-Key.
// - Cross-origin calls are allowed only from the deployment's listed origins. A request with no
//   Origin (a phone, a server) is not a browser's and is let through to authenticate.
import { z } from "zod";
import { OperationError, PendingApprovalError, ValidationError } from "../errors.ts";
import type { Invoker } from "../invoke.ts";
import type { AnyOperation } from "../operation.ts";
import type { AnyInvocationContext, BatchOutcome } from "../pipeline.ts";
import { dataReply, errorReply, type HttpReply, retryAfter } from "./envelope.ts";
import {
  IDEMPOTENCY_HEADER,
  inputHash,
  parseIdempotencyKey,
  runIdempotent,
} from "./idempotency.ts";

export const API_PREFIX = "/api/v1";
const OPERATION_PATH = `${API_PREFIX}/op/`;
const MANIFEST_PATH = `${API_PREFIX}/manifest`;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
/** The largest request body accepted, in bytes. */
export const MAX_BODY_BYTES = 1_000_000;

export interface HttpSurfaceOptions {
  /** The registry's invoker: `createInvoker(registry)`, or `coreInvoker`. */
  invoker: Pick<Invoker, "invokeByName" | "resolveFor" | "listFor">;
  /**
   * The call's context, from the request's verified session: a staff context, or an outside
   * one with a customer or the public principal. Never from anything in the body. Throwing an
   * OperationError refuses the request with it.
   */
  context(request: Request): Promise<AnyInvocationContext>;
  /** Origins a browser may call from, besides the API's own (exact `scheme://host[:port]`). */
  allowedOrigins?: readonly string[];
}

export function isApiPath(pathname: string): boolean {
  return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
}

/** Origins as configured: a comma- or space-separated list, normalised. */
export function parseAllowedOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean)
    .flatMap((o) => {
      try {
        return [new URL(o).origin];
      } catch {
        return [];
      }
    });
}

type OriginCheck = { ok: true; cors: Record<string, string> } | { ok: false };

function checkOrigin(request: Request, allowed: readonly string[]): OriginCheck {
  const origin = request.headers.get("origin");
  if (!origin) return { ok: true, cors: {} };
  if (origin === new URL(request.url).origin) return { ok: true, cors: {} };
  if (!allowed.includes(origin)) return { ok: false };
  return {
    ok: true,
    cors: {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "access-control-expose-headers": "idempotent-replayed, retry-after",
      vary: "Origin",
    },
  };
}

function respond(reply: HttpReply, headers: Record<string, string> = {}): Response {
  return new Response(reply.body, {
    status: reply.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...retryAfter(reply),
      ...headers,
    },
  });
}

const refusal = (
  status: number,
  code: "forbidden" | "not_found" | "invalid_input",
  message: string,
) => respond({ status, body: JSON.stringify({ error: { code, message } }) });

const isOutside = (ctx: AnyInvocationContext) => ctx.principal !== undefined;

/** The scope of a caller's idempotency keys. */
function keyScope(ctx: AnyInvocationContext): string {
  if (!ctx.principal) return `staff:${ctx.user.id}`;
  return ctx.principal.kind === "customer" ? `customer:${ctx.principal.customerId}` : "public";
}

/** What an outcome sends, as the surface sends it: the same bytes whether stored or not. */
function replyFor(outcome: BatchOutcome, outside: boolean): HttpReply | null {
  if (outcome.kind === "queued")
    return errorReply(new PendingApprovalError(outcome.pending), outside);
  return outcome.deferred ? null : dataReply(outcome.output);
}

async function readInput(request: Request): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) {
    throw new ValidationError("Send the input as JSON (content-type: application/json)", {
      httpStatus: 415,
    });
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    throw new ValidationError("The request body is too large", { httpStatus: 413 });
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new ValidationError("The request body is too large", { httpStatus: 413 });
  }
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError("The request body is not valid JSON");
  }
}

/** One operation call. */
async function callOperation(
  options: HttpSurfaceOptions,
  request: Request,
  name: string,
): Promise<{ reply: HttpReply; replayed: boolean }> {
  const ctx = await options.context(request);
  const outside = isOutside(ctx);
  try {
    // The same answer for a name not registered and one not open to this caller, before the
    // body is read: nothing about an operation the caller cannot call depends on what they send.
    const op = await options.invoker.resolveFor(name, ctx);
    const input = await readInput(request);
    if (op.risk === "read") {
      return {
        reply: dataReply(await options.invoker.invokeByName(name, input, ctx)),
        replayed: false,
      };
    }
    const key = parseIdempotencyKey(request.headers.get(IDEMPOTENCY_HEADER));
    const now = ctx.clock ?? (() => new Date());
    const result = await runIdempotent(
      {
        db: ctx.db,
        scope: keyScope(ctx),
        key,
        operation: op.name,
        hash: await inputHash(op.name, input),
        now,
        replyFor: (outcome) => replyFor(outcome, outside),
      },
      async (inBatch) => {
        try {
          const output = await options.invoker.invokeByName(name, input, { ...ctx, inBatch });
          return dataReply(output);
        } catch (error) {
          return errorReply(error, outside);
        }
      },
    );
    return { reply: result, replayed: result.replayed };
  } catch (error) {
    return { reply: errorReply(error, outside), replayed: false };
  }
}

function jsonSchema(schema: z.ZodType, io: "input" | "output"): unknown {
  try {
    return z.toJSONSchema(schema, { unrepresentable: "any", io });
  } catch {
    return {};
  }
}

/** One operation as the manifest lists it. */
export function manifestEntry(op: AnyOperation) {
  return {
    name: op.name,
    description: op.description,
    risk: op.risk,
    input: jsonSchema(op.input, "input"),
    output: jsonSchema(op.output, "output"),
  };
}

async function manifest(options: HttpSurfaceOptions, request: Request): Promise<HttpReply> {
  const ctx = await options.context(request);
  try {
    const ops = await options.invoker.listFor(ctx);
    return dataReply({
      version: "v1",
      audience: ctx.principal?.kind ?? "staff",
      operations: ops.map(manifestEntry).sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (error) {
    return errorReply(error, isOutside(ctx));
  }
}

/**
 * Serves `/api/v1/*`; null for any other path. A failure to build the caller's context (a
 * request carrying two sessions, say) is answered with its error.
 */
export function createHttpSurface(options: HttpSurfaceOptions) {
  const allowed = options.allowedOrigins ?? [];
  return {
    async handle(request: Request): Promise<Response | null> {
      const { pathname } = new URL(request.url);
      if (!isApiPath(pathname)) return null;
      const origin = checkOrigin(request, allowed);
      if (!origin.ok) return refusal(403, "forbidden", "This origin may not call the API");
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            ...origin.cors,
            "access-control-allow-methods": "GET, POST",
            "access-control-allow-headers": "content-type, idempotency-key, authorization",
            "access-control-max-age": "600",
          },
        });
      }
      try {
        if (pathname === MANIFEST_PATH) {
          if (request.method !== "GET") return methodNotAllowed("GET", origin.cors);
          return respond(await manifest(options, request), origin.cors);
        }
        if (pathname.startsWith(OPERATION_PATH)) {
          const name = decodeURIComponent(pathname.slice(OPERATION_PATH.length));
          if (!NAME.test(name)) {
            return respond(
              errorReply(
                new OperationError(
                  "unknown_operation",
                  `No operation named "${name.slice(0, 100)}"`,
                ),
                true,
              ),
              origin.cors,
            );
          }
          if (request.method !== "POST") return methodNotAllowed("POST", origin.cors);
          const { reply, replayed } = await callOperation(options, request, name);
          return respond(reply, {
            ...origin.cors,
            ...(replayed ? { "idempotent-replayed": "true" } : {}),
          });
        }
        return respond(
          {
            status: 404,
            body: JSON.stringify({ error: { code: "not_found", message: "No such route" } }),
          },
          origin.cors,
        );
      } catch (error) {
        // The context could not be built: refused before any operation was looked at.
        return respond(errorReply(error, true), origin.cors);
      }
    },
  };
}

function methodNotAllowed(allow: string, cors: Record<string, string>): Response {
  return new Response(
    JSON.stringify({ error: { code: "invalid_input", message: `Use ${allow}` } }),
    { status: 405, headers: { "content-type": "application/json; charset=utf-8", allow, ...cors } },
  );
}
