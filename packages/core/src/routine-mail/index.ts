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
//
// Routine messages (ADR 0670, stage 30): a kind may also go by text and push, on the channels a
// human admin switched on for it. Each recipient gets a row per channel: the email as before, then
// a push and a text when the kind declares their words, held for exactly the same reasons (what
// its own words show), and kept `no_channel` when the Person cannot be reached that way (reach.ts).
// Quiet hours hold a text or push (never an email) until they end (quiet.ts, ADR 0676). A kind the
// host declares itself is asked for by host code (`prepareHostRoutineMail`), not an automation.

import type { CoreDatabase } from "@composable-os/db";
import {
  calendarsOf,
  channelsOf,
  essentialOf,
  type FormLinkSlotSpec,
  formatMoment,
  formatMoney,
  formLinkSlotsOf,
  PERSONAL_LINK_DAYS,
  PUSH_BODY_MAX,
  PUSH_TITLE_MAX,
  parseTemplate,
  RECEIPT_DAILY_CAP,
  ROUTINE_ABOUT_ORDER,
  ROUTINE_DAILY_CAP,
  ROUTINE_MEMBER_SLOT,
  type RoutineFieldSlotManifest,
  type RoutineMailKindManifest,
  type RoutineMessageManifest,
  type RoutineSlotManifest,
  renderTemplate,
  TEXT_MAX_SEGMENTS,
  TEXT_SENDER_MAX,
  textSegments,
  unroutineText,
  wrapText,
} from "@composable-os/sdk";
import { type Insertable, type Kysely, sql, type Updateable } from "kysely";
import { z } from "zod";
import { ADJUDICATOR_PRINCIPAL } from "../adjudicator/review.ts";
import { type ContactDecision, contactDecision, registerRefusal } from "../contact/decide.ts";
import { type ChoicesInForce, choicesInForce } from "../contact/register.ts";
import { readStopToken, type StopScope, stopLink, tokenOfLink } from "../contact/stop.ts";
import { addressHash, suppressed } from "../contact/suppression.ts";
import { sameEmailPeople } from "../customers/accounts.ts";
import { mailboxKey } from "../customers/limits.ts";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { newId } from "../ids.ts";
import { formIdBySlug, openForm } from "../intake/forms.ts";
import { ensureLink, linkedSince, linkToken, personalLinkUrl } from "../intake/links.ts";
import { notifyStatements } from "../notifications/send.ts";
import { loadRecord } from "../operations/record.ts";
import { staffPrincipal } from "../principals.ts";
import { viewColumnOf } from "../records/columns.ts";
import { extensionSettingValues } from "../records/windows.ts";
import { isTimezone } from "../settings.ts";
import { hasLiveGuardian } from "../visibility/guardians.ts";
import { visibleSource } from "../visibility/index.ts";
import { HOST_KINDS_EXTENSION, hostRoutineKind, hostRoutineKinds } from "./host-kinds.ts";
import { addressField, CREATED, PRIMARY_ADDRESS, type Standing, valueHash } from "./marks.ts";
import { TEXT_COUNTRY_CODES } from "./numbers.ts";
import { DEFAULT_QUIET_HOURS, quietHoursSchema } from "./quiet.ts";
import { type ChannelReach, HOST_REACH, type Reached } from "./reach.ts";

/** What the calendar file read, among the slots: checked for an email that carries one. */
const CALENDAR = "$calendar";
/** Why a host kind's email was kept, failed: retried when its occasion is asked for again. */
const NO_EMAIL_CHANNEL = "No email channel is set in Settings → Notification delivery";
/** What a kind's `until` read: no message shows it, so none rests on it. */
const UNTIL = "$until";
/** The line a stoppable email ends with, before its one-tap stop (ADR 0675). */
export const STOP_WORDS = "To stop getting these emails:";

/**
 * The stop link a prepared email's words end with, when it is a link on `site`'s stop route to a
 * token the host made for exactly `named`; else null (ADR 0675). One statement.
 */
export async function stopLinkOf(
  db: Db,
  body: string,
  site: string | null,
  named: StopScope,
): Promise<string | null> {
  const at = body.lastIndexOf(`\n${STOP_WORDS} `);
  if (at < 0) return null;
  const link = body.slice(at + STOP_WORDS.length + 2);
  const token = tokenOfLink(link, site);
  if (!token) return null;
  const found = await readStopToken(db, token);
  if (
    !found ||
    found.person !== named.person ||
    found.channel !== named.channel ||
    found.scope !== named.scope
  ) {
    return null;
  }
  return link;
}

/**
 * What a kind's one-tap stop turns off by email (ADR 0675): follow-ups on email, for a follow-up;
 * the kind itself, for an optional kind; nothing for an essential kind, whose email always goes.
 */
export function stopScopeOf(kindId: string, spec: RoutineMailKindManifest): string | null {
  if ((spec.purpose ?? "account") === "follow_up") return "follow_up";
  return essentialOf(spec) ? null : kindId;
}

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
  /**
   * Kind id → its text and push switched on by a human admin (ADR 0670), within what the kind
   * declares. Off unless switched on: nothing starts texting or pushing on deploy.
   */
  channels: z
    .record(
      z.string().max(80),
      z.object({ text: z.boolean().optional(), push: z.boolean().optional() }).strict(),
    )
    .default({}),
  /** Decision 2: a member reached by a push is not also texted (on unless an admin chose). */
  textOnlyWithoutApp: z.boolean().default(true),
  /** When texts and pushes wait, in `quietZone` (ADR 0676). */
  quietHours: quietHoursSchema.default(DEFAULT_QUIET_HOURS),
  /**
   * The time zone quiet hours are read in (an IANA name), a human admin's like the window: never
   * the organisation's general time zone, which `settings.update` lets others change (the
   * review of PR #339). No text or push goes until it is set.
   */
  quietZone: z.string().max(64).nullable().default(null),
  /**
   * The name every text begins with (at most 30 characters), a human admin's: never the
   * organisation's name, which others may change (the review of PR #339). No text goes until it
   * is set.
   */
  senderName: z.string().max(TEXT_SENDER_MAX).nullable().default(null),
  /**
   * The month's text limit, in minor units of the business's currency (ADR 0672), a human
   * admin's: a text that would take the month's spend past it is `over_limit`. 0, the default,
   * sends no texts.
   */
  textLimitMinor: z.number().int().min(0).max(100_000_000).default(0),
  /**
   * What one segment costs, in minor units, as the admin read it off the provider's price list:
   * the estimate the limit is counted with until the provider reports. No text goes until it is
   * set.
   */
  textSegmentPriceMinor: z.number().int().min(1).max(100_000).nullable().default(null),
  /**
   * The countries texts may go to (ISO 3166 codes the host knows the numbers of), the business's
   * own first: a number without its country code is read as the first one's (ADR 0673). None,
   * the default, sends no texts.
   */
  textCountries: z.array(z.enum(TEXT_COUNTRY_CODES)).max(TEXT_COUNTRY_CODES.length).default([]),
});
export type RoutineMailSettings = z.infer<typeof routineMailSettingsSchema>;

const DEFAULT_SETTINGS: RoutineMailSettings = {
  packs: {},
  kinds: {},
  siteOrigin: null,
  orgDailyCap: ROUTINE_ORG_DAILY_CAP,
  retentionMonths: ROUTINE_LOG_MONTHS,
  channels: {},
  textOnlyWithoutApp: true,
  quietHours: DEFAULT_QUIET_HOURS,
  quietZone: null,
  senderName: null,
  textLimitMinor: 0,
  textSegmentPriceMinor: null,
  textCountries: [],
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
  /** The extension's routine email turned on by a human admin (D1). Always true for a host kind. */
  packOn: boolean;
  /** Declared by the host itself (ADR 0670): asked for by host code, off until an admin turns it on. */
  host: boolean;
  /** Text and push, each declared by the kind and switched on by a human admin. */
  channels: { text: boolean; push: boolean };
}

/** A kind's text and push: declared, and switched on in the settings. */
function channelSwitches(
  id: string,
  spec: RoutineMailKindManifest,
  settings: RoutineMailSettings,
): { text: boolean; push: boolean } {
  const declared = new Set(channelsOf(spec));
  const on = settings.channels[id] ?? {};
  return {
    text: declared.has("text") && on.text === true,
    push: declared.has("push") && on.push === true,
  };
}

/** Every kind a shipped, active extension declares, and the host's own, with whether it is on now. */
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
        host: false,
        channels: channelSwitches(id, spec, settings),
      });
    }
  }
  for (const [name, spec] of hostRoutineKinds()) {
    const id = `${HOST_KINDS_EXTENSION}.${name}`;
    out.push({
      id,
      extensionId: HOST_KINDS_EXTENSION,
      extensionLabel: "The host",
      name,
      spec,
      // Off until a human admin turns it on, whatever the declaration says (ADR 0670).
      on: settings.kinds[id] === true,
      packOn: true,
      host: true,
      channels: channelSwitches(id, spec, settings),
    });
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
  /** Email rows to hand the integration host now (`ready`, or `sending` after a crash). */
  toSend: { id: string; routine: boolean }[];
  /** Email rows a retried step had already decided. */
  done: { id: string; status: string; routine: boolean }[];
  /**
   * Text and push rows (ADR 0670): sent by their gatekeepers' glue, never by the email path. A
   * `waiting` one waits for quiet hours to end (`releaseWaitingRoutineMessages`).
   */
  phone: { id: string; channel: "text" | "push"; status: string; routine: boolean }[];
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
  /** An address the host cannot send to: the row is kept, failed, for staff to see. */
  invalid?: true;
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
  /**
   * The fields that fed the email, by record: who last wrote each is checked (B2). A relation
   * followed on the way (`class.room` in `class.room.name`) is a `link`: which record the email
   * names is shown too (the third review).
   */
  readonly sources = new Map<
    string,
    { object: string; id: string; fields: Map<string, "value" | "link"> }
  >();
  /** The slot (or `$calendar`) being filled, and the fields each one read. */
  context = "";
  readonly bySlot = new Map<string, Set<string>>();
  note(object: string, id: unknown, field: string, kind: "value" | "link" = "value"): void {
    if (typeof id !== "string") return;
    const key = `${object}:${id}`;
    const found = this.sources.get(key) ?? { object, id, fields: new Map() };
    if (found.fields.get(field) !== "value") found.fields.set(field, kind);
    this.sources.set(key, found);
    const slot = this.bySlot.get(this.context) ?? new Set<string>();
    slot.add(markKey(object, id, field));
    this.bySlot.set(this.context, slot);
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

/** A mark's key: object, record and field. */
const markKey = (o: string, r: string, f: string) => `${o}\u0000${r}\u0000${f}`;

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
    // Which record the path goes through is shown too: an AI re-pointing a class at another room.
    records.note(currentObject, current.id, segment, "link");
    currentObject = to;
    current = await records.get(to, id);
  }
  return undefined;
}

/**
 * Why a value cannot be routine, collected while filling the slots, under the slot (or
 * `$calendar`) it was for: a message is held only for what its own words show (ADR 0670), as
 * its marks are checked (the third review), so a text's shorter title holds only the text.
 */
interface Fill {
  values: Record<string, string | null>;
  problems: { slot: string; why: string }[];
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
    if (!slot.optional) fill.problems.push({ slot: name, why: `${name} is empty` });
    return;
  }
  const format = slot.format ?? "text";
  if (format === "text") {
    const value = String(raw);
    const why = unroutineText(value, slot.max ?? 120);
    fill.values[name] = value;
    if (why) fill.problems.push({ slot: name, why: `${name} holds ${why}` });
    return;
  }
  if (format === "money") {
    const currency = slot.currency ? await walk(records, object, record, slot.currency) : null;
    const value = formatMoney(Number(raw), String(currency ?? ""));
    fill.values[name] = value;
    if (!value) fill.problems.push({ slot: name, why: `${name} is not an amount` });
    return;
  }
  if (format === "count") {
    const n = Number(raw);
    fill.values[name] = Number.isInteger(n) ? String(n) : null;
    if (!Number.isInteger(n))
      fill.problems.push({ slot: name, why: `${name} is not a whole number` });
    return;
  }
  const zone = slot.zone ? zoneOf(await walk(records, object, record, slot.zone)) : null;
  const value = formatMoment(String(raw), zone, format, slot.year === true);
  fill.values[name] = value;
  if (!value) fill.problems.push({ slot: name, why: `${name} is not a time` });
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
    if (!a || seen.has(a)) return;
    seen.add(a);
    // An address the host cannot be sure of (a trailing dot, an international domain) is never
    // dropped in silence: the email waits for staff, who see why (the fourth review).
    if (!ADDRESS.test(a) || a.length > 254) {
      out.push({
        address: a.slice(0, 254),
        ...r,
        held: "the address is not one the host sends to on its own (check it is right)",
        invalid: true,
      });
      return;
    }
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
 * Who a receipt goes to (ADR 0724): whoever sent the submission, once. Signed in, their own
 * verified sign-in address; by a personal link, the link's Person's primary address (where the
 * host sent the link); a visitor, the address they typed, when it is one of the submission's
 * Person's by the same-email rule. Nobody for an anonymous submission (no Person), one entered by
 * staff, one kept as spam, or a Person erased, merged away or in the Trash.
 */
async function receiptRecipientsOf(
  db: Db,
  object: string,
  record: Values,
): Promise<{ recipients: Recipient[]; memberName: string | null; personId: string | null }> {
  const nobody = { recipients: [], memberName: null, personId: null };
  const definition = getObject(object);
  const intake = definition?.intake?.role === "submission" ? definition.intake : null;
  if (!definition || !intake) return nobody;
  const personId = text(record[intake.person]);
  if (!personId) return nobody;
  if (definition.states && record[definition.states.field] === intake.spam) return nobody;
  const certainty = text(record[intake.certainty]);
  const person = await livePerson(db, personId);
  if (!person) return nobody;
  let address: string | null = null;
  if (certainty === "account") {
    const customer = await db
      .selectFrom("core_customer")
      .select("email")
      .where("person_id", "=", personId)
      .where("email_verified", "=", 1)
      .executeTakeFirst();
    address = text(customer?.email);
  } else if (certainty === "link") {
    address = person.email;
  } else if (certainty === "address") {
    for (const typed of typedAddresses(record[intake.answers]).slice(0, 3)) {
      if ((await sameEmailPeople(db, typed)).includes(personId)) {
        address = typed;
        break;
      }
    }
  }
  const a = address?.trim().toLowerCase();
  if (!a) return { ...nobody, personId };
  const recipient: Recipient = { address: a, rule: "person", personId, self: true };
  if (!ADDRESS.test(a) || a.length > 254) {
    recipient.held = "the address is not one the host sends to on its own (check it is right)";
    recipient.invalid = true;
  }
  return { recipients: [recipient], memberName: null, personId };
}

/** The email answers of an answers document, as typed. */
function typedAddresses(document: unknown): string[] {
  let parsed = document;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  const answers = (parsed as { answers?: unknown } | null)?.answers;
  if (!Array.isArray(answers)) return [];
  return answers.flatMap((a) =>
    a && typeof a === "object" && (a as { kind?: unknown }).kind === "email"
      ? typeof (a as { value?: unknown }).value === "string"
        ? [((a as { value: string }).value as string).trim()]
        : []
      : [],
  );
}

/** Whether `address`'s mailbox had this receipt kind's limit in the last day (ADR 0724). */
async function receiptsToday(db: Db, kind: string, address: string, now: string) {
  const since = new Date(Date.parse(now) - 86_400_000).toISOString();
  const row = await db
    .selectFrom("core_routine_mail")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("kind", "=", kind)
    .where("channel", "=", "email")
    .where("recipient_key", "=", mailboxKey(address))
    .where("created_at", ">", since)
    .where("status", "not in", ["off", "over_limit", "stopped", "failed"])
    .executeTakeFirst();
  return Number(row?.n ?? 0) >= RECEIPT_DAILY_CAP;
}

/**
 * The personal link a send's form-link slot carries (ADR 0723): the form the pack's setting names,
 * open to answers by link now, and the link for the record's Person about this record, made now
 * or found again by a retried step. `skip`: not sent at all (asked about this record already, or
 * within the slot's `once` days). `failed`: the email cannot carry a link (no site, no form).
 */
async function planLink(
  db: Db,
  p: Prepare,
  [, slot]: [string, FormLinkSlotSpec],
  personId: string,
): Promise<{ linkId: string; site: string } | { skip: true } | { failed: string }> {
  const site = siteOriginOf(p.settings.siteOrigin);
  if (!site) {
    return { failed: "a personal link is on the business's site: set it in Settings → Routine email" };
  }
  const slug = text(p.packSettings[slot.setting]);
  if (!slug) return { failed: `no form is chosen (the ${slot.setting} setting)` };
  const ctx = { db, now: p.now };
  let formId: string;
  try {
    formId = await formIdBySlug(ctx, slot.object, slug);
    await openForm(ctx, slot.object, formId, "public", { byLink: true });
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    return { failed: "the form chosen does not take answers by personal link now" };
  }
  const about = {
    personId,
    formObject: slot.object,
    formId,
    recordObject: p.object,
    recordId: p.record,
  };
  if (slot.once) {
    const since = new Date(Date.parse(p.now) - slot.once * 86_400_000).toISOString();
    if (await linkedSince(db, about, since)) return { skip: true };
  }
  const link = await ensureLink(db, {
    ...about,
    madeFor: `${p.kindId}:${p.keyPrefix}`.slice(0, 200),
    days: slot.days ?? PERSONAL_LINK_DAYS,
    now: p.now,
  });
  if (!link?.live) return { skip: true };
  return { linkId: link.id, site };
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

/** Whether `address` paid an order of this Person's (the address a payment was applied for). */
async function paidAddress(db: Db, personId: string, address: string): Promise<boolean> {
  const row = await db
    .selectFrom("core_order")
    .select("id")
    .where("person_id", "=", personId)
    .where("paid", ">", 0)
    .where((eb) => eb.fn("lower", ["email"]), "=", address.trim().toLowerCase())
    .limit(1)
    .executeTakeFirst();
  return Boolean(row);
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
  /** How a Person is reached by text and push (default: nobody is yet, ADR 0670). */
  reach?: ChannelReach;
}

/** A kind's message, by the name a send gives or its only one. */
function messageOf(
  kindId: string,
  spec: RoutineMailKindManifest,
  name: string | undefined,
): { messageName: string; message: RoutineMessageManifest } {
  const names = Object.keys(spec.messages);
  const messageName = name ?? (names.length === 1 ? names[0] : undefined);
  const message = messageName ? spec.messages[messageName] : undefined;
  if (!messageName || !message) {
    throw new ValidationError(`Name one of ${kindId}'s messages: ${names.join(", ")}`);
  }
  return { messageName, message };
}

/** What the host reads from the record (a title, a time, a link) is never the caller's to say. */
function checkSendValues(
  kindId: string,
  spec: RoutineMailKindManifest,
  values: Record<string, unknown> | undefined,
) {
  for (const key of Object.keys(values ?? {})) {
    const slot = spec.slots[key];
    if (!slot) throw new ValidationError(`${kindId} has no slot "${key}"`);
    if ("field" in slot || "link" in slot || "each" in slot || "formLink" in slot) {
      throw new ValidationError(`${kindId}'s slot "${key}" is filled by the host`, { slot: key });
    }
  }
}

/**
 * Decides one routine send and writes its rows (one per recipient and channel). Throws a
 * ForbiddenError for a caller that may not send routine mail at all (not a shipped extension's
 * automation run, a kind it does not declare, a record the run is not about) and a
 * ValidationError for a pack's mistake.
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
  const { messageName, message } = messageOf(kindId, spec, send.message);
  checkSendValues(kindId, spec, send.values);

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

  return prepareRows(db, {
    now,
    record: send.record,
    values: send.values,
    kindId,
    extensionId: input.extensionId,
    spec,
    messageName,
    message,
    object,
    records,
    recordValues: record,
    held,
    by,
    triggerType,
    keyPrefix: chain,
    automationId: input.automationId,
    runId: input.runId,
    connectionId: input.connectionId,
    settings,
    on,
    packOn,
    packSettings: await extensionSettingValues(db, input.extensionId),
    reach: input.reach ?? HOST_REACH,
  });
}

export interface PrepareHostRoutineMailInput {
  /** A kind the host declares (`paymentFailed`; its id is `core.paymentFailed`). */
  kind: string;
  /** The record it is about, of the kind's object. */
  record: string;
  message?: string;
  values?: Record<string, string | number | boolean>;
  /**
   * What this send is for (a provider event's id, a failure's first date): the same occasion
   * sends nothing twice, a new one sends again.
   */
  occasion: string;
  /** The org email connection Settings → Notification delivery names, or null when none is set. */
  connectionId: string | null;
  now?: string;
  reach?: ChannelReach;
}

/**
 * A host kind's send (ADR 0670): asked for by host code (subscriptions' payment messages), never an
 * automation, a tool, the assistant or MCP; there is no operation. Everything after the caller is
 * the same as a pack's: the recipient from the record, the words of the declaration, every value
 * checked by its mark, the caps, the switches, quiet hours. Host code is the cause, so the run's
 * checks (a manual trigger, a replay, an AI's change) do not apply; what an AI wrote still holds it.
 */
export async function prepareHostRoutineMail(
  db: Db,
  input: PrepareHostRoutineMailInput,
): Promise<PreparedRoutineMail> {
  const now = input.now ?? new Date().toISOString();
  const spec = hostRoutineKind(input.kind);
  if (!spec) throw new ForbiddenError(`The host declares no routine message "${input.kind}"`);
  const kindId = `${HOST_KINDS_EXTENSION}.${input.kind}`;
  if (!/^[\w:.-]{1,120}$/.test(input.occasion)) {
    throw new ValidationError("A host kind's send names its occasion (letters, digits, : . _ -)");
  }
  const { messageName, message } = messageOf(kindId, spec, input.message);
  checkSendValues(kindId, spec, input.values);
  if (spec.about !== ROUTINE_ABOUT_ORDER) {
    throw new ValidationError(`A host kind is about a record the host reads: ${spec.about} is not`);
  }
  const object = ROUTINE_ABOUT_ORDER;
  const records = new Records(db);
  const record = await records.get(object, input.record);
  if (!record) throw new NotFoundError(object, input.record);
  const settings = await loadRoutineMailSettings(db);
  return prepareRows(db, {
    now,
    record: input.record,
    values: input.values,
    kindId,
    extensionId: HOST_KINDS_EXTENSION,
    spec,
    messageName,
    message,
    object,
    records,
    recordValues: record,
    held: [],
    by: null,
    triggerType: "host",
    keyPrefix: `host:${input.occasion}`,
    automationId: null,
    runId: null,
    connectionId: input.connectionId,
    settings,
    // Off until a human admin turns it on (ADR 0670); there is no pack to turn on.
    on: settings.kinds[kindId] === true,
    packOn: true,
    packSettings: {},
    reach: input.reach ?? HOST_REACH,
  });
}

/** What `prepareRows` needs: the kind, the record, who asked and why the whole send is held. */
interface Prepare {
  now: string;
  record: string;
  values: Record<string, string | number | boolean> | undefined;
  kindId: string;
  extensionId: string;
  spec: RoutineMailKindManifest;
  messageName: string;
  message: RoutineMessageManifest;
  object: string;
  records: Records;
  recordValues: Values;
  held: string[];
  by: { actor: string; userId: string | null; approved: boolean } | null;
  triggerType: string;
  /** The start of every row's idempotency key: the run's chain, or the host's occasion. */
  keyPrefix: string;
  automationId: string | null;
  runId: string | null;
  connectionId: string | null;
  settings: RoutineMailSettings;
  on: boolean;
  packOn: boolean;
  packSettings: Record<string, unknown>;
  reach: ChannelReach;
}

/** The words a recipient is sent on one channel, from their version (theirs or a guardian's). */
type Version = RoutineMessageManifest | NonNullable<RoutineMessageManifest["guardian"]>;

/** The rows of one send: an email per recipient, then a push and a text where they may go. */
async function prepareRows(db: Db, p: Prepare): Promise<PreparedRoutineMail> {
  const { now, records, spec, message, object, settings, on, packOn, held, by } = p;
  const record = p.recordValues;
  const none = (): PreparedRoutineMail => ({
    kind: p.kindId,
    off: !on,
    toSend: [],
    done: [],
    phone: [],
    none: true,
  });
  // A receipt (ADR 0724) goes to whoever sent the submission; every other kind to the record's
  // own Person and their live guardians, or a paid order's address.
  const receipt = spec.receipt === true;
  const found = receipt
    ? await receiptRecipientsOf(db, object, record)
    : await recipientsOf(db, records, object, record);
  const { memberName, personId: aboutPersonId } = found;
  let recipients = found.recipients;
  // A personal link (ADR 0723) is for the record's own Person: never an order's address, and
  // never a child's own address when they have a live guardian (the guardian answers for them).
  const [linkSlot] = formLinkSlotsOf(spec);
  if (linkSlot) {
    recipients = recipients.filter((r) => r.rule !== "order" && r.personId);
    if (aboutPersonId && (await hasLiveGuardian(db, aboutPersonId))) {
      recipients = recipients.filter((r) => !r.self);
    }
  }
  if (!recipients.length) return none();
  // The link itself is made once for the send, when the first email that may go asks for it
  // (each email gets its own token below): one stopped or suppressed makes none. A Person asked
  // about this record already, or within the slot's `once` days, is not sent it again.
  let plan: Awaited<ReturnType<typeof planLink>> | null = null;

  // The slots the host fills, once for the record; the pack's values per audience.
  const fill: Fill = { values: {}, problems: [] };
  const site = siteOriginOf(settings.siteOrigin);
  for (const [name, slot] of Object.entries(spec.slots)) {
    // What each slot reads is noted under its name: an email is checked (and an approval clears)
    // for what its own words show, never another recipient's (the third review).
    records.context = name;
    if ("field" in slot) await fieldSlot(records, object, record, name, slot, fill);
    else if ("link" in slot) {
      let link = siteLink(p.packSettings[slot.link], site);
      if (link && slot.withId) {
        const url = new URL(link);
        url.searchParams.set(slot.withId, p.record);
        link = url.toString();
      }
      fill.values[name] = link;
    } else if ("each" in slot) {
      fill.values[name] = await eachSlot(db, records, p.extensionId, name, slot, p.record, fill);
    }
  }
  const zoneFor = async (slot: RoutineSlotManifest) =>
    "at" in slot && slot.zone ? zoneOf(await walk(records, object, record, slot.zone)) : null;
  const packValues = async (guardian: boolean) => {
    const out: Record<string, string | null> = {};
    for (const [name, slot] of Object.entries(spec.slots)) {
      if ("field" in slot || "link" in slot || "each" in slot || "formLink" in slot) continue;
      records.context = name;
      out[name] = packValue(name, slot, p.values?.[name], await zoneFor(slot), guardian);
    }
    return out;
  };
  const selfValues = { ...fill.values, ...(await packValues(false)) };
  const member: Record<string, string | null> = { [ROUTINE_MEMBER_SLOT]: memberName };
  const memberProblem = memberName ? unroutineText(memberName, 80) : "the member has no name";
  const guardianValues = { ...fill.values, ...(await packValues(true)), ...member };

  records.context = CALENDAR;
  const calendar = await calendarFor(records, object, record, message, selfValues, fill);

  // Text and push (ADR 0670): only on a kind turned on, in a pack turned on, on the channels a
  // human admin switched on for it. Their moment (`until`) is read like any value, but shows in
  // no words, so it rests on nothing.
  const switches = channelSwitches(p.kindId, spec, settings);
  const phoneOn = on && packOn && (switches.text || switches.push);
  let untilAt: number | null = null;
  if (phoneOn && spec.until) {
    records.context = UNTIL;
    const at = Date.parse(String((await walk(records, object, record, spec.until)) ?? ""));
    untilAt = Number.isFinite(at) ? at : null;
  }
  records.context = "";

  // Default deny (ADR 0590, the second review): every value the email shows and every address it
  // goes to needs a host-kept mark that a person stands behind it, for the value it has now. No
  // mark, a mark for another value, the host's or an AI's, or any failure to read: held.
  // Each check, by mark key: what it showed (its hash) and why it is not routine, if it is not.
  const checked = new Map<string, { shown: Shown; problem: string | null }>();
  // The keys every email of the send rests on (the record, its link, its state), and each
  // recipient's own address; slots' keys are in records.bySlot.
  const base = new Set<string>();
  const ofRecipient = new Map<string, Set<string>>();
  let unreadable: string | null = null;
  const markOf = (o: string, r: string, f: string) =>
    db
      .selectFrom("core_value_mark")
      .select(["value_hash", "standing"])
      .where("object_type", "=", o)
      .where("record_id", "=", r)
      .where("field", "=", f)
      .executeTakeFirst();
  // A key checked twice (a state shown in the words as well as checked as the record's state)
  // is held to the stricter of the two lists (the fourth review).
  const allowedOf = new Map<string, readonly Standing[]>();
  const check = async (
    o: string,
    r: string,
    f: string,
    value: unknown,
    allowed: readonly Standing[],
    label: string,
  ): Promise<string> => {
    const key = markKey(o, r, f);
    const before = allowedOf.get(key);
    const strict = before ? before.filter((s) => allowed.includes(s)) : allowed;
    allowedOf.set(key, strict);
    const h = await valueHash(value);
    const mark = await markOf(o, r, f);
    const ok = mark && mark.value_hash === h && strict.includes(mark.standing);
    checked.set(key, {
      shown: { o, r, f, h },
      problem: ok
        ? null
        : `${label} (${mark ? (mark.value_hash === h ? mark.standing : "changed since") : "no one"})`,
    });
    return key;
  };
  try {
    const definition = object === ROUTINE_ABOUT_ORDER ? undefined : getObject(object);
    // The record exists by a person's, the customer's or the host's own rule, never an AI's.
    base.add(
      await check(
        object,
        p.record,
        CREATED,
        "",
        ["person", "customer", "public", "default", "host"],
        `the ${spec.about} itself`,
      ),
    );
    // Its link to its Person, and its state, the same.
    const personField = definition?.customer?.field;
    if (personField) {
      base.add(
        await check(
          object,
          p.record,
          personField,
          record[personField],
          ["person", "customer", "default", "host"],
          `whose ${spec.about} it is`,
        ),
      );
    }
    // A receipt's submission was made by the door for whoever sent it (the public included): its
    // link to its Person and its state are the door's own, anything but an AI's (ADR 0724).
    const sender: readonly Standing[] = receipt
      ? ["person", "customer", "public", "default", "host"]
      : ["person", "customer", "default", "host"];
    const intakePerson =
      receipt && definition?.intake?.role === "submission" ? definition.intake.person : null;
    if (intakePerson) {
      base.add(
        await check(
          object,
          p.record,
          intakePerson,
          record[intakePerson],
          sender,
          `whose ${spec.about} it is`,
        ),
      );
    }
    const stateField = definition?.states?.field;
    if (stateField) {
      base.add(
        await check(
          object,
          p.record,
          stateField,
          record[stateField],
          sender,
          `the ${spec.about}'s state`,
        ),
      );
    }
    // Every field that fed a slot or the calendar: a person's own write, or a default. Every
    // relation followed on the way (which room, which class): anything but an AI's, as the link
    // to the Person is.
    for (const source of records.sources.values()) {
      const row = await records.get(source.object, source.id);
      for (const [field, kind] of source.fields) {
        // A line record's creation (an `each` slot's ticket): anything but an AI's.
        if (field === CREATED) {
          await check(
            source.object,
            source.id,
            CREATED,
            "",
            ["person", "customer", "public", "default", "host"],
            `${source.object} ${source.id} itself`,
          );
          continue;
        }
        const shownValue = row?.[field];
        // Nothing shown (an optional slot left empty): nothing to stand behind.
        if (shownValue === null || shownValue === undefined || shownValue === "") continue;
        if (source.object === object && source.id === p.record && field === personField) continue;
        // Which form a receipt's submission answers is the door's (the sender's) link; what the
        // receipt shows of the form is still a person's or a default.
        const own = source.object === object && source.id === p.record;
        await check(
          source.object,
          source.id,
          field,
          shownValue,
          kind === "link"
            ? own
              ? sender
              : ["person", "customer", "default", "host"]
            : ["person", "default"],
          `${source.object} ${source.id}'s ${field}`,
        );
      }
    }
    // Each address it goes to: its own mark on its Person, always (the third review).
    for (const recipient of recipients) {
      const keys = new Set<string>();
      ofRecipient.set(recipient.address, keys);
      if (recipient.rule === "order") {
        // A paid order's own address (the one that paid), or a customer's verified address.
        const orderId =
          object === ROUTINE_ABOUT_ORDER
            ? p.record
            : text(record[definition?.sellable?.moves?.order ?? ""]);
        const order = orderId ? await records.get(ROUTINE_ABOUT_ORDER, orderId) : null;
        if (!order) {
          const key = markKey("order", orderId ?? "", CREATED);
          checked.set(key, {
            shown: { o: "order", r: orderId ?? "", f: CREATED, h: "" },
            problem: "the order",
          });
          keys.add(key);
          continue;
        }
        keys.add(
          await check(
            "order",
            String(order.id),
            CREATED,
            "",
            ["person", "customer", "public", "host"],
            "the order",
          ),
        );
        continue;
      }
      if (!recipient.personId) continue;
      keys.add(await addressCheck(recipient.personId, recipient.address));
      // A receipt goes to the address the sender gave or signed in with, which one is primary
      // aside; every other email to the Person's primary address, which no AI chose.
      if (!receipt) keys.add(await primaryCheck(recipient.personId, recipient.address));
    }
    // The member's name: a person's write, or the member's own (signed in, or typed at checkout
    // when paying from the address the email goes to: a visitor's name, to themselves).
    if (aboutPersonId && memberName !== null) {
      const own = recipients.every((r) => r.personId === aboutPersonId);
      const paid = own && (await paidFrom(aboutPersonId, recipients));
      records.context = ROUTINE_MEMBER_SLOT;
      records.note("person", aboutPersonId, "displayName");
      records.context = "";
      await check(
        "person",
        aboutPersonId,
        "displayName",
        memberName,
        paid ? ["person", "customer", "public", "default"] : ["person", "customer", "default"],
        "the member's name",
      );
    }
  } catch (error) {
    unreadable = `who stands behind it could not be read (${error instanceof Error ? error.message : String(error)})`;
  }

  /**
   * An address on a Person (the third review): its own mark (`emails:<address>`), whoever wrote
   * the list since. A person's or a default is routine; the account's own sign-in address may be
   * the customer's; one the host added (a ticket holder's, from the order that paid) only when it
   * is their verified sign-in address or paid one of their orders. An AI's never, whoever signs in
   * or pays with it later.
   */
  async function addressCheck(personId: string, address: string): Promise<string> {
    const f = addressField(address);
    const key = markKey("person", personId, f);
    if (checked.has(key)) return key;
    const h = await valueHash(address);
    const mark = await markOf("person", personId, f);
    let problem: string | null = null;
    if (!mark || mark.value_hash !== h) problem = `${address} (no one)`;
    else if (mark.standing === "person" || mark.standing === "default") problem = null;
    // A receipt (ADR 0724, amending ADR 0590) may go to an address only the sender stands behind
    // (one a visitor typed): it shows nothing they typed, and the address is the one they gave.
    else if (receipt && mark.standing !== "ai") problem = null;
    else if (mark.standing === "customer") {
      problem = (await verifiedAddress(db, personId, address)) ? null : `${address} (customer)`;
    } else if (mark.standing === "host" || mark.standing === "public") {
      problem =
        (await verifiedAddress(db, personId, address)) || (await paidAddress(db, personId, address))
          ? null
          : `${address} (${mark.standing})`;
    } else problem = `${address} (${mark.standing})`;
    checked.set(key, { shown: { o: "person", r: personId, f, h }, problem });
    return key;
  }

  /** Which of a Person's addresses is primary (the one the host writes to): never an AI's choice. */
  async function primaryCheck(personId: string, address: string): Promise<string> {
    const key = markKey("person", personId, PRIMARY_ADDRESS);
    if (checked.has(key)) return key;
    const h = await valueHash(address);
    const mark = await markOf("person", personId, PRIMARY_ADDRESS);
    const problem =
      !mark || mark.value_hash !== h
        ? `which of their addresses is ${address}'s primary one (no one)`
        : mark.standing === "ai"
          ? `which of their addresses is primary (ai)`
          : null;
    checked.set(key, { shown: { o: "person", r: personId, f: PRIMARY_ADDRESS, h }, problem });
    return key;
  }

  /** Whether one of the Person's own addresses the email goes to paid one of their orders. */
  async function paidFrom(personId: string, to: readonly Recipient[]): Promise<boolean> {
    for (const r of to) if (await paidAddress(db, personId, r.address)) return true;
    return false;
  }

  /**
   * What one message's words rest on and why it is held: the record, the slots its words name
   * (and the calendar's reads when it carries one), and the keys `extra` adds (an email's own
   * address). Only these are checked for it, and only these an approval of it clears.
   */
  const judge = (
    templates: string[],
    guardian: boolean,
    extra: Iterable<string>,
    withCalendar: boolean,
  ) => {
    const used = new Set<string>();
    for (const t of templates) for (const slot of parseTemplate(t).slots) used.add(slot);
    if (withCalendar) used.add(CALENDAR);
    const rests = new Set<string>([...base, ...extra]);
    for (const k of records.bySlot.get("") ?? []) rests.add(k);
    for (const [slot, read] of records.bySlot)
      if (used.has(slot)) for (const k of read) rests.add(k);
    const shown: Shown[] = [];
    const unmarked: string[] = [];
    for (const k of rests) {
      const c = checked.get(k);
      if (!c) continue;
      shown.push(c.shown);
      if (c.problem) unmarked.push(c.problem);
    }
    if (unreadable) unmarked.push(unreadable);
    const reasons = [...held, ...fill.problems.filter((f) => used.has(f.slot)).map((f) => f.why)];
    if (unmarked.length) reasons.push(`no person stands behind ${unmarked.join(", ")}`);
    if (guardian && memberProblem && used.has(ROUTINE_MEMBER_SLOT)) {
      reasons.push(`the member's name holds ${memberProblem}`);
    }
    return { reasons, shown };
  };

  // Consent to be contacted (ADR 0675): the register for every recipient, read once, and asked
  // per recipient and channel below. A refusal is final: the row is `stopped`, never held.
  const purpose = spec.purpose ?? "account";
  const essential = essentialOf(spec);
  const people = recipients.flatMap((r) => (r.personId ? [r.personId] : []));
  const choices: ChoicesInForce =
    on && people.length ? await choicesInForce(db, people) : new Map();
  // A stoppable email (an optional kind, a follow-up) carries its one-tap stop: off for the kind,
  // or for follow-ups on email. Only on the business's site; without one it has no link.
  const stopScope = stopScopeOf(p.kindId, spec);

  const rows: Insertable<CoreDatabase["core_routine_mail"]>[] = [];
  const keys: string[] = [];
  const common = (recipient: Recipient) => ({
    kind: p.kindId,
    message: p.messageName,
    extension_id: p.extensionId,
    record_object: object,
    record_id: p.record,
    recipient_rule: recipient.rule,
    recipient_person_id: recipient.personId,
    about_person_id: aboutPersonId,
    automation_id: p.automationId,
    run_id: p.runId,
    trigger_type: p.triggerType,
    triggered_by: by ? JSON.stringify(by) : null,
    related: JSON.stringify([...records.read].slice(0, 20)),
    pending_action_id: null,
    created_at: now,
    updated_at: now,
  });
  for (const recipient of recipients) {
    const guardian = !recipient.self && message.guardian !== undefined;
    const template = guardian ? message.guardian : message;
    if (!template) continue;
    const values = guardian ? guardianValues : selfValues;
    const subject = renderTemplate(parseTemplate(template.subject), values).slice(0, 300);
    // May it go to them by email at all (their choices, the suppression list)?
    const consent: ContactDecision | null = !on
      ? null
      : recipient.personId
        ? await contactDecision(
            db,
            {
              person: recipient.personId,
              channel: "email",
              purpose,
              kind: p.kindId,
              essential,
              at: now,
              address: recipient.address,
            },
            { choices, settings },
          )
        : (await suppressed(db, "email", await addressHash(db, recipient.address)))
          ? { send: false, reason: "suppressed", detail: "the address asked not to be sent to" }
          : null;
    const stopped = consent !== null && !consent.send;
    // A receipt: at most three a day to one mailbox (decision 3); the fourth is not sent at all.
    const overReceipts =
      receipt && on && !stopped && (await receiptsToday(db, p.kindId, recipient.address, now));
    // The personal link (ADR 0723): a token of its own for this one email, only for one that may
    // go. Without a link the email is not sent: it is what the email is for.
    let linkProblem: string | null = null;
    let shownValues = values;
    if (linkSlot && on && !stopped && !overReceipts && !recipient.invalid) {
      plan ??= aboutPersonId
        ? await planLink(db, p, linkSlot, aboutPersonId)
        : { failed: "no personal link could be made" };
      if ("skip" in plan) return none();
      if ("failed" in plan) {
        linkProblem = plan.failed;
      } else {
        const url = personalLinkUrl(plan.site, await linkToken(db, plan.linkId, now));
        shownValues = { ...values, [linkSlot[0]]: url };
      }
    }
    let body = renderTemplate(parseTemplate(template.text), shownValues);
    // Not sent at all, and nothing kept of its words: a fourth receipt today, or a personal
    // link that could not be made.
    const notSent = Boolean(overReceipts) || linkProblem !== null;
    const live = on && !stopped && !notSent;
    const link =
      live && stopScope && recipient.personId
        ? await stopLink(db, site, {
            person: recipient.personId,
            channel: "email",
            scope: stopScope,
          })
        : null;
    if (link) body = `${body}\n\n${STOP_WORDS} ${link}`;
    const { reasons, shown } = judge(
      [template.subject, template.text],
      guardian,
      ofRecipient.get(recipient.address) ?? [],
      calendar.length > 0,
    );
    if (subject.length > 200 || !subject.trim()) reasons.push("the subject is too long or empty");
    if (body.length > 30_000) reasons.push("the email is too long");
    if (recipient.held) reasons.push(recipient.held);
    // The daily caps are counted when the row is claimed (claimRoutineMail), not here.
    // A host kind's occasion is keyed on who it goes to, not the address: an order's address
    // changed since sends the same occasion nothing again (the review of PR #339). A pack's key is
    // ADR 0590's, unchanged.
    const key =
      p.automationId === null
        ? `${p.keyPrefix}:${p.kindId}:${p.messageName}:${p.record}:${recipient.rule}:${recipient.personId ?? (recipient.rule === "order" ? "order" : recipient.address)}`
        : `${p.keyPrefix}:${p.kindId}:${p.messageName}:${p.record}:${recipient.address}`;
    keys.push(key);
    // A host kind's email with no email channel set cannot go: kept, failed, for staff to see.
    const noConnection = on && !p.connectionId;
    rows.push({
      ...common(recipient),
      id: newId("routineMail"),
      channel: "email",
      recipient: recipient.address,
      recipient_key: mailboxKey(recipient.address),
      idempotency_key: key,
      routine: live && packOn && !reasons.length ? 1 : 0,
      ordinary: live && !packOn ? 1 : 0,
      held_reason:
        !live
          ? null
          : !packOn
            ? "routine email is not turned on for this pack: decided by the approval policy"
            : reasons.length
              ? reasons.join("; ").slice(0, 1000)
              : null,
      // An address the host cannot send to is kept, failed with the reason, in the log staff
      // read (Settings → Routine email), never dropped in silence (the fourth review).
      // One the person stopped (or whose address is suppressed) is `stopped`: kept in the log,
      // never sent and never held (ADR 0675).
      status: !on
        ? "off"
        : stopped
          ? "stopped"
          : overReceipts
            ? "over_limit"
            : recipient.invalid || noConnection || linkProblem
              ? "failed"
              : "ready",
      connection_id: live ? p.connectionId : null,
      subject: live ? subject.slice(0, 200) : null,
      body: live ? body : null,
      calendar: live && calendar.length ? JSON.stringify(calendar) : null,
      sources: JSON.stringify(unreadable ? [] : shown),
      error:
        consent && !consent.send
          ? consent.detail
          : overReceipts
            ? `${RECEIPT_DAILY_CAP} receipts went to this address in the last day`
            : linkProblem
              ? linkProblem
              : on && recipient.invalid
                ? (recipient.held ?? null)
                : noConnection
                  ? NO_EMAIL_CHANNEL
                  : null,
    });
  }

  // Text and push, per Person reached (ADR 0670): push first, then a text unless a push reached
  // them and "text only without the app" is on (decision 2). An order's own address is not a
  // Person's phone or app: email only.
  if (phoneOn) {
    // The name a text begins with and the zone quiet hours are read in are a human admin's
    // (routineMail.settings.update), never the general settings others may change.
    const sender = settings.senderName?.trim() ?? "";
    const senderProblem = sender ? unroutineText(sender, TEXT_SENDER_MAX) : null;
    const zone = settings.quietZone && isTimezone(settings.quietZone) ? settings.quietZone : null;
    for (const recipient of recipients) {
      if (recipient.rule === "order" || !recipient.personId) continue;
      const personId = recipient.personId;
      // A guardian is texted or pushed only in words declared for a guardian: a message with no
      // guardian's version goes to them by email only (the review of PR #339).
      if (!recipient.self && message.guardian === undefined) continue;
      const guardian = !recipient.self;
      const version: Version | undefined = guardian ? message.guardian : message;
      if (!version) continue;
      const values = guardian ? guardianValues : selfValues;
      let pushReached = false;
      for (const channel of ["push", "text"] as const) {
        if (!switches[channel]) continue;
        // A guardian is texted or pushed only in words declared for a guardian.
        const words =
          channel === "push"
            ? version.push
              ? [version.push.title, version.push.body]
              : null
            : version.textMessage !== undefined
              ? [version.textMessage]
              : null;
        if (!words) continue;
        const { reasons, shown } = judge(words, guardian, [], false);
        let subject: string | null = null;
        let bodyText: string;
        let segments: number | null = null;
        let tooLong: string | null = null;
        // Not set up: no zone for quiet hours, or (a text) no name to begin with.
        const unset = !zone
          ? "set the time zone quiet hours are read in (Settings → Routine email)"
          : channel === "text" && !sender
            ? "set the name texts begin with (Settings → Routine email)"
            : null;
        if (channel === "push") {
          subject = renderTemplate(parseTemplate(words[0] as string), values);
          bodyText = renderTemplate(parseTemplate(words[1] as string), values);
          if (
            !subject.trim() ||
            subject.length > PUSH_TITLE_MAX ||
            bodyText.length > PUSH_BODY_MAX
          ) {
            tooLong = `a push is a title of at most ${PUSH_TITLE_MAX} characters and a line of at most ${PUSH_BODY_MAX}`;
          }
        } else {
          if (senderProblem) reasons.push(`the business's name holds ${senderProblem}`);
          bodyText = wrapText(sender, renderTemplate(parseTemplate(words[0] as string), values));
          const counted = textSegments(bodyText);
          segments = counted.segments;
          if (counted.segments > TEXT_MAX_SEGMENTS) {
            tooLong = `the text is ${counted.segments} segments once filled: at most ${TEXT_MAX_SEGMENTS}`;
          }
        }
        // The one question (ADR 0675): their choices for the kind and its purpose on this
        // channel, the suppression list, whether they can be reached, its moment, quiet hours.
        const decision: ContactDecision =
          channel === "text" && pushReached && settings.textOnlyWithoutApp
            ? {
                send: false,
                reason: "no_device",
                detail: "reached by push (text only without the app)",
              }
            : await contactDecision(
                db,
                {
                  person: personId,
                  channel,
                  purpose,
                  kind: p.kindId,
                  essential,
                  moment: untilAt,
                  urgent: spec.urgent === true,
                  at: now,
                },
                { choices, settings, reach: p.reach },
              );
        const reached: Reached = decision.send
          ? { to: decision.to, key: decision.key }
          : { reason: decision.detail };
        let status: "ready" | "waiting" | "held" | "expired" | "no_channel" | "stopped" | "failed" =
          "ready";
        let waitUntil: string | null = null;
        let error: string | null = null;
        if (!decision.send) {
          // Their own choice, a stop or a suppressed number is `stopped`; a moment passed is
          // `expired`; no number, no device: `no_channel`. Final, never held for a person.
          status =
            decision.reason === "expired"
              ? "expired"
              : decision.reason === "not_textable" || decision.reason === "no_device"
                ? "no_channel"
                : "stopped";
          error = decision.reason === "expired" ? null : decision.detail;
        } else if (unset || tooLong) {
          status = "failed";
          error = unset ?? tooLong;
        } else {
          waitUntil = decision.waitUntil ?? null;
          // Held for a person (anything an AI wrote, a value not routine): never `ready` or
          // `waiting`, the states a sender or the end of quiet hours acts on (the review of
          // PR #339). A person's decision is the text and push steps' review.
          status = reasons.length ? "held" : waitUntil ? "waiting" : "ready";
        }
        if (channel === "push" && (status === "ready" || status === "waiting")) pushReached = true;
        const live = status === "ready" || status === "waiting" || status === "held";
        const key = `${p.keyPrefix}:${p.kindId}:${p.messageName}:${p.record}:${channel}:${personId}`;
        keys.push(key);
        rows.push({
          ...common(recipient),
          id: newId("routineMail"),
          channel,
          // The number or device only while it waits to go; the caps count its key.
          recipient: live && "to" in reached ? reached.to : "",
          recipient_key: "key" in reached ? reached.key : `${channel}:${personId}`,
          idempotency_key: key,
          routine: reasons.length ? 0 : 1,
          ordinary: 0,
          held_reason: reasons.length ? reasons.join("; ").slice(0, 1000) : null,
          status,
          connection_id: null,
          subject: live ? subject : null,
          body: live ? bodyText : null,
          calendar: null,
          sources: JSON.stringify(unreadable ? [] : shown),
          error,
          segments,
          wait_until: waitUntil,
          until_at: untilAt === null ? null : new Date(untilAt).toISOString(),
        });
      }
    }
  }

  for (const row of rows) {
    await db
      .insertInto("core_routine_mail")
      .values(row)
      .onConflict((oc) => oc.column("idempotency_key").doNothing())
      .execute();
  }
  // A host kind's email that failed only because no email channel was set goes when its occasion
  // is asked for again once one is (the review of PR #339): the occasion is not spent on it.
  if (p.automationId === null && p.connectionId && on) {
    for (let i = 0; i < keys.length; i += 90) {
      await db
        .updateTable("core_routine_mail")
        .set({ status: "ready", connection_id: p.connectionId, error: null, updated_at: now })
        .where("idempotency_key", "in", keys.slice(i, i + 90))
        .where("channel", "=", "email")
        .where("status", "=", "failed")
        .where("error", "=", NO_EMAIL_CHANNEL)
        .execute();
    }
  }
  // Read back in chunks: D1 binds at most 100 values a statement.
  const stored: { id: string; status: string; routine: number; channel: string }[] = [];
  for (let i = 0; i < keys.length; i += 90) {
    stored.push(
      ...(await db
        .selectFrom("core_routine_mail")
        .select(["id", "status", "routine", "channel"])
        .where("idempotency_key", "in", keys.slice(i, i + 90))
        .execute()),
    );
  }
  const toSend: PreparedRoutineMail["toSend"] = [];
  const done: PreparedRoutineMail["done"] = [];
  const phone: PreparedRoutineMail["phone"] = [];
  for (const row of stored) {
    if (row.channel === "text" || row.channel === "push") {
      phone.push({
        id: row.id,
        channel: row.channel,
        status: row.status,
        routine: row.routine === 1,
      });
    } else if (row.status === "ready" || row.status === "sending") {
      toSend.push({ id: row.id, routine: row.routine === 1 });
    } else {
      done.push({ id: row.id, status: row.status, routine: row.routine === 1 });
    }
  }
  return { kind: p.kindId, off: !on, toSend, done, phone, none: false };
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
    fill.problems.push({ slot: name, why: `${name} cannot be read` });
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
    // Which records are the lines is shown too (the fourth review): the field that ties each to
    // the record, the field that picks it, and the line record's own creation, none an AI's. An
    // AI re-pointing another buyer's ticket at this order holds the email.
    records.note(object, item.id, each.via, "link");
    if (each.where) records.note(object, item.id, each.where.field, "link");
    records.note(object, item.id, CREATED, "link");
    if (each.distinct) {
      const d = String((await walk(records, object, item, each.distinct)) ?? "");
      if (seen.has(d)) continue;
      seen.add(d);
    }
    const itemFill: Fill = { values: {}, problems: [] };
    for (const [inner, innerSlot] of Object.entries(each.slots)) {
      await fieldSlot(records, object, item, inner, innerSlot, itemFill);
    }
    fill.problems.push(...itemFill.problems.map((p) => ({ slot: name, why: `${name}: ${p.why}` })));
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
    if (titleWhy)
      fill.problems.push({ slot: CALENDAR, why: `the calendar's title holds ${titleWhy}` });
    const location = event.location
      ? text(await walk(records, object, record, event.location))
      : null;
    const locationWhy = location ? unroutineText(location, 200) : null;
    if (locationWhy) {
      fill.problems.push({ slot: CALENDAR, why: `the calendar's place holds ${locationWhy}` });
    }
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
  /** Null for a host kind's row (ADR 0670): host code asked for it, not an automation. */
  automationId: string | null;
  runId: string | null;
  extensionId: string;
  message: {
    to: string[];
    subject: string;
    text: string;
    relatedRecords: string[];
    calendar?: unknown;
    /**
     * The one-tap stop of a stoppable email (ADR 0675): the email gatekeeper sets the
     * List-Unsubscribe and List-Unsubscribe-Post headers to it, for the host's routine mail only.
     */
    listUnsubscribe?: string;
  };
}

/**
 * Asks the register again at the moment of sending (ADR 0675): a choice made, a stop taken or an
 * address suppressed since the row was prepared. Null when it may go, else why not.
 */
async function consentAtSend(
  db: Db,
  row: {
    recipient_person_id: string | null;
    recipient: string;
    recipient_key?: string;
    channel: string;
  },
  kind: RoutineKind | null,
): Promise<string | null> {
  const channel = row.channel === "text" || row.channel === "push" ? row.channel : "email";
  if (kind && row.recipient_person_id) {
    const refused = await registerRefusal(db, {
      person: row.recipient_person_id,
      channel,
      purpose: kind.spec.purpose ?? "account",
      kind: kind.id,
      essential: essentialOf(kind.spec),
    });
    if (refused && !refused.send) return refused.detail;
  }
  if (channel === "email" && row.recipient) {
    if (await suppressed(db, "email", await addressHash(db, row.recipient))) {
      return "the address asked not to be sent to";
    }
  }
  if (channel === "text" && row.recipient_key?.startsWith("text:")) {
    if (await suppressed(db, "text", row.recipient_key.slice(5))) return "the number replied STOP";
  }
  return null;
}

/**
 * A held routine message a person is about to approve (ADR 0675): asked again, because nobody
 * may approve around a stop. Null when it may go; else the row is settled `stopped`, its words
 * cleared, and the reason returned for the approval to be skipped with.
 */
export async function stopHeldRoutineMessage(
  db: Db,
  pendingActionId: string,
  now = new Date().toISOString(),
): Promise<string | null> {
  const row = await db
    .selectFrom("core_routine_mail")
    .select(["id", "kind", "channel", "recipient", "recipient_key", "recipient_person_id"])
    .where("pending_action_id", "=", pendingActionId)
    .executeTakeFirst();
  if (!row) return null;
  // A kind gone since (its pack uninstalled): the register's choices for it cannot be read, but
  // the suppression list still holds.
  const kind = (await routineKinds(db)).find((k) => k.id === row.kind) ?? null;
  const refused = await consentAtSend(db, row, kind);
  if (!refused) return null;
  await db
    .updateTable("core_routine_mail")
    .set({
      status: "stopped",
      routine: 0,
      error: refused,
      updated_at: now,
      subject: null,
      body: null,
      calendar: null,
      recipient: sql<string>`CASE WHEN channel = 'email' THEN recipient ELSE '' END`,
    })
    .where("id", "=", row.id)
    .execute();
  return refused;
}

/**
 * Claims a row to send through `connectionId`; null when it is not one to send there now, `off`
 * when its kind was turned off since it was prepared (F2: settled `off`, nothing sent), `stopped`
 * when the person stopped it (or their address was suppressed) since: settled, nothing sent. The pack
 * switch is read again too (D1), and the daily caps are counted here, in the one statement that
 * claims a routine row (D4): per mailbox (plus-tags and case folded) and for the organisation,
 * so runs claiming at once cannot race past either. Over a cap the row is held for a person.
 */
export async function claimRoutineMail(
  db: Db,
  id: string,
  connectionId: string,
  now = new Date().toISOString(),
): Promise<RoutineMailRow | "off" | "stopped" | null> {
  let row = await db
    .selectFrom("core_routine_mail")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row || (row.status !== "ready" && row.status !== "sending")) return null;
  // A text or push goes through its own gatekeeper, never the email path (ADR 0670).
  if (row.channel !== "email") return null;
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
  const refused = await consentAtSend(db, row, kind);
  if (refused) {
    await db
      .updateTable("core_routine_mail")
      .set({
        status: "stopped",
        routine: 0,
        error: refused,
        updated_at: now,
        subject: null,
        body: null,
        calendar: null,
      })
      .where("id", "=", id)
      .execute();
    return "stopped";
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
              // Emails only: a text has its own caps and the month's limit (ADR 0672).
              .where("o.channel", "=", "email")
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
  const stopScope = stopScopeOf(kind.id, kind.spec);
  // Its header only on one the host decided routine (a held one carries its stop in its words,
  // and the gatekeeper takes the header from the host's routine mail alone), and only the very
  // link its words end with, on the site as it is now and naming this row's Person and kind. A
  // site changed since it was prepared leaves the header off: the email is then an ordinary send,
  // held for a person, never refused and retried (the review of PR #451).
  const listUnsubscribe =
    stopScope && row.recipient_person_id && row.routine === 1
      ? await stopLinkOf(db, row.body, siteOriginOf(settings.siteOrigin), {
          person: row.recipient_person_id,
          channel: "email",
          scope: stopScope,
        })
      : null;
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
      ...(listUnsubscribe ? { listUnsubscribe } : {}),
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
      // A text's number or a push's device is not kept once it is decided (ADR 0670).
      ...(keep
        ? {}
        : { recipient: sql<string>`CASE WHEN channel = 'email' THEN recipient ELSE '' END` }),
    })
    .where("id", "=", id)
    .execute();
}

/**
 * The end of quiet hours (ADR 0676): texts and pushes that waited for it are `ready` to go again,
 * or `expired` when their moment (`until_at`) passed while they waited (their emails went when
 * they were prepared). Each is decided again first, as an email is when it is claimed (F2): its
 * kind turned off, its pack's routine messages or its channel switched off since: `off`; not
 * routine: `held`, never `ready` (the review of PR #339). Batches of 500 until none is left, at
 * most `rounds` a call; the runner's minute cron calls it. Returns the rows made ready, for their
 * gatekeepers' glue to send, which must decide them again when it claims one.
 */
export async function releaseWaitingRoutineMessages(
  db: Db,
  now = new Date().toISOString(),
  rounds = 10,
): Promise<{ ready: { id: string; channel: "text" | "push" }[]; expired: number }> {
  const out: { id: string; channel: "text" | "push" }[] = [];
  let expired = 0;
  const kinds = new Map((await routineKinds(db)).map((k) => [k.id, k]));
  const set = async (ids: string[], values: Updateable<CoreDatabase["core_routine_mail"]>) => {
    // Chunks well under D1's 100 bound values a statement.
    for (let i = 0; i < ids.length; i += 90) {
      await db
        .updateTable("core_routine_mail")
        .set(values)
        .where("id", "in", ids.slice(i, i + 90))
        .where("status", "=", "waiting")
        .execute();
    }
  };
  for (let round = 0; round < rounds; round += 1) {
    const due = await db
      .selectFrom("core_routine_mail")
      .select(["id", "kind", "channel", "routine", "until_at"])
      .where("status", "=", "waiting")
      .where("wait_until", "is not", null)
      .where("wait_until", "<=", now)
      .where("pending_action_id", "is", null)
      .orderBy("wait_until")
      .limit(500)
      .execute();
    const late: string[] = [];
    const off: string[] = [];
    const held: string[] = [];
    const ready: { id: string; channel: "text" | "push" }[] = [];
    for (const row of due) {
      const kind = kinds.get(row.kind);
      const channel = row.channel === "text" || row.channel === "push" ? row.channel : null;
      if (!channel || !kind?.on || !kind.packOn || !kind.channels[channel]) off.push(row.id);
      else if (row.until_at !== null && row.until_at <= now) late.push(row.id);
      else if (row.routine !== 1) held.push(row.id);
      else ready.push({ id: row.id, channel });
    }
    const cleared = { subject: null, body: null, recipient: "", updated_at: now };
    await set(late, { status: "expired", ...cleared });
    await set(off, { status: "off", routine: 0, ...cleared });
    await set(held, { status: "held", updated_at: now });
    await set(
      ready.map((r) => r.id),
      { status: "ready", updated_at: now },
    );
    out.push(...ready);
    expired += late.length;
    if (due.length < 500) break;
  }
  return { ready: out, expired };
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
