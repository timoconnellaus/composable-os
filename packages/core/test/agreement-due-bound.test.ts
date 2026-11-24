// agreement.due.list and agreement.healthReviews over many People (ADR 0642's one question): the
// acceptances, names and facts of a whole list are read in a fixed number of statements, each
// binding its ids as one parameter, not one read per Person and one variable per id.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invoke } from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, unique } from "./helpers.ts";
import { meterStatements } from "./statement-meter.ts";

const POINT = `pd${Date.now().toString(36)}`;
const PEOPLE = 150;
const body = (text: string) => ({
  blocks: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

let admin: ActingUser;
let documentId: string;
let people: string[];

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(
    manifest(extId("due"), {
      objects: {
        plan: {
          label: "Plan",
          plural: "Plans",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            price: { type: "currency", label: "Price", currency: "AUD" },
          },
          sellable: { price: "price" },
          agreements: { point: POINT, label: "Starting a plan" },
        },
      },
    }),
  );
  const { id } = await invoke(
    "agreement.create",
    { title: unique("Doc"), kind: "waiver" },
    context(admin),
  );
  documentId = id;
  const saved = await invoke(
    "agreement.draft.save",
    { id, body: body("Fixture text: not a real document."), tickLabel: "I have read this fixture" },
    context(admin),
  );
  await invoke(
    "agreement.publish",
    { documentId: id, draftHash: saved.hash, draftRev: saved.rev, number: 1, change: "small" },
    context(admin),
  );
  await invoke("agreement.attach", { documentId: id, points: [POINT] }, context(admin));
  // Marked minors are on the list; the marks are written straight in, as a fixture.
  people = [];
  for (let n = 0; n < PEOPLE; n += 1) {
    people.push(
      (await invoke("person.create", { givenName: unique("Minor") }, context(admin))).id as string,
    );
  }
  const now = new Date().toISOString();
  await env.DB.batch(
    people.map((personId) =>
      env.DB.prepare(
        "INSERT INTO core_agreement_minor (person_id, set_by, set_at) VALUES (?, ?, ?)",
      ).bind(personId, admin.id, now),
    ),
  );
}, 120_000);

describe("agreement.due.list over many People", () => {
  it("lists more People than one statement may bind one by one, in a fixed number of statements", async () => {
    const meter = meterStatements();
    const listed = await invoke(
      "agreement.due.list",
      { documentId, limit: 200 },
      context(admin, { db: meter.db }),
    );
    const due = new Set(listed.items.map((i) => i.personId));
    for (const personId of people) expect(due.has(personId)).toBe(true);
    expect(meter.bound.length).toBeLessThan(40);
    expect(Math.max(...meter.bound)).toBeLessThan(100);
  });
});
