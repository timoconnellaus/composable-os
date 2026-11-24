// The stage behaviour (ADR 0100): what the record operations do when an object declares `stages`
// (Deals: a deal moves through its pipeline's stages). Stages are records an admin edits, so this
// is the data-driven form of a lifecycle; it runs on the transition engine it shares with
// `states` (records/transitions.ts, ADR 0425), inside record.create, record.update and the
// record CSV import, so it holds for every actor: people, MCP clients, Code Mode scripts and
// extensions.
//
// This file is the declaration's side of the engine. For a write it works out the record's stage
// after the write, then:
//   - defaults the stage (the group's first stage) and the group (the stage's group);
//   - refuses a stage outside the record's group (StageRuleError);
//   - tells the engine which fields the stage needs (the stage's own list plus
//     `requiredByType`), which refuses entering it while one is empty, with a structured error
//     naming the fields; a read-only one is a fact the host sets (ADR 0750), so no caller can
//     enter the stage before the host has recorded it;
//   - keeps the probability on the stage's default unless it was set by hand (the overridden
//     flag), sets the status from the stage type, and sets or clears the closed date.
// The engine records stage history (closes the current row, opens a new one) on the same batch
// and names the move for the timeline ("Moved to Proposal").
import { sql } from "kysely";
import { ValidationError } from "../errors.ts";
import { FIELD_TYPE_REGISTRY } from "../fields/field-types.ts";
import { getObject } from "../fields/index.ts";
import type { FieldDefinition, ObjectDefinition, StagesDefinition } from "../fields/types.ts";
import { type Reader, visibleSource } from "../visibility/index.ts";
import { viewColumnOf } from "./columns.ts";
import {
  type Lifecycle,
  type Mover,
  type Placement,
  ruleBase,
  TransitionRuleError,
  type TransitionWrite,
} from "./transitions.ts";

export type StageType = "open" | "won" | "lost";

/** A stage record as the behaviour needs it. */
export interface StageInfo {
  id: string;
  title: string;
  type: StageType;
  order: number | null;
  requiredFields: string[];
  probability: number | null;
  group: string | null;
}

/** Details of a refused write: which stage, and which fields it needs. */
export interface StageRuleDetails {
  /** `stage_move_not_permitted`: a customer tried to move a stage; `by` says who may. */
  rule: "stage_required_fields" | "stage_not_in_group" | "no_stage" | "stage_move_not_permitted";
  object: string;
  /** The first missing field (what a UI asks for first). */
  field: string;
  fields: string[];
  labels: string[];
  stage: { id: string; title: string; type: StageType } | null;
  /** `stage_move_not_permitted`: who may make the move. */
  by?: Mover[];
  /** `stage_required_fields`: the missing facts only the host sets (ADR 0750). */
  setByHost?: string[];
}

/** A write broke a stage rule. `code` is `invalid_input`; details say what to fix. */
export class StageRuleError extends TransitionRuleError {
  override name = "StageRuleError";
  constructor(message: string, details: StageRuleDetails) {
    super(message, details);
  }
}

/** Caches stage reads for one operation (an import touches the same few stages many times). */
export type StageCache = Map<string, StageInfo | null>;

function column(object: ObjectDefinition, field: string): string | null {
  const definition = object.fields.find((f) => f.name === field);
  return definition ? viewColumnOf(definition) : null;
}

function readValue(field: FieldDefinition | undefined, raw: unknown): unknown {
  if (!field?.fieldType) return raw ?? null;
  const type = field.fieldType as keyof typeof FIELD_TYPE_REGISTRY;
  return FIELD_TYPE_REGISTRY[type]?.fromStorage(raw ?? null) ?? raw ?? null;
}

function stageObjectOf(object: ObjectDefinition, stages: StagesDefinition): ObjectDefinition {
  const to = object.fields.find((f) => f.name === stages.field)?.options?.to;
  const target = to ? getObject(to) : undefined;
  if (!target) throw new ValidationError(`${object.name}: its stage object is not installed`);
  return target;
}

/** Reads stages by id (live records only), through the cache. */
export async function loadStages(
  ctx: Reader,
  stageObject: ObjectDefinition,
  stages: StagesDefinition,
  ids: readonly string[],
  cache: StageCache = new Map(),
): Promise<Map<string, StageInfo>> {
  const out = new Map<string, StageInfo>();
  const missing = [...new Set(ids)].filter((id) => {
    const hit = cache.get(id);
    if (hit) out.set(id, hit);
    return !cache.has(id);
  });
  if (missing.length) {
    const fieldOf = (name: string | undefined) =>
      name ? stageObject.fields.find((f) => f.name === name) : undefined;
    const rows = await sql<Record<string, unknown>>`
      SELECT * FROM ${visibleSource(ctx, stageObject)}
      WHERE id IN (SELECT value FROM json_each(${JSON.stringify(missing)}))
    `.execute(ctx.db);
    const titleColumn = stageObject.titleField ? column(stageObject, stageObject.titleField) : null;
    const get = (row: Record<string, unknown>, name: string | undefined) => {
      const field = fieldOf(name);
      const col = field ? viewColumnOf(field) : null;
      return col ? readValue(field, row[col]) : null;
    };
    for (const row of rows.rows) {
      const type = get(row, stages.stage.type);
      const required = get(row, stages.stage.requiredFields);
      const order = get(row, stages.stage.order);
      const probability = get(row, stages.stage.probability);
      const group = get(row, stages.stage.group);
      const info: StageInfo = {
        id: String(row.id),
        title: titleColumn ? String(row[titleColumn] ?? row.id) : String(row.id),
        type: type === "won" || type === "lost" ? type : "open",
        order: typeof order === "number" ? order : null,
        requiredFields: Array.isArray(required) ? required.map(String) : [],
        probability: typeof probability === "number" ? probability : null,
        group: typeof group === "string" ? group : null,
      };
      cache.set(info.id, info);
      out.set(info.id, info);
    }
    for (const id of missing) if (!out.has(id)) cache.set(id, null);
  }
  return out;
}

/** The first stage (by order) of a group, or of all stages when the behaviour has no groups. */
async function firstStage(
  ctx: Reader,
  stageObject: ObjectDefinition,
  stages: StagesDefinition,
  group: string | null,
): Promise<string | null> {
  const order = column(stageObject, stages.stage.order);
  const groupColumn = stages.stage.group ? column(stageObject, stages.stage.group) : null;
  if (!order) return null;
  const where = groupColumn ? sql`WHERE ${sql.ref(groupColumn)} = ${group}` : sql``;
  const row = await sql<{ id: string }>`
    SELECT id FROM ${visibleSource(ctx, stageObject)} ${where}
    ORDER BY ${sql.ref(order)} IS NULL, ${sql.ref(order)}, id LIMIT 1
  `.execute(ctx.db);
  return row.rows[0]?.id ?? null;
}

/**
 * The group named by the extension's `defaultGroupSetting` (its stored value, else its declared
 * default), by id or title (case-insensitive), or null.
 */
async function defaultGroup(
  ctx: Reader,
  object: ObjectDefinition,
  stages: StagesDefinition,
  group: string,
): Promise<string | null> {
  const setting = stages.defaultGroupSetting;
  const ext = object.extension;
  const to = object.fields.find((f) => f.name === group)?.options?.to;
  const groupObject = to ? getObject(to) : undefined;
  if (!setting || !ext || !groupObject?.titleField) return null;
  const [stored, installed] = await Promise.all([
    ctx.db
      .selectFrom("core_extension_settings")
      .select("value")
      .where("extension_id", "=", ext)
      .executeTakeFirst(),
    ctx.db
      .selectFrom("core_extensions")
      .select("manifest")
      .where("id", "=", ext)
      .executeTakeFirst(),
  ]);
  const value =
    (stored ? (JSON.parse(stored.value) as Record<string, unknown>)[setting] : undefined) ??
    (installed
      ? (JSON.parse(installed.manifest) as { settings?: Record<string, { default?: unknown }> })
          .settings?.[setting]?.default
      : undefined);
  if (typeof value !== "string" || !value.trim()) return null;
  const title = column(groupObject, groupObject.titleField);
  if (!title) return null;
  const row = await sql<{ id: string }>`
    SELECT id FROM ${visibleSource(ctx, groupObject)}
    WHERE id = ${value.trim()} OR lower(${sql.ref(title)}) = ${value.trim().toLowerCase()}
    ORDER BY id = ${value.trim()} DESC, id LIMIT 1
  `.execute(ctx.db);
  return row.rows[0]?.id ?? null;
}

/**
 * Who may move a record between stages (ADR 0425): staff, and platform code. A customer never
 * moves a record through a pipeline. Every caller of ADR 0100's "every actor" is staff.
 */
const STAGE_MOVERS: readonly Mover[] = ["staff", "host"];

/** Where a write leaves a record, with the stage record the values follow. */
interface StagePlacement extends Placement {
  stage: StageInfo;
}

const stageRef = (stage: StageInfo) => ({ id: stage.id, title: stage.title, type: stage.type });

/** `object`'s stage behaviour as the engine runs it. `cache` holds one operation's stage reads. */
export function stagesLifecycle(
  object: ObjectDefinition,
  stages: StagesDefinition,
  cache: StageCache = new Map(),
): Lifecycle<StagePlacement> {
  const group = stages.group;
  const refuse = (
    write: TransitionWrite,
    rule: StageRuleDetails["rule"],
    message: string,
    fields: string[],
    stage: StageInfo | null,
    by?: readonly Mover[],
  ) =>
    new StageRuleError(message, {
      ...ruleBase(write, rule, fields),
      rule,
      stage: stage ? stageRef(stage) : null,
      ...(by ? { by: [...by] } : {}),
    });

  return {
    form: "stages",
    field: stages.field,
    async place(write): Promise<StagePlacement | null> {
      const { ctx, before, written, after, has, set, labelOf } = write;
      const stageObject = stageObjectOf(object, stages);
      const beforeStage = (before?.[stages.field] as string | null | undefined) ?? null;
      let stageId = (after[stages.field] as string | null | undefined) ?? null;
      const groupChanged = Boolean(
        group && has(group) && written[group] !== (before?.[group] ?? null),
      );
      const stageWritten = has(stages.field);

      // Default the stage: a new record, or one moved to another group without naming a stage,
      // starts in the group's first stage.
      if (
        (!stageWritten && (before === null || groupChanged)) ||
        (stageWritten && stageId === null)
      ) {
        if (stageWritten && stageId === null && before !== null) {
          throw refuse(
            write,
            "no_stage",
            `${object.label} must be in a stage`,
            [stages.field],
            null,
          );
        }
        let groupId = group ? ((after[group] as string | null | undefined) ?? null) : null;
        if (group && !groupId && before === null && stages.defaultGroupSetting) {
          groupId = await defaultGroup(ctx, object, stages, group);
          if (groupId) set(group, groupId);
        }
        if (!group || groupId) {
          stageId = await firstStage(ctx, stageObject, stages, groupId);
          if (stageId) set(stages.field, stageId);
        }
      }
      if (!stageId) {
        if (before === null && !group) return null;
        throw refuse(
          write,
          "no_stage",
          group
            ? `Choose a ${labelOf(group).toLowerCase()} with at least one stage, or a stage`
            : `${object.label} needs a stage`,
          [group ?? stages.field],
          null,
        );
      }

      const loaded = await loadStages(
        ctx,
        stageObject,
        stages,
        beforeStage ? [stageId, beforeStage] : [stageId],
        cache,
      );
      const stage = loaded.get(stageId);
      if (!stage) {
        throw new ValidationError(`${labelOf(stages.field)}: no live stage with id ${stageId}`, {
          field: stages.field,
        });
      }

      // The stage must belong to the record's group; a record without one takes the stage's.
      if (group && stage.group) {
        const groupId = (after[group] as string | null | undefined) ?? null;
        if (groupId === null) set(group, stage.group);
        else if (groupId !== stage.group) {
          throw refuse(
            write,
            "stage_not_in_group",
            `${stage.title} is not a stage of this ${labelOf(group).toLowerCase()}`,
            [stages.field],
            stage,
          );
        }
      }

      const left = beforeStage ? (loaded.get(beforeStage) ?? null) : null;
      return {
        stage,
        fromId: beforeStage,
        from: left ? stageRef(left) : null,
        to: stageRef(stage),
        by: STAGE_MOVERS,
        requires: [...stage.requiredFields, ...(stages.requiredByType?.[stage.type] ?? [])],
        group: () => (group ? ((after[group] as string | null | undefined) ?? null) : stage.group),
      };
    },
    follow(write, { stage }, moved) {
      const { ctx, before, written, after, changed, set } = write;
      if (stages.status && (moved || after[stages.status] !== stage.type)) {
        set(stages.status, stage.type);
      }
      if (stages.closedDate && moved) {
        const field = object.fields.find((f) => f.name === stages.closedDate);
        const now = field?.fieldType === "datetime" ? ctx.now : ctx.now.slice(0, 10);
        set(stages.closedDate, stage.type === "open" ? null : now);
      }
      if (stages.probability) {
        const { field, overridden } = stages.probability;
        let isOverridden = before?.[overridden] === true;
        if (changed(overridden) && written[overridden] !== true) isOverridden = false;
        else if (changed(field)) {
          isOverridden = written[field] !== null && written[field] !== undefined;
        } else if (changed(overridden)) isOverridden = true;
        if (after[overridden] !== isOverridden) set(overridden, isOverridden);
        if (!isOverridden && after[field] !== stage.probability) set(field, stage.probability);
      }
    },
    refusal(write, refusal, placement) {
      return refuse(
        write,
        `stage_${refusal.rule}`,
        refusal.message,
        refusal.fields,
        placement.stage,
        refusal.rule === "move_not_permitted" ? placement.by : undefined,
      );
    },
  };
}
