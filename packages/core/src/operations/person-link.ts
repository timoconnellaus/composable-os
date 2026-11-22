// The family link (stage 31a step 6, ADR 0540): staff link a guardian (a parent) to a dependant
// (a child), and end the link; a signed-in customer reads their own family.
//
//   person.link.add    staff, a person only (people:link): link two People
//   person.link.end    staff, a person only (people:link): end a link; it gives nothing from then
//   person.link.list   staff (records:read): a Person's guardians and dependants, ended ones too
//   person.link.mergePlan  staff (records:read): what a merge would do to two People's links
//   me.family          a signed-in customer: the dependants they act for and their guardians
//
// Who may act for whom is identity (spec 31, ADR 0540), so making and ending a link is a person's
// own act: `actors: ["human"]`, refused to the assistant, MCP clients, automations, extension
// code and an import alike, and closed to customers and the public (staff audience only). What a
// live link allows is decided at the visibility seam alone (visibility/guardians.ts); nothing
// here widens what anyone reads.
import { sql } from "kysely";
import { z } from "zod";
import { ConflictError, NotFoundError, OperationError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { planMergeLinks } from "../records/person-links.ts";
import { GUARDIAN_LINK, recordsMadeFor, sharedEmailWarning } from "../visibility/guardians.ts";
import { visibleSource } from "../visibility/index.ts";

const personId = z.string().min(1).max(64);
const linkId = z.string().min(1).max(64).describe("The link's id (pln_…)");

const linkSchema = z.object({
  id: z.string(),
  kind: z.literal("guardian"),
  guardian: z.object({ id: z.string(), name: z.string().nullable() }),
  dependant: z.object({ id: z.string(), name: z.string().nullable() }),
  note: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string(),
  endedAt: z.string().nullable(),
  endedBy: z.string().nullable(),
  endReason: z.string().nullable(),
  warning: z
    .string()
    .nullable()
    .describe(
      "Set when the child's record has an email that is also the parent's or another account's: " +
        "signing in with it would open that account as the child's",
    ),
});
type Link = z.infer<typeof linkSchema>;

interface LinkRow {
  id: string;
  kind: string;
  guardian_id: string;
  dependant_id: string;
  note: string | null;
  created_by: string;
  created_at: string;
  ended_at: string | null;
  ended_by: string | null;
  end_reason: string | null;
}

/** Display names of People, read through the caller's own scope (staff: every Person). */
async function namesOf(ctx: HandlerContext, ids: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids)];
  if (!wanted.length) return new Map();
  const rows = await ctx.db
    .selectFrom(visibleSource(ctx, "person"))
    .select(["id", "display_name"])
    .where("id", "in", wanted)
    .execute();
  return new Map(rows.map((row) => [row.id, row.display_name]));
}

function toLink(row: LinkRow, names: Map<string, string>, warning: string | null = null): Link {
  return {
    warning,
    id: row.id,
    kind: "guardian",
    guardian: { id: row.guardian_id, name: names.get(row.guardian_id) ?? null },
    dependant: { id: row.dependant_id, name: names.get(row.dependant_id) ?? null },
    note: row.note,
    createdAt: row.created_at,
    createdBy: row.created_by,
    endedAt: row.ended_at,
    endedBy: row.ended_by,
    endReason: row.end_reason,
  };
}

async function loadLink(ctx: HandlerContext, id: string): Promise<LinkRow | undefined> {
  return (await ctx.db
    .selectFrom("core_person_link")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst()) as LinkRow | undefined;
}

/** A live Person (out of the Trash), or not found. */
async function requireLivePerson(ctx: HandlerContext, id: string): Promise<string> {
  const names = await namesOf(ctx, [id]);
  const name = names.get(id);
  if (name === undefined) throw new NotFoundError("person", id);
  return name;
}

export const personLinkAdd = defineOperation({
  name: "person.link.add",
  description:
    "Link a guardian (a parent) to a dependant (a child) they may act for: while the link is " +
    "live the guardian, signed in on the gym's site or app, books, cancels and joins waitlists " +
    "for the dependant, and reads the dependant's bookings and what their memberships and passes " +
    "have left, and nothing else of theirs. The dependant may have no email and no account. A " +
    "dependant may have several guardians, a guardian several dependants. Refused when the two " +
    "are already linked either way. Only a person on the staff with people:link can do this: " +
    "never the assistant, an MCP client or code. Audited.",
  input: z.object({
    guardianId: personId.describe("The parent or guardian (per_…)"),
    dependantId: personId.describe("The child they may act for (per_…)"),
    note: z.string().trim().max(500).optional().describe("Why, e.g. mother, legal guardian"),
  }),
  output: linkSchema,
  permission: "people:link",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    if (input.guardianId === input.dependantId) {
      throw new ValidationError("A person cannot be their own guardian");
    }
    const guardianName = await requireLivePerson(ctx, input.guardianId);
    const dependantName = await requireLivePerson(ctx, input.dependantId);
    const existing = await ctx.db
      .selectFrom("core_person_link")
      .select(["guardian_id"])
      .where("kind", "=", GUARDIAN_LINK)
      .where("ended_at", "is", null)
      .where((eb) =>
        eb.or([
          eb.and([
            eb("guardian_id", "=", input.guardianId),
            eb("dependant_id", "=", input.dependantId),
          ]),
          eb.and([
            eb("guardian_id", "=", input.dependantId),
            eb("dependant_id", "=", input.guardianId),
          ]),
        ]),
      )
      .executeTakeFirst();
    if (existing) {
      throw new ConflictError(
        existing.guardian_id === input.guardianId
          ? "These two are already linked."
          : "The other way round is already linked: the dependant is this person's guardian.",
        { rule: "person_link" },
      );
    }
    const id = newId("personLink");
    ctx.write(
      ctx.db.insertInto("core_person_link").values({
        id,
        kind: GUARDIAN_LINK,
        guardian_id: input.guardianId,
        dependant_id: input.dependantId,
        note: input.note || null,
        created_by: ctx.user.id,
        created_at: ctx.now,
      }),
    );
    // On both timelines, naming no one (an erase of either leaves nothing of the other behind).
    ctx.postActivity({
      subject: "Guardian linked",
      payload: { kind: "person_link", action: "added", linkId: id },
      links: [
        { object: "person", id: input.guardianId },
        { object: "person", id: input.dependantId },
      ],
    });
    return toLink(
      {
        id,
        kind: GUARDIAN_LINK,
        guardian_id: input.guardianId,
        dependant_id: input.dependantId,
        note: input.note || null,
        created_by: ctx.user.id,
        created_at: ctx.now,
        ended_at: null,
        ended_by: null,
        end_reason: null,
      },
      new Map([
        [input.guardianId, guardianName],
        [input.dependantId, dependantName],
      ]),
      // Linked anyway: staff are told, and fix the child's record (ADR 0540).
      await sharedEmailWarning(ctx.db, input.guardianId, input.dependantId),
    );
  },
});

export const personLinkEnd = defineOperation({
  name: "person.link.end",
  description:
    "End a family link: from that moment the guardian reads nothing of the dependant's and " +
    "books nothing for them. Bookings they already made stay (cancel them separately if " +
    "needed); the answer says how many (stays). The link is kept, ended, with who ended it and " +
    "why. Only a person on the staff with people:link can do this. Audited.",
  input: z.object({
    id: linkId,
    reason: z.string().trim().max(500).optional(),
  }),
  output: linkSchema.extend({
    stays: z
      .array(z.object({ object: z.string(), label: z.string(), count: z.number() }))
      .describe("Live records the guardian made for the dependant (bookings): they stay"),
  }),
  permission: "people:link",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await loadLink(ctx, input.id);
    if (!row) throw new NotFoundError("person link", input.id);
    if (row.ended_at) {
      throw new ConflictError("This link has already ended.", { rule: "person_link_ended" });
    }
    ctx.write(
      ctx.db
        .updateTable("core_person_link")
        .set({ ended_at: ctx.now, ended_by: ctx.user.id, end_reason: input.reason || null })
        .where("id", "=", input.id)
        .where("ended_at", "is", null),
    );
    ctx.postActivity({
      subject: "Guardian link ended",
      payload: { kind: "person_link", action: "ended", linkId: input.id },
      links: [
        { object: "person", id: row.guardian_id },
        { object: "person", id: row.dependant_id },
      ],
    });
    const names = await namesOf(ctx, [row.guardian_id, row.dependant_id]);
    // What they made for the child stays (bookings): staff are told how many.
    const stays = await recordsMadeFor(ctx.db, row.guardian_id, row.dependant_id);
    return {
      ...toLink(
        { ...row, ended_at: ctx.now, ended_by: ctx.user.id, end_reason: input.reason || null },
        names,
      ),
      stays,
    };
  },
});

export const personLinkList = defineOperation({
  name: "person.link.list",
  description:
    "A person's family links: the guardians who may act for them and the dependants they may " +
    "act for, live ones first, with names, who made each and when, and (with ended) the links " +
    "that have ended. Read-only.",
  input: z.object({
    personId: personId.describe("The person (per_…)"),
    ended: z.boolean().default(false).describe("Include links that have ended"),
  }),
  output: z.object({ items: z.array(linkSchema) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    let query = ctx.db
      .selectFrom("core_person_link")
      .selectAll()
      .where((eb) =>
        eb.or([eb("guardian_id", "=", input.personId), eb("dependant_id", "=", input.personId)]),
      );
    if (!input.ended) query = query.where("ended_at", "is", null);
    const rows = (await query
      .orderBy(sql`ended_at IS NOT NULL`)
      .orderBy("created_at", "desc")
      .limit(200)
      .execute()) as LinkRow[];
    const names = await namesOf(
      ctx,
      rows.flatMap((row) => [row.guardian_id, row.dependant_id]),
    );
    const items: Link[] = [];
    for (const row of rows) {
      const warning = row.ended_at
        ? null
        : await sharedEmailWarning(ctx.db, row.guardian_id, row.dependant_id);
      items.push(toLink(row, names, warning));
    }
    return { items };
  },
});

export const personLinkMergePlan = defineOperation({
  name: "person.link.mergePlan",
  description:
    "What merging one person (mergedId) into another (survivorId) would do to their family " +
    "links: how many move, how many end (a duplicate, or one whose other way round is linked: " +
    "never a two-way link), how many are deleted (links between the two) and how many past " +
    "links move as history. A merge that touches a live link waits for a person's approval when " +
    "anyone but a person asks for it. Read-only.",
  input: z.object({ survivorId: personId, mergedId: personId }),
  output: z.object({
    moved: z.number(),
    ended: z.number(),
    deleted: z.number(),
    history: z.number(),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const plan = await planMergeLinks(ctx.db, input.survivorId, input.mergedId);
    return { moved: plan.moved, ended: plan.ended, deleted: plan.deleted, history: plan.history };
  },
});

const familyMember = z.object({ personId: z.string(), name: z.string() });

export const meFamily = defineOperation({
  name: "me.family",
  description:
    "Your family, as a signed-in customer: yourself, the dependants (children) the gym has " +
    "linked to you, whom you may book for, and the guardians linked to you, each with their " +
    "name and id. Only live links; the gym's staff make and end them. Read-only.",
  input: z.object({}),
  output: z.object({
    self: familyMember,
    dependants: z.array(familyMember),
    guardians: z.array(familyMember),
  }),
  permission: "records:read",
  risk: "read",
  audiences: ["customer"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    // The seam answers: the caller's own live links only, never an id from the input.
    const family = await ctx.records.family();
    if (!family.self) throw new OperationError("internal", "me.family is for a customer's call");
    return {
      self: family.self,
      dependants: [...family.dependants],
      guardians: [...family.guardians],
    };
  },
});

export const personLinkOperations = [
  personLinkAdd,
  personLinkEnd,
  personLinkList,
  personLinkMergePlan,
  meFamily,
] as const;
