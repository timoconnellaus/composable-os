// Stage 37 step 2: stockMoves and low-stock notices (ADR 0681). A receipt entering `received` adds
// its quantity with its unit cost, a quick stock-in made received adds too, a write-off removes,
// a count applied sets each of its lines' variants to the number counted with `counted`
// movements of the difference (judged at the commit, refused below what unpaid orders hold with
// the numbers), all in the batch of the move; what moved stock cannot change afterwards; the
// declaration's checks and the runtime refusal; the staff who keep stock told once per crossing
// of the reorder level, whatever the write (a sale, a receipt, a count, a write-off); and a
// count's apply costing the same statements for 2 lines as for the limit. Acceptance criteria
// 12 (receipts), 13, 14, 16 (the ledger, by step 1's triggers), 19 (stockMoves) and 20 (a count).
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import {
  defineExtension,
  defineTool,
  type ExtensionManifest,
  toManifest,
  validateManifest,
  z,
} from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  checkManifest,
  createInvoker,
  LOW_STATEMENTS,
  STOCK_MOVES_MAX_LINES,
  STOCK_MOVES_STATEMENTS,
  stockMoveStatements,
} from "../src/index.ts";
import { extId, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";
import { CURRENCY, orderRegistry, outside, PUBLIC, refusal, run } from "./order-fixtures.ts";

const ext = extId("smv");
const VARIANT = `${ext}.variant`;
const RECEIPT = `${ext}.receipt`;
const WRITEOFF = `${ext}.writeoff`;
const COUNT = `${ext}.count`;
const LINE = `${ext}.countline`;
const KEEP = `${ext}:stock`;

const select = (...values: string[]) => ({
  type: "select" as const,
  label: "State",
  options: values.map((value) => ({ value, label: value })),
});

function shop(id: string): ExtensionManifest {
  return toManifest(
    defineExtension({
      id,
      version: "1.0.0",
      contractVersion: 1,
      permissions: { modules: ["ops"] },
      roles: {
        stockroom: {
          label: "Stockroom",
          description: "Fixture: receives and counts stock.",
          permissions: [`${id}:stock`],
          read: [`${id}.variant`],
        },
        door: {
          label: "Door",
          description: "Fixture: holds the stock permission and reads no variant.",
          permissions: [`${id}:stock`],
          read: [],
        },
      },
      tools: {
        receive: defineTool({
          description: "Fixture: receives a delivery (a person approves anyone else's call).",
          input: z.object({}),
          output: z.object({}),
          permission: `${id}:stock`,
          personApproves: true,
          handler: () => ({}),
        }),
        writeOff: defineTool({
          description: "Fixture: writes stock off, a person's own act.",
          input: z.object({}),
          output: z.object({}),
          permission: `${id}:stock`,
          humanOnly: true,
          handler: () => ({}),
        }),
        applyCount: defineTool({
          description: "Fixture: applies a count (a person approves anyone else's call).",
          input: z.object({}),
          output: z.object({}),
          permission: `${id}:stock`,
          personApproves: true,
          handler: () => ({}),
        }),
      },
      objects: {
        variant: {
          label: "Variant",
          plural: "Variants",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            price: { type: "currency", label: "Price", currency: CURRENCY },
            reorderLevel: { type: "number", label: "Reorder level" },
            reorderQty: { type: "number", label: "Reorder quantity" },
          },
          sellable: { price: "price" },
          stock: { reorderAt: "reorderLevel", reorderQty: "reorderQty", notify: `${id}:stock` },
          public: { read: ["name", "price"] },
        },
        receipt: {
          label: "Receipt",
          plural: "Receipts",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name" },
            variant: { type: "relation", label: "Variant", to: `${id}.variant` },
            quantity: { type: "number", label: "Quantity" },
            unitCost: { type: "number", label: "Unit cost" },
            note: { type: "text", label: "Note" },
            state: select("draft", "received", "cancelled"),
          },
          states: {
            field: "state",
            initial: "draft",
            moves: [
              { from: "draft", to: "received", by: ["host"], tools: ["receive"] },
              { from: "draft", to: "cancelled", by: ["staff"], final: true },
            ],
          },
          stockMoves: {
            move: "add",
            on: "variant",
            quantity: "quantity",
            when: "received",
            unitCost: "unitCost",
            note: "note",
          },
        },
        writeoff: {
          label: "Write-off",
          plural: "Write-offs",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name" },
            variant: { type: "relation", label: "Variant", to: `${id}.variant` },
            quantity: { type: "number", label: "Quantity" },
            state: select("draft", "done"),
          },
          states: {
            field: "state",
            initial: "draft",
            moves: [{ from: "draft", to: "done", by: ["host"], tools: ["writeOff"] }],
          },
          stockMoves: { move: "remove", on: "variant", quantity: "quantity", when: "done" },
        },
        count: {
          label: "Count",
          plural: "Counts",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name" },
            state: select("draft", "applied"),
          },
          states: {
            field: "state",
            initial: "draft",
            moves: [{ from: "draft", to: "applied", by: ["host"], tools: ["applyCount"] }],
          },
        },
        countline: {
          label: "Count line",
          plural: "Count lines",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name" },
            count: { type: "relation", label: "Count", to: `${id}.count` },
            variant: { type: "relation", label: "Variant", to: `${id}.variant` },
            counted: { type: "number", label: "Counted" },
          },
          stockMoves: {
            move: "set",
            on: "variant",
            quantity: "counted",
            when: "applied",
            through: "count",
          },
        },
      },
    }),
  );
}

interface Movement {
  quantity: number;
  kind: string;
  place: string;
  sourceType: string;
  sourceId: string;
  by: string | null;
  note: string | null;
  unitCost: number | null;
}

let admin: ActingUser;
let member: ActingUser;
let viewer: ActingUser;
let granted: ActingUser;
let stockroom: ActingUser;
let gone: ActingUser;
let door: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  viewer = await createUser("viewer");
  granted = await createUser("viewer");
  stockroom = await createUser("viewer");
  gone = await createUser("member");
  door = await createUser("viewer");
  const m = shop(ext);
  await reconcile(m);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', ?, ?, ?, ?)",
  )
    .bind(ext, JSON.stringify(m), admin.id, now, now)
    .run();
  await env.DB.prepare("UPDATE core_user SET granted_permissions = ? WHERE id = ?")
    .bind(JSON.stringify([KEEP]), granted.id)
    .run();
  await env.DB.prepare("UPDATE core_user SET pack_role = ? WHERE id = ?")
    .bind(`${ext}.stockroom`, stockroom.id)
    .run();
  await env.DB.prepare("UPDATE core_user SET pack_role = ? WHERE id = ?")
    .bind(`${ext}.door`, door.id)
    .run();
  await env.DB.prepare("UPDATE core_user SET deactivated_at = ? WHERE id = ?")
    .bind(now, gone.id)
    .run();
  await run("order.settings.update", { currency: CURRENCY }, context(admin));
});

async function create(object: string, values: Record<string, unknown>): Promise<string> {
  return (await run<{ id: string }>("record.create", { object, values }, context(admin))).id;
}

const update = (object: string, id: string, values: Record<string, unknown>, user = admin) =>
  run("record.update", { object, id, values }, context(user));

/** The tool of the pack that makes a move into a stock-moving state (a person's, ADR 0513). */
const TOOL_OF: Record<string, string> = {
  [RECEIPT]: "receive",
  [WRITEOFF]: "writeOff",
  [COUNT]: "applyCount",
};

/** A call made from inside the pack's tool, run for a person who holds its permission. */
const asTool = (name: string, overrides: Record<string, unknown> = {}) =>
  context(admin, {
    actor: "extension",
    extension: {
      id: ext,
      permissions: { read: [], write: [], operations: [], modules: ["ops"] },
      tool: {
        name,
        humanOnly: name === "writeOff",
        ...(name === "writeOff" ? {} : { personApproves: true }),
        permission: KEEP,
        calledBy: { account: admin.id, actor: "human" },
      },
    },
    ...overrides,
  } as never);

/** Moves a record into its stock-moving state through the pack's tool. */
const moveIn = (object: string, id: string, state: string, overrides = {}) =>
  run(
    "record.update",
    { object, id, values: { state } },
    asTool(TOOL_OF[object] as string, overrides),
  );

/** A quick stock-in: a receipt made, then received through the tool. */
async function stockIn(variant: string, quantity: number, values: Record<string, unknown> = {}) {
  const id = await create(RECEIPT, { variant, quantity, ...values });
  await moveIn(RECEIPT, id, "received");
  return id;
}

async function variantWith(quantity: number, values: Record<string, unknown> = {}) {
  const id = await create(VARIANT, { name: unique("Hoodie"), price: 60, ...values });
  if (quantity > 0) {
    await run("stock.opening", { object: VARIANT, id, quantity }, context(admin));
  }
  return id;
}

const stockOf = (id: string) =>
  run<{ onHand: number; held: number; available: number }>(
    "stock.get",
    { object: VARIANT, id },
    context(admin),
  );

async function movements(id: string): Promise<Movement[]> {
  return (
    await run<{ items: Movement[] }>("stock.movements", { object: VARIANT, id }, context(admin))
  ).items;
}

async function stateOf(object: string, id: string): Promise<unknown> {
  const got = await run<{ values?: Record<string, unknown> } & Record<string, unknown>>(
    "record.get",
    { object, id },
    context(admin),
  );
  return (got.values ?? got).state;
}

/** Who has been told a variant is low, by account, and how many times each. */
async function toldOf(variant: string): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare(
    "SELECT user_id, count(*) AS n FROM core_notifications WHERE dedupe_key LIKE 'stock_low:%' AND json_extract(link, '$.id') = ? GROUP BY user_id",
  )
    .bind(variant)
    .all<{ user_id: string; n: number }>();
  return Object.fromEntries(results.map((r) => [r.user_id, Number(r.n)]));
}

const startAsGuest = (lines: { object: string; id: string; quantity?: number }[]) =>
  run<{ id: string; total: number }>(
    "order.start",
    { lines, email: `${unique("guest")}@buyers.example` },
    outside(PUBLIC),
  );

const pay = (order: { id: string; total: number }) =>
  run(
    "fixture.verifiedPayment",
    { orderId: order.id, amount: order.total, eventId: unique("evt") },
    context(admin, { actor: "automation" }),
  );

async function countOf(lines: { variant: string; counted: number }[]): Promise<string> {
  const count = await create(COUNT, { name: unique("Count") });
  for (const line of lines) await create(LINE, { count, ...line });
  return count;
}

// --- The declaration --------------------------------------------------------------------------

describe("the stockMoves declaration", () => {
  const issuesOf = (change: (m: ExtensionManifest) => void) => {
    const m = structuredClone(shop("decl"));
    change(m);
    return validateManifest(m).issues.map((i) => `${i.path}: ${i.message}`);
  };
  type Objects = Record<string, Record<string, unknown>>;
  const objects = (m: ExtensionManifest) => m.objects as unknown as Objects;
  const object = (m: ExtensionManifest, name: string) =>
    objects(m)[name] as Record<string, unknown>;

  it("accepts the fixture", () => {
    expect(issuesOf(() => {})).toEqual([]);
  });

  it("refuses a target without stock, a quantity that is not a number, and a cost on a removal", () => {
    expect(
      issuesOf((m) => {
        object(m, "writeoff").stockMoves = {
          move: "remove",
          on: "name",
          quantity: "name",
          when: "done",
          unitCost: "quantity",
          kind: "received",
        };
      }),
    ).toEqual(
      expect.arrayContaining([
        'objects.writeoff.stockMoves.on: "name" must be a relation field (one record) to an object of this extension with stock',
        'objects.writeoff.stockMoves.quantity: "name" must be a number field of writeoff',
        "objects.writeoff.stockMoves.unitCost: Only what comes in (add) has a unit cost",
        'objects.writeoff.stockMoves.kind: A remove writes "written_off" or "used", not "received"',
      ]),
    );
  });

  it("refuses a state that is not one, a state something leaves, and a lifecycle missing", () => {
    expect(
      issuesOf((m) => {
        (object(m, "receipt").stockMoves as Record<string, unknown>).when = "nowhere";
        (object(m, "writeoff").stockMoves as Record<string, unknown>).when = "draft";
        delete object(m, "count").states;
      }),
    ).toEqual(
      expect.arrayContaining([
        'objects.receipt.stockMoves.when: "nowhere" is not a state of receipt',
        'objects.writeoff.stockMoves.when: No move may leave "draft": stock moves once, when a record enters it',
        'objects.countline.stockMoves.through: count must declare states: entering "applied" moves the stock',
      ]),
    );
  });

  it("refuses notify that names no tool's permission, and stock nobody sells or moves", () => {
    expect(
      issuesOf((m) => {
        (object(m, "variant").stock as Record<string, unknown>).notify = "decl:nobody";
        objects(m).part = {
          label: "Part",
          plural: "Parts",
          titleField: "name",
          fields: { name: { type: "text", label: "Name" } },
          stock: {},
        };
      }),
    ).toEqual(
      expect.arrayContaining([
        'objects.variant.stock.notify: "decl:nobody" is not the permission of any of this extension\'s tools (tools.<name>.permission)',
        "objects.part.stock: part has stock but is neither sellable nor moved by a stockMoves of this extension",
      ]),
    );
  });

  it("a runtime extension cannot declare it; a shipped one can", async () => {
    const id = extId("rt");
    const now = new Date().toISOString();
    const runtime = await checkManifest(db.query, id, shop(id), now, { source: "runtime" });
    expect(runtime.issues).toContainEqual(
      expect.objectContaining({
        code: "outside_audience",
        path: "objects.receipt.stockMoves",
        message: expect.stringMatching(
          /^A runtime extension cannot make receipt's states move stock/,
        ),
      }),
    );
    const shipped = await checkManifest(db.query, id, shop(id), now, { source: "shipped" });
    expect(shipped.issues).toEqual([]);
  });
});

// --- Receipts and write-offs --------------------------------------------------------------------

describe("a record's state moves its stock", () => {
  it("a receipt received adds its quantity with its unit cost, in the move's batch", async () => {
    const variant = await variantWith(0);
    const receipt = await create(RECEIPT, {
      variant,
      quantity: 24,
      unitCost: 1250,
      note: "Delivery 18",
    });
    expect(await stockOf(variant)).toMatchObject({ onHand: 0 });
    await moveIn(RECEIPT, receipt, "received");
    expect(await stockOf(variant)).toMatchObject({ onHand: 24, held: 0, available: 24 });
    expect(await movements(variant)).toEqual([
      expect.objectContaining({
        quantity: 24,
        kind: "received",
        place: "default",
        sourceType: RECEIPT,
        sourceId: receipt,
        by: admin.id,
        note: "Delivery 18",
        unitCost: 1250,
      }),
    ]);
  });

  it("a quick stock-in made received adds at once; a cancelled receipt adds nothing", async () => {
    const variant = await variantWith(2);
    await stockIn(variant, 6);
    const cancelled = await create(RECEIPT, { variant, quantity: 50 });
    await update(RECEIPT, cancelled, { state: "cancelled" });
    expect(await stockOf(variant)).toMatchObject({ onHand: 8 });
    expect((await movements(variant)).map((m) => [m.kind, m.quantity])).toEqual([
      ["received", 6],
      ["opening", 2],
    ]);
  });

  it("refuses a receipt with no quantity or no variant, and changing one once received", async () => {
    const variant = await variantWith(0);
    const none = await create(RECEIPT, { variant });
    expect(await refusal(moveIn(RECEIPT, none, "received"))).toMatchObject({
      code: "invalid_input",
      details: { rule: "stock_moves", field: "quantity" },
    });
    const nowhere = await create(RECEIPT, { quantity: 3 });
    expect(await refusal(moveIn(RECEIPT, nowhere, "received"))).toMatchObject({
      details: { rule: "stock_moves", field: "variant" },
    });
    expect(await stateOf(RECEIPT, none)).toBe("draft");
    const done = await stockIn(variant, 4);
    expect(await refusal(update(RECEIPT, done, { quantity: 40 }))).toMatchObject({
      code: "invalid_input",
      details: { rule: "stock_moves", field: "quantity" },
    });
    // Its name is not what moved stock.
    await update(RECEIPT, done, { name: "Corner shop" });
    expect(await stockOf(variant)).toMatchObject({ onHand: 4 });
  });

  it("a write-off removes; more than is on hand fails its batch and leaves it a draft", async () => {
    const variant = await variantWith(5);
    const broken = await create(WRITEOFF, { variant, quantity: 2 });
    await moveIn(WRITEOFF, broken, "done");
    expect(await stockOf(variant)).toMatchObject({ onHand: 3 });
    expect((await movements(variant))[0]).toMatchObject({
      quantity: -2,
      kind: "written_off",
      sourceId: broken,
    });
    const tooMany = await create(WRITEOFF, { variant, quantity: 4 });
    expect(await refusal(moveIn(WRITEOFF, tooMany, "done"))).toMatchObject({
      code: "invalid_input",
      details: { rule: "stock", onHand: -1, held: 0 },
    });
    expect(await stateOf(WRITEOFF, tooMany)).toBe("draft");
    expect(await stockOf(variant)).toMatchObject({ onHand: 3 });
  });
});

// --- Counts ---------------------------------------------------------------------------------------

describe("a count applied", () => {
  it("sets each variant to its counted number with counted movements of the difference", async () => {
    const [a, b, c] = [await variantWith(10), await variantWith(5), await variantWith(0)];
    const count = await countOf([
      { variant: a as string, counted: 8 },
      { variant: b as string, counted: 5 },
      { variant: c as string, counted: 3 },
    ]);
    await moveIn(COUNT, count, "applied");
    expect((await stockOf(a as string)).onHand).toBe(8);
    expect((await stockOf(b as string)).onHand).toBe(5);
    expect((await stockOf(c as string)).onHand).toBe(3);
    expect((await movements(a as string))[0]).toMatchObject({
      quantity: -2,
      kind: "counted",
      sourceType: LINE,
      by: admin.id,
    });
    // No difference, no movement.
    expect((await movements(b as string)).map((m) => m.kind)).toEqual(["opening"]);
    expect((await movements(c as string))[0]).toMatchObject({ quantity: 3, kind: "counted" });
  });

  it("is refused below what unpaid orders hold, with the numbers, and nothing moves", async () => {
    const held = await variantWith(3);
    const other = await variantWith(4);
    await startAsGuest([{ object: VARIANT, id: held, quantity: 2 }]);
    const count = await countOf([
      { variant: other, counted: 1 },
      { variant: held, counted: 1 },
    ]);
    const refused = await refusal(moveIn(COUNT, count, "applied"));
    expect(refused).toMatchObject({
      code: "invalid_input",
      details: { rule: "stock", record: held, onHand: 1, held: 2 },
    });
    expect(refused.message).toMatch(/2 held\. Count again in a few minutes/);
    expect(await stateOf(COUNT, count)).toBe("draft");
    expect((await stockOf(other)).onHand).toBe(4);
    expect((await stockOf(held)).onHand).toBe(3);
  });

  it("works out the difference when the batch commits, not when the lines were read", async () => {
    const variant = await variantWith(10);
    const statements = stockMoveStatements({
      object: VARIANT,
      source: LINE,
      move: "set",
      kind: "counted",
      lines: [{ source: "line_x", record: variant, quantity: 7, unitCost: null, note: null }],
      by: admin.id,
      now: new Date().toISOString(),
    });
    expect(statements).toHaveLength(STOCK_MOVES_STATEMENTS);
    // A sale (a correction here) lands between the count's read and its commit.
    await run(
      "stock.adjust",
      { object: VARIANT, id: variant, quantity: -4, reason: "Sold at the desk" },
      context(admin),
    );
    await db.batch(statements);
    expect((await stockOf(variant)).onHand).toBe(7);
    expect((await movements(variant)).find((m) => m.kind === "counted")).toMatchObject({
      quantity: 1,
    });
  });

  it("refuses a variant counted twice, and a line added or changed once applied", async () => {
    const variant = await variantWith(2);
    const twice = await countOf([
      { variant, counted: 1 },
      { variant, counted: 2 },
    ]);
    expect(await refusal(moveIn(COUNT, twice, "applied"))).toMatchObject({
      details: { rule: "stock_moves", field: "variant" },
    });
    const count = await countOf([{ variant, counted: 1 }]);
    await moveIn(COUNT, count, "applied");
    expect(
      await refusal(
        run(
          "record.create",
          { object: LINE, values: { count, variant, counted: 9 } },
          context(admin),
        ),
      ),
    ).toMatchObject({ code: "invalid_input", details: { rule: "stock_moves", field: "count" } });
    const { items } = await run<{ items: { id: string }[] }>(
      "record.list",
      { object: LINE, filter: { field: "count", op: "eq", value: count } },
      context(admin),
    );
    const line = items[0]?.id as string;
    expect(await refusal(update(LINE, line, { counted: 9 }))).toMatchObject({
      details: { rule: "stock_moves" },
    });
    await update(LINE, line, { name: "Shelf 2" });
    expect((await stockOf(variant)).onHand).toBe(1);
  });
});

// --- Low stock ------------------------------------------------------------------------------------

describe("low stock", () => {
  it("tells those who keep stock once per crossing of the reorder level, whatever the write", async () => {
    const variant = await variantWith(7, { reorderLevel: 5, reorderQty: 12 });
    const keepers = [admin.id, member.id, stockroom.id].sort();
    const told = async () => toldOf(variant);
    expect(await told()).toEqual({});
    // A sale to the level tells each of them once.
    const first = await startAsGuest([{ object: VARIANT, id: variant, quantity: 2 }]);
    await pay(first);
    expect((await stockOf(variant)).onHand).toBe(5);
    expect(Object.keys(await told()).sort()).toEqual(keepers);
    const [notice] = (
      await env.DB.prepare(
        "SELECT title, body, type FROM core_notifications WHERE user_id = ? AND json_extract(link, '$.id') = ?",
      )
        .bind(member.id, variant)
        .all<{ title: string; body: string; type: string }>()
    ).results;
    expect(notice).toMatchObject({ type: "system.message" });
    expect(notice?.title).toMatch(/ is low: 5 on hand$/);
    expect(notice?.body).toBe("At or below its reorder level of 5. Reorder quantity: 12.");
    // Another sale below it tells nobody again.
    await pay(await startAsGuest([{ object: VARIANT, id: variant, quantity: 1 }]));
    expect(Object.values(await told())).toEqual([1, 1, 1]);
    // A receipt above, then a write-off to below: told again.
    await stockIn(variant, 10);
    expect(Object.values(await told())).toEqual([1, 1, 1]);
    const writeoff = await create(WRITEOFF, { variant, quantity: 11 });
    await moveIn(WRITEOFF, writeoff, "done");
    expect((await stockOf(variant)).onHand).toBe(3);
    expect(Object.values(await told())).toEqual([2, 2, 2]);
    // Nobody else: not a viewer without the permission, nor one granted it while the pack does
    // not declare it grantable, nor an account that left.
    const all = await told();
    expect(all[viewer.id]).toBeUndefined();
    expect(all[granted.id]).toBeUndefined();
    expect(all[gone.id]).toBeUndefined();
    // Nor a fixed role holding the permission whose role does not read variants (the review of
    // #422): the notice names the record and its numbers.
    expect(all[door.id]).toBeUndefined();
  });

  it("a count, and a raised level, tell once each crossing", async () => {
    const counted = await variantWith(20, { reorderLevel: 4 });
    await moveIn(COUNT, await countOf([{ variant: counted, counted: 4 }]), "applied");
    expect(Object.keys(await toldOf(counted))).toHaveLength(3);
    const raised = await variantWith(8, { reorderLevel: 2 });
    await update(VARIANT, raised, { reorderLevel: 8 });
    expect(Object.keys(await toldOf(raised))).toHaveLength(3);
    await update(VARIANT, raised, { reorderLevel: 9 });
    expect(Object.values(await toldOf(raised))).toEqual([1, 1, 1]);
  });

  it("tells nobody about an object without a reorder level, or above it", async () => {
    const variant = await variantWith(9, { reorderLevel: 3 });
    await pay(await startAsGuest([{ object: VARIANT, id: variant, quantity: 1 }]));
    const none = await variantWith(1);
    await pay(await startAsGuest([{ object: VARIANT, id: none, quantity: 1 }]));
    expect(await toldOf(variant)).toEqual({});
    expect(await toldOf(none)).toEqual({});
  });
});

// --- After the review of #422 ----------------------------------------------------------------

/** A database whose first batch (the call's commit) waits for `first` to run and commit. */
function beforeCommitOf(first: () => Promise<unknown>) {
  let ran = false;
  const d1 = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!ran) {
            ran = true;
            await first();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return createCrmDb(d1);
}

async function linesOf(count: string): Promise<{ id: string }[]> {
  return (
    await run<{ items: { id: string }[] }>(
      "record.list",
      { object: LINE, filter: { field: "count", op: "eq", value: count } },
      context(admin),
    )
  ).items;
}

describe("moving stock is a person's act", () => {
  const issuesOf = (change: (m: ExtensionManifest) => void) => {
    const m = structuredClone(shop("decl"));
    change(m);
    return validateManifest(m).issues.map((i) => `${i.path}: ${i.message}`);
  };
  type Writable = Record<string, Record<string, unknown> & { states: Record<string, unknown> }>;

  it("the contract refuses a stock-moving state that staff or customers enter, or are made in", () => {
    const issues = issuesOf((m) => {
      const objects = m.objects as unknown as Writable;
      const receipt = objects.receipt as Writable[string];
      const count = objects.count as Writable[string];
      receipt.states.moves = [{ from: "draft", to: "received", by: ["staff"] }];
      receipt.states.create = { in: { received: ["staff"] } };
      count.states.moves = [{ from: "draft", to: "applied", by: ["customer", "host"] }];
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        'objects.receipt.states.moves.0.by: Entering "received" moves stock: declare it by ["host"] with the tools a person makes it through (states.moves.<n>.tools)',
        'objects.receipt.states.create.in.received: Creating a record in "received" moves stock: only the host may; create it in another state and move it through a tool',
        'objects.count.states.moves.0.by: Entering "applied" moves stock: declare it by ["host"] with the tools a person makes it through (states.moves.<n>.tools)',
      ]),
    );
  });

  it("an assistant, an MCP client or a member moves no stock by moving or making a record", async () => {
    const variant = await variantWith(3);
    const count = await countOf([{ variant, counted: 1_000_000 }]);
    const receipt = await create(RECEIPT, { variant, quantity: 500 });
    for (const ctx of [
      context(admin, { actor: "assistant" }),
      context(admin, { actor: "mcp" }),
      context(member),
      context(admin),
    ]) {
      await expect(
        run("record.update", { object: COUNT, id: count, values: { state: "applied" } }, ctx),
      ).rejects.toBeTruthy();
      await expect(
        run("record.update", { object: RECEIPT, id: receipt, values: { state: "received" } }, ctx),
      ).rejects.toBeTruthy();
      await expect(
        run(
          "record.create",
          { object: RECEIPT, values: { variant, quantity: 500, state: "received" } },
          ctx,
        ),
      ).rejects.toBeTruthy();
    }
    expect((await stockOf(variant)).onHand).toBe(3);
    expect(await stateOf(COUNT, count)).toBe("draft");
    // A person's call of the pack's tool moves it.
    await moveIn(COUNT, count, "applied");
    expect((await stockOf(variant)).onHand).toBe(1_000_000);
  });
});

describe("a count and its lines never race", () => {
  it("a line added after the count's lines were read fails the apply; applied again, it counts", async () => {
    const [a, b] = [await variantWith(10), await variantWith(10)];
    const count = await countOf([{ variant: a, counted: 4 }]);
    const added = beforeCommitOf(() => create(LINE, { count, variant: b, counted: 2 }));
    expect(await refusal(moveIn(COUNT, count, "applied", { db: added }))).toMatchObject({
      code: "conflict",
      details: { reason: "moved_meanwhile" },
    });
    expect(await stateOf(COUNT, count)).toBe("draft");
    expect((await stockOf(a)).onHand).toBe(10);
    await moveIn(COUNT, count, "applied");
    expect((await stockOf(a)).onHand).toBe(4);
    expect((await stockOf(b)).onHand).toBe(2);
  });

  it("a line edited after the read fails the apply; it is applied as it stands", async () => {
    const a = await variantWith(10);
    const count = await countOf([{ variant: a, counted: 4 }]);
    const line = (await linesOf(count))[0]?.id as string;
    const edited = beforeCommitOf(() => update(LINE, line, { counted: 7 }));
    expect(await refusal(moveIn(COUNT, count, "applied", { db: edited }))).toMatchObject({
      code: "conflict",
    });
    expect((await stockOf(a)).onHand).toBe(10);
    await moveIn(COUNT, count, "applied");
    expect((await stockOf(a)).onHand).toBe(7);
  });

  it("a line added or edited while the count is applied fails the line's write", async () => {
    const [a, b] = [await variantWith(10), await variantWith(10)];
    const count = await countOf([{ variant: a, counted: 4 }]);
    const line = (await linesOf(count))[0]?.id as string;
    const applied = beforeCommitOf(() => moveIn(COUNT, count, "applied"));
    expect(
      await refusal(
        run(
          "record.create",
          { object: LINE, values: { count, variant: b, counted: 2 } },
          context(admin, { db: applied }),
        ),
      ),
    ).toMatchObject({ code: "conflict", details: { reason: "moved_meanwhile" } });
    expect(await linesOf(count)).toHaveLength(1);
    expect((await stockOf(a)).onHand).toBe(4);
    expect((await stockOf(b)).onHand).toBe(10);
    // An edit read before the apply and committed after it: refused too, so the line says 4.
    const other = await countOf([{ variant: b, counted: 3 }]);
    const otherLine = (await linesOf(other))[0]?.id as string;
    const appliedToo = beforeCommitOf(() => moveIn(COUNT, other, "applied"));
    expect(
      await refusal(
        run(
          "record.update",
          { object: LINE, id: otherLine, values: { counted: 9 } },
          context(admin, { db: appliedToo }),
        ),
      ),
    ).toMatchObject({ code: "conflict" });
    expect((await stockOf(b)).onHand).toBe(3);
    expect(line).toBeTruthy();
  });

  it("a line cannot come back from the Trash under a count applied meanwhile", async () => {
    const [a, b] = [await variantWith(10), await variantWith(10)];
    const count = await countOf([
      { variant: a, counted: 4 },
      { variant: b, counted: 1 },
    ]);
    const lines = await linesOf(count);
    const trashed = lines[1]?.id as string;
    await run("record.delete", { object: LINE, id: trashed }, context(admin));
    await moveIn(COUNT, count, "applied");
    expect(
      await refusal(run("record.restore", { object: LINE, id: trashed }, context(admin))),
    ).toMatchObject({ code: "invalid_input", details: { rule: "stock_moves", field: "count" } });
    expect(await linesOf(count)).toHaveLength(1);
    expect((await stockOf(b)).onHand).toBe(10);
  });
});

describe("a crossing is told once, however long it lasts", () => {
  it("purging the notices does not tell a record still low again", async () => {
    const variant = await variantWith(6, { reorderLevel: 5 });
    await pay(await startAsGuest([{ object: VARIANT, id: variant, quantity: 1 }]));
    expect(Object.keys(await toldOf(variant))).toHaveLength(3);
    // As notifications/purge.ts does after 90 days.
    await env.DB.prepare(
      "DELETE FROM core_notifications WHERE dedupe_key LIKE 'stock_low:%' AND json_extract(link, '$.id') = ?",
    )
      .bind(variant)
      .run();
    await pay(await startAsGuest([{ object: VARIANT, id: variant, quantity: 1 }]));
    expect(await toldOf(variant)).toEqual({});
    // A rise and a fall is a new crossing.
    await stockIn(variant, 10);
    const writeoff = await create(WRITEOFF, { variant, quantity: 12 });
    await moveIn(WRITEOFF, writeoff, "done");
    expect(Object.keys(await toldOf(variant))).toHaveLength(3);
  });
});

// --- Cost -------------------------------------------------------------------------------------------

describe("what a count's apply costs", () => {
  let queries = 0;
  const metered = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(stmt, {
              get(s, p) {
                if (p === "bind") return (...args: unknown[]) => wrap(s.bind(...args));
                if (p === "all" || p === "run" || p === "first" || p === "raw") {
                  return async (...args: unknown[]) => {
                    queries += 1;
                    return (s[p] as (...a: unknown[]) => Promise<unknown>)(...args);
                  };
                }
                const value = Reflect.get(s, p);
                return typeof value === "function" ? value.bind(s) : value;
              },
            });
          return wrap(target.prepare(query));
        };
      }
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          queries += statements.length;
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const meteredDb = createCrmDb(metered);
  const { invokeByName } = createInvoker(orderRegistry);

  async function applyCost(lines: number): Promise<number> {
    const count = await create(COUNT, { name: unique("Count") });
    const variants: string[] = [];
    for (let i = 0; i < lines; i += 50) {
      const made = await run<{ ids?: string[]; records?: { id: string }[] }>(
        "record.createMany",
        {
          object: VARIANT,
          records: Array.from({ length: Math.min(50, lines - i) }, (_, k) => ({
            name: `Bulk ${i + k}`,
            price: 5,
            reorderLevel: 1,
          })),
        },
        context(admin),
      );
      variants.push(...(made.ids ?? (made.records ?? []).map((r) => r.id)));
    }
    for (let i = 0; i < variants.length; i += 50) {
      await run(
        "record.createMany",
        {
          object: LINE,
          records: variants.slice(i, i + 50).map((variant) => ({ count, variant, counted: 1 })),
        },
        context(admin),
      );
    }
    queries = 0;
    await invokeByName(
      "record.update",
      { object: COUNT, id: count, values: { state: "applied" } },
      asTool("applyCount", { db: meteredDb }),
    );
    for (const id of [variants[0], variants.at(-1)]) {
      expect((await stockOf(id as string)).onHand).toBe(1);
      // At its level of 1: every keeper told.
      expect(Object.keys(await toldOf(id as string))).toHaveLength(3);
    }
    return queries;
  }

  it("is the same number of statements for 2 lines as for the limit, well under D1's", async () => {
    const two = await applyCost(2);
    const most = await applyCost(STOCK_MOVES_MAX_LINES);
    expect(most).toBe(two);
    expect(most).toBeLessThan(100);
    expect(LOW_STATEMENTS + STOCK_MOVES_STATEMENTS).toBe(7);
  }, 120_000);
});
