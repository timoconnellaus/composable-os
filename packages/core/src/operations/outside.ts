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
//
// Loading a list (`outside.file.preview`, `outside.file.load`) and removing one are step 4's; they
// plan through `outside/ingest.ts`. None of these writes to the booking system, a Person's fields,
// an order, a membership or booking here, or an allowance. Linking and the settings are a person's
// at the screen (`actors: ["human"]`, never MCP, Code Mode, an extension or an automation): who is
// a member decides prices and what a customer may open. An AI may read the lists' state and To
// match for an account that holds bookingSystem:manage, to explain them.
import { sql } from "kysely";
import { z } from "zod";
import { ValidationError } from "../errors.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { LINK_SUBJECT } from "../outside/match.ts";
import {
  businessToday,
  currentLists,
  LIST_KINDS,
  listAge,
  loadOutsideSettings,
  MAX_LARGEST_AGE_DAYS,
} from "../outside/settings.ts";
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
  output: settingsSchema.extend({ types: z.array(typeSchema) }),
  permission: "bookingSystem:manage",
  risk: "read",
  mcp: { title: "Booking system settings" },
  async handler(_input, ctx) {
    const settings = await loadOutsideSettings(ctx.db);
    const types = await ctx.db
      .selectFrom("core_outside_membership_type")
      .select(["ref", "name", "kind", "active"])
      .orderBy("kind")
      .orderBy("name")
      .execute();
    const { updatedBy: _by, ...rest } = settings;
    return {
      ...rest,
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
    const [settings, lists, today, counts] = await Promise.all([
      loadOutsideSettings(ctx.db),
      currentLists(ctx.db),
      businessToday(ctx.db, ctx.now),
      sql<Record<string, number>>`SELECT
        (SELECT count(*) FROM core_outside_person) AS people,
        (SELECT count(*) FROM core_outside_person WHERE person_id IS NOT NULL) AS linked,
        (SELECT count(*) FROM core_outside_membership) AS memberships,
        (SELECT count(*) FROM core_outside_class) AS classes,
        (SELECT count(*) FROM core_outside_booking) AS bookings,
        (SELECT count(*) FROM core_outside_staff) AS staff,
        (SELECT count(*) FROM core_outside_staff WHERE user_id IS NOT NULL) AS staffLinked,
        (SELECT count(*) FROM core_outside_match WHERE kind = 'person') AS waitingPeople,
        (SELECT count(*) FROM core_outside_match WHERE kind = 'staff') AS waitingStaff`.execute(
        ctx.db,
      ),
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
        linked: n("linked"),
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
    after: z.string().max(600).optional().describe("The last ref of the page before"),
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
      .orderBy("m.ref")
      .orderBy("m.kind")
      .limit(limit + 1);
    if (input.kind) query = query.where("m.kind", "=", input.kind);
    if (input.after !== undefined) query = query.where("m.ref", ">", input.after);
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
      next: rows.length > limit ? (page.at(-1)?.ref ?? null) : null,
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
          .executeTakeFirst()
      : await ctx.db
          .selectFrom("core_outside_staff")
          .select("ref")
          .where("ref", "=", ref)
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
    "Unlink an outside person or coach, with why: they stay in the copy linked to nobody, and the " +
    "host never links them by address again (a load keeps the unlink by ref) until a person links " +
    "them with outside.link. Removes them from To match. A person with bookingSystem:manage only, " +
    "never an AI.",
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
    );
    return { kind: input.kind, unlinked: true };
  },
});

export const outsideOperations = [
  outsideSettingsGet,
  outsideSettingsUpdate,
  outsideStatus,
  outsideMatches,
  outsideLink,
  outsideUnlink,
];
