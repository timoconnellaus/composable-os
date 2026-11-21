// Stage 42, build steps 4, 6 and 8 (the assistant's draft): the Courses pack (packs/courses) in
// the real host, beside Programs, installed as shipped, with real D1, the real payments gatekeeper
// and its fake provider, and the fake Stream (the video host, ADR 0475).
//
// Acceptance criteria: 1 (without the pack, none of it; it requires Programs), 4 (buying a course
// grants one enrolment in the paid batch; the buyer reads the holders' parts and plays a lesson's
// video; a full refund, approved by a person, voids it in the refund's batch and the next lesson
// read is not found; past its `until` nothing), 5 (a bundle reaches its courses and no other; a
// course added later reaches the earlier buyer once the bundle is published), 7 (enrolments and
// progress are their student's), 8 (progress: done, resume, complete; it survives a new version
// that keeps the lesson's key; refused without access), 9 (session lessons assigned on the first
// open; logged with Programs' own tools; none for someone without access) and 14 (a draft over
// MCP; its publish request is queued for a person, ADR 0480).
import { env, exports } from "cloudflare:workers";
import {
  type ActingUser,
  type CustomerPrincipal,
  createFakeStream,
  type ExtensionHost,
  getObject,
  type InvocationContext,
  invokeByName,
  type OutsideInvocationContext,
  refreshSchemaRegistry,
  setVideoHost,
} from "@composable-os/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  COURSES_HOOKS_CALL,
  createCoursesHooks,
  refreshInMs,
} from "../../../packs/courses/client/index.ts";
import type { Outline } from "../../../packs/courses/outline.ts";
import { blobStore, integrationRuntime } from "../src/integrations/runtime.ts";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, db, host, unique } from "./helpers.ts";

const packFiles = (glob: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(glob)
      .map(([path, text]) => [path.split("/").pop() as string, text] as const)
      .filter(([name]) => name !== "vitest.config.ts"),
  );
const files = {
  programs: packFiles(
    import.meta.glob<string>("../../../packs/programs/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
  courses: packFiles(
    import.meta.glob<string>("../../../packs/courses/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
};

/** The extension host of a deployment whose product lists Programs and Courses. */
const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [
    ...(await host.shipped()),
    { id: "courses", version: "0.1.0" },
    { id: "programs", version: "0.1.0" },
  ],
  commitShipped: (id) =>
    id === "programs" || id === "courses"
      ? host.commit({
          id,
          files: files[id],
          message: `Shipped ${id} 0.1.0`,
          author: { name: "Composable OS", email: "release@composableos.dev" },
        })
      : host.commitShipped(id),
};

const BASE = "https://host.test/api/v1/media/fake-stream";
const stream = createFakeStream({ baseUrl: BASE, autoReady: true });
const integrations = integrationRuntime(env);
const runner = exports.default as unknown as {
  gatekeeperFetch(vendor: string, request: Request): Promise<Response>;
};
const RETURN = "https://studio.test/thanks";
const COURSE = "courses.course";
const BUNDLE = "courses.bundle";
const ENROLMENT = "courses.enrolment";

let admin: ActingUser;

const staff = (user: ActingUser, extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user,
  origin: { surface: "ui" },
  db,
  integrations,
  blobs: blobStore(env),
  extensionHost: shippedHost,
  ...extra,
});
const guest: OutsideInvocationContext = {
  principal: { kind: "public" },
  db,
  integrations,
  extensionHost: shippedHost,
};
const as = (principal: CustomerPrincipal, extra: Partial<OutsideInvocationContext> = {}) =>
  ({
    principal,
    db,
    integrations,
    extensionHost: shippedHost,
    ...extra,
  }) as OutsideInvocationContext;

function run<T = Record<string, unknown>>(
  name: string,
  input: unknown,
  ctx: InvocationContext | OutsideInvocationContext,
): Promise<T> {
  return invokeByName(name, input, ctx) as Promise<T>;
}

async function refusal(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    const e = error as { code?: string; message?: string; details?: Record<string, unknown> };
    return { code: e.code, message: e.message, inner: e.details?.code, details: e.details };
  }
  throw new Error("expected a refusal");
}

const create = async (object: string, values: Record<string, unknown>) =>
  (await run<{ id: string }>("record.create", { object, values }, staff(admin))).id;
const publish = (object: string, id: string) => run("record.publish", { object, id }, staff(admin));

async function createCustomer(
  label: string,
): Promise<{ principal: CustomerPrincipal; email: string }> {
  const tag = unique(label).toLowerCase();
  const email = `${tag}@students.test`;
  const person = await run<{ id: string }>(
    "person.create",
    { givenName: `Given-${tag}`, emails: [{ email }] },
    staff(admin),
  );
  const customerId = `cus_${tag}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_customer (id, person_id, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(customerId, person.id, email, now, now)
    .run();
  return { principal: { kind: "customer", customerId, personId: person.id }, email };
}

/** A ready video in the library, uploaded the way the admin does (the fake Stream). */
async function readyVideo(name: string): Promise<string> {
  const asked = await run<{ item: { id: string }; upload: { url: string } }>(
    "media.videoUpload",
    { name, bytes: 1000 },
    staff(admin),
  );
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(1000)]), name);
  await stream.fake.handle(new Request(asked.upload.url, { method: "POST", body: form }));
  await run("media.videoRefresh", { id: asked.item.id }, staff(admin));
  return asked.item.id;
}

interface Order {
  id: string;
  state: string;
  total: number;
  token: string | null;
}

async function checkoutAndPay(order: Order, ctx: OutsideInvocationContext) {
  const checkout = await run<{ url: string }>(
    "order.checkout",
    { id: order.id, ...(order.token ? { token: order.token } : {}), returnUrl: RETURN },
    ctx,
  );
  const paid = await runner.gatekeeperFetch(
    "payments",
    new Request(checkout.url, {
      method: "POST",
      body: new URLSearchParams({ outcome: "pay" }),
      redirect: "manual",
    }),
  );
  expect(paid.status).toBe(303);
}

const orderState = async (id: string) =>
  (await run<{ state: string }>("order.get", { id }, staff(admin))).state;
async function waitForState(id: string, state: string) {
  await vi.waitFor(async () => expect(await orderState(id)).toBe(state), { timeout: 20_000 });
}

async function enrolmentsOf(orderId: string) {
  return (
    await run<{ items: { id: string; values: Record<string, unknown> }[] }>(
      "record.list",
      { object: ENROLMENT, filter: { field: "order", op: "eq", value: orderId }, limit: 10 },
      staff(admin),
    )
  ).items;
}

const NOT_FOUND = { code: "not_found" };
/** A tool's refusal: the host's not-found, inside the tool's error. */
const GONE = { inner: "not_found" };

let lessonVideo: string;
let previewVideo: string;
let trailer: string;
let otherVideo: string;
let programId: string;
let courseId: string;
let otherId: string;
let thirdId: string;
let bundleId: string;

const outline = (video: string, extra: Outline["sections"][number]["lessons"] = []): Outline => ({
  sections: [
    {
      key: "start",
      title: "Start here",
      lessons: [
        {
          kind: "video",
          key: "welcome",
          title: "Welcome",
          preview: true,
          video: { media: previewVideo },
        },
        { kind: "video", key: "wrists", title: "Wrists", duration: 8, video: { media: video } },
        {
          kind: "text",
          key: "read",
          title: "Read this",
          body: {
            blocks: [{ type: "paragraph", content: [{ type: "text", text: "Holders-only-text" }] }],
          },
        },
        ...extra,
      ],
    },
    {
      key: "train",
      title: "Train",
      lessons: [
        {
          kind: "session",
          key: "day-1",
          title: "Day one",
          program: programId,
          week: 1,
          session: 0,
        },
      ],
    },
  ],
});

beforeAll(async () => {
  setVideoHost(stream);
  admin = await createAdmin();
  await setPreset("balanced");

  // Courses requires Programs: installed first, it is refused and says so.
  await refreshSchemaRegistry(db.query);
  expect(getObject(COURSE)).toBeUndefined();
  const early = await refusal(
    run("extension.install", { id: "courses", shipped: true }, staff(admin)),
  );
  expect(JSON.stringify(early)).toContain("requires the programs extension");
  await run("extension.install", { id: "programs", shipped: true }, staff(admin));
  await run("extension.install", { id: "courses", shipped: true }, staff(admin));
  await refreshSchemaRegistry(db.query);
  expect(getObject(COURSE)?.access?.sources).toHaveLength(2);
  // On-demand online courses, no place (ADR 0479): taxed once an admin turns tax on.
  expect(getObject(COURSE)?.sellable?.tax?.code).toBe("txcd_20060158");
  expect(getObject(BUNDLE)?.sellable?.tax?.code).toBe("txcd_20060158");

  await run(
    "order.settings.update",
    { currency: "AUD", returnOrigins: ["https://studio.test"] },
    staff(admin),
  );
  await run("integration.setVendor", { vendor: "payments", enabled: true }, staff(admin));
  const payments = await run<{ connection: { id: string } }>(
    "connection.create",
    { vendor: "payments", scope: "org" },
    staff(admin),
  );
  await run(
    "connection.bindResource",
    { id: payments.connection.id, url: "payments://merchant/fake" },
    staff(admin),
  );

  // A published program with one session a week, for the session lesson.
  const pike = await create("programs.exercise", { name: "Pike", measure: "reps" });
  programId = await create("programs.program", {
    title: "Handstand strength",
    kind: "course",
    layout: {
      weeks: [
        {
          sessions: [
            {
              name: "Press",
              day: 1,
              blocks: [
                {
                  label: "A",
                  items: [
                    {
                      kind: "all",
                      label: "A1",
                      exercises: [{ exercise: pike, sets: [{ kind: "reps", reps: 5 }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  });
  await publish("programs.program", programId);

  lessonVideo = await readyVideo("wrists.mp4");
  previewVideo = await readyVideo("welcome.mp4");
  trailer = await readyVideo("trailer.mp4");
  otherVideo = await readyVideo("hips.mp4");
  courseId = await create(COURSE, {
    title: "Handstands 101",
    level: 1,
    price: 99,
    trailer: { media: trailer },
    outline: outline(lessonVideo),
  });
  otherId = await create(COURSE, {
    title: "Mobility",
    price: 49,
    outline: {
      sections: [
        {
          key: "m",
          title: "M",
          lessons: [{ kind: "video", key: "hips", title: "Hips", video: { media: otherVideo } }],
        },
      ],
    },
  });
  thirdId = await create(COURSE, {
    title: "Splits",
    price: 49,
    outline: {
      sections: [
        {
          key: "s",
          title: "S",
          lessons: [
            {
              kind: "text",
              key: "s1",
              title: "S1",
              body: {
                blocks: [{ type: "paragraph", content: [{ type: "text", text: "Splits-text" }] }],
              },
            },
          ],
        },
      ],
    },
  });
  bundleId = await create(BUNDLE, {
    title: "Starter",
    price: 120,
    courses: { items: [otherId, courseId] },
  });
  for (const id of [courseId, otherId, thirdId]) await publish(COURSE, id);
  await publish(BUNDLE, bundleId);
}, 180_000);

afterAll(() => setVideoHost(undefined));

const lesson = (who: OutsideInvocationContext, key = "wrists", id = courseId) =>
  run<{
    lesson: Record<string, unknown>;
    video: { media: string; record: { object: string; id: string }; field: string } | null;
  }>("x.courses.lesson", { courseId: id, lessonKey: key }, who);
const play = (who: OutsideInvocationContext, media: string) =>
  run<{ hls: string; expiresAt: string }>("media.play", { id: media }, who);

describe("buying one course (criteria 4 and 7)", () => {
  it("a paid order grants one enrolment in the paid batch; the buyer reads and plays the lesson; a stranger cannot", async () => {
    const buyer = await createCustomer("buyer");
    const stranger = await createCustomer("stranger");
    // Before buying: the free preview plays, the lesson is not there.
    expect(await refusal(lesson(as(buyer.principal)))).toMatchObject(GONE);
    expect(await play(as(buyer.principal), previewVideo)).toMatchObject({
      hls: expect.stringContaining(BASE),
    });
    expect(await play(guest, trailer)).toBeTruthy();

    const order = await run<Order>("x.courses.buy", { courseId }, as(buyer.principal));
    expect(order.total).toBe(9900);
    await checkoutAndPay(order, as(buyer.principal));
    await waitForState(order.id, "paid");
    const granted = await enrolmentsOf(order.id);
    expect(granted).toHaveLength(1);
    expect(granted[0]?.values).toMatchObject({
      course: courseId,
      holder: buyer.principal.personId,
      status: "active",
      source: "purchase",
    });

    const read = await lesson(as(buyer.principal));
    expect(read.video).toEqual({
      media: lessonVideo,
      poster: null,
      record: { object: COURSE, id: courseId },
      field: "outline",
    });
    // The app asks the host for the token with what `lesson` named; it plays.
    const token = await run<{ hls: string }>(
      "media.play",
      { id: lessonVideo, record: read.video?.record, field: "outline" },
      as(buyer.principal),
    );
    expect((await stream.fake.handle(new Request(token.hls))).status).toBe(200);
    expect(JSON.stringify(await lesson(as(buyer.principal), "read"))).toContain(
      "Holders-only-text",
    );

    // A stranger: not found, not playable, and no holders' part in what they read.
    expect(await refusal(lesson(as(stranger.principal)))).toMatchObject(GONE);
    expect(await refusal(play(as(stranger.principal), lessonVideo))).toMatchObject(NOT_FOUND);
    expect(await refusal(play(guest, lessonVideo))).toMatchObject(NOT_FOUND);
    const seen = await run("my.get", { object: COURSE, id: courseId }, as(stranger.principal));
    expect(JSON.stringify(seen)).not.toContain(lessonVideo);
    expect(JSON.stringify(seen)).not.toContain("Holders-only-text");
    // Buying it again is refused as a course that is not there.
    expect(await refusal(run("x.courses.buy", { courseId }, as(buyer.principal)))).toMatchObject({
      inner: "not_found",
    });

    // Enrolments and progress are their student's: the stranger sees none of the buyer's.
    const theirs = await run<{ items: unknown[] }>(
      "my.list",
      { object: ENROLMENT, limit: 50 },
      as(stranger.principal),
    );
    expect(theirs.items).toEqual([]);
    const mine = await run<{ courses: { id: string; why: string }[] }>(
      "x.courses.myCourses",
      {},
      as(buyer.principal),
    );
    expect(mine.courses).toEqual([expect.objectContaining({ id: courseId, why: "bought" })]);

    // A full refund, approved by a person, voids it in the refund's batch: access ends.
    const asked = await run<{ refunds: { pendingActionId: string | null }[] }>(
      "order.refund",
      { id: order.id, reason: "Changed their mind" },
      staff(admin),
    );
    await run("approval.approve", { actionIds: [asked.refunds[0]?.pendingActionId] }, staff(admin));
    await waitForState(order.id, "refunded");
    expect((await enrolmentsOf(order.id))[0]?.values.status).toBe("void");
    expect(await refusal(lesson(as(buyer.principal)))).toMatchObject(GONE);
    expect(await refusal(play(as(buyer.principal), lessonVideo))).toMatchObject(NOT_FOUND);
    expect(
      await refusal(
        run("x.courses.progress", { courseId, lessonKey: "wrists" }, as(buyer.principal)),
      ),
    ).toMatchObject({ inner: "not_found" });
  });

  it("access given by staff until a date that has passed gives nothing", async () => {
    const lapsed = await createCustomer("lapsed");
    await run(
      "x.courses.enrol",
      {
        personId: lapsed.principal.personId,
        courseId,
        until: "2020-01-01T00:00:00.000Z",
        reason: "An old pass",
      },
      staff(admin),
    );
    expect(await refusal(lesson(as(lapsed.principal)))).toMatchObject(GONE);
    const given = await createCustomer("given");
    const enrolled = await run<{ enrolmentId: string }>(
      "x.courses.enrol",
      { personId: given.principal.personId, courseId, reason: "A scholarship" },
      staff(admin),
    );
    expect((await lesson(as(given.principal))).video?.media).toBe(lessonVideo);
    await run(
      "x.courses.endEnrolment",
      { enrolmentId: enrolled.enrolmentId, reason: "Scholarship over" },
      staff(admin),
    );
    expect(await refusal(lesson(as(given.principal)))).toMatchObject(GONE);
    // No customer moves an enrolment to void, nor staff: a void is a refund's (the host's).
    expect(
      await refusal(
        run(
          "record.update",
          { object: ENROLMENT, id: enrolled.enrolmentId, values: { status: "void" } },
          staff(admin),
        ),
      ),
    ).toMatchObject({ code: "invalid_input" });
  });
});

describe("buying a bundle (criterion 5)", () => {
  it("gives access to each of its courses and no other; a course added later reaches the buyer once published", async () => {
    const buyer = await createCustomer("bundler");
    const order = await run<Order>("x.courses.buy", { bundleId }, as(buyer.principal));
    expect(order.total).toBe(12000);
    await checkoutAndPay(order, as(buyer.principal));
    await waitForState(order.id, "paid");
    expect((await enrolmentsOf(order.id))[0]?.values).toMatchObject({
      bundle: bundleId,
      status: "active",
    });
    expect((await lesson(as(buyer.principal), "hips", otherId)).video?.media).toBe(otherVideo);
    expect((await lesson(as(buyer.principal))).video?.media).toBe(lessonVideo);
    expect(await refusal(lesson(as(buyer.principal), "s1", thirdId))).toMatchObject(GONE);
    // Staff add the third course to the bundle: nothing until it is published.
    await run(
      "record.update",
      {
        object: BUNDLE,
        id: bundleId,
        values: { courses: { items: [otherId, courseId, thirdId] } },
      },
      staff(admin),
    );
    expect(await refusal(lesson(as(buyer.principal), "s1", thirdId))).toMatchObject(GONE);
    await publish(BUNDLE, bundleId);
    expect(JSON.stringify(await lesson(as(buyer.principal), "s1", thirdId))).toContain(
      "Splits-text",
    );
    const mine = await run<{ courses: { id: string; why: string }[] }>(
      "x.courses.myCourses",
      {},
      as(buyer.principal),
    );
    expect(mine.courses.map((c) => c.id).sort()).toEqual([courseId, otherId, thirdId].sort());
    expect(new Set(mine.courses.map((c) => c.why))).toEqual(new Set(["bundle"]));
  });
});

describe("progress and session lessons (criteria 8 and 9)", () => {
  it("marks done, resumes a video, completes the course, and survives a new version that keeps the key", async () => {
    const student = await createCustomer("student");
    await run(
      "x.courses.enrol",
      { personId: student.principal.personId, courseId, reason: "Testing progress" },
      staff(admin),
    );
    const me = as(student.principal);
    const first = await run<{ state: string }>(
      "x.courses.progress",
      { courseId, lessonKey: "wrists", position: 42 },
      me,
    );
    expect(first.state).toBe("started");
    expect(
      (await run<{ position: number }>("x.courses.lesson", { courseId, lessonKey: "wrists" }, me))
        .position,
    ).toBe(42);
    const ended = await run<{ state: string }>(
      "x.courses.progress",
      { courseId, lessonKey: "wrists", position: 475, duration: 480 },
      me,
    );
    expect(ended.state).toBe("done");

    // The first progress row assigns the course's program to the student, from today (the
    // automation runs as the extension, a moment later: the player says "preparing" till then).
    const session = await vi.waitFor(
      async () => {
        const s = await run<{ sessionId: string | null; preparing: boolean; date: string }>(
          "x.courses.startSession",
          { courseId, lessonKey: "day-1" },
          me,
        );
        expect(s.preparing).toBe(false);
        return s;
      },
      { timeout: 30_000, interval: 500 },
    );
    expect(session.date).toBe(new Date().toISOString().slice(0, 10));
    // They log a set on it with Programs' own tool.
    const logged = await run<{ id: string }>(
      "x.programs.logAdd",
      { sessionId: session.sessionId, item: "A1", setNumber: 1, actual: { reps: 5 } },
      me,
    );
    expect(logged.id).toBeTruthy();

    for (const key of ["welcome", "read", "day-1"]) {
      await run("x.courses.progress", { courseId, lessonKey: key, state: "done" }, me);
    }
    const course = await run<{ complete: boolean; done: string[] }>(
      "x.courses.course",
      { slug: "handstands-101" },
      me,
    );
    expect(course.complete).toBe(true);

    // A new published version that keeps the keys (and adds a lesson): their done lessons stay.
    await run(
      "record.update",
      {
        object: COURSE,
        id: courseId,
        values: {
          outline: outline(lessonVideo, [
            { kind: "text", key: "extra", title: "Extra", body: { blocks: [] } },
          ]),
        },
      },
      staff(admin),
    );
    await publish(COURSE, courseId);
    const after = await run<{ complete: boolean; done: string[]; sections: unknown }>(
      "x.courses.course",
      { slug: "handstands-101" },
      me,
    );
    expect(JSON.stringify(after.sections)).toContain("extra");
    expect(after.done.sort()).toEqual(["day-1", "read", "welcome", "wrists"]);
    expect(after.complete).toBe(false);
  });

  it("someone without access gets no assignment, no session, and cannot log or keep progress", async () => {
    const outsider = await createCustomer("outsider");
    const them = as(outsider.principal);
    expect(
      await refusal(run("x.courses.progress", { courseId, lessonKey: "welcome" }, them)),
    ).toMatchObject({ inner: "not_found" });
    expect(
      await refusal(run("x.courses.startSession", { courseId, lessonKey: "day-1" }, them)),
    ).toMatchObject({ inner: "not_found" });
    const assignments = await run<{ items: unknown[] }>(
      "record.list",
      {
        object: "programs.assignment",
        filter: { field: "person", op: "eq", value: outsider.principal.personId },
      },
      staff(admin),
    );
    expect(assignments.items).toEqual([]);
  });
});

describe("the assistant's draft (criterion 14, ADR 0480)", () => {
  it("drafts a course over MCP from library videos; its publish request is queued for a person", async () => {
    const mcp = staff(admin, { actor: "mcp", origin: { surface: "mcp" } } as never);
    const drafted = await run<{ courseId: string; published: boolean; videos: string[] }>(
      "x.courses.draft",
      { brief: "A wrists course in 2 parts" },
      mcp,
    );
    expect(drafted.published).toBe(false);
    expect(drafted.videos).toContain(lessonVideo);
    const asked = await refusal(
      run("record.publish", { object: COURSE, id: drafted.courseId }, mcp),
    );
    expect(asked.code).toBe("pending_approval");
    const read = await run<{ publishState: string | null; values?: { publishState?: string } }>(
      "record.get",
      { object: COURSE, id: drafted.courseId },
      staff(admin),
    );
    expect(JSON.stringify(read)).toContain('"publishState":"draft"');
  });
});

describe("the hooks (step 7, ADR 0453)", () => {
  it("a customer's client gets the customer hooks only, and playback refreshes before it expires", () => {
    const customerOps = [
      "x.courses.catalogue",
      "x.courses.course",
      "x.courses.buy",
      "order.checkout",
      "x.courses.lesson",
      "media.play",
      "x.courses.progress",
      "x.courses.myCourses",
      "x.courses.startSession",
    ];
    const hooks = createCoursesHooks(
      { useQuery: (() => ({})) as never, useMutation: (() => ({})) as never },
      {
        operations: Object.fromEntries(customerOps.map((n) => [n, true])),
        query: () => ({}),
        mutation: () => ({}),
      } as never,
    );
    expect(Object.keys(hooks).sort()).toEqual(
      [
        "useBuy",
        "useCatalogue",
        "useCourse",
        "useLesson",
        "useMyCourses",
        "usePlayback",
        "useProgress",
        "useStartSession",
      ].sort(),
    );
    expect(Object.keys(COURSES_HOOKS_CALL)).toContain("useEnrol");
    const now = Date.parse("2026-11-22T10:00:00Z");
    expect(refreshInMs("2026-11-22T11:00:00Z", now)).toBe(55 * 60_000);
    expect(refreshInMs("2026-11-22T10:01:00Z", now)).toBe(10_000);
  });
});
