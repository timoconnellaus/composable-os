// Stage 52 step 2: `sellable.finance` in the host (ADR 0792), against the box office fixture. The
// field registry carries every sellable object's kind of sale and how it is earned, with the
// defaults filled, so the finance reports read one answer; an installed extension adds or changes
// it by an ordinary upgrade.
import type { ExtensionManifest } from "@composable-os/sdk";
import { describe, expect, it } from "vitest";
import { getObject } from "../src/fields/index.ts";
import { extId, reconcile } from "./extension-helpers.ts";
import { boxOfficeManifest } from "./sellable-fixtures.ts";

function withFinance(m: ExtensionManifest, finance: Record<string, unknown>): ExtensionManifest {
  const ticketType = m.objects.tickettype;
  if (!ticketType?.sellable) throw new Error("the box office sells ticket types");
  return {
    ...m,
    version: "1.0.1",
    objects: {
      ...m.objects,
      tickettype: { ...ticketType, sellable: { ...ticketType.sellable, finance } },
    },
  };
}

describe("sellable.finance in the field registry", () => {
  it("left out, a sale is category other, earned at sale", async () => {
    const id = extId("fin");
    await reconcile(boxOfficeManifest(id));
    expect(getObject(`${id}.tickettype`)?.sellable?.finance).toEqual({
      category: { key: "other", label: "Other" },
      earned: "at_sale",
    });
  });

  it("an upgrade declares it, and the registry reads it with its path as declared", async () => {
    const id = extId("fin");
    const m = boxOfficeManifest(id);
    await reconcile(m);
    await reconcile(
      withFinance(m, {
        category: { key: "tickets", label: "Tickets" },
        earned: "at_date",
        at: "event.startsAt",
      }),
    );
    expect(getObject(`${id}.tickettype`)?.sellable?.finance).toEqual({
      category: { key: "tickets", label: "Tickets" },
      earned: "at_date",
      at: "event.startsAt",
    });
  });
});
