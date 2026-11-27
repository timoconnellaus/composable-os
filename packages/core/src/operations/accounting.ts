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
//   accounting.approveDay       accounting:manage, a person: a day's entries go to the books
//                               (step 4, ADR 0882); the fourteenth approved day ends approval
//   accounting.post.retry       accounting:manage, a person: a held entry is tried again
//   accounting.post.skip        accounting:manage, a person: an entry is never sent, with why
//
// Every write is a person's whatever is granted (`actors: ["human"]`): no assistant, MCP client,
// automation or extension changes where the business's money goes in its books. None is open to
// customers or the public (ADR 0402), and none writes an order, a payment or a refund.

import type { CoreDatabase } from "@composable-os/db";
import { CompiledQuery, type Kysely } from "kysely";
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
import { ConflictError, NotFoundError, type OperationError, ValidationError } from "../errors.ts";
import { afterCommit, defineOperation, type HandlerContext } from "../operation.ts";
import { parseLocalDate } from "../time/local.ts";
import { rejectOnFacets } from "./approval.ts";

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

/**
 * A change of books (ADR 0882). Nothing already in the old books is posted again to the new ones:
 * the old books' entries not sent are skipped, with why, by the admin making the change, and the
 * new books get their own entries from their own start date. Refused while an entry may be on its
 * way to the old books (being sent, or of unknown outcome), and, on one connection, for other books
 * once that connection has entries: references are unique per connection.
 */
async function changeOfBooks(
  ctx: import("../operation.ts").HandlerContext,
  from: string,
  to: string | null,
): Promise<void> {
  const inFlight = await ctx.db
    .selectFrom("core_accounting_post")
    .select("id")
    .where("connection_id", "=", from)
    .where("state", "in", ["sending", "unknown"])
    .limit(1)
    .executeTakeFirst();
  if (inFlight) {
    throw new ConflictError(
      "An entry is on its way to the current books: try again once it is settled (a few minutes)",
      { rule: "accounting_books_in_flight" },
    );
  }
  if (to === from) {
    const any = await ctx.db
      .selectFrom("core_accounting_post")
      .select("id")
      .where("connection_id", "=", from)
      .limit(1)
      .executeTakeFirst();
    if (any) {
      throw new ConflictError(
        "Entries were made for these books: connect the other books as their own connection",
        { rule: "accounting_books_same_connection" },
      );
    }
    return;
  }
  ctx.write(
    ctx.db
      .updateTable("core_accounting_post")
      .set({
        state: "skipped",
        skipped_by: ctx.user.id,
        skipped_at: ctx.now,
        skip_reason: "The books were changed: not sent to the old books",
        next_attempt_at: null,
        updated_at: ctx.now,
      })
      .where("connection_id", "=", from)
      .where("state", "in", ["awaiting_approval", "queued", "retrying", "held"])
      .where("applied_at", "is", null),
  );
}

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
    let booksChanged = false;
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
      booksChanged = !same;
      if (!same && before.connectionId) {
        await changeOfBooks(ctx, before.connectionId, connectionId);
      }
    } else if (connectionId && resource) {
      const books = await requireBooks(ctx.db, connectionId, resource).catch(() => null);
      title = books?.title ?? null;
      status = books?.status ?? null;
    }

    const startDate = input.startDate ?? before.startDate;
    if (input.startDate !== undefined && input.startDate !== before.startDate && connectionId) {
      // Moving it once an entry to these books may be in them (sent, being sent, or its outcome
      // not known) would send days again or leave a gap. The database refuses it too
      // (core_accounting_settings_start), so an entry claimed meanwhile fails this write whole.
      const inBooks = await ctx.db
        .selectFrom("core_accounting_post")
        .select("id")
        .where("connection_id", "=", connectionId)
        .where("state", "in", ["sending", "sent", "unknown"])
        .limit(1)
        .executeTakeFirst();
      if (inBooks) {
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
    // Only what this call changes is written over the row, so a count the runner or an approval
    // made since it was read (`approved_days`) is kept. The insert, for a first save, is whole.
    const changes = {
      // Other books: the daily pass starts again from their start date (ADR 0882).
      ...(input.books !== undefined
        ? { connection_id: connectionId, resource, ...(booksChanged ? { daily_date: null } : {}) }
        : {}),
      // A new start: the daily pass starts from it (only before anything was sent, above).
      ...(input.startDate !== undefined
        ? {
            start_date: startDate,
            ...(input.startDate !== before.startDate ? { daily_date: null } : {}),
          }
        : {}),
      // Approval put back on: the count starts again, and the admins are told again when it ends.
      ...(input.restartApproval ? { approved_days: 0, automatic_told_at: null } : {}),
      ...(input.approveUntil !== undefined ? { approve_until: approveUntil } : {}),
      ...(input.settleDays !== undefined ? { settle_days: settleDays } : {}),
      ...(input.enabled !== undefined ? { enabled: enabled ? 1 : 0 } : {}),
      updated_by: ctx.user.id,
      updated_at: ctx.now,
    };
    ctx.write(
      ctx.db
        .insertInto("core_accounting_settings")
        .values({
          id: 1,
          connection_id: connectionId,
          resource,
          start_date: startDate,
          approved_days: approvedDays,
          approve_until: approveUntil,
          settle_days: settleDays,
          enabled: enabled ? 1 : 0,
          updated_by: ctx.user.id,
          updated_at: ctx.now,
        })
        .onConflict((oc) => oc.column("id").doUpdateSet(changes)),
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
    // Entries held for a mapping are tried again: the runner resolves every mapping when it sends,
    // so one still missing holds it again, with what is still to map.
    ctx.write(
      ctx.db
        .updateTable("core_accounting_post")
        .set({
          state: "queued",
          error_code: null,
          error_text: null,
          next_attempt_at: null,
          updated_at: ctx.now,
        })
        .where("connection_id", "=", connectionId)
        .where("state", "=", "held")
        .where("error_code", "=", "unmapped"),
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

// --- The outbox (stage 61 step 4, ADR 0882) ----------------------------------------------------

export const accountingApproveDay = defineOperation({
  name: "accounting.approveDay",
  description:
    "Approve one day's entries for the books (a person): while approval is on, each day's " +
    "entries (its summary, transfers, contacts and documents) wait until a person approves the " +
    "whole day; then they are sent. Skip an entry first to leave it out. Each day approved for " +
    "the first time counts towards the days after which entries go on their own; a day nobody " +
    "approved does not count.",
  input: z.object({ day: localDate.describe("The day the entries belong to, YYYY-MM-DD") }),
  output: z.object({
    day: z.string(),
    approved: z.number().int().describe("Entries now queued to send"),
    approvedDays: z.number().int(),
    approveUntil: z.number().int(),
    automatic: z.boolean(),
  }),
  permission: "accounting:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const settings = await loadAccountingSettings(ctx.db);
    const connectionId = requireConnection(settings);
    const waiting = await ctx.db
      .selectFrom("core_accounting_post")
      .select(["id", "amount"])
      .where("connection_id", "=", connectionId)
      .where("belongs_date", "=", input.day)
      .where("state", "=", "awaiting_approval")
      .limit(1000)
      .execute();
    if (!waiting.length) {
      throw new ConflictError("Nothing on that day waits for approval", {
        rule: "accounting_nothing_to_approve",
      });
    }
    const counted = await ctx.db
      .selectFrom("core_accounting_post")
      .select("id")
      .where("connection_id", "=", connectionId)
      .where("belongs_date", "=", input.day)
      .where("approved_at", "is not", null)
      .limit(1)
      .executeTakeFirst();
    // Counted the first time the day is approved, decided in the same batch as the approval, so
    // two people approving the day at once count it once.
    ctx.write(
      ctx.db
        .updateTable("core_accounting_settings")
        .set((eb) => ({ approved_days: eb("approved_days", "+", 1) }))
        .where("id", "=", 1)
        .where("connection_id", "=", connectionId)
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom("core_accounting_post")
                .select("id")
                .where("connection_id", "=", connectionId)
                .where("belongs_date", "=", input.day)
                .where("approved_at", "is not", null),
            ),
          ),
        ),
    );
    ctx.write(
      ctx.db
        .updateTable("core_accounting_post")
        .set({
          state: "queued",
          approved_by: ctx.user.id,
          approved_at: ctx.now,
          next_attempt_at: null,
          updated_at: ctx.now,
        })
        .where("connection_id", "=", connectionId)
        .where("belongs_date", "=", input.day)
        .where("state", "=", "awaiting_approval"),
    );
    const approvedDays = settings.approvedDays + (counted ? 0 : 1);
    ctx.recordChange({
      object: "accounting_day",
      id: input.day,
      action: "update",
      before: { state: "awaiting_approval", entries: waiting.length },
      after: {
        state: "approved",
        entries: waiting.length,
        amount: waiting.reduce((sum, p) => sum + p.amount, 0),
        approvedDays,
      },
    });
    return {
      day: input.day,
      approved: waiting.length,
      approvedDays,
      approveUntil: settings.approveUntil,
      automatic: approvedDays >= settings.approveUntil,
    };
  },
});

const postId = z.string().min(1).max(64).describe("The entry's id");

async function loadPost(db: Kysely<CoreDatabase>, id: string) {
  const post = await db
    .selectFrom("core_accounting_post")
    .select([
      "id",
      "state",
      "reference",
      "amount",
      "error_code",
      "belongs_date",
      "applied_at",
      "pending_action_id",
    ])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!post) throw new NotFoundError("accounting entry", id);
  return post;
}

/**
 * Fails the whole batch, its audit row included, when the move it checks did not land: the runner
 * claimed or settled the entry between the read and the write (an insert over the entry's own id,
 * which the outbox's insert trigger refuses). So a raced retry or skip never says it happened.
 */
function landed(
  id: string,
  state: string,
  now: string,
  reason: string | null = null,
): CompiledQuery {
  return CompiledQuery.raw(
    `INSERT INTO core_accounting_post (id) SELECT ?1 WHERE NOT EXISTS (
       SELECT 1 FROM core_accounting_post WHERE id = ?1 AND state = ?2 AND updated_at = ?3
         AND (?4 IS NULL OR skip_reason = ?4))`,
    [id, state, now, reason],
  );
}

/** What a raced retry or skip answers: the entry moved meanwhile, and nothing was changed. */
async function moved(error: OperationError, input: { id: string }, ctx: HandlerContext) {
  if ((error.details as { rule?: unknown } | undefined)?.rule !== "accounting_post_fixed") {
    return null;
  }
  const now = await loadPost(ctx.db, input.id).catch(() => null);
  return new ConflictError(
    `The entry moved to ${now?.state ?? "another state"} while you acted: nothing was changed`,
    { rule: "accounting_post_moved" },
  );
}

/** A pending action in Approvals, by id. */
async function pendingAction(db: Kysely<CoreDatabase>, id: string | null) {
  if (!id) return null;
  return (
    (await db
      .selectFrom("core_pending_action")
      .select(["id", "status", "connection_id", "facet_key", "gk_action"])
      .where("id", "=", id)
      .executeTakeFirst()) ?? null
  );
}

export const accountingPostRetry = defineOperation({
  name: "accounting.post.retry",
  description:
    "Try a held entry again, or one waiting to retry, now (a person), once what held it is put " +
    "right (a contact, an account in the books, a refusal). An entry already in the books whose " +
    "reference was not found is looked up again, never sent again; any other is looked up by its " +
    "reference before anything is written, so it is never in the books twice. One waiting in " +
    "Approvals is decided there. An entry before the start date is never sent.",
  input: z.object({ id: postId }),
  output: z.object({ id: z.string(), state: z.enum(["queued", "unknown"]) }),
  permission: "accounting:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  explainFailure: moved,
  async handler(input, ctx) {
    const post = await loadPost(ctx.db, input.id);
    if (post.state !== "held" && post.state !== "retrying") {
      throw new ConflictError(`Only a held entry is tried again; this one is ${post.state}`, {
        rule: "accounting_not_held",
      });
    }
    if (post.error_code === "before_start") {
      // Retryable once the start date is moved earlier than its day (before anything was sent).
      const { startDate } = await loadAccountingSettings(ctx.db);
      if (!startDate || post.belongs_date < startDate) {
        throw new ConflictError("Its day is before the start date: it is never sent", {
          rule: "accounting_not_held",
        });
      }
    }
    if (post.error_code === "pending_review") {
      const action = await pendingAction(ctx.db, post.pending_action_id);
      if (action?.status === "pending") {
        throw new ConflictError(
          "It waits in Approvals: approve or reject it there, and the books' answer is recorded",
          { rule: "accounting_in_approvals" },
        );
      }
    }
    // In the books (the host knew it was applied): looked up again, never sent again.
    const state: "unknown" | "queued" = post.applied_at ? "unknown" : "queued";
    ctx.write(
      ctx.db
        .updateTable("core_accounting_post")
        .set({
          state,
          attempts: post.applied_at ? undefined : 0,
          lookups: 0,
          unknowns: 0,
          next_attempt_at: null,
          error_code: post.applied_at ? "applied" : null,
          error_text: post.applied_at ? "A person asked to look it up again" : null,
          pending_action_id: null,
          updated_at: ctx.now,
        })
        .where("id", "=", post.id)
        .where("state", "=", post.state),
      landed(post.id, state, ctx.now),
    );
    ctx.recordChange({
      object: "accounting_post",
      id: post.id,
      action: "update",
      before: { state: post.state, reference: post.reference, error: post.error_code },
      after: { state, reference: post.reference },
    });
    return { id: post.id, state };
  },
});

/** The states a person may skip from: never one that may be in the books. */
const SKIPPABLE = ["awaiting_approval", "queued", "retrying", "held"] as const;

export const accountingPostSkip = defineOperation({
  name: "accounting.post.skip",
  description:
    "Leave one entry out of the books for good (a person), with why: one waiting for approval, " +
    "queued, held or waiting to retry. Never one being sent, sent, in the books, or whose " +
    "outcome is not yet known. One waiting in Approvals is turned down there with it. Its money " +
    "is listed on the log as not in the books; an entry that depends on it is held.",
  input: z.object({
    id: postId,
    reason: z.string().trim().min(1).max(500).describe("Why it is left out"),
  }),
  output: z.object({ id: z.string(), state: z.literal("skipped") }),
  permission: "accounting:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  explainFailure: moved,
  async handler(input, ctx) {
    const post = await loadPost(ctx.db, input.id);
    if (!(SKIPPABLE as readonly string[]).includes(post.state) || post.applied_at) {
      throw new ConflictError(
        post.applied_at
          ? "This entry is in the books: it is never skipped"
          : `This entry is ${post.state}: only one not sent and not being sent is skipped`,
        { rule: "accounting_not_skippable" },
      );
    }
    ctx.write(
      ctx.db
        .updateTable("core_accounting_post")
        .set({
          state: "skipped",
          skipped_by: ctx.user.id,
          skipped_at: ctx.now,
          skip_reason: input.reason,
          next_attempt_at: null,
          updated_at: ctx.now,
        })
        .where("id", "=", post.id)
        .where("state", "=", post.state),
      landed(post.id, "skipped", ctx.now, input.reason),
    );
    // Waiting in Approvals: turned down with it, so nothing approvable is left behind.
    const action = await pendingAction(ctx.db, post.pending_action_id);
    const rejecting = action?.status === "pending" ? action : null;
    if (rejecting) {
      ctx.write(
        ctx.db
          .updateTable("core_pending_action")
          .set({
            status: "rejected",
            status_reason: `Skipped in the accounting outbox by ${ctx.user.name}: ${input.reason}`,
            decided_by: ctx.user.id,
            decided_at: ctx.now,
            decided_via: "tap",
          })
          .where("id", "=", rejecting.id)
          .where("status", "=", "pending"),
      );
    }
    ctx.recordChange({
      object: "accounting_post",
      id: post.id,
      action: "update",
      before: { state: post.state, reference: post.reference, amount: post.amount },
      after: {
        state: "skipped",
        reference: post.reference,
        reason: input.reason,
        ...(rejecting ? { rejectedAction: rejecting.id } : {}),
      },
    });
    const output = { id: post.id, state: "skipped" as const };
    if (!rejecting) return output;
    const integrations = ctx.integrations;
    return afterCommit(async () => {
      await rejectOnFacets(integrations, [rejecting]);
      return output;
    });
  },
});

export const accountingOperations = [
  accountingSettingsGet,
  accountingSettingsUpdate,
  accountingMapSet,
  accountingMapClear,
  accountingApproveDay,
  accountingPostRetry,
  accountingPostSkip,
] as const;
