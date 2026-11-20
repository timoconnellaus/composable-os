// Fixtures for the stage 22 customer tests (ADR 0402, ADR 0412): objects that declare a customer,
// two customers with records in each, and operations open to customers and the public.
//
// The SDK's `customer` key and the real `my.*` and `me.*` operations come in later steps. Until
// then the declaration is attached to reconciled fixture objects in the field registry, and the
// operations below stand in. They live in a registry of their own: nothing here is ever in the
// core registry or in open-operations.json.
import { env } from "cloudflare:workers";
import { CompiledQuery } from "kysely";
import { z } from "zod";
import { fieldStorage, objectTableOf } from "../src/extensions/schema.ts";
import { listObjects, setExtensionObjects } from "../src/fields/index.ts";
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
  getVisible,
  type HandlerContext,
  invoke,
  LIST_MAX_LIMIT,
  listVisible,
  loadPerson,
  newId,
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

export const DECLARATIONS: Record<string, CustomerDeclaration> = {
  [ORDER]: { field: "buyer", read: ["title", "status", "total", "note"], write: ["note"] },
  [TICKET]: { field: "holder", read: ["code", "seat", "comment"], write: ["comment"] },
};

/** Fields a customer must never learn anything about, per object. */
export const UNLISTED: Record<string, string[]> = {
  [ORDER]: ["internalNote", "margin", "buyer", "createdAt", "updatedAt", "createdBy"],
  [TICKET]: ["checkedInBy", "holder", "createdAt", "updatedAt", "createdBy"],
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
    records: { [ORDER]: [], [TICKET]: [] },
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
    for (const [object, values] of [
      [ORDER, order],
      [TICKET, ticket],
    ] as const) {
      const created = await invoke("record.create", { object, values }, context(admin));
      customer.records[object]?.push(created.id);
      customer.secrets.push(created.id);
      if (n === 1) customer.values[object] = values;
      for (const [field, value] of Object.entries(values)) {
        // `open` and `paid` are shared words, and the person id is listed once already.
        if (field === "status" || field === "buyer" || field === "holder") continue;
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
    const table = objectTableOf(object) as string;
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

const objectName = z.string().min(1).max(80);
const recordOut = z.object({
  object: z.string(),
  id: z.string(),
  values: z.record(z.string(), z.unknown()),
});
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
  handler: (input, ctx) => listVisible(ctx, input.object, input),
});

/** What `my.get` will be. */
const myGet = defineOperation({
  ...customerOnly,
  name: "fixture.myGet",
  description: "Fixture: one of the caller's own records, through the seam.",
  input: z.object({ object: objectName, id: z.string().min(1).max(64) }),
  output: recordOut,
  risk: "read",
  handler: (input, ctx) => getVisible(ctx, input.object, input.id),
});

function update(ctx: HandlerContext, object: string, id: string, values: Record<string, unknown>) {
  const table = objectTableOf(object);
  if (!table) throw new ValidationError(`Unknown object "${object}"`, { object });
  for (const [field, value] of Object.entries(values)) {
    const storage = fieldStorage(object, field);
    if (!storage?.column) {
      throw new ValidationError(`Unknown field "${field}" on ${object}`, { field });
    }
    ctx.write(
      CompiledQuery.raw(`UPDATE ${table} SET ${storage.column} = ?, updated_at = ? WHERE id = ?`, [
        value as string,
        ctx.now,
        id,
      ]),
    );
  }
}

/** A write as a careful tool would make it: it reads the record through the seam first. */
const myUpdate = defineOperation({
  ...customerOnly,
  name: "fixture.myUpdate",
  description: "Fixture: changes fields of one of the caller's own records.",
  input: z.object({
    object: objectName,
    id: z.string().min(1).max(64),
    values: z.record(z.string().max(80), z.union([z.string(), z.number(), z.null()])),
  }),
  output: recordOut,
  risk: "write",
  async handler(input, ctx) {
    const before = await getVisible(ctx, input.object, input.id);
    update(ctx, input.object, input.id, input.values);
    ctx.recordChange({
      object: input.object,
      id: input.id,
      action: "update",
      before: Object.fromEntries(
        Object.keys(input.values).map((k) => [k, before.values[k] ?? null]),
      ),
      after: input.values,
    });
    return ctx.afterCommit(() => getVisible(ctx, input.object, input.id));
  },
});

/**
 * A write as a careless tool would make it: straight to the table by id, any field, with no
 * read and no check. Only the seam's check on recorded changes stands between it and someone
 * else's row.
 */
const carelessUpdate = defineOperation({
  ...customerOnly,
  name: "fixture.carelessUpdate",
  description: "Fixture: updates a record by id without checking whose it is.",
  input: z.object({
    object: objectName,
    id: z.string().min(1).max(64),
    values: z.record(z.string().max(80), z.union([z.string(), z.number(), z.null()])),
  }),
  output: z.object({ ok: z.boolean() }),
  risk: "write",
  async handler(input, ctx) {
    update(ctx, input.object, input.id, input.values);
    ctx.recordChange({
      object: input.object,
      id: input.id,
      action: "update",
      before: Object.fromEntries(Object.keys(input.values).map((k) => [k, "(not read)"])),
      after: input.values,
    });
    return { ok: true };
  },
});

/** A create that lets its caller name the owner. The seam allows only the caller. */
const myCreate = defineOperation({
  ...customerOnly,
  name: "fixture.myCreate",
  description: "Fixture: creates a record for the caller, or for whoever the input names.",
  input: z.object({
    object: objectName,
    owner: z.string().min(1).max(64).optional(),
    values: z.record(z.string().max(80), z.union([z.string(), z.number(), z.null()])),
  }),
  output: z.object({ id: z.string() }),
  risk: "write",
  async handler(input, ctx) {
    const definition = getObject(input.object);
    const table = objectTableOf(input.object);
    const ownerField = definition?.customer?.field;
    if (!definition || !table || !ownerField || ctx.principal.kind !== "customer") {
      throw new ValidationError(`Unknown object "${input.object}"`, { object: input.object });
    }
    const id = newId("record");
    const values = { ...input.values, [ownerField]: input.owner ?? ctx.principal.personId };
    const columns = ["id", "created_at", "updated_at"];
    const params: unknown[] = [id, ctx.now, ctx.now];
    for (const [field, value] of Object.entries(values)) {
      const storage = fieldStorage(input.object, field);
      if (!storage?.column) {
        throw new ValidationError(`Unknown field "${field}" on ${input.object}`, { field });
      }
      columns.push(storage.column);
      params.push(value);
    }
    ctx.write(
      CompiledQuery.raw(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        params,
      ),
    );
    ctx.recordChange({ object: input.object, id, action: "create", after: values });
    return { id };
  },
});

/** A handler that reaches for a staff loader: the seam gives it nothing. */
const peekPerson = defineOperation({
  ...customerOnly,
  name: "fixture.peekPerson",
  description: "Fixture: tries to load any person with the staff loader.",
  input: z.object({ id: z.string().min(1).max(64) }),
  output: z.object({ person: z.unknown() }),
  risk: "read",
  handler: async (input, ctx) => ({ person: await loadPerson(ctx, input.id) }),
});

/** A handler that lists with the registry's full definition, as a staff list does. */
const rawList = defineOperation({
  ...customerOnly,
  name: "fixture.rawList",
  description: "Fixture: lists an object with its full definition, not the caller's view of it.",
  input: z.object({
    object: objectName,
    filter: filterSchema.optional(),
    sort: sortSchema.optional(),
    limit: z.number().int().min(1).max(LIST_MAX_LIMIT).default(50),
  }),
  output: z.object({ rows: z.array(z.record(z.string(), z.unknown())) }),
  risk: "read",
  async handler(input, ctx) {
    const definition = getObject(input.object);
    if (!definition) {
      throw new ValidationError(`Unknown object "${input.object}"`, { object: input.object });
    }
    const page = await runListQuery<{ id: string }>(ctx, definition, input);
    return { rows: page.rows };
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
  handler: (input, ctx) => listVisible(ctx, input.object, { limit: 50 }),
});

/** A public write that records a change: the public change nothing. */
const publicWrite = defineOperation({
  name: "fixture.publicWrite",
  description: "Fixture: a public operation that tries to change a record.",
  input: z.object({ object: objectName, id: z.string().min(1).max(64) }),
  output: z.object({ ok: z.boolean() }),
  permission: "records:read",
  risk: "write",
  audiences: ["public"],
  async handler(input, ctx) {
    update(ctx, input.object, input.id, { note: "written by the public" });
    ctx.recordChange({
      object: input.object,
      id: input.id,
      action: "update",
      before: { note: null },
      after: { note: "written by the public" },
    });
    return { ok: true };
  },
});

export const fixtureOperations = [
  myList,
  myGet,
  myUpdate,
  carelessUpdate,
  myCreate,
  peekPerson,
  rawList,
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
