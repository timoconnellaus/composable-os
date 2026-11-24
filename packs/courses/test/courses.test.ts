// The Courses pack against the SDK's test host: the manifest passes the contract, the outline
// schema takes every kind of lesson and refuses a broken one with its path, and every tool asks
// the host what it should and passes on what the host answered. The host's rules themselves (who
// holds access, what the seam removes, buying, refunds, session assignments) are tested against
// the real host in apps/runner/test/courses.test.ts.
import { redactDocument, validateDocument } from "@composable-os/sdk";
import { createTestHost, type TestHost } from "@composable-os/sdk/testing";
import { describe, expect, it } from "vitest";
import { levelName } from "../client/index.ts";
import courses from "../index.ts";
import {
  completion,
  findLesson,
  OUTLINE_SCHEMA,
  type Outline,
  outlineProblems,
  sessionPrograms,
  watchedToEnd,
} from "../outline.ts";

const STAFF = { kind: "staff", userId: "usr_admin", name: "Sam" } as const;
const STUDENT = { kind: "customer", customerId: "cus_1", personId: "per_student" } as const;
const PUBLIC = { kind: "public" } as const;

const outline: Outline = {
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
          duration: 3,
          video: { media: "med_preview" },
        },
        {
          kind: "video",
          key: "wrists",
          title: "Wrists",
          duration: 8,
          video: { media: "med_wrists" },
        },
        {
          kind: "text",
          key: "notes",
          title: "Notes",
          body: { blocks: [{ type: "paragraph", content: [{ type: "text", text: "Read me" }] }] },
        },
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
          program: "rec_program",
          week: 1,
          session: 0,
        },
        { kind: "download", key: "sheet", title: "Worksheet", file: "med_sheet" },
      ],
    },
  ],
};

describe("the manifest and the outline", () => {
  it("passes the contract and requires Programs and Content", () => {
    const host = createTestHost(courses, {
      validate: {
        knownObjects: ["programs.program", "programs.assignment", "programs.session"],
      },
    });
    expect(host.issues).toEqual([]);
    expect(host.manifest.requires).toEqual(["programs", "content"]);
  });

  it("declares the course plan, and a course's access through a subscription to it", () => {
    const plan = courses.objects.plan;
    expect(plan?.sellable).toMatchObject({
      price: "price",
      tax: { code: "txcd_20060158" },
      recurring: { interval: "month", trialDays: "trialDays" },
    });
    expect(courses.objects.course?.access?.sources).toContainEqual({
      kind: "subscription",
      options: { plans: "courses.plan", covers: "all" },
    });
    // The contract refuses a subscription source that names no plan, or covers something else.
    const bad = (options: Record<string, string>) => {
      const course = courses.objects.course as object;
      const m = {
        ...courses,
        objects: {
          ...courses.objects,
          course: { ...course, access: { sources: [{ kind: "subscription", options }] } },
        },
        // A manifest the contract must refuse: not one defineExtension would type.
      } as unknown as typeof courses;
      return createTestHost(m, {
        validate: {
          knownObjects: ["programs.program", "programs.assignment", "programs.session"],
        },
      }).issues.map((i) => i.path);
    };
    expect(bad({ plans: "courses.bundle", covers: "all" })).toEqual([
      "objects.course.access.sources.0.options.plans",
    ]);
    expect(bad({ plans: "courses.plan", covers: "some" })).toEqual([
      "objects.course.access.sources.0.options.covers",
    ]);
    expect(bad({ plans: "other.plan", covers: "all" })).toEqual([
      "objects.course.access.sources.0.options.plans",
    ]);
  });

  it("takes every kind of lesson, and refuses a broken one with its path", () => {
    expect(validateDocument(OUTLINE_SCHEMA, outline, { maxBytes: 524_288 }).ok).toBe(true);
    const broken = structuredClone(outline) as unknown as {
      sections: { lessons: Record<string, unknown>[] }[];
    };
    (broken.sections[1] as { lessons: Record<string, unknown>[] }).lessons[0] = {
      kind: "session",
      key: "day-1",
      title: "Day",
      week: 60,
      session: 0,
    };
    const result = validateDocument(OUTLINE_SCHEMA, broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.path.join("."))).toEqual(
        expect.arrayContaining(["sections.1.lessons.0.program", "sections.1.lessons.0.week"]),
      );
    }
    // A key is lower-case words: no spaces, no capitals.
    const badKey = structuredClone(outline);
    (badKey.sections[0] as { lessons: { key: string }[] }).lessons[0] = {
      ...(outline.sections[0]?.lessons[0] as object),
      key: "Bad Key",
    };
    expect(validateDocument(OUTLINE_SCHEMA, badKey).ok).toBe(false);
  });

  it("is read without a lesson's material by someone without access, except a free preview", () => {
    const outside = redactDocument(OUTLINE_SCHEMA, outline) as Outline;
    expect(findLesson(outside, "welcome")).toMatchObject({ video: { media: "med_preview" } });
    const wrists = findLesson(outside, "wrists");
    expect(wrists).toMatchObject({ key: "wrists", title: "Wrists", duration: 8 });
    expect(wrists).not.toHaveProperty("video");
    expect(findLesson(outside, "notes")).not.toHaveProperty("body");
    expect(findLesson(outside, "day-1")).not.toHaveProperty("program");
    expect(findLesson(outside, "sheet")).not.toHaveProperty("file");
    expect(redactDocument(OUTLINE_SCHEMA, outline, { holder: true })).toEqual(outline);
  });

  it("counts every lesson but a download, and a video watched to its last 10 seconds", () => {
    expect(completion(outline, new Set(["welcome", "wrists"]))).toEqual({
      counted: 4,
      done: 2,
      complete: false,
    });
    expect(completion(outline, new Set(["welcome", "wrists", "notes", "day-1"])).complete).toBe(
      true,
    );
    expect(completion(outline, new Set(), true).complete).toBe(true);
    expect(watchedToEnd(51, 60)).toBe(true);
    expect(watchedToEnd(49, 60)).toBe(false);
    expect(sessionPrograms(outline)).toEqual(["rec_program"]);
    // The host refuses a key used in two sections, not only the builder (progress is kept by it).
    const across = structuredClone(outline);
    across.sections[1]?.lessons.push({
      kind: "text",
      key: "wrists",
      title: "Again",
      body: { blocks: [] },
    });
    const refused = validateDocument(OUTLINE_SCHEMA, across);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.issues).toEqual([
        {
          path: ["sections", 1, "lessons", 2, "key"],
          message: '"wrists" is used already (at sections.0.lessons.1)',
        },
      ]);
    }
    const twice = structuredClone(outline);
    twice.sections[1]?.lessons.push({ kind: "text", key: "wrists", title: "Again" });
    expect(outlineProblems(twice)).toEqual(['The lesson key "wrists" is in start and train']);
  });
});

describe("the client's words", () => {
  it("names the three levels, and nothing else", () => {
    expect([1, 2, 3].map(levelName)).toEqual(["Beginner", "Intermediate", "Advanced"]);
    expect([0, 4, null, undefined].map(levelName)).toEqual([null, null, null, null]);
  });
});

/** A test host whose host operations answer from its records, as the seam would for these tests. */
function hostWith(options: { held?: string[]; enrolments?: Record<string, unknown>[] } = {}) {
  let host: TestHost;
  const rows = (object: string) =>
    [...(host.records.get(object)?.values() ?? [])].map((v) => ({
      object,
      id: String(v.id),
      values: v,
    }));
  const filtered = (input: Record<string, unknown>) => {
    const filter = input.filter as
      | { field?: string; value?: unknown; and?: { field: string; value: unknown }[] }
      | undefined;
    const conditions =
      filter?.and ?? (filter?.field ? [filter as { field: string; value: unknown }] : []);
    return rows(String(input.object)).filter((r) =>
      conditions.every((c) => (c.field === "id" ? r.id : r.values[c.field]) === c.value),
    );
  };
  const page = (input: Record<string, unknown>) => ({
    items: filtered(input),
    nextCursor: null,
    currency: "AUD",
  });
  const one = (input: Record<string, unknown>) => {
    const found = rows(String(input.object)).find((r) => r.id === input.id);
    if (!found) throw Object.assign(new Error("not found"), { code: "not_found" });
    return found;
  };
  host = createTestHost(courses, {
    validate: { knownObjects: ["programs.program", "programs.assignment", "programs.session"] },
    records: {
      "courses.theme": [{ id: "rec_theme", name: "Handstands", order: 1 }],
      "courses.course": [
        {
          id: "rec_course",
          title: "Handstands 101",
          slug: "handstands-101",
          theme: "rec_theme",
          level: 1,
          price: 99,
          outline,
        },
      ],
      "courses.bundle": [
        {
          id: "rec_bundle",
          title: "Starter",
          courses: { items: ["rec_course", "rec_other"] },
          price: 150,
        },
      ],
      "courses.enrolment": (options.enrolments ?? []) as never,
      "courses.progress": [],
      "courses.plan": [{ id: "rec_plan", title: "Every course", price: 29, trialDays: 7 }],
      "programs.session": [
        { id: "rec_session", program: "rec_program", week: 1, position: 0, date: "2026-11-23" },
      ],
    },
    operations: {
      "public.list": page,
      "public.get": one,
      "my.list": page,
      "my.get": one,
      "my.create": (input) =>
        host.records
          .get(String(input.object))
          ?.set("rec_new", { id: "rec_new", ...(input.values as object) }) && { id: "rec_new" },
      "my.update": (input) => {
        const store = host.records.get(String(input.object));
        const before = store?.get(String(input.id)) ?? {};
        store?.set(String(input.id), { ...before, ...(input.values as object) } as never);
        return {};
      },
      "access.check": (input) => ({
        held: (input.ids as string[]).filter((i) => options.held?.includes(i)),
      }),
      "order.start": (input) => ({
        id: "ord_1",
        state: "pending",
        currency: "AUD",
        total: 9900,
        token: null,
        lines: input.lines,
      }),
      "media.list": () => ({
        items: [
          {
            object: "media",
            id: "med_handstand",
            values: { name: "handstand drills.mp4", kind: "video", state: "ready", duration: 300 },
          },
          {
            object: "media",
            id: "med_cooking",
            values: { name: "cooking.mp4", kind: "video", state: "ready" },
          },
        ],
        nextCursor: null,
      }),
      "query.sql": () => ({
        rows: [
          {
            courseId: "rec_course",
            title: "Handstands 101",
            active: 2,
            ended: 0,
            void: 1,
            lessonsDone: 5,
          },
        ],
      }),
    },
  });
  return host;
}

describe("the tools", () => {
  it("catalogue: the published courses, bundles and themes, with the host's currency", async () => {
    const host = hostWith();
    const out = await host.runTool<{
      courses: { id: string; lessons: number }[];
      currency: string;
      themes: unknown[];
      bundles: { courses: string[] }[];
    }>("catalogue", {}, { caller: PUBLIC });
    expect(out.courses).toEqual([
      expect.objectContaining({ id: "rec_course", lessons: 5, price: 99 }),
    ]);
    expect(out.bundles[0]?.courses).toEqual(["rec_course", "rec_other"]);
    expect(out.currency).toBe("AUD");
    expect(host.calls.map((c) => c.operation)).toEqual([
      "public.list",
      "public.list",
      "public.list",
    ]);
  });

  it("course: the outline's lessons, and for a holder that they hold it and what is done", async () => {
    const host = hostWith({ held: ["rec_course"] });
    const out = await host.runTool<{ holds: boolean; sections: { lessons: unknown[] }[] }>(
      "course",
      { slug: "handstands-101" },
      { caller: STUDENT },
    );
    expect(out.holds).toBe(true);
    expect(out.sections[0]?.lessons[0]).toEqual({
      key: "welcome",
      title: "Welcome",
      kind: "video",
      duration: 3,
      preview: true,
    });
    const publicOut = await hostWith().runTool<{ holds: boolean }>(
      "course",
      { slug: "handstands-101" },
      { caller: PUBLIC },
    );
    expect(publicOut.holds).toBe(false);
    await expect(
      hostWith().runTool("course", { slug: "nope" }, { caller: PUBLIC }),
    ).rejects.toThrow();
  });

  it("lesson: names the video for media.play; not found without access unless a preview", async () => {
    const holder = hostWith({ held: ["rec_course"] });
    const out = await holder.runTool<{
      video: { media: string; record: unknown; field: string };
      next: { key: string };
    }>("lesson", { courseId: "rec_course", lessonKey: "wrists" }, { caller: STUDENT });
    expect(out.video).toEqual({
      media: "med_wrists",
      poster: null,
      record: { object: "courses.course", id: "rec_course" },
      field: "outline",
    });
    expect(out.next.key).toBe("notes");
    const stranger = hostWith();
    await expect(
      stranger.runTool(
        "lesson",
        { courseId: "rec_course", lessonKey: "wrists" },
        { caller: STUDENT },
      ),
    ).rejects.toThrow(/No lesson/);
    const preview = await stranger.runTool<{ video: { media: string } }>(
      "lesson",
      { courseId: "rec_course", lessonKey: "welcome" },
      { caller: STUDENT },
    );
    expect(preview.video.media).toBe("med_preview");
  });

  it("progress: creates the row once, then updates it; a video near its end is done", async () => {
    const host = hostWith({ held: ["rec_course"] });
    const first = await host.runTool<{ state: string }>(
      "progress",
      { courseId: "rec_course", lessonKey: "wrists", position: 30 },
      { caller: STUDENT },
    );
    expect(first.state).toBe("started");
    expect(host.calls.some((c) => c.operation === "my.create")).toBe(true);
    const second = await host.runTool<{ state: string; done: number }>(
      "progress",
      { courseId: "rec_course", lessonKey: "wrists", position: 475, duration: 480 },
      { caller: STUDENT },
    );
    expect(second).toMatchObject({ state: "done", done: 1 });
    expect(host.calls.some((c) => c.operation === "my.update")).toBe(true);
    await expect(
      host.runTool("progress", { courseId: "rec_course", lessonKey: "nope" }, { caller: STUDENT }),
    ).rejects.toThrow();
  });

  it("myCourses: what the host says they hold, and why", async () => {
    const host = hostWith({
      held: ["rec_course"],
      enrolments: [
        {
          id: "rec_e1",
          holder: "per_student",
          bundle: "rec_bundle",
          status: "active",
          source: "purchase",
        },
      ],
    });
    const out = await host.runTool<{
      courses: { id: string; why: string; continueWith: string }[];
    }>("myCourses", {}, { caller: STUDENT });
    // The bundle lists two courses; the host says the student holds one of them now.
    expect(out.courses).toEqual([
      expect.objectContaining({ id: "rec_course", why: "bundle", continueWith: "welcome" }),
    ]);
  });

  it("myCourses: a published course the host says they hold with no enrolment is through their subscription", async () => {
    const host = hostWith({ held: ["rec_course"] });
    const out = await host.runTool<{ courses: { id: string; why: string }[] }>(
      "myCourses",
      {},
      { caller: STUDENT },
    );
    expect(out.courses).toEqual([
      expect.objectContaining({ id: "rec_course", why: "subscription" }),
    ]);
    // Whether they hold it is the host's answer (access.check), never the pack's own reading.
    expect(host.calls.map((c) => c.operation)).toContain("access.check");
    expect(host.calls.map((c) => c.operation)).not.toContain("subscription.list");
    // Holding nothing: nothing listed.
    const none = await hostWith().runTool<{ courses: unknown[] }>(
      "myCourses",
      {},
      { caller: STUDENT },
    );
    expect(none.courses).toEqual([]);
  });

  it("myCourses: reads each bundle once and a published course from the listing", async () => {
    const enrolment = { holder: "per_student", bundle: "rec_bundle", status: "active" };
    const host = hostWith({
      held: ["rec_course"],
      enrolments: [
        { id: "rec_e1", ...enrolment, source: "purchase" },
        { id: "rec_e2", ...enrolment, source: "staff" },
      ],
    });
    const out = await host.runTool<{ courses: { id: string; why: string }[] }>(
      "myCourses",
      {},
      { caller: STUDENT },
    );
    expect(out.courses).toEqual([expect.objectContaining({ id: "rec_course", why: "bundle" })]);
    const calls = host.calls.map((c) => c.operation);
    expect(calls.filter((c) => c === "public.get")).toHaveLength(1);
    expect(calls.filter((c) => c === "access.check")).toHaveLength(1);
    expect(calls).not.toContain("my.get");
  });

  it("myCourses: asks the host about every course, 100 at a time (access.check's most)", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `rec_c${String(i).padStart(3, "0")}`);
    const host = hostWith({
      held: ids,
      enrolments: ids.map((course, i) => ({
        id: `rec_e${i}`,
        holder: "per_student",
        course,
        status: "active",
        source: "purchase",
      })),
    });
    for (const id of ids) {
      host.records.get("courses.course")?.set(id, { id, title: id, price: 1, outline });
    }
    const out = await host.runTool<{ courses: { id: string }[] }>(
      "myCourses",
      {},
      { caller: STUDENT },
    );
    expect(out.courses.map((c) => c.id)).toEqual(ids);
    const asked = host.calls.filter((c) => c.operation === "access.check");
    expect(asked.every((c) => (c.input as { ids: string[] }).ids.length <= 100)).toBe(true);
  });

  it("plans: the plans on offer with the host's price and trial days, for anyone", async () => {
    const host = hostWith();
    const out = await host.runTool<{ plans: unknown[]; currency: string }>(
      "plans",
      {},
      { caller: PUBLIC },
    );
    expect(out).toEqual({
      plans: [
        { id: "rec_plan", title: "Every course", description: null, price: 29, trialDays: 7 },
      ],
      currency: "AUD",
    });
    expect(host.calls.map((c) => c.operation)).toEqual(["public.list"]);
  });

  it("buy: one line through order.start; a course already held is refused as not there", async () => {
    const host = hostWith();
    const order = await host.runTool<{ id: string }>(
      "buy",
      { courseId: "rec_course", email: "a@b.test" },
      { caller: PUBLIC },
    );
    expect(order.id).toBe("ord_1");
    expect(host.calls.find((c) => c.operation === "order.start")?.input).toMatchObject({
      lines: [{ object: "courses.course", id: "rec_course", quantity: 1 }],
      email: "a@b.test",
    });
    await expect(
      hostWith({ held: ["rec_course"] }).runTool(
        "buy",
        { courseId: "rec_course" },
        { caller: STUDENT },
      ),
    ).rejects.toThrow(/No courses.course/);
    await expect(host.runTool("buy", {}, { caller: PUBLIC })).rejects.toThrow();
  });

  it("enrol and endEnrolment: staff give access with a reason, and end only what was given", async () => {
    const host = hostWith();
    const given = await host.runTool<{ enrolmentId: string }>(
      "enrol",
      { personId: "per_student", courseId: "rec_course", reason: "A scholarship" },
      { caller: STAFF },
    );
    const row = host.records.get("courses.enrolment")?.get(given.enrolmentId);
    expect(row).toMatchObject({ source: "staff", holder: "per_student", course: "rec_course" });
    expect(String(row?.reason)).toContain("A scholarship");
    const ended = await host.runTool<{ status: string }>(
      "endEnrolment",
      { enrolmentId: given.enrolmentId, reason: "Asked to leave" },
      { caller: STAFF },
    );
    expect(ended.status).toBe("ended");
    const bought = await host.runTool<{ enrolmentId: string }>(
      "enrol",
      { personId: "per_x", courseId: "rec_course", reason: "test row" },
      { caller: STAFF },
    );
    host.records.get("courses.enrolment")?.set(bought.enrolmentId, {
      ...host.records.get("courses.enrolment")?.get(bought.enrolmentId),
      source: "purchase",
    } as never);
    await expect(
      host.runTool(
        "endEnrolment",
        { enrolmentId: bought.enrolmentId, reason: "Not here" },
        { caller: STAFF },
      ),
    ).rejects.toThrow(/refunded/);
  });

  it("stats: the host's numbers per course", async () => {
    const out = await hostWith().runTool<{ courses: { void: number }[] }>(
      "stats",
      {},
      { caller: STAFF },
    );
    expect(out.courses[0]).toMatchObject({ active: 2, void: 1, lessonsDone: 5 });
  });

  it("draft: a working copy from library videos that match the brief, never published", async () => {
    const host = hostWith();
    const out = await host.runTool<{ courseId: string; published: boolean; videos: string[] }>(
      "draft",
      { brief: "A beginner handstand course in 2 parts" },
      { caller: STAFF },
    );
    expect(out.published).toBe(false);
    expect(out.videos[0]).toBe("med_handstand");
    expect(host.calls.map((c) => c.operation)).not.toContain("record.publish");
    const made = host.records.get("courses.course")?.get(out.courseId) as
      | { outline: Outline }
      | undefined;
    expect(validateDocument(OUTLINE_SCHEMA, made?.outline).ok).toBe(true);
  });

  it("startSession: the student's own session for a session lesson", async () => {
    const host = hostWith({ held: ["rec_course"] });
    const out = await host.runTool<{ sessionId: string; preparing: boolean }>(
      "startSession",
      { courseId: "rec_course", lessonKey: "day-1" },
      { caller: STUDENT },
    );
    expect(out).toMatchObject({ sessionId: "rec_session", preparing: false });
    await expect(
      host.runTool(
        "startSession",
        { courseId: "rec_course", lessonKey: "wrists" },
        { caller: STUDENT },
      ),
    ).rejects.toThrow();
  });

  it("assignSessions: assigns a course's session programs once, from today", async () => {
    const host = hostWith();
    host.records.get("courses.progress")?.set("rec_p", {
      id: "rec_p",
      holder: "per_student",
      course: "rec_course",
      lessonKey: "welcome",
    });
    host.publish("courses.course", "rec_course");
    const assigned: unknown[] = [];
    const run = await createTestHost(courses, {
      validate: { knownObjects: ["programs.program", "programs.assignment", "programs.session"] },
      records: {
        "courses.course": [{ id: "rec_course", title: "C", price: 1, outline }],
        "courses.progress": [
          { id: "rec_p", holder: "per_student", course: "rec_course", lessonKey: "welcome" },
        ],
        "programs.assignment": [],
      },
      operations: {
        "x.programs.assign": (input) => {
          assigned.push(input);
          return {
            assignmentId: "rec_a",
            programVersion: 1,
            sessions: 3,
            startDate: "x",
            endDate: "y",
          };
        },
      },
    });
    run.publish("courses.course", "rec_course");
    const result = await run.runAutomation("assignSessions", {
      record: { object: "courses.progress", id: "rec_p" },
      action: "created",
    } as never);
    expect(result.error).toBeNull();
    expect(assigned).toEqual([
      expect.objectContaining({ programId: "rec_program", personId: "per_student" }),
    ]);
  });
});
