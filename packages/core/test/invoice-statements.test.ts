// Stage 35 criterion 23, for the drafts (step 2): the biggest writes of a draft stay well inside
// D1's limits of 1,000 statements per invocation and 100 bound variables per statement, which
// the local runtime does not enforce. A draft has at most DOCUMENT_MAX_LINES lines: starting one
// with all of them, moving one (every line renumbered) and switching between amounts with and
// without tax (every line priced again) are the most a call writes.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invoke } from "../src/index.ts";
import { context, createUser } from "./helpers.ts";
import { createTicketType, installBoxOffice, TICKET_TYPE } from "./order-fixtures.ts";

/** What one call ran on D1: each statement's bound variables. */
let ran: number[] = [];

const counted = new Proxy(env.DB, {
  get(target, key) {
    if (key === "prepare") {
      return (query: string) => {
        const statement = target.prepare(query);
        return new Proxy(statement, {
          get(inner, name) {
            if (name === "bind") {
              return (...values: unknown[]) => {
                ran.push(values.length);
                return inner.bind(...values);
              };
            }
            const value = Reflect.get(inner, name);
            if (typeof value === "function") {
              if (name === "all" || name === "first" || name === "run" || name === "raw") {
                ran.push(0);
              }
              return value.bind(inner);
            }
            return value;
          },
        });
      };
    }
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const countedDb = createCrmDb(counted);

let admin: ActingUser;
let ticket: string;

beforeAll(async () => {
  admin = await createUser("admin");
  await installBoxOffice(admin);
  ticket = await createTicketType(admin, { name: "Fixture pass", price: 25 });
  await invoke(
    "invoice.settings.update",
    { taxRates: [{ key: "std", label: "Standard", rate: 1000 }], defaultTaxRate: "std" },
    context(admin),
  );
}, 120_000);

async function measure<T>(call: () => Promise<T>): Promise<{ result: T; statements: number[] }> {
  ran = [];
  const result = await call();
  return { result, statements: ran };
}

describe("a draft's biggest writes, in a bounded number of statements", () => {
  it("fifty lines, moved and priced again, stay far inside D1's limits", async () => {
    const lines: Record<string, unknown>[] = Array.from({ length: 50 }, (_, n) =>
      n === 0
        ? { item: { object: TICKET_TYPE, id: ticket }, quantity: 1 + (n % 3) }
        : { description: `Fixture line ${n}`, quantity: 1.25, unit: "hours", unitPrice: 1000 + n },
    );
    const created = await measure(() =>
      invoke("invoice.create", { lines }, context(admin, { db: countedDb })),
    );
    expect(created.result.lines).toHaveLength(50);
    const id = created.result.id as string;
    const last = created.result.lines[49]?.id as string;
    const moved = await measure(() =>
      invoke(
        "invoice.updateLine",
        { lineId: last, change: { position: 0 } },
        context(admin, { db: countedDb }),
      ),
    );
    expect(moved.result.lines[0]?.id).toBe(last);
    const repriced = await measure(() =>
      invoke("invoice.update", { id, taxMode: "exclusive" }, context(admin, { db: countedDb })),
    );
    expect(repriced.result.taxMode).toBe("exclusive");
    const removed = await measure(() =>
      invoke("invoice.removeLine", { lineId: last }, context(admin, { db: countedDb })),
    );
    expect(removed.result.lines).toHaveLength(49);
    const deleted = await measure(() =>
      invoke("invoice.delete", { id }, context(admin, { db: countedDb })),
    );
    for (const call of [created, moved, repriced, removed, deleted]) {
      // One statement per line at most, and the reads and bookkeeping around them (about 70).
      expect(call.statements.length).toBeLessThan(200);
      expect(Math.max(...call.statements)).toBeLessThan(100);
    }
    // A line more is refused before anything is written.
    const full = await invoke("invoice.create", { lines }, context(admin));
    await expect(
      invoke(
        "invoice.addLine",
        { id: full.id, line: { description: "One too many", unitPrice: 1 } },
        context(admin),
      ),
    ).rejects.toMatchObject({ details: { rule: "too_many_lines" } });
    await expect(
      invoke(
        "invoice.create",
        { lines: [...lines, { description: "One too many", unitPrice: 1 }] },
        context(admin),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
