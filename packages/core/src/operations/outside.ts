// The booking-system copy (stage 65 step 3, ADR 0922): its settings, the state of its lists, who
// waits to be matched, and linking by hand. Core, staff only (none is open to customers or the
// public, ADR 0402):
//
//   outside.settings.get     staff (bookingSystem:manage)           on or off, member types, links, …
//   outside.settings.update  staff (settings:manage, a person)      change them
//   outside.status           staff (bookingSystem:manage)           the lists, their dates and ages
//   outside.matches          staff (bookingSystem:manage)           To match: who waits, and for whom
//   outside.link             staff (bookingSystem:manage, a person) link an outside person or coach
//   outside.unlink           staff (bookingSystem:manage, a person) unlink one, with why
//   outside.lists.remove     staff (bookingSystem:manage, a person) remove a list, or both
//   outside.file.preview     staff (bookingSystem:manage, a person) the dry run of an exported list
//   outside.file.load        staff (bookingSystem:manage, a person) load it, as the dry run showed
//
// Loading a list (`outside.file.preview`, `outside.file.load`, step 4, ADR 0923) plans through
// `outside/file.ts` and `outside/ingest.ts`. Removing one (step 10) plans through `outside/remove.ts`. None of these writes to the booking system, a Person's fields,
// an order, a membership or booking here, or an allowance. Linking and the settings are a person's
// at the screen (`actors: ["human"]`, never MCP, Code Mode, an extension or an automation): who is
// a member decides prices and what a customer may open. An AI may read the lists' state and To
// match for an account that holds bookingSystem:manage, to explain them.
import { type SqlBool, sql } from "kysely";
import { z } from "zod";
import { ConflictError, ForbiddenError, ValidationError } from "../errors.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import {
  DATE_FORMATS,
  type FileMapping,
  fileBytes,
  MAX_FILE_BASE64,
  MAX_VALUE_WORD,
  planFile,
  savedMappings,
  saveMappingStatement,
} from "../outside/file.ts";
import { droppedOf, LINK_SUBJECT, outsideRefHash } from "../outside/match.ts";
import { planRemoval, REMOVE_MAX_STATEMENTS, REMOVE_PASS_ROWS } from "../outside/remove.ts";
import {
  businessToday,
  currentLists,
  LIST_KINDS,
  type ListKind,
  listAge,
  loadOutsideSettings,
  MAX_LARGEST_AGE_DAYS,
  onCurrentList,
} from "../outside/settings.ts";
import { holdsPermission } from "../principals.ts";
import { putEraseLog } from "../records/erase-log.ts";
import { visibleTable } from "../visibility/index.ts";

const httpsLink = z
  .string()
  .trim()
  .max(500)
  .pipe(z.url({ protocol: /^https$/ }))
  .nullable();

const why = z.string().trim().min(1).max(500).describe("Why: kept with the link and audited");
const ref = z.string().min(1).max(600).describe("The outside person's or coach's ref, as listed");

const settingsSchema = z.object({
  source: z.literal("file"),
  enabled: z.boolean().describe("Off: the copy is kept and nothing reads it"),
  memberTypes: z
    .array(z.string())
    .nullable()
    .describe(
      "The outside membership and pass types that make a Person a member; null: every type of kind membership, no pass",
    ),
  manageUrl: z.string().nullable().describe("Where a member manages their membership"),
  bookUrl: z.string().nullable().describe("Where to book a class"),
  largestAgeDays: z.number().int().describe("A members list counts for this many days"),
  updatedAt: z.string().nullable(),
});

const typeSchema = z.object({
  ref: z.string(),
  name: z.string(),
  kind: z.enum(["membership", "pass"]),
  active: z.boolean(),
  counts: z.boolean().describe("It makes a Person a member"),
});

export const outsideSettingsGet = defineOperation({
  name: "outside.settings.get",
  description:
    "Read the booking-system settings: whether the copy is on, which outside membership and pass " +
    "types make a Person a member (by default every membership, no pass), the business's links " +
    "(where a member manages their membership, where to book a class) and the largest age a " +
    "members list counts for; and the membership types the current members list holds, each " +
    "marked whether it counts. Needs bookingSystem:manage.",
  input: z.object({}),
  output: settingsSchema.extend({
    types: z.array(typeSchema),
    mappings: z
      .record(z.string(), z.unknown())
      .describe("The column mapping and value maps saved by the last load of each kind"),
  }),
  permission: "bookingSystem:manage",
  risk: "read",
  mcp: { title: "Booking system settings" },
  async handler(_input, ctx) {
    const settings = await loadOutsideSettings(ctx.db);
    const types = await ctx.db
      .selectFrom("core_outside_membership_type")
      .select(["ref", "name", "kind", "active"])
      .where(onCurrentList("list_id"))
      .orderBy("kind")
      .orderBy("name")
      .execute();
    const { updatedBy: _by, ...rest } = settings;
    return {
      ...rest,
      mappings: await savedMappings(ctx.db),
      types: types.map((t) => ({
        ref: t.ref,
        name: t.name,
        kind: t.kind,
        active: t.active === 1,
        counts:
          settings.memberTypes === null
            ? t.kind === "membership"
            : settings.memberTypes.includes(t.ref),
      })),
    };
  },
});

export const outsideSettingsUpdate = defineOperation({
  name: "outside.settings.update",
  description:
    "Change the booking-system settings: on or off, the outside types that make a Person a " +
    "member (null for the default: every membership type, no pass), the two links (each an https " +
    "address, or null), and the largest age a members list counts for (1 to 90 days). Leave a " +
    "setting out to keep it. A human admin in the app only.",
  input: z.object({
    enabled: z.boolean().optional(),
    memberTypes: z.array(z.string().min(1).max(600)).max(200).nullable().optional(),
    manageUrl: httpsLink.optional(),
    bookUrl: httpsLink.optional(),
    largestAgeDays: z.number().int().min(1).max(MAX_LARGEST_AGE_DAYS).optional(),
  }),
  output: settingsSchema,
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const before = await loadOutsideSettings(ctx.db);
    const next = {
      enabled: input.enabled ?? before.enabled,
      memberTypes:
        input.memberTypes === undefined
          ? before.memberTypes
          : input.memberTypes === null
            ? null
            : [...new Set(input.memberTypes)],
      manageUrl: input.manageUrl === undefined ? before.manageUrl : input.manageUrl,
      bookUrl: input.bookUrl === undefined ? before.bookUrl : input.bookUrl,
      largestAgeDays: input.largestAgeDays ?? before.largestAgeDays,
    };
    const row = {
      enabled: next.enabled ? 1 : 0,
      member_types: next.memberTypes === null ? null : JSON.stringify(next.memberTypes),
      manage_url: next.manageUrl,
      book_url: next.bookUrl,
      largest_age_days: next.largestAgeDays,
      updated_by: ctx.user.id,
      updated_at: ctx.now,
    };
    ctx.write(
      ctx.db
        .insertInto("core_outside_settings")
        .values({ id: 1, ...row })
        .onConflict((oc) => oc.column("id").doUpdateSet(row)),
    );
    return { source: "file" as const, ...next, updatedAt: ctx.now };
  },
});

const listSchema = z.object({
  kind: z.enum(LIST_KINDS),
  exportedOn: z.string().describe("The date the list's file was exported, YYYY-MM-DD"),
  loadedAt: z.string(),
  loadedBy: z.string(),
  loadedByName: z.string().nullable(),
  rows: z.number().int(),
  refused: z.number().int(),
  kept: z.number().int(),
  ageDays: z.number().int().describe("Days since it was exported"),
  countsUntil: z.string().describe("A members list's last day counting"),
  tooOld: z.boolean().describe("A members list past the largest age: shown, and counts no more"),
});

export const outsideStatus = defineOperation({
  name: "outside.status",
  description:
    "The state of the booking system's copy: the current members and timetable lists (each with " +
    "the date its file was exported, its age, when and by whom it was loaded, rows read, refused " +
    "and kept, and for a members list whether it is too old to count), how many outside people " +
    "are kept and linked, and how many people and coaches wait in To match. With no list loaded " +
    "every count is 0. Counts and dates only, no names. Needs bookingSystem:manage.",
  input: z.object({}),
  output: z.object({
    enabled: z.boolean(),
    largestAgeDays: z.number().int(),
    today: z.string(),
    lists: z.array(listSchema),
    counts: z.object({
      people: z.number().int(),
      linked: z.number().int(),
      memberships: z.number().int(),
      classes: z.number().int(),
      bookings: z.number().int(),
      staff: z.number().int(),
      staffLinked: z.number().int(),
      waitingPeople: z.number().int(),
      waitingStaff: z.number().int(),
    }),
  }),
  permission: "bookingSystem:manage",
  risk: "read",
  mcp: { title: "Booking system lists" },
  async handler(_input, ctx) {
    const [settings, lists, today, counts, linkedRow] = await Promise.all([
      loadOutsideSettings(ctx.db),
      currentLists(ctx.db),
      businessToday(ctx.db, ctx.now),
      // Only current lists' rows: a removed list's rows waiting for the removal's next pass are
      // no copy (stage 65 step 10).
      sql<Record<string, number>>`WITH current AS (
          SELECT id FROM core_outside_list WHERE state = 'current'
        ) SELECT
        (SELECT count(*) FROM core_outside_person WHERE list_id IN current) AS people,
        (SELECT count(*) FROM core_outside_membership WHERE list_id IN current) AS memberships,
        (SELECT count(*) FROM core_outside_class WHERE list_id IN current) AS classes,
        (SELECT count(*) FROM core_outside_booking WHERE list_id IN current) AS bookings,
        (SELECT count(*) FROM core_outside_staff WHERE list_id IN current) AS staff,
        (SELECT count(*) FROM core_outside_staff s JOIN core_user u ON u.id = s.user_id
          AND u.deactivated_at IS NULL WHERE s.list_id IN current) AS staffLinked,
        (SELECT count(*) FROM core_outside_match m JOIN core_outside_person o ON o.ref = m.ref
          WHERE m.kind = 'person' AND o.list_id IN current) AS waitingPeople,
        (SELECT count(*) FROM core_outside_match m JOIN core_outside_staff s ON s.ref = m.ref
          WHERE m.kind = 'staff' AND s.list_id IN current) AS waitingStaff`.execute(ctx.db),
      // Linked to a live Person: a link to one in the Trash, erased or merged away is no link.
      ctx.db
        .selectFrom("core_outside_person as o")
        .innerJoin(visibleTable(ctx, "person", "p"), "p.id", "o.person_id")
        .where("p.deleted_at", "is", null)
        .where(onCurrentList("o.list_id"))
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .executeTakeFirst(),
    ]);
    const loaders = [...new Set([...lists.values()].map((l) => l.loaded_by))];
    const names = loaders.length
      ? new Map(
          (
            await ctx.db
              .selectFrom("core_user")
              .select(["id", "name"])
              .where("id", "in", loaders)
              .execute()
          ).map((u) => [u.id, u.name]),
        )
      : new Map<string, string>();
    const row = counts.rows[0] ?? {};
    const n = (k: string) => Number(row[k] ?? 0);
    return {
      enabled: settings.enabled,
      largestAgeDays: settings.largestAgeDays,
      today,
      lists: LIST_KINDS.flatMap((kind) => {
        const list = lists.get(kind);
        if (!list) return [];
        const age = listAge(list.exported_on, today, settings.largestAgeDays);
        return [
          {
            kind,
            exportedOn: list.exported_on,
            loadedAt: list.loaded_at,
            loadedBy: list.loaded_by,
            loadedByName: names.get(list.loaded_by) ?? null,
            rows: list.row_count,
            refused: list.refused_count,
            kept: list.kept_count,
            ageDays: age.days,
            countsUntil: age.countsUntil,
            tooOld: kind === "members" && age.tooOld,
          },
        ];
      }),
      counts: {
        people: n("people"),
        linked: Number(linkedRow?.n ?? 0),
        memberships: n("memberships"),
        classes: n("classes"),
        bookings: n("bookings"),
        staff: n("staff"),
        staffLinked: n("staffLinked"),
        waitingPeople: n("waitingPeople"),
        waitingStaff: n("waitingStaff"),
      },
    };
  },
});

const MATCHES_PAGE = 50;

export const outsideMatches = defineOperation({
  name: "outside.matches",
  description:
    "To match: the outside people and coaches the host could not link by address, each with why " +
    "(several_people: more than one Person or staff account has the address; shared_address: " +
    "several outside people share it, as a family on one mailbox; no_address: the list gives " +
    "none) and the candidates (Persons, or staff accounts) to choose from. Nobody is linked until " +
    "a person links them with outside.link. Paged by ref. Needs bookingSystem:manage.",
  input: z.object({
    kind: z.enum(["person", "staff"]).optional().describe("Only people, or only coaches"),
    after: z.string().max(700).optional().describe("The `next` of the page before"),
    limit: z.number().int().min(1).max(MATCHES_PAGE).optional(),
  }),
  output: z.object({
    matches: z.array(
      z.object({
        kind: z.enum(["person", "staff"]),
        ref: z.string(),
        name: z.string(),
        address: z.string().nullable(),
        why: z.enum(["several_people", "shared_address", "no_address"]),
        candidates: z.array(z.object({ id: z.string(), name: z.string() })),
        since: z.string(),
      }),
    ),
    next: z.string().nullable(),
  }),
  permission: "bookingSystem:manage",
  risk: "read",
  async handler(input, ctx) {
    const limit = input.limit ?? MATCHES_PAGE;
    let query = ctx.db
      .selectFrom("core_outside_match as m")
      .leftJoin("core_outside_person as o", (j) =>
        j.onRef("o.ref", "=", "m.ref").on("m.kind", "=", "person"),
      )
      .leftJoin("core_outside_staff as s", (j) =>
        j.onRef("s.ref", "=", "m.ref").on("m.kind", "=", "staff"),
      )
      .select([
        "m.kind",
        "m.ref",
        "m.why",
        "m.candidates",
        "m.created_at",
        "o.given_name",
        "o.family_name",
        "o.address as personAddress",
        "s.display_name",
        "s.address as staffAddress",
      ])
      // None of a removed list's rows waiting for removal: they are no copy.
      .where((eb) =>
        eb.or([
          sql<SqlBool>`coalesce(o.list_id, s.list_id) IS NULL`,
          onCurrentList("o.list_id"),
          onCurrentList("s.list_id"),
        ]),
      )
      .orderBy("m.kind")
      .orderBy("m.ref")
      .limit(limit + 1);
    if (input.kind) query = query.where("m.kind", "=", input.kind);
    if (input.after !== undefined) {
      // The cursor is the last row's kind and ref: a person and a coach may share a ref.
      const at = input.after.indexOf(":");
      const kind = input.after.slice(0, at);
      const after = input.after.slice(at + 1);
      if (at < 0 || (kind !== "person" && kind !== "staff")) {
        throw new ValidationError("Not a cursor of outside.matches.", { field: "after" });
      }
      query = query.where((eb) =>
        eb.or([
          eb("m.kind", ">", kind),
          eb.and([eb("m.kind", "=", kind), eb("m.ref", ">", after)]),
        ]),
      );
    }
    const rows = await query.execute();
    const page = rows.slice(0, limit);
    const parsed = page.map((r) => {
      let ids: string[] = [];
      try {
        const value = JSON.parse(r.candidates) as unknown;
        if (Array.isArray(value)) ids = value.filter((v): v is string => typeof v === "string");
      } catch {
        ids = [];
      }
      return { row: r, ids };
    });
    const personIds = [
      ...new Set(parsed.filter((p) => p.row.kind === "person").flatMap((p) => p.ids)),
    ];
    const userIds = [
      ...new Set(parsed.filter((p) => p.row.kind === "staff").flatMap((p) => p.ids)),
    ];
    const [people, users] = await Promise.all([
      personIds.length
        ? ctx.db
            .selectFrom(visibleTable(ctx, "person"))
            .select(["id", "display_name as name"])
            .where("id", "in", personIds)
            .where("deleted_at", "is", null)
            .execute()
        : [],
      userIds.length
        ? ctx.db.selectFrom("core_user").select(["id", "name"]).where("id", "in", userIds).execute()
        : [],
    ]);
    const names = new Map([...people, ...users].map((r) => [r.id, r.name]));
    return {
      matches: parsed.map(({ row, ids }) => ({
        kind: row.kind,
        ref: row.ref,
        name:
          row.kind === "person"
            ? [row.given_name, row.family_name].filter(Boolean).join(" ") || row.ref
            : (row.display_name ?? row.ref),
        address: (row.kind === "person" ? row.personAddress : row.staffAddress) ?? null,
        why: row.why,
        candidates: ids.flatMap((id) => {
          const name = names.get(id);
          return name === undefined ? [] : [{ id, name }];
        }),
        since: row.created_at,
      })),
      next: rows.length > limit && page.length ? `${page.at(-1)?.kind}:${page.at(-1)?.ref}` : null,
    };
  },
});

async function assertOutsideRow(ctx: HandlerContext, kind: "person" | "staff", ref: string) {
  const row =
    kind === "person"
      ? await ctx.db
          .selectFrom("core_outside_person")
          .select("ref")
          .where("ref", "=", ref)
          .where(onCurrentList("list_id"))
          .executeTakeFirst()
      : await ctx.db
          .selectFrom("core_outside_staff")
          .select("ref")
          .where("ref", "=", ref)
          .where(onCurrentList("list_id"))
          .executeTakeFirst();
  if (!row) {
    throw new ValidationError(
      kind === "person"
        ? "Nobody with that ref is in the current members list."
        : "No coach with that ref is in the current timetable list.",
      { field: "ref", rule: "outside_not_listed" },
    );
  }
}

/**
 * An erased Person's outside ref or address never links again, by hand either (stage 65 step 10):
 * a load keeps no row of theirs, and this holds should one be there by any other way.
 */
async function assertNotSuppressed(ctx: HandlerContext, kind: "person" | "staff", ref: string) {
  const row =
    kind === "person"
      ? await ctx.db
          .selectFrom("core_outside_person")
          .select("address")
          .where("ref", "=", ref)
          .executeTakeFirst()
      : await ctx.db
          .selectFrom("core_outside_staff")
          .select("address")
          .where("ref", "=", ref)
          .executeTakeFirst();
  const dropped = await droppedOf(ctx.db, [ref], row?.address ? [row.address] : [], kind);
  if (dropped.refs.size || dropped.addresses.size) {
    throw new ValidationError(
      "This outside record is of an erased person: it is never linked again.",
      { field: "ref", rule: "outside_erased" },
    );
  }
}

const linkInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("person"),
    ref,
    personId: z.string().min(1).describe("The Person (per_…) they are"),
    why,
  }),
  z.object({
    kind: z.literal("staff"),
    ref,
    userId: z.string().min(1).describe("The staff account (usr_…) the coach is"),
    why,
  }),
]);

export const outsideLink = defineOperation({
  name: "outside.link",
  description:
    "Link an outside person from the members list to a Person, or a coach from the timetable list " +
    "to a staff account, by hand, with why. A link made by a person is kept across loads by ref, " +
    "whatever the address. It changes nothing on the Person: no name, address or phone, no " +
    "customer account, nothing sent. Removes them from To match. A person with " +
    "bookingSystem:manage only, never an AI.",
  input: linkInput,
  output: z.object({ kind: z.enum(["person", "staff"]), linkedTo: z.string() }),
  permission: "bookingSystem:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  // A ref may be the address itself (a list with no ids of its own): never in the audit log.
  redact: ["ref"],
  auditSummary: (output) => ({ kind: output.kind, linkedTo: output.linkedTo }),
  async handler(input, ctx) {
    await assertOutsideRow(ctx, input.kind, input.ref);
    await assertNotSuppressed(ctx, input.kind, input.ref);
    const set = { link_how: "staff" as const, link_by: ctx.user.id, link_why: input.why };
    if (input.kind === "person") {
      const person = await ctx.db
        .selectFrom(visibleTable(ctx, "person"))
        .select("id")
        .where("id", "=", input.personId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!person) {
        throw new ValidationError("No live Person with that id.", {
          field: "personId",
          rule: "outside_no_person",
        });
      }
      ctx.write(
        ctx.db
          .updateTable("core_outside_person")
          .set({ ...set, person_id: person.id, linked_at: ctx.now })
          .where("ref", "=", input.ref),
      );
      ctx.postActivity({
        subject: LINK_SUBJECT,
        payload: { kind: "outside_link", how: "staff" },
        links: [{ object: "person", id: person.id }],
      });
    } else {
      const user = await ctx.db
        .selectFrom("core_user")
        .select("id")
        .where("id", "=", input.userId)
        .where("kind", "=", "human")
        .where("deactivated_at", "is", null)
        .executeTakeFirst();
      if (!user) {
        throw new ValidationError("No active staff account with that id.", {
          field: "userId",
          rule: "outside_no_user",
        });
      }
      ctx.write(
        ctx.db
          .updateTable("core_outside_staff")
          .set({ ...set, user_id: user.id, linked_at: ctx.now })
          .where("ref", "=", input.ref),
      );
    }
    ctx.write(
      ctx.db
        .deleteFrom("core_outside_match")
        .where("kind", "=", input.kind)
        .where("ref", "=", input.ref),
      ctx.db
        .deleteFrom("core_outside_unlinked")
        .where("kind", "=", input.kind)
        .where("hash", "=", await outsideRefHash(ctx.db, input.kind, input.ref)),
    );
    return {
      kind: input.kind,
      linkedTo: input.kind === "person" ? input.personId : input.userId,
    };
  },
});

export const outsideUnlink = defineOperation({
  name: "outside.unlink",
  description:
    "Unlink an outside person or coach, with why: they stay in the copy linked to nobody while " +
    "they count (a member, a live pass, booked), and the host never links them by address again " +
    "(the decision is kept by ref across loads) until a person links them with outside.link. " +
    "Removes them from To match. A person with bookingSystem:manage only, never an AI.",
  input: z.object({ kind: z.enum(["person", "staff"]), ref, why }),
  output: z.object({ kind: z.enum(["person", "staff"]), unlinked: z.boolean() }),
  permission: "bookingSystem:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  redact: ["ref"],
  auditSummary: (output) => output,
  async handler(input, ctx) {
    await assertOutsideRow(ctx, input.kind, input.ref);
    const set = {
      link_how: "staff" as const,
      link_by: ctx.user.id,
      link_why: input.why,
      linked_at: ctx.now,
    };
    ctx.write(
      input.kind === "person"
        ? ctx.db
            .updateTable("core_outside_person")
            .set({ ...set, person_id: null })
            .where("ref", "=", input.ref)
        : ctx.db
            .updateTable("core_outside_staff")
            .set({ ...set, user_id: null })
            .where("ref", "=", input.ref),
      ctx.db
        .deleteFrom("core_outside_match")
        .where("kind", "=", input.kind)
        .where("ref", "=", input.ref),
      // The decision itself, by hash: it outlives the row, which is kept only while they count.
      ctx.db
        .insertInto("core_outside_unlinked")
        .values({
          kind: input.kind,
          hash: await outsideRefHash(ctx.db, input.kind, input.ref),
          unlinked_by: ctx.user.id,
          unlinked_at: ctx.now,
        })
        .onConflict((oc) =>
          oc
            .columns(["kind", "hash"])
            .doUpdateSet({ unlinked_by: ctx.user.id, unlinked_at: ctx.now }),
        ),
    );
    return { kind: input.kind, unlinked: true };
  },
});

export const outsideListsRemove = defineOperation({
  name: "outside.lists.remove",
  description:
    "Remove the booking system's copy: the current members list (its outside people, their " +
    "memberships and passes, membership types, links and To match), the timetable list (classes, " +
    "class types, bookings, coaches and their To match), or all of it, which is what " +
    "disconnecting the booking system means for a loaded list. The list stops counting at once " +
    `and its rows are deleted at once, ${REMOVE_PASS_ROWS} a statement and at most ` +
    `${REMOVE_MAX_STATEMENTS * REMOVE_PASS_ROWS} a call: when done is false, the daily maintenance ` +
    "finishes the rest, or call again with finish: true (nothing reads it meanwhile, and a list " +
    "loaded since is never touched). Kept: the settings, the lists' log (counts only, 30 " +
    "days), erased people's suppressions (so no later list brings them back), staff's unlink " +
    "decisions (a hash, no person) and the timeline. Nothing is written to the booking system. A " +
    "person with bookingSystem:manage only, never an AI, an MCP client, an extension or an " +
    "automation.",
  input: z.object({
    kind: z
      .enum([...LIST_KINDS, "all"])
      .describe("members, timetable, or all (disconnect the booking system's lists)"),
    finish: z
      .boolean()
      .optional()
      .describe(
        "Only finish a removal already made (after done: false): removes no current list, so a list loaded since stays",
      ),
  }),
  output: z.object({
    removed: z.array(z.enum(LIST_KINDS)).describe("The kinds whose current list was removed"),
    rows: z.number().int().describe("Rows of the copy deleted by this call"),
    remaining: z.number().int().describe("Rows left for the next call; 0 when done"),
    done: z.boolean(),
  }),
  permission: "bookingSystem:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  auditSummary: (output) => output,
  async handler(input, ctx) {
    const kinds = input.kind === "all" ? [...LIST_KINDS] : [input.kind];
    const plan = await planRemoval(ctx.db, kinds, ctx.now, { markLists: !input.finish });
    if (plan.statements.length) ctx.write(...plan.statements);
    return {
      removed: plan.lists,
      rows: plan.rows,
      remaining: plan.remaining,
      done: plan.remaining === 0,
    };
  },
});

export const outsideSuppressionLift = defineOperation({
  name: "outside.suppression.lift",
  description:
    "Lift the suppression of an outside ref an erase left: when the booking system has given an " +
    "erased person's old ref to someone new, every load drops that ref (counted as previously " +
    "erased) until a person lifts it. The new person is then kept and matched as anyone is. The " +
    "erased person's addresses stay suppressed. This undoes an erase's protection for that ref: " +
    "if the booking system still lists the erased person under it, they come back. Needs both " +
    "bookingSystem:manage and records:erase (the erase's own permission), a person only, never " +
    "an AI, an MCP client, an extension or an automation.",
  input: z.object({ kind: z.enum(["person", "staff"]), ref, why }),
  output: z.object({ lifted: z.boolean() }),
  permission: "bookingSystem:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  // A ref may be the address itself (a list with no ids of its own): never in the audit log.
  redact: ["ref"],
  auditSummary: (output) => output,
  async handler(input, ctx) {
    // It undoes an erase's protection: the erase's permission too, as erasure.allowAddress takes.
    if (!holdsPermission(ctx.user, ctx.permissionGrants, "records:erase")) {
      throw new ForbiddenError("Lifting an erase's suppression needs records:erase", {
        permission: "records:erase",
      });
    }
    const hash = await outsideRefHash(ctx.db, input.kind, input.ref);
    const row = await ctx.db
      .selectFrom("core_outside_suppressed")
      .select("hash")
      .where("kind", "=", "ref")
      .where("hash", "=", hash)
      .executeTakeFirst();
    if (!row) return { lifted: false };
    // Kept in the erase log, so a re-apply after a restore keeps the decision.
    if (ctx.blobs && !ctx.simulation) {
      await putEraseLog(ctx.blobs, {
        v: 1,
        kind: "allow",
        at: ctx.now,
        addresses: [],
        outside: [{ hash, kind: "ref" }],
      });
    }
    ctx.write(
      ctx.db.deleteFrom("core_outside_suppressed").where("hash", "=", hash),
      ctx.db.deleteFrom("core_outside_suppressed_erase").where("hash", "=", hash),
    );
    return { lifted: true };
  },
});

// --- The file source (stage 65 step 4, ADR 0923). ----------------------------------------------

const valueWords = z.record(z.string().min(1).max(MAX_VALUE_WORD), z.string().min(1).max(40));

const fileMappingSchema = z.object({
  columns: z
    .record(z.string().min(1).max(40), z.string().min(1).max(200))
    .describe('Field → the column header that holds it, e.g. { email: "E-mail" }'),
  values: z
    .record(z.string().min(1).max(40), valueWords)
    .optional()
    .describe(
      "The export's own words for values, per value map: members' memberStatus, membershipStatus, membershipKind, membershipType (a plan's name → membership or pass); timetable's bookingState",
    ),
  dateFormat: z.enum(DATE_FORMATS).optional(),
});

const fileInput = z.object({
  kind: z
    .enum(LIST_KINDS)
    .describe("members (people and their memberships and passes) or timetable"),
  file: z
    .string()
    .min(1)
    .max(MAX_FILE_BASE64 + 4)
    .describe(
      "The exported file's bytes, base64 (at most 10 MB): CSV, semicolon or tab separated, in UTF-8, UTF-16 or Windows-1252, read by its content",
    ),
  mapping: fileMappingSchema
    .optional()
    .describe("Omit to use the saved mapping (when the file has its columns) or the suggestion"),
  exportedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("The date the file was exported (what the list's age counts from); default today"),
});

const changesSchema = z.object({
  new: z.number().int(),
  changed: z.number().int(),
  unchanged: z.number().int(),
  removed: z.number().int().describe("In the current list and not in this file: they go"),
});

const outcomeSchema = z.object({
  changes: changesSchema.describe(
    "People (members) or classes (timetable) against the current list",
  ),
  kept: z.number().int(),
  notKept: z.number().int().describe("Not a member, no live pass, not booked, not staff-linked"),
  dropped: z.number().int().describe("Of an erased person: nothing of them is kept"),
  previouslyErased: z.number().int().describe("Of those, dropped by a ref an erase suppressed"),
  linked: z.number().int(),
  links: z.number().int(),
  toMatch: z.number().int(),
  unlinked: z.number().int(),
  items: z.record(z.string(), z.number().int()),
});

const mappingOut = z.object({
  columns: z.record(z.string(), z.string()),
  values: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  dateFormat: z.enum(DATE_FORMATS).optional(),
});

function fileOf(input: {
  kind: ListKind;
  file: string;
  mapping?: FileMapping;
  exportedOn?: string;
}) {
  return {
    kind: input.kind,
    bytes: fileBytes(input.file),
    ...(input.mapping ? { mapping: input.mapping } : {}),
    ...(input.exportedOn ? { exportedOn: input.exportedOn } : {}),
  };
}

export const outsideFilePreview = defineOperation({
  name: "outside.file.preview",
  description:
    "The dry run of a list exported from the booking system: decodes the file by its content, " +
    "maps its columns (the given mapping, else the saved one, else a suggestion from the headers), " +
    "and says what the load would do against the current list (new, changed, unchanged, removed; " +
    "not kept; dropped because the person was erased; who would link by address and who would " +
    "wait in To match) and every refused row with why. Writes nothing and keeps nothing of the " +
    "file. Pass its fingerprint, with the same file, mapping and export date, to outside.file.load. " +
    "A person with bookingSystem:manage only, never an AI.",
  input: fileInput,
  output: z.object({
    kind: z.enum(LIST_KINDS),
    ready: z.boolean().describe("False when a required field has no column: map it and ask again"),
    missing: z.array(z.string()),
    headers: z.array(z.string()),
    mapping: mappingOut,
    mappingFrom: z.enum(["given", "saved", "suggested"]),
    suggested: mappingOut,
    encoding: z.enum(["utf-8", "utf-16le", "utf-16be", "windows-1252"]),
    exportedOn: z.string(),
    rows: z.object({ read: z.number().int(), refused: z.number().int() }),
    issueCount: z.number().int(),
    issues: z.array(
      z.object({
        file: z.enum(["people", "timetable"]),
        row: z.number().int(),
        column: z.string().optional(),
        problem: z.string(),
      }),
    ),
    formulaLike: z.number().int().describe("Cells kept as text that start as a formula would"),
    outcome: outcomeSchema,
    linking: z.array(z.object({ ref: z.string(), name: z.string(), to: z.string() })),
    waiting: z.array(z.object({ ref: z.string(), name: z.string(), why: z.string() })),
    statements: z.number().int(),
    fingerprint: z.string(),
  }),
  permission: "bookingSystem:manage",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  redact: ["file"],
  auditSummary: (output) => ({ kind: output.kind, rows: output.rows, ready: output.ready }),
  async handler(input, ctx) {
    const { preview } = await planFile(ctx.db, fileOf(input), {
      userId: ctx.user.id,
      now: ctx.now,
    });
    return preview;
  },
});

export const outsideFileLoad = defineOperation({
  name: "outside.file.load",
  description:
    "Load a list exported from the booking system, as its dry run showed: the same file, mapping " +
    "and export date, and the dry run's fingerprint. The host plans again and refuses, writing " +
    "nothing, unless the plan is the one the dry run showed (the file, the copy, an erase or a " +
    "Person's address changed since). The list replaces the current one of its kind in one " +
    "batch: rows not in the new file go, with their links and matches; nothing of an erased " +
    "person is kept. The mapping is saved for the next export of the same shape. The file itself " +
    "is not kept; the audit records counts only. A person with bookingSystem:manage only, never an " +
    "AI, an MCP client, Code Mode, an extension or an automation.",
  input: fileInput.extend({
    fingerprint: z.string().min(1).max(200).describe("The dry run's fingerprint"),
    saveMapping: z.boolean().optional().describe("Default true: save the mapping for next time"),
  }),
  output: z.object({
    kind: z.enum(LIST_KINDS),
    exportedOn: z.string(),
    rows: z.object({ read: z.number().int(), refused: z.number().int() }),
    issueCount: z.number().int(),
    outcome: outcomeSchema,
  }),
  permission: "bookingSystem:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  redact: ["file"],
  auditSummary: (output) => output,
  async handler(input, ctx) {
    const { plan, preview } = await planFile(ctx.db, fileOf(input), {
      userId: ctx.user.id,
      now: ctx.now,
    });
    if (!plan || !preview.ready) {
      throw new ValidationError(`No column is mapped to: ${preview.missing.join(", ")}.`, {
        field: "mapping",
        rule: "outside_mapping",
      });
    }
    if (preview.fingerprint !== input.fingerprint) {
      throw new ConflictError(
        "The file, its mapping or the booking system's copy changed since the dry run (another list was loaded, someone was erased, a Person's address changed): nothing was loaded. Run the dry run again.",
        { rule: "outside_preview_stale" },
      );
    }
    ctx.write(...plan.statements);
    if (input.saveMapping !== false)
      ctx.write(saveMappingStatement(input.kind, preview.mapping, preview.headers));
    return {
      kind: input.kind,
      exportedOn: preview.exportedOn,
      rows: preview.rows,
      issueCount: preview.issueCount,
      outcome: preview.outcome,
    };
  },
});

export const outsideOperations = [
  outsideSettingsGet,
  outsideSettingsUpdate,
  outsideStatus,
  outsideMatches,
  outsideLink,
  outsideUnlink,
  outsideListsRemove,
  outsideSuppressionLift,
  outsideFilePreview,
  outsideFileLoad,
];
