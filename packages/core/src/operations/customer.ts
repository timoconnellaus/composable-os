// customer.* operations for staff (stage 22, ADR 0402): the org's customer accounts. Admins only
// (`users:manage`) and humans only, like the staff user operations: no assistant, MCP client,
// automation or extension may invite, disable or sign out a customer. Every write is audited.
//
// Customer accounts are not records: these read and write `core_customer`,
// `core_customer_session`, `core_customer_invite` and `core_customer_email_change`, never a
// Person. A customer's sign-in address is the account's own, so nothing here needs to read people.
//
// Staff may start a change of a member's sign-in address (stage 48, ADR 0712), for a member who
// phones: the code goes to the new address and only the member, signed in, finishes it with
// me.email.confirm. Staff never see the code and cannot finish it.
import { sql } from "kysely";
import { z } from "zod";
import { inviteCustomerStatement } from "../customers/accounts.ts";
import {
  cancelEmailChange,
  EMAIL_CHANGE_CODE_MINUTES,
  maskEmail,
  startEmailChange,
} from "../customers/email-change.ts";
import { NotFoundError } from "../errors.ts";
import { endCustomerDeviceSessions } from "../http/tokens.ts";
import { decodeCursor, encodeCursor, pageSchema } from "../list.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";

const customerId = z.string().min(1).max(64).describe("Customer account id (cus_…)");

export const customerAccountSchema = z.object({
  id: z.string(),
  /** The linked Person, or null until the first sign-in links one (or while people need merging). */
  personId: z.string().nullable(),
  email: z.string(),
  status: z.enum(["active", "disabled"]),
  linkState: z.enum(["linked", "needs_merge"]),
  createdAt: z.string(),
  lastSignInAt: z.string().nullable(),
  /** Sessions that have not expired. */
  sessions: z.number(),
  /** A change of the sign-in address waiting for the member's code (stage 48), or null. */
  emailChange: z
    .object({
      /** The new address, shown only in part: the member proves it, staff never need it. */
      newEmail: z.string(),
      startedBy: z.enum(["customer", "staff"]),
      createdAt: z.string(),
      expiresAt: z.string(),
      expired: z.boolean(),
    })
    .nullable(),
  /** The open erase request the member made by deleting the account, or null. */
  eraseRequest: z.object({ requestedAt: z.string(), dueAt: z.string() }).nullable(),
});
export type CustomerAccountItem = z.infer<typeof customerAccountSchema>;

const SORT = { field: "createdAt", direction: "desc" } as const;

function accounts(ctx: HandlerContext) {
  return ctx.db.selectFrom("core_customer as c").select([
    "c.id",
    "c.person_id",
    "c.email",
    "c.status",
    "c.link_state",
    "c.created_at",
    "c.last_sign_in_at",
    sql<number>`(SELECT count(*) FROM core_customer_session s WHERE s.customer_id = c.id AND s.expires_at > ${ctx.now})`.as(
      "sessions",
    ),
    // At most one open change per account (migration 0990's partial unique index).
    sql<
      string | null
    >`(SELECT json_object('newEmail', x.new_email, 'startedBy', x.started_by, 'createdAt', x.created_at, 'expiresAt', x.expires_at) FROM core_customer_email_change x WHERE x.customer_id = c.id AND x.confirmed_at IS NULL AND x.ended_at IS NULL)`.as(
      "email_change",
    ),
    sql<
      string | null
    >`(SELECT json_object('requestedAt', r.requested_at, 'dueAt', r.due_at) FROM core_erase_request r WHERE r.customer_id = c.id AND r.status = 'open' ORDER BY r.requested_at DESC LIMIT 1)`.as(
      "erase_request",
    ),
  ]);
}

type AccountRow = Awaited<ReturnType<ReturnType<typeof accounts>["executeTakeFirstOrThrow"]>>;

function emailChangeOf(value: string | null, now: string): CustomerAccountItem["emailChange"] {
  if (!value) return null;
  const change = JSON.parse(value) as {
    newEmail: string;
    startedBy: string;
    createdAt: string;
    expiresAt: string;
  };
  return {
    newEmail: maskEmail(change.newEmail),
    startedBy: change.startedBy === "customer" ? "customer" : "staff",
    createdAt: change.createdAt,
    expiresAt: change.expiresAt,
    expired: change.expiresAt <= now,
  };
}

const toItem = (row: AccountRow, now: string): CustomerAccountItem => ({
  id: row.id,
  personId: row.person_id,
  email: row.email,
  status: row.status,
  linkState: row.link_state,
  createdAt: String(row.created_at),
  lastSignInAt: row.last_sign_in_at,
  sessions: Number(row.sessions),
  emailChange: emailChangeOf(row.email_change, now),
  eraseRequest: row.erase_request
    ? (JSON.parse(row.erase_request) as { requestedAt: string; dueAt: string })
    : null,
});

async function requireAccount(ctx: HandlerContext, id: string): Promise<AccountRow> {
  const row = await accounts(ctx).where("c.id", "=", id).executeTakeFirst();
  if (!row) throw new NotFoundError("customer", id);
  return row;
}

export const customerList = defineOperation({
  name: "customer.list",
  description:
    "List the org's customer accounts (people outside the org who can sign in to a client app), " +
    "newest first: address, linked Person, status, when they last signed in, how many " +
    "sessions are open, a change of the sign-in address waiting for the member's code (the new " +
    "address shown only in part) and an open erase request. Filter by personId (a Person's " +
    "account) or status. Admins only. Read-only.",
  input: z.object({
    personId: z.string().max(64).optional().describe("Only the account linked to this Person"),
    status: z.enum(["active", "disabled"]).optional(),
    cursor: z.string().max(1000).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: pageSchema(customerAccountSchema),
  permission: "users:manage",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    let query = accounts(ctx);
    if (input.personId) query = query.where("c.person_id", "=", input.personId);
    if (input.status) query = query.where("c.status", "=", input.status);
    if (input.cursor) {
      const c = decodeCursor(input.cursor, SORT);
      query = query.where(
        sql<boolean>`(c.created_at < ${c.v} OR (c.created_at = ${c.v} AND c.id < ${c.id}))`,
      );
    }
    const rows = await query
      .orderBy("c.created_at", "desc")
      .orderBy("c.id", "desc")
      .limit(input.limit + 1)
      .execute();
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => toItem(row, ctx.now)),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({
              f: SORT.field,
              d: SORT.direction,
              v: String(last.created_at),
              id: last.id,
            })
          : null,
    };
  },
});

export const customerInvite = defineOperation({
  name: "customer.invite",
  description:
    "Invite an email address to sign up for a customer account while sign-up is invite only " +
    "(renewing an earlier invite). Sends nothing: the person requests a sign-in code themselves. " +
    "Refused for an erased person's address. Admins only, humans only.",
  input: z.object({ email: z.string().max(320).describe("The address to invite") }),
  output: z.object({ email: z.string() }),
  permission: "users:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const { email, statement } = await inviteCustomerStatement(
      ctx.db,
      input.email,
      ctx.user.id,
      ctx.now,
    );
    ctx.write(statement);
    ctx.recordChange({
      object: "customer_invite",
      id: email,
      action: "create",
      after: { email, invitedBy: ctx.user.id },
    });
    return { email };
  },
});

/** Ends every session of an account (in the caller's batch). */
function endSessions(ctx: HandlerContext, id: string): void {
  ctx.write(
    ctx.db.deleteFrom("core_customer_session").where("customer_id", "=", id),
    // And its native apps' sessions (stage 23).
    ...endCustomerDeviceSessions(ctx.db, [id]),
  );
}

const statusOutput = customerAccountSchema.extend({ sessionsEnded: z.number() });

async function setStatus(
  ctx: HandlerContext,
  id: string,
  status: "active" | "disabled",
): Promise<z.input<typeof statusOutput>> {
  const before = await requireAccount(ctx, id);
  ctx.write(
    ctx.db.updateTable("core_customer").set({ status, updated_at: ctx.now }).where("id", "=", id),
  );
  // Disabling signs the account out everywhere, in the same batch as the status change: there is
  // no moment when a disabled account still has a session.
  const ended = status === "disabled" ? Number(before.sessions) : 0;
  if (status === "disabled") endSessions(ctx, id);
  if (before.status !== status) {
    ctx.recordChange({
      object: "customer",
      id,
      action: "update",
      before: { status: before.status },
      after: { status },
    });
  }
  return {
    ...toItem(before, ctx.now),
    status,
    sessions: status === "disabled" ? 0 : Number(before.sessions),
    sessionsEnded: ended,
  };
}

export const customerDisable = defineOperation({
  name: "customer.disable",
  description:
    "Disable a customer account: it can no longer sign in, and every session it has ends at " +
    "once. Its Person and records are kept. Undo with customer.enable. Admins only, humans only.",
  input: z.object({ id: customerId }),
  output: statusOutput,
  permission: "users:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    return setStatus(ctx, input.id, "disabled");
  },
});

export const customerEnable = defineOperation({
  name: "customer.enable",
  description:
    "Enable a disabled customer account, so it can sign in again (with a new code). Admins " +
    "only, humans only.",
  input: z.object({ id: customerId }),
  output: statusOutput,
  permission: "users:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    return setStatus(ctx, input.id, "active");
  },
});

export const customerRevokeSessions = defineOperation({
  name: "customer.revokeSessions",
  description:
    "Sign a customer out everywhere: every session of the account ends. The account stays " +
    "active and can sign in again. Admins only, humans only.",
  input: z.object({ id: customerId }),
  output: z.object({ id: z.string(), sessionsEnded: z.number() }),
  permission: "users:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const before = await requireAccount(ctx, input.id);
    endSessions(ctx, input.id);
    return { id: input.id, sessionsEnded: Number(before.sessions) };
  },
});

export const customerChangeEmail = defineOperation({
  name: "customer.changeEmail",
  description:
    "Start changing a customer account's sign-in address, for a member who asks (by phone, at " +
    "the desk). A code is emailed to the new address; nothing changes until the member, signed " +
    `in to their account within the last 15 minutes, enters it on the website or in the app within ${EMAIL_CHANGE_CODE_MINUTES} ` +
    "minutes. You never see the code. Replaces a change already waiting. Admins only, humans only.",
  input: z.object({
    id: customerId,
    email: z.string().trim().min(3).max(320).describe("The member's new sign-in address"),
  }),
  output: z.object({ id: z.string(), newEmail: z.string(), expiresAt: z.string() }),
  permission: "users:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    await requireAccount(ctx, input.id);
    const started = await startEmailChange(ctx, input.id, input.email, ctx.user.id);
    ctx.recordChange({
      object: "customer_email_change",
      id: input.id,
      action: "create",
      after: { newEmail: started.newEmail, startedBy: ctx.user.id },
    });
    return { id: input.id, ...started };
  },
});

export const customerCancelEmailChange = defineOperation({
  name: "customer.cancelEmailChange",
  description:
    "Cancel a change of a customer account's sign-in address that waits for the member's code: " +
    "the code stops working and the address stays as it is. Admins only, humans only.",
  input: z.object({ id: customerId }),
  output: z.object({ id: z.string(), cancelled: z.boolean() }),
  permission: "users:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    await requireAccount(ctx, input.id);
    const cancelled = await cancelEmailChange(ctx, input.id);
    if (cancelled) {
      ctx.recordChange({
        object: "customer_email_change",
        id: input.id,
        action: "update",
        before: { status: "open" },
        after: { status: "cancelled" },
      });
    }
    return { id: input.id, cancelled: Boolean(cancelled) };
  },
});

export const customerOperations = [
  customerList,
  customerInvite,
  customerDisable,
  customerEnable,
  customerRevokeSessions,
  customerChangeEmail,
  customerCancelEmailChange,
] as const;
