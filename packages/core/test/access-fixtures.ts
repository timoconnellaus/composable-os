// Stage 42, step 3 (ADR 0477): a course with holders' parts, a bundle, and enrolments, for the
// access tests and the stage 22 isolation suite. A course's outline is public in its titles and
// for holders in its lessons' videos and notes (unless a lesson is a free preview); a bundle
// lists courses in a document; an enrolment is a customer's, in a state, with an `until`.
import {
  type ActingUser,
  type CustomerPrincipal,
  createFakeStream,
  invoke,
  setVideoHost,
  videoHost,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, unique } from "./helpers.ts";

export const ACCESS_EXT = extId("crs");
export const COURSE = `${ACCESS_EXT}.course`;
export const BUNDLE = `${ACCESS_EXT}.bundle`;
export const ENROLMENT = `${ACCESS_EXT}.enrolment`;

export const FAKE_STREAM_BASE = "https://host.test/api/v1/media/fake-stream";

const SOURCE = { states: ["active"], until: "until" };

export function accessManifest(ext = ACCESS_EXT) {
  const course = `${ext}.course`;
  return manifest(ext, {
    objects: {
      course: {
        label: "Course",
        plural: "Courses",
        titleField: "title",
        fields: {
          title: { type: "text", label: "Title", required: true },
          slug: { type: "slug", label: "Slug" },
          trailer: { type: "video", label: "Trailer" },
          outline: {
            type: "document",
            label: "Outline",
            schema: {
              root: {
                type: "object",
                fields: {
                  lessons: {
                    type: "array",
                    max: 50,
                    of: {
                      type: "object",
                      fields: {
                        key: { type: "text", max: 40 },
                        title: { type: "text", max: 200 },
                        preview: { type: "boolean", optional: true },
                        video: {
                          type: "object",
                          optional: true,
                          fields: { media: { type: "ref", to: "media", media: "video" } },
                        },
                        notes: { type: "text", max: 2000, optional: true },
                      },
                      // The title is for everyone who reads the course; the video and notes for
                      // holders, unless the lesson is a free preview.
                      holders: { keys: ["video", "notes"], unless: "preview" },
                    },
                  },
                  staffNote: {
                    type: "object",
                    optional: true,
                    private: true,
                    fields: {
                      text: { type: "text", max: 200 },
                      clip: { type: "ref", to: "media", media: "video", optional: true },
                    },
                  },
                },
              },
            },
          },
        },
        publishable: { content: ["title", "trailer", "outline"], slug: "slug" },
        public: { read: ["title", "slug", "trailer", "outline"] },
        access: {
          sources: [
            { via: `${ext}.enrolment`, field: "course", ...SOURCE },
            { via: `${ext}.enrolment`, field: "bundle", through: "courses", ...SOURCE },
          ],
        },
      },
      bundle: {
        label: "Bundle",
        plural: "Bundles",
        titleField: "title",
        fields: {
          title: { type: "text", label: "Title", required: true },
          slug: { type: "slug", label: "Slug" },
          courses: {
            type: "document",
            label: "Courses",
            schema: {
              root: {
                type: "object",
                fields: { items: { type: "array", max: 10, of: { type: "ref", to: course } } },
              },
            },
          },
        },
        publishable: { content: ["title", "courses"], slug: "slug" },
        public: { read: ["title", "slug", "courses"] },
      },
      enrolment: {
        label: "Enrolment",
        plural: "Enrolments",
        titleField: "code",
        fields: {
          code: { type: "text", label: "Code", required: true },
          holder: { type: "relation", label: "Holder", to: "person" },
          course: { type: "relation", label: "Course", to: course },
          bundle: { type: "relation", label: "Bundle", to: `${ext}.bundle` },
          status: {
            type: "select",
            label: "Status",
            options: [
              { value: "active", label: "Active" },
              { value: "ended", label: "Ended" },
              { value: "void", label: "Void" },
            ],
          },
          until: { type: "datetime", label: "Until" },
        },
        states: {
          field: "status",
          initial: "active",
          moves: [
            { from: "active", to: "ended", by: ["staff"] },
            // A refund in full moves a grant here (ADR 0435); staff stand in for it here.
            { from: "active", to: "void", by: ["staff"], final: true },
          ],
        },
        customer: {
          field: "holder",
          read: ["code", "course", "bundle", "status", "until"],
          write: [],
        },
      },
    },
  });
}

/** The fake Stream for these tests (one per isolate). */
export function fakeStream() {
  const existing = videoHost() as ReturnType<typeof createFakeStream> | undefined;
  if (existing?.fake) return existing;
  const made = createFakeStream({ baseUrl: FAKE_STREAM_BASE, autoReady: true });
  setVideoHost(made);
  return made;
}

/** A ready video in the library. */
export async function readyVideo(admin: ActingUser, name: string): Promise<string> {
  const stream = fakeStream();
  const asked = await invoke("media.videoUpload", { name, bytes: 1000 }, context(admin));
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(1000)]), name);
  await stream.fake.handle(new Request(String(asked.upload?.url), { method: "POST", body: form }));
  await invoke("media.videoRefresh", { id: asked.item.id }, context(admin));
  return asked.item.id;
}

export async function member(admin: ActingUser, label: string): Promise<CustomerPrincipal> {
  const person = await invoke(
    "person.create",
    { givenName: label, familyName: unique("Student") },
    context(admin),
  );
  return { kind: "customer", customerId: `cus_${unique(label)}`, personId: person.id };
}

export interface AccessWorld {
  course: string;
  other: string;
  bundle: string;
  lessonVideo: string;
  previewVideo: string;
  trailer: string;
  otherVideo: string;
  privateVideo: string;
  holder: CustomerPrincipal;
  bundleHolder: CustomerPrincipal;
  stranger: CustomerPrincipal;
  voided: CustomerPrincipal;
  lapsed: CustomerPrincipal;
}

const create = async (admin: ActingUser, object: string, values: Record<string, unknown>) =>
  (await invoke("record.create", { object, values }, context(admin))).id;

/** The outline of a course: a free preview lesson and a lesson for holders. */
export function outline(
  lessonVideo: string,
  previewVideo: string,
  notes = "Holders-only-notes",
  privateVideo?: string,
) {
  return {
    lessons: [
      {
        key: "intro",
        title: "Welcome",
        preview: true,
        video: { media: previewVideo },
        notes: "Preview-notes",
      },
      { key: "one", title: "Lesson one", video: { media: lessonVideo }, notes },
    ],
    staffNote: { text: "Staff-only-note", ...(privateVideo ? { clip: privateVideo } : {}) },
  };
}

/**
 * Installs the courses fixture and makes: a course (a preview lesson, a holders' lesson, a
 * trailer), another course, a bundle of the other one, and five students: one enrolled in the
 * course, one in the bundle, one enrolled in nothing, one whose enrolment was voided (a refund),
 * one whose enrolment's `until` has passed. Everything published.
 */
export async function createAccessWorld(admin: ActingUser, ext = ACCESS_EXT): Promise<AccessWorld> {
  await reconcile(accessManifest(ext));
  const courseObject = `${ext}.course`;
  const lessonVideo = await readyVideo(admin, "lesson.mp4");
  const previewVideo = await readyVideo(admin, "preview.mp4");
  const trailer = await readyVideo(admin, "trailer.mp4");
  const otherVideo = await readyVideo(admin, "other.mp4");
  const privateVideo = await readyVideo(admin, "private.mp4");
  const course = await create(admin, courseObject, {
    title: "Handstands",
    trailer: { media: trailer },
    outline: outline(lessonVideo, previewVideo, undefined, privateVideo),
  });
  const other = await create(admin, courseObject, {
    title: "Mobility",
    outline: {
      lessons: [{ key: "m1", title: "Hips", video: { media: otherVideo }, notes: "Other-notes" }],
    },
  });
  const bundle = await create(admin, `${ext}.bundle`, {
    title: "Starter",
    courses: { items: [other] },
  });
  for (const [object, id] of [
    [courseObject, course],
    [courseObject, other],
    [`${ext}.bundle`, bundle],
  ] as const) {
    await invoke("record.publish", { object, id }, context(admin));
  }
  const holder = await member(admin, "Holder");
  const bundleHolder = await member(admin, "Bundler");
  const stranger = await member(admin, "Stranger");
  const voided = await member(admin, "Refunded");
  const lapsed = await member(admin, "Lapsed");
  const enrol = (who: CustomerPrincipal, values: Record<string, unknown>) =>
    create(admin, `${ext}.enrolment`, { code: unique("enr"), holder: who.personId, ...values });
  await enrol(holder, { course });
  await enrol(bundleHolder, { bundle });
  const refunded = await enrol(voided, { course });
  await invoke(
    "record.update",
    { object: `${ext}.enrolment`, id: refunded, values: { status: "void" } },
    context(admin),
  );
  await enrol(lapsed, { course, until: "2020-01-01T00:00:00.000Z" });
  return {
    course,
    other,
    bundle,
    lessonVideo,
    previewVideo,
    trailer,
    otherVideo,
    privateVideo,
    holder,
    bundleHolder,
    stranger,
    voided,
    lapsed,
  };
}
