// Stage 48 step 1: the Orders section of My account, against the real host. The base headless
// entry (`loadOrders` in @composable-os/client) reads a page of the customer's orders and then
// their lines in one `my.list` whose filter names every order of the page: each id is a bound
// variable, so this counts what each call runs on D1 (the local runtime enforces neither 1,000
// statements per invocation nor 100 bound variables per statement). It also holds the section to
// the customer's own orders: never another customer's, never a child's.
import { env } from "cloudflare:workers";
import { type AccountClient, loadOrders, ORDERS_PAGE } from "@composable-os/client";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invoke } from "../src/index.ts";
import { context, createUser } from "./helpers.ts";
import {
  type Buyer,
  createBuyer,
  createTicketType,
  installBoxOffice,
  outside,
  run,
  TICKET_TYPE,
} from "./order-fixtures.ts";

/** What one call ran on D1: each statement's bound variables. */
let ran: number[] = [];

/** env.DB, noting each statement's bound variables. The statements it hands out are real. */
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
              // A statement run with nothing bound is a statement too.
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

/** The client the account blocks are given, over the host's operations as `buyer` calls them. */
function clientFor(buyer: Buyer, calls: number[][]): AccountClient {
  return {
    query(name: string, input: unknown) {
      return {
        queryKey: [name, input],
        queryFn: async () => {
          ran = [];
          try {
            return await run(name, input, outside(buyer.principal, { db: countedDb }));
          } finally {
            calls.push(ran);
          }
        },
      };
    },
    mutation() {
      throw new Error("the Orders section changes nothing");
    },
  } as unknown as AccountClient;
}

let admin: ActingUser;
let member: Buyer;
let other: Buyer;
let child: Buyer;
const mine: string[] = [];
const theirs: string[] = [];

async function buy(buyer: Buyer, items: string[]): Promise<string> {
  const order = await run<{ id: string }>(
    "order.start",
    { lines: items.map((id) => ({ object: TICKET_TYPE, id })) },
    outside(buyer.principal),
  );
  return order.id;
}

beforeAll(async () => {
  admin = await createUser("admin");
  await installBoxOffice(admin);
  member = await createBuyer(admin, "member");
  other = await createBuyer(admin, "other");
  child = await createBuyer(admin, "child");
  await invoke(
    "person.link.add",
    { guardianId: member.principal.personId, dependantId: child.principal.personId },
    context(admin),
  );
  const a = await createTicketType(admin, { name: "Fixture class", price: 12 });
  const b = await createTicketType(admin, { name: "Fixture mat hire", price: 3 });
  // More orders than a page, each of two lines.
  for (let n = 0; n < ORDERS_PAGE + 5; n += 1) mine.push(await buy(member, [a, b]));
  theirs.push(await buy(other, [a]), await buy(child, [b]));
}, 120_000);

describe("Orders: the customer's own orders, in a bounded number of statements", () => {
  it("reads a page of orders with their lines in two calls, each well inside D1's limits", async () => {
    const calls: number[][] = [];
    const api = clientFor(member, calls);
    const first = await loadOrders(api);
    expect(first.orders).toHaveLength(ORDERS_PAGE);
    expect(first.nextCursor).not.toBeNull();
    for (const order of first.orders) {
      expect(order.lines.map((l) => l.title).sort()).toEqual(["Fixture class", "Fixture mat hire"]);
      expect(order.currency).toBe("AUD");
      expect(order.state).toBe("pending");
      expect(order.total).toBe(1500);
    }
    // Two calls: the orders, then their lines.
    expect(calls).toHaveLength(2);
    for (const statements of calls) {
      expect(statements.length).toBeGreaterThan(0);
      expect(statements.length).toBeLessThan(20);
      // The lines' call binds every order of the page, and stays far under 100.
      expect(Math.max(...statements)).toBeLessThan(100);
    }
    const lines = calls[1] ?? [];
    expect(Math.max(...lines)).toBeGreaterThanOrEqual(ORDERS_PAGE);

    const second = await loadOrders(api, first.nextCursor ?? undefined);
    expect(second.orders).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    // Newest first, and every order of the member's once.
    const seen = [...first.orders, ...second.orders].map((o) => o.id);
    expect([...seen].sort()).toEqual([...mine].sort());
    // The statements a call runs do not grow with the orders on the page.
    expect(calls[3]?.length).toBe(calls[1]?.length);
  });

  it("never lists another customer's orders, nor a child's to their parent", async () => {
    const api = clientFor(member, []);
    const pages = [await loadOrders(api)];
    const next = pages[0]?.nextCursor;
    if (next) pages.push(await loadOrders(api, next));
    const ids = pages.flatMap((p) => p.orders.map((o) => o.id));
    for (const id of theirs) expect(ids).not.toContain(id);
    // The child's order is the child's own.
    const own = await loadOrders(clientFor(child, []));
    expect(own.orders.map((o) => o.id)).toEqual([theirs[1]]);
  });
});
