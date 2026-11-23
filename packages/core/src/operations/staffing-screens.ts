// What the roster's screens ask the host (stage 45 step 7): who is reading and what they may do,
// who could be put on a shift and why not, the people and the kinds of work for the
// qualifications grid, the regular patterns and changing one from a date, a shift back to its
// pattern, and the import's dry run of a pattern (`cos rostering import`). Tool-only, as every
// staffing operation (ADR 0621): called from a shipped pack's tool run, acting for the staff
// account the pipeline verified as the tool's caller (`ctx.extension.tool.calledBy`, ADR 0625).
//
// None of this moves a rule into a screen: a block shows what these answer. Who may roster, who
// handles pay, whether someone is qualified, away or free, and whether a pattern clashes are each
// decided here, by the same functions the writes use (staffing/index.ts, eligibility.ts,
// rosterers.ts), so what a screen shows before a write is what the write is made with.
import { WEEKDAYS as SDK_WEEKDAYS } from "@composable-os/sdk";
import { sql } from "kysely";
import { z } from "zod";
import { addDaysToDate } from "../automations/cron.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { objectTableOf } from "../extensions/schema.ts";
import { getObject, listObjects } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import {
  exceptionsOf,
  followSeries,
  occurrencesBetween,
  ruleOf,
  type SeriesRule,
} from "../recurring/index.ts";
import { isTimezone, loadGeneralSettings } from "../settings.ts";
import {
  awayOver,
  type Claim,
  checkShift,
  clashWith,
  described,
  kindObjectOf,
  noteClaim,
  personValueFor,
  qualified,
  warningsOf,
} from "../staffing/index.ts";
import { localDateOf } from "../staffing/pay.ts";
import {
  actingAccount,
  isPayer,
  mayRoster,
  rosterNumbers,
  staffName,
} from "../staffing/rosterers.ts";
import { parseLocalTime, wallClockOf, wallClockToInstant } from "../time/local.ts";
import { loadRecord, staffWarningSchema, updateRecord } from "./record.ts";
import {
  assertPersonApplies,
  assertRosterer,
  assertShippedToolRun,
  requireLiveShift,
} from "./staffing.ts";

const objectName = z.string().min(1).max(81);
const recordId = z.string().min(1).max(64);
const accountId = z.string().min(1).max(64);
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date, YYYY-MM-DD");
const localTime = z.string().regex(/^[0-2]\d:[0-5]\d$/, "a time, HH:MM");
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

// biome-ignore lint/suspicious/noExplicitAny: x_* tables are not in CoreDatabase; names come from the registry.
type AnyDb = import("kysely").Kysely<any>;

const nowSeconds = (ctx: HandlerContext) => Math.floor(Date.parse(ctx.now) / 1000);
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

/** The most people one screen's read lists (a business's staff is far fewer). */
export const PEOPLE_MAX = 200;
/** The most people a shift's candidates are worked out for (each is a few indexed reads). */
export const CANDIDATES_MAX = 100;

/** Active people's staff accounts (never a deactivated one, never an agent), by name. */
async function activePeople(
  ctx: HandlerContext,
  limit: number,
): Promise<{ people: { account: string; name: string }[]; truncated: boolean }> {
  const rows = await ctx.db
    .selectFrom("core_user")
    .select(["id", "name", "email"])
    .where("kind", "=", "human")
    .where("deactivated_at", "is", null)
    .orderBy("name")
    .orderBy("email")
    .limit(limit + 1)
    .execute();
  const truncated = rows.length > limit;
  return {
    people: rows.slice(0, limit).map((r) => ({ account: r.id, name: r.name || r.email })),
    truncated,
  };
}

// --- staffing.me ----------------------------------------------------------------------------------

export const staffingMe = defineOperation({
  name: "staffing.me",
  description:
    "Tool-only (a shipped pack's tool): who is reading the roster and what the host lets them " +
    "do: their account and name, whether they roster others, whether they handle pay, the " +
    "organisation's zone and today's local date there, and the offer cut-off in minutes. A " +
    "screen shows the rosterers' and pay controls from this answer, never by guessing. Read-only.",
  input: z.object({}),
  output: z.object({
    account: z.string(),
    name: z.string(),
    rosters: z.boolean().describe("May put people on shifts and see the warnings"),
    pays: z.boolean().describe("Handles pay (a person only)"),
    zone: z.string(),
    today: z.string().describe("Today's local date in the organisation's zone"),
    cutoffMinutes: z.number().int(),
    uncoveredDays: z.number().int(),
  }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  async handler(_input, ctx) {
    await assertShippedToolRun(ctx, "staffing.me");
    const account = actingAccount(ctx);
    const { timezone } = await loadGeneralSettings(ctx.db);
    const numbers = await rosterNumbers(ctx.db);
    // Pay is a person's only: an assistant acting for someone who handles pay is told no.
    const person = ctx.extension?.tool?.calledBy?.actor === "human";
    return {
      account,
      name: await staffName(ctx.db, account),
      rosters: await mayRoster(ctx),
      pays: person && (await isPayer(ctx.db, account)),
      zone: timezone,
      today: localDateOf(nowSeconds(ctx), timezone),
      cutoffMinutes: numbers.cutoffMinutes,
      uncoveredDays: numbers.uncoveredDays,
    };
  },
});

// --- staffing.candidates ----------------------------------------------------------------------------

/** The pattern a generated shift follows: its series' person, as an account, or null. */
async function patternOf(
  ctx: HandlerContext,
  object: ObjectDefinition,
  values: Record<string, unknown>,
): Promise<{ series: { object: string; id: string } | null; account: string | null }> {
  const def = object.staffed;
  const link = def?.pattern?.link;
  const seriesObjectName = link ? object.fields.find((f) => f.name === link)?.options?.to : null;
  const seriesId = link ? text(values[link]) : null;
  const seriesObject = seriesObjectName ? getObject(seriesObjectName) : undefined;
  if (!def?.pattern || !seriesObject || !seriesId) return { series: null, account: null };
  const series = await loadRecord(ctx, seriesObject, seriesId);
  const who = text(series?.values[def.pattern.who]);
  return {
    series: { object: seriesObject.name, id: seriesId },
    account: who === null ? null : await accountOfPerson(ctx, object, who),
  };
}

/** The staff account a value of a shift's person field names (a coach profile's user). */
async function accountOfPerson(
  ctx: HandlerContext,
  object: ObjectDefinition,
  value: string,
): Promise<string | null> {
  const def = object.staffed;
  if (!def?.who.account) return value;
  const holder = def.who.object ? getObject(def.who.object) : undefined;
  const table = holder ? objectTableOf(holder.name) : undefined;
  const column = holder?.fields.find((f) => f.name === def.who.account)?.column;
  if (!table || !column) return null;
  const row = (await (ctx.db as AnyDb)
    .selectFrom(table)
    .select(`${column} as account`)
    .where("id", "=", value)
    .executeTakeFirst()) as { account?: unknown } | undefined;
  return text(row?.account);
}

const candidateSchema = z.object({
  account: z.string(),
  name: z.string(),
  /** Qualified (by the take's rule), free, not away, and the shift can name them. */
  eligible: z.boolean(),
  /** No profile this shift's person field can name (a class needs a coach profile). */
  noProfile: z.boolean(),
  warnings: z.array(staffWarningSchema),
  clash: z
    .object({
      object: z.string(),
      id: z.string(),
      title: z.string(),
      startsAt: z.string(),
      endsAt: z.string(),
    })
    .nullable()
    .describe("Their other shift then: putting them on it is refused as double_booked"),
});

export const staffingCandidates = defineOperation({
  name: "staffing.candidates",
  description:
    "Tool-only (a shipped pack's tool): who could be put on a shift, for someone who rosters. " +
    "Every active member of staff with what putting them on it would be made with (the same " +
    "dry run as staffing.check: warnings, or the other shift it would clash with), eligible " +
    "people first (qualified, free and available), then the rest; who is on it now; its " +
    "pattern's person (a shift of a weekly pattern) and whether it keeps its own person instead. " +
    "Read-only.",
  input: z.object({ object: objectName, id: recordId }),
  output: z.object({
    current: z.object({ account: z.string().nullable(), name: z.string().nullable() }),
    pattern: z
      .object({
        account: z.string().nullable(),
        name: z.string().nullable(),
        /** The shift keeps its own person instead of its pattern's (an exception), or is detached. */
        own: z.boolean(),
      })
      .nullable()
      .describe("A shift of a weekly pattern: its pattern's person; null for a one-off"),
    people: z.array(candidateSchema),
    truncated: z.boolean().describe("More staff than one answer works out"),
  }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    await assertShippedToolRun(ctx, "staffing.candidates");
    await assertRosterer(ctx, "see who could be put on a shift");
    const s = await requireLiveShift(ctx, input.object, input.id);
    const who = s.object.staffed?.who.field as string;
    const { people, truncated } = await activePeople(ctx, CANDIDATES_MAX);
    // Which accounts the shift's person field can name (a coach profile each), in one read.
    const named = new Map<string, string>();
    for (const p of people) {
      const value = await personValueFor(ctx, s.object, p.account);
      if (value) named.set(p.account, value);
    }
    const kind = s.shift.kind;
    const out: z.infer<typeof candidateSchema>[] = [];
    for (const p of people) {
      const { warnings, clash } = await checkShift(ctx, s.object, s.id, s.values, p.account);
      const strict = kind ? await qualified(ctx, s.object, p.account, kind, true) : false;
      const noProfile = !named.has(p.account);
      out.push({
        account: p.account,
        name: p.name,
        eligible: !noProfile && !clash && strict && warnings.length === 0,
        noProfile,
        warnings,
        clash,
      });
    }
    // Eligible first, then those with warnings, then those it would clash with or cannot name;
    // each by name. The order is the host's, so every screen lists them the same way.
    const rank = (c: (typeof out)[number]) => (c.eligible ? 0 : c.clash || c.noProfile ? 2 : 1);
    out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    // The whole record: a shift as the roster reads it holds only what makes it a shift.
    const full = (await loadRecord(ctx, s.object, s.id))?.values ?? s.values;
    const pattern = await patternOf(ctx, s.object, full);
    let own = false;
    if (pattern.series) {
      const exceptions = await exceptionsOf(ctx, s.object, s.id);
      own = exceptions.detached || exceptions.fields.some((f) => f.field === who);
    }
    return {
      current: {
        account: s.shift.account,
        name: s.shift.account ? await staffName(ctx.db, s.shift.account) : null,
      },
      pattern: pattern.series
        ? {
            account: pattern.account,
            name: pattern.account ? await staffName(ctx.db, pattern.account) : null,
            own,
          }
        : null,
      people: out,
      truncated,
    };
  },
});

// --- staffing.people --------------------------------------------------------------------------------

export const staffingPeople = defineOperation({
  name: "staffing.people",
  description:
    "Tool-only (a shipped pack's tool): the active members of staff, and every kind of work a " +
    "shift can be of (each class type, each duty), for someone who rosters to say who may do " +
    "which. Names only. Read-only.",
  input: z.object({}),
  output: z.object({
    people: z.array(z.object({ account: z.string(), name: z.string() })),
    kinds: z.array(
      z.object({ object: z.string(), objectLabel: z.string(), id: z.string(), name: z.string() }),
    ),
    truncated: z.boolean(),
  }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  async handler(_input, ctx) {
    await assertShippedToolRun(ctx, "staffing.people");
    await assertRosterer(ctx, "list the staff and the kinds of work");
    const { people, truncated } = await activePeople(ctx, PEOPLE_MAX);
    const kinds: { object: string; objectLabel: string; id: string; name: string }[] = [];
    const seen = new Set<string>();
    for (const object of listObjects()) {
      const kindObject = kindObjectOf(object);
      if (!kindObject || seen.has(kindObject)) continue;
      seen.add(kindObject);
      const target = getObject(kindObject);
      const table = objectTableOf(kindObject);
      const title = target?.fields.find((f) => f.name === target.titleField)?.column;
      if (!target || !table || !title) continue;
      const rows = await sql<{ id: string; title: string | null }>`SELECT id, ${sql.ref(
        title,
      )} AS title FROM ${sql.table(table)} WHERE deleted_at IS NULL ORDER BY ${sql.ref(
        title,
      )} LIMIT 200`.execute(ctx.db);
      for (const r of rows.rows) {
        kinds.push({
          object: kindObject,
          objectLabel: target.label,
          id: r.id,
          name: r.title ?? target.label,
        });
      }
    }
    return { people, kinds, truncated };
  },
});

// --- staffing.patterns and staffing.setPattern -------------------------------------------------------

/** Each staffed object that follows a pattern, with its series object and the series' person field. */
function patternObjects(): {
  shift: ObjectDefinition;
  series: ObjectDefinition;
  who: string;
}[] {
  const out: { shift: ObjectDefinition; series: ObjectDefinition; who: string }[] = [];
  for (const object of listObjects()) {
    const pattern = object.staffed?.pattern;
    if (!pattern) continue;
    const seriesName = object.fields.find((f) => f.name === pattern.link)?.options?.to;
    const series = seriesName ? getObject(seriesName) : undefined;
    if (series?.recurring) out.push({ shift: object, series, who: pattern.who });
  }
  return out;
}

const patternSchema = z.object({
  object: z.string().describe("The series' object: a class series or a duty series"),
  id: z.string(),
  title: z.string(),
  objectLabel: z.string(),
  kind: z.object({ object: z.string(), id: z.string(), name: z.string() }).nullable(),
  weekdays: z.array(z.string()),
  time: z.string().nullable(),
  length: z.number().nullable(),
  firstDate: z.string().nullable(),
  lastDate: z.string().nullable(),
  zone: z.string(),
  account: z.string().nullable(),
  name: z.string().nullable(),
  noAccount: z.boolean().describe("Its person has no staff account (a visiting coach)"),
});

export const staffingPatterns = defineOperation({
  name: "staffing.patterns",
  description:
    "Tool-only (a shipped pack's tool): the regular week, for someone who rosters: every series " +
    "that makes shifts (class series, duty series) that has not ended, with its weekdays, local " +
    "time, length, dates, zone, kind of work and its regular person (or nobody). Read-only.",
  input: z.object({}),
  output: z.object({ patterns: z.array(patternSchema), truncated: z.boolean() }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  async handler(_input, ctx) {
    await assertShippedToolRun(ctx, "staffing.patterns");
    await assertRosterer(ctx, "see the regular week");
    const { timezone } = await loadGeneralSettings(ctx.db);
    const patterns: z.infer<typeof patternSchema>[] = [];
    let truncated = false;
    for (const { shift, series, who } of patternObjects()) {
      const def = series.recurring;
      const table = objectTableOf(series.name);
      if (!def || !table) continue;
      const rows = (await (ctx.db as AnyDb)
        .selectFrom(table)
        .select("id")
        .where("deleted_at", "is", null)
        .orderBy("id")
        .limit(301)
        .execute()) as { id: string }[];
      if (rows.length > 300) {
        truncated = true;
        rows.length = 300;
      }
      const kindField = shift.staffed?.kind;
      const kindObject = kindObjectOf(shift);
      for (const { id } of rows) {
        const record = await loadRecord(ctx, series, id);
        if (!record) continue;
        const values = record.values;
        if (def.ended && def.ended.in.includes(String(values[def.ended.field] ?? ""))) continue;
        const person = text(values[who]);
        const account = person === null ? null : await accountOfPerson(ctx, shift, person);
        // The series' kind: the field the series copies into the shift's kind.
        const seriesKindField = kindField
          ? Object.entries(def.copy).find(([to]) => to === kindField)?.[1]
          : undefined;
        const kindId = seriesKindField ? text(values[seriesKindField]) : null;
        let kind: { object: string; id: string; name: string } | null = null;
        if (kindObject && kindId) {
          const target = getObject(kindObject);
          const kindRecord = target ? await loadRecord(ctx, target, kindId) : null;
          kind = {
            object: kindObject,
            id: kindId,
            name: String(
              (target?.titleField ? kindRecord?.values[target.titleField] : null) ??
                target?.label ??
                "",
            ),
          };
        }
        const title =
          text(series.titleField ? values[series.titleField] : null) ?? kind?.name ?? series.label;
        const days = values[def.rule.weekdays];
        patterns.push({
          object: series.name,
          id,
          title,
          objectLabel: series.label,
          kind,
          weekdays: Array.isArray(days) ? days.map(String) : [],
          time: text(values[def.rule.time]),
          length:
            def.rule.length && typeof values[def.rule.length] === "number"
              ? (values[def.rule.length] as number)
              : null,
          firstDate: text(values[def.rule.from]),
          lastDate: def.rule.until ? text(values[def.rule.until]) : null,
          zone: text(def.rule.zone ? values[def.rule.zone] : null) ?? timezone,
          account,
          name: account ? await staffName(ctx.db, account) : null,
          noAccount: person !== null && account === null,
        });
      }
    }
    const order = (p: (typeof patterns)[number]) =>
      `${String(SDK_WEEKDAYS.indexOf((p.weekdays[0] ?? "sun") as never)).padStart(2, "0")}${p.time ?? ""}${p.title}`;
    patterns.sort((a, b) => order(a).localeCompare(order(b)));
    return { patterns, truncated };
  },
});

export const staffingSetPattern = defineOperation({
  name: "staffing.setPattern",
  description:
    "Tool-only (a shipped pack's tool): change a weekly pattern's regular person (a class " +
    "series' coach, a duty series' person), or nobody (null), from a local date (today when left " +
    "out). Someone who rosters; an AI's request waits for a person. The shifts from that date " +
    "follow, except those that keep their own person; refused whole when it would put the person " +
    "on two shifts at once on any date (double_booked, naming the dates). Returns the series.",
  input: z.object({
    object: objectName.describe("The series' object (bookings.series, rostering.dutyseries)"),
    id: recordId,
    account: accountId.nullable(),
    from: localDate.optional(),
  }),
  output: z.object({
    object: z.string(),
    id: z.string(),
    account: z.string().nullable(),
    from: z.string(),
  }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  auditSummary: (output) => output,
  async handler(input, ctx) {
    await assertShippedToolRun(ctx, "staffing.setPattern");
    await assertRosterer(ctx, "change who works a pattern");
    assertPersonApplies(ctx, "Changing a pattern's person");
    const found = patternObjects().find((p) => p.series.name === input.object);
    if (!found) {
      throw new ValidationError(`${input.object} is not a pattern of shifts`, { field: "object" });
    }
    const series = await loadRecord(ctx, found.series, input.id);
    if (!series) throw new NotFoundError(input.object, input.id);
    let value: string | null = null;
    if (input.account !== null) {
      const user = await ctx.db
        .selectFrom("core_user")
        .select("id")
        .where("id", "=", input.account)
        .where("kind", "=", "human")
        .where("deactivated_at", "is", null)
        .executeTakeFirst();
      if (!user) throw new NotFoundError("user", input.account);
      value = await personValueFor(ctx, found.shift, input.account);
      if (!value) {
        throw new ConflictError(
          `${await staffName(ctx.db, input.account)} has no profile this pattern can name.`,
          { rule: "no_profile" },
        );
      }
    }
    const { timezone } = await loadGeneralSettings(ctx.db);
    const from = input.from ?? localDateOf(nowSeconds(ctx), timezone);
    await updateRecord(
      ctx,
      found.series,
      input.id,
      { [found.who]: value },
      { by: "staff", recurringFrom: from },
    );
    return { object: input.object, id: input.id, account: input.account, from };
  },
});

// --- staffing.follow --------------------------------------------------------------------------------

export const staffingFollow = defineOperation({
  name: "staffing.follow",
  description:
    "Tool-only (a shipped pack's tool): put a shift of a weekly pattern back to its pattern's " +
    'person ("back to the pattern"): its own person is dropped and it follows the pattern\'s ' +
    "later changes again. Someone who rosters; an AI's request waits for a person. Refused for a " +
    "one-off shift, and as double_booked when the pattern's person is on another shift then.",
  input: z.object({ object: objectName, id: recordId }),
  output: z.object({ object: z.string(), id: z.string(), warnings: z.array(staffWarningSchema) }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  auditSummary: (output) => ({ object: output.object, id: output.id }),
  async handler(input, ctx) {
    await assertShippedToolRun(ctx, "staffing.follow");
    await assertRosterer(ctx, "put a shift back to its pattern");
    assertPersonApplies(ctx, "Putting a shift back to its pattern");
    const s = await requireLiveShift(ctx, input.object, input.id);
    const who = s.object.staffed?.who.field as string;
    await followSeries(ctx, s.object, s.id, [who]);
    return { object: input.object, id: input.id, warnings: warningsOf(ctx, s.object.name, s.id) };
  },
});

// --- staffing.planCheck (the import's dry run) ------------------------------------------------------

const planSchema = z.object({
  key: z.string().max(80).optional().describe("The caller's name for it (a CSV row)"),
  kind: z.object({ object: objectName, id: recordId }).nullable().optional(),
  account: accountId.nullable(),
  weekdays: z.array(z.enum(WEEKDAYS)).min(1).max(7).optional().describe("A weekly pattern's days"),
  date: localDate.optional().describe("A one-off shift's local date"),
  time: localTime,
  length: z.number().int().min(1).max(1440),
  firstDate: localDate.optional(),
  lastDate: localDate.optional(),
  zone: z.string().min(1).max(64).optional(),
});

/** The most dated shifts one plan check works out. */
const PLAN_DATES_MAX = 2000;

export const staffingPlanCheck = defineOperation({
  name: "staffing.planCheck",
  description:
    "Tool-only (a shipped pack's tool): the dry run of rostering patterns and one-off shifts " +
    "before they are made (`cos rostering import`), for someone who rosters. For each plan (a " +
    "weekly pattern from its first date to the horizon, or one dated shift), the dates it would " +
    "make and, for its person, each date that would clash with a shift they are on or with an " +
    "earlier plan in the same check (title and start; `ended` when both have ended: reported, " +
    "never refused), and the dates they would be warned about (away, not qualified). The same " +
    "clash check the writes and the reconcile make. Writes nothing.",
  input: z.object({
    plans: z.array(planSchema).min(1).max(200),
    horizonDays: z.number().int().min(1).max(366).optional(),
  }),
  output: z.object({
    plans: z.array(
      z.object({
        key: z.string().nullable(),
        dates: z.number().int(),
        clashes: z.array(
          z.object({
            date: z.string(),
            startsAt: z.string(),
            other: z.object({ title: z.string(), startsAt: z.string(), endsAt: z.string() }),
            ended: z.boolean(),
          }),
        ),
        away: z.array(z.string()).describe("Dates the person said they are away"),
        notQualified: z.boolean(),
      }),
    ),
    truncated: z.boolean(),
  }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    await assertShippedToolRun(ctx, "staffing.planCheck");
    await assertRosterer(ctx, "check a roster before it is made");
    const { timezone } = await loadGeneralSettings(ctx.db);
    const now = nowSeconds(ctx);
    const today = localDateOf(now, timezone);
    const horizon = input.horizonDays ?? 56;
    const last = addDaysToDate(today, horizon);
    let total = 0;
    let truncated = false;
    const keys = new Map<string, string>();
    const out = [];
    for (const [index, plan] of input.plans.entries()) {
      const zone = plan.zone ?? timezone;
      if (!isTimezone(zone)) throw new ValidationError(`${zone} is not a time zone`);
      const minutes = parseLocalTime(plan.time);
      if (minutes === null) throw new ValidationError(`${plan.time} is not a time`);
      let occurrences: { date: string; starts: number; ends: number }[];
      if (plan.date) {
        const starts = wallClockToInstant(wallClockOf(plan.date, minutes), zone) / 1000;
        occurrences = [{ date: plan.date, starts, ends: starts + plan.length * 60 }];
      } else {
        if (!plan.weekdays || !plan.firstDate) {
          throw new ValidationError("A weekly pattern needs weekdays and a first date", {
            field: "weekdays",
          });
        }
        const rule: SeriesRule | null = ruleOf(
          {
            generates: "",
            link: "",
            rule: {
              weekdays: "weekdays",
              time: "time",
              length: "length",
              from: "from",
              until: "until",
              zone: "zone",
            },
            into: { starts: "" },
            copy: {},
            cancel: "",
            horizonDays: horizon,
          },
          {
            weekdays: plan.weekdays,
            time: plan.time,
            length: plan.length,
            from: plan.firstDate,
            until: plan.lastDate ?? null,
            zone,
          },
          timezone,
        );
        // Shifts are made from today on, as the host's generation does.
        occurrences = rule
          ? occurrencesBetween(rule, today, last).map((o) => ({
              date: o.date,
              starts: Math.floor(o.starts / 1000),
              ends: Math.floor((o.ends ?? o.starts) / 1000),
            }))
          : [];
      }
      if (total + occurrences.length > PLAN_DATES_MAX) {
        truncated = true;
        occurrences = occurrences.slice(0, Math.max(0, PLAN_DATES_MAX - total));
      }
      total += occurrences.length;
      const clashes = [];
      const away: string[] = [];
      for (const o of occurrences) {
        if (!plan.account || !(o.ends > o.starts)) continue;
        const id = `${index}-${o.date}`;
        const claim: Claim = { account: plan.account, starts: o.starts, ends: o.ends };
        const clash = await clashWith(ctx, "staffing.plan", id, claim);
        if (clash) {
          const other =
            clash.object === "staffing.plan"
              ? {
                  title: keys.get(clash.id) ?? "an earlier row",
                  startsAt: iso(clash.starts),
                  endsAt: iso(clash.ends),
                }
              : await described(ctx, clash);
          clashes.push({
            date: o.date,
            startsAt: iso(o.starts),
            other: { title: other.title, startsAt: other.startsAt, endsAt: other.endsAt },
            ended: o.ends <= now && clash.ends <= now,
          });
          continue;
        }
        // Later plans in this check see this one's time as taken.
        noteClaim(ctx, "staffing.plan", id, claim);
        keys.set(id, plan.key ?? `row ${index + 1}`);
        if (await awayOver(ctx, plan.account, o.starts, o.ends)) away.push(o.date);
      }
      let notQualified = false;
      if (plan.account && plan.kind) {
        const shiftObject = listObjects().find((o) => kindObjectOf(o) === plan.kind?.object);
        notQualified = shiftObject
          ? !(await qualified(ctx, shiftObject, plan.account, plan.kind.id))
          : false;
      }
      out.push({
        key: plan.key ?? null,
        dates: occurrences.length,
        clashes,
        away,
        notQualified,
      });
    }
    return { plans: out, truncated };
  },
});

export const staffingScreenOperations = [
  staffingMe,
  staffingCandidates,
  staffingPeople,
  staffingPatterns,
  staffingSetPattern,
  staffingFollow,
  staffingPlanCheck,
] as const;
