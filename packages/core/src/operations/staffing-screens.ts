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
import { jsonList } from "../records/common.ts";
import {
  exceptionsOf,
  followSeries,
  occurrencesBetween,
  ruleOf,
  type SeriesRule,
} from "../recurring/index.ts";
import { isTimezone, loadGeneralSettings } from "../settings.ts";
import { WEEKDAYS } from "../staffing/hours.ts";
import { kindObjectOf, personValueFor, warningsOf } from "../staffing/index.ts";
import { localDateOf } from "../staffing/pay.ts";
import {
  actingAccount,
  isPayer,
  mayRoster,
  rosterNumbers,
  staffName,
} from "../staffing/rosterers.ts";
import {
  awayIn,
  awayRowsOf,
  claimsOf,
  clashIn,
  type HeldClaim,
  namesOf,
  notQualifiedOf,
  profilesOf,
  qualifiedOf,
  titlesOf,
} from "../staffing/sets.ts";
import { parseLocalDate, parseLocalTime, wallClockOf, wallClockToInstant } from "../time/local.ts";
import { visibleSource } from "../visibility/index.ts";
import { fromRow, loadRecord, staffWarningSchema, updateRecord } from "./record.ts";
import {
  accountId,
  assertPersonApplies,
  assertRosterer,
  assertShippedToolRun,
  localDate,
  localTime,
  objectName,
  recordId,
  requireLiveShift,
} from "./staffing.ts";

// biome-ignore lint/suspicious/noExplicitAny: x_* tables are not in CoreDatabase; names come from the registry.
type AnyDb = import("kysely").Kysely<any>;

const nowSeconds = (ctx: HandlerContext) => Math.floor(Date.parse(ctx.now) / 1000);
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

/** The most people one screen's read lists (a business's staff is far fewer). */
export const PEOPLE_MAX = 200;
/** The most people a shift's candidates are worked out for (each is a few indexed reads). */
export const CANDIDATES_MAX = 100;
/** The most series of one object the regular week lists. */
export const PATTERNS_MAX = 300;

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
    const accounts = people.map((p) => p.account);
    // Read once for everyone (ADR 0629: never per person, a D1 call runs at most 1,000 queries):
    // profiles, claims, time off and who is marked for the shift's kind, checked in memory by the
    // writes' own rules (staffing/sets.ts).
    const named = await profilesOf(ctx, s.object, accounts);
    const { starts, ends } = s.shift;
    const span = starts !== null && ends !== null && ends > starts ? { starts, ends } : null;
    // The span its claim would take: widened by the minutes kept free around it (ADR 0760).
    const claimSpan = span
      ? { starts: span.starts - s.shift.before, ends: span.ends + s.shift.after }
      : null;
    const claims = claimSpan
      ? await claimsOf(ctx, accounts, claimSpan.starts, claimSpan.ends)
      : new Map();
    // Who is away is a person's to read (ADR 0629): an assistant acting for a rosterer learns
    // clashes and qualifications, never who is away.
    const person = ctx.extension?.tool?.calledBy?.actor === "human";
    const away = span && person ? await awayRowsOf(ctx, accounts, span.starts, span.ends) : null;
    const kind = s.shift.kind;
    const kindObject = kindObjectOf(s.object);
    const quals = kind && kindObject ? await qualifiedOf(ctx, kindObject, kind, accounts) : null;
    const clashing = new Map<string, HeldClaim>();
    for (const a of accounts) {
      const c = claimSpan
        ? clashIn(claims.get(a), claimSpan.starts, claimSpan.ends, {
            object: s.object.name,
            id: s.id,
          })
        : null;
      if (c) clashing.set(a, c);
    }
    const titles = await titlesOf(ctx, [...clashing.values()]);
    const label = s.object.label.toLowerCase();
    const out: z.infer<typeof candidateSchema>[] = [];
    for (const p of people) {
      const warn = (code: "unavailable" | "not_qualified", message: string) => ({
        code,
        object: s.object.name,
        id: s.id,
        account: p.account,
        message,
      });
      const warnings: ReturnType<typeof warn>[] = [];
      if (span && away && awayIn(away.get(p.account), span.starts, span.ends)) {
        warnings.push(warn("unavailable", `${p.name} said they are not available then.`));
      }
      if (quals && !quals.notWarned(p.account)) {
        warnings.push(
          warn("not_qualified", `${p.name} is not marked as qualified for this kind of ${label}.`),
        );
      }
      const c = clashing.get(p.account);
      const clash = c
        ? {
            object: c.object,
            id: c.id,
            title: titles.get(`${c.object}\u0000${c.id}`) ?? getObject(c.object)?.label ?? "shift",
            // The other shift's own time, not its claim's margins (ADR 0760).
            startsAt: iso(c.own.starts),
            endsAt: iso(c.own.ends),
          }
        : null;
      const strict = quals?.strict.has(p.account) ?? false;
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
    let kindsCut = false;
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
      )} LIMIT 201`.execute(ctx.db);
      if (rows.rows.length > 200) {
        kindsCut = true;
        rows.rows.length = 200;
      }
      for (const r of rows.rows) {
        kinds.push({
          object: kindObject,
          objectLabel: target.label,
          id: r.id,
          name: r.title ?? target.label,
        });
      }
    }
    return { people, kinds, truncated: truncated || kindsCut };
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
    // One read per series object, then the people, their names and the kinds' names each in one
    // read for all of them (ADR 0629: never per series).
    const rowsBy: {
      shift: ObjectDefinition;
      series: ObjectDefinition;
      who: string;
      records: { id: string; values: Record<string, unknown> }[];
    }[] = [];
    for (const { shift, series, who } of patternObjects()) {
      const def = series.recurring;
      if (!def) continue;
      const found = (await (ctx.db as AnyDb)
        .selectFrom(visibleSource(ctx, series))
        .selectAll()
        .orderBy("id")
        .limit(PATTERNS_MAX + 1)
        .execute()) as Record<string, unknown>[];
      if (found.length > PATTERNS_MAX) {
        truncated = true;
        found.length = PATTERNS_MAX;
      }
      const records = found
        .map((row) => fromRow(series, row))
        .filter((r) => !def.ended?.in.includes(String(r.values[def.ended.field] ?? "")));
      rowsBy.push({ shift, series, who, records });
    }
    // Who each pattern's person is: a coach profile's account, read for all profiles at once.
    const accountOf = new Map<string, string | null>();
    for (const { shift, who, records } of rowsBy) {
      const def = shift.staffed;
      const values = [
        ...new Set(records.flatMap((r) => (text(r.values[who]) ? [String(r.values[who])] : []))),
      ];
      if (!def?.who.account) {
        for (const v of values) accountOf.set(`${shift.name}\u0000${v}`, v);
        continue;
      }
      const holder = def.who.object ? getObject(def.who.object) : undefined;
      const table = holder ? objectTableOf(holder.name) : undefined;
      const column = holder?.fields.find((f) => f.name === def.who.account)?.column;
      if (!table || !column || !values.length) continue;
      for (let i = 0; i < values.length; i += 100) {
        const part = values.slice(i, i + 100);
        const held = await sql<{ id: string; account: string | null }>`SELECT id, ${sql.ref(
          column,
        )} AS account FROM ${sql.table(table)} WHERE id IN ${jsonList(part)}`.execute(ctx.db);
        for (const r of held.rows) accountOf.set(`${shift.name}\u0000${r.id}`, text(r.account));
      }
    }
    const names = await namesOf(
      ctx,
      [...accountOf.values()].filter((a): a is string => a !== null),
    );
    const kindRefs: { object: string; id: string }[] = [];
    const kindOf = (
      shift: ObjectDefinition,
      series: ObjectDefinition,
      values: Record<string, unknown>,
    ) => {
      const def = series.recurring;
      const kindField = shift.staffed?.kind;
      const kindObject = kindObjectOf(shift);
      const seriesKindField =
        def && kindField
          ? Object.entries(def.copy).find(([to]) => to === kindField)?.[1]
          : undefined;
      const kindId = seriesKindField ? text(values[seriesKindField]) : null;
      return kindObject && kindId ? { object: kindObject, id: kindId } : null;
    };
    for (const { shift, series, records } of rowsBy) {
      for (const r of records) {
        const k = kindOf(shift, series, r.values);
        if (k) kindRefs.push(k);
      }
    }
    const kindNames = await titlesOf(ctx, kindRefs);
    for (const { shift, series, who, records } of rowsBy) {
      const def = series.recurring;
      if (!def) continue;
      for (const { id, values } of records) {
        const person = text(values[who]);
        const account =
          person === null ? null : (accountOf.get(`${shift.name}\u0000${person}`) ?? null);
        const ref = kindOf(shift, series, values);
        const kind = ref
          ? {
              ...ref,
              name:
                kindNames.get(`${ref.object}\u0000${ref.id}`) ?? getObject(ref.object)?.label ?? "",
            }
          : null;
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
          name: account ? (names.get(account) ?? null) : null,
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
    const ended = found.series.recurring?.ended;
    if (ended?.in.includes(String(series.values[ended.field] ?? ""))) {
      throw new ConflictError("This pattern has ended, so it makes no more shifts to change.", {
        rule: "pattern_ended",
      });
    }
    const { timezone: orgZone } = await loadGeneralSettings(ctx.db);
    const today = localDateOf(nowSeconds(ctx), orgZone);
    if (input.from !== undefined) {
      if (!parseLocalDate(input.from)) {
        throw new ValidationError(`${input.from} is not a real date`, { field: "from" });
      }
      // A past date would rewrite who worked what: past shifts are corrected one by one.
      if (input.from < today) {
        throw new ValidationError("A pattern's person changes from today or a later date", {
          field: "from",
          rule: "past",
        });
      }
    }
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
    const from = input.from ?? today;
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

/** The most dated shifts one plan check works out: more is refused, never cut short. */
const PLAN_DATES_MAX = 20_000;

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
    plans: z.array(planSchema).min(1).max(1000),
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
        first: z
          .object({ date: z.string(), startsAt: z.string(), endsAt: z.string() })
          .nullable()
          .describe("Its first dated shift, as the host places it in its zone"),
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
    // Every plan's dates first: the whole check is one pass over them, read set-based (ADR 0629).
    const dated: { date: string; starts: number; ends: number }[][] = [];
    let total = 0;
    for (const plan of input.plans) {
      const zone = plan.zone ?? timezone;
      if (!isTimezone(zone)) throw new ValidationError(`${zone} is not a time zone`);
      const minutes = parseLocalTime(plan.time);
      if (minutes === null) throw new ValidationError(`${plan.time} is not a time`);
      for (const field of ["date", "firstDate", "lastDate"] as const) {
        const date = plan[field];
        if (date !== undefined && !parseLocalDate(date)) {
          throw new ValidationError(`${date} is not a real date`, { field });
        }
      }
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
      total += occurrences.length;
      // Budgeted by dates, never cut short: a check that left dates out would let them through.
      if (total > PLAN_DATES_MAX) {
        throw new ValidationError(
          `At most ${PLAN_DATES_MAX} dated shifts are checked at once: split the file, or use a shorter horizon.`,
          { rule: "too_large", dates: total },
        );
      }
      dated.push(occurrences);
    }
    // What the people on the plans hold, and their time off, over the whole range: a few reads,
    // however many plans and dates.
    const accounts = [...new Set(input.plans.flatMap((p) => (p.account ? [p.account] : [])))];
    const all = dated.flat();
    const lo = Math.min(...all.map((o) => o.starts), now);
    const hi = Math.max(...all.map((o) => o.ends), now);
    const held = accounts.length ? await claimsOf(ctx, accounts, lo, hi) : new Map();
    const awayRows = accounts.length ? await awayRowsOf(ctx, accounts, lo, hi) : new Map();
    const kinds = input.plans.flatMap((p) => (p.account && p.kind ? [p.kind] : []));
    const notQualifiedFor = kinds.length ? await notQualifiedOf(ctx, accounts, kinds) : null;
    // Claims bucketed by day, so each date is checked against only its neighbours.
    type Bucketed = Map<
      string,
      Map<number, { starts: number; ends: number; ref: HeldClaim | string }[]>
    >;
    const bucket = (
      store: Bucketed,
      account: string,
      c: { starts: number; ends: number; ref: HeldClaim | string },
    ) => {
      const byDay = store.get(account) ?? new Map();
      for (let d = Math.floor(c.starts / 86_400); d <= Math.floor((c.ends - 1) / 86_400); d++) {
        const list = byDay.get(d) ?? [];
        list.push(c);
        byDay.set(d, list);
      }
      store.set(account, byDay);
    };
    const find = (store: Bucketed, account: string, starts: number, ends: number) => {
      const byDay = store.get(account);
      if (!byDay) return null;
      for (let d = Math.floor(starts / 86_400); d <= Math.floor((ends - 1) / 86_400); d++) {
        for (const c of byDay.get(d) ?? []) if (c.starts < ends && c.ends > starts) return c;
      }
      return null;
    };
    const heldBuckets: Bucketed = new Map();
    for (const [account, list] of held) {
      for (const c of list as HeldClaim[])
        bucket(heldBuckets, account, { starts: c.starts, ends: c.ends, ref: c });
    }
    const planned: Bucketed = new Map();
    const found: {
      plan: number;
      date: string;
      starts: number;
      ends: number;
      other: { starts: number; ends: number; ref: HeldClaim | string };
    }[] = [];
    const awayDates: string[][] = input.plans.map(() => []);
    for (const [index, plan] of input.plans.entries()) {
      const account = plan.account;
      if (!account) continue;
      for (const o of dated[index] ?? []) {
        if (!(o.ends > o.starts)) continue;
        const other =
          find(heldBuckets, account, o.starts, o.ends) ?? find(planned, account, o.starts, o.ends);
        if (other) {
          found.push({ plan: index, ...o, other });
          continue;
        }
        // Later plans in this check see this one's time as taken.
        bucket(planned, account, {
          starts: o.starts,
          ends: o.ends,
          ref: plan.key ?? `row ${index + 1}`,
        });
        if (awayIn(awayRows.get(account), o.starts, o.ends)) awayDates[index]?.push(o.date);
      }
    }
    const titles = await titlesOf(
      ctx,
      found.flatMap((f) => (typeof f.other.ref === "string" ? [] : [f.other.ref])),
    );
    const out = [];
    for (const [index, plan] of input.plans.entries()) {
      const occurrences = dated[index] ?? [];
      const clashes = found
        .filter((f) => f.plan === index)
        .map((f) => {
          const ref = f.other.ref;
          const title =
            typeof ref === "string"
              ? ref
              : (titles.get(`${ref.object}\u0000${ref.id}`) ??
                getObject(ref.object)?.label ??
                "shift");
          return {
            date: f.date,
            startsAt: iso(f.starts),
            other: { title, startsAt: iso(f.other.starts), endsAt: iso(f.other.ends) },
            ended: f.ends <= now && f.other.ends <= now,
          };
        });
      const away = awayDates[index] ?? [];
      const notQualified =
        plan.account && plan.kind && notQualifiedFor
          ? notQualifiedFor(plan.account, plan.kind)
          : false;
      out.push({
        key: plan.key ?? null,
        dates: occurrences.length,
        first: occurrences[0]
          ? {
              date: occurrences[0].date,
              startsAt: iso(occurrences[0].starts),
              endsAt: iso(occurrences[0].ends),
            }
          : null,
        clashes,
        away,
        notQualified,
      });
    }
    return { plans: out, truncated: false };
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
