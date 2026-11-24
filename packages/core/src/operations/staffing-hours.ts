// Open hours (stage 49 step 3, ADR 0762): when someone takes appointments, week by week, with extra
// hours on a date, optionally for some kinds of work only. Tool-only, as the roster's operations
// are (ADR 0625): called from a shipped pack's tool run for the staff account the pipeline
// verified as its caller. Set by the person themselves or by someone who rosters, for anyone
// (decision 9); an AI's change waits for a person (the calling tool must ask one). Time off stays
// `staffing.away`: a one-off "not open" is never an entry here. Free times (step 4) read these.
import type { CoreStaffHoursTable } from "@composable-os/db";
import { sql } from "kysely";
import { z } from "zod";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { objectTableOf } from "../extensions/schema.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { isTimezone, loadGeneralSettings } from "../settings.ts";
import { HOURS_MAX, type KindRef, onlyForOf, WEEKDAYS } from "../staffing/hours.ts";
import { actingAccount, mayRoster } from "../staffing/rosterers.ts";
import { namesOf } from "../staffing/sets.ts";
import { localParts } from "../time/local.ts";
import {
  accountId,
  assertPersonApplies,
  assertRosterer,
  assertShippedToolRun,
  instantOf,
  localDate,
  localDateTime,
  localTime,
  requireAccount,
  requireKindObject,
} from "./staffing.ts";

const kindRef = z.object({ object: z.string().min(1).max(81), id: z.string().min(1).max(64) });

/** The longest extra hours one entry gives: hours on a date, overnight at most. */
const EXTRA_MAX_SECONDS = 24 * 3600;

const hoursSchema = z.object({
  id: z.string(),
  account: z.string(),
  name: z.string(),
  kind: z.enum(["weekly", "extra"]),
  weekdays: z.array(z.string()),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  fromDate: z.string().nullable(),
  untilDate: z.string().nullable(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  zone: z.string(),
  /** The kinds of work it is open for; empty: every kind. */
  onlyFor: z.array(z.object({ object: z.string(), id: z.string() })),
});
type HoursItem = z.infer<typeof hoursSchema>;

/** Whose hours a call is about: the caller's own, or anyone's for someone who rosters. */
async function hoursAccount(
  ctx: HandlerContext,
  account: string | undefined,
  what: string,
): Promise<string> {
  const target = account ?? actingAccount(ctx);
  if (target !== actingAccount(ctx)) await assertRosterer(ctx, what);
  return target;
}

/** An entry the caller may change: their own, or anyone's for someone who rosters; else not found. */
async function ownedEntry(ctx: HandlerContext, id: string) {
  const row = await ctx.db
    .selectFrom("core_staff_hours")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row || (row.account_id !== actingAccount(ctx) && !(await mayRoster(ctx)))) {
    throw new NotFoundError("open hours", id);
  }
  return row;
}

/** Each kind is a kind of work some shift is of, and a record of it that is not in the Trash. */
async function requireKinds(ctx: HandlerContext, kinds: readonly KindRef[]): Promise<void> {
  const byObject = new Map<string, string[]>();
  for (const k of kinds) byObject.set(k.object, [...(byObject.get(k.object) ?? []), k.id]);
  for (const [object, ids] of byObject) {
    requireKindObject(object);
    const table = objectTableOf(object);
    if (!table) throw new NotFoundError(object, ids[0] as string);
    const found = await sql<{
      id: string;
    }>`SELECT id FROM ${sql.table(table)} WHERE id IN ${jsonList(
      ids,
    )} AND deleted_at IS NULL`.execute(ctx.db);
    const have = new Set(found.rows.map((r) => r.id));
    const missing = ids.find((id) => !have.has(id));
    if (missing) throw new NotFoundError(object, missing);
  }
}

function itemOf(r: Omit<CoreStaffHoursTable, "set_by" | "set_at">, name: string): HoursItem {
  return {
    id: r.id,
    account: r.account_id,
    name,
    kind: r.kind,
    weekdays: r.weekdays ? r.weekdays.split(",") : [],
    startTime: r.start_time,
    endTime: r.end_time,
    fromDate: r.from_date,
    untilDate: r.until_date,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    zone: r.zone,
    onlyFor: onlyForOf(r) ?? [],
  };
}

export const staffingHoursSet = defineOperation({
  name: "staffing.hours.set",
  description:
    "Tool-only (a shipped pack's tool): say when someone takes appointments. Weekly open hours " +
    "(kind weekly: weekdays, a local startTime and endTime, from fromDate, default today, until " +
    "untilDate; an end at or before the start runs overnight), or extra hours on a date (kind " +
    "extra: startsAt and endsAt, local date-times in zone, at most 24 hours). onlyFor limits it " +
    "to some kinds of work (a service); left out, it is open for every kind. Give id to change " +
    "an entry instead of adding one. Their own, or anyone's for someone who rosters; an AI's " +
    "change waits for a person. Time off is staffing.away, not this. At most 50 entries a " +
    "person. Returns the entry.",
  input: z.object({
    id: z.string().min(1).max(64).optional().describe("An entry to change; leave out to add one"),
    account: accountId.optional().describe("Whose; leave out for your own"),
    kind: z.enum(["weekly", "extra"]),
    weekdays: z.array(z.enum(WEEKDAYS)).min(1).max(7).optional(),
    startTime: localTime.optional(),
    endTime: localTime.optional(),
    fromDate: localDate.optional(),
    untilDate: localDate.optional(),
    startsAt: localDateTime.optional(),
    endsAt: localDateTime.optional(),
    onlyFor: z.array(kindRef).max(20).optional().describe("Kinds of work only; empty: every kind"),
    zone: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("IANA zone; the organisation's if left out"),
  }),
  output: z.object({ id: z.string(), item: hoursSchema }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  auditSummary: (output) => ({ id: output.id, account: output.item.account }),
  async handler(input, ctx) {
    await assertShippedToolRun(ctx, "staffing.hours.set");
    assertPersonApplies(ctx, "Setting open hours");
    const existing = input.id ? await ownedEntry(ctx, input.id) : null;
    if (existing && input.account && input.account !== existing.account_id) {
      throw new ValidationError("An entry stays with whoever it is for", { field: "account" });
    }
    const account =
      existing?.account_id ??
      (await hoursAccount(ctx, input.account, "set someone else's open hours"));
    await requireAccount(ctx, account);
    const zone = input.zone ?? (await loadGeneralSettings(ctx.db)).timezone;
    if (!isTimezone(zone))
      throw new ValidationError(`${zone} is not a time zone`, { field: "zone" });
    if (input.onlyFor?.length) await requireKinds(ctx, input.onlyFor);
    if (!existing) {
      const held = await ctx.db
        .selectFrom("core_staff_hours")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("account_id", "=", account)
        .executeTakeFirst();
      if (Number(held?.n ?? 0) >= HOURS_MAX) {
        throw new ConflictError(
          `Someone holds at most ${HOURS_MAX} open-hours entries. Change or remove one first.`,
          { rule: "hours_too_many", max: HOURS_MAX },
        );
      }
    }
    let row: Pick<
      CoreStaffHoursTable,
      "weekdays" | "start_time" | "end_time" | "from_date" | "until_date" | "starts_at" | "ends_at"
    >;
    if (input.kind === "weekly") {
      if (!input.weekdays || !input.startTime || !input.endTime) {
        throw new ValidationError("Weekly open hours need weekdays, a start time and an end time", {
          field: "weekdays",
        });
      }
      if (input.startsAt || input.endsAt) {
        throw new ValidationError("Weekly open hours have no one-off start or end", {
          field: "startsAt",
        });
      }
      const fromDate = input.fromDate ?? localParts(ctx.now, zone).date;
      if (input.untilDate && input.untilDate < fromDate) {
        throw new ValidationError("They must end on or after their first date", {
          field: "untilDate",
        });
      }
      row = {
        weekdays: WEEKDAYS.filter((d) => input.weekdays?.includes(d)).join(","),
        start_time: input.startTime,
        end_time: input.endTime,
        from_date: fromDate,
        until_date: input.untilDate ?? null,
        starts_at: null,
        ends_at: null,
      };
    } else {
      if (!input.startsAt || !input.endsAt) {
        throw new ValidationError("Extra hours need a start and an end", { field: "startsAt" });
      }
      if (input.weekdays || input.startTime || input.endTime || input.fromDate || input.untilDate) {
        throw new ValidationError("Extra hours have no weekdays, times of day or dates", {
          field: "weekdays",
        });
      }
      const starts = instantOf(input.startsAt, zone);
      const ends = instantOf(input.endsAt, zone);
      if (!(ends > starts)) {
        throw new ValidationError("They must end after they start", { field: "endsAt" });
      }
      if (ends - starts > EXTRA_MAX_SECONDS) {
        throw new ValidationError(
          "Extra hours are at most 24 hours; for more, add weekly hours with first and last dates",
          { field: "endsAt" },
        );
      }
      row = {
        weekdays: null,
        start_time: null,
        end_time: null,
        from_date: null,
        until_date: null,
        starts_at: new Date(starts * 1000).toISOString(),
        ends_at: new Date(ends * 1000).toISOString(),
      };
    }
    const id = existing?.id ?? newId("staffHours");
    const values = {
      kind: input.kind,
      ...row,
      zone,
      only_for: input.onlyFor?.length ? JSON.stringify(input.onlyFor) : null,
      set_by: actingAccount(ctx),
      set_at: ctx.now,
    };
    if (existing) {
      ctx.write(ctx.db.updateTable("core_staff_hours").set(values).where("id", "=", id));
    } else {
      ctx.write(
        ctx.db.insertInto("core_staff_hours").values({ id, account_id: account, ...values }),
      );
    }
    const names = await namesOf(ctx, [account]);
    return { id, item: itemOf({ id, account_id: account, ...values }, names.get(account) ?? "") };
  },
});

export const staffingHoursClear = defineOperation({
  name: "staffing.hours.clear",
  description:
    "Tool-only (a shipped pack's tool): remove an open-hours entry (weekly or extra). Their own, " +
    "or anyone's for someone who rosters; an AI's removal waits for a person. Appointments " +
    "already booked stay. Returns its id.",
  input: z.object({ id: z.string().min(1).max(64) }),
  output: z.object({ id: z.string() }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    await assertShippedToolRun(ctx, "staffing.hours.clear");
    assertPersonApplies(ctx, "Removing open hours");
    await ownedEntry(ctx, input.id);
    ctx.write(ctx.db.deleteFrom("core_staff_hours").where("id", "=", input.id));
    return { id: input.id };
  },
});

export const staffingHoursList = defineOperation({
  name: "staffing.hours.list",
  description:
    "Tool-only (a shipped pack's tool): open hours, weekly and extra, that apply between from " +
    "and to (local dates; default from today). Your own; someone who rosters reads anyone's, or " +
    "everyone's when account is left out. Read-only.",
  input: z.object({
    account: accountId.optional(),
    from: localDate.optional(),
    to: localDate.optional(),
  }),
  output: z.object({ items: z.array(hoursSchema) }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    await assertShippedToolRun(ctx, "staffing.hours.list");
    // Left out: everyone's for someone who rosters, else the caller's own.
    let account = input.account;
    if (account === undefined) {
      if (!(await mayRoster(ctx))) account = actingAccount(ctx);
    } else if (account !== actingAccount(ctx)) {
      await assertRosterer(ctx, "read someone else's open hours");
    }
    const from = input.from ?? ctx.now.slice(0, 10);
    let query = ctx.db.selectFrom("core_staff_hours").selectAll();
    if (account !== undefined) query = query.where("account_id", "=", account);
    query = query.where((eb) =>
      eb.or([
        eb.and([eb("kind", "=", "extra"), eb("ends_at", ">=", from)]),
        eb.and([
          eb("kind", "=", "weekly"),
          eb.or([eb("until_date", "is", null), eb("until_date", ">=", from)]),
        ]),
      ]),
    );
    if (input.to) {
      const to = input.to;
      query = query.where((eb) =>
        eb.or([
          eb.and([eb("kind", "=", "extra"), eb("starts_at", "<=", `${to}T23:59:59.999Z`)]),
          eb.and([eb("kind", "=", "weekly"), eb("from_date", "<=", to)]),
        ]),
      );
    }
    const rows = await query
      .orderBy("account_id")
      .orderBy("kind", "desc")
      .orderBy("set_at")
      .limit(500)
      .execute();
    const names = await namesOf(
      ctx,
      rows.map((r) => r.account_id),
    );
    return { items: rows.map((r) => itemOf(r, names.get(r.account_id) ?? "")) };
  },
});

export const staffingHoursOperations = [
  staffingHoursSet,
  staffingHoursClear,
  staffingHoursList,
] as const;
