// The schema reconciler (ADR 0024): turns an extension's declared objects and fields into an
// ordered DDL plan over x_* tables plus the regenerated rec_* views, which can be dry-run
// (`extension.check`) and is applied atomically in one D1 batch with the state rows.
//
// Rules:
// - Additive changes (new objects, new fields) apply directly.
// - Renames need `renamedFrom`; without it a missing field is a removal.
// - Removals hide the field or object (data kept); dropping it is a separate, explicit call
//   (`planDropHidden`) once it has been hidden for 30 days.
// - Type changes are allowed only where lossless (LOSSLESS_TYPE_CHANGES); others are refused
//   with a suggestion.
// - It never touches core_* tables' schema. (Renaming an object re-points the object type of
//   its tags, links and search entries: data, not schema.)
import type { CoreDatabase } from "@composable-os/db";
import {
  type ExtensionManifest,
  type FieldManifest,
  type FieldTypeName,
  isLosslessChange,
  type ObjectManifest,
} from "@composable-os/sdk";
import { CompiledQuery, type Kysely, sql } from "kysely";
import { dropAllowanceStatements, termsSyncStatements } from "../allowance/index.ts";
import { releaseAllClaimsStatements } from "../capacity/claimants.ts";
import { backfillCounters, dropCapacityStatements } from "../capacity/records.ts";
import { FIELD_TYPE_REGISTRY } from "../fields/field-types.ts";
import { getObject } from "../fields/index.ts";
import { dropRecurringStatements } from "../recurring/bookkeeping.ts";
import { loadGeneralSettings, ORG_TIMEZONE_SETTING } from "../settings.ts";
import {
  type ClashRow,
  clashQuery,
  createStaffedTriggers,
  dropClaims,
  dropStaffedTriggers,
  resyncClaims,
  type StaffedTables,
} from "../staffing/sql.ts";
import { backfillStockCounters } from "../stock/index.ts";
import { orgReader, visibleSource } from "../visibility/index.ts";
import {
  columnName,
  ident,
  isCoreTarget,
  objectTable,
  objectView,
  registryFieldName,
  sideTable,
  splitObjectName,
} from "./naming.ts";
import {
  buildViews,
  type FieldState,
  loadSchemaState,
  type ObjectState,
  type SchemaState,
} from "./schema.ts";
import { seedStatements } from "./seed.ts";

export const HIDDEN_RETENTION_DAYS = 30;

export type SchemaChangeKind =
  | "create_object"
  | "rename_object"
  | "hide_object"
  | "restore_object"
  | "update_object"
  | "add_field"
  | "rename_field"
  | "hide_field"
  | "restore_field"
  | "update_field"
  | "change_type"
  | "drop_field"
  | "drop_object"
  | "add_index"
  | "drop_index"
  | "seed_records"
  | "skip_claims";

export interface SchemaChange {
  kind: SchemaChangeKind;
  object: string;
  field?: string;
  from?: string;
  detail?: string;
}

export interface ReconcileIssue {
  code:
    | "lossy_type_change"
    | "rename_conflict"
    | "hidden_conflict"
    | "unknown_target"
    | "formula"
    | "foreign_object"
    | "seed"
    | "unique_conflict"
    | "claims_conflict"
    | "grants_conflict"
    | "staffed_conflict";
  path: string;
  message: string;
  suggestion?: string;
}

export interface ReconcilePlan {
  extension: string;
  /** The schema DDL, in order (drop views → tables and columns → create views). For display. */
  ddl: string[];
  /** Everything to run in one batch: DDL and state-row writes. */
  statements: CompiledQuery[];
  changes: SchemaChange[];
  /** Refusals. A plan with issues must not be applied. */
  issues: ReconcileIssue[];
  /** The schema state after the plan. */
  next: SchemaState;
}

function clone(state: SchemaState): SchemaState {
  return structuredClone(state);
}

function columnDdl(name: string, type: FieldTypeName): string {
  const storage = FIELD_TYPE_REGISTRY[type].storage;
  if (!storage) throw new Error(`${type} fields have no column`);
  return `${ident(name)} ${storage}`;
}

/**
 * A state field's column defaults to the initial state (ADR 0425), so a column added to an object
 * that already has records is never empty. Other columns have no default.
 */
function stateDefault(object: ObjectManifest | undefined, field: string): string {
  const states = object?.states;
  return states?.field === field ? ` DEFAULT '${states.initial.replace(/'/g, "''")}'` : "";
}

/** The definition stored for a field (without volatile keys). */
function storedDefinition(field: FieldManifest): FieldManifest {
  const { renamedFrom: _renamed, ...rest } = field;
  return rest;
}

function sameDefinition(a: FieldManifest, b: FieldManifest): boolean {
  const { resultType: _a, ...left } = a as FieldManifest & { resultType?: string };
  const { resultType: _b, ...right } = b as FieldManifest & { resultType?: string };
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameStorage(a: FieldTypeName, b: FieldTypeName): boolean {
  return FIELD_TYPE_REGISTRY[a].storage === FIELD_TYPE_REGISTRY[b].storage;
}

const raw = (text: string) => CompiledQuery.raw(text);

/**
 * Plans reconciling `manifest` against the current state. Pure apart from reading state; nothing
 * is written. Apply with `applyPlan` (or queue `plan.statements` in an operation's batch).
 */
export async function planReconcile(
  db: Kysely<CoreDatabase>,
  manifest: ExtensionManifest,
  options: { now: string },
): Promise<ReconcilePlan> {
  const { timezone } = await loadGeneralSettings(db);
  const current = await loadSchemaState(db);
  const plan = planFromState(db, current, manifest, options.now, timezone);
  plan.issues.push(...(await dataIssues(db, current, plan.next, manifest.id, options.now, plan)));
  return plan;
}

/** A declared uniqueness rule's partial index (ADR 0502): its name, columns and condition. */
function uniqueIndexes(state: SchemaState, object: ObjectState, ext: string) {
  const out: { rule: number; name: string; columns: string[]; where: string }[] = [];
  (object.definition.unique ?? []).forEach((rule, i) => {
    const columnOf = (local: string) =>
      state.fields.find(
        (f) =>
          f.object === object.name &&
          f.extensionId === ext &&
          f.localName === local &&
          f.status === "active" &&
          f.tableName === object.tableName,
      )?.columnName ?? null;
    const columns = rule.fields.map(columnOf);
    const stateColumn =
      rule.states && object.definition.states ? columnOf(object.definition.states.field) : null;
    if (columns.some((c) => c === null) || (rule.states && !stateColumn)) return;
    const named = (columns as string[]).map((c) => ident(c));
    const filled = named.map((c) => `${c} IS NOT NULL`);
    const states = rule.states
      ? [`${ident(stateColumn as string)} IN (${rule.states.map(sqlString).join(", ")})`]
      : [];
    const where = ["deleted_at IS NULL", ...filled, ...states].join(" AND ");
    const name = ident(`${object.tableName}__${named.join("__")}__u${shortHash(where)}`);
    out.push({ rule: i, name, columns: named, where });
  });
  return out;
}

/**
 * Refusals that depend on the records already there (stage 31): a uniqueness rule the live
 * records already break (ADR 0502), and a claims declaration changed while records are in a
 * state it names, before or after (ADR 0501: their claims would be missing or never given back).
 * Each names the records to put right first.
 */
async function dataIssues(
  db: Kysely<CoreDatabase>,
  current: SchemaState,
  next: SchemaState,
  ext: string,
  at: string,
  plan: { changes: SchemaChange[] },
): Promise<ReconcileIssue[]> {
  const issues: ReconcileIssue[] = [];
  // Org-wide, through the seam: the installed object's view as the registry has it now.
  const reader = orgReader(db);
  // biome-ignore lint/suspicious/noExplicitAny: extension views are not in the typed schema.
  const anyDb = db as unknown as Kysely<any>;
  for (const object of next.objects) {
    if (object.extensionId !== ext || object.status !== "active") continue;
    const before = current.objects.find(
      (o) => o.name === object.name && o.tableName === object.tableName && o.status === "active",
    );
    const installed = getObject(object.name);
    if (!before || !installed) continue; // A new object has no records.
    const columnOf = (name: string | undefined) =>
      name ? installed.fields.find((f) => f.name === name)?.column : undefined;
    for (const index of uniqueIndexes(next, object, ext)) {
      if ((current.indexes ?? []).some((i) => i.name === index.name)) continue;
      const rule = object.definition.unique?.[index.rule];
      const columns = (rule?.fields ?? []).map(columnOf);
      if (!rule || columns.some((c) => !c)) continue; // A new field: no record has a value yet.
      const stateColumn = rule.states ? columnOf(object.definition.states?.field) : undefined;
      if (rule.states && !stateColumn) continue;
      let query = anyDb
        .selectFrom(visibleSource(reader, installed))
        .select(sql<string>`group_concat(id, ', ')`.as("ids"));
      for (const column of columns) query = query.where(column as string, "is not", null);
      if (rule.states && stateColumn) query = query.where(stateColumn, "in", [...rule.states]);
      const clash = (await query
        .groupBy(columns as string[])
        .having(sql`count(*)`, ">", 1)
        .limit(5)
        .execute()) as { ids: string }[];
      if (clash.length) {
        issues.push({
          code: "unique_conflict",
          path: `objects.${object.localName}.unique.${index.rule}`,
          message: `${object.name}: live records already share these values: ${clash.map((r) => r.ids).join("; ")}. Change or delete them first.`,
        });
      }
    }
    // A shift declaration over records that already put one person on two overlapping shifts
    // (imported data) is refused before its triggers are built, naming them (ADR 0621).
    // Shifts that clash and have both ended are not refused: the claim is not made for the later
    // one, and the plan says which (they happened before anything checked).
    const staffed = staffedTables(next, object);
    if (staffed && staffedColumnsExist(current, staffed)) {
      const seconds = Math.floor(Date.parse(at) / 1000);
      const clash = await sql.raw<ClashRow>(clashQuery(staffed, seconds)).execute(db);
      const named = async (r: ClashRow) =>
        `${await shiftLabel(db, r.object_type, r.record_id, r.starts)} and ${await shiftLabel(db, r.other_object, r.other, r.other_starts)}`;
      const live = clash.rows.filter((r) => Math.max(r.ends, r.other_ends) > seconds);
      if (live.length) {
        const names = await Promise.all(live.map(named));
        issues.push({
          code: "staffed_conflict",
          path: `objects.${object.localName}.staffed`,
          message: `${object.name}: these shifts put one person on two at once: ${names.join("; ")}. Change their person or time first.`,
        });
      } else if (clash.rows.length) {
        const names = await Promise.all(clash.rows.map(named));
        const total = Number(clash.rows[0]?.total ?? clash.rows.length);
        plan.changes.push({
          kind: "skip_claims",
          object: object.name,
          detail: `${total} past shift(s) overlapped another of their person's and claim no time: ${names.join("; ")}${total > names.length ? "; …" : ""}`,
        });
      }
    }
    // What a plan's subscriptions grant (ADR 0510) cannot be dropped or changed while a
    // subscription still running holds a record of it: its records would stop following it and
    // keep what they give for good. End those first, or keep the declaration.
    const grantsWas = before.definition.sellable?.recurring?.grants;
    const grantsNow = object.definition.sellable?.recurring?.grants;
    const grantKey = (g: typeof grantsWas) =>
      g
        ? JSON.stringify({
            object: g.object.includes(".") ? g.object : `${ext}.${g.object}`,
            states: g.states,
            from: g.from ?? null,
            until: g.until ?? null,
          })
        : null;
    if (grantsWas && grantKey(grantsWas) !== grantKey(grantsNow)) {
      const running = await db
        .selectFrom("core_subscription_grant as g")
        .innerJoin("core_subscription as s", "s.id", "g.subscription_id")
        .select(["s.id", "g.record_id"])
        .where("s.plan_object", "=", object.name)
        .where("s.state", "not in", ["ended", "expired"])
        .limit(10)
        .execute();
      if (running.length) {
        issues.push({
          code: "grants_conflict",
          path: `objects.${object.localName}.sellable.recurring.grants`,
          message: `${object.name}: what its subscriptions grant cannot be dropped or changed while subscriptions still running hold one (${running.map((r) => `${r.id} → ${r.record_id}`).join(", ")}). End them first, or keep the declaration.`,
        });
      }
    }
    const was = before.definition.claims;
    const now = object.definition.claims;
    // A waitlist added or changed holds no record's place (ADR 0520): only what holds and takes
    // places must not change under live records. Its holds are given back if it is dropped.
    const placesOf = (c: typeof was) =>
      c ? JSON.stringify({ on: c.on, held: c.held ?? [], confirmed: c.confirmed ?? [] }) : null;
    if (was?.waitlist && !now?.waitlist) {
      const holds = await anyDb
        .selectFrom("core_capacity_claim")
        .select("id")
        .where("for_type", "=", "waitlist")
        .where("for_id", "=", object.name)
        .where("state", "=", "held")
        .limit(1)
        .execute();
      if (holds.length) {
        issues.push({
          code: "claims_conflict",
          path: `objects.${object.localName}.claims.waitlist`,
          message: `${object.name}: its waitlist holds places for people waiting; it cannot be dropped until they are promoted or the holds are given back (within a minute of nobody waiting).`,
        });
      }
    }
    if (placesOf(was) === placesOf(now)) continue;
    const column = columnOf(object.definition.states?.field ?? before.definition.states?.field);
    const states = [
      ...new Set([
        ...(was?.held ?? []),
        ...(was?.confirmed ?? []),
        ...(now?.held ?? []),
        ...(now?.confirmed ?? []),
      ]),
    ];
    if (!column || !states.length) continue;
    const live = (await anyDb
      .selectFrom(visibleSource(reader, installed))
      .select("id")
      .where(column, "in", states)
      .limit(10)
      .execute()) as { id: string }[];
    if (live.length) {
      issues.push({
        code: "claims_conflict",
        path: `objects.${object.localName}.claims`,
        message: `${object.name}: claims cannot change while records are in a state it names (${states.join(", ")}): ${live.map((r) => r.id).join(", ")}. Move them out of those states first.`,
      });
    }
  }
  return issues;
}

export function planFromState(
  db: Kysely<CoreDatabase>,
  current: SchemaState,
  manifest: ExtensionManifest,
  now: string,
  /** The organisation's zone, for holders' terms written for the first time (ADR 0494). */
  orgZone = "UTC",
): ReconcilePlan {
  const ext = manifest.id;
  const next = clone(current);
  const tableDdl: string[] = [];
  const dataStatements: CompiledQuery[] = [];
  const changes: SchemaChange[] = [];
  const issues: ReconcileIssue[] = [];
  const seedWrites: CompiledQuery[] = [];
  const knownTables = new Set([
    ...current.objects.map((o) => o.tableName),
    ...current.fields.map((f) => f.tableName),
  ]);

  // Objects ---------------------------------------------------------------------------------
  const declaredObjects = new Set<string>();
  for (const [local, object] of Object.entries(manifest.objects)) {
    const name = `${ext}.${local}`;
    declaredObjects.add(name);
    const definition = {
      label: object.label,
      plural: object.plural,
      ...(object.icon ? { icon: object.icon } : {}),
      titleField: object.titleField,
      ...(object.description ? { description: object.description } : {}),
      fieldOrder: Object.keys(object.fields),
      ...(object.navigation ? { navigation: object.navigation } : {}),
      ...(object.indexes?.length ? { indexes: object.indexes } : {}),
      ...(object.timelineLinks?.length ? { timelineLinks: object.timelineLinks } : {}),
      ...(object.stages ? { stages: object.stages } : {}),
      ...(object.capacity ? { capacity: object.capacity } : {}),
      ...(object.sellable ? { sellable: object.sellable } : {}),
      ...(object.stock ? { stock: object.stock } : {}),
      ...(object.allowance ? { allowance: object.allowance } : {}),
      ...(object.agreements ? { agreements: object.agreements } : {}),
      ...(object.healthNotes ? { healthNotes: object.healthNotes } : {}),
      ...(object.states ? { states: object.states } : {}),
      ...(object.claims ? { claims: object.claims } : {}),
      ...(object.unique?.length ? { unique: object.unique } : {}),
      ...(object.recurring ? { recurring: object.recurring } : {}),
      ...(object.staffed ? { staffed: object.staffed } : {}),
      ...(object.checklists ? { checklists: object.checklists } : {}),
      ...(object.owner ? { owner: object.owner } : {}),
      ...(object.customer ? { customer: object.customer } : {}),
      ...(object.public ? { public: object.public } : {}),
      ...(object.signedIn ? { signedIn: object.signedIn } : {}),
      ...(object.customerVia ? { customerVia: object.customerVia } : {}),
      ...(object.access ? { access: object.access } : {}),
      ...(object.publishable ? { publishable: object.publishable } : {}),
      ...(object.navigationOrder !== undefined ? { navigationOrder: object.navigationOrder } : {}),
      ...(object.requireOneOf?.length ? { requireOneOf: object.requireOneOf } : {}),
      ...(object.titleDefault ? { titleDefault: object.titleDefault } : {}),
    };
    let existing = next.objects.find((o) => o.name === name);
    if (!existing && object.renamedFrom) {
      const oldName = `${ext}.${object.renamedFrom}`;
      const old = next.objects.find((o) => o.name === oldName);
      if (old) {
        const table = objectTable(ext, local);
        if (knownTables.has(table)) {
          issues.push({
            code: "rename_conflict",
            path: `objects.${local}.renamedFrom`,
            message: `Cannot rename ${oldName} to ${name}: table ${table} already exists`,
          });
          continue;
        }
        tableDdl.push(`ALTER TABLE ${ident(old.tableName)} RENAME TO ${table}`);
        for (const table of [
          "core_activity_links",
          "core_task_links",
          "core_record_tags",
          "core_search_docs",
        ]) {
          dataStatements.push(
            CompiledQuery.raw(`UPDATE ${table} SET object_type = ? WHERE object_type = ?`, [
              name,
              oldName,
            ]),
          );
        }
        for (const field of next.fields) {
          if (field.object === oldName) {
            field.object = name;
            if (field.tableName === old.tableName) field.tableName = table;
            field.updatedAt = now;
          }
        }
        old.name = name;
        old.localName = local;
        old.tableName = table;
        old.updatedAt = now;
        knownTables.add(table);
        changes.push({ kind: "rename_object", object: name, from: oldName });
        existing = old;
      }
    }
    if (existing) {
      if (existing.status === "hidden") {
        existing.status = "active";
        existing.hiddenAt = null;
        changes.push({ kind: "restore_object", object: name });
      }
      if (JSON.stringify(existing.definition) !== JSON.stringify(definition)) {
        changes.push({ kind: "update_object", object: name });
      }
      existing.definition = definition;
      existing.updatedAt = now;
      continue;
    }
    const table = objectTable(ext, local);
    const columns = Object.entries(object.fields)
      .filter(([, field]) => field.type !== "formula")
      .map(
        ([field, spec]) => columnDdl(columnName(field), spec.type) + stateDefault(object, field),
      );
    tableDdl.push(
      `CREATE TABLE ${table} (id TEXT PRIMARY KEY NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT, updated_by TEXT, deleted_at TEXT, deleted_by TEXT${columns.length ? `, ${columns.join(", ")}` : ""})`,
    );
    knownTables.add(table);
    next.objects.push({
      name,
      extensionId: ext,
      localName: local,
      tableName: table,
      status: "active",
      hiddenAt: null,
      definition,
      createdAt: now,
      updatedAt: now,
    });
    changes.push({ kind: "create_object", object: name });
    // Seed records are inserted once, with the table that holds them (ADR 0100).
    if (object.seed && Object.keys(object.seed).length) {
      const seeded = seedStatements(manifest, local, now);
      for (const issue of seeded.issues) issues.push({ code: "seed", ...issue });
      seedWrites.push(...seeded.statements);
      changes.push({
        kind: "seed_records",
        object: name,
        detail: `${Object.keys(object.seed).length} record(s)`,
      });
    }
    // Its fields are added below with columns already present.
    for (const [field, spec] of Object.entries(object.fields)) {
      next.fields.push({
        extensionId: ext,
        object: name,
        localName: field,
        name: field,
        tableName: table,
        columnName: spec.type === "formula" ? null : columnName(field),
        type: spec.type,
        definition: storedDefinition(spec),
        status: "active",
        hiddenAt: null,
        createdAt: now,
        updatedAt: now,
      });
      changes.push({ kind: "add_field", object: name, field });
    }
  }
  for (const object of next.objects) {
    if (object.extensionId !== ext || object.status !== "active") continue;
    if (!declaredObjects.has(object.name)) {
      object.status = "hidden";
      object.hiddenAt = now;
      object.updatedAt = now;
      changes.push({
        kind: "hide_object",
        object: object.name,
        detail: `Hidden; its records are kept and can be dropped after ${HIDDEN_RETENTION_DAYS} days`,
      });
    }
  }

  // Fields ----------------------------------------------------------------------------------
  const targets: [string, Record<string, FieldManifest>, string][] = [
    ...Object.entries(manifest.objects).map(
      ([local, o]) =>
        [`${ext}.${local}`, o.fields, `objects.${local}.fields`] as [
          string,
          Record<string, FieldManifest>,
          string,
        ],
    ),
    ...Object.entries(manifest.fields).map(
      ([target, fields]) =>
        [target, fields, `fields.${target}`] as [string, Record<string, FieldManifest>, string],
    ),
  ];
  const declaredFields = new Set<string>();
  for (const [target, fields, basePath] of targets) {
    const own = target.startsWith(`${ext}.`);
    if (!own) {
      if (!isCoreTarget(target)) {
        const parts = splitObjectName(target);
        const exists = next.objects.some((o) => o.name === target && o.status === "active");
        if (!parts || !exists) {
          issues.push({
            code: "unknown_target",
            path: basePath,
            message: `Cannot add fields to ${target}: no such object is installed`,
          });
          continue;
        }
      }
    }
    const table = own
      ? (next.objects.find((o) => o.name === target) as ObjectState).tableName
      : sideTable(ext, target);
    for (const [local, spec] of Object.entries(fields)) {
      const name = registryFieldName(ext, target, local);
      const path = `${basePath}.${local}`;
      declaredFields.add(`${target}|${name}`);
      const mine = (f: FieldState) => f.extensionId === ext && f.object === target;
      let existing = next.fields.find((f) => mine(f) && f.localName === local);
      if (existing && existing.createdAt === now && existing.updatedAt === now && own) {
        // Created with its object above.
        if (changes.some((c) => c.kind === "create_object" && c.object === target)) continue;
      }
      if (!existing && spec.renamedFrom) {
        const old = next.fields.find(
          (f) => mine(f) && f.localName === spec.renamedFrom && f.status === "active",
        );
        if (old) {
          if (old.columnName) {
            const column = columnName(local);
            tableDdl.push(
              `ALTER TABLE ${ident(old.tableName)} RENAME COLUMN ${ident(old.columnName)} TO ${column}`,
            );
            old.columnName = column;
          }
          changes.push({ kind: "rename_field", object: target, field: name, from: old.name });
          old.localName = local;
          old.name = name;
          old.updatedAt = now;
          existing = old;
        }
      }
      if (existing) {
        if (existing.status === "hidden") {
          if (
            !sameStorage(existing.type, spec.type) ||
            (existing.type === "formula") !== (spec.type === "formula")
          ) {
            issues.push({
              code: "hidden_conflict",
              path,
              message: `A removed ${existing.type} field named ${local} still holds data on ${target}`,
              suggestion: `Choose another name, or drop the hidden field first (extension.dropHidden)`,
            });
            continue;
          }
          existing.status = "active";
          existing.hiddenAt = null;
          changes.push({ kind: "restore_field", object: target, field: name });
        }
        if (existing.type !== spec.type) {
          const formulaSwap = (existing.type === "formula") !== (spec.type === "formula");
          const manyChange = (existing.definition.many ?? false) !== (spec.many ?? false);
          if (formulaSwap || manyChange || !isLosslessChange(existing.type, spec.type)) {
            issues.push({
              code: "lossy_type_change",
              path: `${path}.type`,
              message: `Changing ${target}.${name} from ${existing.type} to ${spec.type} could lose data`,
              suggestion: `Add a new ${spec.type} field (e.g. ${local}${spec.type[0]?.toUpperCase()}${spec.type.slice(1)}), copy the values with a tool, then remove ${local}`,
            });
            continue;
          }
          changes.push({
            kind: "change_type",
            object: target,
            field: name,
            detail: `${existing.type} → ${spec.type}`,
          });
          existing.type = spec.type;
        } else if ((existing.definition.many ?? false) !== (spec.many ?? false)) {
          issues.push({
            code: "lossy_type_change",
            path: `${path}.many`,
            message: `Changing ${target}.${name} between one and many could lose data`,
            suggestion: "Add a new relation field instead",
          });
          continue;
        } else if (!sameDefinition(existing.definition, storedDefinition(spec))) {
          changes.push({ kind: "update_field", object: target, field: name });
        }
        existing.definition = storedDefinition(spec);
        existing.updatedAt = now;
        continue;
      }
      // A new field.
      const column = spec.type === "formula" ? null : columnName(local);
      if (column) {
        if (!own && !knownTables.has(table)) {
          tableDdl.push(`CREATE TABLE ${table} (id TEXT PRIMARY KEY NOT NULL)`);
          knownTables.add(table);
        }
        if (next.fields.some((f) => f.tableName === table && f.columnName === column)) {
          issues.push({
            code: "rename_conflict",
            path,
            message: `Column ${column} already exists on ${table}`,
            suggestion: "Choose another field name",
          });
          continue;
        }
        const declaring = own ? manifest.objects[target.slice(ext.length + 1)] : undefined;
        tableDdl.push(
          `ALTER TABLE ${table} ADD COLUMN ${columnDdl(column, spec.type)}${stateDefault(declaring, local)}`,
        );
        // A time zone added to records that already exist is the deployment's zone, as a new
        // record's is (ADR 0460): no record is left without one, so a required zone never makes
        // an unrelated edit fail. The setting is read in the batch, so it is the zone then.
        if (spec.type === "timezone" && !spec.default) {
          dataStatements.push(
            CompiledQuery.raw(
              `UPDATE ${table} SET ${ident(column)} = COALESCE((SELECT json_extract(value, '$') FROM core_settings WHERE key = ?), 'UTC') WHERE ${ident(column)} IS NULL`,
              [ORG_TIMEZONE_SETTING],
            ),
          );
        }
      }
      next.fields.push({
        extensionId: ext,
        object: target,
        localName: local,
        name,
        tableName: table,
        columnName: column,
        type: spec.type,
        definition: storedDefinition(spec),
        status: "active",
        hiddenAt: null,
        createdAt: now,
        updatedAt: now,
      });
      changes.push({ kind: "add_field", object: target, field: name });
    }
  }
  for (const field of next.fields) {
    if (field.extensionId !== ext || field.status !== "active") continue;
    if (!declaredFields.has(`${field.object}|${field.name}`)) {
      const objectHidden = next.objects.some(
        (o) => o.name === field.object && o.status === "hidden",
      );
      if (objectHidden) continue;
      field.status = "hidden";
      field.hiddenAt = now;
      field.updatedAt = now;
      changes.push({
        kind: "hide_field",
        object: field.object,
        field: field.name,
        detail: `Hidden; its data is kept and can be dropped after ${HIDDEN_RETENTION_DAYS} days`,
      });
    }
  }

  // Indexes (ADR 0100): the reconciler owns indexes named `<table>__<column>[__<column>…]` on
  // the extension's own tables. Declared ones are created (live rows only), others dropped.
  for (const object of next.objects) {
    if (object.extensionId !== ext || object.status !== "active") continue;
    const wanted = new Map<string, string>();
    for (const fields of object.definition.indexes ?? []) {
      const columns = fields.map((field) => {
        if (field === "createdAt") return "created_at";
        if (field === "updatedAt") return "updated_at";
        const state = next.fields.find(
          (f) => f.object === object.name && f.extensionId === ext && f.localName === field,
        );
        return state?.columnName ?? null;
      });
      if (columns.some((c) => c === null)) continue;
      const name = ident(`${object.tableName}__${columns.join("__")}`);
      wanted.set(
        name,
        `CREATE INDEX IF NOT EXISTS ${name} ON ${ident(object.tableName)} (${columns.join(", ")}) WHERE deleted_at IS NULL`,
      );
    }
    // A slug is unique among the object's live records (stage 28, ADR 0442): the database
    // refuses a second one, whatever wrote it. A deleted record's slug can be taken again.
    for (const field of next.fields) {
      if (
        field.object !== object.name ||
        field.extensionId !== ext ||
        field.status !== "active" ||
        field.type !== "slug" ||
        !field.columnName ||
        field.tableName !== object.tableName
      ) {
        continue;
      }
      const column = ident(field.columnName);
      const name = ident(`${object.tableName}__${column}__unique`);
      wanted.set(
        name,
        `CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON ${ident(object.tableName)} (${column}) WHERE deleted_at IS NULL AND ${column} IS NOT NULL`,
      );
    }
    // Declared uniqueness (stage 31, ADR 0502): no two live records with the same values while
    // in the rule's states. A partial unique index, so the database refuses the second record
    // (or a move back into a counted state), whoever writes it and however many at once. Its
    // name carries a hash of the rule, so a changed rule is a new index.
    for (const index of uniqueIndexes(next, object, ext)) {
      wanted.set(
        index.name,
        `CREATE UNIQUE INDEX IF NOT EXISTS ${index.name} ON ${ident(object.tableName)} (${index.columns.join(", ")}) WHERE ${index.where}`,
      );
    }
    // A shift's person (ADR 0621): its holder's triggers find its shifts by it.
    const staffed = staffedTables(next, object);
    if (staffed) {
      const name = ident(`${object.tableName}__${staffed.who}`);
      wanted.set(
        name,
        `CREATE INDEX IF NOT EXISTS ${name} ON ${ident(object.tableName)} (${ident(staffed.who)}) WHERE deleted_at IS NULL`,
      );
    }
    const existing = (current.indexes ?? []).filter(
      (index) => index.table === object.tableName && index.name.startsWith(`${object.tableName}__`),
    );
    for (const index of existing) {
      if (wanted.has(index.name)) continue;
      tableDdl.push(`DROP INDEX IF EXISTS ${ident(index.name)}`);
      changes.push({ kind: "drop_index", object: object.name, detail: index.name });
    }
    for (const [name, ddl] of wanted) {
      if (existing.some((index) => index.name === name)) continue;
      tableDdl.push(ddl);
      changes.push({ kind: "add_index", object: object.name, detail: name });
    }
  }

  // The time claim (ADR 0621): the triggers keeping each shift's claim are dropped before the
  // table changes and built again after them, and every claim is derived again from the records.
  const staffed = staffedPlan(current, next, ext);
  return finishPlan(
    db,
    ext,
    current,
    next,
    [...staffed.drops, ...tableDdl, ...staffed.creates],
    [
      ...dataStatements,
      ...staffed.statements,
      ...seedWrites,
      ...capacityBackfill(next, ext, now),
      ...allowanceBackfill(next, ext, orgZone, now),
      ...exceptionCleanup(next, ext),
    ],
    changes,
    issues,
  );
}

function finishPlan(
  db: Kysely<CoreDatabase>,
  ext: string,
  current: SchemaState,
  next: SchemaState,
  tableDdl: string[],
  dataStatements: CompiledQuery[],
  changes: SchemaChange[],
  issues: ReconcileIssue[],
): ReconcilePlan {
  const views = buildViews(next);
  for (const { object, field, error } of views.errors) {
    const f = next.fields.find((x) => x.object === object && x.name === field);
    if (f?.extensionId !== ext) continue;
    issues.push({
      code: "formula",
      path: `${object}.${field}`,
      message: `${object}.${field}: ${error.message}`,
    });
  }
  for (const field of next.fields) {
    const type = views.formulaTypes.get(`${field.object}|${field.name}`);
    if (type) field.definition = { ...field.definition, resultType: type };
  }
  // Views are dropped before table DDL (SQLite checks views when tables are renamed) and
  // re-created after. Stale views of renamed objects are dropped too.
  const staleViews = current.objects
    .filter(
      (o) => !next.objects.some((n) => n.tableName === o.tableName && n.localName === o.localName),
    )
    .map((o) => `DROP VIEW IF EXISTS ${objectView(o.extensionId, o.localName)}`);
  const ddl = [...new Set([...staleViews, ...views.drops]), ...tableDdl, ...views.creates];

  const touched = new Set([
    ext,
    ...next.fields
      .filter((f) => changes.some((c) => c.object === f.object))
      .map((f) => f.extensionId),
  ]);
  const stateWrites: CompiledQuery[] = [];
  for (const extension of touched) {
    stateWrites.push(
      db.deleteFrom("core_extension_fields").where("extension_id", "=", extension).compile(),
      db.deleteFrom("core_extension_objects").where("extension_id", "=", extension).compile(),
    );
    for (const object of next.objects.filter((o) => o.extensionId === extension)) {
      stateWrites.push(
        db
          .insertInto("core_extension_objects")
          .values({
            name: object.name,
            extension_id: object.extensionId,
            local_name: object.localName,
            table_name: object.tableName,
            status: object.status,
            hidden_at: object.hiddenAt,
            definition: JSON.stringify(object.definition),
            created_at: object.createdAt,
            updated_at: object.updatedAt,
          })
          .compile(),
      );
    }
    const rows = next.fields.filter((f) => f.extensionId === extension);
    for (const field of rows) {
      stateWrites.push(
        db
          .insertInto("core_extension_fields")
          .values({
            extension_id: field.extensionId,
            object: field.object,
            local_name: field.localName,
            name: field.name,
            table_name: field.tableName,
            column_name: field.columnName,
            type: field.type,
            definition: JSON.stringify(field.definition),
            status: field.status,
            hidden_at: field.hiddenAt,
            created_at: field.createdAt,
            updated_at: field.updatedAt,
          })
          .compile(),
      );
    }
  }
  return {
    extension: ext,
    ddl,
    statements: [...ddl.map(raw), ...dataStatements, ...stateWrites],
    changes,
    issues,
    next,
  };
}

/**
 * Plans dropping extension `ext`'s hidden fields and objects that have been hidden for at least
 * `minAgeDays` (default 30). This destroys data; it is a separate, `destructive` call.
 */
export async function planDropHidden(
  db: Kysely<CoreDatabase>,
  ext: string,
  options: { now: string; minAgeDays?: number; only?: string[] },
): Promise<ReconcilePlan> {
  const current = await loadSchemaState(db);
  const next = clone(current);
  const cutoff = new Date(
    Date.parse(options.now) - (options.minAgeDays ?? HIDDEN_RETENTION_DAYS) * 86_400_000,
  ).toISOString();
  const due = (hiddenAt: string | null) => hiddenAt !== null && hiddenAt <= cutoff;
  const wanted = (name: string) => !options.only || options.only.includes(name);
  const tableDdl: string[] = [];
  const changes: SchemaChange[] = [];
  const droppedObjects = next.objects.filter(
    (o) => o.extensionId === ext && o.status === "hidden" && due(o.hiddenAt) && wanted(o.name),
  );
  for (const object of droppedObjects) {
    tableDdl.push(`DROP TABLE IF EXISTS ${ident(object.tableName)}`);
    changes.push({ kind: "drop_object", object: object.name });
  }
  next.objects = next.objects.filter((o) => !droppedObjects.includes(o));
  const droppedTables = new Set(droppedObjects.map((o) => o.tableName));
  const droppedFields = next.fields.filter(
    (f) =>
      f.extensionId === ext &&
      (droppedTables.has(f.tableName) ||
        (f.status === "hidden" && due(f.hiddenAt) && wanted(`${f.object}.${f.name}`))),
  );
  for (const field of droppedFields) {
    if (droppedTables.has(field.tableName)) continue;
    if (field.columnName) {
      tableDdl.push(`ALTER TABLE ${ident(field.tableName)} DROP COLUMN ${ident(field.columnName)}`);
    }
    changes.push({ kind: "drop_field", object: field.object, field: field.name });
  }
  next.fields = next.fields.filter((f) => !droppedFields.includes(f));
  // A side table left without columns is dropped with its last field.
  for (const table of new Set(droppedFields.map((f) => f.tableName))) {
    if (droppedTables.has(table)) continue;
    const isObjectTable = next.objects.some((o) => o.tableName === table);
    if (!isObjectTable && !next.fields.some((f) => f.tableName === table)) {
      tableDdl.push(`DROP TABLE IF EXISTS ${ident(table)}`);
    }
  }
  // Counters and claims of a dropped object go with its table (ADR 0431).
  // A stock object's counters and claims too (ADR 0680); its ledger stays, append-only.
  const capacityDrops = droppedObjects
    .filter((o) => o.definition.capacity || o.definition.stock)
    .flatMap((o) => dropCapacityStatements(o.name));
  // A dropped claimant gives back the places its records held and took (ADR 0501), and a
  // dropped series or generated object takes its recurring bookkeeping with it (ADR 0500).
  const claimantDrops = droppedObjects
    .filter((o) => o.definition.claims)
    .flatMap((o) => releaseAllClaimsStatements(o.name, options.now));
  const recurringDrops = droppedObjects.flatMap((o) => dropRecurringStatements(o.name));
  // A dropped holder's terms, periods and uses go with its table; a dropped spender's open uses
  // are given back first (ADR 0493).
  const allowanceDrops = droppedObjects.flatMap((o) => {
    const declared = o.definition.allowance;
    if (!declared) return [];
    return dropAllowanceStatements(o.name, "holds" in declared ? "holder" : "spender", options.now);
  });
  // What orders granted of a dropped object goes with its table (ADR 0435): the orders stay.
  const granted = new Set(
    current.objects.flatMap((o) => {
      const to = o.definition.sellable?.grants?.object;
      return to ? [to.includes(".") ? to : `${o.extensionId}.${to}`] : [];
    }),
  );
  const subscriptionGranted = new Set(
    current.objects.flatMap((o) => {
      const to = o.definition.sellable?.recurring?.grants?.object;
      return to ? [to.includes(".") ? to : `${o.extensionId}.${to}`] : [];
    }),
  );
  const grantDrops = droppedObjects.flatMap((o) => [
    ...(granted.has(o.name)
      ? [CompiledQuery.raw("DELETE FROM core_order_grant WHERE object_type = ?", [o.name])]
      : []),
    // What subscriptions granted of it (ADR 0510): the subscriptions stay.
    ...(subscriptionGranted.has(o.name)
      ? [CompiledQuery.raw("DELETE FROM core_subscription_grant WHERE object_type = ?", [o.name])]
      : []),
  ]);
  return finishPlan(
    db,
    ext,
    current,
    next,
    tableDdl,
    [...capacityDrops, ...claimantDrops, ...recurringDrops, ...allowanceDrops, ...grantDrops],
    changes,
    [],
  );
}

/**
 * A counter for every record of the extension's objects with a capacity that has none (ADR 0431):
 * records made before their object declared one, and seed records. Pools first, so a record's
 * counter can name its pool's. Records with counters are left alone.
 */
/**
 * Field exceptions (ADR 0620) of fields a series no longer copies: a field taken out of `copy` is
 * no longer the series' to write, so an exception on it means nothing and `recurring.follow`
 * would refuse to clear it. Deleted at each reconcile of the series' extension.
 */
function exceptionCleanup(state: SchemaState, ext: string): CompiledQuery[] {
  return state.objects.flatMap((object) => {
    const declared = object.definition.recurring;
    if (object.extensionId !== ext || object.status !== "active" || !declared) return [];
    const generated = `${ext}.${declared.generates}`;
    const copied = Object.keys(declared.copy ?? {});
    return [
      CompiledQuery.raw(
        `DELETE FROM core_recurrence_exception WHERE object_type = ?${copied.length ? ` AND field NOT IN (${copied.map(() => "?").join(", ")})` : ""}`,
        [generated, ...copied],
      ),
    ];
  });
}

function capacityBackfill(state: SchemaState, ext: string, now: string): CompiledQuery[] {
  // Stock objects' records each get a counter with nothing on hand (ADR 0680).
  const stocked = state.objects
    .filter((o) => o.extensionId === ext && o.status === "active" && o.definition.stock)
    .map((o) => backfillStockCounters({ object: o.name, table: ident(o.tableName), now }));
  const objects = state.objects.filter(
    (o) => o.extensionId === ext && o.status === "active" && o.definition.capacity,
  );
  const ordered = [
    ...objects.filter((o) => !o.definition.capacity?.pool),
    ...objects.filter((o) => o.definition.capacity?.pool),
  ];
  const statements: CompiledQuery[] = [...stocked];
  for (const object of ordered) {
    const capacity = object.definition.capacity;
    if (!capacity) continue;
    const column = (local: string) =>
      state.fields.find(
        (f) =>
          f.object === object.name &&
          f.extensionId === ext &&
          f.localName === local &&
          f.tableName === object.tableName,
      );
    const places = column(capacity.places);
    if (!places?.columnName) continue;
    const pool = capacity.pool ? column(capacity.pool) : undefined;
    statements.push(
      backfillCounters({
        object: object.name,
        table: ident(object.tableName),
        placesColumn: ident(places.columnName),
        pool:
          pool?.columnName && pool.definition.to
            ? { column: ident(pool.columnName), object: pool.definition.to }
            : undefined,
        now,
      }),
    );
  }
  return statements;
}

/**
 * Every holder's terms, derived again from its stored record (ADR 0494), for each of the
 * extension's objects that holds an allowance: records made before their object declared it, seed
 * records, and every record when the declaration changes (another uses field, other live states).
 * Each keeps the zone it was given; one with none gets the organisation's.
 */
function allowanceBackfill(
  state: SchemaState,
  ext: string,
  orgZone: string,
  now: string,
): CompiledQuery[] {
  const statements: CompiledQuery[] = [];
  for (const object of state.objects) {
    const declared = object.definition.allowance;
    if (object.extensionId !== ext || object.status !== "active") continue;
    if (!declared || !("holds" in declared)) continue;
    const h = declared.holds;
    const field = (local: string | undefined) =>
      local === undefined
        ? undefined
        : state.fields.find(
            (f) =>
              f.object === object.name &&
              f.extensionId === ext &&
              f.localName === local &&
              f.tableName === object.tableName &&
              f.status === "active",
          );
    const column = (local: string) => {
      const found = field(local);
      return found?.columnName ? ident(found.columnName) : undefined;
    };
    const person = column(h.person);
    const uses = column(h.uses);
    const per = typeof h.per === "string" ? { fixed: h.per } : { column: column(h.per.field) };
    const stateColumn = object.definition.states
      ? column(object.definition.states.field)
      : undefined;
    if (!person || !uses || (!per.fixed && !per.column)) continue;
    const bound = (local: string | undefined) => {
      const found = field(local);
      return found?.columnName
        ? { column: ident(found.columnName), date: found.type === "date" }
        : undefined;
    };
    statements.push(
      ...termsSyncStatements(
        {
          object: object.name,
          table: ident(object.tableName),
          person,
          uses,
          per: per.fixed ? { fixed: per.fixed } : { column: per.column as string },
          from: bound(h.from),
          until: bound(h.until),
          zone: h.zone ? column(h.zone) : undefined,
          live: h.live && stateColumn ? { column: stateColumn, states: h.live } : undefined,
          emptyIsUnlimited: h.emptyIsUnlimited === true,
        },
        "all",
        orgZone,
        now,
      ),
    );
  }
  return statements;
}

/** A shift as a reconcile message names it: its title and its start (UTC). */
async function shiftLabel(
  db: Kysely<CoreDatabase>,
  objectName: string,
  id: string,
  starts: number,
): Promise<string> {
  const object = getObject(objectName);
  const column = object?.fields.find((f) => f.name === object.titleField)?.column;
  const source = object ? visibleSource(orgReader(db), object) : undefined;
  let title: string | null = null;
  if (column && source) {
    // biome-ignore lint/suspicious/noExplicitAny: extension views are not in the typed schema.
    const row = (await (db as unknown as Kysely<any>)
      .selectFrom(source)
      .select(`${column} as title`)
      .where("id", "=", id)
      .executeTakeFirst()) as { title?: unknown } | undefined;
    title = typeof row?.title === "string" && row.title ? row.title : null;
  }
  const when = new Date(starts * 1000).toISOString().slice(0, 16).replace("T", " ");
  return `${title ?? object?.label ?? "a shift"} (${when} UTC)`;
}

/**
 * The tables and columns a staffed object's claim is derived from (staffing/sql.ts), from a schema
 * state, or null when the object declares no `staffed` or a field it names has no column.
 */
function staffedTables(state: SchemaState, object: ObjectState): StaffedTables | null {
  const declared = object.definition.staffed;
  const states = object.definition.states;
  if (!declared || !states) return null;
  const field = (o: ObjectState, local: string) =>
    state.fields.find(
      (f) =>
        f.object === o.name &&
        f.extensionId === o.extensionId &&
        f.localName === local &&
        f.tableName === o.tableName &&
        f.status === "active",
    );
  const who = field(object, declared.who.field);
  const starts = field(object, declared.starts)?.columnName;
  const ends = field(object, declared.ends)?.columnName;
  const stateColumn = field(object, states.field)?.columnName;
  if (!who?.columnName || !starts || !ends || !stateColumn) return null;
  let account: StaffedTables["account"];
  if (declared.who.account) {
    const holder = state.objects.find((o) => o.name === who.definition.to && o.status === "active");
    const column = holder ? field(holder, declared.who.account)?.columnName : undefined;
    if (!holder || !column) return null;
    account = { table: holder.tableName, column };
  }
  const kind = field(object, declared.kind)?.columnName;
  return {
    object: object.name,
    table: object.tableName,
    who: who.columnName,
    ...(account ? { account } : {}),
    starts,
    ends,
    state: stateColumn,
    live: [...declared.live],
    ...(kind ? { kind } : {}),
  };
}

/** Whether every column `t` reads exists already (a field added in this plan has no records). */
function staffedColumnsExist(current: SchemaState, t: StaffedTables): boolean {
  const has = (table: string, column: string) =>
    current.fields.some((f) => f.tableName === table && f.columnName === column);
  return (
    [t.who, t.starts, t.ends, t.state].every((c) => has(t.table, c)) &&
    (!t.account || has(t.account.table, t.account.column))
  );
}

/**
 * What a reconcile of `ext` does to the time claim (ADR 0621): drop the triggers of every object
 * that declared `staffed` (by the names they had), build them again for every active object that
 * declares it, derive its claims again, and drop the claims of objects that no longer do.
 */
function staffedPlan(current: SchemaState, next: SchemaState, ext: string) {
  const drops: string[] = [];
  const creates: string[] = [];
  const statements: CompiledQuery[] = [];
  const was = current.objects.filter((o) => o.extensionId === ext && o.definition.staffed);
  for (const object of was) {
    const t = staffedTables(current, object);
    if (t) drops.push(...dropStaffedTriggers(t));
  }
  const now = new Set<string>();
  for (const object of next.objects) {
    if (object.extensionId !== ext || object.status !== "active") continue;
    const t = staffedTables(next, object);
    if (!t) continue;
    now.add(object.name);
    creates.push(...createStaffedTriggers(t));
    statements.push(...resyncClaims(t));
  }
  for (const object of was) {
    if (!now.has(object.name)) statements.push(dropClaims(object.name));
  }
  return { drops, creates, statements };
}

/** Applies a plan atomically (one D1 batch). Refuses plans with issues. */
export async function applyPlan(
  batch: (statements: CompiledQuery[]) => Promise<void>,
  plan: ReconcilePlan,
): Promise<void> {
  if (plan.issues.length) {
    throw new Error(
      `Refusing to apply a plan with issues: ${plan.issues.map((i) => i.message).join("; ")}`,
    );
  }
  await batch(plan.statements);
}

/** A SQL string literal (a declared state value in an index's WHERE clause). */
function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Eight hex digits naming a rule's index (FNV-1a): a changed rule is a new index. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
