// Stage 52 step 3, the review of PR #423: each sequence it reproduced, kept as a test. A guest's
// address never lands in a closed Refunds row the erase cannot reach; an erase between the close's
// read and its batch fails the close; a member granted finance:read reads figures over an MCP
// connection with the `read` scope (never the file); a Refunds report naming more staff than D1
// binds variables; a late payment staff honoured counts the month they honoured it; an order with
// no lines keeps its tax. Every clock is injected; orders are written as the order code leaves them.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { closePlan, periodBook, readGuards } from "../src/finance/close.ts";
import { monthRange } from "../src/finance/day.ts";
import {
  type ActingUser,
  type InvocationContext,
  invokeByName,
  newId,
  scopePermissions,
} from "../src/index.ts";
import type { HandlerContext } from "../src/operation.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";

const ZONE = "UTC";
const CURRENCY = "NZD";
const JULY = "2026-07-02T00:00:00.000Z";
const EXT = extId("finrev");
const GOODS = `${EXT}.goods`;

const call = <T>(
  name: string,
  input: unknown,
  user: ActingUser,
  extra: Partial<InvocationContext> = {},
) =>
  invokeByName(name, input, context(user, { clock: () => new Date(JULY), ...extra })) as Promise<T>;

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error("expected a refusal");
}

async function order(lines: number[], personId: string | null, email: string | null) {
  const id = newId("order");
  const total = lines.reduce((n, l) => n + l, 0);
  await env.DB.prepare(
    `INSERT INTO core_order (id, person_id, email, currency, total, paid, refunded, state, placed_as,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'paid', 'public', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')`,
  )
    .bind(id, personId, email, CURRENCY, total, total)
    .run();
  for (const [i, total] of lines.entries()) {
    await env.DB.prepare(
      `INSERT INTO core_order_line (id, order_id, position, object_type, record_id, title, quantity,
         unit_price, line_total, created_at)
       VALUES (?, ?, ?, ?, 'rec_x', 'Mat', 1, ?, ?, '2026-03-01T00:00:00.000Z')`,
    )
      .bind(newId("orderLine"), id, i + 1, GOODS, total, total)
      .run();
  }
  return id;
}

async function payment(
  orderId: string,
  amount: number,
  at: string,
  extra: { outcome?: string; resolvedAt?: string; tax?: number } = {},
) {
  await env.DB.prepare(
    `INSERT INTO core_order_payment (provider, event_id, order_id, amount, currency, outcome,
       payment_ref, received_at, resolved, resolved_at, tax_amount, tax_country)
     VALUES ('fake', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      unique("evt"),
      orderId,
      amount,
      CURRENCY,
      extra.outcome ?? "applied",
      unique("pi"),
      at,
      extra.resolvedAt ? "honoured" : null,
      extra.resolvedAt ?? null,
      extra.tax ?? null,
      extra.tax === undefined ? null : "NZ",
    )
    .run();
}

async function refund(orderId: string, amount: number, at: string, requestedBy: string | null) {
  await env.DB.prepare(
    `INSERT INTO core_order_refund (id, order_id, provider, amount, currency, status, requested_by,
       confirmed_at, created_at)
     VALUES (?, ?, 'fake', ?, ?, 'confirmed', ?, ?, ?)`,
  )
    .bind(newId("refund"), orderId, amount, CURRENCY, requestedBy, at, at)
    .run();
}

async function person(given: string, family: string, email: string): Promise<string> {
  return (
    await call<{ id: string }>(
      "person.create",
      { givenName: given, familyName: family, email },
      admin,
    )
  ).id;
}

const closedRefunds = async (month: string) =>
  (
    await env.DB.prepare(
      `SELECT r.person_id, r.name, r.email FROM core_finance_row r JOIN core_finance_period p
         ON p.id = r.period_id WHERE p.month = ? AND r.report = 'refunds'`,
    )
      .bind(month)
      .all<{ person_id: string | null; name: string | null; email: string | null }>()
  ).results;

let admin: ActingUser;
let member: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  for (const [key, value] of [
    ["org_timezone", ZONE],
    ["order_currency", CURRENCY],
    ["finance_installed_at", "2026-03-02T00:00:00.000Z"],
  ] as const) {
    await env.DB.prepare(
      "INSERT INTO core_settings (key, value, updated_at) VALUES (?, ?, 'now') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
      .bind(key, JSON.stringify(value))
      .run();
  }
  await reconcile(
    manifest(EXT, {
      objects: {
        goods: {
          label: "Goods",
          plural: "Goods",
          titleField: "name",
          fields: {
            name: { type: "text" as const, label: "Name", required: true },
            price: { type: "currency" as const, label: "Price", currency: CURRENCY },
          },
          sellable: { price: "price", finance: { category: { key: "goods", label: "Goods" } } },
        },
      },
    }),
  );
});

describe("the review of PR #423", () => {
  it("a guest's address is not kept in a closed Refunds row, which the erase reaches by Person only", async () => {
    const address = "guest.review@buyers.example";
    const guest = await order([2000], null, address);
    await payment(guest, 2000, "2026-03-05T01:00:00.000Z");
    await refund(guest, 2000, "2026-03-06T01:00:00.000Z", admin.id);
    await call("finance.close", { month: "2026-03" }, admin);
    expect(await closedRefunds("2026-03")).toEqual([{ person_id: null, name: null, email: null }]);
    // An erase of a Person with that address later has nothing left to miss.
    await call("person.erase", { id: await person("Gus", "Guest", address) }, admin);
    const file = await call<{ csv: string }>(
      "finance.export",
      { report: "refunds", month: "2026-03" },
      admin,
    );
    expect(file.csv).not.toContain(address);
  });

  it("an erase between the close's read and its batch fails the close; retried, the name is gone", async () => {
    const address = "eve.review@buyers.example";
    const eve = await person("Eve", "Erased", address);
    const bought = await order([3000], eve, address);
    await payment(bought, 3000, "2026-04-05T01:00:00.000Z");
    await refund(bought, 1000, "2026-04-06T01:00:00.000Z", admin.id);
    const range = monthRange("2026-04", ZONE);
    const ctx = { db: db.query, now: JULY } as unknown as HandlerContext;
    const book = await periodBook(ctx, range);
    const values = await readGuards(ctx.db, book.guards);
    expect(book.rows.find((r) => r.report === "refunds")?.email).toBe(address);
    await call("person.erase", { id: eve }, admin);
    const plan = await closePlan(ctx, {
      id: newId("financePeriod"),
      month: "2026-04",
      range,
      version: 1,
      by: admin.id,
      book,
      guardValues: values,
    });
    await expect(db.batch(plan.statements)).rejects.toThrow(/core_finance_changed/);
    await call("finance.close", { month: "2026-04" }, admin);
    for (const row of await closedRefunds("2026-04")) {
      expect(row.email).not.toBe(address);
      expect(row.name ?? "").not.toContain("Eve");
    }
  });

  it("a member granted finance:read reads over a read-scope MCP connection, never the file", async () => {
    await call("user.setPermissions", { id: member.id, permissions: ["finance:read"] }, admin);
    const mcp: Partial<InvocationContext> = {
      actor: "mcp",
      origin: { surface: "mcp", clientId: "c", clientName: "c", sessionId: unique("s") },
      reason: "test",
      grantedPermissions: scopePermissions(["read"]),
    };
    const report = await call<{ rows: unknown[] }>(
      "finance.report",
      { report: "refunds", month: "2026-04" },
      member,
      mcp,
    );
    expect(report.rows).toHaveLength(1);
    await call("finance.entries", { month: "2026-04" }, member, mcp);
    expect(
      (await refusal(call("finance.export", { report: "sales", month: "2026-04" }, member, mcp)))
        .code,
    ).toBe("forbidden");
  });

  it("a Refunds report naming more staff than D1 binds variables reads their names", async () => {
    const staff: ActingUser[] = [];
    for (let i = 0; i < 105; i++) staff.push(await createUser("member"));
    for (const [i, who] of staff.entries()) {
      const id = await order([500], null, null);
      await payment(id, 500, `2026-05-0${1 + (i % 9)}T01:00:00.000Z`);
      await refund(id, 100, `2026-05-1${i % 9}T01:00:00.000Z`, who.id);
    }
    const refunds = await call<{ rows: { requestedByName: string | null }[] }>(
      "finance.report",
      { report: "refunds", start: "2026-05-01", end: "2026-05-31" },
      admin,
    );
    expect(refunds.rows).toHaveLength(105);
    expect(refunds.rows.every((r) => r.requestedByName === "member user")).toBe(true);
  });

  it("a late payment staff honoured counts the month they honoured it", async () => {
    const id = await order([1700], null, null);
    await payment(id, 1700, "2026-05-30T01:00:00.000Z", {
      outcome: "late",
      resolvedAt: "2026-06-03T01:00:00.000Z",
    });
    const june = await call<{ totals: Record<string, number> }>(
      "finance.report",
      { report: "sales", start: "2026-06-01", end: "2026-06-30" },
      admin,
    );
    expect(june.totals.sold).toBe(1700);
    const may = await call<{ totals: Record<string, number> }>(
      "finance.report",
      { report: "sales", start: "2026-05-30", end: "2026-05-31" },
      admin,
    );
    expect(may.totals.sold).toBe(0);
  });

  it("an order with no lines keeps the provider's tax", async () => {
    const id = await order([], null, null);
    await payment(id, 1100, "2026-06-20T01:00:00.000Z", { tax: 100 });
    const tax = await call<{ rows: Record<string, unknown>[] }>(
      "finance.report",
      { report: "tax", start: "2026-06-20", end: "2026-06-20" },
      admin,
    );
    expect(tax.rows).toEqual([
      expect.objectContaining({ taxCode: "none", taxCountry: "NZ", sold: 1100, taxOnSales: 100 }),
    ]);
  });
});
