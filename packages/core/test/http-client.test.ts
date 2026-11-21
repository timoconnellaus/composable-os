// Stage 23: the typed client's runtime against the real surface, in workerd (ADR 0418). A phone
// that loses the answer to a purchase retries with the same key and buys once; an app older than
// the host is told to update.
import { env } from "cloudflare:workers";
import { createClient, type FetchLike, UpgradeRequiredError } from "@composable-os/client";
import { beforeAll, describe, expect, it } from "vitest";
import { objectTableOf } from "../src/extensions/schema.ts";
import type { ActingUser, AnyInvocationContext } from "../src/index.ts";
import {
  type Customer,
  createCustomer,
  fixtureRegistry,
  installShop,
  outside,
  PUBLIC,
  REQUEST,
} from "./customer-fixtures.ts";
import { createUser, unique } from "./helpers.ts";
import { surfaceOver, tokenFor } from "./http-helpers.ts";

type Ops = {
  "fixture.myCreate": {
    kind: "mutation";
    input: { object: string; values: Record<string, string> };
    output: { id: string };
  };
  "fixture.whoAmI": { kind: "query"; input: Record<string, never>; output: { kind: string } };
};
const specs = {
  "fixture.myCreate": { kind: "mutation", invalidates: ["fixture.myList"] },
  "fixture.whoAmI": { kind: "query", invalidates: [] },
} as const;

let admin: ActingUser;
let a: Customer;
beforeAll(async () => {
  admin = await createUser("admin");
  await installShop();
  a = await createCustomer(admin, "A");
}, 60_000);

/** The surface as a fetch, with the caller's credential, and a way to lose the answer. */
function fetchFor(
  ctx: AnyInvocationContext,
  options: { loseFirstAnswer?: boolean; path?: (p: string) => string } = {},
) {
  const surface = surfaceOver(fixtureRegistry, outside(PUBLIC));
  const token = tokenFor(ctx);
  let calls = 0;
  const fetch: FetchLike = async (url, init) => {
    calls += 1;
    const target = options.path ? options.path(url) : url;
    const response = await surface.handle(
      new Request(target, {
        method: init.method,
        headers: { ...init.headers, authorization: `Bearer ${token}` },
        ...(init.body === undefined ? {} : { body: init.body }),
      }),
    );
    if (!response) throw new TypeError("not served");
    // The host applied the call, but the phone never saw the answer.
    if (options.loseFirstAnswer && calls === 1) throw new TypeError("connection reset");
    return response;
  };
  return { fetch, calls: () => calls };
}

describe("the runtime against the surface", () => {
  it("a write whose answer was lost is retried with its key and applied once", async () => {
    const text = unique("lost");
    const f = fetchFor(outside(a.principal), { loseFirstAnswer: true });
    const api = createClient<Ops>(specs, {
      baseUrl: "https://host.example",
      fetch: f.fetch,
      sleep: async () => {},
    });
    const out = await api.call("fixture.myCreate", { object: REQUEST, values: { text } });
    expect(out.id).toMatch(/^rec_/);
    expect(f.calls()).toBe(2);
    const rows = await env.DB.prepare(`SELECT id FROM ${objectTableOf(REQUEST)} WHERE text = ?`)
      .bind(text)
      .all();
    expect(rows.results).toEqual([{ id: out.id }]);
  });

  it("an app built for a version the host no longer serves gets UpgradeRequiredError (criterion 8)", async () => {
    const f = fetchFor(outside(a.principal), {
      path: (url) => url.replace("/api/v1/", "/api/v0/"),
    });
    let told = 0;
    const api = createClient<Ops>(specs, {
      baseUrl: "https://host.example",
      fetch: f.fetch,
      onUpgradeRequired: () => {
        told += 1;
      },
    });
    await expect(api.call("fixture.whoAmI", {})).rejects.toBeInstanceOf(UpgradeRequiredError);
    expect(told).toBe(1);
  });
});
