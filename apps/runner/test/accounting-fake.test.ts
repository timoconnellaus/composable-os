// Stage 61 step 1: the fake accounting books are bound to cos-runner in tests (and in local
// development), as GATEKEEPER_ACCOUNTING_FAKE. An admin connects them for the org like any
// auto-provisioned gatekeeper and binds a set of books; the integration host reaches the facet,
// which serves the accounting contract. The host's own path to it (purpose `accounting`) and the
// rule that nothing else may call it are step 3.
import { env } from "cloudflare:workers";
import { type ActingUser, catalogueEntry, invokeByName } from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { availableVendors, integrationRuntime } from "../src/integrations/runtime.ts";
import { createAdmin, db, unique } from "./helpers.ts";

const integrations = integrationRuntime(env);
let admin: ActingUser;

function op<T>(name: string, input: unknown) {
  return invokeByName(name, input, {
    actor: "human",
    user: admin,
    origin: { surface: "ui" },
    db,
    integrations,
  }) as Promise<T>;
}

beforeAll(async () => {
  admin = await createAdmin();
});

describe("the fake accounting books in cos-runner", () => {
  it("are a dev-only catalogue entry that implements accounting, available here", async () => {
    expect(catalogueEntry("accounting-fake")).toMatchObject({
      connect: "auto",
      scopes: ["org"],
      devOnly: true,
      implements: "accounting",
    });
    expect(availableVendors(env)).toContain("accounting-fake");
    const { items } = await op<{ items: { vendor: string; available: boolean }[] }>(
      "integration.catalogue",
      {},
    );
    expect(items.find((i) => i.vendor === "accounting-fake")).toMatchObject({ available: true });
  });

  it("connect for the org, bind a set of books and serve the contract's types", async () => {
    const books = unique("books")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 40);
    await op("integration.setVendor", { vendor: "accounting-fake", enabled: true });
    const created = await op<{ connection: { id: string; status: string } }>("connection.create", {
      vendor: "accounting-fake",
      scope: "org",
    });
    expect(created.connection.status).toBe("active");
    const bound = await op<{ resource: { key: string; title: string; tsType: string } }>(
      "connection.bindResource",
      { id: created.connection.id, url: `accounting-fake://books/${books}` },
    );
    expect(bound.resource).toMatchObject({
      title: "Fake books (development)",
      tsType: "AccountingSession",
    });
    const { types } = await op<{ types: string }>("integration.types", {
      connectionId: created.connection.id,
      resource: bound.resource.key,
    });
    expect(types).toContain("export interface AccountingSession");
    // The books' controls reach the same Worker: a fresh set, nothing posted.
    expect((await env.TEST_ACCOUNTING_BOOKS.state(books)).records).toEqual([]);
  });
});
