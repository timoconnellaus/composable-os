// Writes at the visibility seam (ADR 0402, ADR 0412). A caller outside the org changes a record
// only when the seam would show it to them, and only in the fields its object lists as writable.
// The pipeline runs this on every change a customer's or the public's call recorded, before
// anything is committed, so an operation's handler never checks whose record it is.
import { diffRecords } from "../diff.ts";
import { ForbiddenError, NotFoundError, OperationError, ValidationError } from "../errors.ts";
import { getObject, isCoreObject } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext, RecordChange } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { unknownObject } from "./customer.ts";
import { type AnyRow, type Reader, type Scope, scopeOf, visibleSource } from "./index.ts";

/** Fields the host sets on a new record. A create may carry them; no one chooses them. */
const SET_BY_HOST = new Set(["id", "createdAt", "updatedAt", "createdBy"]);

/**
 * Refuses `changes` unless the caller may make every one of them. Staff may (their permissions
 * and the gate decide). For a customer, each change must be a create or an update of a record
 * whose customer is the caller's own Person, touching only writable fields; the customer field is
 * set on create to the caller and never changed after. The public change nothing.
 *
 * `checked` holds the changes the seam's own write helpers recorded. Their fields were checked
 * when the caller named them, and what the host then set beside them (a stage's status, an
 * assigned owner) is the host's doing, so for those only the record itself is checked again.
 *
 * `byHost` holds the changes a `hostInternal` core operation recorded with `recordHostChange`
 * (ADR 0428): the host's own writes, made by reviewed core code with the caller's input already
 * judged (an order the host priced, the Person a guest's order is placed for). They are not the
 * caller's to be checked against the caller's scope, so they pass. What such an operation
 * records with `recordChange` is checked like any other. No extension tool is ever
 * `hostInternal`.
 *
 * A record the caller may not see is reported as a record that is not there, and a field they
 * may not write as a field that does not exist.
 */
export async function assertVisibleWrites(
  ctx: Reader,
  all: readonly RecordChange[],
  checked: ReadonlySet<RecordChange> = new Set(),
  byHost: ReadonlySet<RecordChange> = new Set(),
): Promise<void> {
  if (ctx.principal.kind === "staff" || !all.length) return;
  const changes = byHost.size ? all.filter((change) => !byHost.has(change)) : all;
  if (!changes.length) return;
  if (ctx.principal.kind !== "customer") {
    throw new ForbiddenError("This call cannot change records");
  }
  const personId = ctx.principal.personId;
  const existing = new Map<string, string[]>();
  for (const change of changes) {
    const object = getObject(change.object);
    if (!object) throw unknownObject(change.object);
    const scope: Scope = scopeOf(ctx.principal, object);
    if (scope.kind !== "customer") throw unknownObject(change.object);
    if (change.action !== "create" && change.action !== "update") {
      throw new ForbiddenError(`A customer cannot ${change.action} a ${object.name}`);
    }
    const diff = change.diff ?? diffRecords(change.before, change.after);
    const owner = scope.declaration.field;
    for (const [name, values] of Object.entries(diff)) {
      if (name !== owner && checked.has(change)) continue;
      if (name === owner) {
        // Whose record it is: the caller's on create, and never changed after.
        if (change.action !== "create") throw new NotFoundError(object.name, change.id);
        if (values.after !== personId) {
          throw new ValidationError(`A new ${object.name} must belong to its caller`);
        }
        continue;
      }
      if (scope.writable.has(name)) continue;
      if (change.action === "create" && SET_BY_HOST.has(name)) continue;
      // A field they can read but not write is named. Any other is a field that does not exist.
      if (scope.fields.some((field) => field.name === name)) {
        throw new ValidationError(`${object.name}.${name} cannot be changed`, { field: name });
      }
      throw new ValidationError(`Unknown field "${name}" on ${object.name}`, { field: name });
    }
    if (change.action === "create") {
      if (owner !== "id" && diff[owner]?.after !== personId) {
        throw new ValidationError(`A new ${object.name} must belong to its caller`);
      }
      // A person is their own customer: a customer never creates one.
      if (owner === "id") throw new ForbiddenError(`A customer cannot create a ${object.name}`);
    } else {
      existing.set(object.name, [...(existing.get(object.name) ?? []), change.id]);
    }
  }
  // Every record changed must be one the caller can see: one read per object, through door 1.
  for (const [name, ids] of existing) {
    const object = getObject(name);
    if (!object) throw unknownObject(name);
    // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
    const rows = (await (ctx.db as any)
      .selectFrom(visibleSource(ctx, object))
      .select("id")
      .where("id", "in", jsonList([...new Set(ids)]))
      .execute()) as AnyRow[];
    const mine = new Set(rows.map((row) => String(row.id)));
    const missing = ids.find((id) => !mine.has(id));
    if (missing) throw new NotFoundError(name, missing);
  }
}

// --- The write helpers a handler outside the org is given ---------------------------------------

/** The code that writes a record of an extension object: record.create's and record.update's. */
export interface RecordWriter {
  create(
    ctx: HandlerContext,
    object: ObjectDefinition,
    values: Record<string, unknown>,
  ): Promise<string>;
  update(
    ctx: HandlerContext,
    object: ObjectDefinition,
    id: string,
    values: Record<string, unknown>,
  ): Promise<boolean>;
}

let recordWriter: RecordWriter | null = null;
const coreWriters = new Map<string, Pick<RecordWriter, "update">>();

/** Set by operations/record.ts when it loads: the seam writes with the code staff writes use. */
export function setRecordWriter(writer: RecordWriter): void {
  recordWriter = writer;
}

/** A core object's own update code (a Person's, for `me.update`). Core objects have no create here. */
export function setCoreWriter(object: string, writer: Pick<RecordWriter, "update">): void {
  coreWriters.set(object, writer);
}

/** Who is writing, and with what the host writes for them. */
export interface SeamWriter {
  /** The caller. */
  readonly reader: Reader;
  /**
   * A handler context the record code can run in: the real database and write queue, never
   * handed to the operation's own handler.
   */
  readonly host: HandlerContext;
  /** Fields a pack's tool may set beyond the object's `customer.write`, by object (ADR 0414). */
  readonly widened?: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  /** Called with each change the helpers record, so the final check knows it was checked here. */
  readonly mark: (change: RecordChange) => void;
}

function customerScopeFor(writer: SeamWriter, name: string) {
  const object = getObject(name);
  if (!object) throw unknownObject(name);
  const scope: Scope = scopeOf(writer.reader.principal, object);
  if (scope.kind !== "customer") throw unknownObject(name);
  return { object, scope };
}

function assertSettable(
  writer: SeamWriter,
  object: ObjectDefinition,
  scope: Extract<Scope, { kind: "customer" }>,
  values: Record<string, unknown>,
): void {
  const widened = writer.widened?.get(object.name);
  for (const name of Object.keys(values)) {
    // Whose record it is, and its id, are never a caller's or a tool's to set.
    const reserved = name === scope.declaration.field || name === "id";
    if (!reserved && (scope.writable.has(name) || widened?.has(name))) continue;
    if (!reserved && scope.fields.some((field) => field.name === name)) {
      throw new ValidationError(`${object.name}.${name} cannot be changed`, { field: name });
    }
    throw new ValidationError(`Unknown field "${name}" on ${object.name}`, { field: name });
  }
}

/** Runs `write` and marks every change it recorded as one the seam checked. */
async function recording<T>(
  writer: SeamWriter,
  write: (host: HandlerContext) => Promise<T>,
): Promise<T> {
  // A view of the host context with its own `recordChange`. Not a spread: the host context has
  // members that throw when read (it has no staff actor), and a spread would read them all.
  const host = Object.create(writer.host, {
    recordChange: {
      value: (change: RecordChange) => {
        writer.mark(change);
        writer.host.recordChange(change);
      },
    },
  }) as HandlerContext;
  return write(host);
}

/**
 * Creates a record of `object` for the caller: the customer field is the caller, whatever was
 * asked, and the other values must be fields the caller (or the tool calling for them) may set.
 */
export async function createVisible(
  writer: SeamWriter,
  name: string,
  values: Record<string, unknown>,
): Promise<{ id: string }> {
  const { object, scope } = customerScopeFor(writer, name);
  assertSettable(writer, object, scope, values);
  if (isCoreObject(object.name) || !recordWriter) {
    throw new ForbiddenError(`A customer cannot create a ${object.name}`);
  }
  const owned = { ...values, [scope.declaration.field]: scope.personId };
  const create = recordWriter.create;
  return { id: await recording(writer, (host) => create(host, object, owned)) };
}

/** Changes one of the caller's own records, in fields they (or the tool) may set. */
export async function updateVisible(
  writer: SeamWriter,
  name: string,
  id: string,
  values: Record<string, unknown>,
): Promise<void> {
  const { object, scope } = customerScopeFor(writer, name);
  assertSettable(writer, object, scope, values);
  // The record must be one the seam shows the caller: otherwise it is not there.
  // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
  const row = await (writer.reader.db as any)
    .selectFrom(visibleSource(writer.reader, object))
    .select("id")
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new NotFoundError(object.name, id);
  const update =
    coreWriters.get(object.name)?.update ??
    (isCoreObject(object.name) ? null : recordWriter?.update);
  if (!update) throw new OperationError("internal", `No writer for ${object.name}`);
  await recording(writer, (host) => update(host, object, id, values));
}
