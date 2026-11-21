// Extension schema state (core_extension_objects / core_extension_fields), the field registry
// built from it, and the rec_* view SQL generated from it (ADR 0023, ADR 0024).
import type { CoreDatabase } from "@composable-os/db";
import {
  type CapacityManifest,
  type DocumentSchema,
  documentJsonPath,
  documentPathNode,
  type FieldManifest,
  type FieldTypeName,
  formulaTypeOf,
  type SellableManifest,
  type StagesManifest,
  type StatesManifest,
} from "@composable-os/sdk";
import {
  compileFormula,
  type FormulaEnvironment,
  FormulaError,
  type FormulaFieldRef,
} from "@composable-os/sdk/formula";
import { type Kysely, sql } from "kysely";
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
  states?: StatesManifest;
  owner?: string;
  /** The object's customer (ADR 0402), as declared. */
  customer?: { field: string; read: string[]; write: string[] };
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
  /** Versions of the content fields (ADR 0446), as declared. */
  publishable?: { content: string[] };
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
    if (object.definition.publishable) {
      const published = publishedView(object.name);
      columns.push(...published.columns);
      joins.push(...published.joins);
    }
    build.creates.push(
      `CREATE VIEW ${view} AS SELECT ${columns.join(", ")} FROM ${ident(object.tableName)} t${joins.length ? ` ${joins.join(" ")}` : ""} WHERE t.deleted_at IS NULL`,
    );
  }
  return build;
}

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
  const name = `'${object.replaceAll("'", "''")}'`;
  return {
    joins: [
      `LEFT JOIN core_publish_version pub ON pub.object_type = ${name} AND pub.record_id = t.id AND pub.current = 1`,
    ],
    columns: [
      `pub.version AS ${PUBLISHED_COLUMNS.publishedVersion}`,
      `pub.published_at AS ${PUBLISHED_COLUMNS.publishedAt}`,
    ],
  };
}

/** View columns of the published version: no declared field's column can start with `_`. */
export const PUBLISHED_COLUMNS = {
  publishedVersion: "_pub_version",
  publishedAt: "_pub_at",
} as const;

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
    filterable: field.type !== "document",
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
    const publishable = object.definition.publishable;
    const fields = [
      ...SYSTEM_FIELDS,
      ...own.map((f) => registryField(f, object.name)),
      ...foreign.map((f) => registryField(f, object.name)),
      ...[...own, ...foreign].flatMap((f) => documentPathFields(f, object.name)),
      ...(capacity ? CAPACITY_FIELDS : []),
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
      ...(object.definition.states ? { states: object.definition.states } : {}),
      ...(object.definition.owner ? { ownerField: object.definition.owner } : {}),
      ...(object.definition.customer ? { customer: object.definition.customer } : {}),
      ...(object.definition.public ? { public: object.definition.public } : {}),
      ...(object.definition.signedIn ? { signedIn: object.definition.signedIn } : {}),
      ...(object.definition.customerVia ? { customerVia: object.definition.customerVia } : {}),
      ...(publishable ? { publishable: { content: [...publishable.content] } } : {}),
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
