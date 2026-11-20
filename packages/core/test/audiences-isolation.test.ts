// Stage 22, acceptance criterion 4: isolation, generically.
//
// Two customers, A and B, each with records in every fixture object that declares a customer.
// Every operation open to customers or the public is called as A (and as the public) with B's
// ids, B's filters and guessed ids. No response holds a value from B's rows, a call with B's id
// answers exactly as a call with an id that does not exist, and no write changes a row of B's.
//
// The test reads the registry: the operations come from `openOperations(registry)` and their
// inputs are built from each operation's input schema. A newly opened operation is covered
// without being added here. If one is opened whose input this cannot fill, the test fails and
// says so.
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ActingUser,
  type AnyOperation,
  encodeCursor,
  getObject,
  type ObjectDefinition,
  openOperations,
} from "../src/index.ts";
import {
  type Customer,
  call,
  createCustomer,
  createSupplier,
  DECLARATIONS,
  fixtureRegistry,
  installShop,
  ORDER,
  type Outcome,
  outside,
  PUBLIC,
  SUPPLIER,
  snapshot,
  TICKET,
} from "./customer-fixtures.ts";
import { createUser } from "./helpers.ts";

let admin: ActingUser;
let a: Customer;
let b: Customer;
let supplier: { id: string; secrets: string[] };

const GUESS = "rec_01GUESSED00000000000000000";
const GUESS_PERSON = "per_01GUESSED00000000000000000";

beforeAll(async () => {
  admin = await createUser("admin");
  await installShop();
  a = await createCustomer(admin, "A");
  b = await createCustomer(admin, "B");
  supplier = await createSupplier(admin);
}, 60_000);

/** Every object a caller might name: the ones that declare a customer, and ones that must not exist for them. */
const OBJECTS = [
  ORDER,
  TICKET,
  SUPPLIER,
  "person",
  "organisation",
  "activity",
  "task",
  "nope.nope",
];

interface Property {
  type?: string | string[];
  enum?: unknown[];
  default?: unknown;
}

const isId = (name: string) => name === "id" || name === "owner" || /Id$/.test(name);

/** B's value of `field` on `object`, or something of the right type. */
function theirValue(object: string, field: string): unknown {
  return b.values[object]?.[field] ?? b.records[object]?.[0] ?? b.principal.personId;
}

/** A harmless value for a property: what A would send about A's own record. */
function benign(name: string, property: Property, object: string, required: boolean): unknown {
  if (name === "object") return object;
  if (name === "id") return a.records[object]?.[0] ?? GUESS;
  if (name === "values") {
    const writable = DECLARATIONS[object]?.write[0];
    return writable ? { [writable]: "A wrote this" } : { anything: "x" };
  }
  if (!required) return undefined;
  if (isId(name)) return a.principal.personId;
  if (property.enum?.length) return property.enum[0];
  const type = Array.isArray(property.type) ? property.type[0] : property.type;
  if (type === "string") return "x";
  if (type === "number" || type === "integer") return 1;
  if (type === "boolean") return true;
  if (type === "array") return [];
  if (type === "object") return {};
  throw new Error(`audiences-isolation: cannot build a value for required input "${name}"`);
}

/** Everything a hostile caller might put in a property to reach B's rows. */
function hostile(
  name: string,
  object: string,
  definition: ObjectDefinition | undefined,
): unknown[] {
  const theirs = b.records[object] ?? [];
  const fields = definition?.fields.map((f) => f.name) ?? [];
  const owner = DECLARATIONS[object]?.field;
  if (isId(name)) {
    return [
      ...theirs,
      b.principal.personId,
      b.principal.customerId,
      supplier.id,
      GUESS,
      "' OR 1=1 --",
      "%",
    ];
  }
  if (name === "ids") return [theirs, [GUESS, ...theirs]];
  if (name === "filter") {
    return [
      ...fields.flatMap((field) => [
        { field, op: "eq", value: theirValue(object, field) },
        { field, op: "neq", value: "no such value" },
        { field, op: "is_not_null" },
      ]),
      ...(theirs.length ? [{ field: "id", op: "in", value: theirs }] : []),
      {
        or: [
          { field: "id", op: "eq", value: theirs[0] ?? GUESS },
          { field: "id", op: "is_not_null" },
        ],
      },
      ...(owner ? [{ field: owner, op: "eq", value: b.principal.personId }] : []),
      { field: "buyer", op: "eq", value: b.principal.personId },
      { field: "nothing", op: "eq", value: "x" },
    ];
  }
  if (name === "sort") {
    return fields.flatMap((field) => [
      { field, direction: "asc" },
      { field, direction: "desc" },
    ]);
  }
  if (name === "cursor") {
    // A cursor forged from B's row, for the sorts a list might be in.
    return ["id", definition?.defaultSort.field ?? "id"].flatMap((f) =>
      (["asc", "desc"] as const).map((d) =>
        encodeCursor({ f, d, v: String(theirValue(object, f)), id: theirs[0] ?? GUESS }),
      ),
    );
  }
  if (name === "fields") return [fields, ["internalNote", "margin", "buyer"]];
  if (name === "values") {
    const writable = DECLARATIONS[object]?.write[0] ?? "note";
    return [
      ...fields.filter((f) => f !== "id").map((field) => ({ [field]: "set by A" })),
      ...(owner ? [{ [owner]: b.principal.personId }, { [owner]: a.principal.personId }] : []),
      { [writable]: "ok", internalNote: "smuggled" },
      { id: theirs[0] ?? GUESS },
    ];
  }
  if (name === "limit") return [200];
  return [];
}

/** Inputs for one operation: A's own harmless call per object, then each property turned hostile. */
function inputsFor(op: AnyOperation): Record<string, unknown>[] {
  const schema = z.toJSONSchema(op.input, { unrepresentable: "any", io: "input" }) as {
    properties?: Record<string, Property>;
    required?: string[];
  };
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const objects = "object" in properties ? OBJECTS : [ORDER];
  const out = new Map<string, Record<string, unknown>>();
  const add = (input: Record<string, unknown>) => {
    const clean = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    out.set(JSON.stringify(clean), clean);
  };
  for (const object of objects) {
    const definition = getObject(object);
    const base = Object.fromEntries(
      Object.entries(properties).map(([name, property]) => [
        name,
        benign(name, property, object, required.has(name)),
      ]),
    );
    add(base);
    for (const name of Object.keys(properties)) {
      for (const value of hostile(name, object, definition)) {
        add({ ...base, [name]: value });
        // A hostile id together with each hostile set of values, for writes.
        if (isId(name) && "values" in properties) {
          for (const values of hostile("values", object, definition)) {
            add({ ...base, [name]: value, values });
          }
        }
      }
    }
  }
  return [...out.values()];
}

/** B's ids in `input`, replaced by ids that do not exist: the control for the same call. */
function withGuesses(input: unknown): { control: unknown; swapped: boolean } {
  const swaps: [string, string][] = [
    ...Object.values(b.records)
      .flat()
      .map((id, i): [string, string] => [id, `${GUESS.slice(0, -1)}${i}`]),
    [b.principal.personId, GUESS_PERSON],
    [supplier.id, `${GUESS.slice(0, -2)}S1`],
  ];
  let text = JSON.stringify(input);
  const before = text;
  for (const [real, fake] of swaps) text = text.split(real).join(fake);
  return { control: JSON.parse(text), swapped: text !== before };
}

/**
 * An outcome with every id replaced by a placeholder, to compare two calls: the ids the caller
 * sent, and ids the host made up for the call (a refused create names its new id). A leaked id
 * of B's is caught by `leaks`, with every other value of B's rows.
 */
function shape(outcome: Outcome): string {
  return JSON.stringify(outcome).replace(/\b(rec|per|cus)_[A-Za-z0-9]+/g, "<id>");
}

/** B's secrets that appear in `text` and were not sent by the caller. */
function leaks(text: string, input: unknown, secrets: string[]): string[] {
  const sent = JSON.stringify(input);
  return secrets.filter((secret) => text.includes(secret) && !sent.includes(secret));
}

describe("isolation: every open operation, as A, aimed at B", () => {
  const open = () => openOperations(fixtureRegistry.list()).operations;

  it("reads the list of open operations from the registry", () => {
    const names = open().map((op) => op.name);
    expect(names.length).toBeGreaterThanOrEqual(8);
    // The fixtures are the only open operations: the core registry has none yet.
    expect(names.every((name) => name.startsWith("fixture."))).toBe(true);
    for (const op of open()) expect(["read", "write"]).toContain(op.risk);
  });

  it("is not vacuous: the same operations show A their own records, and B theirs", async () => {
    for (const customer of [a, b]) {
      for (const object of [ORDER, TICKET]) {
        const page = await call("fixture.myList", { object }, outside(customer.principal));
        expect(page.ok, JSON.stringify(page)).toBe(true);
        const items = (page as { value: { items: { id: string }[] } }).value.items;
        expect(items.map((i) => i.id).sort()).toEqual([...(customer.records[object] ?? [])].sort());
        const id = customer.records[object]?.[0] as string;
        const one = await call("fixture.myGet", { object, id }, outside(customer.principal));
        expect(one.ok, JSON.stringify(one)).toBe(true);
      }
    }
  });

  it("no response holds a value from B's rows, and no write changes one", async () => {
    const before = { b: await snapshot(b), supplier: JSON.stringify(supplier) };
    const secrets = [...b.secrets, ...supplier.secrets];
    const problems: string[] = [];
    let calls = 0;
    let withTheirIds = 0;

    for (const { name } of open()) {
      const op = fixtureRegistry.get(name) as AnyOperation;
      for (const caller of [a.principal, PUBLIC]) {
        for (const input of inputsFor(op)) {
          calls += 1;
          const outcome = await call(name, input, outside(caller));
          const text = JSON.stringify(outcome);
          const leaked = leaks(text, input, secrets);
          if (leaked.length) {
            problems.push(
              `${name} as ${caller.kind} leaked ${leaked.join(", ")}: ${JSON.stringify(input)}`,
            );
          }
          // A call that names B's record must answer as a call that names nothing does.
          const { control, swapped } = withGuesses(input);
          if (swapped && caller.kind === "customer") {
            withTheirIds += 1;
            const guessed = await call(name, control, outside(caller));
            if (shape(outcome) !== shape(guessed)) {
              problems.push(
                `${name} tells B's id from a guess: ${JSON.stringify(input)} → ${text} but ` +
                  `${JSON.stringify(control)} → ${JSON.stringify(guessed)}`,
              );
            }
          }
        }
      }
    }

    expect(problems.slice(0, 10), `${problems.length} problem(s)`).toEqual([]);
    expect(calls).toBeGreaterThan(500);
    expect(withTheirIds).toBeGreaterThan(100);
    // Not one byte of B's rows, or of an object with no customer, changed.
    expect(await snapshot(b)).toBe(before.b);
    expect(JSON.stringify(supplier)).toBe(before.supplier);
  }, 300_000);

  it("A's own valid writes did land, so the writes above were real attempts", async () => {
    const id = a.records[ORDER]?.[0] as string;
    const done = await call(
      "fixture.myUpdate",
      { object: ORDER, id, values: { note: "A changed their note" } },
      outside(a.principal),
    );
    expect(done).toMatchObject({ ok: true, value: { values: { note: "A changed their note" } } });
    const careless = await call(
      "fixture.carelessUpdate",
      { object: ORDER, id, values: { note: "and again" } },
      outside(a.principal),
    );
    expect(careless).toEqual({ ok: true, value: { ok: true } });
  });

  it("a careless handler that writes B's row by id is stopped by the seam, not by itself", async () => {
    const before = await snapshot(b);
    const id = b.records[ORDER]?.[0] as string;
    const stolen = await call(
      "fixture.carelessUpdate",
      { object: ORDER, id, values: { note: "A was here" } },
      outside(a.principal),
    );
    // The answer a record that does not exist gets.
    expect(stolen).toEqual({
      ok: false,
      error: {
        code: "not_found",
        message: `No ${ORDER} with id ${id}`,
        details: { object: ORDER, id },
      },
    });
    expect(await snapshot(b)).toBe(before);
  });

  it("a create may only be for its caller", async () => {
    const mine = await call(
      "fixture.myCreate",
      { object: ORDER, values: { title: "A's new order", note: "please hurry" } },
      outside(a.principal),
    );
    // `title` is not writable by a customer: the create is refused whole.
    expect(mine).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const allowed = await call(
      "fixture.myCreate",
      { object: ORDER, values: { note: "a note alone" } },
      outside(a.principal),
    );
    expect(allowed.ok, JSON.stringify(allowed)).toBe(true);
    const forB = await call(
      "fixture.myCreate",
      { object: ORDER, owner: b.principal.personId, values: { note: "a gift" } },
      outside(a.principal),
    );
    expect(forB.ok).toBe(false);
    const theirs = await call("fixture.myList", { object: ORDER }, outside(b.principal));
    const items = (theirs as { value: { items: { values: { note: unknown } }[] } }).value.items;
    expect(items.map((i) => i.values.note)).not.toContain("a gift");
    expect(items).toHaveLength(2);
  });

  it("the public see no object and change no record", async () => {
    for (const object of OBJECTS) {
      const peek = await call("fixture.publicPeek", { object }, outside(PUBLIC));
      expect(peek).toEqual({
        ok: false,
        error: {
          code: "invalid_input",
          message: `Unknown object "${object}"`,
          details: { object },
        },
      });
    }
    const before = await snapshot(b);
    const write = await call(
      "fixture.publicWrite",
      { object: ORDER, id: b.records[ORDER]?.[0] },
      outside(PUBLIC),
    );
    expect(write).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await snapshot(b)).toBe(before);
  });
});
