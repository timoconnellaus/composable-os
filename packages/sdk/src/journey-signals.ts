// Journey signals (stage 53, ADR 0802): the moments about a Person a shipped pack names, that a
// journey can start or stop on ("membership started", "class attended"). A signal is a record of
// one of the pack's objects being created, or entering one of its declared states, and the field
// that names its Person. The host records, in the write's own batch, the last time each Person had
// each signal (`core_person_signal`); no pack code runs for it, and a pack cannot hook a write.
//
// This module is the contract's part: the declaration's shape and checks, and the pure rule the
// host uses to decide whether a write is the signal.
import { z } from "zod";

/** Most signals one extension declares. */
export const JOURNEY_SIGNALS_MAX = 12;

export interface JourneySignalSpec {
  /** For admins choosing a journey's entry or exit: "Membership started". */
  label: string;
  /** For admins: when it happens, in plain words. */
  description?: string;
  /** An object of this extension (`membership`). */
  object: string;
  /**
   * The relation field naming the Person it is about. Default: the object's customer field. A
   * record with it empty (a guest's held booking) is nobody's signal.
   */
  person?: string;
  /**
   * The states that are the signal: the record entering one of them. Left out, only creating a
   * record is (a membership started, whatever its first state).
   */
  enters?: readonly string[];
  /** Only a move out of one of these states counts (a trial ending: `from: ["trialing"]`). */
  from?: readonly string[];
  /** Whether a record created straight into a state in `enters` counts. Default true. */
  created?: boolean;
}

const NAME = /^[a-z][a-zA-Z0-9]{0,39}$/;
const state = z.string().min(1).max(64);

export const journeySignalSchema = z
  .object({
    label: z.string().min(1).max(80),
    description: z.string().max(300).optional(),
    object: z.string().min(1).max(30),
    person: z.string().min(1).max(40).optional(),
    enters: z.array(state).min(1).max(20).optional(),
    from: z.array(state).min(1).max(20).optional(),
    created: z.boolean().optional(),
  })
  .strict();
export type JourneySignalManifest = z.infer<typeof journeySignalSchema>;

export const journeySignalsManifestSchema = z.record(
  z.string().regex(NAME, "camelCase letters and digits, starting lowercase"),
  journeySignalSchema,
);

interface CheckObject {
  fields: Record<string, { type: string; to?: string | undefined; many?: boolean | undefined }>;
  states?: { field: string } | undefined;
  customer?: { field: string } | undefined;
}

interface CheckManifest {
  objects: Record<string, CheckObject>;
  journeySignals?: Record<string, JourneySignalManifest> | undefined;
}

/** The values a states field can hold: its select's options. */
function stateValues(object: CheckObject): Set<string> | null {
  const field = object.states ? object.fields[object.states.field] : undefined;
  const options = (field as { options?: readonly unknown[] } | undefined)?.options;
  if (!options) return null;
  return new Set(
    options.map((o) =>
      typeof o === "string" ? o : String((o as { value?: unknown }).value ?? ""),
    ),
  );
}

/** The contract's issues with a manifest's `journeySignals`. */
export function journeySignalIssues(manifest: CheckManifest): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const contract = (path: string, message: string) => issues.push({ path, message });
  const signals = manifest.journeySignals ?? {};
  if (Object.keys(signals).length > JOURNEY_SIGNALS_MAX) {
    contract("journeySignals", `At most ${JOURNEY_SIGNALS_MAX} journey signals`);
  }
  for (const [name, signal] of Object.entries(signals)) {
    const base = `journeySignals.${name}`;
    const object = manifest.objects[signal.object];
    if (!object) {
      contract(`${base}.object`, `"${signal.object}" is not an object of this extension`);
      continue;
    }
    const person = signal.person ?? object.customer?.field;
    if (!person) {
      contract(`${base}.person`, "Name the relation field that holds the Person it is about");
    } else {
      const field = object.fields[person];
      if (!field) contract(`${base}.person`, `"${person}" is not a field of ${signal.object}`);
      else if (field.type !== "relation" || field.to !== "person" || field.many) {
        contract(`${base}.person`, `"${person}" must be a relation to one person`);
      }
    }
    if (!signal.enters) {
      if (signal.from) contract(`${base}.from`, "from needs enters: the states it moves into");
      if (signal.created === false) {
        contract(`${base}.created`, "A signal that is not a create needs enters");
      }
      continue;
    }
    const values = stateValues(object);
    if (!values) {
      contract(`${base}.enters`, `${signal.object} declares no states`);
      continue;
    }
    for (const [key, list] of [
      ["enters", signal.enters],
      ["from", signal.from ?? []],
    ] as const) {
      list.forEach((value, i) => {
        if (!values.has(value)) {
          contract(`${base}.${key}.${i}`, `"${value}" is not a state of ${signal.object}`);
        }
      });
    }
  }
  return issues;
}

/** A position value as a record holds it (a select's value). */
function stateOf(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * Whether a write is the signal. `before` is the record's values before (null on create), `after`
 * as the write leaves it; `stateField` the object's states field, when it has one.
 */
export function journeySignalFires(
  signal: Pick<JourneySignalSpec, "enters" | "from" | "created">,
  stateField: string | undefined,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): boolean {
  const now = stateField ? stateOf(after[stateField]) : null;
  if (before === null) {
    if (signal.created === false) return false;
    if (!signal.enters) return true;
    return now !== null && signal.enters.includes(now);
  }
  if (!signal.enters || !stateField || now === null) return false;
  const was = stateOf(before[stateField]);
  if (was === now || !signal.enters.includes(now)) return false;
  return !signal.from || (was !== null && signal.from.includes(was));
}
