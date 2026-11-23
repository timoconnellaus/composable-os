// Routine mail (ADR 0590): a shipped pack's declared emails, sent by the host without a person's
// approval. This is the host's half: what may be sent, to whom, saying what, and whether it is
// routine or held for a person. The runner's `codemode:routine-mail` calls `prepareRoutineMail`
// from an automation run; each row it writes is then sent by the integration host's `callAsHost`
// with purpose `routine-mail`, which reads the row (never the caller's words) and marks the queue
// so the gate and the email gatekeeper can tell (`submitOutbound`, email-send's `routine.ts`).
//
// Where each rule is enforced:
// - only a shipped, active extension's declared kind, from an automation of that extension: here
//   (`prepareRoutineMail`) from `core_extensions` and `core_automation_runs`, never from what the
//   code says; and the contract check refuses `routineMail` in a runtime extension (install.ts);
// - the recipient: here, from the record's declared customer Person, their live guardians, or a
//   paid order's own address; the caller names a record, never an address;
// - the words: the declaration's, with slots the host fills from the record and checks
//   (`unroutineText`); a pack passes only declared choices, a moment, a count or a flag;
// - links: only a declared link slot, only to the business's own site (the setting below);
// - held for a person: a value not routine, a slot left empty, the daily cap per recipient, a run
//   started by hand or replayed, a change an AI made that no person approved;
// - the switch per kind: here (`off` rows send nothing and queue nothing).

import type { CoreDatabase } from "@composable-os/db";
import {
  calendarsOf,
  formatMoment,
  formatMoney,
  parseTemplate,
  ROUTINE_ABOUT_ORDER,
  ROUTINE_DAILY_CAP,
  ROUTINE_MEMBER_SLOT,
  type RoutineFieldSlotManifest,
  type RoutineMailKindManifest,
  type RoutineMessageManifest,
  type RoutineSlotManifest,
  renderTemplate,
  unroutineText,
} from "@composable-os/sdk";
import type { Insertable, Kysely } from "kysely";
import { z } from "zod";
import { ADJUDICATOR_PRINCIPAL } from "../adjudicator/review.ts";
import { mailboxKey } from "../customers/limits.ts";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { newId } from "../ids.ts";
import { notifyStatements } from "../notifications/send.ts";
import { loadRecord } from "../operations/record.ts";
import { staffPrincipal } from "../principals.ts";
import { viewColumnOf } from "../records/columns.ts";
import { extensionSettingValues } from "../records/windows.ts";
import { visibleSource } from "../visibility/index.ts";
import { CREATED, type Standing, valueHash } from "./marks.ts";

type Db = Kysely<CoreDatabase>;
type Values = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// The settings: the switch per kind and the business's own site. A person's to change.

export const ROUTINE_MAIL_SETTING = "routine_mail";

/** Most routine emails the whole organisation sends in a rolling day, unless an admin chose. */
export const ROUTINE_ORG_DAILY_CAP = 2_000;
/** How long the routine email log is kept, in months, unless an admin chose. */
export const ROUTINE_LOG_MONTHS = 12;

export const routineMailSettingsSchema = z.object({
  /**
   * Extension id → routine email turned on (ADR 0590, the coordinator's D1): off until a human
   * admin turns it on once; until then its emails are ordinary sends, decided by the policy.
   */
  packs: z.record(z.string().max(40), z.boolean()).default({}),
  /** Kind id (`bookings.reminder`) → on or off, where an admin chose; else the pack's default. */
  kinds: z.record(z.string().max(80), z.boolean()).default({}),
  /** The business's own site (`https://gym.example`): the only place a routine email links to. */
  siteOrigin: z.string().max(200).nullable().default(null),
  /** Routine emails the organisation sends in a rolling day before the rest wait for a person. */
  orgDailyCap: z.number().int().min(1).max(100_000).default(ROUTINE_ORG_DAILY_CAP),
  /** Months the log is kept. */
  retentionMonths: z.number().int().min(1).max(84).default(ROUTINE_LOG_MONTHS),
});
export type RoutineMailSettings = z.infer<typeof routineMailSettingsSchema>;

const DEFAULT_SETTINGS: RoutineMailSettings = {
  packs: {},
  kinds: {},
  siteOrigin: null,
  orgDailyCap: ROUTINE_ORG_DAILY_CAP,
  retentionMonths: ROUTINE_LOG_MONTHS,
};

export async function loadRoutineMailSettings(db: Db): Promise<RoutineMailSettings> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", ROUTINE_MAIL_SETTING)
    .executeTakeFirst();
  try {
    const parsed = routineMailSettingsSchema.safeParse(row ? JSON.parse(row.value) : {});
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * The admins' notice that an extension's routine email is available and off (D1): written when
 * the extension is installed or upgraded while it is not turned on. Once per extension.
 */
export async function routineMailAvailableNotice(
  db: Db,
  extensionId: string,
  label: string,
  now: string,
) {
  const settings = await loadRoutineMailSettings(db);
  if (settings.packs[extensionId] === true) return [];
  const plan = await notifyStatements(
    db,
    {
      to: [{ role: "admin" }],
      type: "system.message",
      title: `Routine email for ${label} is available, and off`,
      body:
        `${label} can send its members' fixed emails (confirmations, changes, cancellations, ` +
        "reminders) without approval once a human admin turns it on in Settings → Routine " +
        "email. Until then each one waits for approval, as before.",
      dedupeKey: `routine-mail.available:${extensionId}`,
      source: { actor: "system" },
    },
    now,
  );
  return plan.statements;
}

/** An https origin with no path, credentials or port games, or null. */
export function siteOriginOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** A link a routine email may carry: https, on the site, no credentials; else null. */
export function siteLink(value: unknown, siteOrigin: string | null): string | null {
  if (!siteOrigin || typeof value !== "string" || value.length > 500) return null;
  try {
    const url = new URL(value);
    if (url.origin !== siteOrigin || url.username || url.password) return null;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
    if (/[\s<>"\u0000-\u001f]/.test(value)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The declared kinds

export interface RoutineKind {
  /** `<extension>.<kind>`. */
  id: string;
  extensionId: string;
  extensionLabel: string;
  name: string;
  spec: RoutineMailKindManifest;
  /** The kind's own switch. */
  on: boolean;
  /** The extension's routine email turned on by a human admin (D1). */
  packOn: boolean;
}

/** Every kind a shipped, active extension declares, with whether it is on now. */
export async function routineKinds(db: Db): Promise<RoutineKind[]> {
  const [rows, settings] = await Promise.all([
    db
      .selectFrom("core_extensions")
      .select(["id", "manifest", "source", "status"])
      .where("source", "=", "shipped")
      .where("status", "=", "active")
      .orderBy("id")
      .execute(),
    loadRoutineMailSettings(db),
  ]);
  const out: RoutineKind[] = [];
  for (const row of rows) {
    let manifest: { label?: string; routineMail?: Record<string, RoutineMailKindManifest> };
    try {
      manifest = JSON.parse(row.manifest);
    } catch {
      continue;
    }
    for (const [name, spec] of Object.entries(manifest.routineMail ?? {})) {
      const id = `${row.id}.${name}`;
      out.push({
        id,
        extensionId: row.id,
        extensionLabel: manifest.label ?? row.id,
        name,
        spec,
        on: settings.kinds[id] ?? spec.on !== false,
        packOn: settings.packs[row.id] === true,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Preparing a send

const sendInput = z
  .object({
    kind: z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/),
    record: z.string().min(1).max(64),
    message: z
      .string()
      .regex(/^[a-z][a-zA-Z0-9]{0,39}$/)
      .optional(),
    values: z
      .record(z.string().max(40), z.union([z.string().max(64), z.number(), z.boolean()]))
      .optional(),
  })
  .strict();

/** Triggers whose runs may send routine mail: what happened to a record, or the clock. */
const ROUTINE_TRIGGERS = new Set(["record", "fieldChanged", "dateRelative", "schedule"]);
const AI_ACTORS = new Set(["assistant", "mcp"]);

export interface PreparedRoutineMail {
  kind: string;
  off: boolean;
  /** Rows to hand the integration host now (`ready`, or `sending` after a crash). */
  toSend: { id: string; routine: boolean }[];
  /** Rows a retried step had already decided. */
  done: { id: string; status: string; routine: boolean }[];
  none: boolean;
}

interface Recipient {
  address: string;
  rule: "person" | "guardian" | "order";
  personId: string | null;
  /** The record's own person (or the paying visitor), not a guardian. */
  self: boolean;
  /** Why an email to this address is not routine (an unpaid order's typed address). */
  held?: string;
}

const ADDRESS = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/i;

function text(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value);
}

/** A record of an object, by registry name, as the host reads it (live rows only). */
class Records {
  readonly #db: Db;
  readonly #cache = new Map<string, Promise<Values | null>>();
  /** Every record read for the email, for its related records. */
  readonly read = new Set<string>();
  /** The fields that fed the email, by record: who last wrote each is checked (B2). */
  readonly sources = new Map<string, { object: string; id: string; fields: Set<string> }>();
  note(object: string, id: unknown, field: string): void {
    if (typeof id !== "string") return;
    const key = `${object}:${id}`;
    const found = this.sources.get(key) ?? { object, id, fields: new Set<string>() };
    found.fields.add(field);
    this.sources.set(key, found);
  }
  constructor(db: Db) {
    this.#db = db;
  }

  get(object: string, id: string): Promise<Values | null> {
    const key = `${object}:${id}`;
    let found = this.#cache.get(key);
    if (!found) {
      found = this.#load(object, id);
      this.#cache.set(key, found);
    }
    return found;
  }

  async #load(object: string, id: string): Promise<Values | null> {
    if (object === ROUTINE_ABOUT_ORDER) {
      const row = await this.#db
        .selectFrom("core_order")
        .select([
          "id",
          "email",
          "paid",
          "total",
          "currency",
          "balance_due_at",
          "state",
          "placed_as",
          "person_id",
        ])
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) return null;
      this.read.add(id);
      return {
        id: row.id,
        email: row.email,
        paid: Number(row.paid),
        total: Number(row.total),
        balance: Math.max(0, Number(row.total) - Number(row.paid)),
        currency: row.currency,
        balanceDueAt: row.balance_due_at,
        state: row.state,
        placedAs: row.placed_as,
        personId: row.person_id,
      };
    }
    const definition = getObject(object);
    if (!definition?.extension) return null;
    const record = await loadRecord(
      { db: this.#db, principal: staffPrincipal({ id: "system", role: "admin" }) },
      definition,
      id,
    );
    if (!record) return null;
    this.read.add(id);
    return { id: record.id, ...record.values };
  }
}

/** The object a relation field points to, by registry name. */
function targetOf(object: string, field: string): string | null {
  const definition = object === ROUTINE_ABOUT_ORDER ? undefined : getObject(object);
  const found = definition?.fields.find((f) => f.name === field);
  return found?.options?.to ?? null;
}

/** The value at `path` from a record, walking relations; undefined when a record on the way is missing. */
async function walk(
  records: Records,
  object: string,
  record: Values,
  path: string,
): Promise<unknown> {
  const segments = path.split(".");
  let currentObject = object;
  let current: Values | null = record;
  for (const [i, segment] of segments.entries()) {
    if (!current) return undefined;
    const value = current[segment];
    if (i === segments.length - 1) {
      records.note(currentObject, current.id, segment);
      return value;
    }
    const id = text(value);
    const to = targetOf(currentObject, segment);
    if (!id || !to) return undefined;
    currentObject = to;
    current = await records.get(to, id);
  }
  return undefined;
}

/** Why a value cannot be routine, collected while filling the slots. */
interface Fill {
  values: Record<string, string | null>;
  problems: string[];
}

function zoneOf(value: unknown): string | null {
  const zone = text(value);
  return zone && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(zone) ? zone : null;
}

async function fieldSlot(
  records: Records,
  object: string,
  record: Values,
  name: string,
  slot: RoutineFieldSlotManifest,
  fill: Fill,
): Promise<void> {
  const raw = await walk(records, object, record, slot.field);
  if (raw === null || raw === undefined || raw === "") {
    fill.values[name] = null;
    if (!slot.optional) fill.problems.push(`${name} is empty`);
    return;
  }
  const format = slot.format ?? "text";
  if (format === "text") {
    const value = String(raw);
    const why = unroutineText(value, slot.max ?? 120);
    fill.values[name] = value;
    if (why) fill.problems.push(`${name} holds ${why}`);
    return;
  }
  if (format === "money") {
    const currency = slot.currency ? await walk(records, object, record, slot.currency) : null;
    const value = formatMoney(Number(raw), String(currency ?? ""));
    fill.values[name] = value;
    if (!value) fill.problems.push(`${name} is not an amount`);
    return;
  }
  if (format === "count") {
    const n = Number(raw);
    fill.values[name] = Number.isInteger(n) ? String(n) : null;
    if (!Number.isInteger(n)) fill.problems.push(`${name} is not a whole number`);
    return;
  }
  const zone = slot.zone ? zoneOf(await walk(records, object, record, slot.zone)) : null;
  const value = formatMoment(String(raw), zone, format, slot.year === true);
  fill.values[name] = value;
  if (!value) fill.problems.push(`${name} is not a time`);
}

/** A pack's value for a slot it may fill; refuses anything else (a pack's mistake, not data). */
function packValue(
  name: string,
  slot: RoutineSlotManifest,
  value: string | number | boolean | undefined,
  zone: string | null,
  guardian: boolean,
): string | null {
  const refuse = (why: string): never => {
    throw new ValidationError(`Routine mail slot ${name}: ${why}`, { slot: name });
  };
  if ("choice" in slot) {
    if (value === undefined) refuse("pass one of its choices");
    const key = String(value);
    if (!Object.hasOwn(slot.choice, key)) refuse(`"${key}" is not one of its choices`);
    return (guardian ? slot.guardian?.[key] : undefined) ?? (slot.choice[key] as string);
  }
  if ("at" in slot) {
    if (value === undefined || value === null || value === "") {
      if (!slot.optional) refuse("pass a moment");
      return null;
    }
    const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
    if (!Number.isFinite(ms) || Math.abs(ms - Date.now()) > 2 * 366 * 86_400_000) {
      refuse("pass an ISO moment within two years");
    }
    return formatMoment(new Date(ms).toISOString(), zone, "datetime", slot.year === true);
  }
  if ("count" in slot) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      refuse("pass a whole number");
    }
    if ((value as number) > slot.count.max) refuse(`at most ${slot.count.max}`);
    return String(value);
  }
  if ("flag" in slot) {
    if (value !== undefined && typeof value !== "boolean") refuse("pass true or false");
    return value === true ? "" : null;
  }
  return refuse("is filled by the host");
}

/** Who a record's routine email goes to: the host's rule, never the caller's. */
async function recipientsOf(
  db: Db,
  records: Records,
  object: string,
  record: Values,
): Promise<{ recipients: Recipient[]; memberName: string | null; personId: string | null }> {
  const out: Recipient[] = [];
  const seen = new Set<string>();
  const add = (address: string | null | undefined, r: Omit<Recipient, "address">) => {
    const a = text(address)?.trim().toLowerCase();
    if (!a || !ADDRESS.test(a) || seen.has(a)) return;
    seen.add(a);
    out.push({ address: a, ...r });
  };
  const paidOrder = async (orderId: string | null) => {
    if (!orderId) return;
    const order = await records.get(ROUTINE_ABOUT_ORDER, orderId);
    if (!order) return;
    const recipient = await routineOrderRecipient(db, order);
    if (recipient)
      add(recipient.address, { rule: "order", personId: null, self: true, ...recipient });
  };
  if (object === ROUTINE_ABOUT_ORDER) {
    await paidOrder(text(record.id));
    return { recipients: out, memberName: null, personId: text(record.personId) };
  }
  const definition = getObject(object);
  const personField = definition?.customer?.field;
  const personId = personField ? text(record[personField]) : null;
  if (!personId) {
    // A visitor's paid drop-in, held with no Person (ADR 0560): the order's own address.
    const moves = definition?.sellable?.moves;
    if (moves?.guest && moves.order) await paidOrder(text(record[moves.order]));
    return { recipients: out, memberName: null, personId: null };
  }
  const person = await livePerson(db, personId);
  if (!person) return { recipients: out, memberName: null, personId };
  add(person.email, { rule: "person", personId, self: true });
  // The family link (ADR 0540): each live guardian, where the object opens to guardians.
  if (definition?.customer?.guardians) {
    const links = await db
      .selectFrom("core_person_link")
      .select("guardian_id")
      .where("dependant_id", "=", personId)
      .where("ended_at", "is", null)
      .orderBy("created_at")
      .limit(10)
      .execute();
    for (const link of links) {
      const guardian = await livePerson(db, link.guardian_id);
      if (guardian)
        add(guardian.email, { rule: "guardian", personId: link.guardian_id, self: false });
    }
  }
  return { recipients: out, memberName: person.name, personId };
}

/**
 * The address an order's routine email may go to (D2): the order's own address once a payment
 * was applied (ADR 0560); for a signed-in customer's free order, their own verified sign-in
 * address; otherwise the address a visitor typed, which is not routine (held for a person).
 */
export async function routineOrderRecipient(
  db: Db,
  order: { email?: unknown; paid?: unknown; placedAs?: unknown; personId?: unknown },
): Promise<{ address: string; held?: string } | null> {
  const email = text(order.email);
  if (Number(order.paid) > 0) return email ? { address: email } : null;
  if (order.placedAs === "customer" && typeof order.personId === "string") {
    const customer = await db
      .selectFrom("core_customer")
      .select("email")
      .where("person_id", "=", order.personId)
      .where("email_verified", "=", 1)
      .executeTakeFirst();
    if (customer?.email) return { address: customer.email };
  }
  return email
    ? {
        address: email,
        held: "nothing was paid on the order, so its address is one a visitor typed",
      }
    : null;
}

/** Whether a person decided a pending action: a human account, not the adjudicator or code. */
const PERSON_DECIDED = (decidedBy: string | null, kind: string | null) =>
  decidedBy !== null && decidedBy !== ADJUDICATOR_PRINCIPAL && kind === "human";

/** A value an email showed: object, record, field and the value's hash. */
interface Shown {
  o: string;
  r: string;
  f: string;
  h: string;
}

/** Whether `address` is the Person's own verified customer sign-in address (their own). */
async function verifiedAddress(db: Db, personId: string, address: string): Promise<boolean> {
  const row = await db
    .selectFrom("core_customer")
    .select("email")
    .where("person_id", "=", personId)
    .where("email_verified", "=", 1)
    .executeTakeFirst();
  return Boolean(row?.email && row.email.trim().toLowerCase() === address.trim().toLowerCase());
}

/** A person not in the Trash and not merged away: their primary address and name. */
async function livePerson(
  db: Db,
  id: string,
): Promise<{ email: string | null; name: string | null } | null> {
  const person = await db
    .selectFrom("core_person")
    .select(["display_name", "deleted_at", "merged_into_id"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!person || person.deleted_at || person.merged_into_id) return null;
  const email = await db
    .selectFrom("core_person_emails")
    .select("email")
    .where("person_id", "=", id)
    .orderBy("is_primary", "desc")
    .orderBy("position", "asc")
    .limit(1)
    .executeTakeFirst();
  return { email: email?.email ?? null, name: text(person.display_name) };
}

/** What started the run: the change's actor, or the clock. */
async function startedBy(
  db: Db,
  rootEventId: string | null,
): Promise<{ actor: string; userId: string | null; approved: boolean } | null> {
  if (!rootEventId) return null;
  const audit = await db
    .selectFrom("core_audit as a")
    .leftJoin("core_pending_action as p", "p.id", "a.pending_action_id")
    .leftJoin("core_user as u", "u.id", "p.decided_by")
    .select(["a.actor", "a.user_id", "p.decided_by", "u.kind"])
    .where("a.id", "=", rootEventId)
    .executeTakeFirst();
  if (!audit) return null;
  // Approved by a person: a human account decided it, never the adjudicator (F1).
  return {
    actor: audit.actor,
    userId: audit.user_id,
    approved: PERSON_DECIDED(audit.decided_by, audit.kind ?? null),
  };
}

/**
 * Whether `named` is the run's record, points at it (a class's booking, an order's drop-in), or
 * is a record of the same object pointing, by a relation to one of the extension's own objects,
 * at the same record as the run's (another booking of the same class: a place free to the
 * waiting list). Sharing a class type, a pass or a person is not enough.
 */
function tiedToTrigger(
  extensionId: string,
  named: { object: string; values: Values },
  trigger: { object: string; id: string; values: Values | null },
): boolean {
  if (named.object === trigger.object && named.values.id === trigger.id) return true;
  if (Object.entries(named.values).some(([k, v]) => k !== "id" && v === trigger.id)) return true;
  if (!trigger.values || named.object !== trigger.object) return false;
  const values = trigger.values;
  return (getObject(named.object)?.fields ?? []).some((f) => {
    const to = f.options?.to;
    const value = named.values[f.name];
    return (
      typeof to === "string" &&
      to.startsWith(`${extensionId}.`) &&
      to !== named.object &&
      typeof value === "string" &&
      value === values[f.name]
    );
  });
}

/** Seconds since 2020: a calendar SEQUENCE that grows with each change (ADR 0572). */
const sequenceNow = () => Math.floor(Date.now() / 1000) - 1_577_836_800;

export interface PrepareRoutineMailInput {
  extensionId: string;
  automationId: string;
  runId: string;
  /** The email-send connection the automation's slot is bound to (the person's consent). */
  connectionId: string;
  send: unknown;
  now?: string;
}

/**
 * Decides one routine send and writes its rows (one per recipient). Throws a ForbiddenError for
 * a caller that may not send routine mail at all (not a shipped extension's automation run, a kind
 * it does not declare, a record the run is not about) and a ValidationError for a pack's mistake.
 */
export async function prepareRoutineMail(
  db: Db,
  input: PrepareRoutineMailInput,
): Promise<PreparedRoutineMail> {
  const now = input.now ?? new Date().toISOString();
  const parsed = sendInput.safeParse(input.send);
  if (!parsed.success) {
    throw new ValidationError(`Invalid routine mail: ${z.prettifyError(parsed.error)}`);
  }
  const send = parsed.data;

  // Who is asking: a shipped, active extension, in a run of one of its own automations.
  const extension = await db
    .selectFrom("core_extensions")
    .select(["source", "status", "manifest"])
    .where("id", "=", input.extensionId)
    .executeTakeFirst();
  if (extension?.source !== "shipped" || extension.status !== "active") {
    throw new ForbiddenError("Only a shipped extension sends routine mail", {
      extension: input.extensionId,
    });
  }
  const manifest = JSON.parse(extension.manifest) as {
    automations?: Record<string, unknown>;
    routineMail?: Record<string, RoutineMailKindManifest>;
  };
  const prefix = `${input.extensionId}.`;
  const automationName = input.automationId.startsWith(prefix)
    ? input.automationId.slice(prefix.length)
    : null;
  if (!automationName || !manifest.automations?.[automationName]) {
    throw new ForbiddenError("Routine mail is sent only by the extension's own automations");
  }
  const run = await db
    .selectFrom("core_automation_runs")
    .select([
      "automation_id",
      "extension_id",
      "trigger",
      "record_object",
      "record_id",
      "root_event_id",
      "replay_of",
      "test",
    ])
    .where("id", "=", input.runId)
    .executeTakeFirst();
  if (
    !run ||
    run.automation_id !== input.automationId ||
    run.extension_id !== input.extensionId ||
    run.test === 1
  ) {
    throw new ForbiddenError("Routine mail is sent only from a recorded run of the automation");
  }
  const spec = manifest.routineMail?.[send.kind];
  if (!spec) {
    throw new ForbiddenError(`${input.extensionId} declares no routine mail "${send.kind}"`, {
      kind: send.kind,
    });
  }
  const kindId = `${input.extensionId}.${send.kind}`;
  const messageNames = Object.keys(spec.messages);
  const messageName = send.message ?? (messageNames.length === 1 ? messageNames[0] : undefined);
  const message = messageName ? spec.messages[messageName] : undefined;
  if (!messageName || !message) {
    throw new ValidationError(`Name one of ${kindId}'s messages: ${messageNames.join(", ")}`);
  }
  for (const key of Object.keys(send.values ?? {})) {
    const slot = spec.slots[key];
    if (!slot) throw new ValidationError(`${kindId} has no slot "${key}"`);
    // What the host reads from the record (a title, a time, a link) is never the pack's to say.
    if ("field" in slot || "link" in slot || "each" in slot) {
      throw new ValidationError(`${kindId}'s slot "${key}" is filled by the host`, { slot: key });
    }
  }

  // The record: of the kind's object, live, and what the run is about.
  const object =
    spec.about === ROUTINE_ABOUT_ORDER ? "order" : `${input.extensionId}.${spec.about}`;
  const records = new Records(db);
  const record = await records.get(object, send.record);
  if (!record) throw new NotFoundError(object, send.record);
  if (run.record_object && run.record_id) {
    const trigger = {
      object: run.record_object,
      id: run.record_id,
      values: await records.get(run.record_object, run.record_id),
    };
    if (!tiedToTrigger(input.extensionId, { object, values: record }, trigger)) {
      throw new ForbiddenError(
        `${send.record} is not a record this run is about (${run.record_object} ${run.record_id})`,
      );
    }
  }

  let trigger: { type?: string; originalRunId?: string; manual?: unknown } = {};
  try {
    trigger = JSON.parse(run.trigger) as typeof trigger;
  } catch {}
  const chain = text(trigger.originalRunId) ?? input.runId;
  const settings = await loadRoutineMailSettings(db);
  const on = settings.kinds[kindId] ?? spec.on !== false;
  // D1: until a human admin turns the extension's routine email on, its emails are ordinary sends.
  const packOn = settings.packs[input.extensionId] === true;

  // Why the whole send waits for a person, whoever it goes to.
  const held: string[] = [];
  // A run started by hand (a manual trigger) or replayed (automation.replay, which an AI may call:
  // it would send again) is never routine.
  const triggerType = trigger.manual ? "manual" : (text(trigger.type) ?? "unknown");
  if (!ROUTINE_TRIGGERS.has(triggerType)) held.push(`the run was started by ${triggerType}`);
  if (run.replay_of) held.push("the run is a replay");
  const by = await startedBy(db, run.root_event_id);
  if (by && AI_ACTORS.has(by.actor) && !by.approved) {
    held.push("an AI made the change that started it, and no person approved it");
  }

  const {
    recipients,
    memberName,
    personId: aboutPersonId,
  } = await recipientsOf(db, records, object, record);
  if (!recipients.length) return { kind: kindId, off: !on, toSend: [], done: [], none: true };

  // The slots the host fills, once for the record; the pack's values per audience.
  const fill: Fill = { values: {}, problems: [] };
  const site = siteOriginOf(settings.siteOrigin);
  const packSettings = await extensionSettingValues(db, input.extensionId);
  for (const [name, slot] of Object.entries(spec.slots)) {
    if ("field" in slot) await fieldSlot(records, object, record, name, slot, fill);
    else if ("link" in slot) {
      let link = siteLink(packSettings[slot.link], site);
      if (link && slot.withId) {
        const url = new URL(link);
        url.searchParams.set(slot.withId, send.record);
        link = url.toString();
      }
      fill.values[name] = link;
    } else if ("each" in slot) {
      fill.values[name] = await eachSlot(
        db,
        records,
        input.extensionId,
        name,
        slot,
        send.record,
        fill,
      );
    }
  }
  const zoneFor = async (slot: RoutineSlotManifest) =>
    "at" in slot && slot.zone ? zoneOf(await walk(records, object, record, slot.zone)) : null;
  const packValues = async (guardian: boolean) => {
    const out: Record<string, string | null> = {};
    for (const [name, slot] of Object.entries(spec.slots)) {
      if ("field" in slot || "link" in slot || "each" in slot) continue;
      out[name] = packValue(name, slot, send.values?.[name], await zoneFor(slot), guardian);
    }
    return out;
  };
  const selfValues = { ...fill.values, ...(await packValues(false)) };
  const member: Record<string, string | null> = { [ROUTINE_MEMBER_SLOT]: memberName };
  const memberProblem = memberName ? unroutineText(memberName, 80) : "the member has no name";
  const guardianValues = { ...fill.values, ...(await packValues(true)), ...member };

  const calendar = await calendarFor(records, object, record, message, selfValues, fill);

  // Default deny (ADR 0590, the second review): every value the email shows and every address it
  // goes to needs a host-kept mark that a person stands behind it, for the value it has now. No
  // mark, a mark for another value, the host's or an AI's, or any failure to read: held.
  const shown: Shown[] = [];
  const unmarked: string[] = [];
  try {
    const check = async (
      o: string,
      r: string,
      f: string,
      value: unknown,
      allowed: readonly Standing[],
      label: string,
    ) => {
      const h = await valueHash(value);
      shown.push({ o, r, f, h });
      const mark = await db
        .selectFrom("core_value_mark")
        .select(["value_hash", "standing"])
        .where("object_type", "=", o)
        .where("record_id", "=", r)
        .where("field", "=", f)
        .executeTakeFirst();
      if (!mark || mark.value_hash !== h || !allowed.includes(mark.standing)) {
        unmarked.push(
          `${label} (${mark ? (mark.value_hash === h ? mark.standing : "changed since") : "no one"})`,
        );
      }
    };
    const definition = object === ROUTINE_ABOUT_ORDER ? undefined : getObject(object);
    // The record exists by a person's, the customer's or the host's own rule, never an AI's.
    await check(
      object,
      send.record,
      CREATED,
      "",
      ["person", "customer", "public", "default", "host"],
      `the ${spec.about} itself`,
    );
    // Its link to its Person, and its state, the same.
    const personField = definition?.customer?.field;
    if (personField) {
      await check(
        object,
        send.record,
        personField,
        record[personField],
        ["person", "customer", "default", "host"],
        `whose ${spec.about} it is`,
      );
    }
    const stateField = definition?.states?.field;
    if (stateField) {
      await check(
        object,
        send.record,
        stateField,
        record[stateField],
        ["person", "customer", "default", "host"],
        `the ${spec.about}'s state`,
      );
    }
    // Every field that fed a slot or the calendar: a person's own write, or a default.
    for (const source of records.sources.values()) {
      const row = await records.get(source.object, source.id);
      for (const field of source.fields) {
        if (source.object === object && source.id === send.record && field === personField)
          continue;
        await check(
          source.object,
          source.id,
          field,
          row?.[field],
          ["person", "default"],
          `${source.object} ${source.id}'s ${field}`,
        );
      }
    }
    // Each address it goes to.
    for (const recipient of recipients) {
      if (recipient.rule === "order") {
        // A paid order's own address (the one that paid), or a customer's verified address.
        const orderId =
          object === ROUTINE_ABOUT_ORDER
            ? send.record
            : text(record[definition?.sellable?.moves?.order ?? ""]);
        const order = orderId ? await records.get(ROUTINE_ABOUT_ORDER, orderId) : null;
        if (!order) unmarked.push("the order");
        if (order)
          await check(
            "order",
            String(order.id),
            CREATED,
            "",
            ["person", "customer", "public", "host"],
            "the order",
          );
        continue;
      }
      if (!recipient.personId) continue;
      if (await verifiedAddress(db, recipient.personId, recipient.address)) continue;
      const emails = await db
        .selectFrom("core_person_emails")
        .select("email")
        .where("person_id", "=", recipient.personId)
        .execute();
      await check(
        "person",
        recipient.personId,
        "emails",
        emails.map((e) => e.email),
        ["person", "default"],
        `${recipient.address}`,
      );
    }
    // The member's name, in a guardian's email: a person's write, or the member's own.
    if (aboutPersonId && memberName !== null) {
      await check(
        "person",
        aboutPersonId,
        "displayName",
        memberName,
        ["person", "customer", "default"],
        "the member's name",
      );
    }
  } catch (error) {
    unmarked.push(
      `who stands behind it could not be read (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (unmarked.length) held.push(`no person stands behind ${unmarked.join(", ")}`);

  const rows: Insertable<CoreDatabase["core_routine_mail"]>[] = [];
  const keys: string[] = [];
  for (const recipient of recipients) {
    const guardian = !recipient.self && message.guardian !== undefined;
    const template = guardian ? message.guardian : message;
    if (!template) continue;
    const values = guardian ? guardianValues : selfValues;
    const subject = renderTemplate(parseTemplate(template.subject), values).slice(0, 300);
    const body = renderTemplate(parseTemplate(template.text), values);
    const reasons = [...held, ...fill.problems];
    const namesMember = [template.subject, template.text].some((t) =>
      parseTemplate(t).slots.has(ROUTINE_MEMBER_SLOT),
    );
    if (guardian && memberProblem && namesMember) {
      reasons.push(`the member's name holds ${memberProblem}`);
    }
    if (subject.length > 200 || !subject.trim()) reasons.push("the subject is too long or empty");
    if (body.length > 30_000) reasons.push("the email is too long");
    if (recipient.held) reasons.push(recipient.held);
    // The daily caps are counted when the row is claimed (claimRoutineMail), not here.
    const key = `${chain}:${kindId}:${messageName}:${send.record}:${recipient.address}`;
    keys.push(key);
    rows.push({
      id: newId("routineMail"),
      kind: kindId,
      message: messageName,
      extension_id: input.extensionId,
      record_object: object,
      record_id: send.record,
      recipient: recipient.address,
      recipient_rule: recipient.rule,
      recipient_person_id: recipient.personId,
      recipient_key: mailboxKey(recipient.address),
      about_person_id: aboutPersonId,
      automation_id: input.automationId,
      run_id: input.runId,
      trigger_type: triggerType,
      triggered_by: by ? JSON.stringify(by) : null,
      idempotency_key: key,
      routine: on && packOn && !reasons.length ? 1 : 0,
      ordinary: on && !packOn ? 1 : 0,
      held_reason: !on
        ? null
        : !packOn
          ? "routine email is not turned on for this pack: decided by the approval policy"
          : reasons.length
            ? reasons.join("; ").slice(0, 1000)
            : null,
      status: on ? "ready" : "off",
      connection_id: on ? input.connectionId : null,
      subject: on ? subject.slice(0, 200) : null,
      body: on ? body : null,
      calendar: on && calendar.length ? JSON.stringify(calendar) : null,
      related: JSON.stringify([...records.read].slice(0, 20)),
      sources: JSON.stringify(shown),
      pending_action_id: null,
      error: null,
      created_at: now,
      updated_at: now,
    });
  }
  for (const row of rows) {
    await db
      .insertInto("core_routine_mail")
      .values(row)
      .onConflict((oc) => oc.column("idempotency_key").doNothing())
      .execute();
  }
  const stored = keys.length
    ? await db
        .selectFrom("core_routine_mail")
        .select(["id", "status", "routine", "idempotency_key"])
        .where("idempotency_key", "in", keys)
        .execute()
    : [];
  const toSend: PreparedRoutineMail["toSend"] = [];
  const done: PreparedRoutineMail["done"] = [];
  for (const row of stored) {
    if (row.status === "ready" || row.status === "sending") {
      toSend.push({ id: row.id, routine: row.routine === 1 });
    } else {
      done.push({ id: row.id, status: row.status, routine: row.routine === 1 });
    }
  }
  return { kind: kindId, off: !on, toSend, done, none: false };
}

/** One line per record of the `each` object pointing at the record. */
async function eachSlot(
  db: Db,
  records: Records,
  extensionId: string,
  name: string,
  slot: Extract<RoutineSlotManifest, { each: unknown }>,
  recordId: string,
  fill: Fill,
): Promise<string | null> {
  const each = slot.each;
  const object = `${extensionId}.${each.object}`;
  const definition = getObject(object);
  const via = definition?.fields.find((f) => f.name === each.via);
  const viaColumn = via ? viewColumnOf(via) : null;
  if (!definition || !viaColumn) {
    fill.problems.push(`${name} cannot be read`);
    return null;
  }
  // biome-ignore lint/suspicious/noExplicitAny: rec_* views are not in CoreDatabase; names come from the registry.
  const rows = (await (db as Kysely<any>)
    .selectFrom(
      visibleSource({ principal: staffPrincipal({ id: "system", role: "admin" }) }, definition),
    )
    .select("id")
    .where(viaColumn, "=", recordId)
    .orderBy("created_at")
    .limit(each.max)
    .execute()) as { id: string }[];
  const line = parseTemplate(each.line);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const item = await records.get(object, row.id);
    if (!item) continue;
    if (each.where && !each.where.in.includes(String(item[each.where.field] ?? ""))) continue;
    if (each.distinct) {
      const d = String((await walk(records, object, item, each.distinct)) ?? "");
      if (seen.has(d)) continue;
      seen.add(d);
    }
    const itemFill: Fill = { values: {}, problems: [] };
    for (const [inner, innerSlot] of Object.entries(each.slots)) {
      await fieldSlot(records, object, item, inner, innerSlot, itemFill);
    }
    fill.problems.push(...itemFill.problems.map((p) => `${name}: ${p}`));
    out.push(renderTemplate(line, itemFill.values));
  }
  return out.length ? out.join("\n") : null;
}

/** The calendar events a message attaches, every value read by the host. */
async function calendarFor(
  records: Records,
  object: string,
  record: Values,
  message: RoutineMessageManifest,
  values: Record<string, string | null>,
  fill: Fill,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const event of calendarsOf(message)) {
    if (event.if && values[event.if] !== "") continue;
    const uid = event.uid ? text(record[event.uid]) : text(record.id);
    if (!uid) continue;
    const start = Date.parse(String((await walk(records, object, record, event.start)) ?? ""));
    if (!Number.isFinite(start)) continue;
    const endRaw = event.end
      ? Date.parse(String((await walk(records, object, record, event.end)) ?? ""))
      : Number.NaN;
    const end =
      Number.isFinite(endRaw) && endRaw > start && endRaw - start <= 7 * 86_400_000
        ? endRaw
        : start + 3_600_000;
    const title = text(await walk(records, object, record, event.title));
    if (!title) continue;
    const titleWhy = unroutineText(title, 200);
    if (titleWhy) fill.problems.push(`the calendar's title holds ${titleWhy}`);
    const location = event.location
      ? text(await walk(records, object, record, event.location))
      : null;
    const locationWhy = location ? unroutineText(location, 200) : null;
    if (locationWhy) fill.problems.push(`the calendar's place holds ${locationWhy}`);
    const url = event.link ? values[event.link] : null;
    out.push({
      uid,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      title,
      ...(location ? { location } : {}),
      ...(url ? { url } : {}),
      ...(event.update ? { sequence: sequenceNow() } : {}),
      ...(event.cancelled ? { cancelled: true } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The integration host's side: the row it sends, and what became of it

export interface RoutineMailRow {
  id: string;
  kind: string;
  routine: boolean;
  /** Not yet turned on (D1): an ordinary send, decided by the policy as before routine mail. */
  ordinary: boolean;
  heldReason: string | null;
  automationId: string;
  runId: string;
  extensionId: string;
  message: {
    to: string[];
    subject: string;
    text: string;
    relatedRecords: string[];
    calendar?: unknown;
  };
}

/**
 * Claims a row to send through `connectionId`; null when it is not one to send there now, `off`
 * when its kind was turned off since it was prepared (F2: settled `off`, nothing sent). The pack
 * switch is read again too (D1), and the daily caps are counted here, in the one statement that
 * claims a routine row (D4): per mailbox (plus-tags and case folded) and for the organisation,
 * so runs claiming at once cannot race past either. Over a cap the row is held for a person.
 */
export async function claimRoutineMail(
  db: Db,
  id: string,
  connectionId: string,
  now = new Date().toISOString(),
): Promise<RoutineMailRow | "off" | null> {
  let row = await db
    .selectFrom("core_routine_mail")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row || (row.status !== "ready" && row.status !== "sending")) return null;
  if (row.connection_id !== connectionId || !row.subject || row.body === null) return null;
  const settings = await loadRoutineMailSettings(db);
  const kinds = await routineKinds(db);
  const kind = kinds.find((k) => k.id === row?.kind);
  if (!kind || !kind.on) {
    await db
      .updateTable("core_routine_mail")
      .set({
        status: "off",
        routine: 0,
        updated_at: now,
        subject: null,
        body: null,
        calendar: null,
      })
      .where("id", "=", id)
      .execute();
    return "off";
  }
  if (row.routine === 1 && !kind.packOn) {
    await db
      .updateTable("core_routine_mail")
      .set({ routine: 0, ordinary: 1, updated_at: now })
      .where("id", "=", id)
      .execute();
  } else if (row.routine === 1) {
    const day = new Date(Date.parse(now) - 86_400_000).toISOString();
    const claimed = await db
      .updateTable("core_routine_mail")
      .set({ status: "sending", claimed_at: now, updated_at: now })
      .where("id", "=", id)
      .where("routine", "=", 1)
      .where((eb) =>
        eb.and([
          eb(
            eb
              .selectFrom("core_routine_mail as o")
              .select((o) => o.fn.countAll<number>().as("n"))
              .where("o.recipient_key", "=", row?.recipient_key ?? "")
              .where("o.routine", "=", 1)
              .where("o.claimed_at", ">", day)
              .where("o.id", "!=", id),
            "<",
            ROUTINE_DAILY_CAP,
          ),
          eb(
            eb
              .selectFrom("core_routine_mail as o")
              .select((o) => o.fn.countAll<number>().as("n"))
              .where("o.routine", "=", 1)
              .where("o.claimed_at", ">", day)
              .where("o.id", "!=", id),
            "<",
            settings.orgDailyCap,
          ),
        ]),
      )
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows) === 0) {
      const mailbox = await db
        .selectFrom("core_routine_mail")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("recipient_key", "=", row.recipient_key)
        .where("routine", "=", 1)
        .where("claimed_at", ">", day)
        .executeTakeFirst();
      const overMailbox = Number(mailbox?.n ?? 0) >= ROUTINE_DAILY_CAP;
      const reason = overMailbox
        ? `${row.recipient} has had ${ROUTINE_DAILY_CAP} routine emails today`
        : `the organisation has sent ${settings.orgDailyCap} routine emails today`;
      await db
        .updateTable("core_routine_mail")
        .set({ routine: 0, held_reason: reason, status: "sending", updated_at: now })
        .where("id", "=", id)
        .execute();
      if (!overMailbox) {
        const plan = await notifyStatements(
          db,
          {
            to: [{ role: "admin" }],
            type: "system.message",
            title: "Routine email reached today's limit",
            body:
              `${settings.orgDailyCap} routine emails went out in the last day. The rest wait in ` +
              "Approvals until a person approves them (Settings → Routine email sets the limit).",
            dedupeKey: `routine-mail.org-cap:${now.slice(0, 10)}`,
            source: { actor: "system" },
          },
          now,
        );
        for (const statement of plan.statements) {
          await (statement as unknown as { execute(): Promise<unknown> }).execute();
        }
      }
    }
  } else {
    await db
      .updateTable("core_routine_mail")
      .set({ status: "sending", updated_at: now })
      .where("id", "=", id)
      .execute();
  }
  row = await db
    .selectFrom("core_routine_mail")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  if (!row.subject || row.body === null) return null;
  let related: string[] = [];
  try {
    related = (JSON.parse(row.related ?? "[]") as unknown[]).map(String).slice(0, 20);
  } catch {}
  let calendar: unknown;
  try {
    calendar = row.calendar ? JSON.parse(row.calendar) : undefined;
  } catch {}
  const events = Array.isArray(calendar) ? calendar : [];
  return {
    id: row.id,
    kind: row.kind,
    routine: row.routine === 1,
    ordinary: row.ordinary === 1,
    heldReason: row.held_reason,
    automationId: row.automation_id,
    runId: row.run_id,
    extensionId: row.extension_id,
    message: {
      to: [row.recipient],
      subject: row.subject,
      text: row.body,
      relatedRecords: related,
      ...(events.length === 1
        ? { calendar: events[0] }
        : events.length
          ? { calendar: events }
          : {}),
    },
  };
}

/** Records what became of a send; the words are cleared once it is decided. */
export async function settleRoutineMail(
  db: Db,
  id: string,
  outcome:
    | { status: "sent" | "denied" }
    | { status: "waiting"; pendingActionId: string }
    | { status: "failed"; error: string }
    | { status: "ready"; error: string },
  now = new Date().toISOString(),
): Promise<void> {
  const keep = outcome.status === "ready";
  await db
    .updateTable("core_routine_mail")
    .set({
      status: outcome.status,
      updated_at: now,
      ...("pendingActionId" in outcome ? { pending_action_id: outcome.pendingActionId } : {}),
      ...("error" in outcome ? { error: outcome.error.slice(0, 1000) } : {}),
      ...(keep ? {} : { subject: null, body: null, calendar: null }),
    })
    .where("id", "=", id)
    .execute();
}

/** Deletes log rows older than the retention setting (D5), in chunks; the daily purge calls it. */
export async function purgeRoutineMail(db: Db, now: string): Promise<{ deleted: number }> {
  const { retentionMonths } = await loadRoutineMailSettings(db);
  const cutoff = new Date(Date.parse(now));
  cutoff.setUTCMonth(cutoff.getUTCMonth() - retentionMonths);
  let deleted = 0;
  for (let round = 0; round < 20; round += 1) {
    const rows = await db
      .selectFrom("core_routine_mail")
      .select("id")
      .where("created_at", "<", cutoff.toISOString())
      .orderBy("created_at")
      .limit(500)
      .execute();
    if (!rows.length) break;
    await db
      .deleteFrom("core_routine_mail")
      .where(
        "id",
        "in",
        rows.map((r) => r.id),
      )
      .execute();
    deleted += rows.length;
    if (rows.length < 500) break;
  }
  return { deleted };
}
