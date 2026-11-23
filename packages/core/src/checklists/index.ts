// Checklists (stage 45 step 4b, ADR 0650): a list of steps a business writes once, picked on
// something that happens (a duty, through a `checklist` field), and a **run** of it on each record
// that declares `checklists`, which its person ticks off.
//
// What the host holds here, for every actor:
// - **A run copies its template** when it is made (a day before it opens, by the minute cron, or by
//   the first tick if that comes sooner), so editing a template changes no run already made. One
//   run per record, ever.
// - **Whose run it is** is the record's person, kept current while the run is open: a shift
//   reassigned mid-run is continued by its new person, and each tick keeps who made it and for whom.
//   When the run closes its person is fixed.
// - **When it may be ticked**: from the record's opening time until its closing time and a grace
//   period after (2 hours, the spec's guess), read from the record as it is now, so a shift moved
//   moves its window. A record not live (cancelled, in the Trash) takes no ticks.
// - **Closing**: the person, or someone who rosters for them with why, marks it done once every
//   required step is ticked (the database refuses it otherwise); after its close and grace the host
//   closes an open run as missed (its record live) or cancelled (its record cancelled, in the
//   Trash or gone), and tells the rosterers of a missed one. A closed run never changes: the
//   database refuses every change of it and its ticks (migration 0815).
// - **Who reads how it went**: the run's person (now or when it closed, or anyone who ticked it)
//   and those who roster; never other staff, never an AI (the reads are a person's own, at the
//   screen). The tables are in no rec_* view.
//
// Every read here is set-based: one read per declaring object for its records, one for the runs,
// one for the ticks, one for the names; nothing is read per step or per record.
import type { CoreDatabase } from "@composable-os/db";
import { CompiledQuery, type Kysely, sql } from "kysely";
import { objectTableOf } from "../extensions/schema.ts";
import { getObject, listObjects } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import { jsonList } from "../records/common.ts";

/** A run is made this long before its record opens (guess: a day). */
export const MAKE_AHEAD_SECONDS = 86_400;
/** Ticks are taken until this long after a record closes (the spec's guess: 2 hours). */
export const GRACE_SECONDS = 7_200;
/** The most steps a checklist has. */
export const MAX_STEPS = 50;

/** One step of a run, as the template was when the run was made. */
export interface RunStep {
  text: string;
  required: boolean;
  /** Asks for a note: ticking it done needs one. */
  note: boolean;
}

export type RunState = "open" | "done" | "missed" | "cancelled";

/** An object that declares `checklists`, with the columns its rules read. */
export interface Declared {
  object: ObjectDefinition;
  table: string;
  who: string;
  opens: string;
  closes: string;
  state: string;
  live: readonly string[];
  title: string | null;
  zone: string | null;
  /** The template's column: on the record, or on what its relation `via` names. */
  template: { column: string; via?: { column: string; table: string } };
}

const column = (object: ObjectDefinition, field: string | undefined) =>
  (field && object.fields.find((f) => f.name === field)?.column) || null;

/** The declaring object's columns, or null when it declares none or a field has no column. */
export function declaredOf(objectName: string): Declared | null {
  const object = getObject(objectName);
  const def = object?.checklists;
  const table = def ? objectTableOf(objectName) : undefined;
  if (!object || !def || !table) return null;
  const who = column(object, def.who);
  const opens = column(object, def.opens);
  const closes = column(object, def.closes);
  const state = column(object, object.states?.field);
  if (!who || !opens || !closes || !state) return null;
  let template: Declared["template"];
  if (def.template.via) {
    const viaCol = column(object, def.template.via);
    const holder = def.template.viaObject ? getObject(def.template.viaObject) : undefined;
    const holderTable = holder ? objectTableOf(holder.name) : undefined;
    const col = holder ? column(holder, def.template.field) : null;
    if (!viaCol || !holderTable || !col) return null;
    template = { column: col, via: { column: viaCol, table: holderTable } };
  } else {
    const col = column(object, def.template.field);
    if (!col) return null;
    template = { column: col };
  }
  return {
    object,
    table,
    who,
    opens,
    closes,
    state,
    live: def.live,
    title: column(object, object.titleField),
    zone: column(object, object.staffed?.zone),
    template,
  };
}

/** Every object declaring `checklists`. */
export function declaredObjects(): Declared[] {
  const out: Declared[] = [];
  for (const object of listObjects()) {
    if (!object.checklists) continue;
    const d = declaredOf(object.name);
    if (d) out.push(d);
  }
  return out;
}

/** A record as its checklist reads it now. */
export interface RecordFacts {
  object: string;
  id: string;
  title: string;
  zone: string | null;
  account: string | null;
  /** Unix seconds. */
  opens: number | null;
  closes: number | null;
  /** In a live state and not in the Trash. */
  live: boolean;
  template: string | null;
}

const seconds = (value: unknown): number | null => {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};
const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

/** The SELECT list and FROM of a declaring object's records with their template (one read). */
function recordSelect(d: Declared) {
  const tpl = d.template.via
    ? sql`v.${sql.ref(d.template.column)}`
    : sql.ref(`t.${d.template.column}`);
  const join = d.template.via
    ? sql`LEFT JOIN ${sql.table(d.template.via.table)} v ON v.id = t.${sql.ref(d.template.via.column)} AND v.deleted_at IS NULL`
    : sql``;
  return sql`SELECT t.id AS id, t.${sql.ref(d.who)} AS who, t.${sql.ref(d.opens)} AS opens,
    t.${sql.ref(d.closes)} AS closes, t.${sql.ref(d.state)} AS state, t.deleted_at AS deleted,
    ${d.title ? sql`t.${sql.ref(d.title)}` : sql`NULL`} AS title,
    ${d.zone ? sql`t.${sql.ref(d.zone)}` : sql`NULL`} AS zone, ${tpl} AS template
    FROM ${sql.table(d.table)} t ${join}`;
}

interface RecordRow {
  id: string;
  who: string | null;
  opens: string | null;
  closes: string | null;
  state: string | null;
  deleted: string | null;
  title: string | null;
  zone: string | null;
  template: string | null;
}

function factsOf(d: Declared, r: RecordRow): RecordFacts {
  return {
    object: d.object.name,
    id: r.id,
    title: text(r.title) ?? d.object.label,
    zone: text(r.zone),
    account: text(r.who),
    opens: seconds(r.opens),
    closes: seconds(r.closes),
    live: r.deleted === null && r.state !== null && d.live.includes(r.state),
    template: text(r.template),
  };
}

/** The records `ids` of one declaring object as their checklists read them, by id. */
export async function recordFacts(
  db: Kysely<CoreDatabase>,
  d: Declared,
  ids: readonly string[],
): Promise<Map<string, RecordFacts>> {
  const out = new Map<string, RecordFacts>();
  if (!ids.length) return out;
  const rows = await sql<RecordRow>`${recordSelect(d)} WHERE t.id IN ${jsonList([
    ...new Set(ids),
  ])}`.execute(db);
  for (const r of rows.rows) out.set(r.id, factsOf(d, r));
  return out;
}

/** A template as a run copies it. */
export interface TemplateCopy {
  id: string;
  name: string;
  version: number;
  active: boolean;
  steps: RunStep[];
}

/** The templates `ids` with their steps (two reads), by id. */
export async function templateCopies(
  db: Kysely<CoreDatabase>,
  ids: readonly string[],
): Promise<Map<string, TemplateCopy>> {
  const out = new Map<string, TemplateCopy>();
  const unique = [...new Set(ids)];
  if (!unique.length) return out;
  const templates = await db
    .selectFrom("core_checklist")
    .select(["id", "name", "version", "active"])
    .where("id", "in", jsonList(unique))
    .execute();
  const steps = await db
    .selectFrom("core_checklist_step")
    .selectAll()
    .where("checklist_id", "in", jsonList(unique))
    .orderBy("checklist_id")
    .orderBy("position")
    .execute();
  for (const t of templates) {
    out.set(t.id, {
      id: t.id,
      name: t.name,
      version: t.version,
      active: t.active === 1,
      steps: [],
    });
  }
  for (const s of steps) {
    out.get(s.checklist_id)?.steps.push({
      text: s.text,
      required: s.required === 1,
      note: s.asks_note === 1,
    });
  }
  return out;
}

/** A run's steps as stored. */
export function stepsOf(json: string): RunStep[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((s) => {
      const step = (s ?? {}) as Record<string, unknown>;
      return {
        text: typeof step.text === "string" ? step.text : "",
        required: step.required === true,
        note: step.note === true,
      };
    });
  } catch {
    return [];
  }
}

/** The statement that makes a run, unless the record has one (it never fails on that). */
export function makeRunStatement(
  id: string,
  facts: RecordFacts,
  template: TemplateCopy,
  now: string,
): CompiledQuery {
  return CompiledQuery.raw(
    `INSERT INTO core_checklist_run (id, object_type, record_id, checklist_id, version, name, steps,
      account_id, opens, closes, state, made_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?
    WHERE NOT EXISTS (SELECT 1 FROM core_checklist_run WHERE object_type = ? AND record_id = ?)`,
    [
      id,
      facts.object,
      facts.id,
      template.id,
      template.version,
      template.name,
      JSON.stringify(template.steps),
      facts.account,
      facts.opens ?? 0,
      facts.closes ?? 0,
      now,
      facts.object,
      facts.id,
    ],
  );
}

/** Whether a template may give a new run: active, with steps. */
export const usable = (t: TemplateCopy | undefined): t is TemplateCopy =>
  t !== undefined && t.active && t.steps.length > 0 && t.steps.length <= MAX_STEPS;

/** Whether `now` (unix seconds) is inside a record's ticking window. */
export function inWindow(facts: Pick<RecordFacts, "opens" | "closes">, now: number): boolean {
  return (
    facts.opens !== null &&
    facts.closes !== null &&
    now >= facts.opens &&
    now <= facts.closes + GRACE_SECONDS
  );
}

/** Each staff account's name (one read). */
export async function namesOf(
  db: Kysely<CoreDatabase>,
  accounts: readonly (string | null | undefined)[],
): Promise<Map<string, string>> {
  const ids = [...new Set(accounts.filter((a): a is string => !!a))];
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const rows = await db
    .selectFrom("core_user")
    .select(["id", "name", "email"])
    .where("id", "in", jsonList(ids))
    .execute();
  for (const r of rows) out.set(r.id, r.name || r.email || "Someone");
  return out;
}

/** A new run's values, for `makeRunsStatement`. */
export function newRunValues(id: string, facts: RecordFacts, template: TemplateCopy, now: string) {
  return {
    id,
    object: facts.object,
    record: facts.id,
    checklist: template.id,
    version: template.version,
    name: template.name,
    steps: template.steps,
    account: facts.account,
    opens: facts.opens ?? 0,
    closes: facts.closes ?? 0,
    madeAt: now,
  };
}

/** The most bytes of runs one statement binds (well under D1's limit on a bound value). */
export const RUN_CHUNK_BYTES = 256 * 1024;

/**
 * The statements making many runs (the minute cron's), as few as fit `RUN_CHUNK_BYTES` each: each
 * run only where its record has none (so none fails on one made meanwhile).
 */
export function makeRunsStatements(
  runs: readonly ReturnType<typeof newRunValues>[],
): CompiledQuery[] {
  const out: CompiledQuery[] = [];
  let chunk: string[] = [];
  let size = 2;
  const flush = () => {
    if (!chunk.length) return;
    out.push(
      CompiledQuery.raw(
        `INSERT INTO core_checklist_run (id, object_type, record_id, checklist_id, version, name,
          steps, account_id, opens, closes, state, made_at)
        SELECT json_extract(j.value, '$.id'), json_extract(j.value, '$.object'),
          json_extract(j.value, '$.record'), json_extract(j.value, '$.checklist'),
          json_extract(j.value, '$.version'), json_extract(j.value, '$.name'),
          json_extract(j.value, '$.steps'), json_extract(j.value, '$.account'),
          json_extract(j.value, '$.opens'), json_extract(j.value, '$.closes'), 'open',
          json_extract(j.value, '$.madeAt')
        FROM json_each(?) j
        WHERE NOT EXISTS (SELECT 1 FROM core_checklist_run r
          WHERE r.object_type = json_extract(j.value, '$.object')
            AND r.record_id = json_extract(j.value, '$.record'))`,
        [`[${chunk.join(",")}]`],
      ),
    );
    chunk = [];
    size = 2;
  };
  for (const run of runs) {
    const json = JSON.stringify(run);
    const bytes = new TextEncoder().encode(json).length + 1;
    if (chunk.length && size + bytes > RUN_CHUNK_BYTES) flush();
    chunk.push(json);
    size += bytes;
  }
  flush();
  return out;
}

// --- Who may change what a checklist hangs on (ADR 0650, the review of PR #298) -------------------

/**
 * The fields of `object` that a `checklists` declaration names as its template: its own, or one of
 * the object a relation names (a duty's `checklist`, for its shifts). Which checklist staff are
 * asked to follow is a rosterer's to say, by every write path, where a pack declares who rosters.
 */
export function checklistTemplateFields(object: ObjectDefinition): string[] {
  const out: string[] = [];
  for (const o of listObjects()) {
    const def = o.checklists;
    if (!def) continue;
    if (def.template.via ? def.template.viaObject === object.name : o.name === object.name) {
      out.push(def.template.field);
    }
  }
  return [...new Set(out)];
}

/**
 * The statement marking a record's open, opened run as ended by `by` (someone who rosters, or the
 * host: the run then closes as cancelled) or by someone who does not (null: it closes as missed),
 * when the record leaves its live states; or clearing the mark when it comes back.
 */
export function endedStatement(
  object: string,
  id: string,
  ended: { at: string; by: string | null } | null,
  now: number,
): CompiledQuery {
  return ended
    ? CompiledQuery.raw(
        "UPDATE core_checklist_run SET ended_at = ?, ended_by = ? WHERE object_type = ? AND record_id = ? AND state = 'open' AND opens <= ?",
        [ended.at, ended.by, object, id, now],
      )
    : CompiledQuery.raw(
        "UPDATE core_checklist_run SET ended_at = NULL, ended_by = NULL WHERE object_type = ? AND record_id = ? AND state = 'open' AND ended_at IS NOT NULL",
        [object, id],
      );
}
