// routineMail.* operations (ADR 0590): what the admin sees of routine mail (each kind the shipped
// packs declare, whether it is on, and what was sent on its own) and the switches. Reading is for
// admins (the log names members' addresses). Changing a switch or the business's site is a
// human admin's only: no assistant, MCP client, automation or extension may turn routine mail on
// or point its links somewhere.
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

const settingsOutput = z.object({
  kinds: z.array(kindSchema),
  siteOrigin: z
    .string()
    .nullable()
    .describe("The business's own site: the only place a routine email links to"),
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
    return {
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
          defaultOn: k.spec.on !== false,
          lastWeek: {
            sent: of(["sent"]),
            waiting: of(["waiting", "ready", "sending"]),
            off: of(["off"]),
            other: of(["denied", "failed"]),
          },
        };
      }),
      siteOrigin: settings.siteOrigin,
      sendsOnItsOwn: gate.decision,
    };
  },
});

const logEntry = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.string(),
  message: z.string(),
  object: z.string(),
  recordId: z.string(),
  recipient: z.string(),
  recipientRule: z
    .enum(["person", "guardian", "order"])
    .describe(
      "How the host chose the recipient: the record's person, their guardian, or a paid order's own address",
    ),
  automationId: z.string(),
  runId: z.string(),
  trigger: z
    .string()
    .describe("What started the run: record, fieldChanged, dateRelative, schedule, manual…"),
  triggeredBy: z
    .object({ actor: z.string(), userId: z.string().nullable(), approved: z.boolean() })
    .nullable()
    .describe("Who made the change that started it; null for the clock"),
  routine: z.boolean().describe("Allowed to go without a person"),
  heldReason: z.string().nullable(),
  status: z.enum(["off", "ready", "sending", "sent", "waiting", "denied", "failed"]),
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
    status: z.enum(["off", "ready", "sending", "sent", "waiting", "denied", "failed"]).optional(),
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
        "recipient",
        "recipient_rule",
        "automation_id",
        "run_id",
        "trigger_type",
        "triggered_by",
        "routine",
        "held_reason",
        "status",
        "pending_action_id",
        "error",
      ])
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(input.limit);
    if (input.kind) query = query.where("kind", "=", input.kind);
    if (input.status) query = query.where("status", "=", input.status);
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
          recipient: r.recipient,
          recipientRule: r.recipient_rule,
          automationId: r.automation_id,
          runId: r.run_id,
          trigger: r.trigger_type,
          triggeredBy: by,
          routine: r.routine === 1,
          heldReason: r.held_reason,
          status: r.status,
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
    "Turn one kind of routine email on or off (kinds: { 'bookings.reminder': false }: off sends " +
    "nothing and queues nothing), or set the business's own site, the only place routine email " +
    "links to (siteOrigin, an https origin; null removes the links). Only what you pass changes. " +
    "Admins only, and only a human can call it: AI assistants, MCP clients, automations and " +
    "extensions are refused.",
  input: z.object({
    kinds: z.record(z.string().max(80), z.boolean()).optional(),
    siteOrigin: z.string().max(200).nullable().optional(),
  }),
  output: z.object({
    kinds: z.record(z.string(), z.boolean()),
    siteOrigin: z.string().nullable(),
  }),
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    if (input.kinds === undefined && input.siteOrigin === undefined) {
      throw new ValidationError("Pass kinds, siteOrigin or both");
    }
    const declared = new Set((await routineKinds(ctx.db)).map((k) => k.id));
    for (const id of Object.keys(input.kinds ?? {})) {
      if (!declared.has(id)) {
        throw new ValidationError(`No shipped pack declares routine email "${id}"`, { kind: id });
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
      kinds: { ...previous.kinds, ...(input.kinds ?? {}) },
      siteOrigin: siteOrigin === undefined ? previous.siteOrigin : siteOrigin,
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
