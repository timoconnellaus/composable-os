// The import door (ADR 0470): `record.import` writes records of an extension object from an
// outside source (an old blog, later a CRM), each named by a key the source gives it, so that a
// re-run creates nothing twice and changes only what the source changed.
//
// For each record:
//   - no record has the key: it is created (a slug a record the import did not make holds is a
//     conflict, never a second record);
//   - the key's record still holds exactly what the import last wrote: the fields the source
//     changed are updated, and nothing else; unchanged, it is left alone;
//   - a person (or anyone) has changed one of those fields since, or deleted the record: it is a
//     conflict, reported with the fields, and nothing is written.
// What the import last wrote is kept in core_import_key, beside the record, in the same batch as
// the write. Every value goes through the record operations' own checks (`checkRecordValues`,
// `createRecord`, `updateRecord`), so an import can store nothing a person could not.
//
// `dryRun` checks every record as it would be written, and says what would happen, writing
// nothing. With `checkReferences: false` it leaves out whether relations and pictures name live
// records: a dry run before the pictures and the related records an import brings exist.
//
// A person's door only (`actors: ["human"]`): `cos content import` signs a staff member in for the
// run. An assistant or an MCP client writes records with record.create like any write.
import { CompiledQuery } from "kysely";
import { z } from "zod";
import { ValidationError } from "../errors.ts";
import { defineOperation } from "../operation.ts";
import { callerMover } from "../records/lifecycle.ts";
import { slugsForCreate } from "../records/slug.ts";
import { foldUniqueValues } from "../records/unique.ts";
import {
  checkRecordValues,
  createRecord,
  loadRecord,
  lockedChange,
  requireExtensionObject,
  updateRecord,
} from "./record.ts";

/** The most records one call imports: each is a create or update with its own reads. */
export const IMPORT_BATCH_MAX = 25;

const outcome = z.enum(["created", "updated", "unchanged", "conflict", "invalid"]);

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export const recordImport = defineOperation({
  name: "record.import",
  description:
    `Import up to ${IMPORT_BATCH_MAX} records of one extension object from an outside source, ` +
    "each with a key the source gives it (its old id or file name). A key seen before updates " +
    "its record, but only while the record still holds what the import last wrote: a record " +
    "someone changed since is reported as a conflict and left alone. A new key creates a " +
    "record. dryRun checks everything and says what would happen, writing nothing. A person's " +
    "door: cos content import runs it.",
  input: z.object({
    object: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z][a-z0-9]*\.[a-z][a-z0-9]*$/)
      .describe("An extension object (`<extension>.<object>`)"),
    records: z
      .array(
        z.object({
          key: z.string().min(1).max(200).describe("The record's key in the source"),
          values: z.record(z.string().max(80), z.unknown()),
        }),
      )
      .min(1)
      .max(IMPORT_BATCH_MAX),
    dryRun: z.boolean().default(false),
    checkReferences: z
      .boolean()
      .default(true)
      .describe("Check that relations and pictures name live records (a dry run may not yet)"),
  }),
  output: z.object({
    results: z.array(
      z.object({
        key: z.string(),
        id: z.string().nullable(),
        outcome,
        /** For a conflict: the fields changed since the import wrote them. */
        fields: z.array(z.string()),
        problems: z.array(z.string()),
      }),
    ),
  }),
  permission: "records:write",
  risk: "bulk-write",
  actors: ["human"],
  mcp: { expose: false },
  bulkSize: (input) => input.records.length,
  auditSummary: (output, input) => ({
    object: input.object,
    dryRun: input.dryRun,
    outcomes: output.results.reduce<Record<string, number>>((n, r) => {
      n[r.outcome] = (n[r.outcome] ?? 0) + 1;
      return n;
    }, {}),
  }),
  async handler(input, ctx) {
    const object = requireExtensionObject(input.object);
    const keys = input.records.map((r) => r.key);
    if (new Set(keys).size !== keys.length) {
      throw new ValidationError("Each record's key appears once in a call", {
        reason: "key_twice",
      });
    }
    const known = new Map(
      (
        await ctx.db
          .selectFrom("core_import_key")
          .selectAll()
          .where("object_type", "=", object.name)
          .where("import_key", "in", keys)
          .execute()
      ).map((row) => [row.import_key, row]),
    );
    const results: {
      key: string;
      id: string | null;
      outcome: z.infer<typeof outcome>;
      fields: string[];
      problems: string[];
    }[] = [];
    const checkReferences = input.dryRun ? input.checkReferences : true;
    for (const { key, values } of input.records) {
      const prior = known.get(key);
      const result = (o: z.infer<typeof outcome>, id: string | null, more = {}) =>
        results.push({ key, id, outcome: o, fields: [], problems: [], ...more });
      let normalized: Record<string, unknown>;
      try {
        // As the host keeps them (ADR 0864): a tag differing only by case or spaces is the same.
        normalized = foldUniqueValues(
          object,
          await checkRecordValues(ctx, object, values, prior ? "update" : "create", {
            checkReferences,
          }),
        );
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        result("invalid", prior?.record_id ?? null, { problems: [error.message] });
        continue;
      }
      if (!prior) {
        try {
          // A slug another record holds (one the import did not make) is a conflict.
          const withSlugs = await slugsForCreate(ctx, object, values);
          if (input.dryRun) {
            result("created", null);
            continue;
          }
          const id = await createRecord(ctx, object, withSlugs, { imported: true });
          ctx.write(
            CompiledQuery.raw(
              "INSERT INTO core_import_key (object_type, import_key, record_id, written, imported_at, imported_by) VALUES (?, ?, ?, ?, ?, ?)",
              [object.name, key, id, JSON.stringify(normalized), ctx.now, ctx.user.id],
            ),
          );
          result("created", id);
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          const taken = (error.details as { reason?: string } | undefined)?.reason === "slug_taken";
          result(taken ? "conflict" : "invalid", null, {
            ...(taken ? { fields: [(error.details as { field: string }).field] } : {}),
            problems: [error.message],
          });
        }
        continue;
      }
      const record = await loadRecord(ctx, object, prior.record_id);
      if (!record) {
        result("conflict", prior.record_id, {
          problems: ["Deleted since it was imported: restore it, or import it under a new key"],
        });
        continue;
      }
      const written = foldUniqueValues(
        object,
        JSON.parse(prior.written) as Record<string, unknown>,
      );
      // Changed here since the import wrote it: a person's edit is never overwritten.
      const edited = Object.keys(written).filter((f) => !same(record.values[f], written[f]));
      if (edited.length) {
        result("conflict", record.id, {
          fields: edited,
          problems: [`Changed since it was imported: ${edited.join(", ")}`],
        });
        continue;
      }
      const changed = Object.keys(normalized).filter((f) => !same(normalized[f], written[f]));
      if (!changed.length) {
        result("unchanged", record.id);
        continue;
      }
      // A field locked in the record's state (ADR 0865) is refused for this row, in the dry run
      // as in the real one, and the other rows go on (the review of PR #502).
      const changes = Object.fromEntries(changed.map((f) => [f, normalized[f]]));
      const locked = lockedChange(ctx, object, record.values, changes, callerMover(ctx));
      if (locked) {
        result("invalid", record.id, { fields: [locked.field], problems: [locked.message] });
        continue;
      }
      if (!input.dryRun) {
        // Any other refusal refuses the call whole, as before: some count every row of the call
        // together (the follower limit, ADR 0841), so one row's answer is not theirs to give.
        await updateRecord(
          ctx,
          object,
          record.id,
          Object.fromEntries(changed.map((f) => [f, values[f]])),
          { imported: true },
        );
        ctx.write(
          CompiledQuery.raw(
            "UPDATE core_import_key SET written = ?, imported_at = ?, imported_by = ? WHERE object_type = ? AND import_key = ?",
            [JSON.stringify({ ...written, ...normalized }), ctx.now, ctx.user.id, object.name, key],
          ),
        );
      }
      result("updated", record.id, { fields: changed });
    }
    return { results };
  },
});

export const recordImportOperations = [recordImport] as const;
