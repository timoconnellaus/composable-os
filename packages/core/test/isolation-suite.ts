// Stage 22, acceptance criterion 4: isolation, generically. Stage 23 (acceptance criterion 2)
// runs the same suite again over the HTTP surface (http-isolation.test.ts), so it is a function
// of the way a call is made: `invoke()` directly, or a request to POST /api/v1/op/<name>.
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
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { objectTableOf } from "../src/extensions/schema.ts";
import {
  type ActingUser,
  type AnyOperation,
  audiencesOf,
  encodeCursor,
  getObject,
  invoke,
  type ObjectDefinition,
  openOperations,
} from "../src/index.ts";
import { type AccessWorld, createAccessWorld, fakeStream } from "./access-fixtures.ts";
import {
  ASSIGNMENT,
  type Customer,
  createClass,
  createCustomer,
  createPosts,
  createShows,
  createSupplier,
  DAY,
  DECLARATIONS,
  fixtureRegistry,
  giveOrders,
  HOLDING,
  ITEM,
  installShop,
  type call as invokeCall,
  LOG,
  ORDER,
  type Outcome,
  outside,
  POST,
  PUBLIC,
  REQUEST,
  SESSION,
  SHOW,
  SUPPLIER,
  snapshot,
  TICKET,
  TIER,
  VISIT,
} from "./customer-fixtures.ts";
import { extId } from "./extension-helpers.ts";
import { context, createUser } from "./helpers.ts";

const ACCESS_SUITE_EXT = extId("crsi");

/** How a call is made: the same arguments and outcome as `call` in customer-fixtures.ts. */
export type CallFn = typeof invokeCall;

export function isolationSuite(how: string, call: CallFn): void {
  let admin: ActingUser;
  let a: Customer;
  let b: Customer;
  let supplier: { id: string; secrets: string[] };
  let shows: Awaited<ReturnType<typeof createShows>>;
  let classes: Awaited<ReturnType<typeof createClass>>;
  let posts: Awaited<ReturnType<typeof createPosts>>;

  const GUESS = "rec_01GUESSED00000000000000000";
  const GUESS_PERSON = "per_01GUESSED00000000000000000";

  beforeAll(async () => {
    admin = await createUser("admin");
    await installShop();
    // Each with a child staff linked to them (stage 31a step 6, ADR 0540).
    a = await createCustomer(admin, "A", { family: true });
    b = await createCustomer(admin, "B", { family: true });
    supplier = await createSupplier(admin);
    // Stage 27 (ADR 0438): what the public may read, and what it may not.
    shows = await createShows(admin);
    // Stage 41 (ADR 0447): a class every signed-in customer reads, beside each one's own.
    classes = await createClass(admin);
    // Stage 28 (ADR 0442): a post the public reads, its draft working copy, a draft, a taken-down one.
    posts = await createPosts(admin);
    // Stage 25, criterion 10: real orders and their lines, for both customers.
    await giveOrders(admin, a);
    await giveOrders(admin, b);
  }, 60_000);

  /** Every object a caller might name: the ones that declare a customer, and ones that must not exist for them. */
  const OBJECTS = [
    ORDER,
    TICKET,
    SUPPLIER,
    // The real Order and Order line (stage 25): base records that declare a customer.
    "order",
    "orderLine",
    // Readable by the public (and customers) while on sale, and only their listed fields.
    SHOW,
    TIER,
    // A published post, read by its slug (stage 28): only its published version's declared fields.
    POST,
    // A program's assignments, sessions and logged sets (stage 41): one's own, and a class's.
    ASSIGNMENT,
    SESSION,
    LOG,
    // The family link (ADR 0540): a visit a guardian writes for a child, a holding they only
    // read, and a day read through a visit.
    VISIT,
    HOLDING,
    DAY,
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
    anyOf?: Property[];
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
    // A nullable value (a birthday, stage 53): null is the harmless one.
    if (property.anyOf?.some((p) => p.type === "null")) return null;
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
    const owner = DECLARATIONS[object]?.field ?? definition?.customer?.field;
    if (isId(name)) {
      return [
        ...theirs,
        // Every id of B's, of every object: an operation that takes one id (order.get) is aimed
        // at B's real orders and lines whatever object the rest of the input names.
        ...Object.values(b.records).flat(),
        b.principal.personId,
        ...b.dependants,
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
        // A relation pointed at B's record of its target: a set logged on B's session.
        ...(definition?.fields ?? [])
          .filter((f) => f.fieldType === "relation" && f.options?.to && f.options.to !== "person")
          .flatMap((f) => {
            const target = b.records[f.options?.to as string]?.[0];
            return target ? [{ [f.name]: target }, { [writable]: "ok", [f.name]: target }] : [];
          }),
      ];
    }
    if (name === "limit") return [200];
    // A record's address (stage 28): the hidden posts', the live one's, and nonsense.
    if (name === "slug") {
      return [
        ...posts.hidden.slugs,
        posts.live.slug,
        "' OR 1=1 --",
        "%",
        "live-%",
        "x".repeat(200),
      ];
    }
    // A preview link's token: made up, and malformed.
    if (name === "token") return [`pv_${"A".repeat(43)}`, "pv_", "%", "' OR 1=1 --"];
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
        for (const value of [
          ...hostile(name, object, definition),
          ...(properties[name]?.enum ?? []),
        ]) {
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
      // B's children are People that do not exist for A (ADR 0540).
      ...b.dependants.map((id, i): [string, string] => [id, `${GUESS_PERSON.slice(0, -2)}D${i}`]),
      [supplier.id, `${GUESS.slice(0, -2)}S1`],
      // A record the public may not read now answers as one that does not exist.
      ...shows.hidden.ids.map((id, i): [string, string] => [id, `${GUESS.slice(0, -2)}H${i}`]),
      // A post the public may not read answers as one that does not exist: a draft, an
      // unpublished one, by id or by slug.
      ...posts.hidden.ids.map((id, i): [string, string] => [id, `${GUESS.slice(0, -2)}P${i}`]),
      ...posts.hidden.slugs.map((slug, i): [string, string] => [slug, `guessed-slug-${i}`]),
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
    return JSON.stringify(outcome).replace(/\b(rec|per|cus|ord|orl)_[A-Za-z0-9]+/g, "<id>");
  }

  /** B's secrets that appear in `text` and were not sent by the caller. */
  function leaks(text: string, input: unknown, secrets: string[]): string[] {
    const sent = JSON.stringify(input);
    return secrets.filter((secret) => text.includes(secret) && !sent.includes(secret));
  }

  describe(`isolation ${how}: every open operation, as A, aimed at B`, () => {
    const open = () => openOperations(fixtureRegistry.list()).operations;

    it("reads the list of open operations from the registry", () => {
      const names = open().map((op) => op.name);
      expect(names.length).toBeGreaterThanOrEqual(8);
      // The fixtures, and whatever the core registry opens (open-operations.json): all of them
      // are called below.
      expect(names.some((name) => name.startsWith("fixture."))).toBe(true);
      expect(names).toEqual(expect.arrayContaining(["me.get", "me.update", "my.get", "my.list"]));
      for (const op of open()) expect(["read", "write"]).toContain(op.risk);
    });

    it("is not vacuous: the same operations show A their own records, and B theirs", async () => {
      for (const customer of [a, b]) {
        // A visit and a holding: their own and their child's (ADR 0540).
        for (const object of [ORDER, TICKET, REQUEST, "order", "orderLine", VISIT, HOLDING]) {
          const page = await call("fixture.myList", { object }, outside(customer.principal));
          expect(page.ok, JSON.stringify(page)).toBe(true);
          const items = (page as { value: { items: { id: string }[] } }).value.items;
          expect(items.map((i) => i.id).sort()).toEqual(
            [...(customer.records[object] ?? [])].sort(),
          );
          const id = customer.records[object]?.[0] as string;
          const one = await call("fixture.myGet", { object, id }, outside(customer.principal));
          expect(one.ok, JSON.stringify(one)).toBe(true);
        }
      }
    });

    it("a class's assignment and session are read by both, with only what is shared (ADR 0447)", async () => {
      for (const customer of [a, b]) {
        for (const object of [ASSIGNMENT, SESSION, LOG]) {
          const page = await call("fixture.myList", { object }, outside(customer.principal));
          expect(page.ok, JSON.stringify(page)).toBe(true);
          const ids = (page as { value: { items: { id: string }[] } }).value.items.map((i) => i.id);
          const shared =
            object === ASSIGNMENT
              ? [classes.assignment]
              : object === SESSION
                ? [classes.session]
                : [];
          // Logged sets grow as the suite's own writes land; each is the caller's.
          if (object === LOG) {
            expect(ids).toEqual(expect.arrayContaining(customer.records[object] ?? []));
            continue;
          }
          expect(ids.sort()).toEqual([...(customer.records[object] ?? []), ...shared].sort());
        }
        const session = await call(
          "fixture.myGet",
          { object: SESSION, id: classes.session },
          outside(customer.principal),
        );
        const text = JSON.stringify(session);
        expect(text).toContain(classes.memberNote);
        for (const hidden of classes.hidden) expect(text).not.toContain(hidden);
      }
    });

    it("no response holds a value from B's rows, and no write changes one", async () => {
      const before = { b: await snapshot(b), supplier: JSON.stringify(supplier) };
      const secrets = [
        ...b.secrets,
        ...supplier.secrets,
        ...shows.hidden.secrets,
        ...classes.hidden,
        ...posts.hidden.secrets,
      ];
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
            if (swapped) {
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
      const kept = await call("fixture.bookkeeping", { object: ORDER, id }, outside(a.principal));
      expect(kept).toMatchObject({ ok: true });
    });

    it("a handler cannot reach B's row past the seam, by any way there is", async () => {
      const before = await snapshot(b);
      const id = b.records[ORDER]?.[0] as string;
      for (const how of ["db", "write", "recordChange", "postActivity", "loader", "list"]) {
        const outcome = await call(
          "fixture.rawAccess",
          { how, object: ORDER, id },
          outside(a.principal),
        );
        expect(outcome, how).toEqual({
          ok: false,
          error: { code: "internal", message: "Internal error" },
        });
      }
      // Even an operation that keeps the raw database has its recorded change checked by the seam:
      // B's record is a record that is not there.
      const kept = await call("fixture.bookkeeping", { object: ORDER, id }, outside(a.principal));
      expect(kept).toEqual({
        ok: false,
        error: {
          code: "not_found",
          message: `No ${ORDER} with id ${id}`,
          details: { object: ORDER, id },
        },
      });
      expect(await snapshot(b)).toBe(before);
    });

    it("a create is always for its caller", async () => {
      // An order needs a title, which a customer may not set: they cannot create one.
      const order = await call(
        "fixture.myCreate",
        { object: ORDER, values: { title: "A's new order", note: "please hurry" } },
        outside(a.principal),
      );
      expect(order).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      const mine = await call(
        "fixture.myCreate",
        { object: REQUEST, values: { text: "Please call me" } },
        outside(a.principal),
      );
      expect(mine.ok, JSON.stringify(mine)).toBe(true);
      const list = await call("fixture.myList", { object: REQUEST }, outside(a.principal));
      expect((list as { value: { items: unknown[] } }).value.items).toHaveLength(3);
      // Naming someone else as the owner, or oneself: the field is never the caller's to send.
      for (const asker of [b.principal.personId, a.principal.personId]) {
        const forOther = await call(
          "fixture.myCreate",
          { object: REQUEST, values: { text: "a gift", asker } },
          outside(a.principal),
        );
        expect(forOther).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      }
      const theirs = await call("fixture.myList", { object: REQUEST }, outside(b.principal));
      const items = (theirs as { value: { items: { values: { text: unknown } }[] } }).value.items;
      expect(items.map((i) => i.values.text)).not.toContain("a gift");
      expect(items).toHaveLength(2);
    });

    it("every operation not open to a caller does not exist for them (stage 22 criterion 1)", async () => {
      // Read from the registry: staff operations, customer operations for the public, public
      // ones for customers, and tool-only ones called directly.
      const closed = (kind: "customer" | "public") =>
        fixtureRegistry.list().filter((op) => !audiencesOf(op).includes(kind) || op.toolOnly);
      let checked = 0;
      for (const caller of [a.principal, PUBLIC]) {
        const ops = closed(caller.kind);
        expect(ops.length).toBeGreaterThan(100);
        for (const op of ops) {
          checked += 1;
          const outcome = await call(op.name, {}, outside(caller));
          expect(outcome, `${op.name} as ${caller.kind}`).toEqual({
            ok: false,
            error: { code: "unknown_operation", message: `No operation named "${op.name}"` },
          });
        }
      }
      expect(checked).toBeGreaterThan(200);
    });

    it("the public see what is declared public, of what is on sale, and nothing else (ADR 0438)", async () => {
      for (const caller of [PUBLIC, a.principal]) {
        const show = await call("fixture.publicPeek", { object: SHOW }, outside(caller));
        if (caller.kind === "customer") {
          // A customer reads at least what the public may (here through a customer's operation).
          const mine = await call("fixture.myList", { object: SHOW }, outside(caller));
          expect(mine).toEqual(show.ok ? show : mine);
        }
        if (caller.kind !== "public") continue;
        expect(show).toMatchObject({ ok: true });
        const items = (show as { value: { items: { id: string; values: object }[] } }).value.items;
        const mine = items.find((i) => i.id === shows.onSale.show);
        expect(mine?.values).toEqual({ name: shows.onSale.name, status: "on_sale" });
        for (const id of shows.hidden.ids) expect(items.map((i) => i.id)).not.toContain(id);
        const tiers = await call("fixture.publicPeek", { object: TIER }, outside(caller));
        const tier = (
          tiers as { value: { items: { id: string; values: object }[] } }
        ).value.items.find((i) => i.id === shows.onSale.tier);
        expect(Object.keys(tier?.values ?? {}).sort()).toEqual(["name", "price", "show"]);
        expect(JSON.stringify(tiers)).not.toContain(shows.hidden.ids[1]);
      }
    });

    it("a customer reads the declared fields of a record their own record points to, and nothing else (ADR 0439)", async () => {
      const heldA = a.records[SHOW]?.[0] as string;
      const heldB = b.records[SHOW]?.[0] as string;
      // Their own ticket points to a show that is not on sale: they read its declared fields.
      const one = await call("fixture.myGet", { object: SHOW, id: heldA }, outside(a.principal));
      expect(one).toEqual({
        ok: true,
        value: { object: SHOW, id: heldA, values: a.values[SHOW] },
      });
      // Never a field outside the declaration: not the backstage note of their own show.
      const page = await call("fixture.myList", { object: SHOW }, outside(a.principal));
      expect(page).toMatchObject({ ok: true });
      const text = JSON.stringify(page);
      expect(text).not.toContain("backstage");
      expect(text).not.toContain("HeldBackstage-");
      const items = (
        page as { value: { items: { id: string; values: Record<string, unknown> }[] } }
      ).value.items;
      const ids = items.map((item) => item.id);
      // Theirs, and the one on sale (the public's), and not B's or the draft one.
      expect(ids).toContain(heldA);
      expect(ids).toContain(shows.onSale.show);
      expect(ids).not.toContain(heldB);
      for (const id of shows.hidden.ids) expect(ids).not.toContain(id);
      // A field only the declaration lists shows only on the records it covers: a show on sale
      // that A holds no ticket for keeps its doors from A, as from the public.
      const onSale = items.find((item) => item.id === shows.onSale.show);
      expect(onSale?.values).toEqual({ name: shows.onSale.name, status: "on_sale", doors: null });
      // Filtering on it cannot find another record's value either.
      const probe = await call(
        "fixture.myList",
        { object: SHOW, filter: { field: "doors", op: "is_not_null" } },
        outside(a.principal),
      );
      const found = (probe as { value: { items: { id: string }[] } }).value.items;
      expect(found.map((item) => item.id)).toEqual([heldA]);
      // B's held show is a record that is not there for A, the public, and through the
      // public's door.
      for (const caller of [a.principal, PUBLIC]) {
        const peek = await call(
          caller.kind === "public" ? "fixture.publicPeek" : "fixture.myGet",
          caller.kind === "public" ? { object: SHOW } : { object: SHOW, id: heldB },
          outside(caller),
        );
        expect(JSON.stringify(peek)).not.toContain(`HeldShow-`);
      }
      // Live: a record their ticket no longer points to is no longer theirs to read.
      const ticket = a.records[TICKET]?.[0] as string;
      const point = (show: string | null) =>
        invoke("record.update", { object: TICKET, id: ticket, values: { show } }, context(admin));
      await point(null);
      try {
        const gone = await call("fixture.myGet", { object: SHOW, id: heldA }, outside(a.principal));
        expect(gone).toMatchObject({ ok: false, error: { code: "not_found" } });
      } finally {
        await point(heldA);
      }
    });

    it("the public read a post's published version by its slug, and nothing else of it (ADR 0442)", async () => {
      for (const caller of [PUBLIC, a.principal]) {
        const live = await call(
          "content.get",
          { object: POST, slug: posts.live.slug },
          outside(caller),
        );
        expect(live).toMatchObject({
          ok: true,
          value: { kind: "record", id: posts.live.id, values: { name: posts.live.name } },
        });
        const values = (live as { value: { values: Record<string, unknown> } }).value.values;
        expect(Object.keys(values).sort()).toEqual(["body", "date", "name", "slug", "teaser"]);
        const page = await call("content.list", { object: POST }, outside(caller));
        const ids = (page as { value: { items: { id: string }[] } }).value.items.map((i) => i.id);
        expect(ids).toContain(posts.live.id);
        for (const id of posts.hidden.ids) expect(ids).not.toContain(id);
        for (const slug of posts.hidden.slugs) {
          expect(await call("content.get", { object: POST, slug }, outside(caller))).toEqual(
            await call("content.get", { object: POST, slug: "never-was-a-post" }, outside(caller)),
          );
        }
      }
    });

    it("a sellable object's records come with the currency their prices are in, from the host", async () => {
      // Stage 25: one currency per deployment, a setting. A client never states it itself.
      const items = await call("fixture.publicPeek", { object: ITEM }, outside(PUBLIC));
      expect(items).toMatchObject({ ok: true, value: { currency: "AUD" } });
      // Not on an object that is not for sale.
      const show = (await call("fixture.publicPeek", { object: SHOW }, outside(PUBLIC))) as {
        value: Record<string, unknown>;
      };
      expect(show.value).not.toHaveProperty("currency");
    });

    it("the public see no other object and change no record", async () => {
      for (const object of OBJECTS.filter((o) => o !== SHOW && o !== TIER && o !== POST)) {
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
      expect(write).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await snapshot(b)).toBe(before);
    });
  });

  // Stage 31a step 6 (ADR 0540): the family link. A and B each have a child staff linked to them.
  // A reads and acts for A's child where an object opens to guardians, and only there; B's child
  // is a Person that does not exist for A, by id, by filter and as `forPersonId`.
  describe(`isolation ${how}: the family link (stage 31a)`, () => {
    const items = (outcome: Outcome) =>
      (outcome as { value: { items: { id: string; values: Record<string, unknown> }[] } }).value
        .items;

    it("a guardian reads their child's records where the object opens to guardians, and nothing of another's", async () => {
      const kid = a.dependants[0] as string;
      for (const object of [VISIT, HOLDING]) {
        const page = items(await call("fixture.myList", { object }, outside(a.principal)));
        const owners = new Set(page.map((item) => item.values.person));
        expect([...owners].sort()).toEqual([a.principal.personId, kid].sort());
        // Filtering on B's child finds nothing, as a Person that does not exist.
        const probe = await call(
          "fixture.myList",
          { object, filter: { field: "person", op: "eq", value: b.dependants[0] } },
          outside(a.principal),
        );
        expect(items(probe)).toEqual([]);
      }
      // Not on an object that does not open to guardians: the child's own records stay theirs.
      const tickets = items(await call("fixture.myList", { object: TICKET }, outside(a.principal)));
      expect(tickets.map((t) => t.id).sort()).toEqual([...(a.records[TICKET] ?? [])].sort());
      // The day of the child's visit, through the visit (customerVia), and not B's child's.
      const days = items(await call("fixture.myList", { object: DAY }, outside(a.principal)));
      expect(days.map((d) => d.id).sort()).toEqual([...(a.records[DAY] ?? [])].sort());
    });

    it("a guardian makes a record for their child, never for anyone else's, and the host says who made it", async () => {
      const kid = a.dependants[0] as string;
      const made = await call(
        "fixture.myCreate",
        { object: VISIT, values: { note: "Booked by A for their child" }, forPersonId: kid },
        outside(a.principal),
      );
      expect(made.ok, JSON.stringify(made)).toBe(true);
      const id = (made as { value: { id: string } }).value.id;
      const row = await env.DB.prepare(`SELECT * FROM ${objectTableOf(VISIT)} WHERE id = ?`)
        .bind(id)
        .first<Record<string, unknown>>();
      expect(Object.values(row ?? {})).toContain(kid);
      expect(Object.values(row ?? {})).toContain(a.principal.personId);
      // B's child, B, a guessed Person, A's child on an object that is read only to guardians,
      // and A's child on an object with no guardians: one answer, a Person that is not there.
      const before = await snapshot(b);
      const answers = new Set<string>();
      for (const [object, forPersonId] of [
        [VISIT, b.dependants[0]],
        [VISIT, b.principal.personId],
        [VISIT, GUESS_PERSON],
        [HOLDING, kid],
        [REQUEST, kid],
      ] as const) {
        const outcome = await call(
          "fixture.myCreate",
          {
            object,
            values: { [object === VISIT ? "note" : object === HOLDING ? "label" : "text"]: "x" },
            forPersonId,
          },
          outside(a.principal),
        );
        expect(outcome).toMatchObject({ ok: false, error: { code: "not_found" } });
        answers.add(shape(outcome));
      }
      expect(answers.size).toBe(1);
      expect(await snapshot(b)).toBe(before);
    });

    it("a guardian changes their child's records only where guardians write", async () => {
      const kidVisit = a.records[VISIT]?.[1] as string;
      const kidHolding = a.records[HOLDING]?.[1] as string;
      const done = await call(
        "fixture.myUpdate",
        { object: VISIT, id: kidVisit, values: { note: "Changed by A" } },
        outside(a.principal),
      );
      expect(done).toMatchObject({ ok: true, value: { values: { note: "Changed by A" } } });
      const readOnly = await call(
        "fixture.myUpdate",
        { object: HOLDING, id: kidHolding, values: { label: "Changed by A" } },
        outside(a.principal),
      );
      expect(readOnly).toMatchObject({ ok: false, error: { code: "not_found" } });
      // B's child's visit: not there.
      const theirs = await call(
        "fixture.myUpdate",
        { object: VISIT, id: b.records[VISIT]?.[1] as string, values: { note: "x" } },
        outside(a.principal),
      );
      expect(theirs).toMatchObject({ ok: false, error: { code: "not_found" } });
    });

    it("me.family names A's child to A only", async () => {
      const family = await call("me.family", {}, outside(a.principal));
      expect(family).toMatchObject({
        ok: true,
        value: {
          self: { personId: a.principal.personId },
          dependants: [{ personId: a.dependants[0] }],
          guardians: [],
        },
      });
      expect(JSON.stringify(family)).not.toContain(b.dependants[0] as string);
      expect(await call("me.family", {}, outside(PUBLIC))).toMatchObject({
        ok: false,
        error: { code: "unknown_operation" },
      });
    });
  });

  // Stage 42, step 3 (ADR 0477): who holds access to a course. The holders' parts of its outline
  // and the video they show are a holder's only: a customer enrolled in the course, or in a
  // bundle that lists it. Not a customer enrolled in nothing, nor one whose enrolment was voided
  // (a refund in full) or has passed its `until`, nor the public. Staff read and play everything.
  describe(`isolation ${how}: access to a course (stage 42)`, () => {
    let world: AccessWorld;
    const NOT_FOUND = {
      ok: false,
      error: { code: "not_found", message: "Not found", details: { object: "media" } },
    };

    beforeAll(async () => {
      fakeStream();
      world = await createAccessWorld(admin, ACCESS_SUITE_EXT);
    }, 60_000);

    const course = () => `${ACCESS_SUITE_EXT}.course`;
    const read = (who: Parameters<typeof outside>[0], id: string) =>
      call("my.get", { object: course(), id }, outside(who));

    it("a holder reads the holders' parts and plays the lesson's video", async () => {
      const text = JSON.stringify(await read(world.holder, world.course));
      expect(text).toContain("Holders-only-notes");
      expect(text).toContain(world.lessonVideo);
      expect(text).not.toContain("Staff-only-note");
      expect(
        await call("media.play", { id: world.lessonVideo }, outside(world.holder)),
      ).toMatchObject({
        ok: true,
      });
    });

    it("a holder of a bundle reads and plays its courses, and no other", async () => {
      expect(JSON.stringify(await read(world.bundleHolder, world.other))).toContain("Other-notes");
      expect(JSON.stringify(await read(world.bundleHolder, world.course))).not.toContain(
        "Holders-only-notes",
      );
      expect(
        await call("media.play", { id: world.otherVideo }, outside(world.bundleHolder)),
      ).toMatchObject({ ok: true });
      expect(
        await call("media.play", { id: world.lessonVideo }, outside(world.bundleHolder)),
      ).toEqual(NOT_FOUND);
    });

    it("a non-holder, a voided enrolment, a lapsed one and the public: no holders' part, the one not-found", async () => {
      for (const who of [world.stranger, world.voided, world.lapsed]) {
        const outcome = await read(who, world.course);
        expect(outcome.ok).toBe(true);
        const text = JSON.stringify(outcome);
        expect(text).not.toContain("Holders-only-notes");
        expect(text).not.toContain(world.lessonVideo);
        expect(await call("media.play", { id: world.lessonVideo }, outside(who))).toEqual(
          NOT_FOUND,
        );
        // Filtering on the outline finds nothing it does not show.
        const probe = await call(
          "my.list",
          { object: course(), filter: { field: "outline", op: "contains", value: "Holders-only" } },
          outside(who),
        );
        expect(JSON.stringify(probe)).not.toContain("Holders-only-notes");
      }
      expect(await call("media.play", { id: world.lessonVideo }, outside(PUBLIC))).toEqual(
        NOT_FOUND,
      );
      const peek = JSON.stringify(
        await call("content.get", { object: course(), slug: "handstands" }, outside(PUBLIC)),
      );
      expect(peek).not.toContain("Holders-only-notes");
      // A made-up id answers as a video they may not play.
      expect(
        await call("media.play", { id: "med_01MADEUP000000000000000000" }, outside(world.holder)),
      ).toEqual(NOT_FOUND);
    });

    it("staff read the whole outline and play any ready video", async () => {
      const got = await call("record.get", { object: course(), id: world.course }, context(admin));
      const text = JSON.stringify(got);
      expect(text).toContain("Holders-only-notes");
      expect(text).toContain("Staff-only-note");
      expect(await call("media.play", { id: world.lessonVideo }, context(admin))).toMatchObject({
        ok: true,
      });
    });
  });
}
