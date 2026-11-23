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
  keptUntil,
  loadKeepYears,
  PURGE_KEPT_MAX,
  purgeableKept,
  purgeCutoff,
} from "../agreements/retention.ts";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { defineOperation } from "../operation.ts";
import { holdsPermission } from "../principals.ts";

const id = (what: string) => z.string().min(1).max(64).describe(what);

export const agreementRetention = defineOperation({
  name: "agreement.retention",
  description:
    "How long an erased person's acceptances are kept as the business's evidence (years, counted " +
    "from the erase; null when the setting is unreadable, and then nothing is purged), how many " +
    "are kept now, and how many are on hold. Read-only.",
  input: z.object({}),
  output: z.object({
    years: z.number().nullable(),
    defaultYears: z.number(),
    kept: z.number().describe("Acceptances kept after an erase"),
    held: z.number().describe("Of those, on hold for a dispute or a claim"),
    cutoff: z
      .string()
      .nullable()
      .describe("Erased before this are past the period: the daily cron purges them"),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
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
    };
  },
});

export const agreementSetRetention = defineOperation({
  name: "agreement.setRetention",
  description:
    "Set how many years an erased person's acceptances are kept (1 to 50, counted from each " +
    "erase); the daily cron then deletes those past it, except any on hold. Shortening it deletes " +
    "evidence for good. Admins only, and only a person in the app: AI assistants, MCP clients and " +
    "automations are refused. The change is audited.",
  input: z.object({ years: keepYearsSchema }),
  output: z.object({ years: z.number(), previousYears: z.number().nullable() }),
  permission: "policy:manage",
  risk: "destructive",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const before = await loadKeepYears(ctx.db);
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
    return { years: input.years, previousYears: before };
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
  auditSummary: (output) => ({ found: output.items.length }),
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
    "scrub. No input names an acceptance.",
  input: z.object({}),
  output: z.object({ purged: z.number(), more: z.boolean() }),
  permission: "records:erase",
  risk: "write",
  actors: ["automation"],
  // The host carrying out the retention a person set (decision 15): never queued under a floor.
  hostStep: true,
  mcp: { expose: false },
  auditSummary: (output) => output,
  async handler(_input, ctx) {
    if (ctx.origin.surface !== "system") {
      throw new ForbiddenError("Only the host's own cron purges kept acceptances");
    }
    if (!purgeCutoff(ctx.now, 1)) throw new ValidationError("Invalid clock");
    const due = await purgeableKept(ctx.db, ctx.now, PURGE_KEPT_MAX + 1);
    const ids = due.slice(0, PURGE_KEPT_MAX);
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
    return { purged: ids.length, more: due.length > PURGE_KEPT_MAX };
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

export const agreementRetentionOperations = [
  agreementRetention,
  agreementSetRetention,
  agreementKeptFind,
  agreementKeptHold,
  agreementPurgeKept,
  agreementMergePlan,
] as const;
