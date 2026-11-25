// Practitioner accounts (stage 43 step 3, ADR 0581). A person on the staff with
// `practitioners:manage` invites an outside practitioner (a physiotherapist, a dietitian), lists
// them and ends their accounts; nobody else does, whatever is granted: every staff operation here
// is `actors: ["human"]`, not on MCP, and refused from a device session (the company's app on a
// phone, or the import door). Accepting an invite is not an operation: it is signing in with a
// code emailed to the address (packages/auth).
//
// `practitioner.me` is the one operation open to the practitioner audience in this step: the
// signed-in practitioner's own account. Nothing about any client is open to them yet (the care
// link is step 4, the practitioner scope step 5).
import type { CorePractitionerTable } from "@composable-os/db";
import type { Selectable } from "kysely";
import { z } from "zod";
import { sameEmailPeople } from "../customers/accounts.ts";
import { usableAddress } from "../customers/address-person.ts";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  OperationError,
  ValidationError,
} from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import {
  endPractitionerSessionsStatements,
  normalisePractitionerEmail,
} from "../practitioners/accounts.ts";
import type { PractitionerPrincipal } from "../principals.ts";

type Row = Selectable<CorePractitionerTable>;

const STATUSES = ["invited", "active", "ended"] as const;

const practitionerSchema = z.object({
  id: z.string(),
  /** Their own Person in the host: their name and contact, as staff see them. */
  personId: z.string(),
  email: z.string(),
  name: z.string(),
  discipline: z.string(),
  /** The practice they work for (an Organisation), or null. */
  practiceId: z.string().nullable(),
  status: z.enum(STATUSES),
  invitedBy: z.string(),
  invitedAt: z.string(),
  activatedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  endedBy: z.string().nullable(),
  endedReason: z.string().nullable(),
  lastSignInAt: z.string().nullable(),
});

const toPractitioner = (row: Row): z.infer<typeof practitionerSchema> => ({
  id: row.id,
  personId: row.person_id,
  email: row.email,
  name: row.name,
  discipline: row.discipline,
  practiceId: row.practice_id,
  status: row.status,
  invitedBy: row.invited_by,
  invitedAt: row.invited_at,
  activatedAt: row.activated_at,
  endedAt: row.ended_at,
  endedBy: row.ended_by,
  endedReason: row.ended_reason,
  lastSignInAt: row.last_sign_in_at,
});

/** What the audit log keeps of an account: no sign-in times. */
const audited = (row: Row) => ({
  personId: row.person_id,
  email: row.email,
  name: row.name,
  discipline: row.discipline,
  practiceId: row.practice_id,
  status: row.status,
  ...(row.ended_reason !== null ? { endedReason: row.ended_reason } : {}),
});

const idInput = z.string().min(1).max(64).describe("Practitioner account id (prc_…)");

/**
 * Only a person at the web admin: `actors: ["human"]` keeps out the assistant, MCP, automations
 * and extensions; this keeps out a device session too (the company's app on a phone, the import
 * door), which is a person's but not the admin's.
 */
function atTheAdmin(ctx: HandlerContext): void {
  if (ctx.origin.staffDevice) {
    throw new ForbiddenError(`${ctx.operation} is done in the web admin, not from a device`, {
      operation: ctx.operation,
      reason: "web_admin_only",
    });
  }
}

async function loadRow(ctx: HandlerContext, id: string): Promise<Row> {
  const row = await ctx.db
    .selectFrom("core_practitioner")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new NotFoundError("practitioner", id);
  return row;
}

/**
 * The Person an invited address is: the one live Person with it (the same-email rule, ADR 0247),
 * or a new one the inviter makes in this batch with the address and the invite's name. Refused
 * when several People have it (merge them first), and, with the same words as any unusable
 * address, when it is not one or is an erased person's.
 */
async function personForInvite(ctx: HandlerContext, email: string, name: string): Promise<string> {
  await usableAddress(ctx, email);
  const matches = await sameEmailPeople(ctx.db, email);
  if (matches.length > 1) {
    throw new ConflictError(
      "Several people have this address. Merge them first, then invite again.",
      { field: "email" },
    );
  }
  if (matches[0]) return matches[0];
  // Loaded lazily: operations/person.ts is reachable from the modules that import this one.
  const { personCreate } = await import("./person.ts");
  const input = personCreate.input.parse({
    displayName: name,
    emails: [{ email, primary: true }],
  });
  const person = (await personCreate.handler(input, ctx)) as { id: string };
  return person.id;
}

export const practitionerList = defineOperation({
  name: "practitioner.list",
  description:
    "List the outside practitioners (physiotherapists, dietitians and the like) the business has " +
    "invited: each one's name, sign-in address, discipline, practice, whether they are invited " +
    "(not yet signed in), active or ended, and who invited and ended them. Needs " +
    "practitioners:manage, and only a person can call it. Read-only.",
  input: z.object({
    status: z.enum(STATUSES).optional().describe("Only accounts in this state"),
  }),
  output: z.object({ items: z.array(practitionerSchema) }),
  permission: "practitioners:manage",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    atTheAdmin(ctx);
    let query = ctx.db.selectFrom("core_practitioner").selectAll();
    if (input.status) query = query.where("status", "=", input.status);
    const rows = await query.orderBy("invited_at", "desc").limit(500).execute();
    return { items: rows.map(toPractitioner) };
  },
});

export const practitionerGet = defineOperation({
  name: "practitioner.get",
  description:
    "One outside practitioner's account by id (prc_…): name, sign-in address, discipline, " +
    "practice, state, who invited and ended it and why. Needs practitioners:manage, and only a " +
    "person can call it. Read-only.",
  input: z.object({ id: idInput }),
  output: practitionerSchema,
  permission: "practitioners:manage",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    atTheAdmin(ctx);
    return toPractitioner(await loadRow(ctx, input.id));
  },
});

export const practitionerInvite = defineOperation({
  name: "practitioner.invite",
  description:
    "Invite an outside practitioner (a physiotherapist, a dietitian) to their own practitioner " +
    "account, by email, with their name, discipline and optionally the practice (an " +
    "Organisation) they work for. They accept by signing in with a code emailed to that address. " +
    "The account is apart from any staff or customer account the same address has, and reaches " +
    "nothing about any client until that client agrees. The address's Person is used, or made " +
    "when there is none. Inviting an address whose invite is not yet accepted updates and resends " +
    "it; an address with an active or ended practitioner account cannot be invited. Needs " +
    "practitioners:manage, and only a person can call it.",
  input: z.object({
    email: z.string().min(3).max(254).describe("Their email address"),
    name: z.string().trim().min(1).max(200).describe("Their name"),
    discipline: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .describe('What they do, as a label ("Physiotherapist", "Dietitian")'),
    practiceId: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("The practice they work for: an Organisation's id (org_…)"),
  }),
  output: practitionerSchema.extend({
    /** Whether the invite notice was emailed, waits for review (it holds no secret), or not. */
    invitationEmail: z.enum(["sent", "pending", "not_sent"]),
  }),
  permission: "practitioners:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    atTheAdmin(ctx);
    const email = normalisePractitionerEmail(input.email);
    if (!email) throw new ValidationError("Not an email address", { field: "email" });
    if (input.practiceId) await ctx.records.get("organisation", input.practiceId);
    const existing = await ctx.db
      .selectFrom("core_practitioner")
      .selectAll()
      .where("email", "=", email)
      .executeTakeFirst();
    if (existing && existing.status !== "invited") {
      throw new ConflictError(
        existing.status === "active"
          ? "This address already has a practitioner account."
          : "This address's practitioner account was ended.",
        { field: "email", practitionerId: existing.id, status: existing.status },
      );
    }
    const fields = {
      name: input.name,
      discipline: input.discipline,
      practice_id: input.practiceId ?? null,
    };
    let row: Row;
    if (existing) {
      // Not yet accepted: the invite is updated and sent again.
      row = { ...existing, ...fields, updated_at: ctx.now };
      ctx.write(
        ctx.db
          .updateTable("core_practitioner")
          .set({ ...fields, updated_at: ctx.now })
          .where("id", "=", existing.id)
          .where("status", "=", "invited"),
      );
      ctx.recordChange({
        object: "practitioner",
        id: existing.id,
        action: "update",
        before: audited(existing),
        after: audited(row),
      });
    } else {
      // The address's Person: the one live Person with it, or one the inviter makes now, in this
      // batch, as person.create makes any (ADR 0581).
      const personId = await personForInvite(ctx, email, input.name);
      const held = await ctx.db
        .selectFrom("core_practitioner")
        .select("id")
        .where("person_id", "=", personId)
        .executeTakeFirst();
      if (held) {
        throw new ConflictError("This person already has a practitioner account.", {
          field: "email",
          practitionerId: held.id,
        });
      }
      row = {
        id: newId("practitioner"),
        person_id: personId,
        email,
        email_verified: 1,
        ...fields,
        status: "invited",
        invited_by: ctx.user.id,
        invited_at: ctx.now,
        activated_at: null,
        ended_at: null,
        ended_by: null,
        ended_reason: null,
        last_sign_in_at: null,
        created_at: ctx.now,
        updated_at: ctx.now,
      };
      ctx.write(ctx.db.insertInto("core_practitioner").values(row));
      ctx.recordChange({
        object: "practitioner",
        id: row.id,
        action: "create",
        after: audited(row),
      });
    }
    const hostMail = ctx.hostMail;
    const invitedBy = ctx.user.name || ctx.user.email;
    const result = toPractitioner(row);
    return ctx.afterCommit(async () => ({
      ...result,
      invitationEmail: hostMail?.sendPractitionerInvite
        ? await hostMail.sendPractitionerInvite({
            to: email,
            invitedBy,
            discipline: input.discipline,
          })
        : ("not_sent" as const),
    }));
  },
});

export const practitionerEnd = defineOperation({
  name: "practitioner.end",
  description:
    "End an outside practitioner's account, with the reason: they can no longer sign in, and " +
    "every session of theirs ends at once. An invite not yet accepted is withdrawn the same way. " +
    "Needs practitioners:manage, and only a person can call it. Returns the account.",
  input: z.object({
    id: idInput,
    reason: z.string().trim().min(1).max(500).describe("Why the account ends"),
  }),
  output: practitionerSchema,
  permission: "practitioners:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    atTheAdmin(ctx);
    const before = await loadRow(ctx, input.id);
    if (before.status === "ended") {
      throw new ConflictError("This practitioner's account has already ended.", {
        practitionerId: before.id,
      });
    }
    const after: Row = {
      ...before,
      status: "ended",
      ended_at: ctx.now,
      ended_by: ctx.user.id,
      ended_reason: input.reason,
      updated_at: ctx.now,
    };
    ctx.write(
      ctx.db
        .updateTable("core_practitioner")
        .set({
          status: "ended",
          ended_at: ctx.now,
          ended_by: ctx.user.id,
          ended_reason: input.reason,
          updated_at: ctx.now,
        })
        .where("id", "=", before.id)
        .where("status", "!=", "ended"),
      // In the same batch: no session of theirs outlives the end.
      ...endPractitionerSessionsStatements(ctx.db, before),
    );
    ctx.recordChange({
      object: "practitioner",
      id: before.id,
      action: "update",
      before: audited(before),
      after: audited(after),
    });
    return toPractitioner(after);
  },
});

/** The caller, who is always a practitioner here. */
function practitionerOf(ctx: HandlerContext): PractitionerPrincipal {
  const principal = ctx.principal;
  if (principal.kind !== "practitioner") {
    throw new OperationError("internal", `${ctx.operation} is for a practitioner's call`);
  }
  return principal;
}

export const practitionerMe = defineOperation({
  name: "practitioner.me",
  description:
    "Your own practitioner account, as a signed-in practitioner: your name, sign-in address and " +
    "discipline. Read-only.",
  input: z.object({}),
  output: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    discipline: z.string(),
  }),
  permission: "records:read",
  risk: "read",
  audiences: ["practitioner"],
  // Core bookkeeping that is not a record (ADR 0413): the caller's own account row, read by the
  // verified principal's id, never an input.
  hostInternal: true,
  mcp: { expose: false },
  async handler(_input, ctx) {
    const { practitionerId } = practitionerOf(ctx);
    const row = await ctx.db
      .selectFrom("core_practitioner")
      .select(["id", "name", "email", "discipline"])
      .where("id", "=", practitionerId)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!row) throw new NotFoundError("practitioner", practitionerId);
    return row;
  },
});

export const practitionerOperations = [
  practitionerList,
  practitionerGet,
  practitionerInvite,
  practitionerEnd,
  practitionerMe,
] as const;
