// Access (stage 42, ADR 0477): whether a customer holds access to a record, the one question the
// seam asks before it shows them a document's `holders` parts, and before `media.play` or
// `media.serve` gives them what those parts show.
//
// An object declares where access comes from:
//   access: {
//     sources: [
//       { via: "courses.enrolment", field: "course", states: ["active"], until: "until" },
//       { via: "courses.enrolment", field: "bundle", through: "courses", states: ["active"], until: "until" },
//     ],
//   }
// A source of kind `record` (the default, named by `via`) is one of the caller's own records of
// `via` (an object of the same extension that declares a customer: its customer field is the
// caller's Person), live (in the trash it gives nothing), in one of `states`, and before its
// `until` when that is set, pointing at the record through `field`, or, with `through`, at a
// record whose field `through` lists the record (a bundle's courses: a many relation, or a
// document's refs, read from its published version when the public reads that object). A refund
// in full moves a granted enrolment to its void state (ADR 0435), which no source may name, so
// access ends in the refund's own batch.
//
// Sources of another kind are the host's: `registerAccessSource` adds one (stage 32's
// subscriptions), and `holdsAccess` answers from every kind the same way, so the seam's question,
// the `holders` flag and `media.play` do not change when a kind is added.
import type { DocumentSchema } from "@composable-os/sdk";
import { documentRefs } from "@composable-os/sdk";
import { type Kysely, type RawBuilder, sql } from "kysely";
import { liveViewOf } from "../extensions/schema.ts";
import { getObject } from "../fields/index.ts";
import type {
  AccessSource,
  FieldDefinition,
  ObjectDefinition,
  RecordAccessSource,
} from "../fields/types.ts";

export type {
  AccessDeclaration,
  AccessSource,
  KindAccessSource,
  RecordAccessSource,
} from "../fields/types.ts";

import { viewColumnOf } from "../records/columns.ts";
import { jsonList } from "../records/common.ts";
import type { Reader } from "./index.ts";

/** What a source of one kind is asked. */
export interface AccessQuery {
  readonly db: Kysely<Record<string, Record<string, unknown>>>;
  /** The caller's Person. */
  readonly personId: string;
  /** Now, as an ISO timestamp: what `until` is compared with. */
  readonly now: string;
  /** The object whose records are asked about, as the registry has it. */
  readonly object: ObjectDefinition;
  /** The records asked about (live records of `object`, at most a page of them). */
  readonly ids: readonly string[];
}

/**
 * One kind of source: which of `query.ids` the caller holds through `source`. `problems` says
 * what is wrong with a declaration of it (empty when nothing is), for the checks.
 */
export interface AccessSourceKind {
  holders(query: AccessQuery, source: AccessSource): Promise<ReadonlySet<string>>;
  problems(object: ObjectDefinition, source: AccessSource): string[];
}

const kinds = new Map<string, AccessSourceKind>();

/**
 * Adds a kind of access source (platform code only: a later stage's subscriptions, or a test's
 * fixture). The seam's question and every rule built on it read it with no other change.
 */
export function registerAccessSource(kind: string, implementation: AccessSourceKind): void {
  if (kind === "record") throw new Error("The record kind is the host's own");
  kinds.set(kind, implementation);
}

/** Whether the host provides a kind of access source. */
export function hasAccessSourceKind(kind: string): boolean {
  return implementationOf(kind) !== undefined;
}

/** Removes a kind added with `registerAccessSource` (tests). */
export function unregisterAccessSource(kind: string): void {
  kinds.delete(kind);
}

const kindOf = (source: AccessSource) => source.kind ?? "record";
const implementationOf = (kind: string) => (kind === "record" ? RECORD_KIND : kinds.get(kind));

/** What is wrong with an object's `access` declaration (empty when nothing is). */
export function accessProblems(object: ObjectDefinition): string[] {
  const declared = object.access;
  if (!declared) return [];
  if (!declared.sources.length) return ["access declares at least one source"];
  const problems: string[] = [];
  declared.sources.forEach((source, i) => {
    const kind = kindOf(source);
    const implementation = implementationOf(kind);
    if (!implementation) {
      problems.push(`access.sources.${i}: the host has no source of kind "${kind}"`);
      return;
    }
    for (const p of implementation.problems(object, source)) {
      problems.push(`access.sources.${i}: ${p}`);
    }
  });
  return problems;
}

/**
 * The one question (ADR 0477): of `ids` (records of `object`), the ones the caller holds access
 * to. Staff hold every record; the public none; a customer those one of the object's sources
 * gives them. An object that declares no access has no holders' parts, and no customer holds it.
 */
export async function holdsAccess(
  reader: Reader,
  object: ObjectDefinition,
  ids: readonly string[],
  now: string = new Date().toISOString(),
): Promise<ReadonlySet<string>> {
  const principal = reader.principal;
  if (principal.kind === "staff") return new Set(ids);
  const definition = getObject(object.name) ?? object;
  const declared = definition.access;
  if (principal.kind !== "customer" || !declared || !ids.length) return new Set();
  const problems = accessProblems(definition);
  // A declaration that does not hold together gives no one access, and says so to its author.
  if (problems.length) {
    throw new Error(`${definition.name}: invalid access declaration: ${problems.join("; ")}`);
  }
  const query: AccessQuery = {
    db: reader.db as unknown as AccessQuery["db"],
    personId: principal.personId,
    now,
    object: definition,
    ids: [...new Set(ids)],
  };
  const held = new Set<string>();
  for (const source of declared.sources) {
    // Every kind is known: accessProblems refused the declaration otherwise.
    const implementation = implementationOf(kindOf(source));
    if (!implementation) continue;
    const left = query.ids.filter((id) => !held.has(id));
    if (!left.length) break;
    const asked = new Set(left);
    for (const id of await implementation.holders({ ...query, ids: left }, source)) {
      if (asked.has(id)) held.add(id);
    }
  }
  return held;
}

// --- The record kind -----------------------------------------------------------------------------

interface ResolvedRecordSource {
  /** The `via` object's live view, its owner, pointer, state and until columns. */
  view: string;
  owner: string;
  pointer: string;
  state: { column: string; values: readonly string[] } | null;
  until: { column: string; date: boolean } | null;
  /** With `through`: where the pointed-to record lists this object's records. */
  through: {
    view: string;
    column: string;
    field: FieldDefinition;
  } | null;
}

const field = (object: ObjectDefinition, name: string) =>
  object.fields.find((f) => f.name === name);

function resolveRecordSource(
  object: ObjectDefinition,
  source: RecordAccessSource,
): ResolvedRecordSource | string {
  const via = getObject(source.via);
  if (!via || via.name === object.name || !object.extension || via.extension !== object.extension) {
    return `via "${source.via}" must be another object of the same extension`;
  }
  const ownerField = via.customer ? field(via, via.customer.field) : undefined;
  const owner = ownerField ? viewColumnOf(ownerField) : null;
  if (!via.customer || !owner) return `via "${source.via}" must declare a customer`;
  const pointerField = field(via, source.field);
  const pointer = pointerField ? viewColumnOf(pointerField) : null;
  if (!pointer || pointerField?.fieldType !== "relation" || pointerField.options?.many) {
    return `field "${source.field}" must be a relation of ${via.name} to one record`;
  }
  let through: ResolvedRecordSource["through"] = null;
  if (source.through === undefined) {
    if (pointerField.options?.to !== object.name) {
      return `field "${source.field}" must be a relation of ${via.name} to one ${object.name}`;
    }
  } else {
    const target = getObject(String(pointerField.options?.to));
    const list = target ? field(target, source.through) : undefined;
    const column = list ? viewColumnOf(list) : null;
    const lists =
      (list?.fieldType === "relation" &&
        list.options?.many === true &&
        list.options?.to === object.name) ||
      list?.fieldType === "document";
    if (!target || !list || !column || !lists) {
      return `through "${source.through}" must be a many relation to ${object.name}, or a document naming it, on the record ${source.field} points to`;
    }
    // What a bundle lists is read as published, when the public reads it as published.
    const published = Boolean(
      target.publishable && target.public && target.publishable.content.includes(list.name),
    );
    through = { view: published ? liveViewOf(target.name) : target.source, column, field: list };
  }
  let state: ResolvedRecordSource["state"] = null;
  if (via.states) {
    const stateField = field(via, via.states.field);
    const column = stateField ? viewColumnOf(stateField) : null;
    if (!column) return `${via.name} has no state column`;
    if (!source.states?.length) return `${via.name} has states: name the ones that give access`;
    state = { column, values: source.states };
  } else if (source.states?.length) {
    return `${via.name} has no states`;
  }
  let until: ResolvedRecordSource["until"] = null;
  if (source.until !== undefined) {
    const untilField = field(via, source.until);
    const column = untilField ? viewColumnOf(untilField) : null;
    if (!column || (untilField?.fieldType !== "date" && untilField?.fieldType !== "datetime")) {
      return `until "${source.until}" must be a date or datetime field of ${via.name}`;
    }
    until = { column, date: untilField.fieldType === "date" };
  }
  return { view: via.source, owner, pointer, state, until, through };
}

/** The caller's own live records of `via` that give access now: their pointers. */
function pointersSql(
  resolved: ResolvedRecordSource,
  query: AccessQuery,
): RawBuilder<{ id: string }> {
  const conditions = [
    sql`${sql.ref(resolved.owner)} = ${query.personId}`,
    sql`${sql.ref(resolved.pointer)} IS NOT NULL`,
  ];
  if (resolved.state) {
    conditions.push(sql`${sql.ref(resolved.state.column)} IN ${jsonList(resolved.state.values)}`);
  }
  if (resolved.until) {
    // A date's last day still gives access; a datetime until its moment.
    const bound = resolved.until.date ? query.now.slice(0, 10) : query.now;
    const op = resolved.until.date ? sql`>=` : sql`>`;
    conditions.push(
      sql`(${sql.ref(resolved.until.column)} IS NULL OR ${sql.ref(resolved.until.column)} = '' OR ${sql.ref(resolved.until.column)} ${op} ${bound})`,
    );
  }
  return sql<{
    id: string;
  }>`SELECT DISTINCT ${sql.ref(resolved.pointer)} AS id FROM ${sql.table(resolved.view)} WHERE ${sql.join(conditions, sql` AND `)}`;
}

const RECORD_KIND: AccessSourceKind = {
  problems(object, source) {
    if (source.via === undefined) return ["a record source names via"];
    const resolved = resolveRecordSource(object, source);
    return typeof resolved === "string" ? [resolved] : [];
  },
  async holders(query, source) {
    if (source.via === undefined) return new Set();
    const resolved = resolveRecordSource(query.object, source);
    if (typeof resolved === "string") return new Set();
    const pointers = pointersSql(resolved, query);
    if (!resolved.through) {
      const rows = await sql<{ id: string }>`SELECT id FROM (${pointers}) WHERE id IN ${jsonList(
        query.ids,
      )}`.execute(query.db);
      return new Set(rows.rows.map((r) => String(r.id)));
    }
    // Through a record that lists them (a bundle): read what each one the caller holds lists.
    const { view, column, field: list } = resolved.through;
    const rows = await sql<{
      value: unknown;
    }>`SELECT ${sql.ref(column)} AS value FROM ${sql.table(view)} WHERE id IN (${pointers})`.execute(
      query.db,
    );
    const wanted = new Set(query.ids);
    const held = new Set<string>();
    for (const { value } of rows.rows) {
      for (const id of listed(list, value, query.object.name)) if (wanted.has(id)) held.add(id);
    }
    return held;
  },
};

/** The ids of `object` records a stored many relation or document lists. */
function listed(list: FieldDefinition, stored: unknown, object: string): string[] {
  let value: unknown = stored;
  if (typeof stored === "string") {
    try {
      value = JSON.parse(stored);
    } catch {
      return [];
    }
  }
  if (list.fieldType === "relation") {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  }
  const schema = list.options?.document?.schema as DocumentSchema | undefined;
  if (!schema || value === null || value === undefined) return [];
  return documentRefs(schema, value)
    .filter((ref) => ref.to === object)
    .map((ref) => ref.id);
}
