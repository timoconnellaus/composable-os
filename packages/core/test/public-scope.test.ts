// The public scope's declaration (stage 27, ADR 0438): what `check` refuses, and that a runtime
// extension may not declare one. What the public sees through it is the isolation suite's
// (isolation-suite.ts, public cases) and the Ticketing pack's (apps/runner/test/ticketing.test.ts).
import { validateManifest } from "@composable-os/sdk";
import { describe, expect, it } from "vitest";
import { checkManifest } from "../src/index.ts";
import { extId, manifest } from "./extension-helpers.ts";
import { db } from "./helpers.ts";

function shop(id: string, show: Record<string, unknown>, tier: Record<string, unknown> = {}) {
  return manifest(id, {
    objects: {
      show: {
        label: "Show",
        plural: "Shows",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          status: {
            type: "select",
            label: "Status",
            options: [
              { value: "draft", label: "Draft" },
              { value: "on_sale", label: "On sale" },
            ],
          },
          buyer: { type: "relation", label: "Buyer", to: "person" },
          venue: { type: "relation", label: "Venue", to: "organisation" },
        },
        ...show,
      },
      tier: {
        label: "Tier",
        plural: "Tiers",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          show: { type: "relation", label: "Show", to: `${id}.show` },
        },
        ...tier,
      },
    },
  } as never);
}

const issues = (m: ReturnType<typeof shop>) =>
  validateManifest(m).issues.map((issue) => `${issue.path}: ${issue.message}`);

describe("the public declaration (ADR 0438)", () => {
  it("accepts a state of its own, a state through one relation, and no condition", () => {
    const id = extId("pub");
    expect(
      issues(
        shop(
          id,
          { public: { read: ["name"], when: { field: "status", in: ["on_sale"] } } },
          {
            public: {
              read: ["name", "show"],
              when: { via: "show", field: "status", in: ["on_sale"] },
            },
          },
        ),
      ),
    ).toEqual([]);
    expect(issues(shop(id, { public: { read: ["name"] } }))).toEqual([]);
  });

  it("refuses unknown fields, a condition that is not a state, a bad relation and both scopes", () => {
    const id = extId("pub");
    const problems = (p: unknown, extra: Record<string, unknown> = {}) =>
      issues(shop(id, { public: p, ...extra }));
    expect(problems({ read: ["nope"] })).toEqual([
      'objects.show.public.read: public.read lists "nope", which is not a field of show',
    ]);
    expect(problems({ read: ["name"], when: { field: "name", in: ["x"] } })).toEqual([
      "objects.show.public.when.field: public.when.field must name a select field of show",
    ]);
    expect(problems({ read: ["name"], when: { field: "status", in: ["sold"] } })).toEqual([
      'objects.show.public.when.in: "sold" is not an option of show.status',
    ]);
    expect(
      problems({ read: ["name"], when: { via: "venue", field: "status", in: ["on_sale"] } }),
    ).toEqual([
      "objects.show.public.when.via: public.when.via must name a relation of show to one record of another of this extension's objects",
    ]);
    expect(
      problems({ read: ["name"] }, { customer: { field: "buyer", read: ["name"], write: [] } }),
    ).toContain("objects.show.public: An object declares customer or public, not both");
  });

  it("a runtime extension cannot declare one: what the public reads is a reviewed change", async () => {
    const id = extId("pub");
    const m = shop(id, { public: { read: ["name"], when: { field: "status", in: ["on_sale"] } } });
    const now = new Date().toISOString();
    const runtime = await checkManifest(db.query, id, m, now, { source: "runtime" });
    expect(runtime.plan).toBeNull();
    expect(runtime.issues).toContainEqual(
      expect.objectContaining({ code: "outside_audience", path: "objects.show.public" }),
    );
    const shipped = await checkManifest(db.query, id, m, now, { source: "shipped" });
    expect(shipped.issues).toEqual([]);
  });
});

describe("customerVia: what a customer reads through their own records (ADR 0439)", () => {
  function box(id: string, via: unknown, ticket: Record<string, unknown> = {}) {
    return manifest(id, {
      objects: {
        show: {
          label: "Show",
          plural: "Shows",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            notes: { type: "text", label: "Notes" },
          },
          customerVia: via,
        },
        ticket: {
          label: "Ticket",
          plural: "Tickets",
          titleField: "code",
          fields: {
            code: { type: "text", label: "Code", required: true },
            holder: { type: "relation", label: "Holder", to: "person" },
            show: { type: "relation", label: "Show", to: `${id}.show` },
          },
          customer: { field: "holder", read: ["code", "show"], write: [] },
          ...ticket,
        },
      },
    } as never);
  }
  const problems = (m: ReturnType<typeof box>) =>
    validateManifest(m).issues.map((issue) => `${issue.path}: ${issue.message}`);

  it("accepts a relation of a customer's own object, and refuses anything else", () => {
    const id = extId("via");
    const from = `${id}.ticket`;
    expect(problems(box(id, { from, field: "show", read: ["name"] }))).toEqual([]);
    expect(problems(box(id, { from, field: "show", read: ["nope"] }))).toEqual([
      'objects.show.customerVia.read: customerVia.read lists "nope", which is not a field of show',
    ]);
    expect(problems(box(id, { from: "other.ticket", field: "show", read: ["name"] }))).toEqual([
      `objects.show.customerVia.from: customerVia.from must name another of this extension's objects, as ${id}.<object>`,
    ]);
    expect(problems(box(id, { from, field: "code", read: ["name"] }))).toEqual([
      "objects.show.customerVia.field: customerVia.field must name a relation of ticket to one show",
    ]);
    // The customer must be able to see the pointer itself.
    expect(
      problems(
        box(
          id,
          { from, field: "show", read: ["name"] },
          { customer: { field: "holder", read: ["code"], write: [] } },
        ),
      ),
    ).toEqual([
      'objects.show.customerVia.field: customerVia.field "show" must be one ticket\'s customer may read (customer.read)',
    ]);
    expect(
      problems(box(id, { from, field: "show", read: ["name"] }, { customer: undefined })),
    ).toEqual([
      "objects.show.customerVia.from: customerVia.from must name an object that declares a customer",
    ]);
  });

  it("a runtime extension cannot declare it", async () => {
    const id = extId("via");
    const m = box(id, { from: `${id}.ticket`, field: "show", read: ["name"] });
    const now = new Date().toISOString();
    const runtime = await checkManifest(db.query, id, m, now, { source: "runtime" });
    expect(runtime.issues).toContainEqual(
      expect.objectContaining({ code: "outside_audience", path: "objects.show.customerVia" }),
    );
  });
});
