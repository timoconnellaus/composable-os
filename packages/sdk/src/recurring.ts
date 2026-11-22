// The `recurring` behaviour (stage 31, ADR 0500): a record (a series: one line of a timetable)
// declares a weekly rule in local wall-clock time, and the host makes the dated records it
// generates (its classes) ahead of time. Its declaration, its manifest schema and its contract
// checks live here; the host's side is packages/core/src/recurring/.
import { z } from "zod";
import type { ExtensionManifest, FieldManifest, ObjectManifest } from "./manifest.ts";

/** The weekday values a rule's `weekdays` field must use (ISO order, Monday first). */
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** How far ahead the host makes records when a series does not say (days). */
export const RECURRING_HORIZON_DAYS = 56;
/** The most days ahead a series may ask for. */
export const RECURRING_HORIZON_MAX = 366;

/**
 * A weekly schedule that generates dated records (ADR 0500). The rule is kept in local
 * wall-clock time in the series' zone: 06:00 is 06:00 on both sides of a clock change. A local
 * time that does not exist on a change day (02:30 when clocks go forward) moves forward by the
 * gap; one that happens twice is the first of the two.
 *
 * - `generates` is another of this extension's objects, and `link` its relation field (one
 *   record, read-only) back to this object: the host sets it.
 * - `rule` names this object's fields: `weekdays` (a multiSelect whose option values are
 *   `mon`…`sun`), `time` (a text field, `HH:MM`), `length` (a number field, minutes), `from` and
 *   `until` (date fields; `until` empty for ongoing) and `zone` (a timezone field; empty is the
 *   organisation's zone).
 * - `into` names the generated object's fields the host fills: `starts` (datetime), `ends`
 *   (datetime, starts plus the length), `zone` (timezone) and `changed` (a read-only boolean the
 *   host sets when someone other than the host edits the record).
 * - `copy` maps generated fields to this object's fields copied onto each record (`{ coach:
 *   "coach" }`).
 * - `cancel` is the generated object's state the host moves a record to when a closure covers it
 *   or the series ends while places are claimed on it. The generated object declares `states`
 *   with a `host` move into it.
 * - `ended` (optional) is this object's select field and the values that mean the series has
 *   ended: nothing more is made, and its future records go.
 * - `closures` (optional) is another of this extension's objects whose records are date ranges
 *   (`from`, `until`, both date fields, inclusive) in which nothing is made and records already
 *   made are cancelled.
 * - `horizonDays` (default 56): how far ahead records are made.
 * - `horizonAtLeast` (optional): another of this extension's objects and a number field of it in
 *   days (a class type's booking window): the horizon is never less than the largest value any
 *   live record of it holds, so a class can be booked as soon as its window opens.
 *
 * Made records are never made twice (the host keys each on the series and its local date). A
 * record edited by staff (its time, copied fields or state) is never overwritten or made again;
 * a change of the series applies to the future records nobody edited.
 */
export interface RecurringScheduleSpec {
  generates: string;
  link: string;
  rule: {
    weekdays: string;
    time: string;
    length?: string;
    from: string;
    until?: string;
    zone?: string;
  };
  into: { starts: string; ends?: string; zone?: string; changed?: string };
  copy?: Readonly<Record<string, string>>;
  cancel: string;
  ended?: { field: string; in: readonly string[] };
  closures?: { object: string; from: string; until: string };
  horizonDays?: number;
  horizonAtLeast?: { object: string; field: string };
}

const fieldName = z.string().max(40);

export const recurringManifestSchema = z
  .object({
    generates: fieldName,
    link: fieldName,
    rule: z
      .object({
        weekdays: fieldName,
        time: fieldName,
        length: fieldName.optional(),
        from: fieldName,
        until: fieldName.optional(),
        zone: fieldName.optional(),
      })
      .strict(),
    into: z
      .object({
        starts: fieldName,
        ends: fieldName.optional(),
        zone: fieldName.optional(),
        changed: fieldName.optional(),
      })
      .strict(),
    copy: z
      .record(fieldName, fieldName)
      .refine((copy) => Object.keys(copy).length <= 20, "At most 20 copied fields")
      .optional(),
    cancel: z.string().min(1).max(100),
    ended: z
      .object({ field: fieldName, in: z.array(z.string().min(1).max(100)).min(1).max(20) })
      .strict()
      .optional(),
    closures: z
      .object({ object: fieldName, from: fieldName, until: fieldName })
      .strict()
      .optional(),
    horizonDays: z.number().int().min(1).max(RECURRING_HORIZON_MAX).optional(),
    horizonAtLeast: z.object({ object: fieldName, field: fieldName }).strict().optional(),
  })
  .strict();
export type RecurringScheduleManifest = z.infer<typeof recurringManifestSchema>;

/** Reports problems with `objects.<name>.recurring` through `contract`. */
export function checkObjectRecurring(
  m: ExtensionManifest,
  name: string,
  object: ObjectManifest,
  contract: (path: string, message: string) => void,
): void {
  const recurring = object.recurring;
  if (!recurring) return;
  const path = `objects.${name}.recurring`;
  const own = (o: ObjectManifest, local: string): FieldManifest | undefined =>
    Object.hasOwn(o.fields, local) ? o.fields[local] : undefined;
  const expect = (
    o: ObjectManifest,
    oName: string,
    at: string,
    local: string | undefined,
    types: readonly string[],
    what: string,
  ): FieldManifest | undefined => {
    if (local === undefined) return undefined;
    const field = own(o, local);
    if (!field || !types.includes(field.type) || field.many) {
      contract(at, `"${local}" must be ${what} of ${oName}`);
      return undefined;
    }
    return field;
  };

  const rule = recurring.rule;
  const weekdays = expect(
    object,
    name,
    `${path}.rule.weekdays`,
    rule.weekdays,
    ["multiSelect"],
    "a multiSelect field",
  );
  if (weekdays) {
    const values = (weekdays.options ?? []).map((o) => o.value);
    const wrong = values.filter((v) => !(WEEKDAYS as readonly string[]).includes(v));
    if (wrong.length || !values.length) {
      contract(
        `${path}.rule.weekdays`,
        `"${rule.weekdays}"'s options must be weekdays (${WEEKDAYS.join(", ")})`,
      );
    }
    if (weekdays.editableOptions) {
      contract(`${path}.rule.weekdays`, "The weekdays field cannot have editableOptions");
    }
  }
  expect(object, name, `${path}.rule.time`, rule.time, ["text"], "a text field (HH:MM)");
  expect(object, name, `${path}.rule.length`, rule.length, ["number"], "a number field (minutes)");
  expect(object, name, `${path}.rule.from`, rule.from, ["date"], "a date field");
  expect(object, name, `${path}.rule.until`, rule.until, ["date"], "a date field");
  expect(object, name, `${path}.rule.zone`, rule.zone, ["timezone"], "a timezone field");
  if (recurring.ended) {
    const field = expect(
      object,
      name,
      `${path}.ended.field`,
      recurring.ended.field,
      ["select"],
      "a select field",
    );
    const values = new Set((field?.options ?? []).map((o) => o.value));
    for (const value of recurring.ended.in) {
      if (field && !values.has(value)) {
        contract(`${path}.ended.in`, `"${value}" is not an option of ${recurring.ended.field}`);
      }
    }
  }

  const generatedName = recurring.generates;
  const generated = Object.hasOwn(m.objects, generatedName) ? m.objects[generatedName] : undefined;
  if (!generated || generatedName === name) {
    contract(`${path}.generates`, `"${generatedName}" must be another of this extension's objects`);
    return;
  }
  const link = own(generated, recurring.link);
  if (link?.type !== "relation" || link.many || link.to !== `${m.id}.${name}`) {
    contract(
      `${path}.link`,
      `"${recurring.link}" must be a relation field of ${generatedName} to ${m.id}.${name}`,
    );
  } else if (!link.readOnly) {
    contract(`${path}.link`, `"${recurring.link}" must be read-only: the host sets it`);
  }
  expect(
    generated,
    generatedName,
    `${path}.into.starts`,
    recurring.into.starts,
    ["datetime"],
    "a datetime field",
  );
  expect(
    generated,
    generatedName,
    `${path}.into.ends`,
    recurring.into.ends,
    ["datetime"],
    "a datetime field",
  );
  expect(
    generated,
    generatedName,
    `${path}.into.zone`,
    recurring.into.zone,
    ["timezone"],
    "a timezone field",
  );
  const changed = expect(
    generated,
    generatedName,
    `${path}.into.changed`,
    recurring.into.changed,
    ["boolean"],
    "a boolean field",
  );
  if (changed && !changed.readOnly) {
    contract(
      `${path}.into.changed`,
      `"${recurring.into.changed}" must be read-only: the host sets it`,
    );
  }
  const into = new Set<string>(Object.values(recurring.into));
  // The state is the host's to move and staff's to change; a series never copies one in.
  if (generated.states) into.add(generated.states.field);
  for (const [target, source] of Object.entries(recurring.copy ?? {})) {
    const to = own(generated, target);
    const from = own(object, source);
    if (!to || to.type === "formula" || into.has(target) || target === recurring.link) {
      contract(
        `${path}.copy.${target}`,
        `"${target}" must be a field of ${generatedName} the host does not already fill`,
      );
    } else if (
      !from ||
      from.type !== to.type ||
      Boolean(from.many) !== Boolean(to.many) ||
      from.to !== to.to
    ) {
      contract(
        `${path}.copy.${target}`,
        `"${source}" must be a field of ${name} of the same type as ${generatedName}.${target}`,
      );
    }
  }
  const states = generated.states;
  if (!states) {
    contract(
      `${path}.cancel`,
      `${generatedName} must declare states, with a host move into "${recurring.cancel}"`,
    );
  } else {
    const field = own(generated, states.field);
    if (!(field?.options ?? []).some((o) => o.value === recurring.cancel)) {
      contract(`${path}.cancel`, `"${recurring.cancel}" is not a state of ${generatedName}`);
    } else if (
      !states.moves.some((move) => move.to === recurring.cancel && move.by.includes("host"))
    ) {
      contract(
        `${path}.cancel`,
        `${generatedName} needs a move into "${recurring.cancel}" that the host may make`,
      );
    }
  }
  if (recurring.horizonAtLeast) {
    const h = recurring.horizonAtLeast;
    // One of this extension's objects, or another extension's object with a number field this
    // extension adds to it (a class type of Programs' carrying Bookings' window, ADR 0505).
    const added = h.object.includes(".") ? m.fields?.[h.object] : undefined;
    const target = added
      ? ({ fields: added } as unknown as ObjectManifest)
      : Object.hasOwn(m.objects, h.object)
        ? m.objects[h.object]
        : undefined;
    if (!target) {
      contract(
        `${path}.horizonAtLeast.object`,
        `"${h.object}" must be one of this extension's objects, or an object this extension adds fields to`,
      );
    } else {
      expect(
        target,
        h.object,
        `${path}.horizonAtLeast.field`,
        h.field,
        ["number"],
        "a number field (days)",
      );
    }
  }
  if (recurring.closures) {
    const c = recurring.closures;
    const closure = Object.hasOwn(m.objects, c.object) ? m.objects[c.object] : undefined;
    if (!closure || c.object === name || c.object === generatedName) {
      contract(
        `${path}.closures.object`,
        `"${c.object}" must be another of this extension's objects`,
      );
    } else {
      expect(closure, c.object, `${path}.closures.from`, c.from, ["date"], "a date field");
      expect(closure, c.object, `${path}.closures.until`, c.until, ["date"], "a date field");
    }
  }
}
