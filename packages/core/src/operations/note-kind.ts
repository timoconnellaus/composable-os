// Note kinds and their templates (stage 56 step 2, ADR 0833).
//
//   note.kinds.list    staff (records:read): the kinds the composer offers, retired ones on request
//   note.kinds.save    staff (notes:manage): a new kind, or a change to one's name, levels, template
//   note.kinds.retire  staff (notes:manage), a person only: no longer offered, or offered again
//
// A kind is the business's words, not personal: every staff account reads the list. Who reads a
// note of it is its level, and the kind says where a note starts (`defaultLevel`) and how low it
// may ever be (`lowestLevel`); `activity.log` and `.update` hold every note to its kind's lowest
// (and migration 1232's triggers hold them against a kind changed meanwhile). A kind's levels are
// a person's: an AI acting for someone who holds `notes:manage` may draft a kind's name and
// template wording, and its write always waits for a person who holds it too (`alwaysReview`, and
// the approver checked at approval), never a level. A level raised or lowered on a kind applies to
// the notes written from then on; notes already written keep theirs.
//
// The kind `note` (key) is the kind of every note written without one, and of every note held
// before kinds: it stays at `staff` and is never retired, so a note written without a kind (the
// assistant's draft, an import) is read as notes always were.
import type { NoteKindSection, NoteLevel } from "@composable-os/db";
import { sql } from "kysely";
import { z } from "zod";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import type { Reader } from "../visibility/index.ts";
import { NOTE_LEVELS } from "../visibility/index.ts";

/** The kind of a note written without one (migration 1232). */
export const DEFAULT_NOTE_KIND = "nkd_note";
export const MAX_SECTIONS = 12;

export const LEVEL_RANK: Record<NoteLevel, number> = { staff: 0, coaches: 1, sensitive: 2 };

/** The levels a note of a kind may have: its lowest and every one above. */
export function levelsFrom(lowest: NoteLevel): NoteLevel[] {
  return NOTE_LEVELS.filter((level) => LEVEL_RANK[level] >= LEVEL_RANK[lowest]);
}

const levelEnum = z.enum(NOTE_LEVELS);

const sectionSchema = z.object({
  key: z.string(),
  label: z.string(),
  hint: z.string().nullable(),
  required: z.boolean(),
});

export const noteKindSchema = z.object({
  id: z.string(),
  /** The shipped kinds' stable key (`note`, `session`, `sensitive`, `from_client`); null for others. */
  key: z.string().nullable(),
  name: z.string(),
  defaultLevel: levelEnum,
  lowestLevel: levelEnum,
  /** The levels a note of it may have, lowest first: what the composer offers. */
  levels: z.array(levelEnum),
  sections: z.array(sectionSchema),
  filesAllowed: z.boolean(),
  evidence: z.boolean(),
  retentionYears: z.number().int().nullable(),
  active: z.boolean(),
  position: z.number().int(),
  updatedAt: z.string(),
});
export type NoteKind = z.infer<typeof noteKindSchema>;

interface NoteKindRow {
  id: string;
  key: string | null;
  name: string;
  default_level: NoteLevel;
  lowest_level: NoteLevel;
  sections: string;
  files_allowed: number;
  evidence: number;
  retention_years: number | null;
  active: number;
  position: number;
  updated_at: string;
}

function toKind(row: NoteKindRow): NoteKind {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    defaultLevel: row.default_level,
    lowestLevel: row.lowest_level,
    levels: levelsFrom(row.lowest_level),
    sections: JSON.parse(row.sections) as NoteKindSection[],
    filesAllowed: row.files_allowed === 1,
    evidence: row.evidence === 1,
    retentionYears: row.retention_years,
    active: row.active === 1,
    position: row.position,
    updatedAt: row.updated_at,
  };
}

function kinds(reader: Pick<Reader, "db">) {
  return reader.db
    .selectFrom("core_note_kind")
    .select([
      "id",
      "key",
      "name",
      "default_level",
      "lowest_level",
      "sections",
      "files_allowed",
      "evidence",
      "retention_years",
      "active",
      "position",
      "updated_at",
    ]);
}

export async function loadNoteKind(
  reader: Pick<Reader, "db">,
  id: string,
): Promise<NoteKind | null> {
  const row = await kinds(reader).where("id", "=", id).executeTakeFirst();
  return row ? toKind(row as NoteKindRow) : null;
}

/** A kind a new note, or a note moved to it, may take: one that is there and not retired. */
export async function requireUsableKind(reader: Pick<Reader, "db">, id: string): Promise<NoteKind> {
  const kind = await loadNoteKind(reader, id);
  if (!kind) throw new NotFoundError("noteKind", id);
  if (!kind.active) {
    throw new ValidationError("That kind of note is retired: pick another", {
      field: "kindId",
      rule: "note_kind_retired",
    });
  }
  return kind;
}

/** A level at or above the kind's lowest, or refused with why. */
export function assertKindLevel(kind: NoteKind, level: NoteLevel): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[kind.lowestLevel]) {
    throw new ValidationError(
      `A ${kind.name} note is kept at least to ${levelWords(kind.lowestLevel)}`,
      { field: "level", rule: "note_below_kind", lowestLevel: kind.lowestLevel },
    );
  }
}

function levelWords(level: NoteLevel): string {
  return level === "staff"
    ? "the staff"
    : level === "coaches"
      ? "the client's coaches"
      : "the people allowed to read sensitive notes";
}

// --- Filling a template --------------------------------------------------------------------------

export const filledSectionInput = z.object({
  key: z.string().min(1).max(40).describe("The template section's key"),
  text: z.string().max(20_000).describe("What the person wrote under it (Markdown)"),
});

/** A filled section as a note keeps it: its label as it was when written, so it reads alone. */
export interface FilledSection {
  key: string;
  label: string;
  text: string;
}

export const filledSectionSchema = z.object({
  key: z.string(),
  label: z.string(),
  text: z.string(),
});

/**
 * A note's sections filled from its kind's template, and the Markdown body made from them (what
 * every path that reads a note's body reads: the timeline, search and summaries for a `staff`
 * note). Unknown or repeated keys and an empty required section are refused.
 */
export function fillTemplate(
  kind: NoteKind,
  input: readonly { key: string; text: string }[],
): { sections: FilledSection[]; body: string } {
  if (!kind.sections.length) {
    throw new ValidationError(`A ${kind.name} note has no template: write it in its body`, {
      field: "sections",
      rule: "note_kind_no_template",
    });
  }
  const given = new Map<string, string>();
  for (const section of input) {
    if (!kind.sections.some((s) => s.key === section.key)) {
      throw new ValidationError(`${kind.name} has no section "${section.key}"`, {
        field: "sections",
        rule: "note_section_unknown",
      });
    }
    if (given.has(section.key)) {
      throw new ValidationError(`The section "${section.key}" is given twice`, {
        field: "sections",
        rule: "note_section_twice",
      });
    }
    given.set(section.key, section.text.trim());
  }
  const sections: FilledSection[] = [];
  for (const section of kind.sections) {
    const text = given.get(section.key) ?? "";
    if (section.required && !text) {
      throw new ValidationError(`Fill in "${section.label}"`, {
        field: "sections",
        rule: "note_section_required",
        section: section.key,
      });
    }
    if (text) sections.push({ key: section.key, label: section.label, text });
  }
  const body = sections.map((s) => `**${s.label}**\n\n${s.text}`).join("\n\n");
  return { sections, body };
}

/** A kind with a required section is written in its template, never as a body alone. */
export function assertNoRequiredSections(kind: NoteKind): void {
  const required = kind.sections.find((s) => s.required);
  if (required) {
    throw new ValidationError(`A ${kind.name} note is written in its sections: fill them in`, {
      field: "sections",
      rule: "note_section_required",
      section: required.key,
    });
  }
}

// --- Operations ----------------------------------------------------------------------------------

const kindId = z.string().startsWith("nkd_").max(64).describe("The kind (nkd_…)");

export const noteKindsList = defineOperation({
  name: "note.kinds.list",
  description:
    "The kinds of note the business keeps (Note, Session note, Sensitive, From the client and " +
    "its own), in the composer's order: each with its template's sections (label, hint, " +
    "required), the level a note of it starts at and the levels it may have. Retired kinds are " +
    "left out unless includeRetired. Read-only.",
  input: z.object({ includeRetired: z.boolean().default(false) }),
  output: z.object({ items: z.array(noteKindSchema) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    let query = kinds(ctx).orderBy("position").orderBy("name");
    if (!input.includeRetired) query = query.where("active", "=", 1);
    const rows = await query.execute();
    return { items: rows.map((row) => toKind(row as NoteKindRow)) };
  },
});

const sectionInput = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,39}$/)
    .optional()
    .describe("Keep a section's key when changing its label; a new section gets one"),
  label: z.string().trim().min(1).max(80),
  hint: z.string().trim().max(200).nullish().describe("A line under the label, as a prompt"),
  required: z.boolean().default(false),
});

/** A key from a label: `How it went` → `how_it_went`, unique among `taken`. */
function keyFor(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^(\d)/, "s_$1")
      .slice(0, 36) || "section";
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
  return key;
}

function templateOf(input: z.output<typeof sectionInput>[]): NoteKindSection[] {
  const given = input.flatMap((s) => (s.key ? [s.key] : []));
  if (new Set(given).size !== given.length) {
    throw new ValidationError("Two sections have the same key", {
      field: "sections",
      rule: "note_section_twice",
    });
  }
  const taken = new Set(given);
  return input.map((s) => {
    const key = s.key ?? keyFor(s.label, taken);
    taken.add(key);
    return {
      key,
      label: s.label,
      hint: s.hint?.trim() ? s.hint.trim() : null,
      required: s.required,
    };
  });
}

/** What a kind's write changes that only a person may: its levels. */
function assertWordingOnly(
  ctx: HandlerContext,
  before: Pick<NoteKind, "defaultLevel" | "lowestLevel"> | null,
  after: { defaultLevel: NoteLevel; lowestLevel: NoteLevel },
): void {
  if (ctx.actor === "human") return;
  const was = before ?? { defaultLevel: "staff", lowestLevel: "staff" };
  if (was.defaultLevel !== after.defaultLevel || was.lowestLevel !== after.lowestLevel) {
    throw new ForbiddenError(
      "Only a person sets who reads a kind of note: an AI may draft its name and template",
      { rule: "note_kind_level_person" },
    );
  }
}

export const noteKindsSave = defineOperation({
  name: "note.kinds.save",
  description:
    "Write a kind of note: a new one (no id), or a change to one's name, the level a note of it " +
    "starts at (defaultLevel), the lowest level a note of it may have (lowestLevel) and its " +
    "template (sections given whole and in order, at most 12: label, an optional hint, required). " +
    "A changed level applies to notes written from now on. Needs notes:manage. An assistant's or " +
    "MCP client's write always waits for a person who holds it too, and may change only the name " +
    "and the template: who reads a kind's notes is a person's to set.",
  input: z.object({
    id: kindId.optional().describe("The kind to change; empty: a new one"),
    name: z.string().trim().min(1).max(80),
    defaultLevel: levelEnum.optional().describe("Where a note of it starts. Default: staff"),
    lowestLevel: levelEnum.optional().describe("The lowest level a note of it may have"),
    sections: z.array(sectionInput).max(MAX_SECTIONS).default([]),
  }),
  output: noteKindSchema,
  permission: "notes:manage",
  risk: "write",
  actors: ["human", "assistant", "mcp"],
  // A draft waits for a person: what staff are asked to write never changes on an AI's word alone.
  alwaysReview: ["assistant", "mcp"],
  async handler(input, ctx) {
    const before = input.id ? await loadNoteKind(ctx, input.id) : null;
    if (input.id && !before) throw new NotFoundError("noteKind", input.id);
    const defaultLevel = input.defaultLevel ?? before?.defaultLevel ?? "staff";
    const lowestLevel = input.lowestLevel ?? before?.lowestLevel ?? "staff";
    assertWordingOnly(ctx, before, { defaultLevel, lowestLevel });
    if (LEVEL_RANK[defaultLevel] < LEVEL_RANK[lowestLevel]) {
      throw new ValidationError("A kind's notes cannot start below its lowest level", {
        field: "defaultLevel",
        rule: "note_kind_levels",
      });
    }
    if (before?.key === "note" && (defaultLevel !== "staff" || lowestLevel !== "staff")) {
      throw new ValidationError(
        "Note is the kind of every note written without one: it stays every staff account's. " +
          "Add a kind of your own for notes kept tighter",
        { field: "defaultLevel", rule: "note_kind_default" },
      );
    }
    const sections = templateOf(input.sections);
    const clash = await ctx.db
      .selectFrom("core_note_kind")
      .select("id")
      .where(sql<boolean>`lower(name) = lower(${input.name})`)
      .where("id", "!=", input.id ?? "")
      .executeTakeFirst();
    if (clash) {
      throw new ConflictError("There is already a kind of note with that name", {
        field: "name",
        rule: "note_kind_name",
      });
    }
    const id = input.id ?? newId("noteKind");
    const values = {
      name: input.name,
      default_level: defaultLevel,
      lowest_level: lowestLevel,
      sections: JSON.stringify(sections),
      updated_by: ctx.user.id,
      updated_at: ctx.now,
    };
    if (!before) {
      const last = await ctx.db
        .selectFrom("core_note_kind")
        .select(sql<number>`coalesce(max(position), -1)`.as("position"))
        .executeTakeFirst();
      ctx.write(
        ctx.db.insertInto("core_note_kind").values({
          id,
          ...values,
          position: (last?.position ?? -1) + 1,
          created_by: ctx.user.id,
          created_at: ctx.now,
        }),
      );
    } else {
      ctx.write(ctx.db.updateTable("core_note_kind").set(values).where("id", "=", id));
    }
    const snapshot = (k: Pick<NoteKind, "name" | "defaultLevel" | "lowestLevel" | "sections">) => ({
      name: k.name,
      defaultLevel: k.defaultLevel,
      lowestLevel: k.lowestLevel,
      sections: k.sections,
    });
    const after = snapshot({ name: input.name, defaultLevel, lowestLevel, sections });
    ctx.recordChange({
      object: "noteKind",
      id,
      action: before ? "update" : "create",
      ...(before ? { before: snapshot(before) } : {}),
      after,
    });
    return ctx.afterCommit(async () => {
      const kind = await loadNoteKind(ctx, id);
      if (!kind) throw new NotFoundError("noteKind", id);
      return kind;
    });
  },
});

export const noteKindsRetire = defineOperation({
  name: "note.kinds.retire",
  description:
    "Retire a kind of note (retired: true): the composer no longer offers it and its notes keep " +
    "it. retired: false offers it again. Note, the kind of a note written without one, is never " +
    "retired. Needs notes:manage; a person only.",
  input: z.object({ id: kindId, retired: z.boolean().default(true) }),
  output: noteKindSchema,
  permission: "notes:manage",
  risk: "destructive",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const before = await loadNoteKind(ctx, input.id);
    if (!before) throw new NotFoundError("noteKind", input.id);
    if (before.key === "note" && input.retired) {
      throw new ValidationError("Note is the kind of every note written without one: it stays", {
        field: "id",
        rule: "note_kind_default",
      });
    }
    const active = !input.retired;
    if (before.active !== active) {
      ctx.write(
        ctx.db
          .updateTable("core_note_kind")
          .set({ active: active ? 1 : 0, updated_by: ctx.user.id, updated_at: ctx.now })
          .where("id", "=", input.id),
      );
      ctx.recordChange({
        object: "noteKind",
        id: input.id,
        action: "update",
        before: { active: before.active },
        after: { active },
      });
    }
    return ctx.afterCommit(async () => {
      const kind = await loadNoteKind(ctx, input.id);
      if (!kind) throw new NotFoundError("noteKind", input.id);
      return kind;
    });
  },
});

export const noteKindOperations = [noteKindsList, noteKindsSave, noteKindsRetire] as const;
