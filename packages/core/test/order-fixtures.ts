// Fixtures for the stage 25 order tests (ADRs 0426 to 0428): an object that is for sale, the
// deployment's currency, customers with real accounts, and the test doubles of the two pieces of
// platform code that are not operations: the handler that receives a verified payment, and a
// direct call to the code that changes an order (to show what the engine refuses).
import { env } from "cloudflare:workers";
import { z } from "zod";
import {
  type ActingUser,
  applyVerifiedPayment,
  type CustomerPrincipal,
  changeOrder,
  coreRegistry,
  createInvoker,
  createRegistry,
  defineOperation,
  invoke,
  loadOrderRow,
  ORDER_STATES,
  type OutsideInvocationContext,
  type PublicPrincipal,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, db, unique } from "./helpers.ts";

export const BOX_OFFICE = extId("box");
/** For sale, in AUD, with an optional deposit. */
export const TICKET_TYPE = `${BOX_OFFICE}.ticket`;
/** For sale, but priced in another currency. */
export const IMPORT = `${BOX_OFFICE}.import`;
/** Not for sale: an object that declares no `sellable`. */
export const POSTER = `${BOX_OFFICE}.poster`;

export const CURRENCY = "AUD";

export async function installBoxOffice(admin: ActingUser): Promise<void> {
  await reconcile(
    manifest(BOX_OFFICE, {
      objects: {
        ticket: {
          label: "Ticket type",
          plural: "Ticket types",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            price: { type: "currency", label: "Price", currency: CURRENCY },
            depositAmount: { type: "currency", label: "Deposit", currency: CURRENCY },
            balanceDue: { type: "date", label: "Balance due" },
          },
          sellable: {
            price: "price",
            deposit: { amount: "depositAmount", balanceDue: "balanceDue" },
          },
          // A customer or a guest buys only what they may read (ADR 0438).
          public: { read: ["name", "price", "depositAmount", "balanceDue"] },
        },
        import: {
          label: "Import",
          plural: "Imports",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            price: { type: "currency", label: "Price", currency: "USD" },
          },
          sellable: { price: "price" },
          public: { read: ["name", "price"] },
        },
        poster: {
          label: "Poster",
          plural: "Posters",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            price: { type: "currency", label: "Price", currency: CURRENCY },
          },
        },
      },
    }),
  );
  await invoke("order.settings.update", { currency: CURRENCY }, context(admin));
}

/** A record of the for-sale fixture. `price` and `deposit` are in dollars, as a record holds them. */
export async function createTicketType(
  admin: ActingUser,
  values: { name?: string; price: number | null; depositAmount?: number; balanceDue?: string },
  object = TICKET_TYPE,
): Promise<string> {
  const created = await invoke(
    "record.create",
    { object, values: { name: values.name ?? unique("Ticket"), ...values } },
    context(admin),
  );
  return created.id;
}

export interface Buyer {
  principal: CustomerPrincipal;
  email: string;
}

/** A Person with a customer account, as a signed-in customer's principal. */
export async function createBuyer(
  admin: ActingUser,
  label = "buyer",
  /** Their address, when a test needs a particular one (a plus-addressed one, say). */
  address?: string,
): Promise<Buyer> {
  const tag = unique(label).toLowerCase();
  const email = address ?? `${tag}@buyers.example`;
  const person = await invoke(
    "person.create",
    { givenName: `Given-${tag}`, emails: [{ email }] },
    context(admin),
  );
  const customerId = `cus_${tag}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_customer (id, person_id, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(customerId, person.id, email, now, now)
    .run();
  return { principal: { kind: "customer", customerId, personId: person.id }, email };
}

// --- Test doubles of platform code ---------------------------------------------------------------

/**
 * What the payments webhook handler will be: an operation only the host's own adapter calls,
 * which hands a payment the gatekeeper verified to `applyVerifiedPayment`. Here anyone on staff
 * can call it, so a test can play the provider.
 */
const verifiedPayment = defineOperation({
  name: "fixture.verifiedPayment",
  description:
    "Fixture: applies a payment as if the gatekeeper had verified the provider's webhook.",
  input: z.object({
    provider: z.string().default("fake"),
    eventId: z.string(),
    orderId: z.string(),
    amount: z.number(),
    currency: z.string().default(CURRENCY),
    paymentRef: z.string().optional(),
  }),
  output: z.object({ outcome: z.string(), state: z.enum(ORDER_STATES).optional() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const result = await applyVerifiedPayment(ctx, input);
    return {
      outcome: result.outcome,
      ...(result.outcome === "applied" ? { state: result.order.state } : {}),
    };
  },
});

/**
 * Calls the code that changes an order with a mover the test names, as no real operation does
 * (the mover is never input). It shows what the engine refuses to each mover.
 */
const moveOrderAs = defineOperation({
  name: "fixture.moveOrderAs",
  description: "Fixture: moves an order as the named mover, straight through the engine.",
  input: z.object({
    id: z.string(),
    to: z.enum(ORDER_STATES),
    by: z.enum(["staff", "customer", "host"]),
  }),
  output: z.object({ state: z.string() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const row = await loadOrderRow(ctx.db, input.id);
    const next = await changeOrder(ctx, row, input.to, {}, input.by);
    return { state: next.state };
  },
});

export const orderRegistry = createRegistry([...coreRegistry.list(), verifiedPayment, moveOrderAs]);
export const orderInvoker = createInvoker(orderRegistry);

export const PUBLIC: PublicPrincipal = { kind: "public" };

export function outside(
  principal: CustomerPrincipal | PublicPrincipal,
  overrides: Partial<OutsideInvocationContext> = {},
): OutsideInvocationContext {
  return { principal, db, ...overrides };
}

/** Calls an operation and returns its output; a refusal is thrown as the pipeline throws it. */
export function run<T = Record<string, unknown>>(
  name: string,
  input: unknown,
  ctx: Parameters<typeof orderInvoker.invokeByName>[2],
): Promise<T> {
  return orderInvoker.invokeByName(name, input, ctx) as Promise<T>;
}

/** The refusal of a call that must be refused: its code, message and details. */
export async function refusal(
  call: Promise<unknown>,
): Promise<{ code: string; message: string; details: Record<string, unknown> }> {
  try {
    await call;
  } catch (error) {
    const e = error as { code?: string; message?: string; details?: unknown };
    return {
      code: String(e.code),
      message: String(e.message),
      details: (e.details ?? {}) as Record<string, unknown>,
    };
  }
  throw new Error("expected a refusal, and the call succeeded");
}

export async function orderRow(id: string) {
  return (await env.DB.prepare("SELECT * FROM core_order WHERE id = ?").bind(id).first()) as Record<
    string,
    unknown
  >;
}

export async function historyOf(id: string) {
  const { results } = await env.DB.prepare(
    "SELECT position_id, entered_as, entered_by, left_at FROM core_transition_history WHERE object_type = 'order' AND record_id = ? ORDER BY entered_at, rowid",
  )
    .bind(id)
    .all();
  return results as { position_id: string; entered_as: string; entered_by: string | null }[];
}

export async function paymentsOf(id: string) {
  const { results } = await env.DB.prepare(
    "SELECT event_id, amount, currency, outcome FROM core_order_payment WHERE order_id = ? ORDER BY received_at, event_id",
  )
    .bind(id)
    .all();
  return results as { event_id: string; amount: number; currency: string; outcome: string }[];
}
