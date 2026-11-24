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
  type AutomationTestReport,
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
import { automationHost } from "../src/automations/host.ts";
import { blobStore, integrationRuntime } from "../src/integrations/runtime.ts";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, db, host, newCustomer, refusal } from "./helpers.ts";
import { packFiles } from "./pack-files.ts";

const files = {
  programs: packFiles("programs"),
  content: packFiles("content"),
  courses: packFiles("courses"),
};

/** The extension host of a deployment whose product lists Programs, Content and Courses. */
const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [
    ...(await host.shipped()),
    { id: "content", version: "0.1.0" },
    { id: "courses", version: "0.1.0" },
    { id: "programs", version: "0.1.0" },
  ],
  commitShipped: (id) =>
    id === "programs" || id === "content" || id === "courses"
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

const create = async (object: string, values: Record<string, unknown>) =>
  (await run<{ id: string }>("record.create", { object, values }, staff(admin))).id;
const publish = (object: string, id: string) => run("record.publish", { object, id }, staff(admin));

const createCustomer = (label: string) =>
  newCustomer(staff(admin), label, { domain: "students.test" });

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
  // And Content, whose rich text blocks draw a text lesson: without it, refused again.
  const second = await refusal(
    run("extension.install", { id: "courses", shipped: true }, staff(admin)),
  );
  expect(JSON.stringify(second)).toContain("requires the content extension");
  await run("extension.install", { id: "content", shipped: true }, staff(admin));
  await run("extension.install", { id: "courses", shipped: true }, staff(admin));
  await refreshSchemaRegistry(db.query);
  // Enrolments for a course, for a bundle, and a course subscription (stage 32a, ADR 0488).
  expect(getObject(COURSE)?.access?.sources).toHaveLength(3);
  expect(getObject("courses.plan")?.sellable?.recurring).toEqual({
    interval: "month",
    trialDays: "trialDays",
  });
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

describe("the course subscription (stage 32a, step 3: ADRs 0488 to 0490)", () => {
  const subscriptionOf = (id: string) =>
    env.DB.prepare("SELECT * FROM core_subscription WHERE id = ?")
      .bind(id)
      .first<Record<string, unknown>>();

  it("a trial through the provider's page gives every published course, one published later too, until it ends", async () => {
    const planId = await create("courses.plan", {
      title: "Every course",
      price: 29,
      trialDays: 7,
    });
    const plans = await run<{ plans: { id: string; trialDays: number }[] }>(
      "x.courses.plans",
      {},
      guest,
    );
    expect(plans.plans).toContainEqual(expect.objectContaining({ id: planId, trialDays: 7 }));
    // A plan is subscribed to, never bought on an order.
    expect(
      await refusal(
        run("x.courses.buy", { courseId: planId }, as((await createCustomer("x")).principal)),
      ),
    ).toBeTruthy();

    const member = await createCustomer("member");
    const stranger = await createCustomer("nonmember");
    expect(await refusal(lesson(as(member.principal), "s1", thirdId))).toMatchObject(GONE);
    const started = await run<{ subscriptionId: string; url: string; trialDays: number | null }>(
      "subscription.start",
      { plan: { object: "courses.plan", id: planId }, returnUrl: RETURN },
      as(member.principal),
    );
    expect(started.trialDays).toBe(7);
    // On the provider's page, nothing is held yet.
    expect(await refusal(lesson(as(member.principal), "s1", thirdId))).toMatchObject(GONE);
    const paid = await runner.gatekeeperFetch(
      "payments",
      new Request(started.url, {
        method: "POST",
        body: new URLSearchParams({ outcome: "pay" }),
        redirect: "manual",
      }),
    );
    expect(paid.status).toBe(303);
    await vi.waitFor(
      async () => expect((await subscriptionOf(started.subscriptionId))?.state).toBe("trialing"),
      { timeout: 20_000 },
    );

    // Every published course's holders' parts, and its videos, with no enrolment.
    expect(JSON.stringify(await lesson(as(member.principal), "s1", thirdId))).toContain(
      "Splits-text",
    );
    const read = await lesson(as(member.principal));
    const token = await run<{ hls: string }>(
      "media.play",
      { id: lessonVideo, record: read.video?.record, field: "outline" },
      as(member.principal),
    );
    expect((await stream.fake.handle(new Request(token.hls))).status).toBe(200);
    const later = await create(COURSE, {
      title: "Published later",
      price: 49,
      outline: {
        sections: [
          {
            key: "l",
            title: "L",
            lessons: [
              {
                kind: "text",
                key: "l1",
                title: "L1",
                body: {
                  blocks: [{ type: "paragraph", content: [{ type: "text", text: "Later-text" }] }],
                },
              },
            ],
          },
        ],
      },
    });
    await publish(COURSE, later);
    expect(JSON.stringify(await lesson(as(member.principal), "l1", later))).toContain("Later-text");
    const mine = await run<{ courses: { id: string; why: string }[] }>(
      "x.courses.myCourses",
      {},
      as(member.principal),
    );
    expect(mine.courses).toContainEqual(
      expect.objectContaining({ id: later, why: "subscription" }),
    );
    // A stranger holds nothing of it.
    expect(await refusal(lesson(as(stranger.principal), "l1", later))).toMatchObject(GONE);
    expect(await refusal(play(as(stranger.principal), lessonVideo))).toMatchObject(NOT_FOUND);

    // One trial per person: a second start is charged from the start.
    const again = await run<{ trialDays: number | null; noTrial: string | null }>(
      "subscription.start",
      { plan: { object: "courses.plan", id: planId }, returnUrl: RETURN },
      as(member.principal),
    );
    expect(again).toMatchObject({ trialDays: null, noTrial: "used" });

    // Another customer cannot cancel it; staff end it now, and access stops once the provider says.
    expect(
      await refusal(
        run("subscription.cancel", { id: started.subscriptionId }, as(stranger.principal)),
      ),
    ).toMatchObject(NOT_FOUND);
    await run(
      "subscription.cancel",
      { id: started.subscriptionId, reason: "Asked by email", now: true },
      staff(admin),
    );
    await vi.waitFor(
      async () => expect((await subscriptionOf(started.subscriptionId))?.state).toBe("ended"),
      { timeout: 20_000 },
    );
    expect(await refusal(lesson(as(member.principal), "l1", later))).toMatchObject(GONE);
    expect(await refusal(play(as(member.principal), lessonVideo))).toMatchObject(NOT_FOUND);
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
    // Nothing of the request chooses what is assigned or to whom: a tool's input has no such
    // fields (unknown keys are dropped), and the automation reads the committed progress row and
    // the course's published version (ADR 0478).
    const someoneElse = await createCustomer("someone-else");
    const otherProgram = await create("programs.program", {
      title: "Not in this course",
      kind: "course",
      layout: { weeks: [{ sessions: [] }] },
    });
    await publish("programs.program", otherProgram);
    const first = await run<{ state: string }>(
      "x.courses.progress",
      {
        courseId,
        lessonKey: "wrists",
        position: 42,
        personId: someoneElse.principal.personId,
        holder: someoneElse.principal.personId,
        programId: otherProgram,
      },
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

    // Only the course's program, only for the student who wrote the progress.
    const assignments = async (person: string) =>
      (
        await run<{ items: { values: Record<string, unknown> }[] }>(
          "record.list",
          { object: "programs.assignment", filter: { field: "person", op: "eq", value: person } },
          staff(admin),
        )
      ).items.map((a) => a.values.program);
    expect(await assignments(student.principal.personId)).toEqual([programId]);
    expect(await assignments(someoneElse.principal.personId)).toEqual([]);

    // The audit log names both: Courses' automation calling Programs' tool, and Programs' own
    // writes under Programs, in the same cascade (one root event, one level deeper).
    const audit = async (operation: string, user?: string) =>
      (
        await env.DB.prepare(
          `SELECT actor, user_id, origin FROM core_audit WHERE operation = ?${user ? " AND user_id = ?" : ""} ORDER BY at DESC LIMIT 5`,
        )
          .bind(...(user ? [operation, user] : [operation]))
          .all<{ actor: string; user_id: string; origin: string }>()
      ).results.map((r) => ({ ...r, origin: JSON.parse(r.origin) as Record<string, unknown> }));
    const users = await env.DB.prepare(
      "SELECT id, user_id FROM core_extensions WHERE id IN ('courses', 'programs')",
    ).all<{ id: string; user_id: string }>();
    const userOf = Object.fromEntries(users.results.map((r) => [r.id, r.user_id]));
    const [call] = await audit("x.programs.assign", userOf.courses);
    expect(call).toMatchObject({
      actor: "automation",
      origin: {
        surface: "automation",
        automationId: "courses.assignSessions",
        extensionId: "courses",
      },
    });
    expect(Number(call?.origin.depth)).toBeGreaterThanOrEqual(1);
    const [made] = await audit("record.create", userOf.programs);
    expect(made).toMatchObject({
      actor: "extension",
      origin: {
        surface: "extension",
        extensionId: "programs",
        rootEventId: call?.origin.rootEventId,
      },
    });
    expect(made?.origin.depth).toBe(call?.origin.depth);

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

describe("one extension calling another's tool (ADR 0478)", () => {
  it("is refused unless the caller declares it, and runs under the called extension's own permissions", async () => {
    const row = await env.DB.prepare(
      "SELECT user_id FROM core_extensions WHERE id = 'courses'",
    ).first<{
      user_id: string;
    }>();
    const user = await env.DB.prepare("SELECT id, email, name FROM core_user WHERE id = ?")
      .bind(row?.user_id)
      .first<{ id: string; email: string; name: string }>();
    const person = await createCustomer("assigned-by-hand");
    const asCourses = (operations: string[]) =>
      ({
        actor: "extension",
        user: { ...(user as { id: string; email: string; name: string }), role: "member" },
        origin: { surface: "extension", extensionId: "courses" },
        db,
        extensionHost: shippedHost,
        extension: {
          id: "courses",
          permissions: { read: [], write: [], operations, modules: ["ops"] },
        },
      }) as unknown as InvocationContext;
    const input = { programId, personId: person.principal.personId, startDate: "2027-01-04" };
    // Not declared: refused before anything runs.
    const refused = await refusal(run("x.programs.assign", input, asCourses([])));
    expect(refused).toMatchObject({ code: "forbidden" });
    expect(refused.message).toContain("x.programs.assign is not in permissions.operations");
    // Declared: it runs, and Programs' tool writes Programs' records as Programs.
    const done = await run<{ assignmentId: string }>(
      "x.programs.assign",
      input,
      asCourses(["x.programs.assign"]),
    );
    expect(done.assignmentId).toBeTruthy();

    // ADR 0022 amendment (2026-11-22): under Cautious an extension's bulk-write waits for a
    // person, and the queued tool is not run (the dry run used to assign the program at once).
    const other = await createCustomer("assigned-after-approval");
    const assignments = async () =>
      (
        await run<{ items: unknown[] }>(
          "record.list",
          {
            object: "programs.assignment",
            filter: { field: "person", op: "eq", value: other.principal.personId },
          },
          staff(admin),
        )
      ).items.length;
    await setPreset("cautious");
    try {
      const queued = await refusal(
        run(
          "x.programs.assign",
          { ...input, personId: other.principal.personId },
          asCourses(["x.programs.assign"]),
        ),
      );
      expect(queued).toMatchObject({ code: "pending_approval" });
      expect(await assignments()).toBe(0);
      const actionId = (queued as { details?: { actionId?: string } }).details?.actionId;
      const pending = await env.DB.prepare(
        "SELECT actor, operation, status FROM core_pending_action WHERE id = ?",
      )
        .bind(actionId)
        .first();
      expect(pending).toEqual({
        actor: "extension",
        operation: "x.programs.assign",
        status: "pending",
      });
      await setPreset("balanced");
      const approved = await run<{ results: { status: string }[] }>(
        "approval.approve",
        { actionIds: [actionId] },
        staff(admin),
      );
      expect(approved.results.map((r) => r.status)).toEqual(["applied"]);
      expect(await assignments()).toBe(1);
    } finally {
      await setPreset("balanced");
    }
  });
});

describe("test mode on the assigning automation (ADR 0022 amendment, 2026-11-22)", () => {
  it("reports Programs' tool as not run, gives the step a placeholder, and assigns nothing", async () => {
    const student = await createCustomer("test-mode-student");
    const progress = await create("courses.progress", {
      holder: student.principal.personId,
      course: courseId,
      lessonKey: "day-1",
      state: "started",
    });
    const { report } = await run<{ report: AutomationTestReport }>(
      "automation.test",
      { id: "courses.assignSessions", record: { object: "courses.progress", id: progress } },
      staff(admin, { automationHost: automationHost(env) }),
    );
    expect(report.ok).toBe(true);
    expect(report.notRun).toEqual([
      { operation: "x.programs.assign", note: expect.stringContaining("would run for real") },
    ]);
    const step = report.steps.find((s) => s.name === "assign");
    expect(step?.operations).toEqual([
      expect.objectContaining({
        operation: "x.programs.assign",
        notRun: expect.stringContaining("not run in test mode"),
      }),
    ]);
    const assignments = await run<{ items: unknown[] }>(
      "record.list",
      {
        object: "programs.assignment",
        filter: { field: "person", op: "eq", value: student.principal.personId },
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
