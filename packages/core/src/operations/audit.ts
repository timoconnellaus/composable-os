// audit.* operations: the admin Audit page (audit.list) and a record's History tab
// (audit.listForRecord), both views over core_audit + core_audit_changes (ADR 0017, ADR 0018).
import { sql } from "kysely";
import { z } from "zod";
import { VERDICT_OPERATION } from "../adjudicator/review.ts";
import { decodeCursor, encodeCursor, pageSchema } from "../list.ts";
import { AUDITED_READS, defineOperation, PEOPLE_ONLY_AUDIT } from "../operation.ts";
import { ALL_ACTORS } from "../principals.ts";
import { jsonList } from "../records/common.ts";
import { recordRefSchema } from "../records/links.ts";
import { hiddenNoteIds, type NoteViewer } from "../visibility/index.ts";

const isoDateTime = z.iso.datetime({ offset: true }).transform((v) => new Date(v).toISOString());

const diffSchema = z.record(z.string(), z.object({ before: z.unknown(), after: z.unknown() }));

export const auditChangeSchema = z.object({
  object: z.string(),
  recordId: z.string(),
  action: z.string(),
  diff: diffSchema,
});

export const auditEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  operation: z.string(),
  risk: z.string(),
  actor: z.string(),
  userId: z.string().nullable(),
  userName: z.string().nullable(),
  origin: z.record(z.string(), z.unknown()),
  input: z.unknown(),
  result: z.unknown(),
  gateDecision: z.string(),
  outcome: z.string(),
  error: z.unknown(),
  /**
   * The pending action (pac_…) this row belongs to: the queued request (outcome `review`) or,
   * after approval, the applied result (gate `review`, outcome `ok`). ADR 0032.
   */
  pendingActionId: z.string().nullable(),
  changes: z.array(auditChangeSchema),
});

const parse = (text: string | null): unknown => (text === null ? null : JSON.parse(text));

/**
 * Who a row is by: a staff user's name, or for a customer's call (whose user_id is the customer
 * account, stage 22) the account's sign-in address. The public have neither.
 */
const customerAccounts = "core_customer as cu" as const;
const userName = sql<string | null>`coalesce(u.name, cu.email)`.as("user_name");

const AUDIT_SORT = { field: "at", direction: "desc" } as const;
const HISTORY_SORT = { field: "changeId", direction: "desc" } as const;

export const auditList = defineOperation({
  name: "audit.list",
  description:
    "The admin audit log: every write, every refusal and every failed non-human read, newest " +
    "first (successful reads by AI and automations are counted per hour in audit.readCounts). " +
    "Filter by userId, actor (human, assistant, mcp, automation, extension, customer, public), operation (exact name, or a " +
    "prefix ending in '.*' such as 'person.*'), outcome, a record (object + recordId), a pending " +
    "action (pendingActionId: its queued request and applied result) and a date range (from " +
    "inclusive, to exclusive). Each entry includes its field diffs. Admins only. " +
    "Read-only.",
  input: z.object({
    userId: z.string().max(64).optional(),
    actor: z.enum(ALL_ACTORS).optional(),
    operation: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9.]+(\.\*)?$/)
      .optional(),
    outcome: z.enum(["ok", "forbidden", "denied", "review", "error"]).optional(),
    object: recordRefSchema.shape.object.optional(),
    recordId: z.string().max(64).optional(),
    pendingActionId: z.string().startsWith("pac_").max(64).optional(),
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
    cursor: z.string().max(1000).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: pageSchema(auditEntrySchema),
  permission: "audit:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    let query = ctx.db
      .selectFrom("core_audit as a")
      .leftJoin("core_user as u", "u.id", "a.user_id")
      .leftJoin(customerAccounts, (join) =>
        join.onRef("cu.id", "=", "a.user_id").on("a.actor", "=", "customer"),
      )
      .selectAll("a")
      .select(userName);
    // Policy adjudicator verdicts are for people only (ADR 0204): an admin's MCP client or the
    // assistant never reads them, so the actor whose work was judged cannot learn the verdicts.
    if (ctx.actor !== "human") query = query.where("a.operation", "<>", VERDICT_OPERATION);
    // The rows of reads audited one by one (`auditReads`: who read whose health answers or
    // marks) are for people only too (stage 44, ADR 0643): together they would list who
    // answered yes.
    if (ctx.actor !== "human" && AUDITED_READS.size) {
      query = query.where("a.operation", "not in", [...AUDITED_READS]);
    }
    // A person's own acts are a person's to read (stage 45 step 4b, ADR 0650): the rows of a
    // checklist's ticks, and of every extension tool only a person may call (`humanOnly`: ticking
    // a checklist, taking a shift, saying one is away, pay), are never listed to an AI actor.
    if (ctx.actor !== "human") {
      if (PEOPLE_ONLY_AUDIT.size) {
        query = query.where("a.operation", "not in", [...PEOPLE_ONLY_AUDIT]);
      }
      // A tool's row is listed only while an installed pack still has the tool and it is not a
      // person's only: a pack since removed, or upgraded without the tool, keeps its rows hidden.
      query = query.where(
        sql<boolean>`(a.operation NOT LIKE 'x.%' OR a.operation IN (SELECT 'x.' || e.id || '.' || t.key FROM core_extensions e, json_each(e.manifest, '$.tools') t WHERE coalesce(json_extract(t.value, '$.humanOnly'), 0) != 1))`,
      );
    }
    // A change to a note kept from the caller says it exists (stage 56, ADR 0830): no AI actor
    // lists its rows, whatever the account holds, nor a person who may not read the note.
    query = query.where(
      sql<boolean>`NOT EXISTS (SELECT 1 FROM core_audit_changes kc WHERE kc.audit_id = a.id AND kc.object_type = 'activity' AND kc.record_id IN ${hiddenNoteIds(ctx as NoteViewer)})`,
    );
    if (input.userId) query = query.where("a.user_id", "=", input.userId);
    if (input.actor) query = query.where("a.actor", "=", input.actor);
    if (input.outcome) query = query.where("a.outcome", "=", input.outcome);
    if (input.pendingActionId) {
      query = query.where("a.pending_action_id", "=", input.pendingActionId);
    }
    if (input.operation?.endsWith(".*")) {
      const prefix = input.operation.slice(0, -1); // keep the dot
      query = query.where(sql<boolean>`substr(a.operation, 1, ${prefix.length}) = ${prefix}`);
    } else if (input.operation) {
      query = query.where("a.operation", "=", input.operation);
    }
    if (input.recordId || input.object) {
      query = query.where((eb) =>
        eb.exists(
          eb
            .selectFrom("core_audit_changes as c")
            .select("c.id")
            .whereRef("c.audit_id", "=", "a.id")
            .$if(Boolean(input.recordId), (q) => q.where("c.record_id", "=", input.recordId ?? ""))
            .$if(Boolean(input.object), (q) => q.where("c.object_type", "=", input.object ?? "")),
        ),
      );
    }
    if (input.from) query = query.where("a.at", ">=", input.from);
    if (input.to) query = query.where("a.at", "<", input.to);
    if (input.cursor) {
      const c = decodeCursor(input.cursor, AUDIT_SORT);
      query = query.where(sql<boolean>`(a.at < ${c.v} OR (a.at = ${c.v} AND a.id < ${c.id}))`);
    }
    const rows = await query
      .orderBy("a.at", "desc")
      .orderBy("a.id", "desc")
      .limit(input.limit + 1)
      .execute();
    const page = rows.slice(0, input.limit);

    const changeRows = page.length
      ? await ctx.db
          .selectFrom("core_audit_changes")
          .selectAll()
          .where("audit_id", "in", jsonList(page.map((r) => r.id)))
          .orderBy("id")
          .execute()
      : [];
    const changes = new Map<string, z.infer<typeof auditChangeSchema>[]>();
    for (const c of changeRows) {
      changes.set(c.audit_id, [
        ...(changes.get(c.audit_id) ?? []),
        {
          object: c.object_type,
          recordId: c.record_id,
          action: c.action,
          diff: JSON.parse(c.diff) as z.infer<typeof diffSchema>,
        },
      ]);
    }

    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        at: row.at,
        operation: row.operation,
        risk: row.risk,
        actor: row.actor,
        userId: row.user_id,
        userName: row.user_name,
        origin: JSON.parse(row.origin) as Record<string, unknown>,
        input: parse(row.input),
        result: parse(row.result),
        gateDecision: row.gate_decision,
        outcome: row.outcome,
        error: parse(row.error),
        pendingActionId: row.pending_action_id,
        changes: changes.get(row.id) ?? [],
      })),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ f: AUDIT_SORT.field, d: "desc", v: last.at, id: last.id })
          : null,
    };
  },
});

export const historyEntrySchema = z.object({
  changeId: z.number(),
  auditId: z.string(),
  at: z.string(),
  operation: z.string(),
  actor: z.string(),
  userId: z.string().nullable(),
  userName: z.string().nullable(),
  action: z.string(),
  diff: diffSchema,
});

export const auditListForRecord = defineOperation({
  name: "audit.listForRecord",
  description:
    "A record's change history (the History tab): who changed which fields, when and through " +
    "which operation, newest first, with before/after values per field. Covers creates, " +
    "updates, deletes, restores and merges. Pass nextCursor back as cursor for the next page. " +
    "Read-only.",
  input: z.object({
    object: recordRefSchema.shape.object,
    recordId: recordRefSchema.shape.id,
    cursor: z.string().max(1000).optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  output: pageSchema(historyEntrySchema),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    // A note's history is for those who may read the note (stage 56, ADR 0830): to anyone else a
    // note kept from them has none, as it has no row.
    if (input.object === "activity") {
      const hidden = await ctx.db
        .selectFrom(sql<{ id: string }>`${hiddenNoteIds(ctx as NoteViewer)}`.as("h"))
        .select("h.id")
        .where("h.id", "=", input.recordId)
        .executeTakeFirst();
      if (hidden) return { items: [], nextCursor: null };
    }
    let query = ctx.db
      .selectFrom("core_audit_changes as c")
      .innerJoin("core_audit as a", "a.id", "c.audit_id")
      .leftJoin("core_user as u", "u.id", "a.user_id")
      .leftJoin(customerAccounts, (join) =>
        join.onRef("cu.id", "=", "a.user_id").on("a.actor", "=", "customer"),
      )
      .select([
        "c.id",
        "c.audit_id",
        "c.at",
        "c.action",
        "c.diff",
        "a.operation",
        "a.actor",
        "a.user_id",
        userName,
      ])
      .where("c.object_type", "=", input.object)
      .where("c.record_id", "=", input.recordId);
    if (input.cursor) {
      const c = decodeCursor(input.cursor, HISTORY_SORT);
      query = query.where("c.id", "<", Number(c.v));
    }
    const rows = await query
      .orderBy("c.id", "desc")
      .limit(input.limit + 1)
      .execute();
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        changeId: row.id,
        auditId: row.audit_id,
        at: row.at,
        operation: row.operation,
        actor: row.actor,
        userId: row.user_id,
        userName: row.user_name,
        action: row.action,
        diff: JSON.parse(row.diff) as z.infer<typeof diffSchema>,
      })),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ f: HISTORY_SORT.field, d: "desc", v: last.id, id: String(last.id) })
          : null,
    };
  },
});

export const auditOperations = [auditList, auditListForRecord] as const;
