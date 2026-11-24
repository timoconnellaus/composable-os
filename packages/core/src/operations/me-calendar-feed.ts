// A customer's private calendar feed (stage 62 step 1, ADR 0890): whether they have one, a new
// address (made, or rotated), and revoking it; and staff revoking one. The feed itself is read at
// `GET /api/v1/me/feed/<token>.ics` (customers/calendar-feed.ts).
//
// The address is a bearer secret (a calendar app polls it with no sign-in), so:
// - only the customer makes or rotates their own, at the screen (`actors: ["human"]`, never a
//   pack's tool run for them), for their own account only (the principal's, never an input);
// - it is answered once, by the call that makes it, and stored only as its hash; nothing of it
//   reaches the audit log (the summary says only that it was rotated, and `redactResult` keeps
//   the path out of the row and out of any stored reply);
// - staff may revoke a customer's feed (`customer.revokeCalendarFeed`), never make or rotate one,
//   which would hand them a secret of someone else's.
//
// The me.* ones are account bookkeeping, not records, so they are `hostInternal` (as the session
// operations are) and touch only the caller's own account.
import { CompiledQuery } from "kysely";
import { z } from "zod";
import {
  customerFeedPath,
  customerFeedTokenHash,
  newCustomerFeedToken,
  revokeCustomerFeed,
} from "../customers/calendar-feed.ts";
import { NotFoundError, OperationError } from "../errors.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import type { CustomerPrincipal } from "../principals.ts";

function customerOf(ctx: HandlerContext): CustomerPrincipal {
  const principal = ctx.principal;
  if (principal.kind !== "customer") {
    throw new OperationError("internal", `${ctx.operation} is for a customer's call`);
  }
  return principal;
}

const statusShape = z.object({
  active: z.boolean().describe("Whether a calendar link exists (it is never shown again)"),
  createdAt: z.string().nullable().describe("When the current link was made"),
});

async function feedRow(ctx: HandlerContext, customerId: string) {
  return ctx.db
    .selectFrom("core_customer_feed")
    .select(["created_at"])
    .where("customer_id", "=", customerId)
    .executeTakeFirst();
}

export const meCalendarFeedStatus = defineOperation({
  name: "me.calendarFeed.status",
  description:
    "Whether you have a private calendar link (your bookings, and your children's, for a " +
    "calendar app to subscribe to), and when it was made, as a signed-in customer. Never the " +
    "link itself: it is shown once, when made. Read-only.",
  input: z.object({}),
  output: statusShape,
  permission: "records:read",
  risk: "read",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  async handler(_input, ctx) {
    const row = await feedRow(ctx, customerOf(ctx).customerId);
    return { active: row !== undefined, createdAt: row?.created_at ?? null };
  },
});

export const meCalendarFeedRotate = defineOperation({
  name: "me.calendarFeed.rotate",
  description:
    "A new private link for your calendar, as a signed-in customer: your bookings and your " +
    "children's, from two weeks ago to four months ahead, for a calendar app to subscribe to. " +
    "It replaces any old link, which stops working at once. The link is shown this once and " +
    "never again: anyone who has it sees your bookings, so do not share it. Your own act.",
  input: z.object({}),
  output: z.object({
    path: z
      .string()
      .describe(
        "The link's address on this host (put the host's origin before it; webcal:// opens it in a calendar app). Shown once.",
      ),
    createdAt: z.string(),
  }),
  permission: "records:write",
  risk: "write",
  audiences: ["customer"],
  // A secret of the person's own: never made by a pack's tool run for them.
  actors: ["human"],
  hostInternal: true,
  mcp: { expose: false },
  // The address is a secret: the audit log says it was rotated, never what it is.
  auditSummary: () => ({ feed: "rotated" }),
  redactResult: ["path"],
  async handler(_input, ctx) {
    const { customerId, personId } = customerOf(ctx);
    // Never an address that would open nothing: an account no longer active (or no longer this
    // Person's) gets no link, as me.deleteAccount answers for an account that is not theirs.
    const account = await ctx.db
      .selectFrom("core_customer")
      .select("id")
      .where("id", "=", customerId)
      .where("person_id", "=", personId)
      .where("status", "=", "active")
      .where("link_state", "=", "linked")
      .executeTakeFirst();
    if (!account) throw new NotFoundError("customer account", customerId);
    const token = newCustomerFeedToken();
    const hash = await customerFeedTokenHash(token);
    // And written only while it still is at commit: a rotate racing a disable or a deletion
    // (which delete the row in their batch) leaves no feed behind.
    ctx.write(
      CompiledQuery.raw(
        "INSERT INTO core_customer_feed (customer_id, token_hash, created_at) SELECT id, ?, ? FROM core_customer WHERE id = ? AND person_id = ? AND status = 'active' AND link_state = 'linked' ON CONFLICT (customer_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at",
        [hash, ctx.now, customerId, personId],
      ),
    );
    return { path: customerFeedPath(token), createdAt: ctx.now };
  },
});

export const meCalendarFeedRevoke = defineOperation({
  name: "me.calendarFeed.revoke",
  description:
    "Turn off your private calendar link, as a signed-in customer: it then answers as if it " +
    "never existed (a calendar app subscribed to it keeps what it last fetched, and gets no " +
    "more). Make a new one with me.calendarFeed.rotate.",
  input: z.object({}),
  output: z.object({ revoked: z.boolean() }),
  permission: "records:write",
  risk: "write",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  auditSummary: (output) => ({ feed: output.revoked ? "revoked" : "none" }),
  async handler(_input, ctx) {
    const { customerId } = customerOf(ctx);
    const row = await feedRow(ctx, customerId);
    if (row) ctx.write(revokeCustomerFeed(ctx.db, customerId));
    return { revoked: row !== undefined };
  },
});

export const customerRevokeCalendarFeed = defineOperation({
  name: "customer.revokeCalendarFeed",
  description:
    "Turn off a customer's private calendar link (their bookings for a calendar app), when they " +
    "ask or it was shared by mistake: it then answers as if it never existed. Staff can never " +
    "make or see one: the customer makes a new link themselves. Admins only.",
  input: z.object({ id: z.string().min(1).max(64).describe("Customer account id (cus_…)") }),
  output: z.object({ id: z.string(), revoked: z.boolean() }),
  permission: "users:manage",
  risk: "write",
  mcp: { expose: false },
  async handler(input, ctx) {
    const account = await ctx.db
      .selectFrom("core_customer")
      .select("id")
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (!account) throw new NotFoundError("customer", input.id);
    const row = await feedRow(ctx, input.id);
    if (row) ctx.write(revokeCustomerFeed(ctx.db, input.id));
    return { id: input.id, revoked: row !== undefined };
  },
});

export const meCalendarFeedOperations = [
  meCalendarFeedStatus,
  meCalendarFeedRotate,
  meCalendarFeedRevoke,
  customerRevokeCalendarFeed,
] as const;
