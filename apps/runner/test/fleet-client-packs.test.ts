// A client of a host of many clients has exactly the packs it is given (review of #553): its
// environment's COS_PACKS is its registry setting, or "" with none (packages/db
// `CLIENT_SETTINGS`, `blank`), never the deployment's "*", which would install the product's
// non-optional packs (Deals, Leads, Ticketing on the hosted product) at boot. The list and the
// install are the real code, on a fresh database.
import { type ExtensionHost, installShippedExtensions } from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { shippedExtensions } from "../src/extensions/shipped-list.ts";
import { createAdmin, db, host } from "./helpers.ts";

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
const shipped = () =>
  db.query
    .selectFrom("core_extensions")
    .select("id")
    .where("source", "=", "shipped")
    .execute()
    .then((rows) => rows.map((r) => r.id).sort());

beforeAll(async () => {
  await createAdmin();
});

describe("a fleet client's packs", () => {
  it("are none with no setting (an empty COS_PACKS): nothing installed, nothing offered", async () => {
    expect(await boot("")).toEqual([]);
    expect(await shipped()).toEqual([]);
  });

  it("are exactly the ones given: COS_PACKS=ticketing installs Ticketing and nothing else", async () => {
    const results = await boot("ticketing");
    expect(results.map((r) => [r.id, r.outcome])).toEqual([["ticketing", "installed"]]);
    expect(await shipped()).toEqual(["ticketing"]);
  });
});
