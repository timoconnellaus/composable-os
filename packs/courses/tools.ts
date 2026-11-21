// The Courses tools. They become operations x.courses.<tool>, run in the sandbox, and reach the
// host only through ctx.ops. None holds a rule: a course's price, its sale window and what a paid
// line grants are `sellable`'s; who holds access to a course, and so which lesson parts a caller
// reads and which videos they may play, is the host's (`access`, the seam's one question, ADR
// 0477); progress is written only while the student holds access (`requireAccess`, ADR 0478). A
// tool asks, and reports what the host answered.
//
// A lesson's video plays with a token only `media.play` makes, in the host: `lesson` names the
// video and where it is shown, and the app asks `media.play` for it (ADR 0478: the signing key
// stays in cos-app).
import { defineTool, type ExtensionContext, OpsCallError, z } from "@composable-os/sdk";
import {
  asOutline,
  completion,
  findLesson,
  LESSON_KINDS,
  type Lesson,
  lessonVideo,
  nextLesson,
  type Outline,
  watchedToEnd,
} from "./outline.ts";

export const THEME = "courses.theme";
export const COURSE = "courses.course";
export const BUNDLE = "courses.bundle";
export const ENROLMENT = "courses.enrolment";
export const PROGRESS = "courses.progress";
const PROGRAM = "programs.program";
const SESSION = "programs.session";

interface RecordShape {
  id: string;
  title?: string | null;
  values: Record<string, unknown>;
}
interface ListShape {
  items: RecordShape[];
  nextCursor?: string | null;
  currency?: string | null;
}

const id = z.string().min(1).max(64);
const text = (value: unknown): string | null =>
  value === null || value === undefined || value === "" ? null : String(value);
const num = (value: unknown): number | null =>
  typeof value === "number" ? value : value == null || value === "" ? null : Number(value);

/** What a tool says for a course the caller may not see: the host's one not-found. */
const notFound = (what: string, which: string) =>
  new OpsCallError("not_found", `No ${what} with id ${which}`, { object: what, id: which });

const isCustomer = (ctx: ExtensionContext) => ctx.caller?.kind === "customer";
const isStaff = (ctx: ExtensionContext) => ctx.caller?.kind === "staff";

/** Of these courses, the ones the caller holds access to: the host's answer (ADR 0477). */
async function held(ctx: ExtensionContext, ids: string[]): Promise<Set<string>> {
  if (!ids.length || !isCustomer(ctx)) return new Set();
  const answer = await ctx.ops.call<{ held: string[] }>("access.check", {
    object: COURSE,
    ids: ids.slice(0, 100),
  });
  return new Set(answer.held);
}

/** The bundle's courses, as its published version lists them. */
const bundleCourses = (bundle: RecordShape): string[] => {
  const items = (bundle.values.courses as { items?: unknown[] } | null)?.items ?? [];
  return items.filter((x): x is string => typeof x === "string");
};

const picture = z
  .object({ media: z.string(), alt: z.string().optional() })
  .passthrough()
  .nullable();
const video = z.object({ media: z.string(), poster: z.string().optional() }).nullable();

const lessonSummary = z.object({
  key: z.string(),
  title: z.string(),
  kind: z.enum(LESSON_KINDS),
  duration: z.number().nullable(),
  preview: z.boolean(),
});

const courseCard = z.object({
  id: z.string(),
  title: z.string().nullable(),
  slug: z.string().nullable(),
  theme: z.string().nullable(),
  level: z.number().nullable(),
  summary: z.string().nullable(),
  cover: picture,
  trailer: video,
  price: z.number().nullable().describe("In the major unit of `currency`"),
  lessons: z.number(),
});

function card(record: RecordShape) {
  const v = record.values;
  const outline = asOutline(v.outline);
  return {
    id: record.id,
    title: text(v.title),
    slug: text(v.slug),
    theme: text(v.theme),
    level: num(v.level),
    summary: text(v.summary),
    cover: (v.cover as never) ?? null,
    trailer: (v.trailer as never) ?? null,
    price: num(v.price),
    lessons: outline.sections.reduce((n, s) => n + (s.lessons?.length ?? 0), 0),
  };
}

function summaryOf(outline: Outline) {
  return outline.sections.map((section) => ({
    key: section.key,
    title: section.title,
    lessons: (section.lessons ?? []).map((l) => ({
      key: l.key,
      title: l.title,
      kind: l.kind,
      duration: l.duration ?? null,
      preview: l.preview === true,
    })),
  }));
}

/** The caller's own progress rows on a course, by lesson key. */
async function progressRows(ctx: ExtensionContext, courseId: string) {
  const page = await ctx.ops.call<ListShape>("my.list", {
    object: PROGRESS,
    filter: { field: "course", op: "eq", value: courseId },
    limit: 200,
  });
  return new Map(page.items.map((row) => [String(row.values.lessonKey), row]));
}

const currency = z
  .string()
  .nullable()
  .describe("The currency prices are in (ISO 4217), the deployment's one; null until it is set");

// --- The catalogue -------------------------------------------------------------------------------

export const catalogue = defineTool({
  description:
    "The published courses, bundles and themes, for a catalogue page: each course's title, " +
    "theme, level, summary, cover, trailer, price and number of lessons; each bundle's courses " +
    "and price; the themes in their order. Prices are in the major unit of `currency`. Filter " +
    "by theme or level. Only what the public may read: a draft is not here. Read-only.",
  input: z.object({
    theme: id.optional(),
    level: z.number().int().min(1).max(3).optional(),
  }),
  output: z.object({
    themes: z.array(
      z.object({
        id: z.string(),
        name: z.string().nullable(),
        slug: z.string().nullable(),
        summary: z.string().nullable(),
        picture,
      }),
    ),
    courses: z.array(courseCard),
    bundles: z.array(
      z.object({
        id: z.string(),
        title: z.string().nullable(),
        slug: z.string().nullable(),
        summary: z.string().nullable(),
        cover: picture,
        courses: z.array(z.string()),
        price: z.number().nullable(),
      }),
    ),
    currency,
  }),
  risk: "read",
  audiences: ["customer", "public"],
  async handler(input, ctx) {
    const where = [
      ...(input.theme ? [{ field: "theme", op: "eq", value: input.theme }] : []),
      ...(input.level ? [{ field: "level", op: "eq", value: input.level }] : []),
    ];
    const [themes, courses, bundles] = await Promise.all([
      ctx.ops.call<ListShape>("public.list", {
        object: THEME,
        sort: { field: "order", direction: "asc" },
        limit: 100,
      }),
      ctx.ops.call<ListShape>("public.list", {
        object: COURSE,
        ...(where.length ? { filter: where.length === 1 ? where[0] : { and: where } } : {}),
        sort: { field: "title", direction: "asc" },
        limit: 100,
      }),
      ctx.ops.call<ListShape>("public.list", { object: BUNDLE, limit: 50 }),
    ]);
    return {
      themes: themes.items.map((t) => ({
        id: t.id,
        name: text(t.values.name),
        slug: text(t.values.slug),
        summary: text(t.values.summary),
        picture: (t.values.picture as never) ?? null,
      })),
      courses: courses.items.map(card),
      bundles: bundles.items.map((b) => ({
        id: b.id,
        title: text(b.values.title),
        slug: text(b.values.slug),
        summary: text(b.values.summary),
        cover: (b.values.cover as never) ?? null,
        courses: bundleCourses(b),
        price: num(b.values.price),
      })),
      currency: courses.currency ?? bundles.currency ?? null,
    };
  },
});

// --- One course ----------------------------------------------------------------------------------

export const course = defineTool({
  description:
    "One published course by its address (slug): its fields, its description, its outline's " +
    "sections and lessons (title, kind, minutes, whether a free preview) and, for a signed-in " +
    "customer, whether they hold access and which lessons they have done. Not found for a " +
    "draft or an unknown address. Read-only.",
  input: z.object({ slug: z.string().trim().min(1).max(200) }),
  output: courseCard.extend({
    description: z.unknown().describe("Rich text"),
    sections: z.array(
      z.object({ key: z.string(), title: z.string(), lessons: z.array(lessonSummary) }),
    ),
    currency,
    holds: z.boolean().describe("The caller holds access: show open, not buy"),
    done: z.array(z.string()).describe("The lesson keys the caller has done"),
    complete: z.boolean(),
  }),
  risk: "read",
  audiences: ["customer", "public"],
  async handler(input, ctx) {
    const page = await ctx.ops.call<ListShape>("public.list", {
      object: COURSE,
      filter: { field: "slug", op: "eq", value: input.slug },
      limit: 1,
    });
    const record = page.items[0];
    if (!record) throw notFound(COURSE, input.slug);
    const outline = asOutline(record.values.outline);
    const holds = (await held(ctx, [record.id])).has(record.id);
    const rows = holds ? await progressRows(ctx, record.id) : new Map<string, RecordShape>();
    const done = [...rows.values()]
      .filter((r) => r.values.state === "done")
      .map((r) => String(r.values.lessonKey));
    return {
      ...card(record),
      description: record.values.description ?? null,
      sections: summaryOf(outline),
      currency: page.currency ?? null,
      holds,
      done,
      complete: completion(outline, new Set(done)).complete,
    };
  },
});

// --- A lesson ------------------------------------------------------------------------------------

export const lesson = defineTool({
  description:
    "One lesson of a published course for someone who holds access to it (or any lesson marked " +
    "a free preview): its kind and its material (a video and notes, a page of text, a training " +
    "session, a download), where the student left its video, and the next lesson. A video is " +
    "named with where it is shown: the app asks media.play for a token to play it. Not found " +
    "without access, as a lesson that does not exist. Read-only.",
  input: z.object({ courseId: id, lessonKey: z.string().min(1).max(40) }),
  output: z.object({
    courseId: z.string(),
    lesson: z.record(z.string(), z.unknown()).describe("The lesson as the outline has it"),
    video: z
      .object({
        media: z.string(),
        poster: z.string().nullable(),
        record: z.object({ object: z.string(), id: z.string() }),
        field: z.string(),
      })
      .nullable()
      .describe("Pass to media.play to get a token and the address it plays at"),
    position: z.number().nullable().describe("Seconds: where the student left the video"),
    state: z.enum(["started", "done"]).nullable(),
    next: lessonSummary.nullable(),
  }),
  risk: "read",
  audiences: ["staff", "customer"],
  async handler(input, ctx) {
    // Staff read the published version; a customer the course as the seam shows them, which
    // has a lesson's material only when they hold access (or the lesson is a free preview).
    let outline: Outline;
    if (isStaff(ctx)) {
      const version = await ctx.ops.call<{ values: Record<string, unknown> }>("record.version", {
        object: COURSE,
        id: input.courseId,
      });
      outline = asOutline(version.values.outline);
    } else {
      const record = await ctx.ops.call<RecordShape>("my.get", { object: COURSE, id: input.courseId });
      outline = asOutline(record.values.outline);
    }
    const found = findLesson(outline, input.lessonKey);
    if (!found) throw notFound("lesson", input.lessonKey);
    const holds = isStaff(ctx) || (await held(ctx, [input.courseId])).has(input.courseId);
    if (!holds && found.preview !== true) throw notFound("lesson", input.lessonKey);
    const row = isCustomer(ctx) ? (await progressRows(ctx, input.courseId)).get(found.key) : null;
    const v = lessonVideo(found);
    const after = nextLesson(outline, found.key);
    const { section: _section, ...plain } = found;
    return {
      courseId: input.courseId,
      lesson: plain as Record<string, unknown>,
      video: v
        ? {
            media: v.media,
            poster: v.poster ?? null,
            record: { object: COURSE, id: input.courseId },
            field: "outline",
          }
        : null,
      position: row ? num(row.values.position) : null,
      state: row ? ((text(row.values.state) as "started" | "done" | null) ?? null) : null,
      next: after
        ? {
            key: after.key,
            title: after.title,
            kind: after.kind,
            duration: after.duration ?? null,
            preview: after.preview === true,
          }
        : null,
    };
  },
});

// --- Progress ------------------------------------------------------------------------------------

export const progress = defineTool({
  description:
    "Mark a lesson started or done, and keep where its video was left (seconds), for the " +
    "signed-in student. A video watched to within 10 seconds of its end counts as done (give " +
    "its `duration`). The host refuses it, as a course that does not exist, when the student " +
    "does not hold access to the course. Returns the lesson's progress and the course's.",
  input: z.object({
    courseId: id,
    lessonKey: z.string().min(1).max(40),
    state: z.enum(["started", "done"]).optional(),
    position: z.number().min(0).max(86_400).optional(),
    duration: z.number().min(0).max(86_400).optional().describe("The video's length, seconds"),
  }),
  output: z.object({
    lessonKey: z.string(),
    state: z.enum(["started", "done"]),
    position: z.number().nullable(),
    done: z.number(),
    counted: z.number(),
    complete: z.boolean(),
  }),
  risk: "write",
  audiences: ["customer"],
  async handler(input, ctx) {
    const record = await ctx.ops.call<RecordShape>("my.get", { object: COURSE, id: input.courseId });
    const outline = asOutline(record.values.outline);
    if (!findLesson(outline, input.lessonKey)) throw notFound("lesson", input.lessonKey);
    const rows = await progressRows(ctx, input.courseId);
    const existing = rows.get(input.lessonKey);
    const now = new Date().toISOString();
    const ended = input.position !== undefined && watchedToEnd(input.position, input.duration);
    const before = text(existing?.values.state) as "started" | "done" | null;
    const state: "started" | "done" =
      input.state === "done" || ended || before === "done" ? "done" : "started";
    const values: Record<string, unknown> = {
      state,
      ...(input.position !== undefined ? { position: input.position } : {}),
      ...(state === "done" && before !== "done" ? { doneAt: now } : {}),
    };
    // The host checks the student holds access to the course on create and on every update.
    if (existing) {
      await ctx.ops.call("my.update", { object: PROGRESS, id: existing.id, values });
    } else {
      await ctx.ops.call("my.create", {
        object: PROGRESS,
        values: { course: input.courseId, lessonKey: input.lessonKey, startedAt: now, ...values },
      });
    }
    const done = new Set(
      [...rows.values()].filter((r) => r.values.state === "done").map((r) => String(r.values.lessonKey)),
    );
    if (state === "done") done.add(input.lessonKey);
    const sum = completion(outline, done);
    return {
      lessonKey: input.lessonKey,
      state,
      position: input.position ?? num(existing?.values.position),
      done: sum.done,
      counted: sum.counted,
      complete: sum.complete,
    };
  },
});

// --- My courses ----------------------------------------------------------------------------------

export const myCourses = defineTool({
  description:
    "Every course the signed-in student holds access to and why (bought, in a bundle, given by " +
    "staff, imported), with how far they are (lessons done of those that count, complete) and " +
    "the lesson to continue with. The host says which they hold; nothing here decides it. " +
    "Read-only.",
  input: z.object({}),
  output: z.object({
    courses: z.array(
      courseCard.extend({
        why: z.enum(["bought", "bundle", "given", "imported"]),
        done: z.number(),
        counted: z.number(),
        complete: z.boolean(),
        continueWith: z.string().nullable().describe("The first lesson not done yet"),
      }),
    ),
  }),
  risk: "read",
  audiences: ["customer"],
  async handler(_input, ctx) {
    const enrolments = await ctx.ops.call<ListShape>("my.list", { object: ENROLMENT, limit: 200 });
    const why = new Map<string, "bought" | "bundle" | "given" | "imported">();
    const completed = new Set<string>();
    const bundles = new Map<string, string[]>();
    for (const e of enrolments.items) {
      const reason =
        e.values.source === "staff" ? "given" : e.values.source === "import" ? "imported" : "bought";
      const courseId = text(e.values.course);
      const bundleId = text(e.values.bundle);
      if (courseId) {
        if (!why.has(courseId)) why.set(courseId, reason);
        if (e.values.completed === true) completed.add(courseId);
      }
      if (bundleId && !bundles.has(bundleId)) {
        try {
          const bundle = await ctx.ops.call<RecordShape>("public.get", { object: BUNDLE, id: bundleId });
          bundles.set(bundleId, bundleCourses(bundle));
          for (const c of bundleCourses(bundle)) if (!why.has(c)) why.set(c, "bundle");
        } catch {
          // A bundle no longer published gives nothing to list.
        }
      }
    }
    // Which of these the host says they hold now (live, in its state, inside its until).
    const holding = await held(ctx, [...why.keys()]);
    const out = [];
    for (const courseId of [...why.keys()].filter((c) => holding.has(c))) {
      const record = await ctx.ops.call<RecordShape>("my.get", { object: COURSE, id: courseId });
      const outline = asOutline(record.values.outline);
      const rows = await progressRows(ctx, courseId);
      const done = new Set(
        [...rows.values()].filter((r) => r.values.state === "done").map((r) => String(r.values.lessonKey)),
      );
      const sum = completion(outline, done, completed.has(courseId));
      const first = outline.sections
        .flatMap((s) => s.lessons ?? [])
        .find((l: Lesson) => l.kind !== "download" && !done.has(l.key));
      out.push({
        ...card(record),
        why: why.get(courseId) ?? "bought",
        done: sum.done,
        counted: sum.counted,
        complete: sum.complete,
        continueWith: first?.key ?? null,
      });
    }
    return { courses: out };
  },
});

// --- Buying --------------------------------------------------------------------------------------

export const buy = defineTool({
  description:
    "Start an order for one course or one bundle. A signed-in customer buys as themselves; a " +
    "guest gives their email address. The host prices it from the record and refuses one " +
    "outside its sale window. A course the caller already holds access to is refused as one " +
    "that does not exist. Nothing is paid here: the buyer then calls order.checkout with the " +
    "order's id (and a guest's token) to pay on the provider's page. Amounts in the minor unit.",
  input: z
    .object({
      courseId: id.optional(),
      bundleId: id.optional(),
      email: z.string().trim().max(320).optional().describe("A guest's email address"),
    })
    .refine((v) => Boolean(v.courseId) !== Boolean(v.bundleId), {
      message: "Name a course or a bundle, not both",
    }),
  output: z.object({
    id: z.string(),
    state: z.string(),
    currency: z.string(),
    total: z.number(),
    token: z.string().nullable().describe("A guest's key to this order, shown once"),
  }),
  risk: "write",
  audiences: ["customer", "public"],
  async handler(input, ctx) {
    if (input.courseId && (await held(ctx, [input.courseId])).has(input.courseId)) {
      throw notFound(COURSE, input.courseId);
    }
    if (input.bundleId && isCustomer(ctx)) {
      const mine = await ctx.ops.call<ListShape>("my.list", {
        object: ENROLMENT,
        filter: { field: "bundle", op: "eq", value: input.bundleId },
        limit: 5,
      });
      if (mine.items.some((e) => e.values.status === "active")) throw notFound(BUNDLE, input.bundleId);
    }
    const order = await ctx.ops.call<{
      id: string;
      state: string;
      currency: string;
      total: number;
      token?: string | null;
    }>("order.start", {
      lines: [
        {
          object: input.courseId ? COURSE : BUNDLE,
          id: input.courseId ?? input.bundleId,
          quantity: 1,
        },
      ],
      pay: "full",
      ...(input.email === undefined ? {} : { email: input.email }),
    });
    return {
      id: order.id,
      state: order.state,
      currency: order.currency,
      total: order.total,
      token: order.token ?? null,
    };
  },
});

// --- Staff ---------------------------------------------------------------------------------------

const enrolmentOut = z.object({
  enrolmentId: z.string(),
  status: z.string(),
  source: z.string(),
});

export const enrol = defineTool({
  description:
    "Give a person access to a course or a bundle, recorded as given by staff with the reason, " +
    "until a date or for as long as it is offered. It is an enrolment like a bought one: the " +
    "person signs in with their email and finds the course. Returns the enrolment.",
  input: z
    .object({
      personId: id,
      courseId: id.optional(),
      bundleId: id.optional(),
      until: z.string().datetime({ offset: true }).optional(),
      reason: z.string().trim().min(3).max(500),
    })
    .refine((v) => Boolean(v.courseId) !== Boolean(v.bundleId), {
      message: "Name a course or a bundle, not both",
    }),
  output: enrolmentOut,
  risk: "write",
  permission: "courses:enrol",
  async handler(input, ctx) {
    const created = await ctx.ops.call<RecordShape>("record.create", {
      object: ENROLMENT,
      values: {
        code: `staff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        holder: input.personId,
        ...(input.courseId ? { course: input.courseId } : { bundle: input.bundleId }),
        source: "staff",
        reason: `${input.reason}${ctx.caller?.kind === "staff" ? ` (${ctx.caller.name})` : ""}`.slice(0, 1000),
        from: new Date().toISOString(),
        ...(input.until ? { until: input.until } : {}),
      },
    });
    return { enrolmentId: created.id, status: "active", source: "staff" };
  },
});

export const endEnrolment = defineTool({
  description:
    "End an enrolment staff gave or one that was imported, with the reason: the person no " +
    "longer holds access through it. A bought enrolment ends by a refund of its order, as " +
    "every grant does, and is refused here.",
  input: z.object({ enrolmentId: id, reason: z.string().trim().min(3).max(500) }),
  output: enrolmentOut,
  risk: "write",
  permission: "courses:enrol",
  async handler(input, ctx) {
    const row = await ctx.ops.call<RecordShape>("record.get", {
      object: ENROLMENT,
      id: input.enrolmentId,
    });
    if (row.values.source === "purchase" || !row.values.source) {
      throw new OpsCallError(
        "invalid_input",
        "A bought enrolment ends when its order is refunded in full, not here",
        { reason: "bought" },
      );
    }
    await ctx.ops.call("record.update", {
      object: ENROLMENT,
      id: input.enrolmentId,
      values: { status: "ended", reason: input.reason },
      from: "active",
    });
    return { enrolmentId: input.enrolmentId, status: "ended", source: String(row.values.source) };
  },
});

export const stats = defineTool({
  description:
    "For staff: enrolments by course (active, ended, void), how many students completed it " +
    "(every lesson that counts done), and lessons marked done by week. All courses, or one. " +
    "Read-only.",
  input: z.object({ courseId: id.optional() }),
  output: z.object({
    courses: z.array(
      z.object({
        courseId: z.string(),
        title: z.string().nullable(),
        active: z.number(),
        ended: z.number(),
        void: z.number(),
        lessonsDone: z.number(),
      }),
    ),
    byWeek: z.array(z.object({ week: z.string(), done: z.number() })),
  }),
  risk: "read",
  async handler(input, ctx) {
    const only = input.courseId ? "WHERE c.id = :course" : "";
    const params = input.courseId ? { course: input.courseId } : {};
    const rows = await ctx.ops.call<{ rows: Record<string, unknown>[] }>("query.sql", {
      sql: `SELECT c.id AS courseId, c.title AS title,
  (SELECT count(*) FROM rec_x_courses_enrolment e WHERE e.course = c.id AND e.status = 'active') AS active,
  (SELECT count(*) FROM rec_x_courses_enrolment e WHERE e.course = c.id AND e.status = 'ended') AS ended,
  (SELECT count(*) FROM rec_x_courses_enrolment e WHERE e.course = c.id AND e.status = 'void') AS void,
  (SELECT count(*) FROM rec_x_courses_progress p WHERE p.course = c.id AND p.state = 'done') AS lessonsDone
FROM rec_x_courses_course c ${only} ORDER BY c.title`,
      params,
    });
    const weeks = await ctx.ops.call<{ rows: Record<string, unknown>[] }>("query.sql", {
      sql: `SELECT date(p.done_at, '-' || ((strftime('%w', p.done_at) + 6) % 7) || ' days') AS week,
  count(*) AS done
FROM rec_x_courses_progress p WHERE p.state = 'done' AND p.done_at IS NOT NULL
${input.courseId ? "AND p.course = :course" : ""}
GROUP BY week ORDER BY week`,
      params,
    });
    return {
      courses: rows.rows.map((r) => ({
        courseId: String(r.courseId),
        title: text(r.title),
        active: Number(r.active ?? 0),
        ended: Number(r.ended ?? 0),
        void: Number(r.void ?? 0),
        lessonsDone: Number(r.lessonsDone ?? 0),
      })),
      byWeek: weeks.rows.map((r) => ({ week: String(r.week), done: Number(r.done ?? 0) })),
    };
  },
});

// --- The assistant's draft -----------------------------------------------------------------------

/** Words of a brief, for matching it to video names. */
const wordsOf = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );

export const draft = defineTool({
  description:
    'Draft a course from a brief ("a beginner handstand course in three parts") as a working ' +
    "copy for staff to edit: sections of lessons built only from videos already in the media " +
    "library (ready ones) and programs already published, with each lesson's title. It reads the " +
    "brief with the extract model role when the deployment has AI. It never publishes: a person " +
    "publishes it, and an assistant's request to publish waits for one (ADR 0480). Returns the " +
    "new course.",
  input: z.object({
    brief: z.string().trim().min(3).max(2000),
    title: z.string().trim().min(1).max(200).optional(),
  }),
  output: z.object({
    courseId: z.string(),
    title: z.string(),
    sections: z.number(),
    lessons: z.number(),
    videos: z.array(z.string()),
    programs: z.array(z.string()),
    published: z.literal(false),
  }),
  risk: "write",
  async handler(input, ctx) {
    const library = await ctx.ops.call<ListShape>("media.list", {
      filter: {
        and: [
          { field: "kind", op: "eq", value: "video" },
          { field: "state", op: "eq", value: "ready" },
        ],
      },
      limit: 200,
    });
    const programs = await ctx.ops.call<ListShape>("record.list", {
      object: PROGRAM,
      filter: { field: "publishState", op: "eq", value: "published" },
      limit: 50,
    });
    let sectionsWanted = 3;
    try {
      const read = await ctx.ai.extract(input.brief, {
        sections: "How many parts or sections the course has, a whole number from 1 to 12",
      });
      const n = Number(read.sections);
      if (Number.isInteger(n) && n >= 1 && n <= 12) sectionsWanted = n;
    } catch {
      const m = /\b(\d{1,2})\s+(?:parts|sections|modules)\b/i.exec(input.brief);
      if (m) sectionsWanted = Math.min(12, Math.max(1, Number(m[1])));
    }
    const brief = wordsOf(input.brief);
    const score = (r: RecordShape) =>
      [...wordsOf(String(r.values.name ?? ""))].filter((w) => brief.has(w)).length;
    const videos = [...library.items].sort((a, b) => score(b) - score(a)).slice(0, sectionsWanted * 3);
    const lessons: Lesson[] = videos.map((v, i) => ({
      kind: "video",
      key: `lesson-${i + 1}`,
      title: String(v.values.name ?? `Lesson ${i + 1}`)
        .replace(/\.[a-z0-9]{2,4}$/i, "")
        .slice(0, 200),
      video: { media: v.id },
      ...(num(v.values.duration) ? { duration: Math.ceil(Number(v.values.duration) / 60) } : {}),
    }));
    const program = programs.items[0];
    if (program) {
      lessons.push({
        kind: "session",
        key: "session-1",
        title: `Train: ${String(program.values.title ?? "session")}`.slice(0, 200),
        program: program.id,
        week: 1,
        session: 0,
      });
    }
    const per = Math.max(1, Math.ceil(lessons.length / sectionsWanted));
    const sections = [];
    for (let s = 0; s * per < lessons.length || (s === 0 && !lessons.length); s += 1) {
      sections.push({
        key: `part-${s + 1}`,
        title: `Part ${s + 1}`,
        lessons: lessons.slice(s * per, (s + 1) * per),
      });
      if (!lessons.length) break;
    }
    const title = input.title ?? `Draft: ${input.brief.slice(0, 60)}`;
    const created = await ctx.ops.call<RecordShape>("record.create", {
      object: COURSE,
      values: { title, price: 0, summary: input.brief.slice(0, 1000), outline: { sections } },
    });
    return {
      courseId: created.id,
      title,
      sections: sections.length,
      lessons: lessons.length,
      videos: videos.map((v) => v.id),
      programs: program ? [program.id] : [],
      published: false as const,
    };
  },
});

// --- Session lessons -----------------------------------------------------------------------------

export const startSession = defineTool({
  description:
    "For a session lesson: the signed-in student's own Programs session for it, once the " +
    "program is assigned to them (it is, from the day they first open the course: the dates " +
    "are a suggested pace). They then log sets with Programs' own tools. `preparing` while the " +
    "assignment is being made. Not found without access to the course.",
  input: z.object({ courseId: id, lessonKey: z.string().min(1).max(40) }),
  output: z.object({
    preparing: z.boolean(),
    sessionId: z.string().nullable(),
    date: z.string().nullable(),
    programId: z.string().nullable(),
  }),
  risk: "read",
  audiences: ["customer"],
  async handler(input, ctx) {
    const record = await ctx.ops.call<RecordShape>("my.get", { object: COURSE, id: input.courseId });
    const found = findLesson(asOutline(record.values.outline), input.lessonKey);
    if (!found || found.kind !== "session") throw notFound("lesson", input.lessonKey);
    // Without access the seam gave no program (a holders' part), so there is no session.
    if (!found.program || found.week === undefined || found.session === undefined) {
      throw notFound("lesson", input.lessonKey);
    }
    const sessions = await ctx.ops.call<ListShape>("my.list", {
      object: SESSION,
      filter: {
        and: [
          { field: "program", op: "eq", value: found.program },
          { field: "week", op: "eq", value: found.week },
          { field: "position", op: "eq", value: found.session },
        ],
      },
      sort: { field: "date", direction: "desc" },
      limit: 1,
    });
    const session = sessions.items[0];
    return {
      preparing: !session,
      sessionId: session?.id ?? null,
      date: session ? text(session.values.date) : null,
      programId: found.program,
    };
  },
});
