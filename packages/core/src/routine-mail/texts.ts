// Routine messages by text (stage 30 step 3, ADRs 0672 and 0673): which number is textable, the
// claim that counts a text against the month's limit and the person's day, what the host does
// with the text gatekeeper's verified receipts and replies, and the step that hands each ready
// text to the integration host.
//
// - Textable (`textReach`): a Person's primary mobile (or, when the primary is not one, their
//   first mobile) in a country texts may go to, whose mark (`phones:<number>`, marks.ts) is a
//   person's or a default's, or that this Person checked by code; never one an AI added, nor one
//   another Person checked (issue #302's rule for numbers), nor one that replied STOP.
// - The month's limit (`claimRoutineText`): a text is claimed with its estimated cost in one
//   statement on `core_text_spend` that refuses to pass the limit, so runs claiming at once cannot
//   go over it; over it the text is `over_limit` (its email went) and admins are told once that
//   day, and at 80% once that month. Five texts a day per number, counted at the same claim.
// - A STOP (the gatekeeper's verified reply) stops every text to the number, on any Person: the
//   next is `stopped`. START lifts it. Numbers are kept only as salted hashes, on the consent
//   register's suppression list (contact/suppression.ts, ADR 0675).
import type { CoreDatabase } from "@composable-os/db";
import { type Kysely, sql } from "kysely";
import { registerRefusal } from "../contact/decide.ts";
import { saltedHash, suppress, suppressed, unsuppress } from "../contact/suppression.ts";
import { newId } from "../ids.ts";
import type { IntegrationRuntime } from "../integrations/runtime.ts";
import { notifyStatements } from "../notifications/send.ts";
import { isTimezone } from "../settings.ts";
import { loadRoutineMailSettings, routineKinds } from "./index.ts";
import { PRIMARY_PHONE, phoneDigits, phoneField, valueHash } from "./marks.ts";
import { mobileInCountries } from "./numbers.ts";
import type { Reached } from "./reach.ts";

type Db = Kysely<CoreDatabase>;

/** Texts a day per number (stage 30: 5 texts and 20 pushes a day per person). */
export const TEXTS_PER_DAY = 5;
/** Codes a day per Person, and per number whoever asks (ADR 0673). */
export const CODES_PER_DAY = 3;
/** The text gatekeeper's resource: the business's sender number. */
export const TEXT_SENDER_URL = "text://sender";
const DAY_MS = 86_400_000;

/** Tells executeTakeFirst-style kysely results apart from a plan's statements. */
async function run(statements: readonly unknown[]): Promise<void> {
  for (const statement of statements) {
    await (statement as { execute(): Promise<unknown> }).execute();
  }
}

/** The salted hash a number is kept as (the caps' key, a stop), never the number. */
export function numberHash(db: Db, number: string): Promise<string> {
  return saltedHash(db, number);
}

/** The month (`YYYY-MM`) `at` falls in, in the business's zone (UTC when none is set). */
export function textMonth(at: string, zone: string | null): string {
  const tz = zone && isTimezone(zone) ? zone : "UTC";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}`;
}

// ---------------------------------------------------------------------------------------------
// Which number is textable

/**
 * The Person's textable mobile and its caps' key, or why there is none. Six statements whatever
 * the Person holds (the cost test counts them).
 */
export async function textReach(db: Db, personId: string): Promise<Reached> {
  const settings = await loadRoutineMailSettings(db);
  if (!settings.textCountries.length) {
    return { reason: "no country is set that texts may go to (Settings → Routine email)" };
  }
  const phones = await db
    .selectFrom("core_person_phones")
    .select(["number", "is_primary"])
    .where("person_id", "=", personId)
    .orderBy("is_primary", "desc")
    .orderBy("position")
    .limit(20)
    .execute();
  let chosen: { raw: string; to: string; primary: boolean } | null = null;
  for (const phone of phones) {
    const to = mobileInCountries(phone.number, settings.textCountries);
    if (to) {
      chosen = { raw: phone.number, to, primary: phone.is_primary === 1 };
      break;
    }
  }
  if (!chosen) {
    return {
      reason: phones.length
        ? "no mobile number in a country texts may go to"
        : "no phone number on the person",
    };
  }
  const field = phoneField(chosen.raw);
  const marks = await db
    .selectFrom("core_value_mark")
    .select(["field", "standing", "value_hash"])
    .where("object_type", "=", "person")
    .where("record_id", "=", personId)
    .where("field", "in", [field, PRIMARY_PHONE])
    .execute();
  const digits = phoneDigits(chosen.raw);
  const hash = await valueHash(digits);
  const mark = marks.find((m) => m.field === field && m.value_hash === hash);
  const primaryMark = marks.find((m) => m.field === PRIMARY_PHONE && m.value_hash === hash);
  const key = await numberHash(db, chosen.to);
  const checks = await db
    .selectFrom("core_phone_check")
    .select("person_id")
    .where("number_hash", "=", key)
    .where("checked_at", "is not", null)
    .limit(20)
    .execute();
  if (checks.some((c) => c.person_id !== personId)) {
    return { reason: "the number was checked by code by another person" };
  }
  // Checked by this Person's own code: theirs, whoever wrote it down. Else a person's or a
  // default's mark, never an AI's (nor a primary an AI chose).
  const checked = checks.some((c) => c.person_id === personId);
  const standing = mark?.standing;
  if (!checked && (standing === "ai" || (chosen.primary && primaryMark?.standing === "ai"))) {
    return {
      reason: "an AI added or chose this number: a person must add it, or the member check it",
    };
  }
  if (!checked && standing !== "person" && standing !== "default") {
    return {
      reason:
        standing === "customer"
          ? "the member's own number, not yet checked by a code"
          : "nobody stands behind this number: a person must add it, or the member check it",
    };
  }
  if (await suppressed(db, "text", key))
    return { reason: "the number replied STOP", stopped: true };
  return { to: chosen.to, key: `text:${key}` };
}

// ---------------------------------------------------------------------------------------------
// The month's spend

/**
 * Adds `segments` costing `cost` to `month`'s spend, only while it stays within `limit`
 * (null: no limit, for a HELP answer the provider already sent). One statement decides, so two
 * runs cannot pass the limit together. Returns the spend after it, or null when it would pass.
 */
async function reserveSpend(
  db: Db,
  month: string,
  segments: number,
  cost: number,
  limit: number | null,
  now: string,
): Promise<number | null> {
  await db
    .insertInto("core_text_spend")
    .values({ month, updated_at: now })
    .onConflict((oc) => oc.column("month").doNothing())
    .execute();
  let update = db
    .updateTable("core_text_spend")
    .set({
      segments: sql`segments + ${segments}`,
      estimated_minor: sql`estimated_minor + ${cost}`,
      updated_at: now,
    })
    .where("month", "=", month);
  if (limit !== null) update = update.where(sql<boolean>`estimated_minor + ${cost} <= ${limit}`);
  const row = await update.returning("estimated_minor").executeTakeFirst();
  return row ? Number(row.estimated_minor) : null;
}

async function refundSpend(db: Db, month: string, segments: number, cost: number, now: string) {
  await db
    .updateTable("core_text_spend")
    .set({
      segments: sql`MAX(0, segments - ${segments})`,
      estimated_minor: sql`MAX(0, estimated_minor - ${cost})`,
      updated_at: now,
    })
    .where("month", "=", month)
    .execute();
}

async function tellAdmins(
  db: Db,
  title: string,
  body: string,
  dedupeKey: string,
  now: string,
): Promise<void> {
  const plan = await notifyStatements(
    db,
    {
      to: [{ role: "admin" }],
      type: "system.message",
      title,
      body,
      dedupeKey,
      source: { actor: "system" },
    },
    now,
  );
  await run(plan.statements);
}

/** This month's spend, against the limit: for `messages.textSpend` and the settings screen. */
export async function textSpend(
  db: Db,
  now: string,
): Promise<{
  month: string;
  segments: number;
  estimatedMinor: number;
  reportedMinor: number;
  limitMinor: number;
  segmentPriceMinor: number | null;
}> {
  const settings = await loadRoutineMailSettings(db);
  const month = textMonth(now, settings.quietZone);
  const row = await db
    .selectFrom("core_text_spend")
    .selectAll()
    .where("month", "=", month)
    .executeTakeFirst();
  return {
    month,
    segments: Number(row?.segments ?? 0),
    estimatedMinor: Number(row?.estimated_minor ?? 0),
    reportedMinor: Number(row?.reported_minor ?? 0),
    limitMinor: settings.textLimitMinor,
    segmentPriceMinor: settings.textSegmentPriceMinor,
  };
}

/**
 * Counts one checking code against the month's limit (ADR 0673: a code sent to any number
 * someone types costs the business), refusing it over the limit. One segment.
 */
export async function claimCodeSpend(
  db: Db,
  now: string,
): Promise<{ ok: true; month: string; cost: number } | { ok: false; why: string }> {
  const settings = await loadRoutineMailSettings(db);
  const price = settings.textSegmentPriceMinor;
  if (!price || settings.textLimitMinor <= 0) {
    return { ok: false, why: "texts are not set up here yet" };
  }
  const month = textMonth(now, settings.quietZone);
  const spent = await reserveSpend(db, month, 1, price, settings.textLimitMinor, now);
  if (spent === null) return { ok: false, why: "this month's texts have reached their limit" };
  return { ok: true, month, cost: price };
}

export async function refundCodeSpend(db: Db, month: string, cost: number, now: string) {
  await refundSpend(db, month, 1, cost, now);
}

// ---------------------------------------------------------------------------------------------
// Claiming a text to send

/** A text the integration host may hand to the text gatekeeper now: the row's own words. */
export interface RoutineTextRow {
  id: string;
  kind: string;
  /** Decided routine: the gatekeeper's `text.routine`. False: a person reviews it. */
  routine: boolean;
  heldReason: string | null;
  automationId: string | null;
  runId: string | null;
  extensionId: string;
  to: string;
  text: string;
  business: string;
  /** What the claim reserved, to give back when it does not go. */
  spend: { month: string; segments: number; cost: number };
  /** The state to go back to when it does not go now: `ready`, or `held` (a person's). */
  from: "ready" | "held";
}

export type ClaimedText =
  | { status: "send"; row: RoutineTextRow }
  | { status: "off" | "stopped" | "over_limit" | "expired" | "failed" | "held" };

/** A text left `sending` this long was cut off (the host stopped before it settled): tried again. */
export const STALE_SENDING_MS = 15 * 60_000;

/**
 * Claims a text row to send through `connectionId` now; null when it is not one to send (sent
 * already, claimed by another run, waiting for a person). Decided again first, as an email is
 * when claimed: its kind, its pack's routine messages and its text switched off since, or the
 * month's limit at 0: `off`; its moment passed: `expired`; its number replied STOP since:
 * `stopped`. Then the row is claimed within its number's day (over it, held for a person), and
 * only then its cost reserved against the month's limit (`over_limit` past it), so two claims of
 * one row never spend twice nor mark it over the limit (the review of PR #435). A row left
 * `sending` longer than `STALE_SENDING_MS` is claimed again with the spend it already reserved;
 * the gatekeeper's idempotency key answers it with what the first try made.
 */
export async function claimRoutineText(
  db: Db,
  id: string,
  connectionId: string,
  now = new Date().toISOString(),
): Promise<ClaimedText | null> {
  const row = await db
    .selectFrom("core_routine_mail")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row || row.channel !== "text") return null;
  const stale =
    row.status === "sending" && Date.parse(row.updated_at) <= Date.parse(now) - STALE_SENDING_MS;
  if (
    row.status !== "ready" &&
    !(row.status === "held" && row.pending_action_id === null) &&
    !stale
  ) {
    return null;
  }
  if (row.body === null || !row.recipient) return null;
  const current = row.status;
  /** Where the row goes back to when it is not handed over now. */
  const from: "ready" | "held" =
    current === "ready" || (current === "sending" && row.routine === 1) ? "ready" : "held";
  const settings = await loadRoutineMailSettings(db);
  const reservedMonth = row.claimed_at ? textMonth(row.claimed_at, settings.quietZone) : null;
  const settle = async (
    status: "off" | "stopped" | "over_limit" | "expired" | "failed",
    error?: string,
  ) => {
    const done = await db
      .updateTable("core_routine_mail")
      .set({
        status,
        updated_at: now,
        subject: null,
        body: null,
        recipient: "",
        cost_minor: null,
        ...(status === "off" ? { routine: 0 } : {}),
        ...(error ? { error } : {}),
      })
      .where("id", "=", id)
      .where("status", "=", current)
      .where("updated_at", "=", row.updated_at)
      .executeTakeFirst();
    // A stale row's reservation goes back once it is decided without sending.
    if (stale && Number(done.numUpdatedRows) && row.cost_minor && reservedMonth) {
      await refundSpend(db, reservedMonth, Math.max(1, row.segments ?? 1), row.cost_minor, now);
    }
    return { status } as const;
  };
  if (row.until_at !== null && row.until_at <= now) return settle("expired");
  const kind = (await routineKinds(db)).find((k) => k.id === row.kind);
  if (!kind?.on || !kind.packOn || !kind.channels.text) return settle("off");
  const limit = settings.textLimitMinor;
  // A limit of 0 is texts switched off, not used up: no notice (the review of PR #435).
  if (limit <= 0) return settle("off", "the month's text limit is 0, so texts are off");
  const key = row.recipient_key.startsWith("text:") ? row.recipient_key.slice(5) : "";
  if (key && (await suppressed(db, "text", key))) {
    return settle("stopped", "the number replied STOP");
  }
  // Their choices, asked again at the moment of sending (ADR 0675): texts of this kind turned off
  // or stopped since it was prepared.
  if (row.recipient_person_id) {
    const refused = await registerRefusal(db, {
      person: row.recipient_person_id,
      channel: "text",
      purpose: kind.spec.purpose ?? "account",
      kind: kind.id,
    });
    if (refused && !refused.send) return settle("stopped", refused.detail);
  }
  const business = settings.senderName?.trim() ?? "";
  const price = settings.textSegmentPriceMinor;
  if (!business)
    return settle("failed", "set the name texts begin with (Settings → Routine email)");
  if (!price) {
    return settle("failed", "set the price of one text segment (Settings → Routine email)");
  }
  const segments = Math.max(1, row.segments ?? 1);
  const send = (spend: RoutineTextRow["spend"]): ClaimedText => ({
    status: "send",
    row: {
      id: row.id,
      kind: row.kind,
      routine: from === "ready" && row.routine === 1,
      heldReason: row.held_reason,
      automationId: row.automation_id,
      runId: row.run_id,
      extensionId: row.extension_id,
      to: row.recipient,
      text: row.body as string,
      business,
      spend,
      from,
    },
  });
  if (stale) {
    // Claimed again, with what the first try reserved; one claim of it wins.
    const again = await db
      .updateTable("core_routine_mail")
      .set({ updated_at: now, connection_id: connectionId })
      .where("id", "=", id)
      .where("status", "=", "sending")
      .where("updated_at", "=", row.updated_at)
      .executeTakeFirst();
    if (!Number(again.numUpdatedRows)) return null;
    return send({
      month: reservedMonth ?? textMonth(now, settings.quietZone),
      segments,
      cost: row.cost_minor ?? 0,
    });
  }
  const cost = segments * price;
  const month = textMonth(now, settings.quietZone);
  const day = new Date(Date.parse(now) - DAY_MS).toISOString();
  let claim = db
    .updateTable("core_routine_mail")
    .set({
      status: "sending",
      claimed_at: now,
      cost_minor: cost,
      connection_id: connectionId,
      updated_at: now,
    })
    .where("id", "=", id)
    .where("status", "=", current);
  if (current === "ready") {
    // Within the number's day: five texts, counted in the statement that claims it.
    claim = claim.where((eb) =>
      eb(
        eb
          .selectFrom("core_routine_mail as o")
          .select((o) => o.fn.countAll<number>().as("n"))
          .where("o.channel", "=", "text")
          .where("o.recipient_key", "=", row.recipient_key)
          .where("o.claimed_at", ">", day)
          .where("o.id", "!=", id),
        "<",
        TEXTS_PER_DAY,
      ),
    );
  } else {
    claim = claim.where("pending_action_id", "is", null);
  }
  const claimed = await claim.executeTakeFirst();
  if (Number(claimed.numUpdatedRows) === 0) {
    if (current !== "ready") return null;
    // Still ready, so over the number's day: held for a person, as an email over its cap is.
    const held = await db
      .updateTable("core_routine_mail")
      .set({
        status: "held",
        routine: 0,
        held_reason: `the number has had ${TEXTS_PER_DAY} texts today`,
        updated_at: now,
      })
      .where("id", "=", id)
      .where("status", "=", "ready")
      .executeTakeFirst();
    return Number(held.numUpdatedRows) ? { status: "held" } : null;
  }
  // The row is this claim's alone now: its cost against the month's limit, in one statement.
  const spent = await reserveSpend(db, month, segments, cost, limit, now);
  if (spent === null) {
    await db
      .updateTable("core_routine_mail")
      .set({
        status: "over_limit",
        updated_at: now,
        subject: null,
        body: null,
        recipient: "",
        cost_minor: null,
        error: "this month's text limit is reached",
      })
      .where("id", "=", id)
      .where("status", "=", "sending")
      .execute();
    await tellAdmins(
      db,
      "Texts reached this month's limit",
      `This month's texts have reached the limit set in Settings → Routine email. Texts stop until the month turns or the limit is raised; emails carry on.`,
      `routine-text.limit:${now.slice(0, 10)}`,
      now,
    );
    return { status: "over_limit" };
  }
  // At 80%: told once a month (the notice's key), however the spend got there.
  if (spent >= limit * 0.8) {
    await tellAdmins(
      db,
      "Texts are at 80% of this month's limit",
      "This month's texts have used 80% of the limit set in Settings → Routine email. At the limit, texts stop until the month turns; emails carry on.",
      `routine-text.80:${month}`,
      now,
    );
  }
  return send({ month, segments, cost });
}

/** Records what became of a claimed text; its words and number are cleared once it is decided. */
export async function settleRoutineText(
  db: Db,
  row: RoutineTextRow,
  outcome:
    | { status: "sent" | "denied" }
    | { status: "waiting"; pendingActionId: string }
    /** `refund`: refused before anything was sent, so its reservation goes back. */
    | { status: "failed"; error: string; refund?: boolean }
    /** Not handed over (a full pending pool, the gatekeeper refused): back as it was, to retry. */
    | { status: "back"; error: string },
  now = new Date().toISOString(),
): Promise<void> {
  const refund =
    outcome.status === "back" ||
    outcome.status === "denied" ||
    (outcome.status === "failed" && outcome.refund === true);
  if (refund) {
    await refundSpend(db, row.spend.month, row.spend.segments, row.spend.cost, now);
  }
  if (outcome.status === "back") {
    await db
      .updateTable("core_routine_mail")
      .set({
        status: row.from,
        claimed_at: null,
        cost_minor: null,
        error: outcome.error.slice(0, 1000),
        updated_at: now,
      })
      .where("id", "=", row.id)
      .where("status", "=", "sending")
      .execute();
    return;
  }
  await db
    .updateTable("core_routine_mail")
    .set({
      status: outcome.status,
      updated_at: now,
      subject: null,
      body: null,
      recipient: "",
      ...(refund ? { cost_minor: null } : {}),
      ...("pendingActionId" in outcome ? { pending_action_id: outcome.pendingActionId } : {}),
      ...("error" in outcome ? { error: outcome.error.slice(0, 1000) } : {}),
    })
    .where("id", "=", row.id)
    .execute();
}

// ---------------------------------------------------------------------------------------------
// The text gatekeeper's verified events

/** A verified event as the text gatekeeper delivers it (its `TextEvent`), read defensively. */
export type TextGatekeeperEvent =
  | {
      kind: "receipt";
      ref: string | null;
      providerRef: string;
      status: "delivered" | "failed";
      at: string;
      costMinor?: number;
    }
  | {
      kind: "reply";
      from: string;
      keyword: "stop" | "start" | "help";
      at: string;
      answeredSegments?: number;
    };

function parseEvent(input: unknown): TextGatekeeperEvent | null {
  if (!input || typeof input !== "object") return null;
  const e = input as Record<string, unknown>;
  const at = typeof e.at === "string" && Number.isFinite(Date.parse(e.at)) ? e.at : null;
  if (!at) return null;
  if (e.kind === "receipt") {
    if (typeof e.providerRef !== "string" || (e.status !== "delivered" && e.status !== "failed")) {
      return null;
    }
    return {
      kind: "receipt",
      ref: typeof e.ref === "string" ? e.ref : null,
      providerRef: e.providerRef.slice(0, 200),
      status: e.status,
      at,
      ...(Number.isSafeInteger(e.costMinor) && (e.costMinor as number) >= 0
        ? { costMinor: e.costMinor as number }
        : {}),
    };
  }
  if (e.kind === "reply") {
    if (typeof e.from !== "string" || !/^\+[1-9]\d{7,14}$/.test(e.from)) return null;
    if (e.keyword !== "stop" && e.keyword !== "start" && e.keyword !== "help") return null;
    return {
      kind: "reply",
      from: e.from,
      keyword: e.keyword,
      at,
      ...(Number.isSafeInteger(e.answeredSegments) && (e.answeredSegments as number) > 0
        ? { answeredSegments: e.answeredSegments as number }
        : {}),
    };
  }
  return null;
}

/**
 * Applies one verified event from the text gatekeeper: a receipt settles its row (`delivered` or
 * `failed`) and adds what the provider charged to the month's reported spend; STOP stops every
 * text to the number, START lifts it; HELP's answer counts against the month's spend. Returns
 * what it did, never the number.
 */
export async function applyTextEvent(
  db: Db,
  input: unknown,
  now = new Date().toISOString(),
): Promise<"delivered" | "failed" | "stopped" | "started" | "help" | "ignored"> {
  const event = parseEvent(input);
  if (!event) return "ignored";
  if (event.kind === "receipt") {
    const id = event.ref?.startsWith("routine:") ? event.ref.slice("routine:".length) : null;
    if (!id) return "ignored";
    const row = await db
      .selectFrom("core_routine_mail")
      .select(["claimed_at", "status"])
      .where("id", "=", id)
      .where("channel", "=", "text")
      .executeTakeFirst();
    if (!row) return "ignored";
    await db
      .updateTable("core_routine_mail")
      .set({
        status: event.status,
        provider_ref: event.providerRef,
        ...(event.status === "delivered"
          ? { delivered_at: event.at, error: null }
          : { error: "the provider could not deliver it" }),
        updated_at: now,
      })
      .where("id", "=", id)
      .where("status", "in", ["sending", "sent", "waiting", "delivered", "failed"])
      .execute();
    if (event.costMinor !== undefined && row.claimed_at) {
      const settings = await loadRoutineMailSettings(db);
      const month = textMonth(row.claimed_at, settings.quietZone);
      await reserveSpend(db, month, 0, 0, null, now);
      await db
        .updateTable("core_text_spend")
        .set({ reported_minor: sql`reported_minor + ${event.costMinor}`, updated_at: now })
        .where("month", "=", month)
        .execute();
    }
    return event.status;
  }
  const hash = await numberHash(db, event.from);
  if (event.keyword === "stop") {
    await suppress(db, "text", hash, "stop_reply", event.at);
    return "stopped";
  }
  if (event.keyword === "start") {
    await unsuppress(db, "text", hash);
    return "started";
  }
  if (event.answeredSegments) {
    const settings = await loadRoutineMailSettings(db);
    const price = settings.textSegmentPriceMinor ?? 0;
    await reserveSpend(
      db,
      textMonth(now, settings.quietZone),
      event.answeredSegments,
      event.answeredSegments * price,
      null,
      now,
    );
  }
  return "help";
}

// ---------------------------------------------------------------------------------------------
// Handing ready texts to the integration host

/** The org text connection and its sender resource, or null when none is set up and bound. */
export async function textTarget(
  db: Db,
): Promise<{ connectionId: string; resource: string } | null> {
  const rows = await db
    .selectFrom("core_integration_connection")
    .select(["id", "resources"])
    .where("vendor", "=", "text")
    .where("scope", "=", "org")
    .where("status", "=", "active")
    .orderBy("created_at")
    .limit(5)
    .execute();
  for (const row of rows) {
    try {
      const resources = JSON.parse(row.resources) as { key?: unknown; pattern?: unknown }[];
      const bound = Array.isArray(resources)
        ? resources.find((r) => r.pattern === TEXT_SENDER_URL && typeof r.key === "string")
        : undefined;
      if (bound) return { connectionId: row.id, resource: bound.key as string };
    } catch {}
  }
  return null;
}

/** How many texts the send step hands over a call. */
const SEND_BATCH = 50;

/**
 * Hands each text that may go now to the integration host (the minute cron, and right after a
 * message is prepared): rows `ready` (just prepared, released at the end of quiet hours, back
 * after a full pending pool) and held ones not yet put to a person. A full pending pool stops the
 * step: the rest wait for the next minute (back-pressure, never a drop).
 */
export async function sendReadyTexts(
  deps: { db: Db; integrations: IntegrationRuntime | undefined },
  options: { ids?: readonly string[]; now?: string } = {},
): Promise<{ sent: number; waiting: number; other: number }> {
  const out = { sent: 0, waiting: 0, other: 0 };
  const send = deps.integrations?.sendRoutineText;
  if (!send) return out;
  const now = options.now ?? new Date().toISOString();
  if (options.ids && !options.ids.length) return out;
  let query = deps.db
    .selectFrom("core_routine_mail")
    .select("id")
    // Literals, so the planner sees the partial index's own condition (migration 0911): an idle
    // minute reads it, never the table.
    .where(sql<boolean>`channel = 'text' AND status IN ('ready', 'held')`)
    .where("pending_action_id", "is", null)
    .where((eb) => eb.or([eb("wait_until", "is", null), eb("wait_until", "<=", now)]))
    .orderBy("updated_at")
    .limit(SEND_BATCH);
  if (options.ids) query = query.where("id", "in", options.ids.slice(0, SEND_BATCH));
  const rows = await query.execute();
  // And texts a host left sending when it stopped (the review of PR #435).
  const cutoff = new Date(Date.parse(now) - STALE_SENDING_MS).toISOString();
  let stale = deps.db
    .selectFrom("core_routine_mail")
    .select("id")
    .where(sql<boolean>`channel = 'text' AND status = 'sending'`)
    .where("updated_at", "<=", cutoff)
    .orderBy("updated_at")
    .limit(SEND_BATCH);
  if (options.ids) stale = stale.where("id", "in", options.ids.slice(0, SEND_BATCH));
  rows.push(...(await stale.execute()));
  if (!rows.length) return out;
  const target = await textTarget(deps.db);
  if (!target) return out;
  for (const row of rows) {
    try {
      const outcome = await send({ ...target, id: row.id });
      if (outcome.status === "sent") out.sent += 1;
      else if (outcome.status === "waiting") out.waiting += 1;
      else out.other += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`routine text ${row.id}: ${message.slice(0, 200)}`);
      // A full pool: the rest wait for room.
      if (message.includes("Too many pending")) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Checking a number by code (me.phone.startCheck / me.phone.check)

/**
 * Whether a code may be sent to `number` for `personId` now: at most three a day for the Person
 * and three a day for the number, whoever asks. Counted and written in one statement, so calls at
 * once cannot pass either (the review of PR #435).
 */
export async function startPhoneCheck(
  db: Db,
  personId: string,
  number: string,
  now: string,
): Promise<{ id: string; hash: string } | { refused: string }> {
  const hash = await numberHash(db, number);
  if (await suppressed(db, "text", hash))
    return { refused: "this number replied STOP to our texts: reply START from it first" };
  const day = new Date(Date.parse(now) - DAY_MS).toISOString();
  const id = newId("phoneCheck");
  const written = await db
    .insertInto("core_phone_check")
    .columns(["id", "person_id", "number", "number_hash", "started_at"])
    .expression(
      sql`SELECT ${id}, ${personId}, ${number}, ${hash}, ${now}
        WHERE (SELECT COUNT(*) FROM core_phone_check
                WHERE person_id = ${personId} AND started_at > ${day}) < ${CODES_PER_DAY}
          AND (SELECT COUNT(*) FROM core_phone_check
                WHERE number_hash = ${hash} AND started_at > ${day}) < ${CODES_PER_DAY}`,
    )
    .returning("id")
    .executeTakeFirst();
  if (!written) {
    return { refused: `at most ${CODES_PER_DAY} codes a day` };
  }
  return { id, hash };
}

/** Tries a code may be typed for one check, here whatever the provider allows. */
export const CODE_TRIES = 3;

/**
 * Counts one try at the open check `id`; false once it has had its tries, so a code cannot be
 * guessed at the host whatever the provider allows.
 */
export async function countCodeTry(db: Db, id: string): Promise<boolean> {
  const counted = await db
    .updateTable("core_phone_check")
    .set({ tries: sql`tries + 1` })
    .where("id", "=", id)
    .where("tries", "<", CODE_TRIES)
    .executeTakeFirst();
  return Number(counted.numUpdatedRows) > 0;
}
