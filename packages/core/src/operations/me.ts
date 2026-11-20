// me.* operations (stage 22, ADR 0402, ADR 0413): a signed-in customer's own Person and their own
// sessions. Open to customers only.
//
// `me.get` and `me.update` reach the Person through `ctx.records`, so the visibility seam decides
// which fields: the ones the Person object lists in its `customer` declaration (fields/person.ts).
// They take no id: the Person is always the caller's. `me.update` writes with the Person code
// person.update runs (the writer registered in operations/person.ts), so uniqueness, search, the
// audit diff and timeline tracking hold as for staff.
//
// The session operations are account bookkeeping, not records, so they are `hostInternal`: they
// keep `ctx.db` and touch only `core_customer_session` rows of the caller's own account. A session
// token never leaves them.
import { z } from "zod";
import { NotFoundError, OperationError } from "../errors.ts";
import { personObject } from "../fields/person.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import type { CustomerPrincipal } from "../principals.ts";

/** The caller, who is always a customer here (every operation in this file is customer-only). */
function customerOf(ctx: HandlerContext): CustomerPrincipal {
  const principal = ctx.principal;
  if (principal.kind !== "customer") {
    throw new OperationError("internal", `${ctx.operation} is for a customer's call`);
  }
  return principal;
}

const text = z.string().nullable();

/** The Person as its customer sees it: id and the fields `customer.read` lists, in staff shape. */
export const mePersonSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  givenName: text,
  familyName: text,
  primaryEmail: text,
  primaryPhone: text,
});
export type MePerson = z.infer<typeof mePersonSchema>;

const READABLE = personObject.customer?.read ?? [];

async function myPerson(ctx: HandlerContext): Promise<MePerson> {
  const { personId } = customerOf(ctx);
  const record = await ctx.records.get("person", personId);
  // Only what the seam returned, which is only what the declaration lists. Every listed field is
  // a scalar text column, so its value is already in the shape person.list returns.
  const values = Object.fromEntries(READABLE.map((name) => [name, record.values[name] ?? null]));
  return mePersonSchema.parse({ ...values, id: record.id });
}

const shortText = (max: number) => z.string().trim().max(max);

export const meGet = defineOperation({
  name: "me.get",
  description:
    "Your own Person, as a signed-in customer: your name, primary email and primary phone. " +
    "Read-only.",
  input: z.object({}),
  output: mePersonSchema,
  permission: "records:read",
  risk: "read",
  audiences: ["customer"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    return myPerson(ctx);
  },
});

export const meUpdate = defineOperation({
  name: "me.update",
  description:
    "Change your own name or primary phone, as a signed-in customer. Only the fields you pass " +
    "change; pass null to clear one. Your email cannot be changed here. Returns your Person.",
  input: z
    .object({
      displayName: shortText(200).min(1).optional(),
      givenName: shortText(100).nullish(),
      familyName: shortText(100).nullish(),
      primaryPhone: shortText(50).nullish(),
    })
    .strict(),
  output: mePersonSchema,
  permission: "records:write",
  risk: "write",
  audiences: ["customer"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const { personId } = customerOf(ctx);
    const values = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    );
    if (Object.keys(values).length) await ctx.records.update("person", personId, values);
    return ctx.afterCommit(() => myPerson(ctx));
  },
});

// --- Sessions ---------------------------------------------------------------------------------

const sessionSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  lastActiveAt: z.string(),
  expiresAt: z.string(),
  /** The session this call was made with, when the adapter says which (origin.sessionId). */
  current: z.boolean(),
});

/** The caller's own sessions only. A token is never selected. */
function ownSessions(ctx: HandlerContext, customerId: string) {
  return ctx.db
    .selectFrom("core_customer_session")
    .select(["id", "created_at", "updated_at", "expires_at"])
    .where("customer_id", "=", customerId);
}

export const meSessionsList = defineOperation({
  name: "me.sessions.list",
  description:
    "The places you are signed in, as a signed-in customer: each session's id, when it began, " +
    "when it was last used and when it expires, and which one is this one. Read-only.",
  input: z.object({}),
  output: z.object({ items: z.array(sessionSchema) }),
  permission: "records:read",
  risk: "read",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  async handler(_input, ctx) {
    const { customerId } = customerOf(ctx);
    const rows = await ownSessions(ctx, customerId)
      .orderBy("created_at", "desc")
      .orderBy("id")
      .execute();
    return {
      items: rows.map((row) => ({
        id: row.id,
        createdAt: String(row.created_at),
        lastActiveAt: String(row.updated_at),
        expiresAt: String(row.expires_at),
        current: row.id === ctx.origin.sessionId,
      })),
    };
  },
});

export const meSessionsRevoke = defineOperation({
  name: "me.sessions.revoke",
  description:
    "Sign out one of your sessions, as a signed-in customer, by its id from me.sessions.list. " +
    "A session that is not yours is not found.",
  input: z.object({ id: z.string().min(1).max(128).describe("Session id from me.sessions.list") }),
  output: z.object({ id: z.string(), revoked: z.literal(true) }),
  permission: "records:write",
  risk: "write",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const { customerId } = customerOf(ctx);
    const row = await ownSessions(ctx, customerId).where("id", "=", input.id).executeTakeFirst();
    // Another customer's session answers exactly as one that does not exist.
    if (!row) throw new NotFoundError("session", input.id);
    ctx.write(
      ctx.db
        .deleteFrom("core_customer_session")
        .where("id", "=", input.id)
        .where("customer_id", "=", customerId),
    );
    return { id: input.id, revoked: true as const };
  },
});

export const meSignOut = defineOperation({
  name: "me.signOut",
  description:
    "Sign out of this session, as a signed-in customer. Your other sessions stay signed in " +
    "(end them with me.sessions.revoke).",
  input: z.object({}),
  output: z.object({ signedOut: z.boolean() }),
  permission: "records:write",
  risk: "write",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  async handler(_input, ctx) {
    const { customerId } = customerOf(ctx);
    // The adapter names the session the call was made with; without one there is nothing to end.
    const sessionId = ctx.origin.sessionId;
    if (!sessionId) return { signedOut: false };
    const row = await ownSessions(ctx, customerId).where("id", "=", sessionId).executeTakeFirst();
    if (!row) return { signedOut: false };
    ctx.write(
      ctx.db
        .deleteFrom("core_customer_session")
        .where("id", "=", sessionId)
        .where("customer_id", "=", customerId),
    );
    return { signedOut: true };
  },
});

export const meOperations = [meGet, meUpdate, meSessionsList, meSessionsRevoke, meSignOut] as const;
