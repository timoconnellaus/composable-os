// Fixtures for the stage 22 customer tests (ADR 0402, ADR 0412): objects that declare a customer,
// two customers with records in each, and operations open to customers and the public.
//
// The SDK's `customer` key and the real `my.*` and `me.*` operations come in later steps. Until
// then the declaration is attached to reconciled fixture objects in the field registry, and the
// operations below stand in. They live in a registry of their own: nothing here is ever in the
// core registry or in open-operations.json.
import { env } from "cloudflare:workers";
import { CompiledQuery, sql } from "kysely";
import { z } from "zod";
import { fieldStorage, objectTableOf } from "../src/extensions/schema.ts";
import { BASE_TABLES, listObjects, setExtensionObjects } from "../src/fields/index.ts";
import type { CustomerDeclaration } from "../src/fields/types.ts";
import {
  type ActingUser,
  type CustomerPrincipal,
  coreRegistry,
  createInvoker,
  createRegistry,
  defineOperation,
  filterSchema,
  getObject,
  invoke,
  LIST_MAX_LIMIT,
  loadPerson,
  type OutsideInvocationContext,
  type PublicPrincipal,
  refreshSchemaRegistry,
  runListQuery,
  sortSchema,
  ValidationError,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, db, unique } from "./helpers.ts";

export const SHOP = extId("shop");
export const ORDER = `${SHOP}.order`;
export const TICKET = `${SHOP}.ticket`;
/** An object that declares no customer: it must not exist for one. */
export const SUPPLIER = `${SHOP}.supplier`;
/** An object a customer may create records of: every field they must give is writable. */
export const REQUEST = `${SHOP}.request`;
/** Something for sale (stage 25): what the real orders below are for. No customer declared. */
export const ITEM = `${SHOP}.item`;

export const DECLARATIONS: Record<string, CustomerDeclaration> = {
  [ORDER]: { field: "buyer", read: ["title", "status", "total", "note"], write: ["note"] },
  [TICKET]: { field: "holder", read: ["code", "seat", "comment"], write: ["comment"] },
  [REQUEST]: { field: "asker", read: ["text"], write: ["text"] },
};

/** Fields a customer must never learn anything about, per object. */
export const UNLISTED: Record<string, string[]> = {
  [ORDER]: ["internalNote", "margin", "buyer", "createdAt", "updatedAt", "createdBy"],
  [TICKET]: ["checkedInBy", "holder", "createdAt", "updatedAt", "createdBy"],
  [REQUEST]: ["handledBy", "asker", "createdAt", "updatedAt", "createdBy"],
};

/**
 * Attaches the `customer` declarations to the reconciled fixture objects. The registry is
 * reloaded from D1 only when the schema changes, so call this after the last `reconcile`.
 */
export async function declareCustomers(
  declarations: Record<string, CustomerDeclaration> = DECLARATIONS,
): Promise<void> {
  await refreshSchemaRegistry(db.query);
  setExtensionObjects(
    new Map(
      listObjects().map((object) => {
        const customer = declarations[object.name];
        return [object.name, customer ? { ...object, customer } : object];
      }),
    ),
  );
}

export async function installShop(): Promise<void> {
  await reconcile(
    manifest(SHOP, {
      objects: {
        order: {
          label: "Order",
          plural: "Orders",
          titleField: "title",
          fields: {
            title: { type: "text", label: "Title", required: true },
            status: {
              type: "select",
              label: "Status",
              options: [
                { value: "open", label: "Open" },
                { value: "paid", label: "Paid" },
              ],
            },
            total: { type: "number", label: "Total" },
            note: { type: "text", label: "Note from the buyer" },
            internalNote: { type: "text", label: "Staff note" },
            margin: { type: "number", label: "Margin" },
            buyer: { type: "relation", label: "Buyer", to: "person" },
          },
        },
        ticket: {
          label: "Ticket",
          plural: "Tickets",
          titleField: "code",
          fields: {
            code: { type: "text", label: "Code", required: true },
            seat: { type: "text", label: "Seat" },
            comment: { type: "text", label: "Comment" },
            checkedInBy: { type: "text", label: "Checked in by" },
            holder: { type: "relation", label: "Holder", to: "person" },
          },
        },
        request: {
          label: "Request",
          plural: "Requests",
          titleField: "text",
          fields: {
            text: { type: "text", label: "Request", required: true },
            handledBy: { type: "text", label: "Handled by" },
            asker: { type: "relation", label: "Asker", to: "person" },
          },
        },
        item: {
          label: "Item",
          plural: "Items",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            price: { type: "currency", label: "Price", currency: "AUD" },
          },
          sellable: { price: "price" },
        },
        supplier: {
          label: "Supplier",
          plural: "Suppliers",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            terms: { type: "text", label: "Terms" },
          },
        },
      },
    }),
  );
  await declareCustomers();
  // Real orders (stage 25): the item is for sale (it declares `sellable`), and the deployment
  // has a currency.
  await env.DB.prepare(
    "INSERT INTO core_settings (key, value, updated_at, updated_by) VALUES ('order_currency', '\"AUD\"', ?, NULL) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(new Date().toISOString())
    .run();
}

/**
 * Gives `customer` a real account and two real orders (stage 25, ADR 0427), each for an item
 * only they bought, started as the customer through `order.start`. Their ids, their lines' ids,
 * their totals and what they bought join the customer's records and secrets, so everything that
 * aims at B's rows aims at B's orders too.
 */
export async function giveOrders(admin: ActingUser, customer: Customer): Promise<void> {
  const tag = customer.principal.customerId.slice("cus_".length).toLowerCase();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO core_customer (id, person_id, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(
      customer.principal.customerId,
      customer.principal.personId,
      `${tag}@orders.example`,
      now,
      now,
    )
    .run();
  customer.records.order = [];
  customer.records.orderLine = [];
  for (let n = 1; n <= 2; n += 1) {
    const cents = secretNumber();
    const name = `Item-${tag}-${n}`;
    const item = await invoke(
      "record.create",
      { object: ITEM, values: { name, price: cents / 100 } },
      context(admin),
    );
    const order = (await invoker.invokeByName(
      "order.start",
      { lines: [{ object: ITEM, id: item.id }] },
      outside(customer.principal),
    )) as { id: string; total: number; lines: { id: string }[] };
    if (order.total !== cents) throw new Error(`fixture order priced ${order.total}, not ${cents}`);
    customer.records.order.push(order.id);
    customer.records.orderLine.push(...order.lines.map((line) => line.id));
    customer.secrets.push(order.id, ...order.lines.map((l) => l.id), String(cents), name, item.id);
    if (n === 1) {
      customer.values.order = { total: cents, state: "pending", currency: "AUD" };
      customer.values.orderLine = {
        orderId: order.id,
        title: name,
        unitPrice: cents,
        total: cents,
      };
    }
  }
  customer.secrets.push(`${tag}@orders.example`);
}

export interface Customer {
  principal: CustomerPrincipal;
  /** A letter for messages: A or B. */
  label: string;
  /** Record ids by object. */
  records: Record<string, string[]>;
  /** Every value in this customer's rows that no one else may see, as it would print in JSON. */
  secrets: string[];
  /** Values by object and field, of the customer's first record of each object. */
  values: Record<string, Record<string, unknown>>;
}

let numbers = 700_000_000;
const secretNumber = () => {
  numbers += 7919;
  return numbers;
};

/** A person, their customer principal, and two orders and two tickets of their own. */
export async function createCustomer(admin: ActingUser, label: string): Promise<Customer> {
  const tag = unique(label);
  const email = `${tag}@customers.example`;
  const person = await invoke(
    "person.create",
    { givenName: `Given-${tag}`, familyName: `Family-${tag}`, emails: [{ email }] },
    context(admin),
  );
  const customer: Customer = {
    label,
    principal: { kind: "customer", customerId: `cus_${tag}`, personId: person.id },
    records: { [ORDER]: [], [TICKET]: [], [REQUEST]: [] },
    secrets: [`Given-${tag}`, `Family-${tag}`, email, person.id],
    values: {},
  };
  for (let n = 1; n <= 2; n += 1) {
    const order = {
      title: `Order-${tag}-${n}`,
      status: n === 1 ? "open" : "paid",
      total: secretNumber(),
      note: `Note-${tag}-${n}`,
      internalNote: `Internal-${tag}-${n}`,
      margin: secretNumber(),
      buyer: person.id,
    };
    const ticket = {
      code: `Code-${tag}-${n}`,
      seat: `Seat-${tag}-${n}`,
      comment: `Comment-${tag}-${n}`,
      checkedInBy: `CheckedIn-${tag}-${n}`,
      holder: person.id,
    };
    const request = {
      text: `Request-${tag}-${n}`,
      handledBy: `HandledBy-${tag}-${n}`,
      asker: person.id,
    };
    for (const [object, values] of [
      [ORDER, order],
      [TICKET, ticket],
      [REQUEST, request],
    ] as const) {
      const created = await invoke("record.create", { object, values }, context(admin));
      customer.records[object]?.push(created.id);
      customer.secrets.push(created.id);
      if (n === 1) customer.values[object] = values;
      for (const [field, value] of Object.entries(values)) {
        // `open` and `paid` are shared words, and the person id is listed once already.
        if (["status", "buyer", "holder", "asker"].includes(field)) continue;
        customer.secrets.push(String(value));
      }
    }
  }
  return customer;
}

export async function createSupplier(
  admin: ActingUser,
): Promise<{ id: string; secrets: string[] }> {
  const tag = unique("supplier");
  const created = await invoke(
    "record.create",
    { object: SUPPLIER, values: { name: `Supplier-${tag}`, terms: `Terms-${tag}` } },
    context(admin),
  );
  return { id: created.id, secrets: [`Supplier-${tag}`, `Terms-${tag}`, created.id] };
}

/** The rows of a customer's records and their Person, exactly as stored. */
export async function snapshot(customer: Customer): Promise<string> {
  const rows: unknown[] = [];
  for (const [object, ids] of Object.entries(customer.records)) {
    const table = (objectTableOf(object) ??
      BASE_TABLES[object as keyof typeof BASE_TABLES]) as string;
    for (const id of ids) {
      rows.push(await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first());
    }
  }
  rows.push(
    await env.DB.prepare("SELECT * FROM core_person WHERE id = ?")
      .bind(customer.principal.personId)
      .first(),
    (
      await env.DB.prepare("SELECT * FROM core_person_emails WHERE person_id = ? ORDER BY id")
        .bind(customer.principal.personId)
        .all()
    ).results,
  );
  return JSON.stringify(rows);
}

// --- Operations open to customers and the public ---------------------------------------------
//
// A handler here has what a real one has (ADR 0413): `ctx.records` and nothing else of the
// database. `rawAccess` tries the rest, and `bookkeeping` is the one kind allowed to keep it.

const objectName = z.string().min(1).max(80);
const recordOut = z.object({
  object: z.string(),
  id: z.string(),
  values: z.record(z.string(), z.unknown()),
});
const valuesIn = z.record(z.string().max(80), z.union([z.string(), z.number(), z.null()]));
const customerOnly = {
  permission: "records:read",
  audiences: ["customer"],
} as const;

/** What `my.list` will be: a page of the caller's own records of any object. */
const myList = defineOperation({
  ...customerOnly,
  name: "fixture.myList",
  description: "Fixture: a page of the caller's own records of an object, through the seam.",
  input: z.object({
    object: objectName,
    filter: filterSchema.optional(),
    sort: sortSchema.optional(),
    cursor: z.string().max(1000).optional(),
    limit: z.number().int().min(1).max(LIST_MAX_LIMIT).default(50),
  }),
  output: z.object({ items: z.array(recordOut), nextCursor: z.string().nullable() }),
  risk: "read",
  handler: (input, ctx) => ctx.records.list(input.object, input),
});

/** What `my.get` will be. */
const myGet = defineOperation({
  ...customerOnly,
  name: "fixture.myGet",
  description: "Fixture: one of the caller's own records, through the seam.",
  input: z.object({ object: objectName, id: z.string().min(1).max(64) }),
  output: recordOut,
  risk: "read",
  handler: (input, ctx) => ctx.records.get(input.object, input.id),
});

const myCount = defineOperation({
  ...customerOnly,
  name: "fixture.myCount",
  description: "Fixture: how many of the caller's own records match a filter.",
  input: z.object({ object: objectName, filter: filterSchema.optional() }),
  output: z.object({ count: z.number(), capped: z.boolean() }),
  risk: "read",
  handler: (input, ctx) => ctx.records.count(input.object, input.filter),
});

/** A write as a tool makes it: through the seam's helper, which checks whose record it is. */
const myUpdate = defineOperation({
  ...customerOnly,
  name: "fixture.myUpdate",
  description: "Fixture: changes fields of one of the caller's own records.",
  input: z.object({ object: objectName, id: z.string().min(1).max(64), values: valuesIn }),
  output: recordOut,
  risk: "write",
  async handler(input, ctx) {
    await ctx.records.update(input.object, input.id, input.values);
    return ctx.afterCommit(() => ctx.records.get(input.object, input.id));
  },
});

/** A create that passes on whatever its caller sent, the owner field included. */
const myCreate = defineOperation({
  ...customerOnly,
  name: "fixture.myCreate",
  description: "Fixture: creates a record for the caller from the values given.",
  input: z.object({ object: objectName, values: valuesIn }),
  output: z.object({ id: z.string() }),
  risk: "write",
  handler: (input, ctx) => ctx.records.create(input.object, input.values),
});

/**
 * A handler that reaches past the seam, each way there is: the raw database, a queued statement,
 * a change it only claims to have made, an activity. None of them is there for it.
 */
const rawAccess = defineOperation({
  ...customerOnly,
  name: "fixture.rawAccess",
  description: "Fixture: tries to read or write a record without the seam's helpers.",
  input: z.object({
    how: z.enum(["db", "write", "recordChange", "postActivity", "loader", "list"]),
    object: objectName,
    id: z.string().min(1).max(64),
  }),
  output: z.object({ got: z.unknown() }),
  risk: "write",
  async handler(input, ctx) {
    const table = objectTableOf(input.object) ?? "core_person";
    switch (input.how) {
      case "db":
        return {
          got: await sql`SELECT * FROM ${sql.table(table)} WHERE id = ${input.id}`.execute(ctx.db),
        };
      case "write":
        ctx.write(
          CompiledQuery.raw(`UPDATE ${table} SET updated_at = ? WHERE id = ?`, ["x", input.id]),
        );
        return { got: "queued" };
      case "recordChange":
        ctx.recordChange({ object: input.object, id: input.id, action: "update", diff: {} });
        return { got: "recorded" };
      case "postActivity":
        return {
          got: ctx.postActivity({
            subject: "from a customer",
            payload: { kind: "note" },
            links: [{ object: input.object, id: input.id }],
          }),
        };
      case "loader":
        return { got: await loadPerson(ctx, input.id) };
      case "list": {
        const definition = getObject(input.object);
        if (!definition) throw new ValidationError(`Unknown object "${input.object}"`);
        return { got: await runListQuery<{ id: string }>(ctx, definition, { limit: 50 }) };
      }
    }
  },
});

/**
 * Core bookkeeping (`hostInternal`): it keeps the raw database and write queue. A record change
 * it records itself is still checked in full by the seam before anything commits.
 */
const bookkeeping = defineOperation({
  ...customerOnly,
  name: "fixture.bookkeeping",
  description: "Fixture: a hostInternal operation that writes a note on a record with raw SQL.",
  input: z.object({
    object: objectName,
    id: z.string().min(1).max(64),
    field: z.string().default("note"),
  }),
  output: z.object({ people: z.number() }),
  risk: "write",
  hostInternal: true,
  async handler(input, ctx) {
    const table = objectTableOf(input.object);
    const column = fieldStorage(input.object, input.field)?.column;
    if (!table || !column) throw new ValidationError(`Unknown object "${input.object}"`);
    const { rows } = await sql<{ n: number }>`SELECT count(*) AS n FROM core_person`.execute(
      ctx.db,
    );
    ctx.write(
      CompiledQuery.raw(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [
        "kept by the host",
        input.id,
      ]),
    );
    ctx.recordChange({
      object: input.object,
      id: input.id,
      action: "update",
      before: { [input.field]: null },
      after: { [input.field]: "kept by the host" },
    });
    return { people: Number(rows[0]?.n ?? 0) };
  },
});

/** A handler written for staff by mistake: it reads the staff user. */
const staffHabit = defineOperation({
  ...customerOnly,
  name: "fixture.staffHabit",
  description: "Fixture: reads ctx.user, which a customer's call does not have.",
  input: z.object({}),
  output: z.object({ userId: z.string() }),
  risk: "read",
  handler: async (_input, ctx) => ({ userId: ctx.user.id }),
});

const whoAmI = defineOperation({
  name: "fixture.whoAmI",
  description: "Fixture: says which kind of caller this is. Open to everyone.",
  input: z.object({}),
  output: z.object({ kind: z.string() }),
  permission: "records:read",
  risk: "read",
  audiences: ["staff", "customer", "public"],
  handler: async (_input, ctx) => ({ kind: ctx.principal.kind }),
});

/** A public read that tries to read records: the public have no scope on anything. */
const publicPeek = defineOperation({
  name: "fixture.publicPeek",
  description: "Fixture: a public operation that tries to list an object.",
  input: z.object({ object: objectName }),
  output: z.object({ items: z.array(recordOut), nextCursor: z.string().nullable() }),
  permission: "records:read",
  risk: "read",
  audiences: ["public"],
  handler: (input, ctx) => ctx.records.list(input.object),
});

/** A public write: the public change nothing. */
const publicWrite = defineOperation({
  name: "fixture.publicWrite",
  description: "Fixture: a public operation that tries to change a record.",
  input: z.object({ object: objectName, id: z.string().min(1).max(64) }),
  output: z.object({ ok: z.boolean() }),
  permission: "records:read",
  risk: "write",
  audiences: ["public"],
  async handler(input, ctx) {
    await ctx.records.update(input.object, input.id, { note: "written by the public" });
    return { ok: true };
  },
});

export const fixtureOperations = [
  myList,
  myGet,
  myCount,
  myUpdate,
  myCreate,
  rawAccess,
  bookkeeping,
  staffHabit,
  whoAmI,
  publicPeek,
  publicWrite,
] as const;

/** The core registry plus the fixtures: what a deployment with opened operations looks like. */
export const fixtureRegistry = createRegistry([...coreRegistry.list(), ...fixtureOperations]);
const invoker = createInvoker(fixtureRegistry);

export const PUBLIC: PublicPrincipal = { kind: "public" };

export function outside(
  principal: CustomerPrincipal | PublicPrincipal,
  overrides: Partial<OutsideInvocationContext> = {},
): OutsideInvocationContext {
  return { principal, db, ...overrides };
}

export type Outcome = { ok: true; value: unknown } | { ok: false; error: Record<string, unknown> };

/** Calls an operation of the fixture registry and returns what the caller would be sent. */
export async function call(
  name: string,
  input: unknown,
  ctx: Parameters<typeof invoker.invokeByName>[2],
): Promise<Outcome> {
  try {
    return { ok: true, value: await invoker.invokeByName(name, input, ctx) };
  } catch (error) {
    const e = error as { toJSON?: () => Record<string, unknown>; message?: string };
    return {
      ok: false,
      error: typeof e.toJSON === "function" ? e.toJSON() : { thrown: String(e.message ?? error) },
    };
  }
}
