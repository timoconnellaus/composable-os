// The `allowance` behaviour (stage 32b, ADRs 0493 and 0494): a record that holds a number of uses
// (a pass, a membership), and a record that spends one (a booking, a visit). The host keeps the
// count and refuses, in the database, a spend past it in the spender's own batch, for every actor.
// Its declaration, its manifest schema and its contract checks live here; the host's side is
// packages/core/src/allowance/.
import { z } from "zod";
import type { ExtensionManifest, FieldManifest, ObjectManifest } from "./manifest.ts";

/** What a holder's uses are counted over. Weeks start on Monday; both in the holder's zone. */
export const ALLOWANCE_PERIODS = ["total", "week", "month"] as const;
export type AllowancePeriod = (typeof ALLOWANCE_PERIODS)[number];

/**
 * The read-only values the host adds to every record of a holder object: uses spent in the
 * current period, and uses left now (0 when the holder cannot be spent now; empty when
 * unlimited). A holder object cannot have fields of these names.
 */
export const ALLOWANCE_VALUES = ["used", "left"] as const;

/**
 * One condition a spender's record must meet to be paid by a holder. `field` is a field of the
 * spender (one the host copies onto it, such as a class type or a local time: see `copy` and
 * `local`); exactly one of `in`, `atLeast` and `below` compares it.
 *
 * - `in`: a field of the holder holding a list (a many relation, a multi-select) or one value, or
 *   a list of values written here. An empty holder field allows any value ("all class types").
 * - `atLeast` / `below`: a number field of the holder, or a number written here. The spender's
 *   value must be at least it, or below it (a time of day from 09:00, `atLeast: 540`, and before
 *   16:00, `below: 960`). An empty holder field sets no bound.
 *
 * A spender with no value for `field` meets no condition that sets a limit.
 */
export interface AllowanceCondition {
  field: string;
  in?: string | readonly string[];
  atLeast?: string | number;
  below?: string | number;
}

/** What a holder may be spent on: an object that declares `allowance.spends`, and conditions. */
export interface AllowanceSpendsOn {
  /** This extension's object (`booking`) or another extension's (`bookings.booking`). */
  object: string;
  when?: readonly AllowanceCondition[];
}

/**
 * A holder: its records grant uses (ADR 0493).
 *
 * - `person`: the relation to the Person whose uses they are. Only that Person's spenders spend
 *   them (a payer who is not the holder pays; the holder spends).
 * - `uses`: a number field, how many uses per period. Empty means none, unless the object
 *   declares `emptyIsUnlimited: true`: then empty is unlimited (a use is still written, so
 *   attendance counts). Unlimited is always the object's explicit choice, never what a missing
 *   value falls into.
 * - `per`: `total`, `week` or `month`, or `{ field }`, a select field whose options are those.
 *   Unused uses never carry over: each period starts at nought.
 * - `from`, `until`: date or datetime fields. A spender whose time is before `from` or at or
 *   after `until` cannot be paid by it; a date `until` includes that day.
 * - `live`: with `states`, the states in which it can be spent (`active`); required then, and
 *   left out on an object without states.
 * - `zone`: a timezone field; weeks, months and dates are in it. Left out (or empty), the
 *   organisation's zone.
 * - `spendsOn`: what it pays for, one or several.
 *
 * None of these fields, nor the holder fields a condition compares with, may be writable by a
 * customer by any route (`customer.write`, or a tool's `customerFields`): a customer does not set
 * their own uses.
 */
export interface AllowanceHolderSpec {
  person: string;
  uses: string;
  per: AllowancePeriod | { field: string };
  spendsOn: AllowanceSpendsOn | readonly AllowanceSpendsOn[];
  from?: string;
  until?: string;
  live?: readonly string[];
  zone?: string;
  emptyIsUnlimited?: boolean;
}

/**
 * A spender: its records spend a use when they enter a state of `spendIn`, and give it back when
 * they enter a state of `returnIn` (ADR 0493). Any other move keeps the use (a late cancel, a
 * no-show, an attendance). The object must declare `states`.
 *
 * - `person`: the relation to the Person spending. The holder must be theirs.
 * - `holder`: a text field naming the holder spent from (a record id). A caller may set it to
 *   choose one of the Person's holders; left empty, the host chooses (ADR 0494) and fills it.
 * - `at`: the spender's time, a datetime field of its own or one relation away
 *   (`class.startsAt`). The use counts in the holder's period containing it, and the holder must
 *   be live then. Left out: the time of the spend.
 * - `copy`: read-only fields of its own the host fills, at create and at each spend, from one
 *   relation away (`{ classType: "class.classType" }`), so a holder's `when` can read them and no
 *   caller can set them.
 * - `local`: read-only number fields of its own the host fills from `at` in `zone` (a timezone
 *   field of its own or one relation away; the organisation's when left out or empty):
 *   `weekday` (1 Monday to 7 Sunday) and `minute` (minutes since local midnight).
 * - `movedFrom`: a relation to another record of this object, and the state it is moved into.
 *   A record created into a spend state with it set takes the use of the record it names: in the
 *   same batch the host moves that record to `state` (a return state) and spends from the same
 *   holder, so a move never fails for want of a use the member already had.
 * - `paidBy`: holders of other extensions that may pay for it, by object (`memberships.pass`) or
 *   by extension (`memberships`). Left out, only this extension's holders. A holder naming a
 *   spender of another extension that does not list it is refused at install.
 * - `waived` (ADR 0506): a read-only boolean field of its own. A record created with it true
 *   enters its spend states without spending (a walk-in who paid at the desk, a drop-in paid by
 *   its order). Only the host and this extension's own code set it, never a customer, and it
 *   cannot change while the record is in a spend state.
 *
 * Every field a holder's condition reads must be one the host fills (`copy` or `local`), so no
 * caller (a customer, staff, an AI) sets what pays for it.
 */
export interface AllowanceSpenderSpec {
  person: string;
  holder: string;
  spendIn: readonly string[];
  returnIn: readonly string[];
  at?: string;
  copy?: Readonly<Record<string, string>>;
  local?: { weekday?: string; minute?: string; zone?: string };
  movedFrom?: { field: string; state: string };
  paidBy?: readonly string[];
  waived?: string;
}

/** The allowance behaviour: an object holds uses or spends them, never both. */
export type AllowanceSpec = { holds: AllowanceHolderSpec } | { spends: AllowanceSpenderSpec };

const fieldName = z.string().max(40);
const path = z.string().max(81);
const stateValue = z.string().min(1).max(100);

const conditionSchema = z
  .object({
    field: fieldName,
    in: z.union([fieldName, z.array(z.string().max(200)).min(1).max(100)]).optional(),
    atLeast: z.union([fieldName, z.number()]).optional(),
    below: z.union([fieldName, z.number()]).optional(),
  })
  .strict();

const spendsOnSchema = z
  .object({ object: path, when: z.array(conditionSchema).max(10).optional() })
  .strict();

export const allowanceManifestSchema = z.union([
  z
    .object({
      holds: z
        .object({
          person: fieldName,
          uses: fieldName,
          per: z.union([z.enum(ALLOWANCE_PERIODS), z.object({ field: fieldName }).strict()]),
          spendsOn: z.union([spendsOnSchema, z.array(spendsOnSchema).min(1).max(8)]),
          from: fieldName.optional(),
          until: fieldName.optional(),
          live: z.array(stateValue).min(1).max(20).optional(),
          zone: fieldName.optional(),
          emptyIsUnlimited: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      spends: z
        .object({
          person: fieldName,
          holder: fieldName,
          spendIn: z.array(stateValue).min(1).max(20),
          returnIn: z.array(stateValue).max(20),
          at: path.optional(),
          copy: z.record(fieldName, path).optional(),
          local: z
            .object({
              weekday: fieldName.optional(),
              minute: fieldName.optional(),
              zone: path.optional(),
            })
            .strict()
            .optional(),
          movedFrom: z.object({ field: fieldName, state: stateValue }).strict().optional(),
          paidBy: z.array(path).min(1).max(20).optional(),
          waived: fieldName.optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type AllowanceManifest = z.infer<typeof allowanceManifestSchema>;

/** The spendsOn declarations of a holder, as a list. */
export function spendsOnList(
  holds: Pick<AllowanceHolderSpec, "spendsOn">,
): readonly AllowanceSpendsOn[] {
  return Array.isArray(holds.spendsOn)
    ? (holds.spendsOn as readonly AllowanceSpendsOn[])
    : [holds.spendsOn as AllowanceSpendsOn];
}

const DATES = new Set(["date", "datetime"]);

/** The fields a spender's host fills: what its holders' conditions may read. */
export function hostFilledFields(spends: Pick<AllowanceSpenderSpec, "copy" | "local">): string[] {
  return [
    ...Object.keys(spends.copy ?? {}),
    ...(spends.local?.weekday ? [spends.local.weekday] : []),
    ...(spends.local?.minute ? [spends.local.minute] : []),
  ];
}

/**
 * Whether a spender (of extension `spenderExtension`) lets a holder object pay for it:
 * `paidBy` names the holder's object or its extension; left out, its own extension's only.
 */
export function spenderAllows(
  spends: Pick<AllowanceSpenderSpec, "paidBy">,
  spenderExtension: string,
  holderObject: string,
): boolean {
  const holderExtension = holderObject.split(".")[0];
  if (holderExtension === spenderExtension) return true;
  return (spends.paidBy ?? []).some((p) => p === holderObject || p === holderExtension);
}

/** The fields of `object` (local name `name`) a customer can write by any route. */
export function customerWritable(m: ExtensionManifest, name: string): Set<string> {
  const object = m.objects[name];
  const out = new Set(object?.customer?.write ?? []);
  if (object?.customer?.field) out.add(object.customer.field);
  for (const tool of Object.values(m.tools ?? {})) {
    for (const field of tool.customerFields?.[`${m.id}.${name}`] ?? []) out.add(field);
  }
  return out;
}

/** Reports problems with `objects.<name>.allowance` through `contract`. */
export function checkObjectAllowance(
  m: ExtensionManifest,
  name: string,
  object: ObjectManifest,
  contract: (path: string, message: string) => void,
): void {
  const allowance = object.allowance;
  if (!allowance) return;
  const ap = `objects.${name}.allowance`;
  const fieldOf = (o: ObjectManifest, local: string): FieldManifest | undefined =>
    Object.hasOwn(o.fields, local) ? o.fields[local] : undefined;
  const customerWrites = customerWritable(m, name);
  // A holder's Person is whose record it is: a customer sets it to themselves on create, so it
  // is not a term they choose; it is checked against the spender's Person, never trusted.
  if (object.customer?.field) customerWrites.delete(object.customer.field);
  const ownObject = (target: string): [string, ObjectManifest] | undefined => {
    const local = target.startsWith(`${m.id}.`)
      ? target.slice(m.id.length + 1)
      : target.includes(".")
        ? undefined
        : target;
    return local !== undefined && Object.hasOwn(m.objects, local)
      ? [local, m.objects[local] as ObjectManifest]
      : undefined;
  };
  const states = new Set(
    object.states ? (fieldOf(object, object.states.field)?.options ?? []).map((o) => o.value) : [],
  );
  const notCustomerWritten = (local: string, p: string, what: string) => {
    if (customerWrites.has(local)) {
      contract(
        p,
        `"${local}" is ${what}, so a customer cannot write it (customer.write or a tool's customerFields)`,
      );
    }
  };

  if ("holds" in allowance) {
    const h = allowance.holds;
    const hp = `${ap}.holds`;
    const person = fieldOf(object, h.person);
    if (person?.type !== "relation" || person.many || person.to !== "person") {
      contract(`${hp}.person`, `"${h.person}" must be a relation field (one record) to person`);
    }
    // The holder's Person: whose uses they are. Only the customer field itself is set to the
    // caller by the host; any other person field must not be a customer's to write.
    if (h.person !== object.customer?.field) {
      notCustomerWritten(h.person, `${hp}.person`, "whose uses they are");
    }
    const uses = fieldOf(object, h.uses);
    if (uses?.type !== "number" || uses.many) {
      contract(`${hp}.uses`, `"${h.uses}" must be a number field of ${name}`);
    }
    notCustomerWritten(h.uses, `${hp}.uses`, "the holder's uses");
    if (typeof h.per === "object") {
      const per = fieldOf(object, h.per.field);
      const options = (per?.options ?? []).map((o) => o.value);
      if (per?.type !== "select" || per.many) {
        contract(`${hp}.per.field`, `"${h.per.field}" must be a select field of ${name}`);
      } else if (
        options.some((o) => !(ALLOWANCE_PERIODS as readonly string[]).includes(o)) ||
        per.editableOptions
      ) {
        contract(
          `${hp}.per.field`,
          `"${h.per.field}"'s options must be fixed and among ${ALLOWANCE_PERIODS.join(", ")}`,
        );
      }
      notCustomerWritten(h.per.field, `${hp}.per.field`, "the holder's period");
    }
    for (const key of ["from", "until"] as const) {
      const local = h[key];
      if (local === undefined) continue;
      const field = fieldOf(object, local);
      if (!field || !DATES.has(field.type) || field.many) {
        contract(`${hp}.${key}`, `"${local}" must be a date or datetime field of ${name}`);
      }
      notCustomerWritten(local, `${hp}.${key}`, `the holder's ${key} date`);
    }
    if (h.zone !== undefined) {
      const zone = fieldOf(object, h.zone);
      if (zone?.type !== "timezone" || zone.many) {
        contract(`${hp}.zone`, `"${h.zone}" must be a timezone field of ${name}`);
      }
      notCustomerWritten(h.zone, `${hp}.zone`, "the holder's zone");
    }
    if (object.states) {
      if (!h.live) {
        contract(`${hp}.live`, "A holder with states names the states it can be spent in (live)");
      }
      for (const state of h.live ?? []) {
        if (!states.has(state)) {
          contract(`${hp}.live`, `"${state}" is not an option of ${object.states.field}`);
        }
      }
    } else if (h.live) {
      contract(`${hp}.live`, "live names states, and this object has none");
    }
    for (const reserved of ALLOWANCE_VALUES) {
      if (Object.hasOwn(object.fields, reserved)) {
        contract(
          `objects.${name}.fields.${reserved}`,
          `"${reserved}" is a value the host adds to an allowance holder; rename the field`,
        );
      }
    }
    spendsOnList(h).forEach((target, i) => {
      const sp = Array.isArray(h.spendsOn) ? `${hp}.spendsOn.${i}` : `${hp}.spendsOn`;
      const own = ownObject(target.object);
      if (!own) {
        if (!target.object.includes(".") || target.object.startsWith(`${m.id}.`)) {
          contract(`${sp}.object`, `"${target.object}" is not an object of this extension`);
        }
        // Another extension's object: checked by the host when both are installed.
        return;
      }
      const [spenderName, spender] = own;
      if (!spender.allowance || !("spends" in spender.allowance)) {
        contract(`${sp}.object`, `${spenderName} must declare allowance.spends`);
        return;
      }
      const filledBy = new Set(hostFilledFields(spender.allowance.spends));
      (target.when ?? []).forEach((clause, j) => {
        const cp = `${sp}.when.${j}`;
        const ops = (["in", "atLeast", "below"] as const).filter((k) => clause[k] !== undefined);
        if (ops.length !== 1) {
          contract(cp, "A condition compares with exactly one of in, atLeast and below");
        }
        const field = fieldOf(spender, clause.field);
        if (!field || field.type === "formula") {
          contract(`${cp}.field`, `"${clause.field}" must be a field of ${spenderName}`);
        } else if (!filledBy.has(clause.field)) {
          contract(
            `${cp}.field`,
            `"${clause.field}" must be a field ${spenderName}'s host fills (its copy or local), so no caller sets what pays for it`,
          );
        }
        if (typeof clause.in === "string" && !fieldOf(object, clause.in)) {
          contract(`${cp}.in`, `"${clause.in}" is not a field of ${name}`);
        }
        if (typeof clause.in === "string") notCustomerWritten(clause.in, `${cp}.in`, "a limit");
        for (const bound of ["atLeast", "below"] as const) {
          const value = clause[bound];
          if (typeof value !== "string") continue;
          const limit = fieldOf(object, value);
          if (limit?.type !== "number" || limit.many) {
            contract(`${cp}.${bound}`, `"${value}" must be a number field of ${name}`);
          }
          notCustomerWritten(value, `${cp}.${bound}`, "a limit");
        }
      });
    });
    return;
  }

  const s = allowance.spends;
  const sp = `${ap}.spends`;
  if (!object.states) {
    contract(sp, "A spender declares states: it spends on entering a state");
  }
  const person = fieldOf(object, s.person);
  if (person?.type !== "relation" || person.many || person.to !== "person") {
    contract(`${sp}.person`, `"${s.person}" must be a relation field (one record) to person`);
  }
  const holder = fieldOf(object, s.holder);
  if (holder?.type !== "text" || holder.many) {
    contract(`${sp}.holder`, `"${s.holder}" must be a text field of ${name} (a holder's id)`);
  }
  const spendIn = new Set(s.spendIn);
  for (const [key, list] of [
    ["spendIn", s.spendIn],
    ["returnIn", s.returnIn],
  ] as const) {
    for (const state of list) {
      if (object.states && !states.has(state)) {
        contract(`${sp}.${key}`, `"${state}" is not an option of ${object.states.field}`);
      }
      if (key === "returnIn" && spendIn.has(state)) {
        contract(`${sp}.returnIn`, `"${state}" cannot both spend and return a use`);
      }
    }
  }
  /** A path of one hop: the relation (one record) and the target field, when known. */
  const hop = (value: string, p: string): FieldManifest | null | undefined => {
    const [rel, target, extra] = value.split(".");
    if (extra !== undefined || !rel || !target) {
      contract(p, `"${value}" must be a field of ${name} or one relation away (relation.field)`);
      return undefined;
    }
    const relation = fieldOf(object, rel);
    if (relation?.type !== "relation" || relation.many || !relation.to) {
      contract(p, `"${rel}" must be a relation field (one record) of ${name}`);
      return undefined;
    }
    const other = ownObject(relation.to);
    if (!other) return null; // Another extension's object or a core one: the host checks.
    const field = fieldOf(other[1], target);
    if (!field) contract(p, `"${target}" is not a field of ${other[0]}`);
    return field;
  };
  if (s.at !== undefined) {
    if (s.at.includes(".")) {
      const field = hop(s.at, `${sp}.at`);
      if (field && field.type !== "datetime") {
        contract(`${sp}.at`, `"${s.at}" must be a datetime field`);
      }
    } else {
      const field = fieldOf(object, s.at);
      if (field?.type !== "datetime" || field.many) {
        contract(`${sp}.at`, `"${s.at}" must be a datetime field of ${name}`);
      }
      notCustomerWritten(s.at, `${sp}.at`, "the time a use is counted at");
    }
  }
  const filled = (local: string, p: string, type?: string) => {
    const field = fieldOf(object, local);
    if (!field || field.many || !field.readOnly || (type && field.type !== type)) {
      contract(
        p,
        `"${local}" must be a read-only ${type ? `${type} ` : ""}field of ${name}: the host fills it`,
      );
    }
  };
  for (const [local, source] of Object.entries(s.copy ?? {})) {
    filled(local, `${sp}.copy.${local}`);
    if (!source.includes(".")) {
      contract(`${sp}.copy.${local}`, `"${source}" must be one relation away (relation.field)`);
    } else hop(source, `${sp}.copy.${local}`);
  }
  if (s.local) {
    if (s.local.weekday !== undefined) filled(s.local.weekday, `${sp}.local.weekday`, "number");
    if (s.local.minute !== undefined) filled(s.local.minute, `${sp}.local.minute`, "number");
    if (s.local.zone !== undefined) {
      if (s.local.zone.includes(".")) {
        const field = hop(s.local.zone, `${sp}.local.zone`);
        if (field && field.type !== "timezone") {
          contract(`${sp}.local.zone`, `"${s.local.zone}" must be a timezone field`);
        }
      } else {
        if (fieldOf(object, s.local.zone)?.type !== "timezone") {
          contract(`${sp}.local.zone`, `"${s.local.zone}" must be a timezone field of ${name}`);
        }
        notCustomerWritten(s.local.zone, `${sp}.local.zone`, "the zone its local time is read in");
      }
    }
  }
  for (const [i, payer] of (s.paidBy ?? []).entries()) {
    if (!/^[a-z][a-z0-9]{1,29}(\.[a-z][a-z0-9]{0,29})?$/.test(payer)) {
      contract(`${sp}.paidBy.${i}`, `"${payer}" must be an extension id or <extension>.<object>`);
    }
  }
  if (s.waived !== undefined) {
    // Paid another way (ADR 0506): only the host and the extension's own code say so.
    const waived = fieldOf(object, s.waived);
    if (waived?.type !== "boolean" || !waived.readOnly) {
      contract(`${sp}.waived`, `"${s.waived}" must be a read-only boolean field of ${name}`);
    }
    notCustomerWritten(s.waived, `${sp}.waived`, "whether it spends a use");
  }
  if (s.movedFrom) {
    const rel = fieldOf(object, s.movedFrom.field);
    if (rel?.type !== "relation" || rel.many || (rel.to !== `${m.id}.${name}` && rel.to !== name)) {
      contract(
        `${sp}.movedFrom.field`,
        `"${s.movedFrom.field}" must be a relation field (one record) to ${m.id}.${name}`,
      );
    }
    if (!s.returnIn.includes(s.movedFrom.state)) {
      contract(
        `${sp}.movedFrom.state`,
        `"${s.movedFrom.state}" must be one of returnIn: the moved record gives its use back`,
      );
    }
    if (object.states) {
      const into = object.states.moves.filter((move) => move.to === s.movedFrom?.state);
      if (!into.some((move) => move.by.includes("staff"))) {
        contract(
          `${sp}.movedFrom.state`,
          `A move into "${s.movedFrom.state}" by staff must be declared: staff move a record's use`,
        );
      }
    }
  }
}
