// A pack a product lists is installed in every deployment of that product (ADR 0420, amended
// 2026-11-22). The real path: `cos deploy` sets COS_PACKS to the product's packs
// (packages/create-composable-os, tested there), the runner lists them from the release's bundle
// (`shippedExtensions`, shipped-list.ts) and every new isolate installs them at boot
// (`installShippedExtensions`, packages/core/src/extensions/shipped.ts) through
// `extension.install`. Here the list and the install are the real code; only COS_PACKS, which the
// test pool's runner has as "*", is given per test.
import {
  type ExtensionHost,
  getObject,
  installShippedExtensions,
  invokeByName,
  type OutsideInvocationContext,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { shippedExtensions } from "../src/extensions/shipped-list.ts";
import { createAdmin, db, host } from "./helpers.ts";

/** The extension host of a deployment whose runner has this COS_PACKS. */
function deploymentWith(packs: string): ExtensionHost {
  return {
    ...host,
    shipped: async () =>
      (await shippedExtensions({ COS_PACKS: packs })).map(({ files: _files, ...meta }) => meta),
    commitShipped: async (id) => {
      const pack = (await shippedExtensions({ COS_PACKS: packs })).find((p) => p.id === id);
      if (!pack) throw new Error(`No shipped extension ${id}`);
      return host.commit({
        id,
        files: pack.files,
        message: `Shipped ${id} ${pack.version}`,
        author: { name: "Composable OS", email: "release@composableos.dev" },
      });
    },
  };
}

const boot = (packs: string) => installShippedExtensions({ db, host: deploymentWith(packs) });
const outcomes = (results: { id: string; outcome: string }[]) =>
  Object.fromEntries(results.map((r) => [r.id, r.outcome]));

beforeAll(async () => {
  await createAdmin();
});

describe("a client product's listed packs (ADR 0420, amended)", () => {
  it("are installed at the first boot, optional or not: objects, tools and public reads", async () => {
    // Programs with Bookings, which it requires: what `cos deploy` writes for a product listing
    // Programs (stage 78, ADR 0980).
    const results = await boot("bookings,content,programs,ticketing");
    expect(outcomes(results)).toEqual({
      bookings: "installed",
      content: "installed",
      programs: "installed",
      ticketing: "installed",
    });
    await refreshSchemaRegistry(db.query);
    for (const object of ["content.post", "programs.program", "ticketing.event"]) {
      expect(getObject(object), object).toBeDefined();
    }
    // The packs' public reads answer the public, through the operations pipeline.
    const guest: OutsideInvocationContext = {
      principal: { kind: "public" },
      db,
      extensionHost: deploymentWith("bookings,content,programs,ticketing"),
    };
    await expect(invokeByName("x.ticketing.eventsOnSale", {}, guest)).resolves.toMatchObject({
      events: [],
    });
    await expect(invokeByName("x.content.categories", {}, guest)).resolves.toBeDefined();
  });

  it("a product that adds a pack in a later deploy gets it installed; the others are left as they are", async () => {
    expect(outcomes(await boot("bookings,content,programs,ticketing"))).toEqual({
      bookings: "unchanged",
      content: "unchanged",
      programs: "unchanged",
      ticketing: "unchanged",
    });
    // (Deals is in the release too, and this product now lists it.)
    expect(outcomes(await boot("bookings,content,deals,programs,ticketing")).deals).toBe(
      "installed",
    );
  });

  it("a product that drops a pack leaves it installed with its data; nothing is deleted", async () => {
    await boot("bookings,content,deals,programs,ticketing");
    const results = await boot("bookings,content,programs,ticketing");
    expect(results.map((r) => r.id)).not.toContain("deals");
    const row = await db.query
      .selectFrom("core_extensions")
      .select(["status", "source"])
      .where("id", "=", "deals")
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "active", source: "shipped" });
  });

  it('the release product\'s own catalogue ("*") keeps an optional pack for an admin to choose', async () => {
    // The CRM lists lifecycle, which is opt-in for it (ADR 0246).
    expect(outcomes(await boot("*")).lifecycle).toBe("available");
  });
});
