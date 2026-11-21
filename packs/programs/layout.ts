// The layout of a program (stage 41, "The layout document"): one document, checked by the host
// against this schema on every write by every actor (ADR 0445). The same schema serves a class
// program with levels and a client program with typed sets: there is one layout.
//
//   program → weeks → sessions (a name, a focus, a day of its week, a warm-up)
//           → blocks (a label, rounds, notes) → items (a label such as A1)
//
// An item is for everyone (`kind: "all"`: one or more bank exercises done together) or has
// levels (`kind: "levels"`: up to five, possibly sparse, each one exercise, several done
// together, or alternatives). Each exercise is a bank exercise (a ref the host checks is a live
// `programs.exercise`) with typed sets (reps, time or a hold, with load, tempo and rest) and a
// free-text note in the coach's words. A note on a session, block or item is for coaches only
// unless marked `members: true`; the host removes the others from what a member reads.
//
// A generated session carries its own slice of the layout (SESSION_PLAN_SCHEMA): the session
// node and the definitions it uses, so a session is read in one record and keeps the version it
// was made from.
import type {
  DocumentNode,
  DocumentObjectNode,
  DocumentSchema,
  DocumentUnionNode,
} from "@composable-os/sdk";

const LOAD = {
  type: "number",
  min: 0,
  max: 1000,
  step: 0.25,
  optional: true,
  description: "Kilograms, added to the body",
} as const;
const TEMPO = {
  type: "text",
  min: 4,
  max: 4,
  chars: "0123456789X",
  optional: true,
  description: "Four characters, down-pause-up-pause: 32X1",
} as const;
const REST = {
  type: "number",
  min: 0,
  max: 1800,
  integer: true,
  optional: true,
  description: "Seconds of rest after the set",
} as const;

/** One set's target: reps, a time, or holds. */
const SET: DocumentUnionNode = {
  type: "union",
  tag: "kind",
  description: "One set's target",
  variants: {
    reps: {
      type: "object",
      fields: {
        reps: { type: "number", min: 1, max: 999, integer: true },
        repsMax: {
          type: "number",
          min: 1,
          max: 999,
          integer: true,
          optional: true,
          description: "The top of a range: 8 to 12",
        },
        load: LOAD,
        tempo: TEMPO,
        rest: REST,
      },
    },
    time: {
      type: "object",
      fields: {
        seconds: { type: "number", min: 1, max: 7200, integer: true },
        load: LOAD,
        rest: REST,
      },
    },
    hold: {
      type: "object",
      fields: {
        seconds: { type: "number", min: 1, max: 600, integer: true, description: "Each hold" },
        holds: {
          type: "number",
          min: 2,
          max: 10,
          integer: true,
          optional: true,
          description: "Holds in the set (one when left out)",
        },
        load: LOAD,
        rest: REST,
      },
    },
  },
};

/** A bank exercise with its sets and the coach's words for it. */
const PRESCRIPTION: DocumentObjectNode = {
  type: "object",
  fields: {
    exercise: { type: "ref", to: "programs.exercise" },
    sets: { type: "array", min: 1, max: 12, of: { type: "use", def: "set" } },
    note: {
      type: "text",
      max: 300,
      optional: true,
      description: "The coach's wording beside the numbers: legs as straight as possible",
    },
  },
};

const NOTE: DocumentObjectNode = {
  type: "object",
  description: "For coaches only unless marked as shown to members",
  fields: {
    text: { type: "text", min: 1, max: 800, multiline: true },
    members: { type: "boolean", optional: true, description: "Shown to members" },
  },
  private: { unless: "members" },
};

const NOTES: DocumentNode = {
  type: "array",
  max: 10,
  optional: true,
  of: { type: "use", def: "note" },
};

const EXERCISES = (min: number) =>
  ({
    type: "array",
    min,
    max: 3,
    of: { type: "use", def: "prescription" },
  }) as const;

const LEVEL: DocumentUnionNode = {
  type: "union",
  tag: "mode",
  description: "One exercise, several done together, or alternatives",
  variants: {
    one: {
      type: "object",
      fields: {
        level: { type: "number", min: 1, max: 5, integer: true },
        exercise: { type: "use", def: "prescription" },
      },
    },
    together: {
      type: "object",
      fields: {
        level: { type: "number", min: 1, max: 5, integer: true },
        exercises: EXERCISES(2),
      },
    },
    alternatives: {
      type: "object",
      fields: {
        level: { type: "number", min: 1, max: 5, integer: true },
        exercises: EXERCISES(2),
      },
    },
  },
};

const ITEM: DocumentUnionNode = {
  type: "union",
  tag: "kind",
  variants: {
    all: {
      type: "object",
      description: "For everyone: one exercise, or several done together",
      fields: {
        label: { type: "text", min: 1, max: 6 },
        exercises: EXERCISES(1),
        notes: NOTES,
      },
    },
    levels: {
      type: "object",
      description: "Up to five levels, possibly sparse (only 1 and 5)",
      fields: {
        label: { type: "text", min: 1, max: 6 },
        levels: {
          type: "array",
          min: 1,
          max: 5,
          unique: "level",
          of: { type: "use", def: "level" },
        },
        notes: NOTES,
      },
    },
  },
};

const BLOCK: DocumentObjectNode = {
  type: "object",
  fields: {
    label: { type: "text", min: 1, max: 4, description: "A, B, …" },
    rounds: { type: "number", min: 1, max: 50, integer: true, optional: true },
    items: { type: "array", min: 1, max: 12, unique: "label", of: { type: "use", def: "item" } },
    notes: NOTES,
  },
};

/** A session of a week: what a generated session carries as its plan. */
const SESSION: DocumentObjectNode = {
  type: "object",
  fields: {
    name: { type: "text", min: 1, max: 60 },
    focus: { type: "text", max: 200, optional: true, description: "What the session is about" },
    day: {
      type: "number",
      min: 1,
      max: 7,
      integer: true,
      description: "Day of its week, 1 to 7: a session is dated from the start date with it",
    },
    warmup: {
      type: "object",
      optional: true,
      fields: {
        text: { type: "text", max: 1200, multiline: true, optional: true },
        exercises: {
          type: "array",
          max: 15,
          optional: true,
          of: { type: "use", def: "prescription" },
        },
      },
    },
    blocks: { type: "array", max: 10, unique: "label", of: { type: "use", def: "block" } },
    notes: NOTES,
  },
};

const DEFS: Record<string, DocumentNode> = {
  set: SET,
  prescription: PRESCRIPTION,
  note: NOTE,
  level: LEVEL,
  item: ITEM,
  block: BLOCK,
};

/** The most weeks a program has, and sessions a week: 52 × 14 sessions at most per assignment. */
export const MAX_WEEKS = 52;
export const MAX_SESSIONS_PER_WEEK = 14;

/** A program's layout: its weeks of sessions. */
export const LAYOUT_SCHEMA: DocumentSchema = {
  defs: { ...DEFS, session: SESSION },
  root: {
    type: "object",
    fields: {
      weeks: {
        type: "array",
        min: 1,
        max: MAX_WEEKS,
        of: {
          type: "object",
          fields: {
            label: { type: "text", max: 60, optional: true },
            sessions: {
              type: "array",
              max: MAX_SESSIONS_PER_WEEK,
              of: { type: "use", def: "session" },
            },
          },
        },
      },
      notes: NOTES,
    },
  },
};

/** One generated session's plan: a session of the layout, as the version had it. */
export const SESSION_PLAN_SCHEMA: DocumentSchema = { defs: DEFS, root: SESSION };

// --- The layout's shape, for the pack's tools -------------------------------------------------

export type SetTarget =
  | {
      kind: "reps";
      reps: number;
      repsMax?: number;
      load?: number;
      tempo?: string;
      rest?: number;
    }
  | { kind: "time"; seconds: number; load?: number; rest?: number }
  | { kind: "hold"; seconds: number; holds?: number; load?: number; rest?: number };
export interface Prescription {
  exercise: string;
  sets: SetTarget[];
  note?: string;
}
export interface Note {
  text: string;
  members?: boolean;
}
export type Level =
  | { mode: "one"; level: number; exercise: Prescription }
  | { mode: "together" | "alternatives"; level: number; exercises: Prescription[] };
export type Item =
  | { kind: "all"; label: string; exercises: Prescription[]; notes?: Note[] }
  | { kind: "levels"; label: string; levels: Level[]; notes?: Note[] };
export interface Block {
  label: string;
  rounds?: number;
  items: Item[];
  notes?: Note[];
}
export interface Session {
  name: string;
  focus?: string;
  day: number;
  warmup?: { text?: string; exercises?: Prescription[] };
  blocks: Block[];
  notes?: Note[];
}
export interface Layout {
  weeks: { label?: string; sessions: Session[] }[];
  notes?: Note[];
}

/** The exercises of a level, whatever its mode. */
export function levelExercises(level: Level): Prescription[] {
  return level.mode === "one" ? [level.exercise] : level.exercises;
}

/** Every prescription of a session, with the item label and level it is under. */
export function prescriptions(
  session: Session,
): { item: string; level: number | null; prescription: Prescription }[] {
  const out: { item: string; level: number | null; prescription: Prescription }[] = [];
  for (const block of session.blocks) {
    for (const item of block.items) {
      if (item.kind === "all") {
        for (const p of item.exercises)
          out.push({ item: item.label, level: null, prescription: p });
      } else {
        for (const level of item.levels) {
          for (const p of levelExercises(level)) {
            out.push({ item: item.label, level: level.level, prescription: p });
          }
        }
      }
    }
  }
  return out;
}
