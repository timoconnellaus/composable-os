// What the public reads when several conditions hold, and through a public record (ADR 0689): a
// read declaration's `when` may be a list of up to three conditions that all hold, and a
// condition may be `via` alone: the record that relation points to is one the public reads
// (published, if its object is publishable, and meeting its own `when`). A shop's variant is
// public while it is active and its item is published; a draft's variant and a retired one are
// not found, for the public and a signed-in customer alike, and so cannot be bought.
import { validateManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, getVisible, listVisible } from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";
import { CURRENCY, PUBLIC, refusal, run } from "./order-fixtures.ts";

const select = (...values: string[]) => ({
  type: "select" as const,
  label: "State",
  options: values.map((value) => ({ value, label: value })),
});

function shop(
  id: string,
  variant: Record<string, unknown> = {},
  item: Record<string, unknown> = {},
) {
  return manifest(id, {
    objects: {
      item: {
        label: "Item",
        plural: "Items",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          slug: { type: "slug", label: "Address" },
          range: select("core", "seasonal"),
        },
        publishable: { content: ["name"], slug: "slug" },
        public: { read: ["name", "slug", "range"] },
        ...item,
      },
      variant: {
        label: "Variant",
        plural: "Variants",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          item: { type: "relation", label: "Item", to: `${id}.item` },
          price: { type: "currency", label: "Price", currency: CURRENCY },
          state: select("active", "retired"),
        },
        public: {
          read: ["name", "item", "price"],
          when: [{ field: "state", in: ["active"] }, { via: "item" }],
        },
        ...variant,
      },
    },
  } as never);
}

const issues = (m: ReturnType<typeof shop>) =>
  validateManifest(m).issues.map((issue) => `${issue.path}: ${issue.message}`);

describe("the declaration (ADR 0689)", () => {
  it("takes a list of conditions and via alone", () => {
    expect(issues(shop(extId("all")))).toEqual([]);
    // One condition still reads as before.
    expect(
      issues(shop(extId("all"), { public: { read: ["name"], when: { via: "item" } } })),
    ).toEqual([]);
  });

  it("refuses via alone where the record pointed to is not public, chains, and halves of a condition", () => {
    const id = extId("all");
    expect(issues(shop(id, {}, { public: undefined }))).toEqual([
      "objects.variant.public.when.1.via: item declares no public: via alone means its record is one the public reads",
    ]);
    expect(
      issues(
        shop(id, {
          public: { read: ["name"], when: [{ field: "state" }] },
        }),
      ),
    ).toEqual([
      "objects.variant.public.when.0: public.when names a field and its values (in) together",
    ]);
    expect(issues(shop(id, { public: { read: ["name"], when: [{ in: ["active"] }] } }))).toContain(
      "objects.variant.public.when.0: public.when names a field and its values (in) together",
    );
    expect(
      issues(shop(id, { public: undefined, signedIn: { read: ["name"], when: { via: "item" } } })),
    ).toEqual([
      "objects.variant.signedIn.when.via: via alone is the public's: it reads the record it points to as the public does",
    ]);
    // A chain: the item's own condition is via alone.
    const chained = manifest(id, {
      objects: {
        brand: {
          label: "Brand",
          plural: "Brands",
          titleField: "name",
          fields: { name: { type: "text", label: "Name", required: true } },
          public: { read: ["name"] },
        },
        item: {
          label: "Item",
          plural: "Items",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            brand: { type: "relation", label: "Brand", to: `${id}.brand` },
          },
          public: { read: ["name"], when: { via: "brand" } },
        },
        variant: {
          label: "Variant",
          plural: "Variants",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            item: { type: "relation", label: "Item", to: `${id}.item` },
          },
          public: { read: ["name"], when: { via: "item" } },
        },
      },
    } as never);
    expect(validateManifest(chained).issues.map((i) => `${i.path}: ${i.message}`)).toEqual([
      "objects.variant.public.when.via: item's own public.when uses via alone: one step only, no chains",
    ]);
    // At most three conditions.
    const four = [1, 2, 3, 4].map(() => ({ field: "state", in: ["active"] }));
    expect(() => shop(id, { public: { read: ["name"], when: four } })).toThrow(/<=3 items/);
  });
});

describe("what the seam shows (ADR 0689)", () => {
  const ext = extId("all");
  const ITEM = `${ext}.item`;
  const VARIANT = `${ext}.variant`;
  let admin: ActingUser;

  const create = async (object: string, values: Record<string, unknown>) =>
    (await run<{ id: string }>("record.create", { object, values }, context(admin))).id;

  beforeAll(async () => {
    admin = await createUser("admin");
    await reconcile(
      shop(
        ext,
        {},
        { public: { read: ["name", "slug", "range"], when: { field: "range", in: ["core"] } } },
      ),
    );
  });

  it("an active variant of a published item that meets its own when; nothing else", async () => {
    const item = async (range: string, publish: boolean) => {
      const id = await create(ITEM, { name: unique("Item"), range });
      if (publish) await run("record.publish", { object: ITEM, id }, context(admin));
      return id;
    };
    const published = await item("core", true);
    const draft = await item("core", false);
    const seasonal = await item("seasonal", true);
    const shown = await create(VARIANT, { name: unique("V"), item: published, state: "active" });
    const retired = await create(VARIANT, { name: unique("V"), item: published, state: "retired" });
    const ofDraft = await create(VARIANT, { name: unique("V"), item: draft, state: "active" });
    const ofSeasonal = await create(VARIANT, {
      name: unique("V"),
      item: seasonal,
      state: "active",
    });

    const reader = { principal: PUBLIC, db: db.query };
    const ids = (await listVisible(reader, VARIANT, { limit: 100 })).items.map((r) => r.id);
    expect(ids).toEqual([shown]);
    for (const id of [retired, ofDraft, ofSeasonal]) {
      expect(await refusal(getVisible(reader, VARIANT, id))).toMatchObject({ code: "not_found" });
    }
    // The variant follows its item: published, its variant is shown; unpublished, it goes.
    await run("record.publish", { object: ITEM, id: draft }, context(admin));
    await getVisible(reader, VARIANT, ofDraft);
    await run("record.unpublish", { object: ITEM, id: draft }, context(admin));
    expect(await refusal(getVisible(reader, VARIANT, ofDraft))).toMatchObject({
      code: "not_found",
    });
    // Staff see every one.
    const all = await run<{ items: { id: string }[] }>(
      "record.list",
      { object: VARIANT, limit: 100 },
      context(admin),
    );
    expect(all.items.map((r) => r.id).sort()).toEqual([shown, retired, ofDraft, ofSeasonal].sort());
  });
});
