// Server functions for buyers without an account (stage 25; anonymous callers may use the
// `*.public.ts` files, see identity.ts): the guest's order page and the host's plain checkout
// start. Each calls an order operation as the public principal, so the operation, not this file,
// decides what a guest may see and do: the order's token opens one order, the host prices it,
// and only the payment provider's confirmation marks anything paid.
import { env } from "cloudflare:workers";
import {
  type CoreOutput,
  errorForLog,
  invokeByName,
  type OperationErrorCode,
  toOperationError,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { ensureDevSellable } from "./dev-sellable.ts";
import { integrationRuntimeFor } from "./integrations.ts";
import { ensureShippedExtensions } from "./operations.ts";

/** What a guest server function answers: never a thrown error or a stack trace. */
export type GuestResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: OperationErrorCode; message: string } };

/** Runs one order operation as the public, with the request's origin for the payment provider. */
async function asPublic<T>(name: string, input: unknown, origin: string): Promise<GuestResult<T>> {
  try {
    await ensureShippedExtensions(env);
    ensureDevSellable(env);
    const integrations = integrationRuntimeFor(env, origin);
    const data = await invokeByName(name, input, {
      principal: { kind: "public" },
      db: createCrmDb(env.DB),
      origin: { surface: "client" },
      ...(integrations ? { integrations } : {}),
    });
    return { ok: true, data: JSON.parse(JSON.stringify(data)) as T };
  } catch (error) {
    const typed = toOperationError(error);
    if (typed.code === "internal" || typed.code === "config") {
      // Log-safe: the error can quote record content (ADR 0320).
      console.error(`operation ${name} failed`, errorForLog(error));
    }
    return { ok: false, error: { code: typed.code, message: typed.message } };
  }
}

const requestOrigin = () => new URL(getRequest().url).origin;

const orderRef = z.object({
  id: z.string().min(1).max(64),
  token: z.string().min(1).max(128),
});

/** The guest's order, opened with its token (order.view). */
export const guestOrder = createServerFn({ method: "GET" })
  .validator((data: unknown) => orderRef.parse(data))
  .handler(
    ({ data }): Promise<GuestResult<CoreOutput<"order.view">>> =>
      asPublic("order.view", data, requestOrigin()),
  );

/** Opens the payment provider's page for the guest's order and answers its address. */
export const guestPay = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    orderRef.extend({ amount: z.number().int().positive().optional() }).parse(data),
  )
  .handler(async ({ data }): Promise<GuestResult<{ url: string }>> => {
    const origin = requestOrigin();
    const back = new URL(`/order/${encodeURIComponent(data.id)}`, origin);
    back.searchParams.set("token", data.token);
    const result = await asPublic<CoreOutput<"order.checkout">>(
      "order.checkout",
      {
        id: data.id,
        token: data.token,
        returnUrl: back.toString(),
        ...(data.amount !== undefined ? { amount: data.amount } : {}),
      },
      origin,
    );
    return result.ok ? { ok: true, data: { url: result.data.url } } : result;
  });

/** Starts an order for one record as a guest, and answers its id and token. */
export const guestStart = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z
      .object({
        object: z.string().min(1).max(80),
        recordId: z.string().min(1).max(64),
        quantity: z.number().int().min(1).max(1000),
        email: z.string().trim().min(1).max(320),
        pay: z.enum(["full", "deposit"]),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<GuestResult<{ id: string; token: string }>> => {
    const result = await asPublic<CoreOutput<"order.start">>(
      "order.start",
      {
        lines: [{ object: data.object, id: data.recordId, quantity: data.quantity }],
        pay: data.pay,
        email: data.email,
      },
      requestOrigin(),
    );
    if (!result.ok) return result;
    if (!result.data.token) {
      return { ok: false, error: { code: "internal", message: "The order has no link" } };
    }
    return { ok: true, data: { id: result.data.id, token: result.data.token } };
  });
