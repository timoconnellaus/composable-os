// Staff read names (stage 38 step 6, ADR 0708): what the contract checks of `staffNames`. Each
// is a single relation content field to another object of the same pack, it needs `staffRead`,
// and the related object has no row rules of its own (not publishable, no customer, customerVia
// or access) and a plain text title: a staff reader, a pack role's included, is given the related
// record's id, title and declared order as it is on the record, so nothing a row rule or a draft
// keeps from them can be one. The host checks the same at install (core's checkManifest runs
// this) and again when it reads (`namedTarget` in visibility/staff-read.ts).
import { describe, expect, it } from "vitest";
import { defineExtension, toManifest, validateManifest } from "../src/index.ts";

const chapterFields = {
  name: { type: "text", label: "Name" },
  email: { type: "email", label: "Email" },
  order: { type: "number", label: "Order" },
  note: { type: "text", label: "Note" },
  reader: { type: "relation", label: "Reader", to: "person" },
};

function pack(publishable: Record<string, unknown>, chapter: Record<string, unknown> = {}) {
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
        },
        publishable: publishable as never,
      },
      chapter: {
        label: "Chapter",
        plural: "Chapters",
        titleField: "name",
        fields: chapterFields as never,
        ...chapter,
      },
    },
  });
}

const issues = (publishable: Record<string, unknown>, chapter: Record<string, unknown> = {}) =>
  validateManifest(toManifest(pack(publishable, chapter)))
    .issues.filter((i) => i.path.includes("staffNames"))
    .map((i) => i.message);

const base = {
  content: ["title", "chapter", "chapters", "contact"],
  slug: "slug",
  staffRead: true,
};
const names = { ...base, staffNames: ["chapter"] };

describe("publishable.staffNames (ADR 0708)", () => {
  it("names a single relation content field to a plain object of the pack, with an order", () => {
    expect(issues(names)).toEqual([]);
    expect(issues({ ...base, staffNames: [{ field: "chapter", order: "order" }] })).toEqual([]);
    expect(
      toManifest(pack({ ...base, staffNames: [{ field: "chapter", order: "order" }] })).objects.page
        ?.publishable,
    ).toMatchObject({ staffNames: [{ field: "chapter", order: "order" }] });
  });

  it("refuses it without staff read", () => {
    expect(issues({ ...names, staffRead: false })).toEqual([
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

  it("refuses a related object with versions: its title could be an unpublished draft's", () => {
    expect(issues(names, { publishable: { content: ["name", "note"] } })).toEqual([
      '"chapter" relates to manual.chapter, which declares publishable: staffNames names only an object with no row rules of its own',
    ]);
  });

  it("refuses a related object a customer, a customer's record or an access source owns", () => {
    expect(issues(names, { customer: { field: "reader", read: ["name"], write: [] } })).toEqual([
      '"chapter" relates to manual.chapter, which declares customer: staffNames names only an object with no row rules of its own',
    ]);
    expect(
      issues(names, { customerVia: { from: "manual.page", field: "chapter", read: ["name"] } }),
    ).toEqual([
      '"chapter" relates to manual.chapter, which declares customerVia: staffNames names only an object with no row rules of its own',
    ]);
    expect(issues(names, { access: { sources: [{ kind: "subscription" }] } })).toEqual([
      '"chapter" relates to manual.chapter, which declares access: staffNames names only an object with no row rules of its own',
    ]);
  });

  it("refuses a title that is not plain text, and an order that is not a number", () => {
    expect(issues(names, { titleField: "email" })).toEqual([
      '"chapter" relates to manual.chapter, whose title field is not plain text',
    ]);
    expect(issues({ ...base, staffNames: [{ field: "chapter", order: "note" }] })).toEqual([
      '"chapter" orders by "note", which is not a number field of manual.chapter',
    ]);
  });
});
