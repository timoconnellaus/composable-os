// A buyer without an account reaches the host through the HTTP surface (stage 23,
// `/api/v1/op/<name>`), as the public: no session, no server function. The operations decide
// what a guest may see and do (stage 25): the order's token opens one order, the host prices it,
// and only the payment provider's confirmation marks anything paid.
import type { CoreOutput, OperationErrorCode } from "@composable-os/core";

/** What a guest call answers: never a thrown error. */
export type GuestResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: OperationErrorCode; message: string } };

async function op<T>(name: string, input: unknown): Promise<GuestResult<T>> {
  const response = await fetch(`/api/v1/op/${name}`, {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
  const body = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: { code?: OperationErrorCode; message?: string };
  };
  if (response.ok && "data" in body) return { ok: true, data: body.data as T };
  return {
    ok: false,
    error: {
      code: body.error?.code ?? "internal",
      message: body.error?.message ?? "Something went wrong. Try again in a moment.",
    },
  };
}

/** The guest's order, opened with its token (order.view). */
export function guestOrder({ data }: { data: { id: string; token: string } }) {
  return op<CoreOutput<"order.view">>("order.view", data);
}

/** Opens the payment provider's page for the guest's order; the buyer comes back here. */
export async function guestPay({
  data,
}: {
  data: { id: string; token: string; amount?: number };
}): Promise<GuestResult<{ url: string }>> {
  const back = new URL(`/order/${encodeURIComponent(data.id)}`, window.location.origin);
  back.searchParams.set("token", data.token);
  const result = await op<CoreOutput<"order.checkout">>("order.checkout", {
    ...data,
    returnUrl: back.toString(),
  });
  return result.ok ? { ok: true, data: { url: result.data.url } } : result;
}

/** Starts an order for one record as a guest, and answers its id and token. */
export async function guestStart({
  data,
}: {
  data: {
    object: string;
    recordId: string;
    quantity: number;
    email: string;
    pay: "full" | "deposit";
  };
}): Promise<GuestResult<{ id: string; token: string }>> {
  const result = await op<CoreOutput<"order.start">>("order.start", {
    lines: [{ object: data.object, id: data.recordId, quantity: data.quantity }],
    pay: data.pay,
    email: data.email,
  });
  if (!result.ok) return result;
  if (!result.data.token) {
    return { ok: false, error: { code: "internal", message: "The order has no link" } };
  }
  return { ok: true, data: { id: result.data.id, token: result.data.token } };
}
