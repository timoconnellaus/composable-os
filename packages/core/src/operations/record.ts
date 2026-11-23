// record.* operations: generic records of extension objects, and extension fields on any object
// (ADR 0023). They read the rec_* views and write x_* tables, validated against the field registry
// and the field-type registry, so lists, filters, search, saved views, history (audit diffs) and
// timeline tracking work for extension schema exactly as for core objects.
//
// Core objects keep their own operations (person.update, …); `record.update` on a core object
// writes only extension fields (into side tables), and `record.get` returns them.

import {
  type DocumentSchema,
  documentRefs,
  type FieldManifest,
  isDocumentType,
} from "@composable-os/sdk";
import { CompiledQuery, type Kysely, sql } from "kysely";
import { z } from "zod";
import {
  assertHolderCreatable,
  assertSpenderDeletable,
  followSpenders,
  holderTerms,
  holderTrash,
  holderWrite,
  hostFilled,
  setAllowanceRecordUpdate,
  spenderWrite,
} from "../allowance/records.ts";
import { assignOwner, recordAssignment } from "../assignment/index.ts";
import { assertNoLiveClaim } from "../capacity/claimants.ts";
import { assertNoConfirmedClaims, counterWrite } from "../capacity/records.ts";
import { WAITLIST_FOR } from "../capacity/waitlist.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import {
  ALLOWANCE_FIELDS,
  CAPACITY_FIELDS,
  fieldStorage,
  objectTableOf,
  PUBLISHED_FIELDS,
} from "../extensions/schema.ts";
import { FIELD_TYPE_REGISTRY, formulaFromStorage } from "../fields/field-types.ts";
import { getObject, isCoreObject, listObjects } from "../fields/index.ts";
import { mediaObject } from "../fields/media.ts";
import type { FieldDefinition, ObjectDefinition } from "../fields/types.ts";
import { newId } from "../ids.ts";
import { listInputSchema, pageSchema, runListQuery } from "../list.ts";
import type { RecordRef } from "../operation.ts";
import { defineOperation, type HandlerContext, personsTool } from "../operation.ts";
import { viewColumnOf } from "../records/columns.ts";
import { jsonList, restorableUntil, TRASH_RETENTION_DAYS } from "../records/common.ts";
import { FOLLOWERS_MAX, followerIds, followersOf } from "../records/follows.ts";
import { applyTransition, callerMover } from "../records/lifecycle.ts";
import {
  assertRestorable,
  assertSlugsFree,
  redirectWrites,
  slugsForCreate,
} from "../records/slug.ts";
import type { StageCache } from "../records/stages.ts";
import { resolveStateRequest } from "../records/states.ts";
import { type Mover, type TransitionOutcome, transitionTimeline } from "../records/transitions.ts";
import { assertUnique } from "../records/unique.ts";
import { guardStatement } from "../recurring/bookkeeping.ts";
import {
  assertRuleValues,
  claimedOn,
  closureWritten,
  generatedRecordEdited,
  seriesChanged,
  seriesCreated,
  setRecurringWriter,
} from "../recurring/index.ts";
import { type ChangeMarks, CREATED, type MarkSource } from "../routine-mail/marks.ts";
import { loadGeneralSettings } from "../settings.ts";
import {
  assertHolderTrashable,
  assertRosterRestore,
  assertRosterWrite,
  holderWritten,
  type StaffWarning,
  staffedReleased,
  staffedRestored,
  staffedWritten,
  warningsOf,
} from "../staffing/index.ts";
import { type Reader, visibleSource, visibleTable } from "../visibility/index.ts";
import { setRecordWriter } from "../visibility/writes.ts";

const objectName = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)?$/)
  .describe("Object: an extension object (`<extension>.<object>`) or a core object");
const recordId = z.string().min(1).max(64).describe("Record id");
const valuesSchema = z
  .record(z.string().max(80), z.unknown())
  .describe("Field values by registry field name (see schema.objects)");

export const recordSchema = z.object({
  object: z.string(),
  id: z.string(),
  title: z.string().nullable(),
  values: z.record(z.string(), z.unknown()),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type RecordOutput = z.infer<typeof recordSchema>;

/** A warning a write of a shift was made with (stage 45, ADR 0622): it was made, not refused. */
export const staffWarningSchema = z.object({
  code: z.enum(["unavailable", "not_qualified", "uncovered"]),
  object: z.string(),
  id: z.string(),
  account: z.string().nullable(),
  message: z.string(),
});

/** What record.create and record.update answer: the stored record, and any warnings. */
export const recordWriteSchema = recordSchema.extend({
  warnings: z
    .array(staffWarningSchema)
    .optional()
    .describe(
      "A shift's warnings (ADR 0622): its person away or not qualified, or nobody on it. The write was made.",
    ),
});

/** The record as stored, with the warnings this batch's write of it was made with. */
async function withWarnings(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  warnings: readonly StaffWarning[],
) {
  const record = (await loadRecord(ctx, object, id)) as RecordOutput;
  return warnings.length ? { ...record, warnings: [...warnings] } : record;
}

// biome-ignore lint/suspicious/noExplicitAny: x_* tables and rec_x_* views are not in CoreDatabase; names come from the registry.
type AnyDb = Kysely<any>;

function requireObject(name: string): ObjectDefinition {
  const object = getObject(name);
  if (!object) throw new ValidationError(`Unknown object "${name}"`, { object: name });
  return object;
}

export function requireExtensionObject(name: string): ObjectDefinition & { titleField: string } {
  const object = requireObject(name);
  if (isCoreObject(name) || !object.extension || !object.titleField) {
    throw new ValidationError(
      `${name} is a core object; use its own operations (e.g. ${name}.create)`,
      { object: name },
    );
  }
  return object as ObjectDefinition & { titleField: string };
}

/** The extension fields of an object's registry entry (everything but system and core fields). */
function extensionFields(object: ObjectDefinition): FieldDefinition[] {
  return object.fields.filter((f) => f.extension);
}

function manifestOf(field: FieldDefinition): FieldManifest {
  return {
    type: field.fieldType as FieldManifest["type"],
    label: field.label,
    ...(field.options?.choices ? { options: [...field.options.choices] } : {}),
    ...(field.options?.to ? { to: field.options.to } : {}),
    ...(field.options?.many !== undefined ? { many: field.options.many } : {}),
    ...(field.options?.min !== undefined ? { min: field.options.min } : {}),
    ...(field.options?.max !== undefined ? { max: field.options.max } : {}),
    ...(field.options?.step !== undefined ? { step: field.options.step } : {}),
    ...(field.options?.document
      ? {
          schema: field.options.document.schema,
          ...(field.options.document.maxBytes !== undefined
            ? { maxBytes: field.options.document.maxBytes }
            : {}),
        }
      : {}),
  };
}

function fromRow(object: ObjectDefinition, row: Record<string, unknown>): RecordOutput {
  const values: Record<string, unknown> = {};
  for (const field of extensionFields(object)) {
    const type = field.fieldType as keyof typeof FIELD_TYPE_REGISTRY;
    const column = viewColumnOf(field);
    const rawValue = column ? row[column] : null;
    values[field.name] =
      type === "formula"
        ? formulaFromStorage(field.options?.resultType, rawValue)
        : FIELD_TYPE_REGISTRY[type].fromStorage(rawValue ?? null);
  }
  // The capacity behaviour's read-only values (ADR 0431): held, taken, available.
  if (object.capacity) {
    for (const field of CAPACITY_FIELDS) {
      const raw = field.column ? row[field.column] : null;
      values[field.name] = raw === undefined || raw === null ? null : Number(raw);
    }
  }
  // The allowance behaviour's read-only values on a holder (ADR 0493): used and left now.
  if (object.allowance?.kind === "holder") {
    for (const field of ALLOWANCE_FIELDS) {
      const raw = field.column ? row[field.column] : null;
      values[field.name] = raw === undefined || raw === null ? null : Number(raw);
    }
  }
  // The publishable behaviour's read-only values (ADR 0446): the version readers are given.
  if (object.publishable) {
    for (const field of PUBLISHED_FIELDS) {
      const raw = field.column ? row[field.column] : null;
      values[field.name] =
        raw === undefined || raw === null ? null : field.type === "number" ? Number(raw) : raw;
    }
  }
  const titleColumn = object.titleField
    ? object.fields.find((f) => f.name === object.titleField)?.column
    : undefined;
  const titleValue = titleColumn ? row[titleColumn] : (row.name ?? row.display_name ?? row.title);
  return {
    object: object.name,
    id: String(row.id),
    title: titleValue == null ? null : String(titleValue),
    values,
    createdAt: (row.created_at as string | undefined) ?? null,
    updatedAt: (row.updated_at as string | undefined) ?? null,
  };
}

export async function loadRecord(
  reader: Reader,
  object: ObjectDefinition,
  id: string,
): Promise<RecordOutput | null> {
  const row = await (reader.db as AnyDb)
    .selectFrom(visibleSource(reader, object))
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  return row ? fromRow(object, row as Record<string, unknown>) : null;
}

interface PreparedValue {
  field: FieldDefinition;
  value: unknown;
  stored: string | number | null;
  table: string;
  column: string;
  own: boolean;
}

/** Validates `values` for writing; returns them with their storage. */
async function prepareValues(
  ctx: HandlerContext,
  object: ObjectDefinition,
  values: Record<string, unknown>,
  mode: "create" | "update",
  options: { checkReferences?: boolean; by?: Mover; seamSet?: ReadonlySet<string> } = {},
): Promise<PreparedValue[]> {
  const prepared: PreparedValue[] = [];
  for (const [name, value] of Object.entries(values)) {
    const field = object.fields.find((f) => f.name === name);
    if (!field) {
      throw new ValidationError(`Unknown field "${name}" on ${object.name}`, {
        field: name,
        allowed: extensionFields(object)
          .filter((f) => !f.readOnly)
          .map((f) => f.name),
      });
    }
    if (!field.extension) {
      throw new ValidationError(
        `${object.name}.${name} is a core field; change it with ${object.name}.update`,
        { field: name },
      );
    }
    // Read-only fields are maintained by the host, or by the declaring extension's own code
    // (a tool or automation of that extension, ADR 0246): Leads sets a lead's deal on conversion.
    // A holder's terms (its uses, its dates, whose they are) only through a tool only a person
    // with a permission may call (ADR 0513): never any other code of the extension.
    const term = holderTerms(object).has(name);
    const ownCode =
      field.fieldType !== "formula" &&
      field.extension !== undefined &&
      ctx.extension?.id === field.extension &&
      (!term || personsTool(ctx, field.extension) !== null);
    // Who made a record for a customer (ADR 0540) is the seam's alone: set by its create, and by
    // no one else, staff, AI, the host's other code and the extension's own tools included.
    if (name === object.customer?.guardians?.madeBy) {
      if (mode === "create" && options.seamSet?.has(name)) {
        // Set by the seam for the caller: stored as given (a relation to a Person).
      } else {
        throw new ValidationError(
          `${object.name}.${name} is set by the host and cannot be written`,
          {
            field: name,
          },
        );
      }
    }
    const seamCode = options.seamSet?.has(name) === true;
    // Platform code making a host move sets them too (a payment's reference and time).
    const hostCode = field.fieldType !== "formula" && (options.by === "host" || seamCode);
    // What a holder's conditions read on a spender is the host's alone, even for the
    // extension's own code (ADR 0493): no actor sets what pays for it.
    if (!hostCode && hostFilled(object).has(name)) {
      throw new ValidationError(`${object.name}.${name} is set by the host and cannot be written`, {
        field: name,
      });
    }
    if (field.readOnly && !ownCode && !hostCode) {
      throw new ValidationError(
        field.fieldType === "formula"
          ? `${object.name}.${name} is computed and cannot be set`
          : `${object.name}.${name} is set automatically and cannot be written`,
        { field: name },
      );
    }
    const storage = fieldStorage(object.name, name);
    if (!storage?.column) throw new ValidationError(`${object.name}.${name} cannot be written`);
    const spec = FIELD_TYPE_REGISTRY[storage.type];
    const parsed = spec.schema(manifestOf(field)).safeParse(value);
    if (!parsed.success) {
      // A document's fault is named by its path in the message too (ADR 0445).
      const first = [
        "document",
        "richText",
        "image",
        "video",
        "slug",
        "number",
        "currency",
        "percent",
      ].includes(storage.type)
        ? parsed.error.issues[0]
        : undefined;
      const where = first
        ? `: ${[name, ...first.path.map(String)].join(".")}: ${first.message}`
        : "";
      throw new ValidationError(`Invalid value for ${object.name}.${name}${where}`, {
        field: name,
        issues: parsed.error.issues,
      });
    }
    if (field.required && (parsed.data === null || parsed.data === "")) {
      throw new ValidationError(`${object.name}.${name} is required`, { field: name });
    }
    prepared.push({
      field,
      value: parsed.data,
      stored: spec.toStorage(parsed.data),
      table: storage.table,
      column: storage.column,
      own: storage.own,
    });
  }
  if (mode === "create") {
    for (const field of extensionFields(object)) {
      if (field.required && !prepared.some((p) => p.field.name === field.name)) {
        const storage = fieldStorage(object.name, field.name);
        if (storage?.own) {
          throw new ValidationError(`${object.name}.${field.name} is required`, {
            field: field.name,
          });
        }
      }
    }
  }
  if (options.checkReferences !== false) await assertReferences(ctx, prepared);
  return prepared;
}

/**
 * Checks `values` for writing exactly as a create or an update would (types, schemas, required
 * fields, rules of choices, and, unless `checkReferences` is false, that relations, users and
 * document refs name live records), and returns each value as the record will hold it: what a
 * read of the record gives back. Writes nothing. The import door (ADR 0470) compares by these.
 */
export async function checkRecordValues(
  ctx: HandlerContext,
  object: ObjectDefinition,
  values: Record<string, unknown>,
  mode: "create" | "update",
  options: { checkReferences?: boolean } = {},
): Promise<Record<string, unknown>> {
  const prepared = await prepareValues(ctx, object, values, mode, options);
  return Object.fromEntries(
    prepared.map((p) => {
      const type = fieldStorage(object.name, p.field.name)?.type ?? "text";
      return [p.field.name, FIELD_TYPE_REGISTRY[type].fromStorage(p.stored)];
    }),
  );
}

/** Values the host sets (a lifecycle's): validated by type; read-only fields allowed. */
function hostValues(object: ObjectDefinition, values: Record<string, unknown>): PreparedValue[] {
  return Object.entries(values).map(([name, value]) => {
    const field = object.fields.find((f) => f.name === name);
    const storage = fieldStorage(object.name, name);
    if (!field || !storage?.column) throw new Error(`${object.name}.${name} cannot be set`);
    const spec = FIELD_TYPE_REGISTRY[storage.type];
    const parsed = spec.schema(manifestOf(field)).parse(value);
    return {
      field,
      value: parsed,
      stored: spec.toStorage(parsed),
      table: storage.table,
      column: storage.column,
      own: storage.own,
    };
  });
}

function withHostValues(
  prepared: PreparedValue[],
  outcome: TransitionOutcome,
  object: ObjectDefinition,
) {
  const extra = hostValues(object, outcome.values);
  return [...prepared.filter((p) => !Object.hasOwn(outcome.values, p.field.name)), ...extra];
}

/** A lifecycle outcome with more host values (the allowance's) on top of its own. */
function withValues(
  outcome: TransitionOutcome,
  values: Record<string, unknown>,
): TransitionOutcome {
  return Object.keys(values).length
    ? { ...outcome, values: { ...outcome.values, ...values } }
    : outcome;
}

const valuesOf = (prepared: PreparedValue[]) =>
  Object.fromEntries(prepared.map((p) => [p.field.name, p.value]));

/**
 * Select choices may require other fields (ADR 0058): a record holding the choice must have a
 * value in each. `values` is the record as it will be after the write. Refuses with the first
 * missing field named in `details.field`, so a board drag can ask for it.
 */
export function assertChoiceRequirements(
  object: ObjectDefinition,
  prepared: readonly { field: FieldDefinition; value: unknown }[],
  values: Record<string, unknown>,
): void {
  for (const p of prepared) {
    const choice = p.field.options?.choices?.find((c) => c.value === p.value);
    if (!choice?.requires?.length) continue;
    const prefix = p.field.name.includes(".") ? `${p.field.name.split(".")[0]}.` : "";
    const missing = choice.requires
      .map((name) => object.fields.find((f) => f.name === name || f.name === `${prefix}${name}`))
      .filter((f): f is FieldDefinition => Boolean(f))
      .filter((f) => {
        const value = values[f.name];
        return (
          value === null ||
          value === undefined ||
          value === "" ||
          (Array.isArray(value) && value.length === 0)
        );
      });
    const first = missing[0];
    if (first) {
      throw new ValidationError(
        `${p.field.label} “${choice.label}” needs ${missing.map((f) => f.label).join(", ")}`,
        {
          field: first.name,
          fields: missing.map((f) => f.name),
          reason: "required_by_choice",
          choiceField: p.field.name,
          choice: choice.value,
        },
      );
    }
  }
}

/** Relation and user fields must point at live records and real users. */
async function assertReferences(ctx: HandlerContext, prepared: PreparedValue[]) {
  for (const p of prepared) {
    if (p.value == null) continue;
    if (isDocumentType(p.field.fieldType)) {
      await assertDocumentRefs(ctx, p.field, p.value);
      continue;
    }
    const ids = Array.isArray(p.value) ? (p.value as string[]) : [String(p.value)];
    if (!ids.length) continue;
    if (p.field.fieldType === "user") {
      const found = await ctx.db
        .selectFrom("core_user")
        .select("id")
        .where("id", "in", jsonList(ids))
        .where("kind", "=", "human")
        .execute();
      if (found.length !== new Set(ids).size) {
        throw new ValidationError(`${p.field.name}: no such user`, { field: p.field.name });
      }
      continue;
    }
    if (p.field.fieldType === "relation" && p.field.options?.to) {
      const target = getObject(p.field.options.to);
      if (!target) throw new ValidationError(`${p.field.name}: unknown target object`);
      const found = await (ctx.db as AnyDb)
        .selectFrom(visibleSource(ctx, target))
        .select("id")
        .where("id", "in", jsonList(ids))
        .execute();
      const have = new Set(found.map((r) => String((r as { id: string }).id)));
      const missing = [...new Set(ids)].filter((id) => !have.has(id));
      if (missing.length) {
        throw new ValidationError(
          `${p.field.name}: no live ${target.name} with id ${missing.join(", ")}`,
          {
            field: p.field.name,
            missing,
          },
        );
      }
    }
  }
}

/**
 * A document's refs must name live records of their objects, as a relation's do (ADR 0445): one
 * read per object named, through the caller's seam. The first missing one is named by its path.
 */
async function assertDocumentRefs(ctx: HandlerContext, field: FieldDefinition, value: unknown) {
  const schema = field.options?.document?.schema as DocumentSchema | undefined;
  if (!schema) return;
  const refs = documentRefs(schema, value);
  const byObject = new Map<string, typeof refs>();
  for (const ref of refs) byObject.set(ref.to, [...(byObject.get(ref.to) ?? []), ref]);
  for (const [to, list] of byObject) {
    const target = getObject(to);
    if (!target) throw new ValidationError(`${field.name}: unknown object ${to}`);
    const ids = [...new Set(list.map((r) => r.id))];
    const found = await (ctx.db as AnyDb)
      .selectFrom(visibleSource(ctx, target))
      .select("id")
      .where("id", "in", jsonList(ids))
      .execute();
    const have = new Set(found.map((r) => String((r as { id: string }).id)));
    const missing = list.find((r) => !have.has(r.id));
    if (missing) {
      const where = [field.name, ...missing.path.map(String)].join(".");
      throw new ValidationError(`${where}: no live ${to} with id ${missing.id}`, {
        field: field.name,
        path: missing.path,
        missing: ids.filter((id) => !have.has(id)),
      });
    }
    if (to === "media") await assertMediaKinds(ctx, field, list);
  }
}

/**
 * A media ref that names a kind takes only that kind (stage 42, ADR 0475): a picture where a
 * picture goes, a file where a download goes, and a video only once Stream has it ready.
 */
async function assertMediaKinds(
  ctx: HandlerContext,
  field: FieldDefinition,
  refs: ReturnType<typeof documentRefs>,
) {
  const typed = refs.filter((r) => r.media);
  if (!typed.length) return;
  const rows = await ctx.db
    .selectFrom(visibleSource(ctx, mediaObject))
    .select(["id", "kind", "state"])
    .where("id", "in", jsonList([...new Set(typed.map((r) => r.id))]))
    .execute();
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  for (const ref of typed) {
    const row = byId.get(ref.id);
    const where = [field.name, ...ref.path.map(String)].join(".");
    if (!row || row.kind !== ref.media) {
      throw new ValidationError(`${where}: ${ref.id} is not a ${ref.media}`, {
        field: field.name,
        path: ref.path,
        reason: "media_kind",
        expected: ref.media,
      });
    }
    if (ref.media === "video" && row.state !== "ready") {
      throw new ValidationError(`${where}: the video ${ref.id} is not ready yet`, {
        field: field.name,
        path: ref.path,
        reason: "video_not_ready",
        state: row.state,
      });
    }
  }
}

/** Upserts side-table values (one statement per side table). */
function sideWrites(id: string, prepared: PreparedValue[]): CompiledQuery[] {
  const byTable = new Map<string, PreparedValue[]>();
  for (const p of prepared.filter((x) => !x.own)) {
    byTable.set(p.table, [...(byTable.get(p.table) ?? []), p]);
  }
  return [...byTable].map(([table, values]) => {
    const columns = values.map((v) => v.column);
    return CompiledQuery.raw(
      `INSERT INTO ${table} (id, ${columns.join(", ")}) VALUES (?, ${columns.map(() => "?").join(", ")}) ON CONFLICT (id) DO UPDATE SET ${columns.map((c) => `${c} = excluded.${c}`).join(", ")}`,
      [id, ...values.map((v) => v.stored)],
    );
  });
}

function searchDoc(object: string, id: string, title: string | null): CompiledQuery[] {
  return [
    CompiledQuery.raw("DELETE FROM core_search_docs WHERE object_type = ? AND record_id = ?", [
      object,
      id,
    ]),
    CompiledQuery.raw(
      "INSERT INTO core_search_docs (object_type, record_id, title, body) VALUES (?, ?, ?, '')",
      [object, id, title ?? ""],
    ),
  ];
}

function snapshot(record: RecordOutput): Record<string, unknown> {
  return { ...record.values };
}

export const recordCreate = defineOperation({
  name: "record.create",
  description:
    "Create a record of an extension object (`<extension>.<object>`, see schema.objects) with " +
    "field values by name. Formula fields are computed and cannot be set; relation fields take " +
    "record ids (an array when the field holds many). Returns the stored record. Core objects " +
    "(person, organisation, …) use their own create operations.",
  input: z.object({ object: objectName, values: valuesSchema.default({}) }),
  output: recordWriteSchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const object = requireExtensionObject(input.object);
    const id = await createRecord(ctx, object, input.values);
    const warnings = warningsOf(ctx, object.name, id);
    return ctx.afterCommit(() => withWarnings(ctx, object, id, warnings));
  },
});

/**
 * Queues the writes that create one record of an extension object (validation, the object's
 * lifecycle and its history, search, audit) and returns its id. record.create and the record CSV
 * import share it. `by` is who creates it: the caller unless platform code says `host`.
 */
export async function createRecord(
  ctx: HandlerContext,
  object: ObjectDefinition,
  values: Record<string, unknown>,
  options: {
    cache?: StageCache;
    checkReferences?: boolean;
    assignmentTimeline?: boolean;
    by?: Mover;
    /** A closure's create cancelling records with places taken: their count, confirmed. */
    recurringConfirm?: number | undefined;
    /** Fields the visibility seam itself sets for a customer (`guardians.madeBy`, ADR 0540). */
    seamSet?: ReadonlySet<string>;
    /** Fields the host copies from other records (ADR 0590): their marks are the sources'. */
    copied?: Record<string, MarkSource[]>;
    /** Fields the host generates itself, not anyone's words (a ticket's code): `default`. */
    generated?: readonly string[];
  } = {},
): Promise<string> {
  const requester = options.by ?? (object.states?.requests ? callerMover(ctx) : undefined);
  // A move asked for by name (`cancel`) becomes the state the host picks (ADR 0503).
  const asked = requester
    ? await resolveStateRequest(ctx, object, null, values, requester)
    : values;
  // What an order line grants, given by a person's tool instead (a pass by hand, ADR 0513): its
  // dates are the host's, as a paid line's are, and an intro offer's one per Person is used.
  const handed =
    options.by !== "host" && personsTool(ctx, object.extension) !== null && isGranted(object)
      ? await (await import("../orders/grants.ts")).handGrantValues(ctx, object, asked)
      : asked;
  // A slug left empty is made from the title; one given must be free (ADR 0442).
  const withDefaults = await slugsForCreate(ctx, object, await applyDefaults(ctx, object, handed));
  let prepared = await prepareValues(ctx, object, withDefaults, "create", options);
  assertOneOf(object, valuesOf(prepared));
  assertRuleValues(object, valuesOf(prepared));
  // No owner given: assignment rules choose one, in this same insert (ADR 0246).
  const ownerField = object.ownerField;
  const assignment =
    ownerField && (withDefaults[ownerField] === undefined || withDefaults[ownerField] === null)
      ? await assignOwner(ctx, object, { get: (field) => valuesOf(prepared)[field] ?? null })
      : null;
  if (ownerField && assignment?.ownerId) {
    prepared = [
      ...prepared.filter((p) => p.field.name !== ownerField),
      ...hostValues(object, { [ownerField]: assignment.ownerId }),
    ];
  }
  assertChoiceRequirements(object, prepared, valuesOf(prepared));
  const table = objectTableOf(object.name) as string;
  const id = newId("record");
  const by = options.by ?? callerMover(ctx);
  // Passes and memberships are granted or made by staff, never by a customer (ADR 0494).
  assertHolderCreatable(object, by);
  const outcome = await applyTransition(ctx, object, id, null, valuesOf(prepared), {
    by,
    cache: options.cache,
  });
  // A spender entering a spend state spends a use (ADR 0493): the host's values on it (the
  // holder spent from, what it copies) go in this insert, the use after it.
  const spent = await spenderWrite(ctx, object, id, null, valuesOf(prepared), outcome, by);
  prepared = withHostValues(prepared, withValues(outcome, spent.values), object);
  // One live record per declared key (ADR 0502); the database's index refuses a race.
  await assertUnique(ctx, object, id, valuesOf(prepared));
  // Who works a shift, or a pattern's person: a rosterer's to say (ADR 0626).
  await assertRosterWrite(ctx, object, null, valuesOf(prepared), by);
  // A shift: never one person on two at once, refused naming the other; its warnings (ADR 0621).
  await staffedWritten(ctx, object, id, null, valuesOf(prepared), { by });
  const own = prepared.filter((p) => p.own);
  const columns = ["id", "created_at", "updated_at", "created_by", ...own.map((p) => p.column)];
  ctx.write(
    CompiledQuery.raw(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      [id, ctx.now, ctx.now, ctx.user.id, ...own.map((p) => p.stored)],
    ),
    ...sideWrites(id, prepared),
    ...outcome.history,
  );
  // The record's capacity counter (ADR 0431), after the record it belongs to.
  const counter = await counterWrite(ctx, object, id, valuesOf(prepared), "create");
  if (counter) ctx.write(counter);
  // A holder's terms, and a spender's use (ADR 0493).
  ctx.write(...(await holderWrite(ctx, object, id, null, valuesOf(prepared))));
  ctx.write(...spent.statements);
  const title = prepared.find((p) => p.field.name === object.titleField)?.value;
  ctx.write(...searchDoc(object.name, id, title == null ? null : String(title)));
  ctx.write(...(await redirectWrites(ctx, object, id, null, valuesOf(prepared))));
  // A new series is due now; a new closure cancels what it covers (ADR 0500).
  seriesCreated(ctx, object, id);
  await closureWritten(ctx, object, null, valuesOf(prepared), options.recurringConfirm);
  const assigned = assignment
    ? recordAssignment(ctx, object, id, assignment, {
        timeline: options.assignmentTimeline !== false,
      })
    : undefined;
  const after = valuesOf(prepared);
  const warnings = warningsOf(ctx, object.name, id);
  ctx.recordChange({
    object: object.name,
    id,
    action: "create",
    after,
    assignment: assigned,
    marks: await createMarks(
      ctx,
      object,
      values,
      withDefaults,
      after,
      by,
      options.copied,
      options.generated,
    ),
    ...(warnings.length ? { warnings } : {}),
  });
  return id;
}

/**
 * Who stands behind a new record's values (ADR 0590): what the caller gave is the caller's; a
 * title taken from a related record (`titleDefault`) and a moved booking's values (`movedFrom`)
 * carry their sources' marks; a declared default is a default; everything else the host filled
 * (and everything a host write sets) is the host's.
 */
async function createMarks(
  ctx: HandlerContext,
  object: ObjectDefinition,
  given: Record<string, unknown>,
  withDefaults: Record<string, unknown>,
  after: Record<string, unknown>,
  by: Mover,
  copiedIn: Record<string, MarkSource[]> | undefined,
  generated: readonly string[] = [],
): Promise<ChangeMarks> {
  const filled = (v: unknown) => v !== undefined && v !== null && v !== "";
  const copied: Record<string, MarkSource[]> = { ...(copiedIn ?? {}) };
  const titleField = object.titleField;
  if (
    titleField &&
    object.titleDefault &&
    !filled(given[titleField]) &&
    filled(after[titleField])
  ) {
    for (const name of object.titleDefault.from) {
      const to = object.fields.find((f) => f.name === name)?.options?.to;
      const target = to ? getObject(to) : undefined;
      const relatedId = withDefaults[name];
      if (!to || !target || typeof relatedId !== "string" || !relatedId) continue;
      const field = target.titleField ?? (to === "person" ? "displayName" : "name");
      copied[titleField] = [
        { object: to, id: relatedId, field, value: await titleOf(ctx, to, relatedId) },
      ];
      break;
    }
  }
  // A move (ADR 0551): the new record's values that are the old one's carry the old one's marks.
  const moved =
    object.allowance?.kind === "spender" ? object.allowance.movedFrom?.field : undefined;
  const oldId = moved ? after[moved] : undefined;
  if (moved && typeof oldId === "string") {
    const old = await loadRecord(ctx, object, oldId);
    for (const [field, value] of Object.entries(after)) {
      if (field === moved || !old || copied[field]) continue;
      if (JSON.stringify(old.values[field] ?? null) === JSON.stringify(value ?? null)) {
        copied[field] = [{ object: object.name, id: oldId, field, value }];
      }
    }
    copied[CREATED] = [{ object: object.name, id: oldId, field: CREATED, value: "" }];
  }
  // A default taken from an extension setting is the setting's writer's: a default only when the
  // setting is one a person approves (ADR 0552), else the host's (an AI may write settings).
  const fromSetting = new Set(await settingDefaults(ctx, object, given, withDefaults));
  const defaulted = Object.keys(after).filter(
    (f) =>
      generated.includes(f) ||
      (!filled(given[f]) &&
        filled(withDefaults[f]) &&
        !copied[f] &&
        !fromSetting.has(f) &&
        by !== "host"),
  );
  const hostFilled = Object.keys(after).filter(
    (f) => (by === "host" || !Object.hasOwn(given, f)) && !copied[f] && !defaulted.includes(f),
  );
  return { copied, hostFilled, defaulted };
}

/**
 * The fields of a new record filled from an extension setting (`defaultSetting`) that is not one a
 * person approves: who stands behind them is whoever last wrote the setting (ADR 0590).
 */
async function settingDefaults(
  ctx: HandlerContext,
  object: ObjectDefinition,
  given: Record<string, unknown>,
  withDefaults: Record<string, unknown>,
): Promise<string[]> {
  const fields = object.fields.filter(
    (f) =>
      f.options?.defaultSetting &&
      (given[f.name] === undefined || given[f.name] === null || given[f.name] === "") &&
      withDefaults[f.name] !== undefined &&
      withDefaults[f.name] !== null &&
      JSON.stringify(withDefaults[f.name]) !== JSON.stringify(f.options?.default ?? null),
  );
  if (!fields.length || !object.extension) return [];
  const row = await ctx.db
    .selectFrom("core_extensions")
    .select("manifest")
    .where("id", "=", object.extension)
    .executeTakeFirst();
  let settings: Record<string, { personApproves?: boolean }> = {};
  try {
    settings = (JSON.parse(row?.manifest ?? "{}") as { settings?: typeof settings }).settings ?? {};
  } catch {}
  return fields
    .filter((f) => settings[f.options?.defaultSetting ?? ""]?.personApproves !== true)
    .map((f) => f.name);
}

/**
 * Field defaults (ADR 0246) for a new record of an extension object: the declared `default`, or
 * the extension setting named by `defaultSetting` when it has a value. Given values win.
 */
async function applyDefaults(
  ctx: HandlerContext,
  object: ObjectDefinition,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const named = await withZoneDefaults(ctx, object, await withDefaultTitle(ctx, object, values));
  const fields = object.fields.filter(
    (f) =>
      f.extension === object.extension &&
      (f.options?.default !== undefined || f.options?.defaultSetting) &&
      (named[f.name] === undefined || named[f.name] === null),
  );
  if (!fields.length || !object.extension) return named;
  let settings: Record<string, unknown> = {};
  if (fields.some((f) => f.options?.defaultSetting)) {
    const row = await ctx.db
      .selectFrom("core_extension_settings")
      .select("value")
      .where("extension_id", "=", object.extension)
      .executeTakeFirst();
    settings = row ? (JSON.parse(row.value) as Record<string, unknown>) : {};
  }
  const out = { ...named };
  for (const field of fields) {
    const setting = field.options?.defaultSetting ? settings[field.options.defaultSetting] : null;
    const value = setting ?? field.options?.default;
    if (value !== undefined && value !== null) out[field.name] = value;
  }
  return out;
}

/**
 * A `timezone` field left empty on a new record, with no default of its own, is the deployment's
 * zone (Settings → General, `timezone`; ADR 0460): an event created in Sydney is in Sydney until
 * someone says it is in Bangkok.
 */
async function withZoneDefaults(
  ctx: HandlerContext,
  object: ObjectDefinition,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const empty = object.fields.filter(
    (f) =>
      f.fieldType === "timezone" &&
      f.options?.default === undefined &&
      !f.options?.defaultSetting &&
      (values[f.name] === undefined || values[f.name] === null || values[f.name] === ""),
  );
  if (!empty.length) return values;
  const { timezone } = await loadGeneralSettings(ctx.db);
  return { ...values, ...Object.fromEntries(empty.map((f) => [f.name, timezone])) };
}

/** `titleDefault` (ADR 0246): a record left untitled is named after its first filled relation. */
async function withDefaultTitle(
  ctx: HandlerContext,
  object: ObjectDefinition,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { titleDefault, titleField } = object;
  if (!titleDefault || !titleField) return values;
  const given = values[titleField];
  if (given !== undefined && given !== null && given !== "") return values;
  for (const name of titleDefault.from) {
    const to = object.fields.find((f) => f.name === name)?.options?.to;
    const title = await titleOf(ctx, to, values[name]);
    if (title) return { ...values, [titleField]: `${title}${titleDefault.suffix ?? ""}` };
  }
  return values;
}

/** `requireOneOf` (ADR 0246): each group needs a value in at least one of its fields. */
function assertOneOf(object: ObjectDefinition, values: Record<string, unknown>): void {
  for (const group of object.requireOneOf ?? []) {
    const filled = group.some((name) => {
      const value = values[name];
      return value !== null && value !== undefined && value !== "";
    });
    if (filled) continue;
    const labels = group.map((name) => object.fields.find((f) => f.name === name)?.label ?? name);
    throw new ValidationError(
      `${object.label} needs ${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}`,
      { field: group[0], fields: [...group], reason: "require_one_of" },
    );
  }
}

/** Titles of records by id (relation targets), for timeline labels. */
async function titleOf(ctx: HandlerContext, to: string | undefined, id: unknown) {
  if (typeof id !== "string" || !to) return null;
  const target = getObject(to);
  const column = target?.titleField
    ? target.fields.find((f) => f.name === target.titleField)?.column
    : target?.name === "organisation"
      ? "name"
      : target?.name === "person"
        ? "display_name"
        : undefined;
  if (!target || !column) return null;
  const row = await sql<{ title: string | null }>`
    SELECT ${sql.ref(column)} AS title FROM ${visibleSource(ctx, target)} WHERE id = ${id}
  `.execute(ctx.db);
  return row.rows[0]?.title ?? null;
}

/**
 * The timeline post's subject, links and value labels for an update (ADR 0100, ADR 0425): a move
 * reads "Moved to <stage or state>", and posts also go on the records named by the object's
 * timelineLinks.
 */
async function timelineFor(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  outcome: TransitionOutcome,
) {
  const move = transitionTimeline(outcome);
  const tracked = object.fields.filter(
    (f) =>
      f.track === "timeline" &&
      JSON.stringify(before[f.name] ?? null) !== JSON.stringify(after[f.name] ?? null),
  );
  if (!tracked.length) return undefined;
  const links: RecordRef[] = [{ object: object.name, id }];
  for (const name of object.timelineLinks ?? []) {
    const to = object.fields.find((f) => f.name === name)?.options?.to;
    const value = after[name];
    if (to && typeof value === "string") links.push({ object: to, id: value });
  }
  const labels: Record<string, { before: string | null; after: string | null }> = {};
  for (const field of tracked) {
    if (move && field.name === move.field) {
      labels[field.name] = move.labels;
      continue;
    }
    if (field.fieldType !== "relation" || field.options?.many) continue;
    labels[field.name] = {
      before: await titleOf(ctx, field.options?.to, before[field.name]),
      after: await titleOf(ctx, field.options?.to, after[field.name]),
    };
  }
  return {
    ...(move ? { subject: move.subject } : {}),
    links,
    labels,
  };
}

export const recordGet = defineOperation({
  name: "record.get",
  description:
    "Get one record by object and id. For extension objects returns every field; for core " +
    "objects returns only the values of extension fields (use person.get etc. for core fields). " +
    "Read-only.",
  input: z.object({ object: objectName, id: recordId }),
  output: recordSchema,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const object = requireObject(input.object);
    const record = await loadRecord(ctx, object, input.id);
    if (!record) throw new NotFoundError(input.object, input.id);
    return record;
  },
});

/**
 * Queues the writes that update one record (validation, the object's lifecycle and its history,
 * search, audit, the timeline post). Returns false when `values` is empty. record.update and the
 * visibility seam's write helper are a caller's ways in; `updateRecordAsHost` is platform code's.
 */
export async function updateRecord(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  values: Record<string, unknown>,
  options: {
    by?: Mover;
    from?: string | undefined;
    /** A series or closure change moving or cancelling records with places taken: their count. */
    recurringConfirm?: number | undefined;
    /** A series change applies from this local date (`recurring.change { from }`). */
    recurringFrom?: string | undefined;
    /** The record this one moves into, made in this batch (`movedFrom`, ADR 0551). */
    movedInto?: string | undefined;
    /** Platform code only: a value names a record made in this same batch (ADR 0560). */
    checkReferences?: boolean;
    /** Fields the host copies from other records (ADR 0590): their marks are the sources'. */
    copied?: Record<string, MarkSource[]>;
  } = {},
): Promise<boolean> {
  const before = await loadRecord(ctx, object, id);
  if (!before) throw new NotFoundError(object.name, id);
  const by = options.by ?? callerMover(ctx);
  // A move asked for by name (`cancel`) becomes the state the host picks (ADR 0503).
  const asked = await resolveStateRequest(ctx, object, before.values, values, by);
  if (options.from !== undefined) assertMovesFrom(object, before.values, asked, options.from);
  let prepared = await prepareValues(ctx, object, asked, "update", options);
  if (!prepared.length) return false;
  assertRuleValues(object, { ...before.values, ...valuesOf(prepared) });
  await assertSlugsFree(ctx, object, id, valuesOf(prepared));
  assertChoiceRequirements(object, prepared, {
    ...before.values,
    ...Object.fromEntries(prepared.map((p) => [p.field.name, p.value])),
  });
  assertOneOf(object, {
    ...before.values,
    ...Object.fromEntries(prepared.map((p) => [p.field.name, p.value])),
  });
  const outcome = await applyTransition(ctx, object, id, before.values, valuesOf(prepared), {
    by,
  });
  const spent = await spenderWrite(
    ctx,
    object,
    id,
    before.values,
    valuesOf(prepared),
    outcome,
    by,
    {
      movedInto: options.movedInto,
    },
  );
  prepared = withHostValues(prepared, withValues(outcome, spent.values), object);
  // A record a series made, changed by anyone but the host: the fields changed are its own, or
  // the whole record when its time or state changed (ADRs 0500 and 0620).
  const edited = await generatedRecordEdited(
    ctx,
    object,
    id,
    before.values,
    { ...before.values, ...valuesOf(prepared) },
    by,
  );
  if (Object.keys(edited).length) {
    prepared = [
      ...prepared.filter((p) => !Object.hasOwn(edited, p.field.name)),
      ...hostValues(object, edited),
    ];
  }
  // One live record per declared key (ADR 0502); the database's index refuses a race.
  if (object.unique)
    await assertUnique(ctx, object, id, { ...before.values, ...valuesOf(prepared) });
  // Who works a shift, a pattern's person or a profile's account: a rosterer's to say (ADR 0626).
  await assertRosterWrite(
    ctx,
    object,
    before.values,
    { ...before.values, ...valuesOf(prepared) },
    by,
  );
  // A shift (or the profile holding the account of some): never one person on two shifts at once,
  // refused naming the other; a shift's warnings (ADR 0621, 0622).
  await staffedWritten(
    ctx,
    object,
    id,
    before.values,
    { ...before.values, ...valuesOf(prepared) },
    { by },
  );
  await holderWritten(ctx, object, id, before.values, { ...before.values, ...valuesOf(prepared) });
  const own = prepared.filter((p) => p.own);
  if (own.length || !isCoreObject(object.name)) {
    const table = objectTableOf(object.name);
    if (table) {
      ctx.write(
        CompiledQuery.raw(
          `UPDATE ${table} SET ${[...own.map((p) => `${p.column} = ?`), "updated_at = ?", "updated_by = ?"].join(", ")} WHERE id = ? AND deleted_at IS NULL`,
          [...own.map((p) => p.stored), ctx.now, ctx.user.id, id],
        ),
      );
    }
  }
  ctx.write(...sideWrites(id, prepared), ...outcome.history);
  const after = {
    ...before.values,
    ...Object.fromEntries(prepared.map((p) => [p.field.name, p.value])),
  };
  // Places or pool changed: the counter follows, and the database refuses places below what is
  // held and taken, with the numbers (ADR 0431).
  const counter = await counterWrite(
    ctx,
    object,
    id,
    after,
    prepared.map((p) => p.field.name),
  );
  if (counter) ctx.write(counter);
  // A holder's terms follow its record; a spender's move spends or gives back a use (ADR 0493).
  ctx.write(...(await holderWrite(ctx, object, id, before.values, after)));
  ctx.write(...spent.statements);
  // Spenders that read their time or copies from this record follow it (a class rescheduled).
  ctx.write(
    ...(await followSpenders(
      ctx,
      object,
      id,
      after,
      prepared.map((p) => p.field.name),
      by,
    )),
  );
  // Records that follow this one's moves move with it, as the host, in this batch (ADR 0507).
  await moveFollowers(ctx, object, id, outcome.moved?.id);
  // A series' future records follow it; a closure cancels what it covers (ADR 0500).
  await seriesChanged(ctx, object, id, before.values, after, {
    confirm: options.recurringConfirm,
    from: options.recurringFrom,
  });
  await closureWritten(ctx, object, before.values, after, options.recurringConfirm);
  // A published record's old address keeps pointing to it (ADR 0442).
  ctx.write(...(await redirectWrites(ctx, object, id, before.values, after)));
  const timeline = await timelineFor(ctx, object, id, before.values, after, outcome);
  if (object.titleField && prepared.some((p) => p.field.name === object.titleField)) {
    const title = after[object.titleField];
    ctx.write(...searchDoc(object.name, id, title == null ? null : String(title)));
  }
  const warnings = warningsOf(ctx, object.name, id);
  ctx.recordChange({
    object: object.name,
    id,
    action: "update",
    before: snapshot(before),
    after,
    ...(timeline ? { timeline } : {}),
    // ADR 0590: what the caller wrote is theirs; what the host wrote (a host write, or values it
    // added) is the host's, or its sources' when it copied them.
    marks: {
      copied: options.copied ?? {},
      hostFilled: Object.keys(after).filter(
        (f) => (by === "host" || !Object.hasOwn(values, f)) && !options.copied?.[f],
      ),
    },
    ...(warnings.length ? { warnings } : {}),
  });
  return true;
}

/**
 * The state cascade (ADR 0507): when `object`'s record `id` moves into a state an object that
 * follows it names, each of that object's live records pointing at it (in its `from` states)
 * moves to the state given, as the host, in this write's batch, with everything that move does
 * (its place given back, its use returned). More than FOLLOWERS_MAX refuses the move.
 */
async function moveFollowers(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  to: string | undefined,
): Promise<void> {
  if (!to) return;
  const following = followersOf(object.name).filter((f) => Object.hasOwn(f.when, to));
  if (!following.length) return;
  // The record's live claims, read before its followers (ADR 0550): a follower made after this
  // read and before the batch commits (a booking of a class being cancelled) would be missed by
  // the cascade, so the batch checks at commit that the record's counter is what this read, less
  // what the cascade gives back, leaves. Read first, so one made between the two reads is moved.
  const claims =
    object.capacity && !ctx.simulation
      ? await ctx.db
          .selectFrom("core_capacity_claim")
          .select(["id", "for_type", "for_id", "quantity"])
          .where("object_type", "=", object.name)
          .where("record_id", "=", id)
          .where("state", "in", ["held", "confirmed"])
          .execute()
      : null;
  const givenBack = new Set<string>();
  for (const follower of following) {
    const target = follower.when[to] as string;
    const ids = await followerIds(ctx, follower, id);
    if (ids.length > FOLLOWERS_MAX) {
      throw new ConflictError(
        `${object.label} has more than ${FOLLOWERS_MAX} ${(follower.object.plural ?? "records").toLowerCase()} to move with it`,
        { rule: "follows_too_many", object: follower.object.name },
      );
    }
    const fc = follower.object.claims;
    if (claims && fc?.object === object.name && fc.on === follower.relation) {
      const keeps = fc.held.includes(target) || fc.confirmed.includes(target);
      const moving = new Set(ids);
      // A follower moved out of its places gives back each claim it holds.
      if (!keeps) {
        for (const c of claims) {
          if (c.for_type === follower.object.name && moving.has(c.for_id)) givenBack.add(c.id);
        }
      }
      // Its waitlist's holds go back with the last waiter (ADR 0520): when waiters move too.
      const waiting = fc.waitlist?.state;
      if (waiting && follower.from.includes(waiting) && ids.length) {
        const waiters = await followerIds(ctx, { ...follower, from: [waiting] }, id);
        if (waiters.length) {
          for (const c of claims) {
            if (c.for_type === WAITLIST_FOR && c.for_id === follower.object.name) {
              givenBack.add(c.id);
            }
          }
        }
      }
    }
    for (const child of ids) {
      await updateRecord(
        ctx,
        follower.object,
        child,
        { [follower.stateField]: target },
        {
          by: "host",
        },
      );
    }
  }
  if (claims) {
    const expected = claims
      .filter((c) => !givenBack.has(c.id))
      .reduce((sum, c) => sum + Number(c.quantity), 0);
    ctx.write(guardStatement("claimed", object.name, id, expected));
  }
}

/**
 * `record.update { from }` (ADR 0437): the write must move the record out of `from`, and the
 * record must still be there when it is read. Refused as a conflict when it has left it. The
 * move itself is then made from this read or not at all (records/transitions.ts), so of two
 * writes that both expect `from`, exactly one moves the record and the other is refused, however
 * close together they are: what checking a ticket in needs.
 */
function assertMovesFrom(
  object: ObjectDefinition,
  stored: Record<string, unknown>,
  values: Record<string, unknown>,
  from: string,
): void {
  const field = object.states?.field ?? object.stages?.field;
  if (!field) {
    throw new ValidationError(`${object.label} has no states or stages, so "from" means nothing`, {
      field: "from",
    });
  }
  const label = object.fields.find((f) => f.name === field)?.label ?? field;
  const to = values[field];
  if (to === undefined || to === null || String(to) === from) {
    throw new ValidationError(`With "from", the write must move ${label} to another value`, {
      field,
    });
  }
  const current = stored[field] ?? null;
  if (current === null || String(current) !== from) {
    throw new ConflictError(
      `${object.label} is no longer ${from}: its ${label.toLowerCase()} is ${String(current ?? "empty")}. Nothing was changed.`,
      { reason: "not_in_position", field, from, current },
    );
  }
}

// The seam's write helper (visibility/writes.ts) changes extension records with this code.
setRecordWriter({ create: createRecord, update: updateRecord });
setAllowanceRecordUpdate(updateRecord);

/** Moves a record to Trash as the host (a series' record no longer in its rule, ADR 0500). */
async function trashRecordAsHost(ctx: HandlerContext, object: ObjectDefinition, id: string) {
  const before = await loadRecord(ctx, object, id);
  if (!before) return;
  // Never a record with places held or taken on it, nor a claimant holding one: refused here, and
  // at commit by the guards (a booking made after this read fails the batch).
  if ((await claimedOn(ctx, object, id)) > 0) {
    throw new ConflictError(`${object.label} has places taken and cannot be removed`, {
      rule: "capacity",
      object: object.name,
      record: id,
    });
  }
  await assertNoLiveClaim(ctx, object, id);
  if (object.capacity) ctx.write(guardStatement("claimed", object.name, id, 0));
  if (object.claims) ctx.write(guardStatement("claimant", object.name, id, 0));
  // A shift in the Trash claims nobody's time (its trigger drops the claim, ADR 0621).
  await staffedReleased(ctx, object, id);
  const table = objectTableOf(object.name) as string;
  ctx.write(
    CompiledQuery.raw(`UPDATE ${table} SET deleted_at = ?, deleted_by = ? WHERE id = ?`, [
      ctx.now,
      ctx.user.id,
      id,
    ]),
    CompiledQuery.raw("DELETE FROM core_search_docs WHERE object_type = ? AND record_id = ?", [
      object.name,
      id,
    ]),
  );
  ctx.recordChange({ object: object.name, id, action: "delete", before: snapshot(before) });
}

// The recurring behaviour makes, moves and removes a series' records with this code.
setRecurringWriter({
  load: async (ctx, object, id) => (await loadRecord(ctx, object, id))?.values ?? null,
  create: (ctx, object, values, options) => createRecord(ctx, object, values, options),
  update: (ctx, object, id, values, options) => updateRecord(ctx, object, id, values, options),
  remove: trashRecordAsHost,
});

export const recordUpdate = defineOperation({
  name: "record.update",
  description:
    "Update field values of a record. On extension objects any writable field; on core objects " +
    "only extension fields (named `<extension>.<field>`). Pass null to clear a value. Changes " +
    "are recorded in the record's history; fields tracked on the timeline post a system " +
    "activity. Returns the stored record.",
  input: z.object({
    object: objectName,
    id: recordId,
    values: valuesSchema,
    from: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "Only move the record if it is still in this state (or stage id), and move it out of " +
          "it: for a write two people may make at once, such as checking a ticket in. Refused " +
          "as a conflict (reason not_in_position or moved_meanwhile) when the record has left it.",
      ),
  }),
  output: recordWriteSchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const object = requireObject(input.object);
    await updateRecord(ctx, object, input.id, input.values, { from: input.from });
    const warnings = warningsOf(ctx, object.name, input.id);
    return ctx.afterCommit(() => withWarnings(ctx, object, input.id, warnings));
  },
});

/**
 * Platform code's way to write a record as the host (ADR 0425): the only way to make a move a
 * `states` declaration marks `host` (a payment confirmed, an order expired), and to set the
 * read-only fields that go with it. It queues the writes on the calling operation's batch.
 *
 * It is a function, not an operation: nothing a person, an MCP client, an extension or an import
 * can send reaches it, because they can only call operations, and no operation passes its input
 * here. Call it from a handler that has itself established the fact (a verified webhook).
 */
export async function updateRecordAsHost(
  ctx: HandlerContext,
  objectName: string,
  id: string,
  values: Record<string, unknown>,
): Promise<void> {
  const object = requireObject(objectName);
  await updateRecord(ctx, object, id, values, { by: "host" });
}

/** Whether an object is what some sellable object's paid line grants (ADR 0435). */
function isGranted(object: ObjectDefinition): boolean {
  return listObjects().some((o) => o.sellable?.grants?.object === object.name);
}

/** Whether a holder record was granted by a paid order line or a subscription (ADRs 0435, 0510). */
async function grantedBy(ctx: HandlerContext, object: string, id: string): Promise<boolean> {
  const [order, subscription] = await Promise.all([
    ctx.db
      .selectFrom("core_order_grant")
      .select("record_id")
      .where("object_type", "=", object)
      .where("record_id", "=", id)
      .executeTakeFirst(),
    ctx.db
      .selectFrom("core_subscription_grant")
      .select("record_id")
      .where("object_type", "=", object)
      .where("record_id", "=", id)
      .executeTakeFirst(),
  ]);
  return Boolean(order ?? subscription);
}

/**
 * A holder's Trash rule (ADR 0513): a holder that can be spent (its state is live) cannot go to
 * the Trash, and neither can a granted one that has not reached a final state (a membership its
 * subscription still moves, a pass not void): void or end it first. Its grant, not the Trash,
 * decides what it gives. `restoring`: a granted holder in the Trash that is not final (put there
 * before this rule) is not restored, since its grant may no longer give what it held.
 */
async function assertHolderTrashRule(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  state: unknown,
  restoring: boolean,
): Promise<void> {
  const def = object.allowance;
  if (def?.kind !== "holder" || !object.states) return;
  const finals = new Set(object.states.moves.filter((m) => m.final).map((m) => m.to));
  const final = typeof state === "string" && finals.has(state);
  const live = typeof state === "string" && (def.live ?? []).includes(state);
  const granted = !final && (await grantedBy(ctx, object.name, id));
  if (!restoring && (live || granted)) {
    throw new ValidationError(
      `${object.label} can still be spent or is kept by what granted it: void or end it before deleting it`,
      { rule: "allowance", reason: "holder_live", object: object.name, record: id },
    );
  }
  if (restoring && granted) {
    throw new ValidationError(
      `${object.label} was granted and is not ended or void: what granted it decides its state, so it is not restored`,
      { rule: "allowance", reason: "holder_granted", object: object.name, record: id },
    );
  }
}

export const recordDelete = defineOperation({
  name: "record.delete",
  description:
    `Move a record of an extension object to Trash (soft delete). It can be restored with ` +
    `record.restore for ${TRASH_RETENTION_DAYS} days. Returns the id and the restore deadline.`,
  input: z.object({ object: objectName, id: recordId }),
  output: z.object({ id: z.string(), restorableUntil: z.string() }),
  permission: "records:write",
  risk: "destructive",
  async handler(input, ctx) {
    const object = requireExtensionObject(input.object);
    const before = await loadRecord(ctx, object, input.id);
    if (!before) throw new NotFoundError(input.object, input.id);
    // Places people have paid for keep their record out of Trash (ADR 0431), and so does a use
    // a spender holds (ADR 0493).
    await assertNoConfirmedClaims(ctx, object, input.id);
    await assertSpenderDeletable(ctx, object, input.id);
    // A holder that can be spent, or that its grant still moves, is voided or ended first.
    if (object.states) {
      await assertHolderTrashRule(ctx, object, input.id, before.values[object.states.field], false);
    }
    // A claimant holding a place gives it back by moving out of its state, not by Trash.
    await assertNoLiveClaim(ctx, object, input.id);
    // A series in Trash makes nothing more; its future records go as an ended series' do.
    await seriesChanged(ctx, object, input.id, before.values, before.values, { trashed: true });
    // The read above gives the message; this makes it hold at commit (a claim made meanwhile).
    if (object.claims) ctx.write(guardStatement("claimant", object.name, input.id, 0));
    // A shift in the Trash claims nobody's time (its trigger drops the claim, ADR 0621); a coach
    // profile on shifts not yet ended is not trashed while it still names their person.
    await staffedReleased(ctx, object, input.id);
    await assertHolderTrashable(ctx, object, input.id);
    const table = objectTableOf(object.name) as string;
    ctx.write(
      CompiledQuery.raw(`UPDATE ${table} SET deleted_at = ?, deleted_by = ? WHERE id = ?`, [
        ctx.now,
        ctx.user.id,
        input.id,
      ]),
      CompiledQuery.raw("DELETE FROM core_search_docs WHERE object_type = ? AND record_id = ?", [
        object.name,
        input.id,
      ]),
      // A holder in the Trash cannot be spent: its terms follow the record (ADR 0493).
      ...(await holderTrash(ctx, object, input.id)),
    );
    ctx.recordChange({
      object: object.name,
      id: input.id,
      action: "delete",
      before: snapshot(before),
    });
    return { id: input.id, restorableUntil: restorableUntil(ctx.now) };
  },
});

export const recordRestore = defineOperation({
  name: "record.restore",
  description:
    "Restore a record of an extension object from Trash (within 30 days of its deletion). " +
    "Returns the restored record.",
  input: z.object({ object: objectName, id: recordId }),
  output: recordSchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const object = requireExtensionObject(input.object);
    const table = objectTableOf(object.name) as string;
    const row = await sql<{ deleted_at: string | null }>`
      SELECT deleted_at FROM ${visibleTable(ctx, object)} WHERE id = ${input.id}
    `.execute(ctx.db);
    const deletedAt = row.rows[0]?.deleted_at;
    if (deletedAt === undefined) throw new NotFoundError(input.object, input.id);
    if (deletedAt === null) throw new ValidationError(`${input.id} is not in Trash`);
    // Its slug may have been taken while it was in the Trash (stage 28, ADR 0444).
    await assertRestorable(ctx, object, input.id);
    // Back with someone on it (a shift's person, a series' regular person): a rosterer's (ADR 0626).
    await assertRosterRestore(ctx, object, input.id);
    // A shift's time may have been given to its person meanwhile (ADR 0621): refused naming it.
    await staffedRestored(ctx, object, input.id);
    // A granted holder comes back only in a final state (ADR 0513).
    const stateColumn = object.states
      ? fieldStorage(object.name, object.states.field)?.column
      : undefined;
    if (stateColumn) {
      const stored = await sql<Record<string, unknown>>`
        SELECT * FROM ${visibleTable(ctx, object)} WHERE id = ${input.id}
      `.execute(ctx.db);
      await assertHolderTrashRule(ctx, object, input.id, stored.rows[0]?.[stateColumn], true);
    }
    ctx.write(
      CompiledQuery.raw(`UPDATE ${table} SET deleted_at = NULL, deleted_by = NULL WHERE id = ?`, [
        input.id,
      ]),
      ...(await holderTrash(ctx, object, input.id)),
    );
    ctx.recordChange({ object: object.name, id: input.id, action: "restore", diff: {} });
    // A series back from Trash is due now, so its records are made again (ADR 0500).
    seriesCreated(ctx, object, input.id);
    return ctx.afterCommit(async () => {
      const record = (await loadRecord(ctx, object, input.id)) as RecordOutput;
      await ctx.db
        .insertInto("core_search_docs")
        .values({
          object_type: object.name,
          record_id: input.id,
          title: record.title ?? "",
          body: "",
        })
        .onConflict((oc) => oc.columns(["object_type", "record_id"]).doNothing())
        .execute();
      return record;
    });
  },
});

export const recordList = defineOperation({
  name: "record.list",
  description:
    "List records of an extension object (or a core object's extension fields) with the same " +
    "filter JSON, sort and cursor as other list operations. Every field in schema.objects is " +
    "filterable, including formula fields; multi-valued fields match any value. Read-only.",
  input: listInputSchema.extend({ object: objectName }),
  output: pageSchema(recordSchema),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const object = requireObject(input.object);
    const page = await runListQuery<{ id: string }>(ctx, object, input);
    const items = page.rows.map((row) => {
      const record = fromRow(object, row as Record<string, unknown>);
      if (input.fields) {
        record.values = Object.fromEntries(
          Object.entries(record.values).filter(([key]) => input.fields?.includes(key)),
        );
        // Core fields named in `fields` come back too (board, calendar and gallery views of
        // core objects read them here), as their view columns' values.
        for (const name of input.fields) {
          const field = object.fields.find((f) => f.name === name);
          if (field && !field.extension && field.column && !(name in record.values)) {
            record.values[name] = (row as Record<string, unknown>)[field.column] ?? null;
          }
        }
      }
      return record;
    });
    return { items, nextCursor: page.nextCursor };
  },
});

const fieldInfoSchema = z.object({
  name: z.string(),
  label: z.string(),
  type: z.string(),
  fieldType: z.string().nullable(),
  enumValues: z.array(z.string()).nullable(),
  multi: z.boolean(),
  filterable: z.boolean(),
  sortable: z.boolean(),
  readOnly: z.boolean(),
  required: z.boolean(),
  track: z.boolean(),
  extension: z.string().nullable(),
  description: z.string().nullable(),
  options: z.record(z.string(), z.unknown()).nullable(),
});
export type FieldInfo = z.infer<typeof fieldInfoSchema>;

export const objectInfoSchema = z.object({
  name: z.string(),
  label: z.string(),
  plural: z.string().nullable(),
  icon: z.string().nullable(),
  titleField: z.string().nullable(),
  extension: z.string().nullable(),
  description: z.string().nullable(),
  /** The rec_* view, for query.sql. */
  view: z.string(),
  fields: z.array(fieldInfoSchema),
  /** Where the UI lists it: main navigation, Settings, or nowhere (ADR 0100). */
  navigation: z.enum(["main", "settings", "none"]),
  /** The stage behaviour, when it has one (ADR 0100). */
  stages: z.record(z.string(), z.unknown()).nullable(),
  /** The capacity behaviour, when it has one (ADR 0430). */
  capacity: z
    .object({
      places: z.string(),
      pool: z.object({ field: z.string(), object: z.string() }).nullable(),
      show: z.enum(["exact", "low", "availability"]),
      lowAt: z.number().nullable(),
      releaseOnRefund: z.boolean(),
    })
    .nullable(),
  /** The sellable behaviour, when it has one (ADR 0435): its price, rules and what it grants. */
  sellable: z.record(z.string(), z.unknown()).nullable(),
  /** The state machine, when it has one (ADR 0425). */
  states: z.record(z.string(), z.unknown()).nullable(),
  /**
   * Versions of its content (ADRs 0446, 0441), when it has them: the content fields, its slug
   * field and date field, and whether the public reads it (ADR 0442: then it has previews).
   */
  publishable: z
    .object({
      content: z.array(z.string()),
      slug: z.string().nullable(),
      date: z.string().nullable(),
      public: z.boolean(),
    })
    .nullable(),
  timelineLinks: z.array(z.string()),
  /** The owner field assignment rules set (ADR 0246), when the object has one. */
  ownerField: z.string().nullable(),
  /** Sidebar order among extension objects (lower first). */
  navigationOrder: z.number(),
  /** The relations an untitled record is named after (ADR 0246), when it has any. */
  titleDefaultFrom: z.array(z.string()),
});
export type ObjectInfo = z.infer<typeof objectInfoSchema>;

export function objectInfo(object: ObjectDefinition): ObjectInfo {
  return {
    name: object.name,
    label: object.label,
    plural: object.plural ?? null,
    icon: object.icon ?? null,
    titleField: object.titleField ?? null,
    extension: object.extension ?? null,
    description: object.description ?? null,
    view: object.source,
    navigation: object.navigation ?? "main",
    stages: object.stages ? { ...object.stages } : null,
    capacity: object.capacity
      ? {
          places: object.capacity.places,
          pool: object.capacity.pool ? { ...object.capacity.pool } : null,
          show: object.capacity.show,
          lowAt: object.capacity.lowAt ?? null,
          releaseOnRefund: object.capacity.releaseOnRefund,
        }
      : null,
    sellable: object.sellable ? { ...object.sellable } : null,
    states: object.states ? { ...object.states } : null,
    publishable: object.publishable
      ? {
          content: [...object.publishable.content],
          slug: object.publishable.slug ?? null,
          date: object.publishable.date ?? null,
          public: Boolean(object.public),
        }
      : null,
    timelineLinks: [...(object.timelineLinks ?? [])],
    ownerField: object.ownerField ?? null,
    navigationOrder: object.navigationOrder ?? 100,
    titleDefaultFrom: [...(object.titleDefault?.from ?? [])],
    fields: object.fields.map((f) => ({
      name: f.name,
      label: f.label,
      type: f.type,
      fieldType: f.fieldType ?? null,
      enumValues: f.enumValues ? [...f.enumValues] : null,
      multi: Boolean(f.related),
      filterable: f.filterable,
      sortable: f.sortable,
      readOnly: Boolean(f.readOnly),
      required: Boolean(f.required),
      track: f.track === "timeline",
      extension: f.extension ?? null,
      description: f.description ?? null,
      options: f.options ? { ...f.options } : null,
    })),
  };
}

export const schemaObjects = defineOperation({
  name: "schema.objects",
  description:
    "List every object in the field registry (core objects and extension objects) with their " +
    "fields: name, label, type, filterability, sortability, whether computed, and type options " +
    "(select choices, relation target, formula expression). Use it before record.* and list " +
    "filters. Read-only.",
  input: z.object({ object: objectName.optional() }),
  output: z.object({ objects: z.array(objectInfoSchema) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input) {
    const objects = input.object ? [requireObject(input.object)] : listObjects();
    return { objects: objects.map(objectInfo) };
  },
});

export { viewColumnOf };

export const recordOperations = [
  recordCreate,
  recordGet,
  recordUpdate,
  recordDelete,
  recordRestore,
  recordList,
  schemaObjects,
] as const;
