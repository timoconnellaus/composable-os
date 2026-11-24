// Extension schema state (core_extension_objects / core_extension_fields), the field registry
// built from it, and the rec_* view SQL generated from it (ADR 0023, ADR 0024).
import type { CoreDatabase } from "@composable-os/db";
import {
  type AgreementsManifest,
  type AllowanceManifest,
  type CapacityManifest,
  type ChecklistsManifest,
  type ClaimsManifest,
  type DocumentSchema,
  documentJsonPath,
  documentMaxBytesOf,
  documentPathNode,
  documentSchemaOf,
  type FieldManifest,
  type FieldTypeName,
  formulaTypeOf,
  isDocumentType,
  RECURRING_HORIZON_DAYS,
  type RecurringScheduleManifest,
  type SellableManifest,
  type StaffedManifest,
  type StagesManifest,
  type StatesManifest,
  type StockManifest,
  spendsOnList,
  type UniqueManifest,
} from "@composable-os/sdk";
import {
  compileFormula,
  type FormulaEnvironment,
  FormulaError,
  type FormulaFieldRef,
} from "@composable-os/sdk/formula";
import { type Kysely, sql } from "kysely";
import { setDeclaredUniqueKeys } from "../errors.ts";
import { FIELD_TYPE_REGISTRY, formulaFilterType } from "../fields/field-types.ts";
import { CORE_OBJECTS, setExtensionObjects } from "../fields/index.ts";
import type { FieldDefinition, FieldType, ObjectDefinition } from "../fields/types.ts";
import {
  CORE_TARGETS,
  type CoreTarget,
  ident,
  isCoreTarget,
  objectView,
  registryFieldName,
  splitObjectName,
  viewColumnName,
  viewOf,
} from "./naming.ts";

/** One source of access as declared (ADR 0477): a record source, or a kind the host provides. */
export type AccessSourceJson =
  | {
      via: string;
      field: string;
      through?: string | undefined;
      states?: string[] | undefined;
      until?: string | undefined;
    }
  | { kind: string; options?: Record<string, unknown> | undefined };

export interface ObjectDefinitionJson {
  label: string;
  plural: string;
  icon?: string;
  titleField: string;
  description?: string;
  /** Declared field order. */
  fieldOrder: string[];
  /** Behaviour keys (ADR 0100), as declared. */
  navigation?: "main" | "settings" | "none";
  indexes?: string[][];
  timelineLinks?: string[];
  stages?: StagesManifest;
  capacity?: CapacityManifest;
  sellable?: SellableManifest;
  stock?: StockManifest;
  allowance?: AllowanceManifest;
  /** An agreement point (stage 44, ADR 0641), as declared. */
  agreements?: AgreementsManifest;
  /** A health-note list (stage 44, ADR 0643), as declared. */
  healthNotes?: { list: string; person: string };
  states?: StatesManifest;
  claims?: ClaimsManifest;
  unique?: UniqueManifest;
  recurring?: RecurringScheduleManifest;
  /** A shift (stage 45, ADR 0621), as declared. */
  staffed?: StaffedManifest;
  /** A checklist its person ticks off (stage 45 step 4b, ADR 0650), as declared. */
  checklists?: ChecklistsManifest;
  owner?: string;
  /** The object's customer (ADR 0402), as declared. */
  customer?: {
    field: string;
    read: string[];
    write: string[];
    requireAccess?: string[] | undefined;
    createOnly?: string[] | undefined;
    guardians?: { write?: boolean | undefined; madeBy?: string | undefined } | undefined;
  };
  /** What the public may read (ADR 0438), as declared. */
  public?: {
    read: string[];
    when?: { via?: string | undefined; field: string; in: string[] } | undefined;
  };
  /** What every signed-in customer may read (ADR 0447), as declared. */
  signedIn?: {
    read: string[];
    when?: { via?: string | undefined; field: string; in: string[] } | undefined;
  };
  /** What a customer reads of a record their own record points to (ADR 0439), as declared. */
  customerVia?: { from: string; field: string; read: string[] };
  /** Who holds access to a record (ADR 0477), as declared. */
  access?: { sources: AccessSourceJson[] };
  /** Versions of the content fields (ADR 0446), as declared. */
  publishable?: { content: string[]; slug?: string | undefined; date?: string | undefined };
  navigationOrder?: number;
  requireOneOf?: string[][];
  titleDefault?: { from: string[]; suffix?: string | undefined };
}

export type FieldDefinitionJson = FieldManifest & {
  /** Formula fields: the result type, set when the formula compiled. */
  resultType?: string;
  /** Fields with editableOptions whose options an admin edited: the declared options. */
  declaredOptions?: FieldManifest["options"];
};

export interface ObjectState {
  name: string;
  extensionId: string;
  localName: string;
  tableName: string;
  status: "active" | "hidden";
  hiddenAt: string | null;
  definition: ObjectDefinitionJson;
  createdAt: string;
  updatedAt: string;
}

export interface FieldState {
  id?: number;
  extensionId: string;
  object: string;
  localName: string;
  name: string;
  tableName: string;
  columnName: string | null;
  type: FieldTypeName;
  definition: FieldDefinitionJson;
  status: "active" | "hidden";
  hiddenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SchemaState {
  objects: ObjectState[];
  fields: FieldState[];
  /** Indexes on x_* tables (from sqlite_master), so the reconciler can add and drop its own. */
  indexes?: { name: string; table: string }[];
}

/** Reads the reconciler's state tables. */
export async function loadSchemaState(db: Kysely<CoreDatabase>): Promise<SchemaState> {
  const [objects, fields, indexes] = await Promise.all([
    db.selectFrom("core_extension_objects").selectAll().orderBy("name").execute(),
    db.selectFrom("core_extension_fields").selectAll().orderBy("id").execute(),
    sql<{ name: string; tbl_name: string }>`
      SELECT name, tbl_name FROM sqlite_master
      WHERE type = 'index' AND substr(tbl_name, 1, 2) = 'x_' AND sql IS NOT NULL
    `.execute(db),
  ]);
  return {
    indexes: indexes.rows.map((row) => ({ name: row.name, table: row.tbl_name })),
    objects: objects.map((row) => ({
      name: row.name,
      extensionId: row.extension_id,
      localName: row.local_name,
      tableName: row.table_name,
      status: row.status,
      hiddenAt: row.hidden_at,
      definition: JSON.parse(row.definition) as ObjectDefinitionJson,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    fields: fields.map((row) => ({
      id: row.id,
      extensionId: row.extension_id,
      object: row.object,
      localName: row.local_name,
      name: row.name,
      tableName: row.table_name,
      columnName: row.column_name,
      type: row.type as FieldTypeName,
      definition: JSON.parse(row.definition) as FieldDefinitionJson,
      status: row.status,
      hiddenAt: row.hidden_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Formula environments

const CORE_FORMULA_TYPES: Partial<
  Record<FieldType, "text" | "number" | "boolean" | "date" | "datetime">
> = {
  text: "text",
  id: "text",
  enum: "text",
  number: "number",
  boolean: "boolean",
  date: "date",
  datetime: "datetime",
};

/** Core fields of a core object a formula may read: single-valued registry fields with a column. */
export function coreFormulaFields(
  target: CoreTarget,
  alias = "b",
): Record<string, FormulaFieldRef> {
  const env: Record<string, FormulaFieldRef> = {};
  const fields: readonly FieldDefinition[] = CORE_OBJECTS[target].fields;
  for (const field of fields) {
    const type = CORE_FORMULA_TYPES[field.type];
    if (!field.column || field.related || !type) continue;
    env[field.name] = { type, sql: `${alias}.${ident(field.column)}` };
  }
  return env;
}

/** Adds `fields` (one extension's, on one object) to a formula environment. */
function addFields(
  env: Record<string, FormulaFieldRef>,
  fields: FieldState[],
  alias: string,
  local: boolean,
) {
  for (const field of fields) {
    const key = local ? field.localName : field.name;
    if (field.type === "formula") {
      env[key] = { expression: field.definition.expression ?? "" };
      continue;
    }
    const type = formulaTypeOf(field.type, field.definition.many);
    if (type && field.columnName) env[key] = { type, sql: `${alias}.${ident(field.columnName)}` };
  }
}

/**
 * The environment a formula of extension `extension` on `object` compiles in: the object's base
 * fields and the extension's own fields on it (by their local names).
 */
export function formulaEnvironment(
  state: SchemaState,
  object: string,
  extension: string,
): FormulaEnvironment {
  const active = state.fields.filter((f) => f.status === "active" && f.object === object);
  const env: Record<string, FormulaFieldRef> = {};
  if (isCoreTarget(object)) {
    Object.assign(env, coreFormulaFields(object, "b"));
  } else {
    env.createdAt = { type: "datetime", sql: "t.created_at" };
    env.updatedAt = { type: "datetime", sql: "t.updated_at" };
    const owner = splitObjectName(object)?.extension;
    addFields(
      env,
      active.filter((f) => f.extensionId === owner),
      "t",
      true,
    );
  }
  if (isCoreTarget(object) || splitObjectName(object)?.extension !== extension) {
    addFields(
      env,
      active.filter((f) => f.extensionId === extension),
      `s_${ident(extension)}`,
      true,
    );
  }
  return { fields: env };
}

// ---------------------------------------------------------------------------------------------
// rec_* views

export interface ViewBuild {
  /** `DROP VIEW IF EXISTS` for every view the reconciler owns (current and stale). */
  drops: string[];
  creates: string[];
  /** Formulas that failed to compile, by field. */
  errors: { object: string; field: string; error: FormulaError }[];
  /** Compiled formula result types, keyed `object|name`. */
  formulaTypes: Map<string, string>;
}

function compileIn(
  state: SchemaState,
  field: FieldState,
  build: ViewBuild,
): { sql: string; type: string } | null {
  try {
    const compiled = compileFormula(
      field.definition.expression ?? "",
      formulaEnvironment(state, field.object, field.extensionId),
      field.localName,
    );
    build.formulaTypes.set(`${field.object}|${field.name}`, compiled.type);
    return compiled;
  } catch (error) {
    if (error instanceof FormulaError) {
      build.errors.push({ object: field.object, field: field.name, error });
      return null;
    }
    throw error;
  }
}

/** Side-table joins and columns of every extension's fields on `object` (other than its owner). */
function foreignColumns(
  state: SchemaState,
  object: string,
  owner: string | null,
  idRef: string,
  build: ViewBuild,
): { joins: string[]; columns: string[] } {
  const fields = state.fields.filter(
    (f) => f.status === "active" && f.object === object && f.extensionId !== owner,
  );
  const extensions = [...new Set(fields.map((f) => f.extensionId))].sort();
  const joins: string[] = [];
  const columns: string[] = [];
  for (const extension of extensions) {
    const own = fields.filter((f) => f.extensionId === extension);
    const alias = `s_${ident(extension)}`;
    const table = own.find((f) => f.columnName)?.tableName;
    if (table) joins.push(`LEFT JOIN ${ident(table)} ${alias} ON ${alias}.id = ${idRef}`);
    for (const field of own) {
      const as = viewColumnName(extension, object, field.localName);
      if (field.type === "formula") {
        const compiled = compileIn(state, field, build);
        columns.push(`${compiled ? compiled.sql : "NULL"} AS ${as}`);
      } else if (field.columnName && table) {
        columns.push(`${alias}.${ident(field.columnName)} AS ${as}`);
        columns.push(...documentPathColumns(field, alias, object));
      }
    }
  }
  return { joins, columns };
}

/**
 * The rec_* views for the given state: the four core objects (base view + side tables) and every
 * active extension object. Formulas compile here; one that fails yields NULL and an error.
 */
export function buildViews(state: SchemaState): ViewBuild {
  const build: ViewBuild = { drops: [], creates: [], errors: [], formulaTypes: new Map() };
  for (const [object, target] of Object.entries(CORE_TARGETS)) {
    const { joins, columns } = foreignColumns(state, object, null, "b.id", build);
    build.drops.push(`DROP VIEW IF EXISTS ${target.view}`);
    build.creates.push(
      `CREATE VIEW ${target.view} AS SELECT ${["b.*", ...columns].join(", ")} FROM ${target.base} b${joins.length ? ` ${joins.join(" ")}` : ""}`,
    );
  }
  for (const object of state.objects) {
    const view = objectView(object.extensionId, object.localName);
    build.drops.push(`DROP VIEW IF EXISTS ${view}`);
    if (object.status !== "active") continue;
    const own = state.fields.filter(
      (f) =>
        f.status === "active" && f.object === object.name && f.extensionId === object.extensionId,
    );
    const columns = ["t.id", "t.created_at", "t.updated_at", "t.created_by"];
    for (const field of own) {
      const as = viewColumnName(object.extensionId, object.name, field.localName);
      if (field.type === "formula") {
        const compiled = compileIn(state, field, build);
        columns.push(`${compiled ? compiled.sql : "NULL"} AS ${as}`);
      } else if (field.columnName) {
        columns.push(`t.${ident(field.columnName)} AS ${as}`);
        columns.push(...documentPathColumns(field, "t", object.name));
      }
    }
    const foreign = foreignColumns(state, object.name, object.extensionId, "t.id", build);
    columns.push(...foreign.columns);
    const joins = [...foreign.joins];
    if (object.definition.capacity) {
      const capacity = capacityView(object.name);
      columns.push(...capacity.columns);
      joins.push(...capacity.joins);
    }
    if (object.definition.stock) {
      const stock = stockView(object.name);
      columns.push(...stock.columns);
      joins.push(...stock.joins);
    }
    if (object.definition.publishable) {
      const published = publishedView(object.name);
      columns.push(...published.columns);
      joins.push(...published.joins);
    }
    const allowance = object.definition.allowance;
    if (allowance && "holds" in allowance) {
      const held = allowanceView(object.name);
      columns.push(...held.columns);
      joins.push(...held.joins);
    }
    build.creates.push(
      `CREATE VIEW ${view} AS SELECT ${columns.join(", ")} FROM ${ident(object.tableName)} t${joins.length ? ` ${joins.join(" ")}` : ""} WHERE t.deleted_at IS NULL`,
    );
    if (object.definition.publishable) {
      build.creates.push(liveViewSql(object, own));
    }
  }
  // The live views of objects that are no longer publishable (or gone) go with the rest.
  for (const object of state.objects) {
    build.drops.push(`DROP VIEW IF EXISTS ${liveViewOf(object.name)}`);
  }
  return build;
}

/**
 * The live view of a publishable object (stage 28, ADR 0442): `pub_x_<ext>_<object>`, what the
 * public reads. One row per live record that has a current version, with the columns of its
 * rec_* view: a content field's value (and a declared path of a content document) from the
 * current version, never the working copy; any other field of the object's own from the record,
 * as the host keeps it (its slug, a state the public's `when` tests); formulas and other
 * extensions' fields absent (NULL), since they read the working copy. `updated_at` is when the
 * version was published. Not a rec_* view: `query.sql` does not read it, and nothing but the
 * visibility seam's public source does (visibility/public.ts).
 */
function liveViewSql(object: ObjectState, own: FieldState[]): string {
  const publishable = object.definition.publishable as NonNullable<
    ObjectDefinitionJson["publishable"]
  >;
  const content = new Set(publishable.content);
  const columns = ["t.id", "t.created_at", "pub.published_at AS updated_at", "t.created_by"];
  for (const field of own) {
    const as = viewColumnName(object.extensionId, object.name, field.localName);
    if (field.type === "formula" || !field.columnName) {
      columns.push(`NULL AS ${as}`);
      continue;
    }
    if (!content.has(field.localName)) {
      columns.push(`t.${ident(field.columnName)} AS ${as}`);
      columns.push(...documentPathColumns(field, "t", object.name));
      continue;
    }
    columns.push(`json_extract(pub.content, '${documentJsonPath(field.localName)}') AS ${as}`);
    if (field.type === "document") {
      for (const [name, spec] of Object.entries(field.definition.paths ?? {})) {
        const json = `'${documentJsonPath(`${field.localName}.${spec.path}`)}'`;
        const read = spec.count
          ? `json_array_length(pub.content, ${json})`
          : `json_extract(pub.content, ${json})`;
        columns.push(`${read} AS ${viewColumnName(field.extensionId, object.name, name)}`);
      }
    }
  }
  const joins = [
    `JOIN core_publish_version pub ON pub.object_type = ${sqlString(object.name)} AND pub.record_id = t.id AND pub.current = 1`,
  ];
  if (object.definition.capacity) {
    const view = capacityView(object.name);
    columns.push(...view.columns);
    joins.push(...view.joins);
  }
  if (object.definition.stock) {
    const view = stockView(object.name);
    columns.push(...view.columns);
    joins.push(...view.joins);
  }
  columns.push(
    `pub.version AS ${PUBLISHED_COLUMNS.publishedVersion}`,
    `pub.published_at AS ${PUBLISHED_COLUMNS.publishedAt}`,
    `'published' AS ${PUBLISHED_COLUMNS.publishState}`,
    `NULL AS ${PUBLISHED_COLUMNS.publishAt}`,
  );
  return `CREATE VIEW ${liveViewOf(object.name)} AS SELECT ${columns.join(", ")} FROM ${ident(object.tableName)} t ${joins.join(" ")} WHERE t.deleted_at IS NULL`;
}

/** The live view of a publishable object: `pub_x_<ext>_<object>` (ADR 0442). */
export function liveViewOf(objectName: string): string {
  const parts = splitObjectName(objectName);
  if (!parts) throw new Error(`Not an extension object: ${objectName}`);
  return ident(`pub_x_${parts.extension}_${parts.object}`);
}

const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * The capacity values of an object's view (stage 26, ADR 0431): its counter and its pool's
 * counter, joined by primary key. `available` is the fewer of the record's and the pool's places
 * left, null when both are unlimited.
 */
function capacityView(object: string): { joins: string[]; columns: string[] } {
  const name = `'${object.replaceAll("'", "''")}'`;
  const left = (alias: string) => `max(${alias}.places - ${alias}.held - ${alias}.taken, 0)`;
  return {
    joins: [
      `LEFT JOIN core_capacity cap ON cap.object_type = ${name} AND cap.record_id = t.id`,
      "LEFT JOIN core_capacity capp ON capp.object_type = cap.pool_object_type AND capp.record_id = cap.pool_record_id",
    ],
    columns: [
      `coalesce(cap.held, 0) AS ${CAPACITY_COLUMNS.held}`,
      `coalesce(cap.taken, 0) AS ${CAPACITY_COLUMNS.taken}`,
      `CASE WHEN cap.places IS NULL AND capp.places IS NULL THEN NULL WHEN capp.places IS NULL THEN ${left("cap")} WHEN cap.places IS NULL THEN ${left("capp")} ELSE min(${left("cap")}, ${left("capp")}) END AS ${CAPACITY_COLUMNS.available}`,
    ],
  };
}

/**
 * The stock values of an object's view (stage 37, ADR 0680): from its counter on core_capacity,
 * on hand is places - taken (what came in less what was sold) and available is on hand - held.
 */
function stockView(object: string): { joins: string[]; columns: string[] } {
  const name = `'${object.replaceAll("'", "''")}'`;
  return {
    joins: [`LEFT JOIN core_capacity stk ON stk.object_type = ${name} AND stk.record_id = t.id`],
    columns: [
      `coalesce(stk.places, 0) - coalesce(stk.taken, 0) AS ${STOCK_COLUMNS.onHand}`,
      `coalesce(stk.held, 0) AS ${STOCK_COLUMNS.held}`,
      `max(coalesce(stk.places, 0) - coalesce(stk.taken, 0) - coalesce(stk.held, 0), 0) AS ${STOCK_COLUMNS.available}`,
    ],
  };
}

/**
 * The allowance values of a holder's view (stage 32b, ADR 0493): uses spent in the current period
 * and uses left now, from rec_allowance (migration 0533) over its terms row, which every write and
 * the reconciler's backfill keep.
 */
function allowanceView(object: string): { joins: string[]; columns: string[] } {
  const name = `'${object.replaceAll("'", "''")}'`;
  return {
    joins: [`LEFT JOIN rec_allowance alw ON alw.object_type = ${name} AND alw.record_id = t.id`],
    columns: [
      `coalesce(alw.used, 0) AS ${ALLOWANCE_COLUMNS.used}`,
      // No terms row (never written since a reconcile's backfill): nothing can be spent yet.
      `CASE WHEN alw.record_id IS NULL THEN 0 ELSE alw."left" END AS ${ALLOWANCE_COLUMNS.left}`,
    ],
  };
}

/**
 * The declared paths of a document field (ADR 0445) as view columns: `json_extract` of the path,
 * or `json_array_length` for a count. Paths are checked keys (`documentJsonPath`), quoted as a
 * SQL string; their column names are made like a field's.
 */
function documentPathColumns(field: FieldState, alias: string, object: string): string[] {
  if (field.type !== "document" || !field.columnName) return [];
  const column = `${alias}.${ident(field.columnName)}`;
  return Object.entries(field.definition.paths ?? {}).map(([name, spec]) => {
    const json = `'${documentJsonPath(spec.path)}'`;
    const read = spec.count
      ? `json_array_length(${column}, ${json})`
      : `json_extract(${column}, ${json})`;
    return `${read} AS ${viewColumnName(field.extensionId, object, name)}`;
  });
}

/** The registry fields of a document field's declared paths: read-only, filterable, sortable. */
function documentPathFields(field: FieldState, object: string): FieldDefinition[] {
  if (field.type !== "document") return [];
  const schema = field.definition.schema as unknown as DocumentSchema | undefined;
  if (!schema) return [];
  return Object.entries(field.definition.paths ?? {}).flatMap(([local, spec]) => {
    const reached = documentPathNode(schema, spec);
    if (typeof reached === "string") return [];
    const fieldType =
      reached.type === "boolean" ? "boolean" : reached.type === "number" ? "number" : "text";
    return [
      {
        name: registryFieldName(field.extensionId, object, local),
        label: spec.label,
        type: reached.type,
        column: viewColumnName(field.extensionId, object, local),
        filterable: true,
        sortable: true,
        readOnly: true,
        extension: field.extensionId,
        fieldType,
        options: { documentPath: { field: field.name, path: spec.path, count: spec.count } },
        ...(spec.description ? { description: spec.description } : {}),
      } satisfies FieldDefinition,
    ];
  });
}

/**
 * The published version of a publishable object's records (ADR 0446): the current row of
 * `core_publish_version`, joined by its primary key's prefix and the one-current-row index.
 */
function publishedView(object: string): { joins: string[]; columns: string[] } {
  const name = sqlString(object);
  return {
    joins: [
      `LEFT JOIN core_publish_version pub ON pub.object_type = ${name} AND pub.record_id = t.id AND pub.current = 1`,
      `LEFT JOIN core_publish_schedule sch ON sch.object_type = ${name} AND sch.record_id = t.id`,
    ],
    columns: [
      `pub.version AS ${PUBLISHED_COLUMNS.publishedVersion}`,
      `pub.published_at AS ${PUBLISHED_COLUMNS.publishedAt}`,
      // Stage 28 (ADR 0441): the state is read from the versions and the schedule, never kept
      // beside them, so it cannot disagree with what the public is given.
      `CASE WHEN pub.version IS NOT NULL THEN 'published' WHEN sch.record_id IS NOT NULL THEN 'scheduled' WHEN EXISTS (SELECT 1 FROM core_publish_version v WHERE v.object_type = ${name} AND v.record_id = t.id) THEN 'unpublished' ELSE 'draft' END AS ${PUBLISHED_COLUMNS.publishState}`,
      `sch.publish_at AS ${PUBLISHED_COLUMNS.publishAt}`,
    ],
  };
}

/** View columns of the published version: no declared field's column can start with `_`. */
export const PUBLISHED_COLUMNS = {
  publishedVersion: "_pub_version",
  publishedAt: "_pub_at",
  publishState: "_pub_state",
  publishAt: "_pub_due",
} as const;

/** Where a publishable record is (ADR 0441). */
export const PUBLISH_STATES = ["draft", "scheduled", "published", "unpublished"] as const;
export type PublishState = (typeof PUBLISH_STATES)[number];

/** The read-only published values on every record of a publishable object (ADR 0446). */
export const PUBLISHED_FIELDS: readonly FieldDefinition[] = [
  {
    name: "publishedVersion",
    label: "Published version",
    type: "number",
    column: PUBLISHED_COLUMNS.publishedVersion,
    filterable: true,
    sortable: true,
    readOnly: true,
    description: "The version readers are given. Empty: never published.",
  },
  {
    name: "publishedAt",
    label: "Published",
    type: "datetime",
    column: PUBLISHED_COLUMNS.publishedAt,
    filterable: true,
    sortable: true,
    readOnly: true,
    description: "When that version was published.",
  },
  {
    name: "publishState",
    label: "Publishing",
    type: "enum",
    enumValues: PUBLISH_STATES,
    column: PUBLISHED_COLUMNS.publishState,
    filterable: true,
    sortable: true,
    readOnly: true,
    description:
      "draft (never published), scheduled (to be published at publishAt), published (the public " +
      "reads its current version) or unpublished (versions kept, none read).",
  },
  {
    name: "publishAt",
    label: "Scheduled for",
    type: "datetime",
    column: PUBLISHED_COLUMNS.publishAt,
    filterable: true,
    sortable: true,
    readOnly: true,
    description: "When a scheduled publish goes live. Empty: nothing is scheduled.",
  },
];

/** View columns of the capacity values: no declared field's column can start with `_`. */
export const CAPACITY_COLUMNS = {
  held: "_cap_held",
  taken: "_cap_taken",
  available: "_cap_available",
} as const;

/** The read-only capacity values on every record of an object with a capacity (CAPACITY_VALUES). */
export const CAPACITY_FIELDS: readonly FieldDefinition[] = [
  {
    name: "held",
    label: "Held",
    type: "number",
    column: CAPACITY_COLUMNS.held,
    filterable: true,
    sortable: true,
    readOnly: true,
    description: "Places held while someone pays.",
  },
  {
    name: "taken",
    label: "Taken",
    type: "number",
    column: CAPACITY_COLUMNS.taken,
    filterable: true,
    sortable: true,
    readOnly: true,
    description: "Places taken by paid orders.",
  },
  {
    name: "available",
    label: "Available",
    type: "number",
    column: CAPACITY_COLUMNS.available,
    filterable: true,
    sortable: true,
    readOnly: true,
    description: "Places left (the record's and its pool's, whichever is fewer). Empty: unlimited.",
  },
];

/** View columns of the stock values: no declared field's column can start with `_`. */
export const STOCK_COLUMNS = {
  onHand: "_stk_on_hand",
  held: "_stk_held",
  available: "_stk_available",
} as const;

/** The read-only stock values on every record of an object with stock (STOCK_VALUES). */
export const STOCK_FIELDS: readonly FieldDefinition[] = [
  {
    name: "onHand",
    label: "On hand",
    type: "number",
    column: STOCK_COLUMNS.onHand,
    filterable: true,
    sortable: true,
    readOnly: true,
    description: "How many there are, sold ones gone. Changed only by stock movements.",
  },
  {
    name: "held",
    label: "Held",
    type: "number",
    column: STOCK_COLUMNS.held,
    filterable: true,
    sortable: true,
    readOnly: true,
    description: "How many orders being paid for hold.",
  },
  {
    name: "available",
    label: "Available",
    type: "number",
    column: STOCK_COLUMNS.available,
    filterable: true,
    sortable: true,
    readOnly: true,
    description: "On hand less held: how many can be sold now.",
  },
];

/** View columns of the allowance values: no declared field's column can start with `_`. */
export const ALLOWANCE_COLUMNS = { used: "_alw_used", left: "_alw_left" } as const;

/** The read-only allowance values on every record of a holder object (ALLOWANCE_VALUES). */
export const ALLOWANCE_FIELDS: readonly FieldDefinition[] = [
  {
    name: "used",
    label: "Used",
    type: "number",
    column: ALLOWANCE_COLUMNS.used,
    filterable: true,
    sortable: true,
    readOnly: true,
    description: "Uses spent in the current period (this week, this month, or in all).",
  },
  {
    name: "left",
    label: "Left",
    type: "number",
    column: ALLOWANCE_COLUMNS.left,
    filterable: true,
    sortable: true,
    readOnly: true,
    description: "Uses that can be spent now in the current period. Empty: unlimited.",
  },
];

/** The allowance declaration with registry field names, or undefined (ADR 0493). */
function allowanceDefinition(object: ObjectState): ObjectDefinition["allowance"] {
  const declared = object.definition.allowance;
  if (!declared) return undefined;
  const qualify = (target: string) =>
    target.includes(".") ? target : `${object.extensionId}.${target}`;
  if ("holds" in declared) {
    const h = declared.holds;
    return {
      kind: "holder",
      person: h.person,
      uses: h.uses,
      per: typeof h.per === "string" ? { fixed: h.per } : { field: h.per.field },
      spendsOn: spendsOnList(h).map((s) => ({
        object: qualify(s.object),
        when: (s.when ?? []).map((c) => ({ ...c })),
      })),
      ...(h.from ? { from: h.from } : {}),
      ...(h.until ? { until: h.until } : {}),
      live: h.live ? [...h.live] : null,
      ...(h.zone ? { zone: h.zone } : {}),
      emptyIsUnlimited: h.emptyIsUnlimited === true,
    };
  }
  const sp = declared.spends;
  return {
    kind: "spender",
    person: sp.person,
    holder: sp.holder,
    spendIn: [...sp.spendIn],
    returnIn: [...sp.returnIn],
    ...(sp.at ? { at: sp.at } : {}),
    copy: { ...(sp.copy ?? {}) },
    local: { ...(sp.local ?? {}) },
    ...(sp.movedFrom ? { movedFrom: { ...sp.movedFrom } } : {}),
    paidBy: [...(sp.paidBy ?? [])],
    ...(sp.waived ? { waived: sp.waived } : {}),
  };
}

/** The capacity declaration with registry field names, or undefined. */
function capacityDefinition(object: ObjectState, own: FieldState[]): ObjectDefinition["capacity"] {
  const declared = object.definition.capacity;
  if (!declared) return undefined;
  const nameOf = (local: string) => own.find((f) => f.localName === local)?.name ?? local;
  const poolField = declared.pool ? own.find((f) => f.localName === declared.pool) : undefined;
  return {
    places: nameOf(declared.places),
    ...(poolField?.definition.to
      ? { pool: { field: poolField.name, object: poolField.definition.to } }
      : {}),
    show: declared.show ?? "availability",
    ...(declared.lowAt !== undefined ? { lowAt: declared.lowAt } : {}),
    releaseOnRefund: declared.releaseOnRefund ?? true,
  };
}

/** The stock declaration with registry field names, or undefined (ADR 0680). */
function stockDefinition(object: ObjectState, own: FieldState[]): ObjectDefinition["stock"] {
  const declared = object.definition.stock;
  if (!declared) return undefined;
  const nameOf = (local: string) => own.find((f) => f.localName === local)?.name ?? local;
  return {
    ...(declared.reorderAt ? { reorderAt: nameOf(declared.reorderAt) } : {}),
    ...(declared.reorderQty ? { reorderQty: nameOf(declared.reorderQty) } : {}),
    show: declared.show ?? "availability",
    ...(declared.lowAt !== undefined ? { lowAt: declared.lowAt } : {}),
  };
}

/** The claimant declaration (ADR 0501), with the claimed object's registry name. */
function claimsDefinition(
  object: ObjectState,
  own: FieldState[],
): Pick<ObjectDefinition, "claims"> {
  const declared = object.definition.claims;
  if (!declared) return {};
  const on = own.find((f) => f.localName === declared.on);
  if (!on?.definition.to) return {};
  const waitlist = declared.waitlist;
  const named = (local: string | undefined) =>
    local === undefined ? undefined : (own.find((f) => f.localName === local)?.name ?? local);
  return {
    claims: {
      on: on.name,
      object: on.definition.to,
      held: [...(declared.held ?? [])],
      confirmed: [...(declared.confirmed ?? [])],
      ...(waitlist
        ? {
            waitlist: {
              state: waitlist.state,
              promote: waitlist.promote,
              until: waitlist.until,
              promotedAt: named(waitlist.promotedAt),
              passedOverAt: named(waitlist.passedOverAt),
              passedOverReason: named(waitlist.passedOverReason),
            },
          }
        : {}),
    },
  };
}

/** The recurring declaration (ADR 0500), with the objects' registry names. */
/** The staffed declaration (ADR 0621), with the account holder's registry name. */
function staffedDefinition(
  object: ObjectState,
  own: readonly FieldState[],
): Pick<ObjectDefinition, "staffed"> {
  const declared = object.definition.staffed;
  if (!declared) return {};
  const holder = declared.who.account
    ? own.find((f) => f.localName === declared.who.field)?.definition.to
    : undefined;
  return {
    staffed: {
      ...declared,
      who: {
        field: declared.who.field,
        ...(declared.who.account ? { account: declared.who.account, object: holder } : {}),
      },
      live: [...declared.live],
      ...(declared.evidence
        ? {
            evidence: {
              ...declared.evidence,
              object: `${object.extensionId}.${declared.evidence.object}`,
            },
          }
        : {}),
    },
  };
}

/** The checklists declaration (ADR 0650), with the template's holder's registry name. */
function checklistsDefinition(
  object: ObjectState,
  own: readonly FieldState[],
): Pick<ObjectDefinition, "checklists"> {
  const declared = object.definition.checklists;
  if (!declared) return {};
  const [first, second] = declared.template.split(".") as [string, string | undefined];
  const viaObject =
    second !== undefined ? own.find((f) => f.localName === first)?.definition.to : undefined;
  return {
    checklists: {
      template: second !== undefined ? { field: second, via: first, viaObject } : { field: first },
      who: declared.who,
      opens: declared.opens,
      closes: declared.closes,
      live: [...declared.live],
    },
  };
}

function recurringDefinition(object: ObjectState): Pick<ObjectDefinition, "recurring"> {
  const declared = object.definition.recurring;
  if (!declared) return {};
  const named = (local: string) => `${object.extensionId}.${local}`;
  return {
    recurring: {
      generates: named(declared.generates),
      link: declared.link,
      rule: { ...declared.rule },
      into: { ...declared.into },
      copy: { ...(declared.copy ?? {}) },
      cancel: declared.cancel,
      ...(declared.ended
        ? { ended: { field: declared.ended.field, in: [...declared.ended.in] } }
        : {}),
      ...(declared.closures
        ? { closures: { ...declared.closures, object: named(declared.closures.object) } }
        : {}),
      horizonDays: declared.horizonDays ?? RECURRING_HORIZON_DAYS,
      ...(declared.horizonAtLeast
        ? {
            // Another extension's object carries this extension's field (ADR 0505).
            horizonAtLeast: declared.horizonAtLeast.object.includes(".")
              ? {
                  object: declared.horizonAtLeast.object,
                  field: registryFieldName(
                    object.extensionId,
                    declared.horizonAtLeast.object,
                    declared.horizonAtLeast.field,
                  ),
                }
              : {
                  object: named(declared.horizonAtLeast.object),
                  field: declared.horizonAtLeast.field,
                },
          }
        : {}),
      ...(declared.horizonSetting
        ? { horizonSetting: { extension: object.extensionId, name: declared.horizonSetting } }
        : {}),
    },
  };
}

/**
 * The sellable declaration with registry field names, or undefined (ADR 0435). The granted
 * object's fields are named by their registry names, which for an object's own fields are their
 * local names.
 */
function sellableDefinition(object: ObjectState, own: FieldState[]): ObjectDefinition["sellable"] {
  const declared = object.definition.sellable;
  if (!declared) return undefined;
  const nameOf = (local: string) => own.find((f) => f.localName === local)?.name ?? local;
  const opt = (local: string | undefined) => (local === undefined ? undefined : nameOf(local));
  const priceField = own.find((f) => f.localName === declared.price);
  const currency = declared.currency ?? priceField?.definition.currency;
  const { amount, balanceDue } = declared.deposit ?? {};
  const grants = declared.grants;
  return {
    price: nameOf(declared.price),
    ...(currency ? { currency } : {}),
    ...(declared.saleWindow
      ? {
          saleWindow: {
            from: opt(declared.saleWindow.from),
            until: opt(declared.saleWindow.until),
          },
        }
      : {}),
    ...(declared.maxPerOrder ? { maxPerOrder: nameOf(declared.maxPerOrder) } : {}),
    ...(amount && balanceDue
      ? { deposit: { amount: nameOf(amount), balanceDue: nameOf(balanceDue) } }
      : {}),
    ...(grants
      ? {
          grants: {
            object: grants.object.includes(".")
              ? grants.object
              : `${object.extensionId}.${grants.object}`,
            set: { ...grants.set },
            void: grants.void,
            ...(grants.valid ? { valid: { ...grants.valid } } : {}),
          },
        }
      : {}),
    ...(declared.onePerPerson ? { onePerPerson: nameOf(declared.onePerPerson) } : {}),
    // Paths (`class.classType.dropInPrice`) stay as declared: the host's path reader names each
    // part as the declaring extension's (ADR 0505); a field of the object is named here.
    ...(declared.moves
      ? {
          moves: {
            held: declared.moves.held,
            paid: declared.moves.paid,
            expired: declared.moves.expired,
            refund: [...(declared.moves.refund ?? [])],
            ...(declared.moves.price ? { price: { ...declared.moves.price } } : {}),
            ...(declared.moves.title ? { title: declared.moves.title } : {}),
            ...(declared.moves.order ? { order: nameOf(declared.moves.order) } : {}),
            ...(declared.moves.guest ? { guest: true } : {}),
            ...(declared.moves.holdCap ? { holdCap: { ...declared.moves.holdCap } } : {}),
          },
        }
      : {}),
    ...(declared.tax
      ? {
          tax: {
            code: declared.tax.code,
            ...(declared.tax.place
              ? {
                  place: {
                    ...declared.tax.place,
                    // Fields of the object itself are named by their registry names; a related
                    // record's own fields are named by their local names, which are the same.
                    ...(declared.tax.place.via
                      ? { via: nameOf(declared.tax.place.via) }
                      : {
                          country: nameOf(declared.tax.place.country),
                          region: opt(declared.tax.place.region),
                          postcode: opt(declared.tax.place.postcode),
                          city: opt(declared.tax.place.city),
                          line1: opt(declared.tax.place.line1),
                        }),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(declared.recurring
      ? {
          recurring: {
            interval: declared.recurring.interval,
            trialDays: opt(declared.recurring.trialDays),
            ...(declared.recurring.pause
              ? {
                  pause: {
                    minDays: opt(declared.recurring.pause.minDays),
                    maxDays: opt(declared.recurring.pause.maxDays),
                  },
                }
              : {}),
            ...(declared.recurring.grants
              ? {
                  grants: {
                    ...declared.recurring.grants,
                    object: declared.recurring.grants.object.includes(".")
                      ? declared.recurring.grants.object
                      : `${object.extensionId}.${declared.recurring.grants.object}`,
                    set: { ...declared.recurring.grants.set },
                    states: { ...declared.recurring.grants.states },
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Field registry

function registryField(field: FieldState, object: string): FieldDefinition {
  const spec = FIELD_TYPE_REGISTRY[field.type];
  const def = field.definition;
  const column = viewColumnName(field.extensionId, object, field.localName);
  const multi = spec.multi(def);
  const source = viewOf(object);
  const type: FieldType =
    field.type === "formula" ? formulaFilterType(def.resultType ?? "text") : spec.filterType(def);
  const options = {
    ...(def.options ? { choices: def.options } : {}),
    ...(def.editableOptions ? { editableOptions: true } : {}),
    ...(def.default !== undefined ? { default: def.default } : {}),
    ...(def.defaultSetting ? { defaultSetting: def.defaultSetting } : {}),
    ...(def.personApproves ? { personApproves: true } : {}),
    ...(def.to ? { to: def.to } : {}),
    ...(def.many !== undefined ? { many: def.many } : {}),
    // No currency of its own: the deployment's base currency applies (ADR 0101).
    ...(field.type === "currency" && def.currency ? { currency: def.currency } : {}),
    ...(field.type === "formula"
      ? { expression: def.expression ?? "", resultType: def.resultType ?? "text" }
      : {}),
    ...(def.min !== undefined ? { min: def.min } : {}),
    ...(def.max !== undefined ? { max: def.max } : {}),
    ...(def.step !== undefined ? { step: def.step } : {}),
    ...(field.type === "document" && def.schema
      ? { document: { schema: def.schema, maxBytes: def.maxBytes } }
      : {}),
    // Rich text is a document with the platform's schema (ADR 0440).
    ...(field.type === "richText" || field.type === "image" || field.type === "video"
      ? {
          document: {
            schema: documentSchemaOf(def) as unknown as Record<string, unknown>,
            maxBytes: documentMaxBytesOf(def),
          },
        }
      : {}),
  };
  return {
    name: field.name,
    label: def.label,
    type,
    ...(type === "enum" ? { enumValues: (def.options ?? []).map((o) => o.value) } : {}),
    ...(multi
      ? {
          related: {
            from: `${ident(source)} r2, json_each(r2.${column}) r`,
            link: "r2.id",
            column: "r.value",
          },
        }
      : { column }),
    // A document is read whole; its declared paths are what lists filter by.
    filterable: !isDocumentType(field.type),
    sortable: !multi && spec.sortable(def),
    ...(def.track ? { track: "timeline" as const } : {}),
    extension: field.extensionId,
    fieldType: field.type,
    options,
    ...(field.type === "formula" || def.readOnly ? { readOnly: true } : {}),
    ...(def.required ? { required: true } : {}),
    ...(def.description ? { description: def.description } : {}),
  };
}

const SYSTEM_FIELDS: FieldDefinition[] = [
  { name: "id", label: "ID", type: "id", column: "id", filterable: true, sortable: true },
  {
    name: "createdAt",
    label: "Created",
    type: "datetime",
    column: "created_at",
    filterable: true,
    sortable: true,
    readOnly: true,
  },
  {
    name: "updatedAt",
    label: "Updated",
    type: "datetime",
    column: "updated_at",
    filterable: true,
    sortable: true,
    readOnly: true,
  },
  {
    name: "createdBy",
    label: "Created by",
    type: "id",
    column: "created_by",
    filterable: true,
    sortable: false,
    readOnly: true,
  },
];

/** Builds the registry's extension objects (and extended core objects) from schema state. */
export function buildRegistry(state: SchemaState): Map<string, ObjectDefinition> {
  const map = new Map<string, ObjectDefinition>();
  const active = state.fields.filter((f) => f.status === "active");
  for (const [name, core] of Object.entries(CORE_OBJECTS)) {
    const extra = active
      .filter((f) => f.object === name)
      .flatMap((f) => [registryField(f, name), ...documentPathFields(f, name)]);
    if (extra.length) map.set(name, { ...core, fields: [...core.fields, ...extra] });
  }
  for (const object of state.objects) {
    if (object.status !== "active") continue;
    const own = active.filter(
      (f) => f.object === object.name && f.extensionId === object.extensionId,
    );
    const order = object.definition.fieldOrder;
    own.sort((a, b) => order.indexOf(a.localName) - order.indexOf(b.localName));
    const foreign = active.filter(
      (f) => f.object === object.name && f.extensionId !== object.extensionId,
    );
    const capacity = capacityDefinition(object, own);
    const sellable = sellableDefinition(object, own);
    const stock = stockDefinition(object, own);
    const allowance = allowanceDefinition(object);
    const publishable = object.definition.publishable;
    const fields = [
      ...SYSTEM_FIELDS,
      ...own.map((f) => registryField(f, object.name)),
      ...foreign.map((f) => registryField(f, object.name)),
      ...[...own, ...foreign].flatMap((f) => documentPathFields(f, object.name)),
      ...(capacity ? CAPACITY_FIELDS : []),
      ...(stock ? STOCK_FIELDS : []),
      ...(allowance?.kind === "holder" ? ALLOWANCE_FIELDS : []),
      ...(publishable ? PUBLISHED_FIELDS : []),
    ];
    map.set(object.name, {
      name: object.name,
      label: object.definition.label,
      plural: object.definition.plural,
      ...(object.definition.icon ? { icon: object.definition.icon } : {}),
      ...(object.definition.description ? { description: object.definition.description } : {}),
      titleField: object.definition.titleField,
      source: objectView(object.extensionId, object.localName),
      extension: object.extensionId,
      fields,
      defaultSort: { field: object.definition.titleField, direction: "asc" },
      ...(object.definition.navigation ? { navigation: object.definition.navigation } : {}),
      ...(object.definition.timelineLinks?.length
        ? { timelineLinks: object.definition.timelineLinks }
        : {}),
      ...(object.definition.stages ? { stages: object.definition.stages } : {}),
      ...(capacity ? { capacity } : {}),
      ...(sellable ? { sellable } : {}),
      ...(stock ? { stock } : {}),
      ...(allowance ? { allowance } : {}),
      ...(object.definition.agreements ? { agreements: object.definition.agreements } : {}),
      ...(object.definition.healthNotes ? { healthNotes: object.definition.healthNotes } : {}),
      ...(object.definition.states ? { states: object.definition.states } : {}),
      ...claimsDefinition(object, own),
      ...(object.definition.unique?.length ? { unique: object.definition.unique } : {}),
      ...recurringDefinition(object),
      ...staffedDefinition(object, own),
      ...checklistsDefinition(object, own),
      ...(object.definition.owner ? { ownerField: object.definition.owner } : {}),
      ...(object.definition.customer ? { customer: object.definition.customer } : {}),
      ...(object.definition.public ? { public: object.definition.public } : {}),
      ...(object.definition.signedIn ? { signedIn: object.definition.signedIn } : {}),
      ...(object.definition.customerVia ? { customerVia: object.definition.customerVia } : {}),
      ...(object.definition.access ? { access: object.definition.access } : {}),
      ...(publishable
        ? {
            publishable: {
              content: [...publishable.content],
              ...(publishable.slug ? { slug: publishable.slug } : {}),
              ...(publishable.date ? { date: publishable.date } : {}),
            },
          }
        : {}),
      ...(object.definition.navigationOrder !== undefined
        ? { navigationOrder: object.definition.navigationOrder }
        : {}),
      ...(object.definition.titleDefault ? { titleDefault: object.definition.titleDefault } : {}),
      ...(object.definition.requireOneOf?.length
        ? { requireOneOf: object.definition.requireOneOf }
        : {}),
    });
  }
  return map;
}

// ---------------------------------------------------------------------------------------------
// The per-isolate registry cache

/** Where a field's value is stored (for record operations). */
export interface FieldStorage {
  extension: string;
  table: string;
  /** Null for formula fields. */
  column: string | null;
  type: FieldTypeName;
  definition: FieldDefinitionJson;
  /** True when stored in the object's own table, false for a 1:1 side table. */
  own: boolean;
}

let cached: {
  stamp: string;
  objects: Map<string, ObjectDefinition>;
  storage: Map<string, FieldStorage>;
  tables: Map<string, string>;
} | null = null;

/** Storage of an active extension field, by object and registry field name. */
export function fieldStorage(object: string, field: string): FieldStorage | undefined {
  return cached?.storage.get(`${object}|${field}`);
}

/** The x_* table of an active extension object. */
export function objectTableOf(object: string): string | undefined {
  return cached?.tables.get(object);
}

/**
 * Loads the extension schema into the field registry (`getObject`). One cheap stamp query per
 * call; the state is re-read only when it changed. The pipeline calls this for every invocation.
 */
export async function refreshSchemaRegistry(db: Kysely<CoreDatabase>): Promise<void> {
  const row = await sql<{ stamp: string }>`
    SELECT (SELECT count(*) || ':' || coalesce(max(updated_at), '') || ':' || coalesce(max(id), 0) FROM core_extension_fields)
      || '/' || (SELECT count(*) || ':' || coalesce(max(updated_at), '') FROM core_extension_objects)
      || '/' || (SELECT count(*) || ':' || coalesce(max(updated_at), '') FROM core_field_options) AS stamp
  `.execute(db);
  const stamp = row.rows[0]?.stamp ?? "";
  if (cached?.stamp === stamp) return;
  const loaded = await loadSchemaState(db);
  const overrides = await db.selectFrom("core_field_options").selectAll().execute();
  const state = withEditedOptions(loaded, overrides);
  const objects = buildRegistry(state);
  const storage = new Map<string, FieldStorage>();
  for (const f of state.fields) {
    if (f.status !== "active") continue;
    const owner = state.objects.find((o) => o.name === f.object);
    storage.set(`${f.object}|${f.name}`, {
      extension: f.extensionId,
      table: f.tableName,
      column: f.columnName,
      type: f.type,
      definition: f.definition,
      own: owner?.tableName === f.tableName,
    });
  }
  const tables = new Map(
    state.objects.filter((o) => o.status === "active").map((o) => [o.name, o.tableName]),
  );
  cached = { stamp, objects, storage, tables };
  setExtensionObjects(objects);
  // How D1 names a declared uniqueness rule's columns when it refuses (ADR 0502).
  const keys = new Set<string>();
  for (const object of state.objects) {
    if (object.status !== "active") continue;
    for (const rule of object.definition.unique ?? []) {
      const columns = rule.fields.map(
        (local) =>
          state.fields.find(
            (f) =>
              f.object === object.name &&
              f.extensionId === object.extensionId &&
              f.localName === local &&
              f.status === "active",
          )?.columnName,
      );
      if (columns.every(Boolean)) {
        keys.add(columns.map((c) => `${object.tableName}.${c}`).join(", "));
      }
    }
  }
  setDeclaredUniqueKeys(keys);
}

/** One declared or edited option of a select field. */
export interface FieldOption {
  value: string;
  label: string;
  color?: string;
  requires?: string[];
  fixed?: boolean;
}

/**
 * The options a field with `editableOptions` has once an admin's edit is applied: the edited
 * list in its order (labels and colours as edited, `requires` and `fixed` as declared), then any
 * fixed option the edit lacks (a later release may add one).
 */
export function mergeOptions(
  declared: readonly FieldOption[],
  edited: readonly { value: string; label: string; color?: string | undefined }[] | null,
): FieldOption[] {
  if (!edited) return [...declared];
  const byValue = new Map(declared.map((o) => [o.value, o]));
  const merged: FieldOption[] = edited.map((o) => {
    const base = byValue.get(o.value);
    return {
      value: o.value,
      label: o.label,
      ...(o.color ? { color: o.color } : {}),
      ...(base?.requires?.length ? { requires: base.requires } : {}),
      ...(base?.fixed ? { fixed: true } : {}),
    };
  });
  const have = new Set(merged.map((o) => o.value));
  for (const option of declared) if (option.fixed && !have.has(option.value)) merged.push(option);
  return merged;
}

/** Applies admin-edited options (core_field_options) to fields declared with editableOptions. */
function withEditedOptions(
  state: SchemaState,
  overrides: { object_type: string; field: string; options: string }[],
): SchemaState {
  if (!overrides.length) return state;
  const byKey = new Map(overrides.map((o) => [`${o.object_type}|${o.field}`, o.options]));
  return {
    ...state,
    fields: state.fields.map((field) => {
      const edited = byKey.get(`${field.object}|${field.name}`);
      if (!edited || !field.definition.editableOptions) return field;
      const options = mergeOptions(
        (field.definition.options ?? []) as FieldOption[],
        JSON.parse(edited) as FieldOption[],
      );
      return {
        ...field,
        definition: { ...field.definition, options, declaredOptions: field.definition.options },
      };
    }),
  };
}

/** Forgets the cache (tests that rebuild state by hand). */
export function resetSchemaRegistry(): void {
  cached = null;
  setExtensionObjects(new Map());
}
