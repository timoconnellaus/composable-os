// Stage 22, acceptance criterion 5: fields. A field an object does not list as readable never
// appears in a customer's response, including in filters, sorts, errors and field diffs, and
// filtering or sorting on one is refused, exactly as for a field that does not exist.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { getObject } from "../src/fields/index.ts";
import {
  type ActingUser,
  customerProblems,
  invoke,
  type ObjectDefinition,
  scopeOf,
  visibleObject,
} from "../src/index.ts";
import {
  type Customer,
  call,
  createCustomer,
  DECLARATIONS,
  declareCustomers,
  installShop,
  ORDER,
  type Outcome,
  outside,
  SUPPLIER,
  TICKET,
  UNLISTED,
} from "./customer-fixtures.ts";
import { context, createUser } from "./helpers.ts";

let admin: ActingUser;
let a: Customer;

beforeAll(async () => {
  admin = await createUser("admin");
  await installShop();
  a = await createCustomer(admin, "A");
}, 60_000);

const asA = () => outside(a.principal);
const NOT_A_FIELD = "nothingByThisName";

/** An outcome with one field name replaced, to compare an unlisted field with one that does not exist. */
const withName = (outcome: Outcome, name: string) =>
  JSON.stringify(outcome).split(name).join("<field>");

/** A's own values of fields A may not read: they must appear nowhere, not even to A. */
function hidden(object: string): string[] {
  const values = a.values[object] ?? {};
  return UNLISTED[object]?.flatMap((f) => (f in values ? [String(values[f])] : [])) ?? [];
}

describe("what a customer reads", () => {
  it("holds exactly the listed fields, for a list and for one record", async () => {
    for (const object of [ORDER, TICKET]) {
      const listed = DECLARATIONS[object]?.read ?? [];
      const page = await call("fixture.myList", { object }, asA());
      const items = (page as { value: { items: { id: string; values: object }[] } }).value.items;
      expect(items).toHaveLength(2);
      for (const item of items) expect(Object.keys(item.values)).toEqual(listed);
      const one = await call("fixture.myGet", { object, id: items[0]?.id }, asA());
      const record = (one as { value: { values: Record<string, unknown> } }).value;
      expect(Object.keys(record.values)).toEqual(listed);
      const text = JSON.stringify([page, one]);
      for (const name of UNLISTED[object] ?? []) expect(text, name).not.toContain(`"${name}"`);
      for (const value of hidden(object)) expect(text, value).not.toContain(value);
    }
  });

  it("holds the listed values themselves", async () => {
    const id = a.records[ORDER]?.[0] as string;
    const one = await call("fixture.myGet", { object: ORDER, id }, asA());
    const { title, status, total, note } = a.values[ORDER] as Record<string, unknown>;
    expect(one).toEqual({
      ok: true,
      value: { object: ORDER, id, values: { title, status, total, note } },
    });
  });

  it("a handler that reaches past the seam gets nothing, even of the caller's own record", async () => {
    const id = a.records[ORDER]?.[0] as string;
    for (const how of ["db", "write", "recordChange", "postActivity", "loader", "list"]) {
      const outcome = await call("fixture.rawAccess", { how, object: ORDER, id }, asA());
      expect(outcome, how).toEqual({
        ok: false,
        error: { code: "internal", message: "Internal error" },
      });
    }
  });

  it("staff still read every field of the same record", async () => {
    const id = a.records[ORDER]?.[0] as string;
    const record = await invoke("record.get", { object: ORDER, id }, context(admin));
    expect(record.values).toMatchObject({
      internalNote: a.values[ORDER]?.internalNote,
      margin: a.values[ORDER]?.margin,
      buyer: a.principal.personId,
    });
  });
});

describe("filters and sorts", () => {
  for (const operation of ["fixture.myList", "fixture.myCount"]) {
    it(`${operation}: filtering on an unlisted field is refused as an unknown field is`, async () => {
      for (const object of [ORDER, TICKET]) {
        const unknown = await call(
          operation,
          { object, filter: { field: NOT_A_FIELD, op: "is_not_null" } },
          asA(),
        );
        expect(unknown).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        for (const field of UNLISTED[object] ?? []) {
          for (const filter of [
            { field, op: "is_not_null" },
            { field, op: "eq", value: "x" },
            { and: [{ field: "id", op: "is_not_null" }, { or: [{ field, op: "is_null" }] }] },
          ]) {
            const refused = await call(operation, { object, filter }, asA());
            expect(refused.ok, `${field} ${JSON.stringify(filter)}`).toBe(false);
            for (const value of hidden(object))
              expect(JSON.stringify(refused)).not.toContain(value);
          }
          const refused = await call(
            operation,
            { object, filter: { field, op: "is_not_null" } },
            asA(),
          );
          // The same words, whether the field is hidden or was never there.
          expect(withName(refused, field)).toBe(withName(unknown, NOT_A_FIELD));
        }
      }
    });

    it.skipIf(operation === "fixture.myCount")(
      `${operation}: sorting on an unlisted field is refused as an unknown field is`,
      async () => {
        for (const object of [ORDER, TICKET]) {
          const unknown = await call(
            operation,
            { object, sort: { field: NOT_A_FIELD, direction: "asc" } },
            asA(),
          );
          expect(unknown).toMatchObject({ ok: false, error: { code: "invalid_input" } });
          for (const field of UNLISTED[object] ?? []) {
            const refused = await call(
              operation,
              { object, sort: { field, direction: "desc" } },
              asA(),
            );
            expect(withName(refused, field)).toBe(withName(unknown, NOT_A_FIELD));
          }
        }
      },
    );
  }

  it("filtering and sorting on listed fields work, over the caller's rows only", async () => {
    const paid = await call(
      "fixture.myList",
      { object: ORDER, filter: { field: "status", op: "eq", value: "paid" } },
      asA(),
    );
    const items = (paid as { value: { items: { id: string }[] } }).value.items;
    expect(items.map((i) => i.id)).toEqual([a.records[ORDER]?.[1]]);

    const first = await call(
      "fixture.myList",
      { object: ORDER, sort: { field: "total", direction: "desc" }, limit: 1 },
      asA(),
    );
    const page1 = (first as { value: { items: { id: string }[]; nextCursor: string } }).value;
    expect(page1.items.map((i) => i.id)).toEqual([a.records[ORDER]?.[1]]);
    const second = await call(
      "fixture.myList",
      {
        object: ORDER,
        sort: { field: "total", direction: "desc" },
        limit: 1,
        cursor: page1.nextCursor,
      },
      asA(),
    );
    const page2 = (second as { value: { items: { id: string }[]; nextCursor: null } }).value;
    expect(page2.items.map((i) => i.id)).toEqual([a.records[ORDER]?.[0]]);
    expect(page2.nextCursor).toBeNull();
  });

  it("the default sort falls back to id when the object's own is not listed", () => {
    // Tickets sort by `code`, which is listed. Orders by `title`, listed too.
    expect(visibleObject(asA(), TICKET).defaultSort).toEqual({ field: "code", direction: "asc" });
    const hiddenTitle: ObjectDefinition = {
      ...(getObject(ORDER) as ObjectDefinition),
      name: "fixture.hiddenTitle",
      customer: { field: "buyer", read: ["status"], write: [] },
    };
    const scope = scopeOf(a.principal, hiddenTitle);
    expect(scope.kind).toBe("customer");
    expect(visibleObject(asA(), hiddenTitle)).toMatchObject({
      defaultSort: { field: "id", direction: "asc" },
      fields: [{ name: "id" }, { name: "status" }],
    });
    expect(visibleObject(asA(), hiddenTitle).titleField).toBeUndefined();
  });
});

describe("writes and field diffs", () => {
  async function diffsOf(recordId: string) {
    const { results } = await env.DB.prepare(
      `SELECT c.diff, a.actor, a.user_id, a.outcome FROM core_audit_changes c
       JOIN core_audit a ON a.id = c.audit_id WHERE c.record_id = ? AND a.actor = 'customer'
       ORDER BY c.id`,
    )
      .bind(recordId)
      .all<{ diff: string; actor: string; user_id: string; outcome: string }>();
    return results.map((row) => ({
      ...row,
      diff: JSON.parse(row.diff) as Record<string, unknown>,
    }));
  }

  it("a customer changes a writable field, and the diff holds that field alone", async () => {
    const id = a.records[TICKET]?.[0] as string;
    const done = await call(
      "fixture.myUpdate",
      { object: TICKET, id, values: { comment: "Aisle seat, please" } },
      asA(),
    );
    expect(done).toMatchObject({ ok: true, value: { values: { comment: "Aisle seat, please" } } });
    expect(Object.keys((done as { value: { values: object } }).value.values)).toEqual(
      DECLARATIONS[TICKET]?.read,
    );
    const diffs = await diffsOf(id);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ actor: "customer", user_id: a.principal.customerId });
    expect(Object.keys(diffs[0]?.diff ?? {})).toEqual(["comment"]);
  });

  it("writing an unlisted field is refused as a field that does not exist, and nothing is written", async () => {
    const id = a.records[ORDER]?.[0] as string;
    for (const operation of ["fixture.myUpdate"]) {
      const unknown = await call(
        operation,
        { object: ORDER, id, values: { [NOT_A_FIELD]: "x" } },
        asA(),
      );
      expect(unknown).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      for (const field of ["internalNote", "margin"]) {
        const refused = await call(
          operation,
          { object: ORDER, id, values: { [field]: "x" } },
          asA(),
        );
        expect(withName(refused, field), `${operation} ${field}`).toBe(
          withName(unknown, NOT_A_FIELD),
        );
        // With a writable field beside it too: the whole write is refused.
        const mixed = await call(
          operation,
          { object: ORDER, id, values: { note: "fine", [field]: "x" } },
          asA(),
        );
        expect(mixed.ok).toBe(false);
        for (const value of hidden(ORDER))
          expect(JSON.stringify([refused, mixed])).not.toContain(value);
      }
    }
    const record = await invoke("record.get", { object: ORDER, id }, context(admin));
    expect(record.values).toMatchObject({
      internalNote: a.values[ORDER]?.internalNote,
      margin: a.values[ORDER]?.margin,
      note: a.values[ORDER]?.note,
    });
    // No field diff of a customer's names anything but a writable field.
    for (const diff of await diffsOf(id)) {
      expect(Object.keys(diff.diff).every((k) => DECLARATIONS[ORDER]?.write.includes(k))).toBe(
        true,
      );
    }
  });

  it("a field they can read but not write is refused by name, and whose record it is cannot change", async () => {
    const id = a.records[ORDER]?.[0] as string;
    const status = await call(
      "fixture.myUpdate",
      { object: ORDER, id, values: { status: "paid" } },
      asA(),
    );
    expect(status).toEqual({
      ok: false,
      error: {
        code: "invalid_input",
        message: `${ORDER}.status cannot be changed`,
        details: { field: "status" },
      },
    });
    const owner = await call(
      "fixture.myUpdate",
      { object: ORDER, id, values: { buyer: "per_01SOMEONEELSE0000000000000" } },
      asA(),
    );
    // The customer field is not listed: to the caller it is a field that does not exist.
    expect(owner).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(JSON.stringify(owner)).toContain("Unknown field");
    const record = await invoke("record.get", { object: ORDER, id }, context(admin));
    expect(record.values).toMatchObject({ status: "open", buyer: a.principal.personId });
  });
});

describe("errors", () => {
  it("no error a customer can cause names an unlisted field or holds a hidden value", async () => {
    const id = a.records[ORDER]?.[0] as string;
    const outcomes: Outcome[] = [];
    for (const [name, input] of [
      ["fixture.myGet", { object: ORDER, id: "rec_01NOTTHERE0000000000000000" }],
      ["fixture.myGet", { object: ORDER }],
      ["fixture.myList", { object: ORDER, limit: 0 }],
      ["fixture.myList", { object: ORDER, cursor: "not a cursor" }],
      ["fixture.myList", { object: ORDER, filter: { field: "total", op: "contains", value: 1 } }],
      ["fixture.myList", { object: ORDER, filter: { field: "status", op: "eq", value: { x: 1 } } }],
      ["fixture.myUpdate", { object: ORDER, id, values: { note: { nested: true } } }],
      ["fixture.myUpdate", { object: ORDER, id }],
      ["fixture.myList", { object: ORDER, sort: { field: "status", direction: "sideways" } }],
      ["fixture.staffHabit", {}],
      ["fixture.rawAccess", { how: "loader", object: "person", id: a.principal.personId }],
    ] as const) {
      outcomes.push(await call(name, input, asA()));
    }
    const text = JSON.stringify(outcomes);
    expect(outcomes.every((o) => !o.ok)).toBe(true);
    for (const name of UNLISTED[ORDER] ?? []) expect(text, name).not.toContain(name);
    for (const value of hidden(ORDER)) expect(text, value).not.toContain(value);
    // Nothing of the database's own words either.
    expect(text).not.toMatch(/SQLITE|D1_|no such column|x_shop|rec_x_|core_/);
  });

  it("an internal failure tells a customer nothing", async () => {
    expect(await call("fixture.staffHabit", {}, asA())).toEqual({
      ok: false,
      error: { code: "internal", message: "Internal error" },
    });
  });

  it("a staff loader gives a customer nothing, even for their own person", async () => {
    expect(
      await call(
        "fixture.rawAccess",
        { how: "loader", object: "person", id: a.principal.personId },
        asA(),
      ),
    ).toEqual({ ok: false, error: { code: "internal", message: "Internal error" } });
  });
});

describe("an object with no customer, and a declaration that does not hold together", () => {
  it("an object that declares no customer does not exist for one", async () => {
    for (const operation of ["fixture.myList", "fixture.myCount"]) {
      const none = await call(operation, { object: "nope.nope" }, asA());
      for (const object of [SUPPLIER, "person", "organisation", "task", "activity"]) {
        const closed = await call(operation, { object }, asA());
        expect(withName(closed, object)).toBe(withName(none, "nope.nope"));
      }
    }
  });

  it("checks a declaration against the object's fields", () => {
    const order = getObject(ORDER) as ObjectDefinition;
    const problems = (customer: ObjectDefinition["customer"]) =>
      customerProblems({ ...order, customer });
    expect(problems(DECLARATIONS[ORDER])).toEqual([]);
    expect(problems(undefined)).toEqual([]);
    expect(problems({ field: "status", read: [], write: [] })).toEqual([
      'customer.field "status" must be a relation to one person',
    ]);
    expect(problems({ field: "missing", read: [], write: [] })).toEqual([
      'customer.field "missing" is not a single-valued field',
    ]);
    expect(problems({ field: "buyer", read: ["nope"], write: [] })).toEqual([
      'customer.read lists "nope", which is not a field',
    ]);
    expect(problems({ field: "buyer", read: ["note"], write: ["note", "status"] })).toEqual([
      'customer.write lists "status", which customer.read does not',
    ]);
    expect(problems({ field: "buyer", read: ["buyer"], write: ["buyer"] })).toEqual([
      "customer.write may not list the customer field: it is always the caller",
    ]);
    expect(problems({ field: "buyer", read: ["note", "note"], write: [] })).toEqual([
      "customer.read lists a field twice",
    ]);
  });

  it("shows nothing through a declaration that does not hold together", async () => {
    await declareCustomers({
      ...DECLARATIONS,
      [TICKET]: { field: "seat", read: ["code"], write: [] },
    });
    try {
      const outcome = await call("fixture.myList", { object: TICKET }, asA());
      expect(outcome).toEqual({
        ok: false,
        error: { code: "internal", message: "Internal error" },
      });
    } finally {
      await declareCustomers();
    }
    expect((await call("fixture.myList", { object: TICKET }, asA())).ok).toBe(true);
  });
});
