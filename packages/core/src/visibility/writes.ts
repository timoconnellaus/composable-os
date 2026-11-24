// Writes at the visibility seam (ADR 0402, ADR 0412). A caller outside the org changes a record
// only when the seam would show it to them as their own (or, where an object lets guardians write,
// a live dependant's: ADR 0540), and only in the fields its object lists as writable.
// The pipeline runs this on every change a customer's or the public's call recorded, before
// anything is committed, so an operation's handler never checks whose record it is.
import type { CompiledQuery } from "kysely";
import { diffRecords } from "../diff.ts";
import { ForbiddenError, NotFoundError, OperationError, ValidationError } from "../errors.ts";
import { getObject, isCoreObject } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext, RecordChange } from "../operation.ts";
import { viewColumnOf } from "../records/columns.ts";
import { jsonList } from "../records/common.ts";
import { holdsAccess } from "./access.ts";
import { unknownObject } from "./customer.ts";
import { isLiveDependant, linkGuardStatement } from "./guardians.ts";
import {
  type AnyRow,
  ownedSource,
  type Reader,
  type Scope,
  scopeOf,
  visibleSource,
} from "./index.ts";

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
  /**
   * Adds a statement to the call's batch: the link's guard for every change to a dependant's
   * record (ADR 0540), so one recorded outside the seam's helpers is held to the live link at
   * commit too. Without it, such a change is refused.
   */
  guard?: (statement: CompiledQuery) => void,
): Promise<void> {
  if (ctx.principal.kind === "staff" || !all.length) return;
  const changes = byHost.size ? all.filter((change) => !byHost.has(change)) : all;
  if (!changes.length) return;
  if (ctx.principal.kind !== "customer") {
    throw new ForbiddenError("This call cannot change records");
  }
  const personId = ctx.principal.personId;
  const existing = new Map<string, string[]>();
  const guarded = new Set<string>();
  /** Holds a write for a dependant to the live link at commit (migration 0650's guard). */
  const holdToLink = (dependantId: string): boolean => {
    if (!guard) return false;
    if (!guarded.has(dependantId)) {
      guarded.add(dependantId);
      guard(linkGuardStatement(personId, dependantId));
    }
    return true;
  };
  /** A new record's Person: the caller, or a live dependant where guardians write (ADR 0540). */
  const mayOwn = async (scope: Extract<Scope, { kind: "customer" }>, owner: unknown) =>
    owner === personId ||
    (scope.dependantsWrite &&
      typeof owner === "string" &&
      (await isLiveDependant(ctx.db, personId, owner)) &&
      holdToLink(owner));
  for (const change of changes) {
    const object = getObject(change.object);
    if (!object) throw unknownObject(change.object);
    const scope: Scope = scopeOf(ctx.principal, object);
    if (scope.kind !== "customer") throw unknownObject(change.object);
    // A record of an object that lets its customer remove their own (`customer.delete`): only
    // whose it is matters, checked with the updates below.
    if (change.action === "delete" && object.customer?.delete) {
      existing.set(object.name, [...(existing.get(object.name) ?? []), change.id]);
      continue;
    }
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
        if (!(await mayOwn(scope, values.after))) {
          throw new ValidationError(`A new ${object.name} must belong to its caller`);
        }
        continue;
      }
      // Set when the record is made, never after (ADR 0507).
      if (change.action !== "create" && object.customer?.createOnly?.includes(name)) {
        throw new ValidationError(`${object.name}.${name} is set only when it is made`, {
          field: name,
        });
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
      if (owner !== "id" && !(await mayOwn(scope, diff[owner]?.after))) {
        throw new ValidationError(`A new ${object.name} must belong to its caller`);
      }
      // A person is their own customer: a customer never creates one.
      if (owner === "id") throw new ForbiddenError(`A customer cannot create a ${object.name}`);
    } else {
      existing.set(object.name, [...(existing.get(object.name) ?? []), change.id]);
    }
  }
  // Every record changed must be the caller's own: one read per object. A record shared with
  // every signed-in customer (ADR 0447) is read, never changed, by one.
  for (const [name, ids] of existing) {
    const object = getObject(name);
    if (!object) throw unknownObject(name);
    // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
    const rows = (await (ctx.db as any)
      .selectFrom(ownedSource(ctx, object))
      .select(["id", "owner"])
      .where("id", "in", jsonList([...new Set(ids)]))
      .execute()) as AnyRow[];
    const mine = new Set(rows.map((row) => String(row.id)));
    const missing = ids.find((id) => !mine.has(id));
    if (missing) throw new NotFoundError(name, missing);
    // A dependant's record (ADR 0540): held to the live link at commit, or refused.
    for (const row of rows) {
      const owner = row.owner === null || row.owner === undefined ? null : String(row.owner);
      if (owner !== null && owner !== personId && !holdToLink(owner)) {
        throw new NotFoundError(name, String(row.id));
      }
    }
  }
}

// --- The write helpers a handler outside the org is given ---------------------------------------

/** The code that writes a record of an extension object: record.create's and record.update's. */
export interface RecordWriter {
  create(
    ctx: HandlerContext,
    object: ObjectDefinition,
    values: Record<string, unknown>,
    options?: { seamSet?: ReadonlySet<string> },
  ): Promise<string>;
  update(
    ctx: HandlerContext,
    object: ObjectDefinition,
    id: string,
    values: Record<string, unknown>,
    options?: { from?: string | undefined },
  ): Promise<boolean>;
  /** Moves a record to Trash with every rule `record.delete` holds. */
  delete(ctx: HandlerContext, object: ObjectDefinition, id: string): Promise<void>;
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
    // Whose record it is, who made it (ADR 0540) and its id are never a caller's or a tool's to
    // set.
    const reserved =
      name === scope.declaration.field ||
      name === "id" ||
      name === scope.declaration.guardians?.madeBy;
    if (!reserved && (scope.writable.has(name) || widened?.has(name))) continue;
    if (!reserved && scope.fields.some((field) => field.name === name)) {
      throw new ValidationError(`${object.name}.${name} cannot be changed`, { field: name });
    }
    throw new ValidationError(`Unknown field "${name}" on ${object.name}`, { field: name });
  }
}

/**
 * A customer's write may point a relation only at records the customer can see (ADR 0447): a
 * log at their own session, or at a class's session shared with them, never at another
 * customer's. The record code checks a relation against the host's org-wide reader, which sees
 * everything; this reads through the caller's own. One read per relation field set; an id they
 * cannot see is answered as one that does not exist.
 */
async function assertRelationsVisible(
  reader: Reader,
  object: ObjectDefinition,
  values: Record<string, unknown>,
): Promise<void> {
  for (const [name, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue;
    const field = object.fields.find((f) => f.name === name);
    const to = field?.fieldType === "relation" ? field.options?.to : undefined;
    if (!to) continue;
    const target = getObject(to);
    const ids = [...new Set(Array.isArray(value) ? value.map(String) : [String(value)])];
    const missing = (wanted: string) => new NotFoundError(to, wanted);
    if (!target) throw missing(ids[0] ?? "");
    if (scopeOf(reader.principal, target).kind === "none") throw missing(ids[0] ?? "");
    // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
    const rows = (await (reader.db as any)
      .selectFrom(visibleSource(reader, target))
      .select("id")
      .where("id", "in", jsonList(ids))
      .execute()) as AnyRow[];
    const seen = new Set(rows.map((row) => String(row.id)));
    const unseen = ids.find((id) => !seen.has(id));
    if (unseen !== undefined) throw missing(unseen);
  }
}

/**
 * A write that needs access to what it points to (stage 42, ADR 0478): for each relation the
 * object's customer declaration lists in `requireAccess`, the record it points to after the write
 * (the value set, or the row's own on an update) must be one the caller holds access to, by the
 * seam's one question. Otherwise the write is refused as a record that is not there.
 */
async function assertAccessRequired(
  reader: Reader,
  object: ObjectDefinition,
  values: Record<string, unknown>,
  existing: AnyRow | null,
): Promise<void> {
  const required = object.customer?.requireAccess ?? [];
  for (const name of required) {
    const field = object.fields.find((f) => f.name === name);
    const to = field?.options?.to;
    const target = to ? getObject(to) : undefined;
    const pointed = Object.hasOwn(values, name) ? values[name] : existing?.[name];
    const id = pointed === null || pointed === undefined ? null : String(pointed);
    if (!target || !id) throw new NotFoundError(to ?? name, id ?? "");
    const held = await holdsAccess(reader, target, [id]);
    if (!held.has(id)) throw new NotFoundError(target.name, id);
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
 * The Person a customer's new record is for (ADR 0540): the caller, or the one they name in
 * `forPersonId` when that is a live dependant of theirs and the object lets guardians write
 * its records. Anyone else (another member, an ended link, a Person who does not exist, an object
 * that does not open to guardians) is answered as a Person that is not there.
 */
async function ownerFor(
  writer: SeamWriter,
  scope: Extract<Scope, { kind: "customer" }>,
  forPersonId: string | undefined,
): Promise<string> {
  if (forPersonId === undefined || forPersonId === scope.personId) return scope.personId;
  if (
    !scope.dependantsWrite ||
    !(await isLiveDependant(writer.reader.db, scope.personId, forPersonId))
  ) {
    throw new NotFoundError("person", forPersonId);
  }
  return forPersonId;
}

/**
 * Creates a record of `object` for the caller: the customer field is the caller, whatever was
 * asked, or a live dependant they name (`forPersonId`, ADR 0540), and the other values must be
 * fields the caller (or the tool calling for them) may set. A record made for a dependant is held
 * to the live link at commit by the final check, so it is not made if the link ended meanwhile. The object's
 * `guardians.madeBy`, when declared, is set to the caller.
 */
export async function createVisible(
  writer: SeamWriter,
  name: string,
  values: Record<string, unknown>,
  options: { forPersonId?: string | undefined } = {},
): Promise<{ id: string }> {
  const { object, scope } = customerScopeFor(writer, name);
  assertSettable(writer, object, scope, values);
  if (isCoreObject(object.name) || !recordWriter) {
    throw new ForbiddenError(`A customer cannot create a ${object.name}`);
  }
  const owner = await ownerFor(writer, scope, options.forPersonId);
  await assertRelationsVisible(writer.reader, object, values);
  await assertAccessRequired(writer.reader, object, values, null);
  const madeBy = scope.declaration.guardians?.madeBy;
  const owned = {
    ...values,
    [scope.declaration.field]: owner,
    ...(madeBy ? { [madeBy]: scope.personId } : {}),
  };
  // For a dependant, the final check (assertVisibleWrites) adds the link's guard to the batch.
  const create = recordWriter.create;
  const seamSet = new Set(madeBy ? [madeBy] : []);
  return { id: await recording(writer, (host) => create(host, object, owned, { seamSet })) };
}

/** Changes one of the caller's own records, in fields they (or the tool) may set. */
export async function updateVisible(
  writer: SeamWriter,
  name: string,
  id: string,
  values: Record<string, unknown>,
  options: { from?: string | undefined } = {},
): Promise<void> {
  const { object, scope } = customerScopeFor(writer, name);
  assertSettable(writer, object, scope, values);
  // Fields set when the record is made, never after (ADR 0507), whatever tool asks.
  for (const field of object.customer?.createOnly ?? []) {
    if (Object.hasOwn(values, field)) {
      throw new ValidationError(`${object.name}.${field} is set only when it is made`, { field });
    }
  }
  // The record must be the caller's own: otherwise it is not there. One shared with them is
  // theirs to read only (ADR 0447).
  // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
  const row = (await (writer.reader.db as any)
    .selectFrom(ownedSource(writer.reader, object))
    .select("id")
    .where("id", "=", id)
    .executeTakeFirst()) as AnyRow | undefined;
  if (!row) throw new NotFoundError(object.name, id);
  // A dependant's record (ADR 0540): the final check (assertVisibleWrites) holds the write to the
  // live link at commit, as it does every change to a dependant's record.
  await assertRelationsVisible(writer.reader, object, values);
  if (object.customer?.requireAccess?.length) {
    // What the row points to now, through the caller's own source (its listed columns).
    // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
    const current = (await (writer.reader.db as any)
      .selectFrom(visibleSource(writer.reader, object))
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst()) as AnyRow | undefined;
    const existing: AnyRow = {};
    for (const name of object.customer.requireAccess) {
      const field = object.fields.find((f) => f.name === name);
      const column = field ? viewColumnOf(field) : null;
      existing[name] = column && current ? current[column] : null;
    }
    await assertAccessRequired(writer.reader, object, values, existing);
  }
  const update =
    coreWriters.get(object.name)?.update ??
    (isCoreObject(object.name) ? null : recordWriter?.update);
  if (!update) throw new OperationError("internal", `No writer for ${object.name}`);
  // `from` is passed by the tool and judged by the record code: a move made from a current read.
  const from = options.from === undefined ? {} : { from: options.from };
  await recording(writer, (host) => update(host, object, id, values, from));
}

/**
 * Moves one of the caller's own records to Trash, where its object lets its customer remove their
 * own (`customer.delete`, ADR 0414, amended): a logged set ticked by mistake. Any other object, and a
 * record that is not theirs, is answered as a record that is not there.
 */
export async function deleteVisible(writer: SeamWriter, name: string, id: string): Promise<void> {
  const { object } = customerScopeFor(writer, name);
  if (!object.customer?.delete || isCoreObject(object.name) || !recordWriter) {
    throw new ForbiddenError(`A customer cannot delete a ${object.name}`);
  }
  // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
  const row = (await (writer.reader.db as any)
    .selectFrom(ownedSource(writer.reader, object))
    .select("id")
    .where("id", "=", id)
    .executeTakeFirst()) as AnyRow | undefined;
  if (!row) throw new NotFoundError(object.name, id);
  const trash = recordWriter.delete;
  await recording(writer, (host) => trash(host, object, id));
}
