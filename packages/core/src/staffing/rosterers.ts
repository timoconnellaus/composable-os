// Who may roster, who the roster's caller is, the roster's numbers, and the roster's notices
// (stage 45, ADRs 0622 to 0626).
//
// **Who may roster** is decided here and nowhere else (step 4, ADR 0625): an active staff account
// that is an admin, or that a human admin granted the rosterers' permission, which a shipped pack
// declares (`staffing.rosters`, restricted and grantable: Rostering's `rostering:manage`). With
// no such pack installed, the admins. Every rule that asks "may this caller roster?" or "who are
// the rosterers?" reads these functions.
//
// **Who the caller is.** An operation a pack's tool calls runs as the extension's own account; the
// staff account the tool was called for is the pipeline's verified caller, carried on the run
// (`ctx.extension.tool.calledBy`, ADR 0625), never the input. `actingAccount` gives it.
//
// **The numbers** (the offer cut-off, the uncovered window) are the pack's settings, read by the
// host through the same declaration (`staffing.settings`), with the host's defaults otherwise.
//
// **The notices** are the host's own (in-app, delivered by email as each person's preferences
// say), written in the batch of the write that causes them, so a take or a reassignment made by
// any path tells the same people. Nothing here writes to a member.

import type { CoreDatabase } from "@composable-os/db";
import { type Kysely, sql } from "kysely";
import { ForbiddenError } from "../errors.ts";
import { notifyStatements } from "../notifications/send.ts";
import type { NotificationLink } from "../notifications/types.ts";
import type { HandlerContext } from "../operation.ts";
import { parseGrants } from "../pack-roles.ts";
import { jsonList } from "../records/common.ts";
import { extensionSettingValues } from "../records/windows.ts";

/** Offers close this many minutes before a shift starts unless a pack's setting says (decision 21). */
export const DEFAULT_OFFER_CUTOFF_MINUTES = 60;
/** Shifts with nobody on them are surfaced this many days ahead unless a pack's setting says. */
export const DEFAULT_UNCOVERED_DAYS = 14;

/** The actors whose call of a tool is a staff account's own (or made for it by an AI). */
const STAFF_ACTORS: ReadonlySet<string> = new Set(["human", "assistant", "mcp"]);

/**
 * The staff account a call is for: in a pack tool's run, the account the tool was called for (the
 * pipeline's verified caller); otherwise the calling account itself.
 */
export function actingAccount(ctx: Pick<HandlerContext, "actor" | "extension" | "user">): string {
  const tool = ctx.extension?.tool;
  if (ctx.actor === "extension" && tool?.calledBy) return tool.calledBy.account;
  return ctx.user.id;
}

/**
 * The staff account a tool-only staffing operation acts for, or null when the tool was not
 * called for one (an automation's run, another extension's code, a customer): those are refused.
 */
export function toolCaller(ctx: Pick<HandlerContext, "actor" | "extension">): string | null {
  const calledBy = ctx.actor === "extension" ? ctx.extension?.tool?.calledBy : undefined;
  return calledBy && STAFF_ACTORS.has(calledBy.actor) && calledBy.account ? calledBy.account : null;
}

interface StaffingDeclaration {
  extension: string;
  rosters: string;
  grantable: boolean;
  /** Who handles pay (ADR 0627), when declared and still grantable. */
  pays: string | null;
  settings: {
    offerCutoffMinutes?: string;
    uncoveredDays?: string;
    payPeriod?: string;
    payPeriodStart?: string;
    payPeriodDay?: string;
  };
}

const SETTING_KEYS = [
  "offerCutoffMinutes",
  "uncoveredDays",
  "payPeriod",
  "payPeriodStart",
  "payPeriodDay",
] as const;

/** The installed, active, shipped packs that declare the roster's rules (ADR 0626). */
async function declarations(db: Kysely<CoreDatabase>): Promise<StaffingDeclaration[]> {
  const rows = await sql<{ id: string; staffing: string | null; grantable: string | null }>`
    SELECT id, json_extract(manifest, '$.staffing') AS staffing,
      json_extract(manifest, '$.grantable') AS grantable
    FROM core_extensions
    WHERE status = 'active' AND source = 'shipped'
      AND json_extract(manifest, '$.staffing') IS NOT NULL
    ORDER BY id
  `.execute(db);
  const out: StaffingDeclaration[] = [];
  for (const row of rows.rows) {
    try {
      const staffing = JSON.parse(row.staffing ?? "null") as {
        rosters?: unknown;
        pays?: unknown;
        settings?: Record<string, unknown>;
      } | null;
      const grantable = parseGrants(row.grantable);
      if (typeof staffing?.rosters !== "string") continue;
      const settings = staffing.settings ?? {};
      const named: StaffingDeclaration["settings"] = {};
      for (const k of SETTING_KEYS) {
        const value = settings[k];
        if (typeof value === "string") named[k] = value;
      }
      out.push({
        extension: row.id,
        rosters: staffing.rosters,
        grantable: grantable.includes(staffing.rosters),
        // A pay permission no longer declared grantable is nobody's grant (admins still hold it).
        pays:
          typeof staffing.pays === "string" && grantable.includes(staffing.pays)
            ? staffing.pays
            : null,
        settings: named,
      });
    } catch {
      // A manifest that does not parse declares nothing (fail closed: admins only).
    }
  }
  return out;
}

/** The permissions whose grant makes an account a rosterer (still declared grantable). */
async function rosterGrants(db: Kysely<CoreDatabase>): Promise<string[]> {
  return (await declarations(db)).filter((d) => d.grantable).map((d) => d.rosters);
}

/** Whether the staff account `account` may roster other people (ADR 0625). */
export async function isRosterer(db: Kysely<CoreDatabase>, account: string): Promise<boolean> {
  const row = await db
    .selectFrom("core_user")
    .select(["role", "kind", "deactivated_at", "granted_permissions"])
    .where("id", "=", account)
    .executeTakeFirst();
  if (!row || row.kind !== "human" || row.deactivated_at) return false;
  if (row.role === "admin") return true;
  const grants = parseGrants(row.granted_permissions);
  if (!grants.length) return false;
  return (await rosterGrants(db)).some((p) => grants.includes(p));
}

/** Whether the caller (the account the call is for) may roster other people. */
export function mayRoster(ctx: HandlerContext): Promise<boolean> {
  return isRosterer(ctx.db, actingAccount(ctx));
}

/**
 * Whether an installed, active, shipped pack declares who rosters (Rostering's `staffing`). Where
 * none does (a product with Bookings alone), who is on a shift stays whoever may write the record,
 * as before stage 45 step 4 (ADR 0626).
 */
export async function rosteringDeclared(db: Kysely<CoreDatabase>): Promise<boolean> {
  return (await declarations(db)).length > 0;
}

/**
 * Refuses the caller's write of who works a shift (or a pattern's person, or a coach profile's
 * account) unless they roster, where a pack declares who rosters (ADR 0626, the review of PR #284;
 * the owner's decision of 2026-11-24).
 * Putting someone on a shift, taking them off, or yourself, is a rosterer's; a person gives their
 * own shift away by offering it.
 */
export async function assertMayRoster(ctx: HandlerContext, what: string): Promise<void> {
  if (!(await rosteringDeclared(ctx.db))) return;
  if (await mayRoster(ctx)) return;
  throw new ForbiddenError(
    `Only someone who rosters may ${what}. Offer your own shift instead, or ask whoever rosters.`,
    { rule: "rostering" },
  );
}

/**
 * Whether the staff account `account` handles pay (ADR 0627): an active person who is an admin,
 * or whom a human admin granted the pay permission a shipped pack declares (`staffing.pays`).
 */
export async function isPayer(db: Kysely<CoreDatabase>, account: string): Promise<boolean> {
  const row = await db
    .selectFrom("core_user")
    .select(["role", "kind", "deactivated_at", "granted_permissions"])
    .where("id", "=", account)
    .executeTakeFirst();
  if (!row || row.kind !== "human" || row.deactivated_at) return false;
  if (row.role === "admin") return true;
  const grants = parseGrants(row.granted_permissions);
  if (!grants.length) return false;
  return (await declarations(db)).some((d) => d.pays !== null && grants.includes(d.pays));
}

/**
 * Whether the extension `id` is the shipped pack whose pay periods the host totals (it declares
 * them in `staffing.settings`): a person's own totals are read only through its tools.
 */
export async function declaresPayPeriods(db: Kysely<CoreDatabase>, id: string): Promise<boolean> {
  const declared = (await declarations(db)).find(
    (d) => d.settings.payPeriod && d.settings.payPeriodStart && d.settings.payPeriodDay,
  );
  return declared?.extension === id;
}

/** The pay period's settings as the pack declaring the roster's rules sets them, or null. */
export async function payPeriodSettings(db: Kysely<CoreDatabase>): Promise<{
  period: unknown;
  start: unknown;
  day: unknown;
} | null> {
  const declared = (await declarations(db)).find(
    (d) => d.settings.payPeriod && d.settings.payPeriodStart && d.settings.payPeriodDay,
  );
  if (!declared) return null;
  const values = await extensionSettingValues(db, declared.extension);
  const { payPeriod, payPeriodStart, payPeriodDay } = declared.settings;
  return {
    period: payPeriod ? values[payPeriod] : undefined,
    start: payPeriodStart ? values[payPeriodStart] : undefined,
    day: payPeriodDay ? values[payPeriodDay] : undefined,
  };
}

/** Every active rosterer's account: admins, and those granted the rosterers' permission. */
export async function rosterers(db: Kysely<CoreDatabase>): Promise<string[]> {
  const grants = await rosterGrants(db);
  const rows = await db
    .selectFrom("core_user")
    .select(["id", "role", "granted_permissions"])
    .where("kind", "=", "human")
    .where("deactivated_at", "is", null)
    .where((eb) =>
      grants.length
        ? eb.or([eb("role", "=", "admin"), eb("granted_permissions", "is not", null)])
        : eb("role", "=", "admin"),
    )
    .orderBy("id")
    .execute();
  return rows
    .filter(
      (r) =>
        r.role === "admin" || parseGrants(r.granted_permissions).some((p) => grants.includes(p)),
    )
    .map((r) => r.id);
}

/** The roster's numbers: the offer cut-off (minutes) and the uncovered window (days). */
export interface RosterNumbers {
  cutoffMinutes: number;
  uncoveredDays: number;
}

const bounded = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(Math.round(value), min), max)
    : fallback;

/**
 * The roster's numbers as the pack declaring the roster's rules sets them (its settings' stored
 * values, else their defaults), or the host's defaults when none does.
 */
export async function rosterNumbers(db: Kysely<CoreDatabase>): Promise<RosterNumbers> {
  const declared = (await declarations(db)).find(
    (d) => d.settings.offerCutoffMinutes || d.settings.uncoveredDays,
  );
  if (!declared) {
    return {
      cutoffMinutes: DEFAULT_OFFER_CUTOFF_MINUTES,
      uncoveredDays: DEFAULT_UNCOVERED_DAYS,
    };
  }
  const values = await extensionSettingValues(db, declared.extension);
  const { offerCutoffMinutes, uncoveredDays } = declared.settings;
  return {
    cutoffMinutes: bounded(
      offerCutoffMinutes ? values[offerCutoffMinutes] : undefined,
      0,
      10_080,
      DEFAULT_OFFER_CUTOFF_MINUTES,
    ),
    uncoveredDays: bounded(
      uncoveredDays ? values[uncoveredDays] : undefined,
      1,
      62,
      DEFAULT_UNCOVERED_DAYS,
    ),
  };
}

/** A staff account's name as notices and answers show it. */
export async function staffName(db: Kysely<CoreDatabase>, account: string): Promise<string> {
  const row = await db
    .selectFrom("core_user")
    .select(["name", "email"])
    .where("id", "=", account)
    .executeTakeFirst();
  return row?.name || row?.email || "Someone";
}

/** One notice the host sends. */
export interface StaffNotice {
  to: readonly string[];
  title: string;
  body?: string | null;
  link?: NotificationLink | null;
  /** The person only: no AI acting for them lists it (it says something about availability). */
  humanOnly?: boolean;
  dedupeKey?: string;
}

/**
 * Queues one notice to each of `to` (people only; duplicates dropped) in the caller's batch. The
 * caller itself is never told what it just did.
 */
export async function queueNotice(ctx: HandlerContext, notice: StaffNotice): Promise<void> {
  const me = actingAccount(ctx);
  const to = [...new Set(notice.to)].filter((id) => id && id !== me);
  if (!to.length) return;
  const people = await ctx.db
    .selectFrom("core_user")
    .select("id")
    .where("id", "in", jsonList(to))
    .where("kind", "=", "human")
    .execute();
  if (!people.length) return;
  const plan = await notifyStatements(
    ctx.db,
    {
      to: people.map((p) => ({ userId: p.id })),
      type: "system.message",
      title: notice.title.slice(0, 200),
      body: notice.body ?? null,
      link: notice.link ?? null,
      ...(notice.dedupeKey ? { dedupeKey: notice.dedupeKey } : {}),
      ...(notice.humanOnly ? { humanOnly: true } : {}),
      source: { actor: ctx.actor, userId: me },
    },
    ctx.now,
  );
  ctx.write(...plan.statements);
}

/** A notice's link to a shift. */
export const shiftLink = (object: string, id: string): NotificationLink => ({
  kind: "record",
  object,
  id,
});
