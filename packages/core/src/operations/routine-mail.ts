// routineMail.* operations (ADR 0590): what the admin sees of routine mail (each kind the shipped
// packs declare, whether it is on, and what was sent on its own) and the switches. Reading is for
// admins (the log names members' addresses). Changing a switch or the business's site is a
// human admin's only: no assistant, MCP client, automation or extension may turn routine mail on
// or point its links somewhere.
//
// Routine messages (ADR 0670): each kind's text and push, switched on by a human admin within what
// the kind declares; "text only without the app"; quiet hours (ADR 0676). The host's own kinds
// (`core.*`) are listed with the packs' and turned on the same way.
import { channelsOf, essentialOf, ROUTINE_CHANNELS } from "@composable-os/sdk";
import { z } from "zod";
import { ValidationError } from "../errors.ts";
import { evaluateGate } from "../gate.ts";
import { defineOperation } from "../operation.ts";
import {
  loadRoutineMailSettings,
  ROUTINE_MAIL_SETTING,
  routineKinds,
  siteOriginOf,
} from "../routine-mail/index.ts";
import { quietHoursSchema } from "../routine-mail/quiet.ts";
import { loadApprovalPolicy } from "../settings.ts";

const kindSchema = z.object({
  id: z.string().describe("The kind: <extension>.<kind>, e.g. bookings.reminder"),
  extension: z.string(),
  extensionLabel: z.string(),
  label: z.string(),
  description: z.string(),
  about: z.string().describe("The object each email is about"),
  messages: z.array(z.string()),
  on: z.boolean().describe("Sent; off sends nothing and queues nothing"),
  defaultOn: z.boolean(),
  host: z.boolean().describe("Declared by the host itself (asked for by host code), not a pack"),
  channels: z
    .array(
      z.object({
        channel: z.enum(ROUTINE_CHANNELS),
        on: z
          .boolean()
          .describe("Email follows the kind's switch; text and push are switched on one by one"),
      }),
    )
    .describe("The channels the kind declares, and which are on"),
  essential: z
    .boolean()
    .describe("Its email always goes: a person cannot turn it off (text and push they can)"),
  purpose: z.enum(["account", "follow_up"]),
  urgent: z
    .boolean()
    .describe(
      "May go during quiet hours when waiting would make it late (a short-notice cancellation)",
    ),
  lastWeek: z
    .object({
      sent: z.number().int(),
      waiting: z.number().int(),
      off: z.number().int(),
      other: z.number().int(),
    })
    .describe(
      "Emails of this kind in the last 7 days: sent on their own (or once approved), waiting for a person, not sent because the kind was off, and refused or failed",
    ),
});

const packSchema = z.object({
  id: z.string(),
  label: z.string(),
  on: z
    .boolean()
    .describe(
      "Turned on by a human admin: its kinds send without approval. Off (the default): each " +
        "of its emails is an ordinary send the approval policy decides, as before routine mail",
    ),
});

const settingsOutput = z.object({
  packs: z.array(packSchema),
  kinds: z.array(kindSchema),
  orgDailyCap: z
    .number()
    .int()
    .describe("Routine emails the organisation sends in a day before the rest wait for a person"),
  retentionMonths: z.number().int().describe("Months the log is kept"),
  siteOrigin: z
    .string()
    .nullable()
    .describe("The business's own site: the only place a routine email links to"),
  textOnlyWithoutApp: z
    .boolean()
    .describe("A member reached by a push on the business's app is not also texted"),
  quietHours: quietHoursSchema.describe(
    "When texts and pushes wait, in the business's time zone; emails always go at once",
  ),
  sendsOnItsOwn: z
    .enum(["auto", "review", "deny"])
    .describe(
      "What the approval policy and the deploy floor do with routine mail now: auto (it sends on its own), review (each waits for a person: the Cautious policy, or a floor of review on outbound) or deny (a floor refuses outbound)",
    ),
});

export const routineMailGet = defineOperation({
  name: "routineMail.get",
  description:
    "Routine email (ADR 0590): every kind the shipped packs declare (a booking's confirmation, a " +
    "class reminder) with whether it is on and how many were sent on their own, waited for a " +
    "person or were not sent in the last 7 days; the business's site the emails may link to; and " +
    "whether the approval policy lets routine email go out on its own now. Admins only. Read-only.",
  input: z.object({}),
  output: settingsOutput,
  permission: "audit:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    const kinds = await routineKinds(ctx.db);
    const since = new Date(Date.parse(ctx.now) - 7 * 86_400_000).toISOString();
    const counts = await ctx.db
      .selectFrom("core_routine_mail")
      .select(["kind", "status", (eb) => eb.fn.countAll<number>().as("n")])
      .where("created_at", ">", since)
      .groupBy(["kind", "status"])
      .execute();
    const settings = await loadRoutineMailSettings(ctx.db);
    const gate = evaluateGate(
      {
        actor: "automation",
        risk: "outbound",
        outbound: { autoApprovable: false, enabled: false, routine: true },
      },
      await loadApprovalPolicy(ctx.db),
      ctx.floor,
    );
    const packs = new Map<string, { id: string; label: string; on: boolean }>();
    for (const k of kinds) {
      // The host's own kinds have no pack to turn on: each kind is turned on by itself.
      if (k.host) continue;
      packs.set(k.extensionId, { id: k.extensionId, label: k.extensionLabel, on: k.packOn });
    }
    return {
      packs: [...packs.values()],
      orgDailyCap: settings.orgDailyCap,
      retentionMonths: settings.retentionMonths,
      kinds: kinds.map((k) => {
        const of = (status: string[]) =>
          counts
            .filter((c) => c.kind === k.id && status.includes(c.status))
            .reduce((sum, c) => sum + Number(c.n), 0);
        return {
          id: k.id,
          extension: k.extensionId,
          extensionLabel: k.extensionLabel,
          label: k.spec.label,
          description: k.spec.description,
          about: k.spec.about,
          messages: Object.keys(k.spec.messages),
          on: k.on,
          defaultOn: !k.host && k.spec.on !== false,
          host: k.host,
          channels: channelsOf(k.spec).map((channel) => ({
            channel,
            on: channel === "email" ? k.on : k.on && k.channels[channel],
          })),
          essential: essentialOf(k.spec),
          purpose: k.spec.purpose ?? "account",
          urgent: k.spec.urgent === true,
          lastWeek: {
            sent: of(["sent", "delivered"]),
            waiting: of(["waiting", "ready", "sending"]),
            off: of(["off"]),
            other: of(["denied", "failed", "stopped", "expired", "over_limit", "no_channel"]),
          },
        };
      }),
      siteOrigin: settings.siteOrigin,
      textOnlyWithoutApp: settings.textOnlyWithoutApp,
      quietHours: settings.quietHours,
      sendsOnItsOwn: gate.decision,
    };
  },
});

const STATUSES = [
  "off",
  "ready",
  "sending",
  "sent",
  "delivered",
  "waiting",
  "denied",
  "failed",
  "stopped",
  "expired",
  "over_limit",
  "no_channel",
] as const;

const logEntry = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.string(),
  message: z.string(),
  object: z.string(),
  recordId: z.string(),
  channel: z.enum(ROUTINE_CHANNELS),
  recipient: z.string().describe("The address an email went to; always empty for a text or push"),
  recipientRule: z
    .enum(["person", "guardian", "order"])
    .describe(
      "How the host chose the recipient: the record's person, their guardian, or a paid order's own address",
    ),
  automationId: z.string().nullable().describe("Null for a host kind's message"),
  runId: z.string().nullable(),
  trigger: z
    .string()
    .describe("What started the run: record, fieldChanged, dateRelative, schedule, manual…"),
  triggeredBy: z
    .object({ actor: z.string(), userId: z.string().nullable(), approved: z.boolean() })
    .nullable()
    .describe("Who made the change that started it; null for the clock"),
  routine: z.boolean().describe("Allowed to go without a person"),
  heldReason: z.string().nullable(),
  status: z
    .enum(STATUSES)
    .describe(
      "sent, delivered (a text the provider confirmed), waiting (for a person, or for quiet hours to end: waitUntil), off, denied, failed, stopped, expired (its moment passed while it waited), over_limit (the month's text limit), no_channel (no address, textable number or app device)",
    ),
  waitUntil: z.string().nullable().describe("Quiet hours: when a waiting text or push goes"),
  pendingActionId: z.string().nullable(),
  error: z.string().nullable(),
});

export const routineMailLog = defineOperation({
  name: "routineMail.log",
  description:
    "The routine email log (ADR 0590), newest first: each email a shipped pack's automation asked " +
    "for, its kind, the record it is about, who it went to and by which rule (the record's person, " +
    "their guardian or a paid order's own address), what started it and who made that change, " +
    "whether it went on its own or was held for a person and why, and what became of it. Filter " +
    "by kind or status. Admins only. Read-only.",
  input: z.object({
    kind: z.string().max(80).optional(),
    status: z.enum(STATUSES).optional(),
    channel: z.enum(ROUTINE_CHANNELS).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({ items: z.array(logEntry) }),
  permission: "audit:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    let query = ctx.db
      .selectFrom("core_routine_mail")
      .select([
        "id",
        "created_at",
        "kind",
        "message",
        "record_object",
        "record_id",
        "channel",
        "recipient",
        "recipient_rule",
        "automation_id",
        "run_id",
        "trigger_type",
        "triggered_by",
        "routine",
        "held_reason",
        "status",
        "wait_until",
        "pending_action_id",
        "error",
      ])
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(input.limit);
    if (input.kind) query = query.where("kind", "=", input.kind);
    if (input.status) query = query.where("status", "=", input.status);
    if (input.channel) query = query.where("channel", "=", input.channel);
    const rows = await query.execute();
    return {
      items: rows.map((r) => {
        let by: { actor: string; userId: string | null; approved: boolean } | null = null;
        try {
          by = r.triggered_by ? JSON.parse(r.triggered_by) : null;
        } catch {}
        return {
          id: r.id,
          at: r.created_at,
          kind: r.kind,
          message: r.message,
          object: r.record_object,
          recordId: r.record_id,
          channel: r.channel,
          // A text's number or a push's device is never shown, even while it waits (ADR 0670).
          recipient: r.channel === "email" ? r.recipient : "",
          recipientRule: r.recipient_rule,
          automationId: r.automation_id,
          runId: r.run_id,
          trigger: r.trigger_type,
          triggeredBy: by,
          routine: r.routine === 1,
          heldReason: r.held_reason,
          status: r.status,
          waitUntil: r.wait_until,
          pendingActionId: r.pending_action_id,
          error: r.error,
        };
      }),
    };
  },
});

export const routineMailSettingsUpdate = defineOperation({
  name: "routineMail.settings.update",
  description:
    "Turn a pack's routine email on (packs: { bookings: true }: its kinds then send without " +
    "approval; off, each is an ordinary send the policy decides), turn one kind on or off " +
    "(kinds: { 'bookings.reminder': false }: off sends " +
    "nothing and queues nothing), or set the business's own site, the only place routine email " +
    "links to (siteOrigin, an https origin; null removes the links), the organisation's daily " +
    "limit (orgDailyCap) or how long the log is kept (retentionMonths). Switch a kind's text or push " +
    "on (channels: { 'bookings.reminder': { push: true } }, only channels the kind declares), " +
    "whether a member reached by push is also texted (textOnlyWithoutApp), or quiet hours, when " +
    "texts and pushes wait (quietHours: { start: '21:00', end: '07:00' }, the business's time " +
    "zone; the same start and end: none). Only what you pass changes. " +
    "Admins only, and only a human can call it: AI assistants, MCP clients, automations and " +
    "extensions are refused.",
  input: z.object({
    packs: z.record(z.string().max(40), z.boolean()).optional(),
    kinds: z.record(z.string().max(80), z.boolean()).optional(),
    siteOrigin: z.string().max(200).nullable().optional(),
    orgDailyCap: z.number().int().min(1).max(100_000).optional(),
    retentionMonths: z.number().int().min(1).max(84).optional(),
    channels: z
      .record(
        z.string().max(80),
        z.object({ text: z.boolean().optional(), push: z.boolean().optional() }).strict(),
      )
      .optional(),
    textOnlyWithoutApp: z.boolean().optional(),
    quietHours: quietHoursSchema.optional(),
  }),
  output: z.object({
    packs: z.record(z.string(), z.boolean()),
    kinds: z.record(z.string(), z.boolean()),
    siteOrigin: z.string().nullable(),
    orgDailyCap: z.number().int(),
    retentionMonths: z.number().int(),
    channels: z.record(
      z.string(),
      z.object({ text: z.boolean().optional(), push: z.boolean().optional() }),
    ),
    textOnlyWithoutApp: z.boolean(),
    quietHours: quietHoursSchema,
  }),
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    if (Object.values(input).every((v) => v === undefined)) {
      throw new ValidationError("Pass what to change");
    }
    const declaredKinds = await routineKinds(ctx.db);
    const declared = new Set(declaredKinds.map((k) => k.id));
    const declaredPacks = new Set(declaredKinds.filter((k) => !k.host).map((k) => k.extensionId));
    for (const id of Object.keys(input.packs ?? {})) {
      if (!declaredPacks.has(id)) {
        throw new ValidationError(`No shipped pack ${id} declares routine email`, { pack: id });
      }
    }
    for (const id of Object.keys(input.kinds ?? {})) {
      if (!declared.has(id)) {
        throw new ValidationError(`No shipped pack declares routine email "${id}"`, { kind: id });
      }
    }
    for (const [id, switches] of Object.entries(input.channels ?? {})) {
      const kind = declaredKinds.find((k) => k.id === id);
      if (!kind) {
        throw new ValidationError(`No shipped pack declares routine email "${id}"`, { kind: id });
      }
      const has = new Set(channelsOf(kind.spec));
      for (const channel of ["text", "push"] as const) {
        if (switches[channel] !== undefined && !has.has(channel)) {
          throw new ValidationError(`${id} does not go by ${channel}`, { kind: id, channel });
        }
      }
    }
    let siteOrigin: string | null | undefined;
    if (input.siteOrigin !== undefined) {
      siteOrigin = input.siteOrigin === null ? null : siteOriginOf(input.siteOrigin.trim());
      if (input.siteOrigin !== null && !siteOrigin) {
        throw new ValidationError(
          "The site must be an https origin with nothing after it, e.g. https://www.example.com",
          { field: "siteOrigin" },
        );
      }
    }
    const previous = await loadRoutineMailSettings(ctx.db);
    const next = {
      packs: { ...previous.packs, ...(input.packs ?? {}) },
      kinds: { ...previous.kinds, ...(input.kinds ?? {}) },
      siteOrigin: siteOrigin === undefined ? previous.siteOrigin : siteOrigin,
      orgDailyCap: input.orgDailyCap ?? previous.orgDailyCap,
      retentionMonths: input.retentionMonths ?? previous.retentionMonths,
      channels: Object.fromEntries(
        [...new Set([...Object.keys(previous.channels), ...Object.keys(input.channels ?? {})])].map(
          (id) => [id, { ...previous.channels[id], ...input.channels?.[id] }],
        ),
      ),
      textOnlyWithoutApp: input.textOnlyWithoutApp ?? previous.textOnlyWithoutApp,
      quietHours: input.quietHours ?? previous.quietHours,
    };
    const value = JSON.stringify(next);
    ctx.write(
      ctx.db
        .insertInto("core_settings")
        .values({ key: ROUTINE_MAIL_SETTING, value, updated_at: ctx.now, updated_by: ctx.user.id })
        .onConflict((oc) =>
          oc.column("key").doUpdateSet({ value, updated_at: ctx.now, updated_by: ctx.user.id }),
        ),
    );
    ctx.recordChange({
      object: "settings",
      id: ROUTINE_MAIL_SETTING,
      action: "update",
      before: previous,
      after: next,
    });
    return next;
  },
});

export const routineMailOperations = [
  routineMailGet,
  routineMailLog,
  routineMailSettingsUpdate,
] as const;
