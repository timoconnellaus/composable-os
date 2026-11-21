// eraseRequest.* operations (stage 22, ADR 0402): the requests customers make when they delete
// their account. Staff either erase the person with person.erase, which closes (and deletes) the
// request with everything else about them, or decline here with a reason, which is emailed to the
// person. Admins only (`audit:read` to list, `records:erase` to decline) and humans only, like
// erasure itself.
//
// Requests are not records. A Person's name is read through `ctx.records`, the seam.
import { z } from "zod";
import {
  customerCodeTarget,
  eraseDeclinedEmail,
  sendCustomerEmail,
} from "../customers/code-email.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import { errorForLog } from "../log.ts";
import type { CallIntegration } from "../notifications/channels.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";

const requestSchema = z.object({
  id: z.string(),
  personId: z.string(),
  /** The Person's name, when staff can still see them (null for one in Trash). */
  personName: z.string().nullable(),
  requestedAt: z.string(),
  dueAt: z.string(),
  overdue: z.boolean(),
});

async function personName(ctx: HandlerContext, id: string): Promise<string | null> {
  try {
    const record = await ctx.records.get("person", id);
    const name = record.values.displayName;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

export const eraseRequestList = defineOperation({
  name: "eraseRequest.list",
  description:
    "List open erase requests: customers who deleted their account and asked to be erased, " +
    "soonest due first, with when each was asked, when it is due and whether it is overdue. " +
    "Action one with person.erase, or eraseRequest.decline with a reason. Admins only. Read-only.",
  input: z.object({}),
  output: z.object({ items: z.array(requestSchema) }),
  // A read: the admin Audit page's permission, as for erasure.addressStatus. Admins only.
  permission: "audit:read",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    const rows = await ctx.db
      .selectFrom("core_erase_request")
      .select(["id", "person_id", "requested_at", "due_at"])
      .where("status", "=", "open")
      .orderBy("due_at")
      .orderBy("id")
      .limit(500)
      .execute();
    const items = [];
    for (const row of rows) {
      items.push({
        id: row.id,
        personId: row.person_id,
        personName: await personName(ctx, row.person_id),
        requestedAt: row.requested_at,
        dueAt: row.due_at,
        overdue: row.due_at <= ctx.now,
      });
    }
    return { items };
  },
});

/** Sends through the email-send gatekeeper as the staff member who declined. */
function callAs(ctx: HandlerContext): CallIntegration | null {
  const integrations = ctx.integrations;
  if (!integrations) return null;
  return async (input) => {
    const result = await integrations.call({
      ...input,
      caller: {
        actor: ctx.actor,
        userId: ctx.user.id,
        userName: ctx.user.name,
        role: ctx.user.role,
        origin: ctx.origin,
        grantedPermissions: ctx.grantedPermissions,
        reason: "Telling a customer why their erase request was declined",
      },
    });
    return { value: result.value, pending: result.pending, applied: result.applied };
  };
}

export const eraseRequestDecline = defineOperation({
  name: "eraseRequest.decline",
  description:
    "Decline an open erase request with a reason (a record the org must keep). Closes the " +
    "request and emails the reason to the person through the org's email connection. The " +
    "account stays disabled. Admins only, humans only.",
  input: z.object({
    id: z.string().min(1).max(64).describe("Erase request id (erq_…) from eraseRequest.list"),
    reason: z.string().trim().min(1).max(2000).describe("Why the data must be kept"),
  }),
  output: z.object({
    id: z.string(),
    status: z.literal("declined"),
    /** sent; pending (queued for approval); or not_sent, with why. */
    email: z.enum(["sent", "pending", "not_sent"]),
    problem: z.string().optional(),
  }),
  permission: "records:erase",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await ctx.db
      .selectFrom("core_erase_request as r")
      .leftJoin("core_customer as c", "c.id", "r.customer_id")
      .select(["r.id", "r.person_id", "r.status", "c.email"])
      .where("r.id", "=", input.id)
      .executeTakeFirst();
    if (!row) throw new NotFoundError("erase request", input.id);
    if (row.status !== "open") {
      throw new ConflictError(`The erase request is already ${row.status}`, {
        status: row.status,
      });
    }
    ctx.write(
      ctx.db
        .updateTable("core_erase_request")
        .set({
          status: "declined",
          decline_reason: input.reason,
          closed_at: ctx.now,
          closed_by: ctx.user.id,
        })
        .where("id", "=", input.id)
        .where("status", "=", "open"),
    );
    ctx.recordChange({
      object: "erase_request",
      id: input.id,
      action: "update",
      before: { status: "open" },
      after: { status: "declined", declineReason: input.reason },
    });
    // The email goes after the decline commits: a failed send does not reopen the request.
    return ctx.afterCommit(async () => {
      const declined = { id: input.id, status: "declined" as const };
      const to =
        row.email ??
        (await ctx.records
          .get("person", row.person_id)
          .then((p) => (typeof p.values.primaryEmail === "string" ? p.values.primaryEmail : null))
          .catch(() => null));
      if (!to) return { ...declined, email: "not_sent" as const, problem: "No address to email" };
      const call = callAs(ctx);
      if (!call) {
        return {
          ...declined,
          email: "not_sent" as const,
          problem: "The integration host is not available here",
        };
      }
      const target = await customerCodeTarget(ctx.db);
      if ("problem" in target) {
        return { ...declined, email: "not_sent" as const, problem: target.problem };
      }
      try {
        const sent = await sendCustomerEmail(call, target.target, {
          to,
          ...eraseDeclinedEmail(input.reason),
        });
        return { ...declined, email: sent };
      } catch (error) {
        console.error("erase request decline email not sent", errorForLog(error));
        return { ...declined, email: "not_sent" as const, problem: "The email could not be sent" };
      }
    });
  },
});

export const eraseRequestOperations = [eraseRequestList, eraseRequestDecline] as const;
