// Stage 65 step 1: the fake booking system is bound to cos-runner in tests (and in local
// development), as GATEKEEPER_BOOKING_SYSTEM_FAKE. An admin connects it for the org like any
// auto-provisioned gatekeeper and binds a site; the integration host reaches the facet, which
// serves the read-only booking-system contract. The host's own path to it (the sync kind
// `booking-system`) and the rule that nothing else may call it are step 3.
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

describe("the fake booking system in cos-runner", () => {
  it("is a dev-only catalogue entry that implements booking-system, available here", async () => {
    expect(catalogueEntry("booking-system-fake")).toMatchObject({
      connect: "auto",
      scopes: ["org"],
      devOnly: true,
      implements: "booking-system",
    });
    expect(availableVendors(env)).toContain("booking-system-fake");
    const { items } = await op<{ items: { vendor: string; available: boolean }[] }>(
      "integration.catalogue",
      {},
    );
    expect(items.find((i) => i.vendor === "booking-system-fake")).toMatchObject({
      available: true,
    });
  });

  it("connects for the org, binds a site and serves the contract's types", async () => {
    const site = unique("site")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 40);
    await env.TEST_BOOKING_SYSTEM.reset(site, { now: "2026-11-20T09:00:00.000Z" });
    await op("integration.setVendor", { vendor: "booking-system-fake", enabled: true });
    const created = await op<{ connection: { id: string; status: string } }>("connection.create", {
      vendor: "booking-system-fake",
      scope: "org",
    });
    expect(created.connection.status).toBe("active");
    const bound = await op<{ resource: { key: string; title: string; tsType: string } }>(
      "connection.bindResource",
      { id: created.connection.id, url: `booking-system-fake://site/${site}` },
    );
    expect(bound.resource).toMatchObject({
      title: "Fake booking system (development)",
      tsType: "BookingSystemSession",
    });
    const { types } = await op<{ types: string }>("integration.types", {
      connectionId: created.connection.id,
      resource: bound.resource.key,
    });
    expect(types).toContain("export interface BookingSystemSession");
    // Connecting and binding read nothing from the site.
    expect(await env.TEST_BOOKING_SYSTEM.callCount(site)).toEqual({ used: 0, byMethod: {} });
  });
});
