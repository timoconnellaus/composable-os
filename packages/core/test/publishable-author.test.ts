// Stage 54, step 1 (ADR 0810): publishable with an author. A review is its author's record (its
// customer) and published content the public reads: the author reads and writes their working
// copy through the seam; the public reads only the published version, listed and never by an
// address; the author's fields are refused to staff and every AI on every path; and a review is
// published only in the states its object lists, and unpublished in the batch that moves it out.
import { env } from "cloudflare:workers";
import { validateManifest } from "@composable-os/sdk";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type CustomerPrincipal,
  getObject,
  invoke,
  publicProblems,
  runPublishDue,
  setContentCacheStore,
} from "../src/index.ts";
import { call, outside, PUBLIC } from "./customer-fixtures.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";

const EXT = extId("rv");
const REVIEW = `${EXT}.review`;
let admin: ActingUser;
let author: CustomerPrincipal;
let other: CustomerPrincipal;

const AUTHOR_FIELDS = ["rating", "words", "shownName"];

const REVIEW_OBJECT = {
  label: "Review",
  plural: "Reviews",
  titleField: "shownName",
  fields: {
    person: { type: "relation", label: "Person", to: "person" },
    rating: { type: "number", label: "Rating", min: 1, max: 5 },
    words: { type: "text", label: "Words" },
    shownName: { type: "text", label: "Name shown" },
    about: { type: "text", label: "About", readOnly: true },
    date: { type: "datetime", label: "Date" },
    staffNote: { type: "text", label: "Staff note" },
    state: {
      type: "select",
      label: "State",
      options: [
        { value: "private", label: "Private" },
        { value: "consented", label: "Consented" },
        { value: "withdrawn", label: "Withdrawn" },
      ],
    },
  },
  states: {
    field: "state",
    initial: "private",
    moves: [
      { from: "private", to: "consented", by: ["customer"] },
      { from: "consented", to: "private", by: ["customer"] },
      { from: ["private", "consented"], to: "withdrawn", by: ["customer", "staff"], final: true },
    ],
  },
  customer: {
    field: "person",
    read: ["rating", "words", "shownName", "about", "state", "date"],
    write: ["rating", "words", "shownName", "state"],
  },
  publishable: {
    content: ["rating", "words", "shownName", "about", "date"],
    date: "date",
    publishIn: ["consented"],
  },
  public: {
    read: ["rating", "words", "shownName", "about", "date", "publishedAt"],
    when: { field: "state", in: ["consented"] },
  },
};

async function createCustomer(label: string): Promise<CustomerPrincipal> {
  const tag = unique(label);
  const person = await invoke(
    "person.create",
    { givenName: tag, emails: [{ email: `${tag}@reviews.example` }] },
    context(admin),
  );
  return { kind: "customer", customerId: `cus_${tag}`, personId: person.id };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a refusal");
}

/** The author writes a review through a customer's tool, as stage 29's door will. */
async function write({ state, ...values }: Record<string, unknown>, as = author) {
  const made = await call("fixture.myCreate", { object: REVIEW, values }, outside(as));
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  const { id } = made.value as { id: string };
  // A review starts private; the author consents.
  if (state) await authorUpdate(id, { state }, as);
  return id;
}
const authorUpdate = (id: string, values: Record<string, unknown>, as = author) =>
  call("fixture.myUpdate", { object: REVIEW, id, values }, outside(as));
const staffUpdate = (id: string, values: Record<string, unknown>, ctx = context(admin)) =>
  invoke("record.update", { object: REVIEW, id, values }, ctx);
const publish = (id: string) => invoke("record.publish", { object: REVIEW, id }, context(admin));
const list = () => call("content.list", { object: REVIEW }, outside(PUBLIC));
const listed = async () =>
  ((await list()) as { value: { items: { id: string; values: Record<string, unknown> }[] } }).value
    .items;

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(manifest(EXT, { objects: { review: REVIEW_OBJECT } } as never));
  author = await createCustomer("author");
  other = await createCustomer("other");
}, 60_000);

beforeEach(() => {
  setContentCacheStore(null);
});

describe("the declaration", () => {
  const issues = (change: (review: Record<string, unknown>) => void) => {
    const review = structuredClone(REVIEW_OBJECT) as Record<string, unknown>;
    change(review);
    return validateManifest(manifest(extId("bad"), { objects: { review } } as never)).issues.map(
      (i) => i.message,
    );
  };

  it("accepts a customer, public and no slug on a publishable object, with a read-only content field", () => {
    expect(issues(() => {})).toEqual([]);
    expect(getObject(REVIEW)?.publishable).toEqual({
      content: ["rating", "words", "shownName", "about", "date"],
      date: "date",
      publishIn: ["consented"],
    });
    const review = getObject(REVIEW);
    if (!review) throw new Error("no review");
    expect(publicProblems(review)).toEqual([]);
  });

  it("refuses a slug, the author in the public's fields, customerVia and states it does not have", () => {
    expect(
      issues((r) => {
        (r.fields as Record<string, unknown>).slug = { type: "slug", label: "Slug" };
        (r.publishable as Record<string, unknown>).slug = "slug";
        (r.public as { read: string[] }).read.push("slug", "person");
        (r.publishable as Record<string, unknown>).publishIn = ["consented", "approved"];
      }),
    ).toEqual(
      expect.arrayContaining([
        "A publishable object with an author (customer) has no slug: its records are listed, not addressed",
        'public.read lists "person", the author: the public never reads whose it is',
        '"approved" is not a state of review (state)',
      ]),
    );
    expect(
      issues((r) => {
        delete r.states;
      }),
    ).toContain("publishable.publishIn names states: declare states first");
    // Without an author, a read-only field is still not content, and customer or public stays one.
    expect(
      issues((r) => {
        delete r.customer;
      }),
    ).toContain('"about" is read-only: content is what staff edit');
    const review = getObject(REVIEW);
    if (!review?.public || !review.customer) throw new Error("no review");
    expect(
      publicProblems({ ...review, public: { ...review.public, read: ["rating", "person"] } }),
    ).toEqual(['public.read lists "person", the author']);
    expect(
      publicProblems({
        ...review,
        publishable: { ...review.publishable, content: ["rating"] },
        customerVia: { from: REVIEW, field: "person", read: ["rating"] },
      }),
    ).toContain("a publishable object the public reads declares no customerVia");
  });

  it("tells staff and the assistant the author's fields are read-only", async () => {
    const { objects } = await invoke("schema.objects", {}, context(admin));
    const review = (
      objects as { name: string; fields: { name: string; readOnly: boolean }[] }[]
    ).find((o) => o.name === REVIEW);
    const readOnly = review?.fields.filter((f) => f.readOnly).map((f) => f.name);
    expect(readOnly).toEqual(expect.arrayContaining([...AUTHOR_FIELDS, "about"]));
    expect(readOnly).not.toContain("state");
    expect(readOnly).not.toContain("staffNote");
  });
});

describe("the author's fields are the author's alone", () => {
  it("the author writes and reads their own working copy; another customer finds nothing", async () => {
    const id = await write({ rating: 5, words: "Great classes", shownName: "Sam" });
    expect(await call("fixture.myGet", { object: REVIEW, id }, outside(author))).toMatchObject({
      ok: true,
      value: { values: { rating: 5, words: "Great classes", shownName: "Sam", state: "private" } },
    });
    expect(await authorUpdate(id, { shownName: "Sam L.", state: "consented" })).toMatchObject({
      ok: true,
      value: { values: { shownName: "Sam L.", state: "consented" } },
    });
    expect(await call("fixture.myGet", { object: REVIEW, id }, outside(other))).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await authorUpdate(id, { words: "Mine now" }, other)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("staff are refused every author's field, by update, create, import and a restored version", async () => {
    const id = await write({ rating: 4, words: "Good", shownName: "Ana", state: "consented" });
    for (const field of AUTHOR_FIELDS) {
      const refused = await refusal(staffUpdate(id, { [field]: field === "rating" ? 1 : "x" }));
      expect(refused).toMatchObject({
        code: "forbidden",
        details: { field, reason: "author_only" },
      });
    }
    expect(
      await refusal(
        invoke(
          "record.create",
          { object: REVIEW, values: { person: author.personId, rating: 5, words: "Made up" } },
          context(admin),
        ),
      ),
    ).toMatchObject({ code: "forbidden", details: { reason: "author_only" } });
    expect(
      await refusal(
        invoke(
          "record.import",
          { object: REVIEW, records: [{ key: "old-1", values: { rating: 5, words: "Imported" } }] },
          context(admin),
        ),
      ),
    ).toMatchObject({ code: "forbidden", details: { reason: "author_only" } });
    // A version copied back into the working copy is a staff write of the author's fields.
    await publish(id);
    await authorUpdate(id, { words: "Good, changed" });
    expect(
      await refusal(
        invoke("record.restoreVersion", { object: REVIEW, id, version: 1 }, context(admin)),
      ),
    ).toMatchObject({ code: "forbidden", details: { reason: "author_only" } });
    // What is not the author's stays staff's: a note, and moving its state.
    await staffUpdate(id, { staffNote: "Checked" });
    const after = await call("fixture.myGet", { object: REVIEW, id }, outside(author));
    expect(after).toMatchObject({ value: { values: { words: "Good, changed", rating: 4 } } });
  });

  it("an assistant and an MCP client are refused them, whatever the approval policy", async () => {
    const id = await write({ rating: 3, words: "Fine", shownName: "Kim" });
    for (const actor of ["assistant", "mcp"] as const) {
      expect(
        await refusal(staffUpdate(id, { words: "Better words" }, context(admin, { actor }))),
      ).toMatchObject({ code: "forbidden", details: { field: "words", reason: "author_only" } });
    }
    const { results } = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_pending_action WHERE operation = 'record.update' AND input LIKE ?",
    )
      .bind(`%${id}%`)
      .all<{ n: number }>();
    expect(results[0]?.n).toBe(0);
  });
});

describe("published only in the listed states, listed only", () => {
  it("a private review cannot be published; a consented one can, and the public lists only its version", async () => {
    const id = await write({ rating: 5, words: "Loved it", shownName: "Jo" });
    expect(await refusal(publish(id))).toMatchObject({
      code: "invalid_input",
      details: { reason: "not_publishable_state", states: ["consented"] },
    });
    expect(
      await refusal(
        invoke(
          "record.schedulePublish",
          { object: REVIEW, id, at: new Date(Date.now() + 3_600_000).toISOString() },
          context(admin),
        ),
      ),
    ).toMatchObject({ details: { reason: "not_publishable_state" } });
    await authorUpdate(id, { state: "consented" });
    expect((await listed()).some((r) => r.id === id)).toBe(false);
    await publish(id);
    const shown = (await listed()).find((r) => r.id === id);
    expect(Object.keys(shown?.values ?? {}).sort()).toEqual(
      ["about", "date", "publishedAt", "rating", "shownName", "words"].sort(),
    );
    expect(shown?.values).toMatchObject({ rating: 5, words: "Loved it", shownName: "Jo" });
    // A changed shown name waits for a person to publish again.
    await authorUpdate(id, { shownName: "Jo B." });
    expect((await listed()).find((r) => r.id === id)?.values.shownName).toBe("Jo");
    // No address: read by one, it is not found, as anything else is.
    for (const slug of ["jo", id]) {
      expect(await call("content.get", { object: REVIEW, slug }, outside(PUBLIC))).toEqual({
        ok: false,
        error: { code: "not_found", message: "Not found", details: { object: REVIEW } },
      });
    }
  });

  it("consent withdrawn takes it off at once; withdrawal unpublishes it in the same batch", async () => {
    const id = await write({ rating: 4, words: "Nice", shownName: "Lee", state: "consented" });
    await publish(id);
    expect((await listed()).some((r) => r.id === id)).toBe(true);
    // Back to private: unpublished, so consenting again waits for a person's publish.
    await authorUpdate(id, { state: "private" });
    expect((await listed()).some((r) => r.id === id)).toBe(false);
    await authorUpdate(id, { state: "consented" });
    expect((await listed()).some((r) => r.id === id)).toBe(false);
    await publish(id);
    expect((await listed()).some((r) => r.id === id)).toBe(true);

    const versions = async () =>
      env.DB.prepare(
        "SELECT version, current FROM core_publish_version WHERE object_type = ? AND record_id = ? ORDER BY version",
      )
        .bind(REVIEW, id)
        .all<{ version: number; current: number }>();
    await authorUpdate(id, { state: "withdrawn" });
    expect((await listed()).some((r) => r.id === id)).toBe(false);
    // The versions are kept, none current.
    expect((await versions()).results).toEqual([
      { version: 1, current: 0 },
      { version: 2, current: 0 },
    ]);
  });

  it("staff recording a withdrawal unpublish it too, and a schedule of a review moved out is dropped", async () => {
    const id = await write({ rating: 5, words: "Top", shownName: "Ray", state: "consented" });
    await publish(id);
    await staffUpdate(id, { state: "withdrawn" });
    expect((await listed()).some((r) => r.id === id)).toBe(false);

    const later = await write({ rating: 5, words: "Soon", shownName: "Max", state: "consented" });
    const at = new Date(Date.now() + 60_000);
    await invoke(
      "record.schedulePublish",
      { object: REVIEW, id: later, at: at.toISOString() },
      context(admin),
    );
    await authorUpdate(later, { state: "private" });
    // Moving out dropped the schedule; a schedule made behind its back is dropped when due.
    await env.DB.prepare(
      "INSERT INTO core_publish_schedule (object_type, record_id, publish_at, content, bytes, note, scheduled_by, scheduled_at) VALUES (?, ?, ?, '{}', 2, NULL, ?, ?)",
    )
      .bind(REVIEW, later, at.toISOString(), admin.id, new Date().toISOString())
      .run();
    const due = await runPublishDue(db, { clock: () => new Date(at.getTime() + 1000) });
    expect(due).toMatchObject({ published: 0 });
    expect((await listed()).some((r) => r.id === later)).toBe(false);
  });
});

describe("what anyone else reads (the seam)", () => {
  it("nothing but the published version's declared fields reaches another customer or the public", async () => {
    const tag = unique("secret");
    const live = await write({
      rating: 5,
      words: `LiveWords-${tag}`,
      shownName: `LiveName-${tag}`,
      state: "consented",
    });
    await publish(live);
    await staffUpdate(live, { staffNote: `StaffNote-${tag}` });
    await authorUpdate(live, { shownName: `DraftName-${tag}` });
    const hidden = await write({ rating: 1, words: `PrivateWords-${tag}`, shownName: "P" });
    const secrets = [
      `StaffNote-${tag}`,
      `DraftName-${tag}`,
      `PrivateWords-${tag}`,
      author.personId,
    ];
    const answers: unknown[] = [];
    for (const caller of [other, PUBLIC]) {
      answers.push(
        await call("content.list", { object: REVIEW }, outside(caller)),
        await call(
          "content.list",
          { object: REVIEW, filter: { field: "staffNote", op: "eq", value: `StaffNote-${tag}` } },
          outside(caller),
        ),
        await call(
          "content.list",
          { object: REVIEW, filter: { field: "person", op: "eq", value: author.personId } },
          outside(caller),
        ),
        await call("content.get", { object: REVIEW, slug: hidden }, outside(caller)),
      );
    }
    answers.push(
      await call("fixture.myList", { object: REVIEW }, outside(other)),
      await call("fixture.myGet", { object: REVIEW, id: live }, outside(other)),
    );
    const text = JSON.stringify(answers);
    // Another customer asking for the private one by its id is told what a made-up id is told.
    const guessed = "rec_01M00000000000000000000000";
    expect(
      JSON.stringify(await call("fixture.myGet", { object: REVIEW, id: hidden }, outside(other))),
    ).toBe(
      JSON.stringify(
        await call("fixture.myGet", { object: REVIEW, id: guessed }, outside(other)),
      ).replaceAll(guessed, hidden),
    );
    for (const secret of secrets) expect(text).not.toContain(secret);
    // The published one is there, as approved.
    expect(text).toContain(`LiveName-${tag}`);
    expect(text).toContain(`LiveWords-${tag}`);
  });
});
