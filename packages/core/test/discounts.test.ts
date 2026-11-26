// Stage 34 step 4 (ADR 0693): the `discount` behaviour. Against the real host, an Offers-shaped
// fixture pack (a discount object with live states a person's tool enters, and promo codes kept as
// records), things for sale (classes with a deposit and a tax code, goods with free postage, a
// gym's drop-in), the payments gatekeeper's test double and the fake provider:
//   - a percentage code: each line's net, the total, the provider's ask and its tax shares
//     (criteria 1 and 2);
//   - one answer for a code that does not apply, whatever the reason (criterion 3);
//   - a limit kept by the database under two orders at once (criterion 4);
//   - a use held, used, released at expiry, kept after a refund (criterion 5);
//   - per-person codes and new customers over folded addresses (criterion 6);
//   - a member's price by itself, and the better of it and a code (criterion 7);
//   - deposits (criterion 9), refunds of the net (criterion 23's rule), a staff discount on top,
//     free postage on the goods' net, order.quote writing nothing and agreeing with order.start,
//     order.applyCode and order.removeCode, discount.check, and a runtime extension (criterion 24).
import { env } from "cloudflare:workers";
import {
  CODE_ALPHABET,
  codeHash,
  defineExtension,
  defineTool,
  type ExtensionManifest,
  foldCode,
  isCodeHash,
  randomCodes,
  toManifest,
  z,
} from "@composable-os/sdk";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  checkManifest,
  type InvocationContext,
  loadOrderRow,
  memoryEventSink,
  memoryRateLimit,
} from "../src/index.ts";
import { discountCheck } from "../src/operations/discount.ts";
import {
  orderApplyCode,
  orderQuote,
  orderStartHeld,
  orderStartInput,
} from "../src/operations/order.ts";
import { extId, manifest, plan as planOf, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";
import {
  type Buyer,
  CURRENCY,
  createBuyer,
  outside,
  PUBLIC,
  refusal,
  run,
} from "./order-fixtures.ts";
import { paymentsDouble } from "./payments-double.ts";

const OFFERS = extId("offers");
const DISCOUNT = `${OFFERS}.discount`;
const CODE = `${OFFERS}.code`;
const MANAGE = `${OFFERS}:manage`;
const SHOP = extId("dshop");
const CLASS = `${SHOP}.class`;
const TEE = `${SHOP}.tee`;
const DELIVERY = `${SHOP}.delivery`;
const PLAN = `${SHOP}.plan`;
const KLASS = `${SHOP}.session`;
const BOOKING = `${SHOP}.booking`;
const RETURN = "https://shop.example.com/thanks";
const TAX = "txcd_20060158";
const NEXT_YEAR = `${new Date().getUTCFullYear() + 1}-06-30`;
const NOT_VALID = "This code is not valid here";

const select = (...values: string[]) => ({
  type: "select" as const,
  label: "Select",
  options: values.map((value) => ({ value, label: value })),
});

function offers(id: string): ExtensionManifest {
  return toManifest(
    defineExtension({
      id,
      version: "1.0.0",
      contractVersion: 1,
      permissions: { modules: ["ops"] },
      roles: {
        manager: {
          label: "Offers manager",
          description: "Fixture: runs the discounts.",
          permissions: [`${id}:manage`],
          read: [`${id}.discount`, `${id}.code`],
        },
      },
      tools: {
        activate: defineTool({
          description: "Fixture: a person moves a discount live (anyone else's call waits).",
          input: z.object({}),
          output: z.object({}),
          permission: `${id}:manage`,
          personApproves: true,
          handler: () => ({}),
        }),
      },
      objects: {
        discount: {
          label: "Discount",
          plural: "Discounts",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            kind: select("percent", "amount", "price"),
            percent: { type: "number", label: "Percent" },
            amount: { type: "currency", label: "Amount", currency: CURRENCY },
            automatic: { type: "boolean", label: "Automatic" },
            code: { type: "text", label: "Code" },
            who: select("anyone", "signed_in", "members", "new_customers", "organisation", "tag"),
            orgs: { type: "relation", label: "Organisations", to: "organisation", many: true },
            items: { type: "relation", label: "Items", to: `${SHOP}.class`, many: true },
            tag: { type: "text", label: "Tag" },
            plans: { type: "relation", label: "Plans", to: `${SHOP}.plan`, many: true },
            on: {
              type: "multiSelect",
              label: "On",
              options: [CLASS, TEE, BOOKING].map((value) => ({ value, label: value })),
            },
            from: { type: "date", label: "From" },
            until: { type: "date", label: "Until" },
            totalUses: { type: "number", label: "Uses" },
            perPerson: { type: "number", label: "Per person" },
            minSpend: { type: "currency", label: "Minimum spend", currency: CURRENCY },
            state: select("draft", "active", "paused", "ended"),
          },
          states: {
            field: "state",
            initial: "draft",
            moves: [
              { from: ["draft", "paused"], to: "active", by: ["host"], tools: ["activate"] },
              { from: "active", to: "paused", by: ["staff"] },
              { from: ["draft", "active", "paused"], to: "ended", by: ["staff"], final: true },
            ],
          },
          discount: {
            kind: "kind",
            percent: "percent",
            amount: "amount",
            live: ["active"],
            automatic: "automatic",
            code: "code",
            codes: { object: "code", discount: "discount", word: "word", uses: "uses" },
            who: "who",
            tag: "tag",
            organisations: "orgs",
            records: ["items"],
            plans: "plans",
            objects: "on",
            from: "from",
            until: "until",
            totalUses: "totalUses",
            perPerson: "perPerson",
            minSpend: "minSpend",
          },
        },
        code: {
          label: "Promo code",
          plural: "Promo codes",
          titleField: "word",
          fields: {
            word: { type: "text", label: "Code", required: true },
            discount: { type: "relation", label: "Discount", to: `${id}.discount` },
            uses: { type: "number", label: "Uses" },
          },
        },
      },
    }),
  );
}

const shop = () =>
  manifest(SHOP, {
    permissions: { operations: ["order.startHeld"] },
    settings: { price: { type: "number", label: "Price" } },
    objects: {
      class: {
        label: "Class pass",
        plural: "Class passes",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          price: { type: "currency", label: "Price", currency: CURRENCY },
          depositAmount: { type: "currency", label: "Deposit", currency: CURRENCY },
          balanceDue: { type: "date", label: "Balance due" },
        },
        sellable: {
          price: "price",
          deposit: { amount: "depositAmount", balanceDue: "balanceDue" },
          tax: { code: TAX },
        },
        public: { read: ["name", "price", "depositAmount", "balanceDue"] },
      },
      tee: {
        label: "Tee",
        plural: "Tees",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          price: { type: "currency", label: "Price", currency: CURRENCY },
        },
        sellable: { price: "price", goods: {} },
        public: { read: ["name", "price"] },
      },
      delivery: {
        label: "Delivery option",
        plural: "Delivery options",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          price: { type: "currency", label: "Price", currency: CURRENCY },
          kind: select("post", "collect", "here"),
          freeOver: { type: "currency", label: "Free over", currency: CURRENCY },
          countries: { type: "text", label: "Countries" },
        },
        sellable: {
          price: "price",
          delivery: { kind: "kind", freeOver: "freeOver", countries: "countries" },
        },
        public: { read: ["name", "price", "kind", "freeOver", "countries"] },
      },
      plan: {
        label: "Plan",
        plural: "Plans",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          price: { type: "currency", label: "Price", currency: CURRENCY },
        },
        sellable: { price: "price", recurring: { interval: "month" } },
        public: { read: ["name", "price"] },
      },
      session: {
        label: "Class",
        plural: "Classes",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          price: { type: "number", label: "Price" },
          places: { type: "number", label: "Places", required: true },
        },
        capacity: { places: "places" },
        public: { read: ["name"] },
      },
      booking: {
        label: "Booking",
        plural: "Bookings",
        titleField: "title",
        fields: {
          title: { type: "text", label: "Title" },
          class: { type: "relation", label: "Class", to: KLASS, required: true },
          person: { type: "relation", label: "Person", to: "person" },
          state: select("booked", "pending", "expired", "cancelled"),
          paid: { type: "number", label: "Paid", readOnly: true },
          order: { type: "text", label: "Order", readOnly: true },
        },
        states: {
          field: "state",
          initial: "booked",
          create: { in: { pending: ["host"] } },
          moves: [
            { from: "pending", to: "booked", by: ["host"] },
            { from: "pending", to: "expired", by: ["host"], final: true },
            { from: "booked", to: "cancelled", by: ["customer", "staff"], final: true },
          ],
        },
        claims: { on: "class", held: ["pending"], confirmed: ["booked"] },
        customer: { field: "person", read: ["class", "state"], write: ["class"] },
        sellable: {
          price: "paid",
          moves: {
            held: "pending",
            paid: "booked",
            expired: "expired",
            refund: ["cancelled"],
            price: { field: "class.price", setting: "price" },
            title: "class.name",
            order: "order",
          },
        },
      },
    },
  } as never);

interface Line {
  id: string;
  object: string;
  total: number;
  discount: number;
}
interface OrderOut {
  id: string;
  state: string;
  total: number;
  paid: number;
  discount: number;
  deposit: number | null;
  pay: string;
  token?: string | null;
  lines: Line[];
  deal: { kind: string; title: string; amount: number } | null;
  codeApplied: boolean | null;
  adjustments?: { kind: string; amount: number; reason: string | null }[];
}
type SentTax = { ref: string; amount: number; taxCode: string };

let events: ReturnType<typeof memoryEventSink>;
const payments = paymentsDouble(() => events);
const { gw, runtime, providerPays } = payments;
let admin: ActingUser;
let desk: ActingUser;
/** $120.00, deposit $40.00. */
let yoga: string;
/** $45.50, deposit $10.00. */
let mat: string;
/** $110.00 of goods; post costs $10.00, free over $100.00. */
let tee: string;
let post: { object: string; id: string };
let plan: string;

const staff = (user: ActingUser = admin, extra: Partial<InvocationContext> = {}) =>
  context(user, { integrations: runtime, events, ...extra });
const guest = () => outside(PUBLIC, { integrations: runtime, events });
const as = (buyer: Buyer) => outside(buyer.principal, { integrations: runtime, events });

async function create(object: string, values: Record<string, unknown>): Promise<string> {
  return ((await run("record.create", { object, values }, context(admin))) as { id: string }).id;
}

/** A call made from inside the pack's activate tool, run for a person who holds its permission. */
const asTool = () =>
  context(admin, {
    actor: "extension",
    extension: {
      id: OFFERS,
      permissions: { read: [], write: [], operations: [], modules: ["ops"] },
      tool: {
        name: "activate",
        personApproves: true,
        permission: MANAGE,
        calledBy: { account: admin.id, actor: "human" },
      },
    },
  } as never);

/** A live discount: made in draft, moved live by a person through the pack's tool. */
async function discount(values: Record<string, unknown>): Promise<string> {
  const id = await create(DISCOUNT, { name: unique("Deal"), ...values });
  await run("record.update", { object: DISCOUNT, id, values: { state: "active" } }, asTool());
  return id;
}

/** A code word nobody else's test uses. */
const word = (prefix = "CODE") => unique(prefix).toUpperCase();

function buy(
  lines: { id: string; quantity?: number; object?: string }[],
  extra: Record<string, unknown> = {},
  ctx = guest(),
) {
  return run<OrderOut>(
    "order.start",
    {
      lines: lines.map((l) => ({ object: CLASS, ...l })),
      ...(ctx.principal.kind === "customer" ? {} : { email: `${unique("g")}@buyers.example` }),
      ...extra,
    },
    ctx,
  );
}

async function checkout(order: OrderOut, ctx = guest()) {
  return run<{ amount: number; kind: string }>(
    "order.checkout",
    { id: order.id, ...(order.token ? { token: order.token } : {}), returnUrl: RETURN },
    ctx,
  );
}

async function usesOf(orderId: string) {
  const { results } = await env.DB.prepare(
    "SELECT discount_id, code_id, kind, state, amount, person_id FROM core_discount_use WHERE order_id = ? ORDER BY created_at, id",
  )
    .bind(orderId)
    .all<{
      discount_id: string;
      code_id: string | null;
      kind: string;
      state: string;
      amount: number;
      person_id: string | null;
    }>();
  return results;
}

async function adjustmentsOf(orderId: string) {
  const { results } = await env.DB.prepare(
    "SELECT kind, source_object, source_id, amount, line_id, removed_at FROM core_order_adjustment WHERE order_id = ? ORDER BY created_at, id",
  )
    .bind(orderId)
    .all<{
      kind: string;
      source_object: string | null;
      source_id: string | null;
      amount: number;
      line_id: string | null;
      removed_at: string | null;
    }>();
  return results;
}

/** A live subscription to `plan` held by the buyer, as the provider's confirmation makes it. */
async function subscribe(buyer: Buyer, planId: string) {
  const id = `sbs_${unique("m")}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO core_subscription (id, payer_person_id, holder_person_id, email, placed_as,
       plan_object, plan_id, plan_title, amount, currency, interval, state, provider, provider_ref,
       cancel_at_period_end, observed_at, created_at, updated_at, version)
     VALUES (?, ?, ?, ?, 'customer', ?, ?, 'Monthly', 4000, ?, 'month', 'active', 'fake', ?, 0, ?, ?, ?, 0)`,
  )
    .bind(
      id,
      buyer.principal.personId,
      buyer.principal.personId,
      buyer.email,
      PLAN,
      planId,
      CURRENCY,
      `fsub_${id}`,
      now,
      now,
      now,
    )
    .run();
}

beforeAll(async () => {
  admin = await createUser("admin");
  desk = await createUser("member");
  await reconcile(shop());
  const m = offers(OFFERS);
  await reconcile(m);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', ?, ?, ?, ?)",
  )
    .bind(OFFERS, JSON.stringify(m), admin.id, now, now)
    .run();
  await run(
    "order.settings.update",
    {
      currency: CURRENCY,
      returnOrigins: ["https://shop.example.com"],
      discountLimit: { percent: 20, amount: 10_000 },
    },
    context(admin),
  );
  await run(
    "user.setPermissions",
    { id: desk.id, permissions: ["orders:discount"] },
    context(admin),
  );
  yoga = await create(CLASS, {
    name: "Yoga pass",
    price: 120,
    depositAmount: 40,
    balanceDue: NEXT_YEAR,
  });
  mat = await create(CLASS, {
    name: "Mat hire",
    price: 45.5,
    depositAmount: 10,
    balanceDue: NEXT_YEAR,
  });
  tee = await create(TEE, { name: "Club tee", price: 110 });
  post = {
    object: DELIVERY,
    id: await create(DELIVERY, {
      name: "Post",
      price: 10,
      kind: "post",
      freeOver: 100,
      countries: "AU",
    }),
  };
  plan = await create(PLAN, { name: "Monthly", price: 40 });
  await payments.connect(admin.id);
}, 60_000);

beforeEach(async () => {
  events = memoryEventSink();
  await setPreset("balanced");
  await run("order.settings.update", { tax: false }, context(admin));
});

// --- A code on an order (criteria 1 and 2) -----------------------------------------------------

describe("a percentage code", () => {
  it("each line's net, the total and the provider's ask are the discounted prices; the adjustment names the discount (criterion 1)", async () => {
    const code = word("TENOFF");
    const id = await discount({ kind: "percent", percent: 10, code });
    const order = await buy([{ id: yoga, quantity: 2 }, { id: mat }], { code: code.toLowerCase() });
    // 10% of 240.00 and of 45.50, rounded down per line.
    expect(order.lines.map((l) => l.discount)).toEqual([2_400, 455]);
    expect(order).toMatchObject({ total: 28_550 - 2_855, discount: 2_855, codeApplied: true });
    expect(order.deal).toMatchObject({ kind: "code", amount: 2_855 });
    const adjustments = await adjustmentsOf(order.id);
    expect(adjustments.map((a) => [a.kind, a.source_object, a.source_id, a.amount])).toEqual([
      ["code", DISCOUNT, id, 2_400],
      ["code", DISCOUNT, id, 455],
    ]);
    expect(await usesOf(order.id)).toEqual([
      expect.objectContaining({ discount_id: id, kind: "code", state: "held", amount: 2_855 }),
    ]);
    expect(await checkout(order)).toMatchObject({ amount: 25_695, kind: "full" });
    await providerPays(order.id);
    expect(await loadOrderRow(db.query, order.id)).toMatchObject({ state: "paid", paid: 25_695 });
    expect((await usesOf(order.id)).map((u) => u.state)).toEqual(["used"]);
  });

  it("with tax at checkout, the provider's shares are the net lines and sum to the charge (criterion 2)", async () => {
    await run("order.settings.update", { tax: true }, context(admin));
    const code = word("TAX");
    await discount({ kind: "amount", amount: 30.01, code });
    const order = await buy([{ id: yoga, quantity: 2 }, { id: mat }], { code });
    expect(order.total).toBe(28_550 - 3_001);
    await checkout(order);
    const sent = gw.checkouts.filter((c) => c.orderId === order.id).at(-1) as {
      amount: number;
      tax?: { lines: SentTax[] };
    };
    expect(sent.amount).toBe(28_550 - 3_001);
    const lines = sent.tax?.lines ?? [];
    expect(lines.map((l) => l.amount)).toEqual(order.lines.map((l) => l.total - l.discount));
    expect(lines.reduce((s, l) => s + l.amount, 0)).toBe(sent.amount);
  });

  it("a code kept as a record applies its discount, and a single-use code goes once", async () => {
    const id = await discount({ kind: "amount", amount: 5 });
    const once = word("ONCE");
    await create(CODE, { word: once, discount: id, uses: 1 });
    const first = await buy([{ id: mat }], { code: once });
    expect(first).toMatchObject({ total: 4_050, discount: 500 });
    expect((await usesOf(first.id))[0]?.code_id).toBeTruthy();
    expect((await refusal(buy([{ id: mat }], { code: once }))).message).toBe(NOT_VALID);
  });

  it("only on what it names, and never on the delivery", async () => {
    const code = word("TEES");
    await discount({ kind: "percent", percent: 50, code, on: [TEE] });
    const order = await buy([{ id: tee, object: TEE }, { id: mat }], {
      code,
      delivery: { ...post, address: { name: "A", line1: "1 St", country: "AU" } },
    });
    // Half the tee; the mat and the postage untouched. The goods' net (55.00) is under the
    // free-over (100.00): postage is charged (the spec's rule 8).
    expect(order.lines.map((l) => [l.object, l.total, l.discount])).toEqual([
      [TEE, 11_000, 5_500],
      [CLASS, 4_550, 0],
      [DELIVERY, 1_000, 0],
    ]);
    expect(order.total).toBe(5_500 + 4_550 + 1_000);
  });
});

// --- What a caller can and cannot do ----------------------------------------------------------

describe("prices are the host's: a caller sends at most a code", () => {
  it("no input names an amount, a percentage or a total; one sent is ignored", async () => {
    for (const [name, schema] of [
      ["order.start", orderStartInput],
      ["order.startHeld", orderStartHeld.input],
      ["order.quote", orderQuote.input],
      ["order.applyCode", orderApplyCode.input],
      ["discount.check", discountCheck.input],
    ] as const) {
      const json = z.toJSONSchema(schema, { io: "input" }) as { properties: object };
      const keys = Object.keys(json.properties);
      for (const forbidden of ["amount", "percent", "total", "discount", "price", "deal"]) {
        expect(keys, name).not.toContain(forbidden);
      }
    }
    const code = word("HOST");
    await discount({ kind: "percent", percent: 10, code });
    const order = await buy([{ id: yoga }], {
      code,
      discount: 12_000,
      percent: 100,
      amount: 1,
      total: 1,
      deal: { amount: 11_999 },
    });
    expect(order).toMatchObject({ total: 10_800, discount: 1_200 });
    const quoted = await run<{ total: number }>(
      "order.quote",
      { lines: [{ object: CLASS, id: yoga }], code, percent: 100, amount: 11_999 },
      guest(),
    );
    expect(quoted.total).toBe(10_800);
    const again = await buy([{ id: yoga }]);
    const applied = await run<OrderOut>(
      "order.applyCode",
      { id: again.id, token: again.token, code, amount: 11_999, percent: 99 },
      guest(),
    );
    expect(applied).toMatchObject({ total: 10_800, discount: 1_200 });
  });

  it("a customer or a guest cannot make, change or move a discount live", async () => {
    const buyer = await createBuyer(admin, "nodeal");
    const id = await create(DISCOUNT, { name: "Mine", kind: "percent", percent: 99, code: word() });
    for (const ctx of [as(buyer), guest()]) {
      const made = await refusal(
        run("record.create", { object: DISCOUNT, values: { name: "x", kind: "percent" } }, ctx),
      );
      expect(made.code).not.toBe("ok");
      const moved = await refusal(
        run("record.update", { object: DISCOUNT, id, values: { state: "active" } }, ctx),
      );
      expect(moved.code).not.toBe("ok");
    }
    // Staff writing the state field are refused too: only the pack's tool moves it live.
    const byStaff = await refusal(
      run("record.update", { object: DISCOUNT, id, values: { state: "active" } }, staff()),
    );
    expect(byStaff.code).not.toBe("ok");
  });

  it("a code never makes an order free", async () => {
    const code = word("FREE");
    await discount({ kind: "percent", percent: 100, code });
    expect((await refusal(buy([{ id: yoga }], { code }))).message).toBe(NOT_VALID);
  });
});

// --- One answer (criterion 3) ------------------------------------------------------------------

describe("a code that does not apply gets one answer (criterion 3)", () => {
  it("unknown, ended, used up, outside its dates, not for a guest, not for these items", async () => {
    const ended = word("ENDED");
    const endedId = await discount({ kind: "percent", percent: 10, code: ended });
    await run(
      "record.update",
      { object: DISCOUNT, id: endedId, values: { state: "ended" } },
      staff(),
    );
    const used = word("USED");
    await discount({ kind: "percent", percent: 10, code: used, totalUses: 0 });
    const later = word("LATER");
    await discount({ kind: "percent", percent: 10, code: later, from: NEXT_YEAR });
    const members = word("MEMBERS");
    await discount({ kind: "percent", percent: 10, code: members, who: "members" });
    const tees = word("TEESONLY");
    await discount({ kind: "percent", percent: 10, code: tees, on: [TEE] });
    const spend = word("SPEND");
    await discount({ kind: "percent", percent: 10, code: spend, minSpend: 500 });
    const answers = [];
    const checks = [];
    for (const code of [word("NOPE"), ended, used, later, members, tees, spend]) {
      answers.push(await refusal(buy([{ id: yoga }], { code })));
      checks.push(
        await run("discount.check", { code, lines: [{ object: CLASS, id: yoga }] }, guest()),
      );
    }
    for (const answer of answers) {
      expect(answer).toEqual({
        code: "invalid_input",
        message: NOT_VALID,
        details: { rule: "code_not_valid", field: "code" },
      });
    }
    for (const check of checks) {
      expect(check).toEqual({
        valid: false,
        message: NOT_VALID,
        title: null,
        amount: 0,
        lines: [],
        better: false,
      });
    }
    // Staff are told why: they read the discounts anyway.
    const why = await refusal(
      run(
        "order.start",
        { lines: [{ object: CLASS, id: yoga }], email: "x@buyers.example", code: used },
        staff(),
      ),
    );
    expect(why.details).toMatchObject({ rule: "code_not_valid", reason: "used_up" });
    // The quote reports it rather than refusing, the same words.
    const quoted = await run<{ problems: { rule: string; message: string }[]; ready: boolean }>(
      "order.quote",
      { lines: [{ object: CLASS, id: yoga }], code: members },
      guest(),
    );
    expect(quoted.problems).toEqual([{ rule: "code_not_valid", message: NOT_VALID }]);
    expect(quoted.ready).toBe(false);
  });

  it("discount.check says what a valid code takes off, and holds nothing", async () => {
    const code = word("CHECK");
    await discount({ kind: "percent", percent: 10, code });
    const before = await env.DB.prepare("SELECT count(*) AS n FROM core_discount_use").first<{
      n: number;
    }>();
    const checked = await run(
      "discount.check",
      {
        code,
        lines: [
          { object: CLASS, id: yoga },
          { object: CLASS, id: mat },
        ],
      },
      guest(),
    );
    expect(checked).toMatchObject({
      valid: true,
      amount: 1_655,
      lines: [
        { position: 0, discount: 1_200 },
        { position: 1, discount: 455 },
      ],
      better: false,
    });
    const after = await env.DB.prepare("SELECT count(*) AS n FROM core_discount_use").first<{
      n: number;
    }>();
    expect(after?.n).toBe(before?.n);
    // Not offered to an assistant.
    const assistant = await refusal(
      run(
        "discount.check",
        { code, lines: [{ object: CLASS, id: yoga }] },
        staff(admin, { actor: "assistant" }),
      ),
    );
    expect(assistant.code).toBe("forbidden");
  });
});

// --- Limits kept by the database (criteria 4 and 5) -------------------------------------------

describe("limits are kept by the database", () => {
  it("a code with one use left: two orders started at once, one gets it (criterion 4)", async () => {
    const code = word("LAST");
    const id = await discount({ kind: "percent", percent: 10, code, totalUses: 1 });
    const results = await Promise.allSettled([
      buy([{ id: yoga }], { code }),
      buy([{ id: mat }], { code }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    // The same answer as a code used up when it was read.
    expect(failed.reason).toMatchObject({
      message: NOT_VALID,
      details: { rule: "code_not_valid", field: "code" },
    });
    const { results: uses } = await env.DB.prepare(
      "SELECT state FROM core_discount_use WHERE discount_id = ?",
    )
      .bind(id)
      .all<{ state: string }>();
    expect(uses.map((u) => u.state)).toEqual(["held"]);
    // The backstop itself: a use written straight to the table past the limit is refused.
    const winner = (
      results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<OrderOut>
    ).value;
    await expect(
      env.DB.prepare(
        "INSERT INTO core_discount_use (id, discount_object, discount_id, kind, order_id, state, amount, max_uses, created_at, updated_at) VALUES (?, ?, ?, 'code', ?, 'held', 1, 1, 't', 't')",
      )
        .bind(unique("dcu"), DISCOUNT, id, winner.id)
        .run(),
    ).rejects.toThrow(/core_discount_use_limit/);
  });

  it("a use held by an unpaid order is released when it expires; a paid one stays after a full refund (criterion 5)", async () => {
    const code = word("BACK");
    await discount({ kind: "percent", percent: 10, code, totalUses: 1 });
    const lapsed = await buy([{ id: yoga }], { code });
    await run("fixture.moveOrderAs", { id: lapsed.id, to: "expired", by: "host" }, staff());
    expect((await usesOf(lapsed.id)).map((u) => u.state)).toEqual(["released"]);
    const paid = await buy([{ id: yoga }], { code });
    await checkout(paid);
    await providerPays(paid.id);
    expect((await usesOf(paid.id)).map((u) => u.state)).toEqual(["used"]);
    const asked = await run<{ refunds: { amount: number }[] }>(
      "order.refund",
      { id: paid.id, reason: "Cannot come" },
      staff(),
    );
    // What goes back is what was paid: the net.
    expect(asked.refunds.map((r) => r.amount)).toEqual([10_800]);
    expect((await usesOf(paid.id)).map((u) => u.state)).toEqual(["used"]);
    expect((await refusal(buy([{ id: yoga }], { code }))).message).toBe(NOT_VALID);
  });

  it("a cancelled unpaid order gives its use back", async () => {
    const buyer = await createBuyer(admin, "cancel");
    const code = word("CANCEL");
    await discount({ kind: "percent", percent: 10, code, totalUses: 1 });
    const order = await buy([{ id: yoga }], { code }, as(buyer));
    await run("order.cancel", { id: order.id }, as(buyer));
    expect((await usesOf(order.id)).map((u) => u.state)).toEqual(["released"]);
  });
});

// --- One person (criterion 6) ------------------------------------------------------------------

describe("folded addresses are one person (criterion 6)", () => {
  it("a+1@ and a+2@ share a per-person code and are not new customers twice; a.b@ and ab@ stay two", async () => {
    const tag = unique("fold").toLowerCase();
    const one = await createBuyer(admin, "f1", `${tag}+1@gym.example`);
    const two = await createBuyer(admin, "f2", `${tag}+2@gym.example`);
    const code = word("ONEEACH");
    await discount({ kind: "percent", percent: 10, code, perPerson: 1 });
    const order = await buy([{ id: yoga }], { code }, as(one));
    expect(order.discount).toBe(1_200);
    // Held on +1: +2 gets the one answer, and so does a guest (no per-person deal for a guest).
    expect((await refusal(buy([{ id: yoga }], { code }, as(two)))).message).toBe(NOT_VALID);
    expect((await refusal(buy([{ id: yoga }], { code }))).message).toBe(NOT_VALID);
    await checkout(order, as(one));
    await providerPays(order.id);

    const fresh = word("NEW");
    await discount({ kind: "percent", percent: 15, code: fresh, who: "new_customers" });
    expect((await refusal(buy([{ id: mat }], { code: fresh }, as(two)))).message).toBe(NOT_VALID);
    const dotted = await createBuyer(admin, "dot", `a.b.${tag}@gym.example`);
    const dotless = await createBuyer(admin, "nodot", `ab${tag}@gym.example`);
    expect((await buy([{ id: mat }], { code }, as(dotted))).discount).toBe(455);
    expect((await buy([{ id: mat }], { code }, as(dotless))).discount).toBe(455);
    expect((await buy([{ id: mat }], { code: fresh }, as(dotless))).discount).toBe(682);
  });

  it("the database refuses a second per-person use by a+2@ written at once", async () => {
    const tag = unique("foldrace").toLowerCase();
    const one = await createBuyer(admin, "r1", `${tag}+1@gym.example`);
    const two = await createBuyer(admin, "r2", `${tag}+2@gym.example`);
    const code = word("RACE");
    await discount({ kind: "percent", percent: 10, code, perPerson: 1 });
    const results = await Promise.allSettled([
      buy([{ id: yoga }], { code }, as(one)),
      buy([{ id: mat }], { code }, as(two)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});

// --- A member's price (criterion 7) ------------------------------------------------------------

describe("a member's price applies by itself (criterion 7)", () => {
  let member: Buyer;
  beforeAll(async () => {
    member = await createBuyer(admin, "member");
    await subscribe(member, plan);
    // Members pay 100.00 for the yoga pass, and 15.00 for a drop-in.
    await discount({
      kind: "price",
      amount: 100,
      automatic: true,
      who: "members",
      plans: [plan],
      on: [CLASS],
    });
    await discount({ kind: "price", amount: 15, automatic: true, who: "members", on: [BOOKING] });
  });

  it("for a signed-in member, not for a guest using their address", async () => {
    const mine = await buy([{ id: yoga }], {}, as(member));
    expect(mine).toMatchObject({ total: 10_000, discount: 2_000, codeApplied: null });
    expect(mine.deal).toMatchObject({ kind: "automatic", amount: 2_000 });
    const theirs = await run<OrderOut>(
      "order.start",
      { lines: [{ object: CLASS, id: yoga }], email: member.email },
      guest(),
    );
    expect(theirs).toMatchObject({ total: 12_000, discount: 0, deal: null });
    // The quote agrees with the order, and writes nothing.
    const quoted = await run<{ total: number; deal: { kind: string } | null }>(
      "order.quote",
      { lines: [{ object: CLASS, id: yoga }] },
      as(member),
    );
    expect(quoted).toMatchObject({ total: 10_000, deal: { kind: "automatic" } });
  });

  it("a code that takes more off applies instead; one that takes less does not", async () => {
    const big = word("BIG");
    await discount({ kind: "percent", percent: 25, code: big });
    const small = word("SMALL");
    await discount({ kind: "percent", percent: 5, code: small });
    const more = await buy([{ id: yoga }], { code: big }, as(member));
    expect(more).toMatchObject({ total: 9_000, codeApplied: true, deal: { kind: "code" } });
    const less = await buy([{ id: yoga }], { code: small }, as(member));
    expect(less).toMatchObject({ total: 10_000, codeApplied: false, deal: { kind: "automatic" } });
    expect((await usesOf(less.id)).map((u) => u.kind)).toEqual(["automatic"]);
    const checked = await run(
      "discount.check",
      { code: small, lines: [{ object: CLASS, id: yoga }] },
      as(member),
    );
    expect(checked).toMatchObject({ valid: true, amount: 600, better: true });
  });

  it("applies to a drop-in started for the member (order.startHeld)", async () => {
    const klass = await create(KLASS, { name: unique("Spin"), price: 20, places: 10 });
    const toolCtx = (user: ActingUser) =>
      context(user, {
        integrations: runtime,
        events,
        actor: "extension",
        origin: { surface: "extension", extensionId: SHOP },
        extension: {
          id: SHOP,
          permissions: shop().permissions,
          tool: { name: "book", humanOnly: false, permission: null },
        },
      } as never);
    const forMember = await run<OrderOut>(
      "order.startHeld",
      { object: BOOKING, values: { class: klass }, email: member.email },
      toolCtx(admin),
    );
    expect(forMember).toMatchObject({ total: 1_500, discount: 500, deal: { kind: "automatic" } });
    const forGuest = await run<OrderOut>(
      "order.startHeld",
      { object: BOOKING, values: { class: klass }, email: `${unique("v")}@buyers.example` },
      toolCtx(admin),
    );
    expect(forGuest).toMatchObject({ total: 2_000, discount: 0 });
  });
});

// --- Deposits, staff discounts, postage, codes on pending orders ------------------------------

describe("a code with the order's other rules", () => {
  it("a deposit order keeps its deposit and lowers its balance (criterion 9); a deposit left at the total pays in full", async () => {
    const code = word("DEP");
    await discount({ kind: "amount", amount: 20, code });
    const order = await buy([{ id: yoga }], { code, pay: "deposit" });
    expect(order).toMatchObject({ total: 10_000, deposit: 4_000, pay: "deposit" });
    expect(await checkout(order)).toMatchObject({ amount: 4_000, kind: "deposit" });
    const deep = word("DEEP");
    await discount({ kind: "amount", amount: 40, code: deep });
    const full = await buy([{ id: mat }], { code: deep, pay: "deposit" });
    // 45.50 less 40.00 leaves 5.50, under the 10.00 deposit: paid in full.
    expect(full).toMatchObject({ total: 550, deposit: null, pay: "full" });
  });

  it("a staff discount goes on top of the deal, counted against the limit alone", async () => {
    const code = word("STACK");
    await discount({ kind: "percent", percent: 20, code });
    const order = await buy([{ id: yoga }], { code });
    expect(order.total).toBe(9_600);
    // 10% of what is left after the deal, within the 20% staff limit of the 120.00 order.
    const adjusted = await run<OrderOut>(
      "order.adjust",
      { id: order.id, percent: 10, reason: "Regular" },
      staff(desk),
    );
    expect(adjusted).toMatchObject({ total: 9_600 - 960, discount: 2_400 + 960 });
    // A code put on after the staff discount still comes first: staff's 10% is of the net.
    const other = await buy([{ id: yoga }]);
    await run("order.adjust", { id: other.id, amount: 1_000, reason: "Desk" }, staff(desk));
    const coded = await run<OrderOut>("order.applyCode", { id: other.id, code }, staff(desk));
    expect(coded).toMatchObject({ total: 12_000 - 2_400 - 1_000, discount: 3_400 });
    const kinds = (await adjustmentsOf(other.id)).filter((a) => !a.removed_at).map((a) => a.kind);
    expect(kinds.sort()).toEqual(["code", "staff"]);
  });

  it("free postage counts the goods' net after the deal, in the quote and the order alike", async () => {
    const code = word("POST");
    await discount({ kind: "percent", percent: 20, code, on: [TEE] });
    const delivery = { ...post, address: { name: "A", line1: "1 St", country: "AU" } };
    const lines = [{ object: TEE, id: tee }];
    // 110.00 is over the 100.00 free-over: posted free.
    const plain = await run<{ total: number; delivery: { free: boolean } }>(
      "order.quote",
      { lines, delivery },
      guest(),
    );
    expect(plain).toMatchObject({ total: 11_000, delivery: { free: true } });
    // With 20% off the goods are 88.00: postage is charged.
    const quoted = await run<{ total: number; delivery: { free: boolean }; goodsTotal: number }>(
      "order.quote",
      { lines, delivery, code },
      guest(),
    );
    expect(quoted).toMatchObject({
      total: 8_800 + 1_000,
      goodsTotal: 8_800,
      delivery: { free: false },
    });
    const order = await buy([{ id: tee, object: TEE }], { code, delivery });
    expect(order.total).toBe(quoted.total);
    // The code put on a pending order later decides it again.
    const later = await buy([{ id: tee, object: TEE }], { delivery });
    expect(later.total).toBe(11_000);
    const applied = await run<OrderOut>(
      "order.applyCode",
      { id: later.id, token: later.token, code },
      guest(),
    );
    expect(applied.total).toBe(9_800);
    expect(applied.lines.map((l) => l.total)).toEqual([11_000, 1_000]);
    const removed = await run<OrderOut>(
      "order.removeCode",
      { id: later.id, token: later.token },
      guest(),
    );
    expect(removed).toMatchObject({ total: 11_000, discount: 0, deal: null });
    expect((await usesOf(later.id)).map((u) => u.state)).toEqual(["released"]);
  });

  it("order.quote holds nothing and writes nothing", async () => {
    const code = word("QUOTE");
    await discount({ kind: "percent", percent: 10, code, totalUses: 1 });
    const count = async () =>
      (
        await env.DB.prepare(
          "SELECT (SELECT count(*) FROM core_discount_use) + (SELECT count(*) FROM core_order) + (SELECT count(*) FROM core_order_adjustment) AS n",
        ).first<{ n: number }>()
      )?.n;
    const before = await count();
    for (let i = 0; i < 3; i++) {
      const quoted = await run<{ total: number; codeApplied: boolean }>(
        "order.quote",
        { lines: [{ object: CLASS, id: yoga }], code },
        guest(),
      );
      expect(quoted).toMatchObject({ total: 10_800, codeApplied: true });
    }
    expect(await count()).toBe(before);
  });
});

describe("order.applyCode and order.removeCode", () => {
  it("the buyer's own pending order only, before its payment page opens", async () => {
    const code = word("APPLY");
    await discount({ kind: "percent", percent: 10, code });
    const buyer = await createBuyer(admin, "apply");
    const stranger = await createBuyer(admin, "stranger");
    const order = await buy([{ id: yoga }], {}, as(buyer));
    expect((await refusal(run("order.applyCode", { id: order.id, code }, as(stranger)))).code).toBe(
      "not_found",
    );
    expect((await refusal(run("order.applyCode", { id: order.id, code }, guest()))).code).toBe(
      "not_found",
    );
    const bad = await refusal(run("order.applyCode", { id: order.id, code: "NOPE" }, as(buyer)));
    expect(bad).toMatchObject({ message: NOT_VALID, details: { rule: "code_not_valid" } });
    const applied = await run<OrderOut>("order.applyCode", { id: order.id, code }, as(buyer));
    expect(applied).toMatchObject({ total: 10_800, codeApplied: true });
    await checkout(order, as(buyer));
    const late = await refusal(run("order.removeCode", { id: order.id }, as(buyer)));
    expect(late.details.rule).toBe("checkout_open");
    const none = await buy([{ id: mat }], {}, as(buyer));
    expect((await refusal(run("order.removeCode", { id: none.id }, as(buyer)))).details.rule).toBe(
      "no_code",
    );
  });

  it("changing the code gives the first one's use back, in the same batch", async () => {
    const first = word("FIRST");
    await discount({ kind: "percent", percent: 10, code: first, totalUses: 1 });
    const second = word("SECOND");
    await discount({ kind: "percent", percent: 15, code: second });
    const order = await buy([{ id: yoga }], { code: first });
    await run("order.applyCode", { id: order.id, token: order.token, code: second }, guest());
    expect((await usesOf(order.id)).map((u) => [u.state, u.amount])).toEqual([
      ["released", 1_200],
      ["held", 1_800],
    ]);
    // The first code's use is free again.
    expect((await buy([{ id: yoga }], { code: first })).discount).toBe(1_200);
  });
});

// --- A runtime extension (criterion 24) ---------------------------------------------------------

describe("a runtime extension (criterion 24)", () => {
  /** A runtime extension's discount: no staff role or tool, a state field a person approves. */
  function runtimeOffers(id: string, personApproves = true) {
    const m = offers(id) as unknown as {
      roles?: unknown;
      tools?: unknown;
      objects: {
        discount: {
          fields: Record<string, Record<string, unknown>>;
          states: { moves: unknown[] };
        };
      };
    };
    delete m.roles;
    delete m.tools;
    m.objects.discount.fields.state = { ...m.objects.discount.fields.state, personApproves };
    m.objects.discount.states.moves = [
      { from: ["draft", "paused"], to: "active", by: ["staff"] },
      { from: "active", to: "paused", by: ["staff"] },
      { from: ["draft", "active", "paused"], to: "ended", by: ["staff"], final: true },
    ];
    return m;
  }

  it("may declare discount objects and passes the host's checks", async () => {
    const id = extId("rtoff");
    const now = new Date().toISOString();
    const checked = await checkManifest(db.query, id, runtimeOffers(id), now, {
      source: "runtime",
    });
    expect(checked.issues).toEqual([]);
    // Moved live by staff only through a state a person approves.
    const loose = await checkManifest(db.query, id, runtimeOffers(id, false), now, {
      source: "runtime",
    });
    expect(loose.issues.map((i) => i.path)).toContain("objects.discount.states.moves.0.by");
  });

  it("an assistant's change to a live discount waits for a person", async () => {
    const code = word("AILIVE");
    const id = await discount({ kind: "percent", percent: 10, code });
    const asked = await refusal(
      run(
        "record.update",
        { object: DISCOUNT, id, values: { percent: 90 } },
        staff(admin, { actor: "assistant" }),
      ),
    );
    expect(asked.code).toBe("pending_approval");
    expect((await buy([{ id: yoga }], { code })).discount).toBe(1_200);
  });
});

// --- The review of PR #454 ----------------------------------------------------------------------

describe("an AI or an automation cannot hand out a discount (review M1)", () => {
  for (const preset of ["balanced", "autonomous"] as const) {
    it(`codes and a restored discount wait for a person (${preset})`, async () => {
      await setPreset(preset);
      const id = await discount({ kind: "percent", percent: 50 });
      for (const actor of ["assistant", "automation"] as const) {
        const word1 = word("AIWORD");
        const made = await refusal(
          run(
            "record.create",
            { object: CODE, values: { word: word1, discount: id } },
            staff(admin, { actor }),
          ),
        );
        expect(made.code, actor).toBe("pending_approval");
        const many = await refusal(
          run(
            "record.createMany",
            { object: CODE, records: [{ word: word("AIMANY"), discount: id }] },
            staff(admin, { actor }),
          ),
        );
        expect(many.code, actor).toBe("pending_approval");
        // Meanwhile no order gets the deal.
        expect((await refusal(buy([{ id: yoga }], { code: word1 }))).message).toBe(NOT_VALID);
      }
      // A single-use code a person made: an AI raising its uses waits.
      const once = word("AIONCE");
      const codeId = await create(CODE, { word: once, discount: id, uses: 1 });
      const raised = await refusal(
        run(
          "record.update",
          { object: CODE, id: codeId, values: { uses: 1000 } },
          staff(admin, { actor: "assistant" }),
        ),
      );
      expect(raised.code).toBe("pending_approval");
      expect((await buy([{ id: yoga }], { code: once })).discount).toBe(6_000);
      expect((await refusal(buy([{ id: yoga }], { code: once }))).message).toBe(NOT_VALID);
      // A person stops a live discount by deleting it; an AI restoring it waits.
      const live = word("AIRESTORE");
      const gone = await discount({ kind: "percent", percent: 30, code: live });
      await run("record.delete", { object: DISCOUNT, id: gone }, staff());
      const restored = await refusal(
        run("record.restore", { object: DISCOUNT, id: gone }, staff(admin, { actor: "assistant" })),
      );
      expect(restored.code).toBe("pending_approval");
      expect((await refusal(buy([{ id: yoga }], { code: live }))).message).toBe(NOT_VALID);
      await setPreset("balanced");
    });
  }
});

describe("a late payment honoured (review F3)", () => {
  it("takes the use again while one is left, and is refused with words saying so when none is", async () => {
    const code = word("LATEOK");
    await discount({ kind: "percent", percent: 10, code, totalUses: 1 });
    const late = await buy([{ id: yoga }], { code });
    await checkout(late);
    await run("fixture.moveOrderAs", { id: late.id, to: "expired", by: "host" }, staff());
    await providerPays(late.id);
    await run("order.honourLate", { id: late.id }, staff());
    expect((await usesOf(late.id)).map((u) => u.state)).toEqual(["released", "used"]);

    const gone = word("LATEGONE");
    await discount({ kind: "percent", percent: 10, code: gone, totalUses: 1 });
    const lapsed = await buy([{ id: yoga }], { code: gone });
    await checkout(lapsed);
    await run("fixture.moveOrderAs", { id: lapsed.id, to: "expired", by: "host" }, staff());
    const taken = await buy([{ id: mat }], { code: gone });
    await checkout(taken);
    await providerPays(taken.id);
    await providerPays(lapsed.id);
    const refused = await refusal(run("order.honourLate", { id: lapsed.id }, staff()));
    expect(refused.details).toMatchObject({ rule: "discount_used_up", reason: "had_since" });
    expect(refused.message).toMatch(/Refund the payment/);
    expect((await usesOf(lapsed.id)).map((u) => u.state)).toEqual(["released"]);
  });
});

describe("the smallest amount that can be charged (review F4, rule 5)", () => {
  it("a deal leaving less than the setting is not valid; an automatic one is not applied", async () => {
    const code = word("NEARLY");
    await discount({ kind: "percent", percent: 99.99, code });
    // 99.99% of 120.00 leaves 0.02: under the 0.50 default.
    expect((await refusal(buy([{ id: yoga }], { code }))).message).toBe(NOT_VALID);
    const settings = await run<{ minCharge: number }>("order.settings.get", {}, staff());
    expect(settings.minCharge).toBe(50);
    // Lowered by a person, it applies.
    await run("order.settings.update", { minCharge: 1 }, context(admin));
    expect((await buy([{ id: yoga }], { code })).total).toBe(2);
    await run("order.settings.update", { minCharge: 50 }, context(admin));
    // Changing it is a person's.
    const byAi = await refusal(
      run("order.settings.update", { minCharge: 1 }, staff(admin, { actor: "assistant" })),
    );
    expect(byAi.code).toBe("forbidden");

    const cheap = await create(CLASS, { name: unique("Towel"), price: 1.5 });
    await discount({ kind: "amount", amount: 1.2, automatic: true, items: [cheap] });
    const order = await buy([{ id: cheap }]);
    expect(order).toMatchObject({ total: 150, discount: 0, deal: null });
  });
});

describe("automatic discounts past the cap (review F5)", () => {
  it("out-of-date ones never crowd out one that applies", async () => {
    const item = await create(CLASS, { name: unique("Busy"), price: 50 });
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    for (let i = 0; i < 27; i++) {
      await discount({
        kind: "amount",
        amount: 1,
        automatic: true,
        items: [item],
        until: yesterday,
      });
    }
    await discount({ kind: "amount", amount: 5, automatic: true, items: [item] });
    expect((await buy([{ id: item }])).discount).toBe(500);
  });
});

describe("races and limits the review found untested", () => {
  it("an automatic price's last use taken at once: the other order goes through without it (F8)", async () => {
    const item = await create(CLASS, { name: unique("Race"), price: 30 });
    await discount({ kind: "amount", amount: 5, automatic: true, items: [item], totalUses: 1 });
    const results = await Promise.allSettled([buy([{ id: item }]), buy([{ id: item }])]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const discounts = results
      .map((r) => (r as PromiseFulfilledResult<OrderOut>).value.discount)
      .sort((a, b) => a - b);
    expect(discounts).toEqual([0, 500]);
  });

  it("a code record's own limit is kept by the database (code_max_uses)", async () => {
    const id = await discount({ kind: "amount", amount: 5 });
    const once = word("RACEONE");
    const codeId = await create(CODE, { word: once, discount: id, uses: 1 });
    const results = await Promise.allSettled([
      buy([{ id: yoga }], { code: once }),
      buy([{ id: mat }], { code: once }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = (
      results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<OrderOut>
    ).value;
    await expect(
      env.DB.prepare(
        "INSERT INTO core_discount_use (id, discount_object, discount_id, code_object, code_id, kind, order_id, state, amount, code_max_uses, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'code', ?, 'held', 1, 1, 't', 't')",
      )
        .bind(unique("dcu"), DISCOUNT, id, CODE, codeId, winner.id)
        .run(),
    ).rejects.toThrow(/core_discount_use_limit/);
  });

  it("a merge moves uses to the survivor; an erase leaves them with no Person", async () => {
    const code = word("MERGE");
    await discount({ kind: "percent", percent: 10, code, perPerson: 1 });
    const merged = await createBuyer(admin, "dm1");
    const survivor = await createBuyer(admin, "dm2");
    const order = await buy([{ id: yoga }], { code }, as(merged));
    await run("customer.disable", { id: merged.principal.customerId }, staff());
    await run(
      "person.merge",
      { survivorId: survivor.principal.personId, mergedId: merged.principal.personId },
      staff(),
    );
    expect((await usesOf(order.id)).map((u) => u.person_id)).toEqual([survivor.principal.personId]);
    expect((await refusal(buy([{ id: mat }], { code }, as(survivor)))).message).toBe(NOT_VALID);
    await run("person.erase", { id: survivor.principal.personId }, staff());
    expect((await usesOf(order.id)).map((u) => u.person_id)).toEqual([null]);
  });

  it("the organisation and tag audiences", async () => {
    const org = (
      await run<{ id: string }>("organisation.create", { name: unique("Acme") }, staff())
    ).id;
    const at = await createBuyer(admin, "atorg");
    const other = await createBuyer(admin, "elsewhere");
    await run(
      "affiliation.create",
      { personId: at.principal.personId, organisationId: org },
      staff(),
    );
    const rate = word("ACME");
    await discount({ kind: "percent", percent: 20, code: rate, who: "organisation", orgs: [org] });
    expect((await buy([{ id: yoga }], { code: rate }, as(at))).discount).toBe(2_400);
    expect((await refusal(buy([{ id: yoga }], { code: rate }, as(other)))).message).toBe(NOT_VALID);
    const vip = unique("vip").toLowerCase();
    await run("person.update", { id: other.principal.personId, tags: [vip] }, staff());
    const tagged = word("VIP");
    await discount({ kind: "percent", percent: 15, code: tagged, who: "tag", tag: vip });
    expect((await buy([{ id: yoga }], { code: tagged }, as(other))).discount).toBe(1_800);
    expect((await refusal(buy([{ id: yoga }], { code: tagged }, as(at)))).message).toBe(NOT_VALID);
  });
});

// ADR 0940: codes as the host keeps them, and wrong codes counted per caller.
describe("promo codes kept folded, looked up by index, and guessed no faster than the limit", () => {
  const guessLimits = () => ({
    read: memoryRateLimit(10_000),
    write: memoryRateLimit(10_000),
    asset: memoryRateLimit(10_000),
    shared: memoryRateLimit(10_000),
    caller: memoryRateLimit(10_000),
    codeSurge: memoryRateLimit(10_000),
  });
  const wifi = { key: "the-gyms-wifi", shared: false };
  const limited = (
    principal: Buyer["principal"] | typeof PUBLIC = PUBLIC,
    address: { key: string; shared: boolean } = wifi,
    limits = guessLimits(),
  ) =>
    outside(principal, {
      integrations: runtime,
      events,
      publicLimits: limits,
      clientAddress: address,
    });
  const check = (code: string, ctx: ReturnType<typeof guest> | ReturnType<typeof staff>) =>
    run<{ valid: boolean; message: string | null }>(
      "discount.check",
      { code, lines: [{ object: CLASS, id: yoga }] },
      ctx,
    );

  it("after 20 wrong codes a member is refused codes, a right one too; another member on the same wifi is not", async () => {
    const right = word("RIGHT");
    await discount({ kind: "percent", percent: 10, code: right });
    const guesser = await createBuyer(admin, "guesser");
    for (let n = 0; n < 20; n += 1) {
      expect((await check(word("WRONG"), limited(guesser.principal))).valid).toBe(false);
    }
    // The 21st try from that account, right or wrong: refused, the same answer either way.
    const wrong21 = await refusal(check(word("WRONG"), limited(guesser.principal)));
    const right21 = await refusal(check(right, limited(guesser.principal)));
    expect(wrong21).toMatchObject({ code: "rate_limited", details: { retryAfterSeconds: 900 } });
    expect({ code: right21.code, message: right21.message }).toEqual({
      code: wrong21.code,
      message: wrong21.message,
    });
    // An order start with a code counts in the same group, and is refused too.
    expect(
      await refusal(buy([{ id: yoga }], { code: right }, limited(guesser.principal))),
    ).toMatchObject({ code: "rate_limited" });
    // Another member on the same wifi, and a guest there, are not affected.
    const other = await createBuyer(admin, "other");
    expect((await check(right, limited(other.principal))).valid).toBe(true);
    expect((await check(right, limited())).valid).toBe(true);
    // Staff are never counted.
    expect((await check(right, staff())).valid).toBe(true);
  });

  it("a guest's wrong codes on an order lock that order only", async () => {
    const right = word("ORDERCODE");
    await discount({ kind: "percent", percent: 10, code: right });
    const first = await buy([{ id: mat }], {}, limited());
    const second = await buy([{ id: mat }], {}, limited());
    const apply = (order: OrderOut, code: string) =>
      run("order.applyCode", { id: order.id, token: order.token, code }, limited());
    for (let n = 0; n < 20; n += 1) {
      expect((await refusal(apply(first, word("NOPE")))).message).toBe(NOT_VALID);
    }
    expect(await refusal(apply(first, right))).toMatchObject({ code: "rate_limited" });
    // Another guest's order from the same address takes the right code.
    expect(await apply(second, right)).toMatchObject({ codeApplied: true });
  });

  it("a guest naming no order is counted per address, at 50", async () => {
    const address = { key: unique("guest-address"), shared: false };
    for (let n = 0; n < 50; n += 1) {
      await refusal(buy([{ id: yoga }], { code: word("NOPE") }, limited(PUBLIC, address)));
    }
    expect(await refusal(check(word("ANY"), limited(PUBLIC, address)))).toMatchObject({
      code: "rate_limited",
    });
    // A web app's shared bucket is never locked.
    const shared = { key: "client-app", shared: true };
    for (let n = 0; n < 60; n += 1) {
      expect((await check(word("NOPE"), limited(PUBLIC, shared))).valid).toBe(false);
    }
  });

  it("10 code checks a minute per signed-in account", async () => {
    const limits = { ...guessLimits(), caller: memoryRateLimit(10) };
    const member = await createBuyer(admin, "fast");
    const right = word("FAST");
    await discount({ kind: "percent", percent: 10, code: right });
    for (let n = 0; n < 10; n += 1) await check(right, limited(member.principal, wifi, limits));
    expect(await refusal(check(right, limited(member.principal, wifi, limits)))).toMatchObject({
      code: "rate_limited",
    });
  });

  it("a code is kept folded: typed in any case or with spaces, and with non-ASCII letters", async () => {
    const tag = unique("x").toLowerCase();
    const id = await discount({ kind: "percent", percent: 10, code: `été ${tag}` });
    const row = await env.DB.prepare(`SELECT * FROM ${await viewOf(DISCOUNT)} WHERE id = ?`)
      .bind(id)
      .first<Record<string, unknown>>();
    expect(Object.values(row ?? {})).toContain(`ÉTÉ${tag.toUpperCase()}`);
    expect((await check(`ÉTÉ${tag}`, guest())).valid).toBe(true);
    expect((await check(` Été ${tag.toUpperCase()} `, guest())).valid).toBe(true);
    // A code record's word too.
    const owner = await discount({ kind: "percent", percent: 5, code: word("OWNER") });
    const single = `straße${unique("s").toLowerCase()}`;
    await create(CODE, { word: single, discount: owner, uses: 1 });
    expect((await check(single.toUpperCase(), guest())).valid).toBe(true);
  });

  it("a code word is at least 6 characters, and one word names one live record", async () => {
    const short = await refusal(create(DISCOUNT, { name: unique("Deal"), code: "SALE" }));
    expect(short).toMatchObject({ code: "invalid_input", details: { rule: "code_length" } });
    const taken = word("TAKEN");
    await create(DISCOUNT, { name: unique("Deal"), code: taken });
    const again = await refusal(
      create(DISCOUNT, { name: unique("Deal"), code: taken.toLowerCase() }),
    );
    expect(again).toMatchObject({ code: "conflict", details: { rule: "code_taken" } });
    // The database holds it too, whatever wrote it: a unique index on the folded word.
    const { results } = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name LIKE '%\\_\\_code' ESCAPE '\\'",
    ).all<{ sql: string }>();
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.every((r) => /CREATE UNIQUE INDEX/.test(r.sql))).toBe(true);
  });

  it("a guess is looked up by the index, not by reading every code", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name LIKE '%\\_\\_code' ESCAPE '\\'",
    ).all<{ name: string; tbl_name: string }>();
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (const index of results) {
      const column = index.name.slice(`${index.tbl_name}__`.length, -"__code".length);
      const plan = await env.DB.prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM ${index.tbl_name} WHERE deleted_at IS NULL AND ${column} = ?`,
      )
        .bind("ANYCODE")
        .all<{ detail: string }>();
      expect(plan.results.map((r) => r.detail).join(" "), index.name).toContain(index.name);
    }
  });

  it("words already there are folded before the unique index is built; two that fold to one stop it, named (F4)", async () => {
    const id = extId("offerswords");
    const m = offers(id);
    await reconcile(m);
    const table = await viewOf(`${id}.discount`);
    const column = (
      await env.DB.prepare(
        "SELECT column_name FROM core_extension_fields WHERE object = ? AND name = 'code'",
      )
        .bind(`${id}.discount`)
        .first<{ column_name: string }>()
    )?.column_name as string;
    const index = `${table}__${column}__code`;
    // As a client extension's records were before the index: unfolded, and two alike.
    await env.DB.prepare(`DROP INDEX ${index}`).run();
    const now = new Date().toISOString();
    const insert = (rid: string, word: string) =>
      env.DB.prepare(
        `INSERT INTO ${table} (id, created_at, updated_at, created_by, name, ${column}) VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(rid, now, now, admin.id, "Old", word)
        .run();
    await insert("rec_fold_a", "summer 26x");
    await insert("rec_fold_b", "SUMMER26X");
    await insert("rec_fold_c", "winter26x");
    const clash = await planOf(m);
    expect(clash.issues.map((i) => i.code)).toContain("code_word_conflict");
    expect(clash.issues.find((i) => i.code === "code_word_conflict")?.message).toMatch(
      /SUMMER26X \(rec_fold_a, rec_fold_b\)/,
    );
    await env.DB.prepare(`UPDATE ${table} SET deleted_at = ? WHERE id = 'rec_fold_b'`)
      .bind(now)
      .run();
    await reconcile(m);
    const kept = await env.DB.prepare(
      `SELECT id, ${column} AS word FROM ${table} WHERE id LIKE 'rec_fold_%' ORDER BY id`,
    ).all();
    expect(kept.results).toEqual([
      { id: "rec_fold_a", word: "SUMMER26X" },
      { id: "rec_fold_b", word: "SUMMER26X" },
      { id: "rec_fold_c", word: "WINTER26X" },
    ]);
    const built = await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = ?")
      .bind(index)
      .first();
    expect(built).toBeTruthy();
  });

  it("foldCode drops invisible characters a pasted code may carry (F5)", () => {
    expect(foldCode("sum\u200bmer\u00ad26")).toBe("SUMMER26");
    expect(foldCode("\ufeffWINTER 26")).toBe("WINTER26");
  });

  it("randomCodes: 16 characters of an alphabet with no 0, 1, I or O, from getRandomValues", () => {
    const codes = randomCodes(500);
    expect(new Set(codes).size).toBe(500);
    for (const code of codes) {
      expect(code).toMatch(/^[2-9A-HJ-NP-Z]{16}$/);
      expect(foldCode(code)).toBe(code);
    }
    expect(CODE_ALPHABET).toHaveLength(32);
    expect(() => randomCodes(1, 8)).toThrow();
  });
});

// --- Stage 34 step 5 (ADR 0699): single-use codes kept as their hash ------------------------------

describe("codes kept as their hash", () => {
  const H = extId("hoffers");
  const HDISCOUNT = `${H}.discount`;
  const HCODE = `${H}.code`;
  const hashedTool = () =>
    context(admin, {
      actor: "extension",
      extension: {
        id: H,
        permissions: { read: [], write: [], operations: [], modules: ["ops"] },
        tool: {
          name: "activate",
          personApproves: true,
          permission: `${H}:manage`,
          calledBy: { account: admin.id, actor: "human" },
        },
      },
    } as never);
  let hdiscount: string;

  beforeAll(async () => {
    const m = offers(H) as unknown as ExtensionManifest & {
      objects: { discount: { discount: { codes: Record<string, unknown> } } };
    };
    m.objects.discount.discount.codes.hashed = true;
    await reconcile(m);
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', ?, ?, ?, ?)",
    )
      .bind(H, JSON.stringify(m), admin.id, now, now)
      .run();
    hdiscount = (
      (await run(
        "record.create",
        { object: HDISCOUNT, values: { name: unique("Hashed"), kind: "percent", percent: 25 } },
        context(admin),
      )) as { id: string }
    ).id;
    await run(
      "record.update",
      { object: HDISCOUNT, id: hdiscount, values: { state: "active" } },
      hashedTool(),
    );
  });

  const check = (code: string) =>
    run<{ valid: boolean }>(
      "discount.check",
      { code, lines: [{ object: CLASS, id: yoga }] },
      guest(),
    );

  it("keeps only a hash: a code in clear is refused, by a person too", async () => {
    const [code] = randomCodes(1) as [string];
    const clear = await refusal(
      run(
        "record.create",
        { object: HCODE, values: { word: code, discount: hdiscount, uses: 1 } },
        context(admin),
      ),
    );
    expect(clear).toMatchObject({ code: "invalid_input", details: { rule: "code_hashed" } });
    const hash = await codeHash(code);
    expect(isCodeHash(hash)).toBe(true);
    expect(hash).toHaveLength(57);
    await run(
      "record.create",
      { object: HCODE, values: { word: hash, discount: hdiscount, uses: 1 } },
      context(admin),
    );
    const table = await viewOf(HCODE);
    const stored = await env.DB.prepare(`SELECT * FROM ${table}`).all();
    expect(JSON.stringify(stored.results)).not.toContain(code);
  });

  it("the host hashes what a buyer types and finds the code; the hash typed is not a code", async () => {
    const [code] = randomCodes(1) as [string];
    const hash = await codeHash(code);
    await run(
      "record.create",
      { object: HCODE, values: { word: hash, discount: hdiscount, uses: 1 } },
      context(admin),
    );
    expect((await check(code.toLowerCase())).valid).toBe(true);
    expect((await check(hash)).valid).toBe(false);
    // Single use: once paid, it is spent.
    const order = await buy([{ id: yoga }], { code });
    expect(order.deal).toMatchObject({ kind: "code", amount: 3_000 });
    expect((await buy([{ id: yoga }], { code }).catch((e) => e)).message).toBe(NOT_VALID);
  });
});

/** The table of an extension object's records, as the registry names it. */
async function viewOf(object: string): Promise<string> {
  const row = await env.DB.prepare("SELECT table_name FROM core_extension_objects WHERE name = ?")
    .bind(object)
    .first<{ table_name: string }>();
  return row?.table_name ?? "";
}
