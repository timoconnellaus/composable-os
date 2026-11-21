// `cos courses import` (stage 42, ADR 0495) against the real host: the CLI's own engine
// (packages/create-composable-os/src/courses-import) over cos-app's real HTTP surface and media
// routes, with a person's staff device session, as the command runs it, and the fake Stream as
// the video host. Programs and Courses are reconciled into the host from their own manifests.
//
// A folder imports (courses with videos by file and by link with captions, a bundle, a session
// lesson, enrolments, completions, lesson progress); a re-run changes and uploads nothing; an
// imported student can play a lesson's video and someone else cannot; rows that match nothing are
// reported with their file and line and the rest imports; a student's own progress since is kept;
// no AI actor can run any of it.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  applyPlan,
  type CustomerPrincipal,
  coreInvoker,
  createFakeStream,
  handleMedia,
  type InvocationContext,
  invoke,
  isMediaPath,
  issueDeviceSession,
  type OutsideInvocationContext,
  planReconcile,
  refreshSchemaRegistry,
  setVideoHost,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { toManifest } from "@composable-os/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  runCoursesImport,
  type VideoSource,
} from "../../../packages/create-composable-os/src/courses-import/engine.ts";
import {
  type CoursesFolder,
  readCoursesFolder,
} from "../../../packages/create-composable-os/src/courses-import/format.ts";
import {
  type ImportHost,
  sessionHost,
} from "../../../packages/create-composable-os/src/import-door/host.ts";
import courses from "../../../packs/courses/index.ts";
import programs from "../../../packs/programs/index.ts";
import { apiContext, handleApi } from "../src/server/http/api.ts";
import { mediaStoreFor } from "../src/server/media.ts";
import { boundTestEnv } from "./bound-env.ts";
import { ORIGIN, signUp, unique } from "./mcp-helpers.ts";

const hostEnv = boundTestEnv(env);
const db = createCrmDb(env.DB);
const STREAM = `${ORIGIN}/api/v1/media/fake-stream`;
const stream = createFakeStream({ baseUrl: STREAM, autoReady: false });
/** Stream finishing what it was sent: every video the fake was given is ready. */
const streamCatchesUp = async () => {
  for (const c of stream.fake.calls) {
    if ((c.method === "createUpload" || c.method === "copyFromUrl") && c.uid) {
      const v = stream.fake.video(c.uid);
      if (v?.state === "processing") stream.fake.finish(c.uid);
    }
  }
};
const COURSE = "courses.course";

async function serve(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/api/v1/media/fake-stream/")) return stream.fake.handle(request);
  if (isMediaPath(pathname)) {
    return handleMedia(request, {
      invoker: coreInvoker,
      context: (req) => apiContext(req, hostEnv),
      media: mediaStoreFor(hostEnv as never),
      uploads: true,
      tokenUploads: true,
    });
  }
  return (await handleApi(request, hostEnv)) ?? new Response("Not found", { status: 404 });
}
const fetcher = ((input: string, init?: RequestInit) =>
  serve(new Request(input, init))) as unknown as typeof fetch;

let admin: ActingUser;
let accessToken: string;
const asStaff = (): ImportHost =>
  sessionHost(ORIGIN, async () => ({ authorization: `Bearer ${accessToken}` }), fetcher);
const staff = (extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user: admin,
  origin: { surface: "ui" },
  db,
  ...extra,
});
const as = (principal: CustomerPrincipal): OutsideInvocationContext => ({ principal, db });

const tag = unique("crs")
  .toLowerCase()
  .replace(/[^a-z0-9]/g, "");
const email = (who: string) => `${who}-${tag}@students.test`;
const people: Record<string, CustomerPrincipal> = {};
let programId: string;

/** A video file in memory, as the CLI reads one from disk. */
async function memoryVideo(seed: number, size = 4096): Promise<VideoSource> {
  const bytes = new Uint8Array(size).map((_, i) => (i * 7 + seed) % 251);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { size, sha256, read: async (offset, length) => bytes.slice(offset, offset + length) };
}
const videoFiles = new Map<string, VideoSource>();

const vtt = (text: string) => new TextEncoder().encode(text);
const pdf = new TextEncoder().encode("%PDF-1.7\n% worksheet\n");

/** An old platform's export: two courses, a bundle, five students, access and progress. */
function folder(change: (f: CoursesFolder) => void = () => {}): CoursesFolder {
  const f: CoursesFolder = {
    courses: new Map([
      [
        `handstands-${tag}.json`,
        JSON.stringify({
          title: `Handstands ${tag}`,
          price: 99,
          level: 1,
          theme: `Balance ${tag}`,
          status: "published",
          trailer: { file: "trailer.mp4" },
          outline: {
            sections: [
              {
                key: "start",
                title: "Start here",
                lessons: [
                  {
                    kind: "video",
                    key: "wrists",
                    title: "Wrists",
                    sourceId: "lw-101",
                    video: {
                      file: "wrists.mp4",
                      captions: [{ language: "en", file: "wrists.srt", label: "English" }],
                    },
                  },
                  {
                    kind: "text",
                    key: "read",
                    title: "Read this",
                    sourceId: "lw-102",
                    body: {
                      blocks: [
                        { type: "paragraph", content: [{ type: "text", text: "Imported-text" }] },
                      ],
                    },
                  },
                  {
                    kind: "download",
                    key: "sheet",
                    title: "Worksheet",
                    sourceId: "lw-103",
                    file: "sheet.pdf",
                  },
                  {
                    kind: "session",
                    key: "day-1",
                    title: "Day one",
                    sourceId: "lw-104",
                    program: `Strength ${tag}`,
                    week: 1,
                    session: 0,
                  },
                ],
              },
            ],
          },
        }),
      ],
      [
        `mobility-${tag}.json`,
        JSON.stringify({
          title: `Mobility ${tag}`,
          price: 49,
          outline: {
            sections: [
              {
                key: "m",
                title: "Move",
                lessons: [
                  {
                    kind: "video",
                    key: "hips",
                    title: "Hips",
                    sourceId: "lw-201",
                    video: { url: `https://videos.example.com/${tag}/hips.mp4` },
                  },
                ],
              },
            ],
          },
        }),
      ],
    ]),
    bundles: new Map([
      [
        `starter-${tag}.json`,
        JSON.stringify({
          title: `Starter ${tag}`,
          price: 120,
          status: "published",
          courses: [`handstands-${tag}`, `mobility-${tag}`],
        }),
      ],
    ]),
    videos: new Map([
      ["wrists.mp4", 4096],
      ["trailer.mp4", 4096],
    ]),
    captions: new Map([["wrists.srt", vtt("1\n00:00:00,000 --> 00:00:01,500\nHello\n")]]),
    pictures: new Map(),
    downloads: new Map([["sheet.pdf", pdf]]),
    access: [
      "email,course,bundle,from,until,completed",
      `${email("ana")},handstands-${tag},,2024-01-01,,`,
      `${email("ben")},,starter-${tag},,,`,
      `${email("cy")},mobility-${tag},,,,true`,
      `${email("dee")},handstands-${tag},,,2020-01-01,`,
      `nobody-${tag}@students.test,handstands-${tag},,,,`,
    ].join("\n"),
    progress: [
      "email,course,lesson,state,done_at,position",
      `${email("ana")},handstands-${tag},lw-101,done,2024-02-01,`,
      `${email("ana")},handstands-${tag},lw-102,started,,`,
      `${email("ana")},handstands-${tag},lw-999,done,,`,
      `${email("eve")},handstands-${tag},lw-101,done,,`,
    ].join("\n"),
  };
  change(f);
  return f;
}

const run = (
  plan = readCoursesFolder(folder()),
  options: Parameters<typeof runCoursesImport>[2] = {},
) =>
  runCoursesImport(plan, asStaff(), {
    videoFiles: (name) => videoFiles.get(name),
    pollMs: 1,
    sleep: streamCatchesUp,
    ...options,
  });

beforeAll(async () => {
  setVideoHost(stream);
  const user = await signUp(hostEnv as never, "admin");
  admin = { id: user.id, email: user.email, name: "Admin", role: "admin" };
  for (const m of [programs, courses]) {
    const plan = await planReconcile(db.query, toManifest(m), { now: new Date().toISOString() });
    await applyPlan((statements) => db.batch(statements), plan);
    await refreshSchemaRegistry(db.query);
  }
  accessToken = (
    await issueDeviceSession(
      db,
      { audience: "staff", subjectId: admin.id },
      "Courses import test",
      new Date(),
    )
  ).accessToken;
  videoFiles.set("wrists.mp4", await memoryVideo(1));
  videoFiles.set("trailer.mp4", await memoryVideo(2));
  // The students come first, through the people import (here: as staff would have them).
  for (const who of ["ana", "ben", "cy", "dee"]) {
    const person = await invoke(
      "person.create",
      { givenName: who, emails: [{ email: email(who) }] },
      staff(),
    );
    people[who] = { kind: "customer", customerId: `cus_${who}${tag}`, personId: person.id };
  }
  // eve is not on the host (her people row did not import): her rows are reported, not guessed.
  // Two people cannot share an address here (person.create refuses it), so an address names one.
  const pike = await invoke(
    "record.create",
    { object: "programs.exercise", values: { name: "Pike", measure: "reps" } },
    staff(),
  );
  programId = (
    await invoke(
      "record.create",
      {
        object: "programs.program",
        values: {
          title: `Strength ${tag}`,
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
                            exercises: [{ exercise: pike.id, sets: [{ kind: "reps", reps: 5 }] }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
      staff(),
    )
  ).id;
  await invoke("record.publish", { object: "programs.program", id: programId }, staff());
}, 120_000);

afterAll(() => setVideoHost(undefined));

const courseId = async (key: string) =>
  (
    await env.DB.prepare(
      "SELECT record_id FROM core_import_key WHERE object_type = ? AND import_key = ?",
    )
      .bind(COURSE, key)
      .first<{ record_id: string }>()
  )?.record_id as string;

describe("cos courses import against the real host (ADR 0495)", () => {
  it("a course whose videos Stream has not finished is not written yet; a re-run writes it", async () => {
    const plan = readCoursesFolder(
      folder((f) => {
        f.courses = new Map([
          [
            `later-${tag}.json`,
            JSON.stringify({
              title: `Later ${tag}`,
              price: 10,
              outline: {
                sections: [
                  {
                    key: "s",
                    title: "S",
                    lessons: [
                      {
                        kind: "video",
                        key: "v",
                        title: "V",
                        video: { url: `https://videos.example.com/${tag}/later.mp4` },
                      },
                    ],
                  },
                ],
              },
            }),
          ],
        ]);
        f.bundles = new Map();
        f.access = null;
        f.progress = null;
      }),
    );
    const first = await run(plan, { waitMs: 0, sleep: async () => {} });
    expect(first.waiting.map((w) => w.file)).toEqual([`courses/later-${tag}.json`]);
    expect(await courseId(`later-${tag}`)).toBeUndefined();
    await streamCatchesUp();
    const again = await run(plan);
    expect(again.waiting).toEqual([]);
    expect(again.media.videosUploaded).toBe(0);
    expect(await courseId(`later-${tag}`)).toBeTruthy();
  });

  it("a bad folder stops before any write, each problem with its file and line", async () => {
    const plan = readCoursesFolder(
      folder((f) => {
        f.courses.set(
          "broken.json",
          JSON.stringify({
            title: "Broken",
            outline: {
              sections: [
                {
                  key: "s",
                  title: "S",
                  lessons: [{ kind: "video", key: "Bad Key", video: { file: "missing.mp4" } }],
                },
              ],
            },
          }),
        );
        f.access = `${f.access}\nnot-an-email,handstands-${tag},,,,`;
      }),
    );
    expect(plan.problems.map((p) => p.file)).toEqual(
      expect.arrayContaining(["courses/broken.json", "access.csv:7"]),
    );
    const report = await run(plan);
    expect(report.wroteNothing).toBe(true);
  });

  it("a dry run checks everything on the host and writes nothing", async () => {
    const report = await run(undefined, { dryRun: true });
    expect(report.problems).toEqual([]);
    expect(report.wroteNothing).toBe(true);
    expect(stream.fake.calls.filter((c) => c.method === "createUpload")).toHaveLength(0);
  });

  it("imports courses, a bundle, videos with captions, access, completions and progress", async () => {
    const report = await run(undefined, { publish: true, confirm: async () => true });
    expect(report.problems).toEqual([]);
    expect(report.waiting).toEqual([]);
    expect(report.media).toMatchObject({ uploaded: 1, videosUploaded: 3 });
    // The rows that matched nothing, with their file and line; the rest imported.
    expect(report.unmatched.map((u) => u.file).sort()).toEqual([
      "access.csv:6",
      "progress.csv:4",
      "progress.csv:5",
    ]);
    expect(report.unmatched.find((u) => u.file === "progress.csv:5")?.message).toContain(
      "No person on the host",
    );
    expect(report.unmatched.find((u) => u.file === "progress.csv:4")?.message).toContain(
      '"lw-999"',
    );
    const handstands = await courseId(`handstands-${tag}`);
    // The session lesson names the published program by id; the caption came over as WebVTT.
    const course = await invoke("record.get", { object: COURSE, id: handstands }, staff());
    expect(JSON.stringify(course.values.outline)).toContain(programId);
    expect(course.values.publishState).toBe("published");
    const wrists = (
      course.values.outline as {
        sections: { lessons: { key: string; video?: { media: string } }[] }[];
      }
    ).sections[0]?.lessons[0]?.video?.media as string;
    const played = await invoke("media.play", { id: wrists }, staff());
    expect(played.captions).toEqual([{ language: "en", label: "English" }]);
    // Access: imported as enrolments, never orders; the completed one is marked.
    const enrolments = await invoke(
      "record.list",
      {
        object: "courses.enrolment",
        filter: { field: "source", op: "eq", value: "import" },
        limit: 50,
      },
      staff(),
    );
    const mine = enrolments.items.filter((e) =>
      Object.values(people).some((p) => p.personId === e.values.holder),
    );
    expect(mine).toHaveLength(4);
    expect(mine.find((e) => e.values.holder === people.cy?.personId)?.values.completed).toBe(true);
    const orders = await env.DB.prepare("SELECT count(*) AS n FROM core_order WHERE person_id = ?")
      .bind(people.ana?.personId)
      .first<{ n: number }>();
    expect(orders?.n).toBe(0);
    // Progress by the lesson's sourceId.
    const progress = await invoke(
      "record.list",
      {
        object: "courses.progress",
        filter: { field: "holder", op: "eq", value: people.ana?.personId },
      },
      staff(),
    );
    expect(
      progress.items.map((p) => [p.values.lessonKey, p.values.state, p.values.source]).sort(),
    ).toEqual([
      ["read", "started", "import"],
      ["wrists", "done", "import"],
    ]);
    // Mobility had access but no progress rows: the report says so.
    expect(report.notes.map((n) => n.message)).toContain(
      "No lesson progress to bring for this course",
    );
  });

  it("an imported student plays the lesson's video; someone without access, and the lapsed one, cannot", async () => {
    const handstands = await courseId(`handstands-${tag}`);
    const ana = as(people.ana as CustomerPrincipal);
    const read = await invoke("my.get", { object: COURSE, id: handstands }, ana);
    expect(JSON.stringify(read.values)).toContain("Imported-text");
    const wrists = (
      read.values.outline as { sections: { lessons: { video?: { media: string } }[] }[] }
    ).sections[0]?.lessons[0]?.video?.media as string;
    const token = await invoke("media.play", { id: wrists }, ana);
    expect((await stream.fake.handle(new Request(token.hls))).status).toBe(200);
    // ben holds the bundle, which lists the course.
    expect(
      await invoke("media.play", { id: wrists }, as(people.ben as CustomerPrincipal)),
    ).toBeTruthy();
    for (const who of ["cy", "dee"]) {
      await expect(
        invoke("media.play", { id: wrists }, as(people[who] as CustomerPrincipal)),
      ).rejects.toMatchObject({
        code: "not_found",
      });
    }
  });

  it("a re-run changes nothing and uploads nothing", async () => {
    const before = stream.fake.calls.filter(
      (c) => c.method === "createUpload" || c.method === "copyFromUrl",
    ).length;
    const report = await run(undefined, { publish: true, confirm: async () => true });
    expect(report.problems).toEqual([]);
    expect(
      report.records.filter((r) => r.outcome === "created" || r.outcome === "updated"),
    ).toEqual([]);
    expect(report.media).toMatchObject({ uploaded: 0, videosUploaded: 0 });
    expect(
      stream.fake.calls.filter((c) => c.method === "createUpload" || c.method === "copyFromUrl"),
    ).toHaveLength(before);
    expect(report.published.every((p) => p.as === "unchanged")).toBe(true);
  });

  it("a student's own progress since the import is kept, and reported", async () => {
    const handstands = await courseId(`handstands-${tag}`);
    const ana = people.ana as CustomerPrincipal;
    // ana carries on watching: her imported row for "read" now says done, written as her.
    const row = (
      await invoke(
        "record.list",
        {
          object: "courses.progress",
          filter: {
            and: [
              { field: "holder", op: "eq", value: ana.personId },
              { field: "lessonKey", op: "eq", value: "read" },
            ],
          },
        },
        staff(),
      )
    ).items[0] as { id: string };
    await invoke(
      "record.update",
      { object: "courses.progress", id: row.id, values: { state: "done" } },
      staff(),
    );
    // and starts a lesson the export knows nothing of yet; the next export has it.
    await invoke(
      "record.create",
      {
        object: "courses.progress",
        values: {
          holder: ana.personId,
          course: handstands,
          lessonKey: "sheet",
          state: "started",
          source: "self",
        },
      },
      staff(),
    );
    const report = await run(
      readCoursesFolder(
        folder((f) => {
          f.progress = `${f.progress}\n${email("ana")},handstands-${tag},lw-103,done,,`;
        }),
      ),
    );
    const conflicts = report.records.filter((r) => r.outcome === "conflict").map((r) => r.file);
    expect(conflicts).toEqual(expect.arrayContaining(["progress.csv:3", "progress.csv:6"]));
    const kept = await invoke("record.get", { object: "courses.progress", id: row.id }, staff());
    expect(kept.values.state).toBe("done");
  });

  it("no AI actor can run it: the record import, the video uploads and the token routes are a person's", async () => {
    for (const actor of ["assistant", "mcp", "automation"] as const) {
      const ai = staff({ actor } as never);
      await expect(
        invoke(
          "record.import",
          { object: COURSE, records: [{ key: "x", values: { title: "x", price: 1 } }] },
          ai,
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        invoke("media.videoFromUrl", { name: "x", url: "https://videos.example.com/x.mp4" }, ai),
      ).rejects.toMatchObject({
        code: "forbidden",
      });
      await expect(invoke("media.videoUpload", { name: "x", bytes: 10 }, ai)).rejects.toMatchObject(
        { code: "forbidden" },
      );
    }
    // Stream copies from an https address only.
    await expect(
      invoke("media.videoFromUrl", { name: "x", url: "http://videos.example.com/x.mp4" }, staff()),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    // The caption route takes a staff device token only: a cookie, or none, is refused.
    const id = (
      await env.DB.prepare("SELECT id FROM core_media WHERE kind = 'video' LIMIT 1").first<{
        id: string;
      }>()
    )?.id;
    const refused = await serve(
      new Request(`${ORIGIN}/api/v1/media/${id}/captions?language=fr`, {
        method: "POST",
        body: vtt("WEBVTT\n"),
      }),
    );
    expect(refused.status).toBe(401);
  });
});
