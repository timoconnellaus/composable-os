// Keeping acceptances after erase (stage 44 step 8, ADR 0646; decision 15):
//
//   agreement.retention     how long an erased person's acceptances are kept, and how many are
//   agreement.setRetention  a human admin sets it (1 to 50 years; default 7)
//   agreement.kept.find     a person with agreements:manage finds kept acceptances by the address
//                           or the name they hold, for a dispute or a claim; every search audited
//   agreement.kept.hold     the same person holds one (or releases it): the purge passes it by
//   agreement.purgeKept     the daily cron's host step: deletes what is past the period
//   agreement.mergePlan     what a merge would move: the merge preview's counts
//
// None of these returns a name typed, an address, a signature or an answer: a kept acceptance is
// opened with agreement.acceptance.pdf (agreements:manage, audited). No AI reads a kept one.
import { sql } from "kysely";
import { z } from "zod";
import { mergeAgreementCounts } from "../agreements/people.ts";
import {
  DEFAULT_KEEP_YEARS,
  KEEP_SETTING,
  keepYearsSchema,
  keptPastPeriod,
  keptUntil,
  loadKeepYears,
  PURGE_KEPT_MAX,
  purgeableKept,
  purgeCutoff,
} from "../agreements/retention.ts";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { defineOperation } from "../operation.ts";
import { holdsPermission } from "../principals.ts";

const id = (what: string) => z.string().min(1).max(64).describe(what);

export const agreementRetention = defineOperation({
  name: "agreement.retention",
  description:
    "How long an erased person's acceptances are kept as the business's evidence (years, counted " +
    "from the erase; null when the setting is unreadable, and then nothing is purged), how many " +
    "are kept now, and how many are on hold. With `years`, also how many kept acceptances that " +
    "period would make due for deletion at the next daily run. Read-only.",
  input: z.object({
    years: keepYearsSchema.optional().describe("A period to ask about before setting it"),
  }),
  output: z.object({
    years: z.number().nullable(),
    defaultYears: z.number(),
    kept: z.number().describe("Acceptances kept after an erase"),
    held: z.number().describe("Of those, on hold for a dispute or a claim"),
    cutoff: z
      .string()
      .nullable()
      .describe("Erased before this are past the period: the daily cron purges them"),
    purgeableAt: z
      .number()
      .nullable()
      .describe("With `years`: kept acceptances past that period now, not on hold"),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const years = await loadKeepYears(ctx.db);
    const { rows } = await sql<{ kept: number; held: number }>`SELECT
        (SELECT count(*) FROM core_agreement_acceptance WHERE erased_at IS NOT NULL) AS kept,
        (SELECT count(*) FROM core_agreement_hold) AS held`.execute(ctx.db);
    return {
      years,
      defaultYears: DEFAULT_KEEP_YEARS,
      kept: Number(rows[0]?.kept ?? 0),
      held: Number(rows[0]?.held ?? 0),
      cutoff: purgeCutoff(ctx.now, years),
      purgeableAt: input.years ? await keptPastPeriod(ctx.db, ctx.now, input.years) : null,
    };
  },
});

export const agreementSetRetention = defineOperation({
  name: "agreement.setRetention",
  description:
    "Set how many years an erased person's acceptances are kept (1 to 50, counted from each " +
    "erase); the daily cron then deletes those past it, except any on hold. A change that makes " +
    "more kept acceptances due for deletion needs `confirmPurgeable`: the number " +
    "agreement.retention gives for that period, typed by the person. Admins only, and only a " +
    "person in the app: AI assistants, MCP clients and automations are refused. Audited, with " +
    "that number.",
  input: z.object({
    years: keepYearsSchema,
    confirmPurgeable: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("How many kept acceptances the new period makes due for deletion, as shown"),
  }),
  output: z.object({
    years: z.number(),
    previousYears: z.number().nullable(),
    purgeable: z.number().describe("Kept acceptances past the new period now, not on hold"),
  }),
  permission: "policy:manage",
  risk: "destructive",
  actors: ["human"],
  mcp: { expose: false },
  auditSummary: (output) => output,
  async handler(input, ctx) {
    const before = await loadKeepYears(ctx.db);
    // A period that makes more kept records due than now (shorter, or the setting was unreadable,
    // when nothing is purged): the person types how many the next daily run will delete.
    const purgeable = await keptPastPeriod(ctx.db, ctx.now, input.years);
    const dueNow = before === null ? 0 : await keptPastPeriod(ctx.db, ctx.now, before);
    if (purgeable > dueNow && input.confirmPurgeable !== purgeable) {
      throw new ConflictError(
        `This period makes ${purgeable} kept agreement${purgeable === 1 ? "" : "s"} due for ` +
          "deletion at the next daily run, for good. Type that number to confirm.",
        { rule: "agreement_retention_confirm", purgeable },
      );
    }
    const value = JSON.stringify({ years: input.years });
    ctx.write(
      ctx.db
        .insertInto("core_settings")
        .values({ key: KEEP_SETTING, value, updated_at: ctx.now, updated_by: ctx.user.id })
        .onConflict((oc) =>
          oc.column("key").doUpdateSet({ value, updated_at: ctx.now, updated_by: ctx.user.id }),
        ),
    );
    ctx.recordChange({
      object: "settings",
      id: KEEP_SETTING,
      action: "update",
      before: { years: before },
      after: { years: input.years },
    });
    return { years: input.years, previousYears: before, purgeable };
  },
});

const keptItem = z.object({
  id: z.string(),
  documentId: z.string(),
  title: z.string(),
  versionNumber: z.number(),
  by: z.enum(["self", "guardian", "guest", "paper"]),
  how: z.enum(["typed", "drawn", "paper"]),
  channel: z.enum(["web", "app", "paper", "desk"]),
  acceptedAt: z.string(),
  erasedAt: z.string(),
  until: z.string().nullable().describe("When the purge deletes it; null: not while on hold"),
  held: z.boolean(),
});

export const agreementKeptFind = defineOperation({
  name: "agreement.kept.find",
  description:
    "Find acceptances kept after their person was erased, by the address the copy went to or " +
    "the name typed (part of it), for a dispute or a claim: what was agreed, how and when, and " +
    "until when it is kept. Open one with agreement.acceptance.pdf. A person on the staff with " +
    "agreements:manage only; every search is audited, without what was searched for.",
  input: z
    .object({
      email: z.string().trim().toLowerCase().max(320).optional(),
      name: z.string().trim().min(2).max(200).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .refine((v) => Boolean(v.email || v.name), { message: "Give an address or a name" }),
  output: z.object({ items: z.array(keptItem) }),
  permission: "agreements:manage",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  auditReads: true,
  redact: ["email", "name"],
  // Which kept acceptances it showed, never what was searched for (the review of PR #288).
  auditSummary: (output) => ({
    found: output.items.length,
    acceptanceIds: output.items.map((i) => i.id),
  }),
  async handler(input, ctx) {
    if (ctx.actor !== "human") throw new ForbiddenError("Only a person finds a kept acceptance");
    const years = await loadKeepYears(ctx.db);
    let query = ctx.db
      .selectFrom("core_agreement_acceptance as a")
      .innerJoin("core_agreement_version as v", "v.id", "a.version_id")
      .leftJoin("core_agreement_hold as h", "h.acceptance_id", "a.id")
      .select([
        "a.id",
        "a.document_id",
        "v.title",
        "v.number",
        "a.by",
        "a.how",
        "a.channel",
        "a.accepted_at",
        "a.erased_at",
        "h.acceptance_id as held",
      ])
      .where("a.erased_at", "is not", null);
    if (input.email) query = query.where(sql<boolean>`lower(a.email) = ${input.email}`);
    if (input.name) {
      const pattern = `%${input.name.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      query = query.where(sql<boolean>`lower(a.typed_name) LIKE ${pattern} ESCAPE '\\'`);
    }
    const rows = await query.orderBy("a.erased_at", "desc").limit(input.limit).execute();
    return {
      items: rows.map((r) => ({
        id: r.id,
        documentId: r.document_id,
        title: r.title,
        versionNumber: r.number,
        by: r.by,
        how: r.how,
        channel: r.channel,
        acceptedAt: r.accepted_at,
        erasedAt: r.erased_at as string,
        until: r.held ? null : keptUntil(r.erased_at as string, years),
        held: Boolean(r.held),
      })),
    };
  },
});

export const agreementKeptHold = defineOperation({
  name: "agreement.kept.hold",
  description:
    "Hold a kept acceptance (one kept after its person was erased) for a dispute or a claim, so " +
    "the retention purge passes it by; or release it (held: false), after which the purge takes " +
    "it once its period is over. A person on the staff with agreements:manage only. Audited.",
  input: z.object({ acceptanceId: id("The kept acceptance (aga_…)"), held: z.boolean() }),
  output: z.object({ acceptanceId: z.string(), held: z.boolean() }),
  permission: "agreements:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await ctx.db
      .selectFrom("core_agreement_acceptance as a")
      .leftJoin("core_agreement_hold as h", "h.acceptance_id", "a.id")
      .select(["a.id", "a.erased_at", "h.acceptance_id as held"])
      .where("a.id", "=", input.acceptanceId)
      .executeTakeFirst();
    if (!row?.erased_at) throw new NotFoundError("kept acceptance", input.acceptanceId);
    if (input.held && !row.held) {
      ctx.write(
        ctx.db.insertInto("core_agreement_hold").values({
          acceptance_id: input.acceptanceId,
          held_by: ctx.user.id,
          held_at: ctx.now,
        }),
      );
    } else if (!input.held && row.held) {
      ctx.write(
        ctx.db.deleteFrom("core_agreement_hold").where("acceptance_id", "=", input.acceptanceId),
      );
    }
    return { acceptanceId: input.acceptanceId, held: input.held };
  },
});

export const agreementPurgeKept = defineOperation({
  name: "agreement.purgeKept",
  description:
    "Platform use only: delete the acceptances kept after an erase whose retention period is " +
    "over (oldest first, at most a bounded number per call), with their signature, answers and " +
    "copy record; never one on hold, nor one whose copy the email gatekeeper has still to " +
    "scrub unless that scrub has been owed for 30 days (those are named in the audit). No " +
    "input names an acceptance.",
  input: z.object({}),
  output: z.object({
    purged: z.number(),
    more: z.boolean(),
    unscrubbed: z
      .array(z.string())
      .describe("Purged although the email gatekeeper could not be reached to scrub their copy"),
  }),
  permission: "records:erase",
  risk: "write",
  actors: ["automation"],
  // The host carrying out the retention a person set (decision 15): never queued under a floor.
  hostStep: true,
  mcp: { expose: false },
  auditSummary: (output) => output,
  // The database judges each delete again (migration 0855). If it refuses, the setting changed or
  // a record moved between the read and the commit: nothing was deleted, and the next run reads
  // again (the review of PR #288: never a misleading "immutable").
  explainFailure: async (error) =>
    /immutable|copy_fixed/.test(error.message)
      ? new ConflictError(
          "Nothing was purged: the retention setting or a kept agreement changed while purging. " +
            "The next daily run reads them again.",
          { rule: "agreement_purge_changed" },
        )
      : null,
  async handler(_input, ctx) {
    if (ctx.origin.surface !== "system") {
      throw new ForbiddenError("Only the host's own cron purges kept acceptances");
    }
    if (!purgeCutoff(ctx.now, 1)) throw new ValidationError("Invalid clock");
    const due = await purgeableKept(ctx.db, ctx.now, PURGE_KEPT_MAX + 1);
    const taken = due.slice(0, PURGE_KEPT_MAX);
    const ids = taken.map((d) => d.id);
    const unscrubbed = taken.filter((d) => d.unscrubbed).map((d) => d.id);
    if (ids.length) {
      const list = sql`(SELECT value FROM json_each(${JSON.stringify(ids)}))`;
      // What sits beside each one first: the acceptance's own trigger refuses while any is left.
      ctx.write(
        sql`DELETE FROM core_agreement_copy WHERE acceptance_id IN ${list}`.compile(ctx.db),
        sql`DELETE FROM core_agreement_signature WHERE acceptance_id IN ${list}`.compile(ctx.db),
        sql`DELETE FROM core_agreement_answer WHERE acceptance_id IN ${list}`.compile(ctx.db),
        sql`DELETE FROM core_agreement_acceptance WHERE id IN ${list}`.compile(ctx.db),
      );
    }
    return { purged: ids.length, more: due.length > PURGE_KEPT_MAX, unscrubbed };
  },
});

export const agreementMergePlan = defineOperation({
  name: "agreement.mergePlan",
  description:
    "What merging mergedId into survivorId would do to their agreements: how many acceptances " +
    "(their own, and made as a guardian) move to the survivor unchanged, whether the minor mark " +
    "moves, and whether the caller may merge them (a person with agreements:manage only). " +
    "Counts only. Read-only.",
  input: z.object({
    survivorId: id("The person who remains"),
    mergedId: id("The duplicate merged away"),
  }),
  output: z.object({
    acceptances: z.number(),
    asGuardian: z.number(),
    minor: z.boolean(),
    needs: z
      .enum(["agreements:manage", "person"])
      .nullable()
      .describe("Why the caller cannot merge them; null when they can, or nothing moves"),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    await ctx.records.get("person", input.mergedId);
    await ctx.records.get("person", input.survivorId);
    const counts = await mergeAgreementCounts(ctx, input.mergedId);
    const moves = counts.acceptances > 0 || counts.asGuardian > 0 || counts.minor;
    const needs: "agreements:manage" | "person" | null = !moves
      ? null
      : ctx.actor !== "human"
        ? "person"
        : holdsPermission(ctx.user, ctx.permissionGrants, "agreements:manage")
          ? null
          : "agreements:manage";
    return { ...counts, needs };
  },
});

export const agreementErasePreview = defineOperation({
  name: "agreement.erasePreview",
  description:
    "What erasing a Person would do to their agreements, for the screen that confirms an erase: " +
    "how many acceptances (their own, and those they made as a guardian) are kept, no longer " +
    "theirs, and until when; how many health forms' answers are deleted at once. Counts only. " +
    "Read-only.",
  input: z.object({ personId: id("The Person to erase (per_…)") }),
  output: z.object({
    kept: z.number(),
    until: z.string().nullable().describe("When the purge deletes them; null: nothing is purged"),
    healthAnswers: z.number().describe("Health forms whose answers are deleted at once"),
  }),
  // Admins, who erase (the read permission erasure.addressStatus uses); a Person in the Trash
  // included, as person.erase takes them.
  permission: "audit:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const person = await ctx.db
      .selectFrom("core_person")
      .select("id")
      .where("id", "=", input.personId)
      .executeTakeFirst();
    if (!person) throw new NotFoundError("person", input.personId);
    const { rows } = await sql<{ kept: number; answers: number }>`SELECT
        (SELECT count(*) FROM core_agreement_acceptance WHERE erased_at IS NULL
          AND (person_id = ${input.personId} OR agent_person_id = ${input.personId})) AS kept,
        (SELECT count(*) FROM core_agreement_answer n JOIN core_agreement_acceptance a
          ON a.id = n.acceptance_id WHERE a.person_id = ${input.personId}) AS answers`.execute(
      ctx.db,
    );
    const kept = Number(rows[0]?.kept ?? 0);
    return {
      kept,
      until: kept ? keptUntil(ctx.now, await loadKeepYears(ctx.db)) : null,
      healthAnswers: Number(rows[0]?.answers ?? 0),
    };
  },
});

export const agreementRetentionOperations = [
  agreementErasePreview,
  agreementRetention,
  agreementSetRetention,
  agreementKeptFind,
  agreementKeptHold,
  agreementPurgeKept,
  agreementMergePlan,
] as const;
