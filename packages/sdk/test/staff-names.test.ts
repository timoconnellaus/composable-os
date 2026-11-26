// Staff read names (stage 38 step 6, ADR 0708): what the contract checks of `staffNames`. Each
// is a single relation content field to another object of the same pack, and it needs
// `staffRead`: a staff reader, a pack role's included, is given the related record's title and
// nothing else of it, so a person, an organisation or another pack's record is never one.
import { describe, expect, it } from "vitest";
import { defineExtension, toManifest, validateManifest } from "../src/index.ts";

function pack(publishable: Record<string, unknown>, extraFields: Record<string, unknown> = {}) {
  return defineExtension({
    id: "manual",
    version: "1.0.0",
    contractVersion: 1,
    objects: {
      page: {
        label: "Page",
        plural: "Pages",
        titleField: "title",
        fields: {
          title: { type: "text", label: "Title" },
          slug: { type: "slug", label: "Address" },
          chapter: { type: "relation", label: "Chapter", to: "manual.chapter" },
          chapters: { type: "relation", label: "Chapters", to: "manual.chapter", many: true },
          contact: { type: "relation", label: "Contact", to: "person" },
          ...extraFields,
        },
        publishable: publishable as never,
      },
      chapter: {
        label: "Chapter",
        plural: "Chapters",
        titleField: "name",
        fields: { name: { type: "text", label: "Name" } },
      },
    },
  });
}

const issues = (publishable: Record<string, unknown>) =>
  validateManifest(toManifest(pack(publishable)))
    .issues.filter((i) => i.path.includes("staffNames"))
    .map((i) => i.message);

const base = {
  content: ["title", "chapter", "chapters", "contact"],
  slug: "slug",
  staffRead: true,
};

describe("publishable.staffNames (ADR 0708)", () => {
  it("names a single relation content field to another object of the pack", () => {
    expect(issues({ ...base, staffNames: ["chapter"] })).toEqual([]);
    expect(
      toManifest(pack({ ...base, staffNames: ["chapter"] })).objects.page?.publishable,
    ).toMatchObject({
      staffNames: ["chapter"],
    });
  });

  it("refuses it without staff read", () => {
    expect(issues({ ...base, staffRead: false, staffNames: ["chapter"] })).toEqual([
      "publishable.staffNames needs staffRead",
    ]);
  });

  it("refuses a field that is not a single relation in content, and a person", () => {
    expect(issues({ ...base, staffNames: ["chapters"] })).toEqual([
      '"chapters" must be a single relation field listed in content',
    ]);
    expect(issues({ ...base, content: ["title"], staffNames: ["chapter"] })).toEqual([
      '"chapter" must be a single relation field listed in content',
    ]);
    expect(issues({ ...base, staffNames: ["contact"] })).toEqual([
      '"contact" must relate to another object of this pack (manual.*)',
    ]);
  });
});
