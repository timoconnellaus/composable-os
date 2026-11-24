// Accounting sync's operations, settings and mapping (stage 61 step 2). The host sends its own
// money to the books a human admin connected; core speaks one contract and never names a system
// (ADR 0880).
//
//   accounting.settings.get     accounting:manage: the books chosen, the start date, approval, the
//                               settle delay, on or off, the mapping, the connections to choose
//   accounting.settings.update  a human admin (settings:manage): choose the books, the start date,
//                               approval, the settle delay, turn the sync on or off
//   accounting.map.set          accounting:manage, a person: which books account or tax rate one
//                               kind of host money goes to
//   accounting.map.clear        accounting:manage, a person: forget one mapping row
//
// Every write is a person's whatever is granted (`actors: ["human"]`): no assistant, MCP client,
// automation or extension changes where the business's money goes in its books. None is open to
// customers or the public (ADR 0402), and none writes an order, a payment or a refund.

import { z } from "zod";
import {
  ACCOUNTING_MAP_KINDS,
  booksChoices,
  DEFAULT_APPROVE_UNTIL,
  loadAccountingSettings,
  loadMapping,
  MAX_APPROVE_UNTIL,
  MAX_SETTLE_DAYS,
  mapKey,
  mapTarget,
  requireBooks,
  requireConnection,
} from "../accounting/settings.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { defineOperation } from "../operation.ts";
import { parseLocalDate } from "../time/local.ts";

const localDate = z
  .string()
  .refine((d) => parseLocalDate(d) !== null, "A date as YYYY-MM-DD")
  .describe("A date, YYYY-MM-DD");

const mapKind = z
  .enum(ACCOUNTING_MAP_KINDS)
  .describe(
    "What is mapped: `category` (a kind of sale, by its category key), `tax` (a tax code, to a " +
      "tax rate), `fees` (the payment provider's fees), `clearing` (card money on its way to the " +
      "bank), `bank` (where payouts land), `method` (a recorded-payment kind: transfer, cash, " +
      "cheque, card machine, other), `rounding`, `refunds`, `invoice_default` (an invoice line " +
      "with no category)",
  );

const mappingRow = z.object({
  kind: z.enum(ACCOUNTING_MAP_KINDS),
  hostKey: z.string().nullable(),
  target: z.enum(["account", "tax_rate"]),
  booksRef: z.string(),
  booksName: z.string(),
  setBy: z.string(),
  setAt: z.string(),
});

const settingsShape = z.object({
  books: z
    .object({
      connectionId: z.string(),
      resource: z.string(),
      title: z.string().nullable(),
      status: z.string().nullable(),
    })
    .nullable()
    .describe("The accounting connection and the books on it, or null when none is chosen"),
  startDate: z.string().nullable().describe("Nothing dated before it is ever sent"),
  enabled: z.boolean(),
  approval: z.object({
    approvedDays: z.number().int(),
    approveUntil: z.number().int(),
    automatic: z.boolean().describe("Approval is over: entries go without a person approving"),
  }),
  settleDays: z.number().int(),
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const accountingSettingsGet = defineOperation({
  name: "accounting.settings.get",
  description:
    "The accounting sync's settings: the books chosen (an accounting connection and the books on " +
    "it), the start date (nothing dated before it is sent), whether it is on, approval (how many " +
    "days a person has approved and after how many sending is automatic), the settle delay, the " +
    "mapping (which of the books' accounts and tax rates each kind of sale, tax, fee, payout and " +
    "recorded payment goes to) and the accounting connections an admin may choose. Read-only.",
  input: z.object({}),
  output: settingsShape.extend({
    mapping: z.array(mappingRow),
    choices: z.array(
      z.object({
        connectionId: z.string(),
        vendor: z.string(),
        title: z.string(),
        status: z.string(),
        resources: z.array(z.object({ key: z.string(), url: z.string().nullable() })),
      }),
    ),
  }),
  permission: "accounting:manage",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    const settings = await loadAccountingSettings(ctx.db);
    const choices = await booksChoices(ctx.db);
    const mapping = settings.connectionId ? await loadMapping(ctx.db, settings.connectionId) : [];
    const chosen = choices.find((c) => c.connectionId === settings.connectionId);
    return {
      books:
        settings.connectionId && settings.resource
          ? {
              connectionId: settings.connectionId,
              resource: settings.resource,
              title: chosen?.title ?? null,
              status: chosen?.status ?? null,
            }
          : null,
      startDate: settings.startDate,
      enabled: settings.enabled,
      approval: {
        approvedDays: settings.approvedDays,
        approveUntil: settings.approveUntil,
        automatic: settings.automatic,
      },
      settleDays: settings.settleDays,
      updatedBy: settings.updatedBy,
      updatedAt: settings.updatedAt,
      mapping: mapping.map((m) => ({ ...m, target: mapTarget(m.kind) })),
      choices,
    };
  },
});

export const accountingSettingsUpdate = defineOperation({
  name: "accounting.settings.update",
  description:
    "Change the accounting sync's settings (a human admin): choose the books (an accounting " +
    "connection made in Settings → Integrations, and the books bound on it), the start date " +
    "(nothing dated before it is ever sent; fixed once anything was sent), the number of days a " +
    `person approves before sending is automatic (${DEFAULT_APPROVE_UNTIL} to ${MAX_APPROVE_UNTIL}), ` +
    "putting approval back on (`restartApproval`: the count starts again), the settle delay in " +
    "days, and turning it on or off. Turning it on needs the books, an active connection and a " +
    "start date; the books change only while it is off.",
  input: z.object({
    books: z
      .object({
        connectionId: z.string().min(1).max(64),
        resource: z.string().min(1).max(200).describe("The books' resource key on the connection"),
      })
      .nullable()
      .optional()
      .describe("The books; null clears them (only while off)"),
    startDate: localDate.optional(),
    approveUntil: z.number().int().min(DEFAULT_APPROVE_UNTIL).max(MAX_APPROVE_UNTIL).optional(),
    restartApproval: z
      .literal(true)
      .optional()
      .describe(
        "Put approval back on: every day waits for a person again until the count is reached",
      ),
    settleDays: z.number().int().min(1).max(MAX_SETTLE_DAYS).optional(),
    enabled: z.boolean().optional(),
  }),
  output: settingsShape,
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const before = await loadAccountingSettings(ctx.db);
    let connectionId = before.connectionId;
    let resource = before.resource;
    let title: string | null = null;
    let status: string | null = null;
    if (input.books !== undefined) {
      const same =
        input.books?.connectionId === before.connectionId &&
        input.books?.resource === before.resource;
      if (!same && before.enabled && input.enabled !== false) {
        throw new ConflictError("Turn the sync off before choosing other books", {
          rule: "accounting_books_while_on",
        });
      }
      if (input.books) {
        const books = await requireBooks(ctx.db, input.books.connectionId, input.books.resource);
        connectionId = books.connectionId;
        resource = input.books.resource;
        title = books.title;
        status = books.status;
      } else {
        connectionId = null;
        resource = null;
      }
    } else if (connectionId && resource) {
      const books = await requireBooks(ctx.db, connectionId, resource).catch(() => null);
      title = books?.title ?? null;
      status = books?.status ?? null;
    }

    const startDate = input.startDate ?? before.startDate;
    if (input.startDate !== undefined && input.startDate !== before.startDate) {
      // Moving it after an entry went would send days again or leave a gap in the books.
      const sent = await ctx.db
        .selectFrom("core_accounting_post")
        .select("id")
        .where("state", "=", "sent")
        .limit(1)
        .executeTakeFirst();
      if (sent) {
        throw new ConflictError(
          "Entries were already sent from the start date, so it no longer changes",
          { rule: "accounting_start_fixed" },
        );
      }
    }

    const enabled = input.enabled ?? before.enabled;
    if (enabled) {
      if (!connectionId || !resource) {
        throw new ValidationError("Choose the books before turning the sync on", {
          field: "books",
          rule: "accounting_no_books",
        });
      }
      if (!startDate) {
        throw new ValidationError("Set the start date before turning the sync on", {
          field: "startDate",
          rule: "accounting_no_start",
        });
      }
      if (!before.enabled && status !== "active") {
        throw new ConflictError(
          "The accounting connection is not active: an admin reconnects it in Settings → Integrations",
          { rule: "accounting_connection_inactive" },
        );
      }
    }

    const approvedDays = input.restartApproval ? 0 : before.approvedDays;
    const approveUntil = input.approveUntil ?? before.approveUntil;
    const settleDays = input.settleDays ?? before.settleDays;
    const values = {
      connection_id: connectionId,
      resource,
      start_date: startDate,
      approved_days: approvedDays,
      approve_until: approveUntil,
      settle_days: settleDays,
      enabled: enabled ? 1 : 0,
      updated_by: ctx.user.id,
      updated_at: ctx.now,
      // Approval put back on: the admins are told again when it next ends.
      ...(input.restartApproval ? { automatic_told_at: null } : {}),
    };
    ctx.write(
      ctx.db
        .insertInto("core_accounting_settings")
        .values({ id: 1, ...values })
        .onConflict((oc) => oc.column("id").doUpdateSet(values)),
    );
    const audit = (s: {
      connectionId: string | null;
      resource: string | null;
      startDate: string | null;
      approvedDays: number;
      approveUntil: number;
      settleDays: number;
      enabled: boolean;
    }) => ({
      connectionId: s.connectionId,
      resource: s.resource,
      startDate: s.startDate,
      approvedDays: s.approvedDays,
      approveUntil: s.approveUntil,
      settleDays: s.settleDays,
      enabled: s.enabled,
    });
    const after = {
      connectionId,
      resource,
      startDate,
      approvedDays,
      approveUntil,
      settleDays,
      enabled,
    };
    ctx.recordChange({
      object: "accounting_settings",
      id: "accounting",
      action: "update",
      before: audit(before),
      after: audit(after),
    });
    return {
      books: connectionId && resource ? { connectionId, resource, title, status } : null,
      startDate,
      enabled,
      approval: { approvedDays, approveUntil, automatic: approvedDays >= approveUntil },
      settleDays,
      updatedBy: ctx.user.id,
      updatedAt: ctx.now,
    };
  },
});

const mapInput = z.object({
  kind: mapKind,
  hostKey: z
    .string()
    .max(100)
    .nullable()
    .optional()
    .describe("For category, tax and method: the category key, tax code or recorded-payment kind"),
});

export const accountingMapSet = defineOperation({
  name: "accounting.map.set",
  description:
    "Choose which of the books' accounts (or, for a tax code, which tax rate) one kind of host " +
    "money goes to, from the books' own lists: a category of sale, a tax code, the provider's " +
    "fees, the clearing account, the bank account payouts land in, a recorded-payment kind, " +
    "rounding, refunds, or an invoice line with no category. `booksName` is the name the books " +
    "gave it when it was chosen. A change applies only to entries not yet sent; a person only.",
  input: mapInput.extend({
    booksRef: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("The books' own id for the account or rate"),
    booksName: z.string().trim().min(1).max(200).describe("Its name in the books, as read"),
  }),
  output: z.object({ changed: z.boolean(), row: mappingRow }),
  permission: "accounting:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const connectionId = requireConnection(await loadAccountingSettings(ctx.db));
    const hostKey = mapKey(input.kind, input.hostKey);
    const before = await ctx.db
      .selectFrom("core_accounting_map")
      .selectAll()
      .where("connection_id", "=", connectionId)
      .where("kind", "=", input.kind)
      .where("host_key", "=", hostKey)
      .executeTakeFirst();
    const row = {
      kind: input.kind,
      hostKey: hostKey || null,
      target: mapTarget(input.kind),
      booksRef: input.booksRef,
      booksName: input.booksName,
      setBy: ctx.user.id,
      setAt: ctx.now,
    };
    if (before && before.books_ref === input.booksRef && before.books_name === input.booksName) {
      return {
        changed: false,
        row: { ...row, setBy: before.set_by, setAt: before.set_at },
      };
    }
    const values = {
      books_ref: input.booksRef,
      books_name: input.booksName,
      set_by: ctx.user.id,
      set_at: ctx.now,
    };
    ctx.write(
      ctx.db
        .insertInto("core_accounting_map")
        .values({ connection_id: connectionId, kind: input.kind, host_key: hostKey, ...values })
        .onConflict((oc) => oc.columns(["connection_id", "kind", "host_key"]).doUpdateSet(values)),
    );
    ctx.recordChange({
      object: "accounting_map",
      id: `${input.kind}:${hostKey}`,
      action: before ? "update" : "create",
      before: before ? { booksRef: before.books_ref, booksName: before.books_name } : null,
      after: { connectionId, booksRef: input.booksRef, booksName: input.booksName },
    });
    return { changed: true, row };
  },
});

export const accountingMapClear = defineOperation({
  name: "accounting.map.clear",
  description:
    "Forget which books account or tax rate one kind of host money goes to. Entries not yet " +
    "sent that need it are held until it is mapped again; nothing sent changes. A person only.",
  input: mapInput,
  output: z.object({ cleared: z.boolean() }),
  permission: "accounting:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const connectionId = requireConnection(await loadAccountingSettings(ctx.db));
    const hostKey = mapKey(input.kind, input.hostKey);
    const before = await ctx.db
      .selectFrom("core_accounting_map")
      .selectAll()
      .where("connection_id", "=", connectionId)
      .where("kind", "=", input.kind)
      .where("host_key", "=", hostKey)
      .executeTakeFirst();
    if (!before) throw new NotFoundError("accounting mapping", `${input.kind}:${hostKey}`);
    ctx.write(
      ctx.db
        .deleteFrom("core_accounting_map")
        .where("connection_id", "=", connectionId)
        .where("kind", "=", input.kind)
        .where("host_key", "=", hostKey),
    );
    ctx.recordChange({
      object: "accounting_map",
      id: `${input.kind}:${hostKey}`,
      action: "delete",
      before: { connectionId, booksRef: before.books_ref, booksName: before.books_name },
      after: null,
    });
    return { cleared: true };
  },
});

export const accountingOperations = [
  accountingSettingsGet,
  accountingSettingsUpdate,
  accountingMapSet,
  accountingMapClear,
] as const;
