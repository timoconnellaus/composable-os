// Stage 42, step 3 (ADR 0477): the access scope. Whether a customer holds access to a record is
// one question the seam asks (`holdsAccess`), answered from the object's declared sources: an
// enrolment pointing at the course, or at a bundle that lists it. The document's `holders` parts
// are read only by a holder, and media.play gives a holder's video only to a holder, from the
// same answer. A third kind of source, declared here only, is honoured with no change to the seam
// (criterion 6). The stage 22 isolation suite covers the same callers directly and over HTTP
// (isolation-suite.ts).

import { env } from "cloudflare:workers";
import {
  type DocumentSchema,
  documentMediaReach,
  redactDocument,
  validateManifest,
} from "@composable-os/sdk";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  getObject,
  holdsAccess,
  invoke,
  registerAccessSource,
  setVideoHost,
  unregisterAccessSource,
} from "../src/index.ts";
import {
  ACCESS_EXT,
  type AccessWorld,
  BUNDLE,
  COURSE,
  createAccessWorld,
  ENROLMENT,
  fakeStream,
  member,
  outline,
  readyVideo,
} from "./access-fixtures.ts";
import { call, outside, PUBLIC } from "./customer-fixtures.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";

let admin: ActingUser;
let world: AccessWorld;

type Lesson = {
  key: string;
  title: string;
  preview?: boolean;
  video?: { media: string };
  notes?: string;
};
const lessonsOf = (outcome: Awaited<ReturnType<typeof call>>) =>
  outcome.ok
    ? ((outcome.value as { values: { outline: { lessons: Lesson[] } } }).values.outline.lessons ??
      [])
    : null;

const NOT_FOUND = {
  ok: false,
  error: { code: "not_found", message: "Not found", details: { object: "media" } },
};

beforeAll(async () => {
  fakeStream();
  admin = await createUser("admin");
  world = await createAccessWorld(admin);
});

afterAll(() => setVideoHost(undefined));

describe("the holders' flag on a document (ADR 0477)", () => {
  const schema = {
    root: {
      type: "object",
      fields: {
        lessons: {
          type: "array",
          max: 5,
          of: {
            type: "object",
            fields: {
              title: { type: "text" },
              preview: { type: "boolean", optional: true },
              video: { type: "ref", to: "media", optional: true },
            },
            holders: { keys: ["video"], unless: "preview" },
          },
        },
        extra: {
          type: "object",
          optional: true,
          holders: true,
          fields: { media: { type: "ref", to: "media" } },
        },
        hidden: {
          type: "object",
          optional: true,
          private: true,
          fields: { media: { type: "ref", to: "media" } },
        },
      },
    },
  } as unknown as DocumentSchema;
  const value = {
    lessons: [
      { title: "Free", preview: true, video: "med_free" },
      { title: "Paid", video: "med_paid" },
    ],
    extra: { media: "med_extra" },
    hidden: { media: "med_hidden" },
  };

  it("removes holders' parts for a reader without access, keeps them for a holder, and private parts for both", () => {
    expect(redactDocument(schema, value)).toEqual({
      lessons: [{ title: "Free", preview: true, video: "med_free" }, { title: "Paid" }],
    });
    expect(redactDocument(schema, value, { holder: true })).toEqual({
      lessons: value.lessons,
      extra: { media: "med_extra" },
    });
  });

  it("says who outside the org reads each media item it names", () => {
    expect(Object.fromEntries(documentMediaReach(schema, value))).toEqual({
      med_free: "all",
      med_paid: "holders",
      med_extra: "holders",
      med_hidden: "private",
    });
  });

  it("is checked: keys of the object, a boolean unless, and no column through it", () => {
    const bad = (holders: unknown, paths?: Record<string, unknown>) =>
      validateManifest(
        manifest("chk", {
          objects: {
            thing: {
              label: "Thing",
              plural: "Things",
              titleField: "name",
              fields: {
                name: { type: "text", label: "Name", required: true },
                doc: {
                  type: "document",
                  label: "Doc",
                  schema: {
                    root: {
                      type: "object",
                      fields: { a: { type: "text" }, flag: { type: "boolean" } },
                      holders,
                    },
                  },
                  ...(paths ? { paths } : {}),
                },
              },
            },
          },
        }),
      ).issues.map((i) => i.message);
    expect(bad({ keys: ["nope"] })).toEqual(
      expect.arrayContaining([expect.stringContaining("holders is")]),
    );
    expect(bad({ keys: ["a"], unless: "a" })).toEqual(
      expect.arrayContaining([expect.stringContaining("holders is")]),
    );
    expect(bad({ keys: ["a"], unless: "flag" })).toEqual([]);
    expect(bad({ keys: ["a"] }, { a: { label: "A", path: "a" } })).toEqual(
      expect.arrayContaining([expect.stringContaining("holders only")]),
    );
  });
});

describe("the access declaration is checked (ADR 0477)", () => {
  const withAccess = (source: Record<string, unknown>, grants = false) => {
    const m = manifest("acc", {
      objects: {
        course: {
          label: "Course",
          plural: "Courses",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            price: { type: "currency", label: "Price" },
          },
          access: { sources: [source] },
          ...(grants
            ? {
                sellable: {
                  price: "price",
                  grants: { object: "acc.enrolment", void: "void", set: {} },
                },
              }
            : {}),
        },
        enrolment: {
          label: "Enrolment",
          plural: "Enrolments",
          titleField: "code",
          fields: {
            code: { type: "text", label: "Code", required: true },
            holder: { type: "relation", label: "Holder", to: "person" },
            course: { type: "relation", label: "Course", to: "acc.course" },
            starts: { type: "text", label: "Starts" },
            status: {
              type: "select",
              label: "Status",
              options: [
                { value: "active", label: "Active" },
                { value: "void", label: "Void" },
              ],
            },
          },
          states: {
            field: "status",
            initial: "active",
            moves: [{ from: "active", to: "void", by: ["host"], final: true }],
          },
          customer: { field: "holder", read: ["code", "course"], write: [] },
        },
      },
    });
    return validateManifest(m).issues.map((i) => `${i.path}: ${i.message}`);
  };

  it("names its own objects, a customer's records, the states that give access and never the void one", () => {
    expect(withAccess({ via: "acc.enrolment", field: "course", states: ["active"] })).toEqual([]);
    expect(withAccess({ via: "acc.enrolment", field: "course" }).join()).toContain("name the ones");
    // A refund in full moves a grant to its void state (ADR 0435): it can give no access.
    expect(
      withAccess(
        { via: "acc.enrolment", field: "course", states: ["active", "void"] },
        true,
      ).join(),
    ).toContain("where a refund moves");
    expect(
      withAccess({ via: "acc.enrolment", field: "course", states: ["gone"] }).join(),
    ).toContain("not a state");
    expect(
      withAccess({ via: "acc.enrolment", field: "code", states: ["active"] }).join(),
    ).toContain("relation");
    expect(withAccess({ via: "acc.course", field: "course", states: ["active"] }).join()).toContain(
      "via",
    );
    expect(
      withAccess({
        via: "acc.enrolment",
        field: "course",
        states: ["active"],
        until: "starts",
      }).join(),
    ).toContain("date or datetime");
  });
});

describe("holders read the holders' parts; no one else does (criteria 4, 5 and 7)", () => {
  const read = (who: Parameters<typeof outside>[0], id = world.course) =>
    call("my.get", { object: COURSE, id }, outside(who));

  it("a holder reads the lesson's video and notes; never the private note", async () => {
    const lessons = lessonsOf(await read(world.holder));
    expect(lessons?.[1]).toEqual({
      key: "one",
      title: "Lesson one",
      video: { media: world.lessonVideo },
      notes: "Holders-only-notes",
    });
    expect(JSON.stringify(await read(world.holder))).not.toContain("Staff-only-note");
  });

  it("a customer without access reads the titles and the free preview, and no holders' part", async () => {
    for (const who of [world.stranger, world.voided, world.lapsed, world.bundleHolder]) {
      const outcome = await read(who);
      const lessons = lessonsOf(outcome);
      expect(lessons?.[0]).toMatchObject({ key: "intro", video: { media: world.previewVideo } });
      expect(lessons?.[1]).toEqual({ key: "one", title: "Lesson one" });
      const text = JSON.stringify(outcome);
      expect(text).not.toContain("Holders-only-notes");
      expect(text).not.toContain(world.lessonVideo);
    }
  });

  it("the public reads the course as a stranger does", async () => {
    const outcome = await call(
      "content.get",
      { object: COURSE, slug: "handstands" },
      outside(PUBLIC),
    );
    const text = JSON.stringify(outcome);
    expect(outcome.ok).toBe(true);
    expect(text).toContain("Lesson one");
    expect(text).not.toContain("Holders-only-notes");
    expect(text).not.toContain(world.lessonVideo);
  });

  it("a bundle holder reads the courses the bundle lists, and no other", async () => {
    expect(lessonsOf(await read(world.bundleHolder, world.other))?.[0]).toMatchObject({
      video: { media: world.otherVideo },
      notes: "Other-notes",
    });
    expect(lessonsOf(await read(world.bundleHolder))?.[1]).toEqual({
      key: "one",
      title: "Lesson one",
    });
  });

  it("a course added to a bundle reaches earlier buyers once the bundle is published, and one removed stops", async () => {
    const add = { items: [world.other, world.course] };
    await invoke(
      "record.update",
      { object: BUNDLE, id: world.bundle, values: { courses: add } },
      context(admin),
    );
    // The working copy alone changes nothing: what the bundle lists is its published version.
    expect(lessonsOf(await read(world.bundleHolder))?.[1]).toEqual({
      key: "one",
      title: "Lesson one",
    });
    await invoke("record.publish", { object: BUNDLE, id: world.bundle }, context(admin));
    expect(lessonsOf(await read(world.bundleHolder))?.[1]?.notes).toBe("Holders-only-notes");
    const removed = { items: [world.other] };
    await invoke(
      "record.update",
      { object: BUNDLE, id: world.bundle, values: { courses: removed } },
      context(admin),
    );
    await invoke("record.publish", { object: BUNDLE, id: world.bundle }, context(admin));
    expect(lessonsOf(await read(world.bundleHolder))?.[1]).toEqual({
      key: "one",
      title: "Lesson one",
    });
  });

  it("ending an enrolment, or voiding it, ends access at once", async () => {
    const student = await member(admin, "Quitter");
    const id = (
      await invoke(
        "record.create",
        {
          object: ENROLMENT,
          values: { code: unique("enr"), holder: student.personId, course: world.course },
        },
        context(admin),
      )
    ).id;
    expect(lessonsOf(await read(student))?.[1]?.notes).toBe("Holders-only-notes");
    await invoke(
      "record.update",
      { object: ENROLMENT, id, values: { status: "void" } },
      context(admin),
    );
    expect(lessonsOf(await read(student))?.[1]).toEqual({ key: "one", title: "Lesson one" });
  });

  it("the one question: staff hold every record, the public none, a customer only theirs", async () => {
    const course = getObject(COURSE);
    if (!course) throw new Error("no course");
    const ids = [world.course, world.other];
    const ask = async (principal: Parameters<typeof outside>[0]) =>
      [...(await holdsAccess({ db: db.query, principal }, course, ids))].sort();
    expect(await ask({ kind: "staff", user: { id: admin.id, role: "admin" } } as never)).toEqual(
      [...ids].sort(),
    );
    expect(await ask(PUBLIC)).toEqual([]);
    expect(await ask(world.holder)).toEqual([world.course]);
    expect(await ask(world.stranger)).toEqual([]);
    expect(await ask(world.voided)).toEqual([]);
    expect(await ask(world.lapsed)).toEqual([]);
  });
});

describe("media.play follows the same answer (criteria 3, 4 and 5)", () => {
  const play = (id: string, who: Parameters<typeof outside>[0]) =>
    call("media.play", { id }, outside(who));

  it("a holder gets a token for the lesson's video; everyone else the one not-found", async () => {
    const stream = fakeStream();
    const holder = await play(world.lessonVideo, world.holder);
    expect(holder).toMatchObject({ ok: true });
    const hls = (holder as { value: { hls: string } }).value.hls;
    expect((await stream.fake.handle(new Request(hls))).status).toBe(200);
    for (const who of [world.stranger, world.voided, world.lapsed, world.bundleHolder, PUBLIC]) {
      expect(await play(world.lessonVideo, who)).toEqual(NOT_FOUND);
    }
    // The free preview and the trailer play for anyone who may read the course.
    expect(await play(world.previewVideo, PUBLIC)).toMatchObject({ ok: true });
    expect(await play(world.trailer, world.stranger)).toMatchObject({ ok: true });
    // A bundle holder plays the bundle's course's video.
    expect(await play(world.otherVideo, world.bundleHolder)).toMatchObject({ ok: true });
    expect(await play(world.otherVideo, world.holder)).toEqual(NOT_FOUND);
    // Narrowed to a record or a field that does not show it: not found.
    expect(
      await call(
        "media.play",
        { id: world.lessonVideo, record: { object: COURSE, id: world.other } },
        outside(world.holder),
      ),
    ).toEqual(NOT_FOUND);
    // An audited call keeps no token.
    const rows = await env.DB.prepare(
      "SELECT result FROM core_audit WHERE operation = 'media.play' AND result IS NOT NULL",
    ).all<{ result: string }>();
    for (const row of rows.results) expect(row.result).not.toMatch(/eyJ/);
  });

  it("what a published version shows is written with its reach", async () => {
    const rows = await sql<{ media_id: string; reach: string }>`
      SELECT media_id, reach FROM core_published_media WHERE record_id = ${world.course}`.execute(
      db.query,
    );
    const reach = Object.fromEntries(rows.rows.map((r) => [r.media_id, r.reach]));
    expect(reach).toEqual({
      [world.trailer]: "all",
      [world.previewVideo]: "all",
      [world.lessonVideo]: "holders",
    });
  });

  it("a new published version that drops the video stops it for holders too", async () => {
    const fresh = await readyVideo(admin, "fresh.mp4");
    await invoke(
      "record.update",
      { object: COURSE, id: world.course, values: { outline: outline(fresh, world.previewVideo) } },
      context(admin),
    );
    // Until it is published, the holder plays the published lesson's video, not the draft's.
    expect(await play(fresh, world.holder)).toEqual(NOT_FOUND);
    await invoke("record.publish", { object: COURSE, id: world.course }, context(admin));
    expect(await play(fresh, world.holder)).toMatchObject({ ok: true });
    expect(await play(world.lessonVideo, world.holder)).toEqual(NOT_FOUND);
    // Put back for the tests after.
    await invoke(
      "record.update",
      {
        object: COURSE,
        id: world.course,
        values: { outline: outline(world.lessonVideo, world.previewVideo) },
      },
      context(admin),
    );
    await invoke("record.publish", { object: COURSE, id: world.course }, context(admin));
  });
});

describe("the seam takes a third kind of source (criterion 6)", () => {
  // A source of a kind the host does not ship: passes kept in a setting, person → course ids. It
  // stands in for stage 32's subscriptions. Only this test declares it.
  const KIND = "fixturePass";
  const SETTING = "test_fixture_passes";
  const EXT = extId("pass");
  let course: string;
  let video: string;
  let passHolder: Awaited<ReturnType<typeof member>>;
  let other: Awaited<ReturnType<typeof member>>;

  beforeAll(async () => {
    registerAccessSource(KIND, {
      problems: (_object, source) =>
        typeof source.options?.setting === "string" ? [] : ["a fixture pass names its setting"],
      async holders(query, source) {
        const row = await sql<{
          value: string;
        }>`SELECT value FROM core_settings WHERE key = ${String(source.options?.setting)}`.execute(
          query.db,
        );
        const passes = JSON.parse(row.rows[0]?.value ?? "{}") as Record<string, string[]>;
        return new Set((passes[query.personId] ?? []).filter((id) => query.ids.includes(id)));
      },
    });
    const m = manifest(EXT, {
      objects: {
        course: {
          label: "Course",
          plural: "Courses",
          titleField: "title",
          fields: {
            title: { type: "text", label: "Title", required: true },
            slug: { type: "slug", label: "Slug" },
            outline: {
              type: "document",
              label: "Outline",
              schema: {
                root: {
                  type: "object",
                  fields: {
                    video: { type: "ref", to: "media", media: "video" },
                    notes: { type: "text" },
                  },
                  holders: { keys: ["video", "notes"] },
                },
              },
            },
          },
          publishable: { content: ["title", "outline"], slug: "slug" },
          public: { read: ["title", "slug", "outline"] },
          access: { sources: [{ kind: KIND, options: { setting: SETTING } }] },
        },
      },
    });
    await reconcile(m);
    video = await readyVideo(admin, "pass.mp4");
    course = (
      await invoke(
        "record.create",
        {
          object: `${EXT}.course`,
          values: { title: "Pass course", outline: { video, notes: "Pass-notes" } },
        },
        context(admin),
      )
    ).id;
    await invoke("record.publish", { object: `${EXT}.course`, id: course }, context(admin));
    passHolder = await member(admin, "Pass");
    other = await member(admin, "NoPass");
    await env.DB.prepare("INSERT INTO core_settings (key, value, updated_at) VALUES (?, ?, ?)")
      .bind(SETTING, JSON.stringify({ [passHolder.personId]: [course] }), new Date().toISOString())
      .run();
  });

  afterAll(() => unregisterAccessSource(KIND));

  it("gives access with no change to the seam or to media.play", async () => {
    const readAs = (who: typeof other) =>
      call("my.get", { object: `${EXT}.course`, id: course }, outside(who));
    expect(JSON.stringify(await readAs(passHolder))).toContain("Pass-notes");
    expect(JSON.stringify(await readAs(other))).not.toContain("Pass-notes");
    expect(await call("media.play", { id: video }, outside(passHolder))).toMatchObject({
      ok: true,
    });
    expect(await call("media.play", { id: video }, outside(other))).toEqual(NOT_FOUND);
  });

  it("a kind the host does not provide is refused at install", async () => {
    const { checkManifest } = await import("../src/extensions/install.ts");
    const checked = await checkManifest(
      db.query,
      "nokind",
      manifest("nokind", {
        objects: {
          thing: {
            label: "Thing",
            plural: "Things",
            titleField: "name",
            fields: { name: { type: "text", label: "Name", required: true } },
            access: { sources: [{ kind: "subscriptionLater" }] },
          },
        },
      }),
      new Date().toISOString(),
    );
    expect(checked.issues.map((i) => i.message).join()).toContain('kind "subscriptionLater"');
  });
});

void ACCESS_EXT;
