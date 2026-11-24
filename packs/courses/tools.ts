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
import { WEEK } from "./dashboards.ts";
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
export const PLAN = "courses.plan";
const PROGRAM = "programs.program";
const SESSION = "programs.session";

export interface RecordShape {
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

/** The most ids one access.check takes. */
const ACCESS_CHECK_MAX = 100;

/**
 * Of these courses, the ones the caller holds access to: the host's answer (ADR 0477), asked
 * `ACCESS_CHECK_MAX` at a time.
 */
async function held(ctx: ExtensionContext, ids: string[]): Promise<Set<string>> {
  if (!ids.length || !isCustomer(ctx)) return new Set();
  const batches: string[][] = [];
  for (let at = 0; at < ids.length; at += ACCESS_CHECK_MAX) {
    batches.push(ids.slice(at, at + ACCESS_CHECK_MAX));
  }
  const answers = await Promise.all(
    batches.map((batch) =>
      ctx.ops.call<{ held: string[] }>("access.check", { object: COURSE, ids: batch }),
    ),
  );
  return new Set(answers.flatMap((answer) => answer.held));
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
/** A picture or a video field's value, as the host gives it. */
type Picture = z.infer<typeof picture>;
type Video = z.infer<typeof video>;
const pictureOf = (value: unknown) => (value as Picture | undefined) ?? null;

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
    cover: pictureOf(v.cover),
    trailer: (v.trailer as Video | undefined) ?? null,
    price: num(v.price),
    lessons: outline.sections.reduce((n, s) => n + (s.lessons?.length ?? 0), 0),
  };
}

/** What everyone who may read the course reads of a lesson (`lessonSummary`). */
const summaryOfLesson = (l: Lesson): z.infer<typeof lessonSummary> => ({
  key: l.key,
  title: l.title,
  kind: l.kind,
  duration: l.duration ?? null,
  preview: l.preview === true,
});

function summaryOf(outline: Outline) {
  return outline.sections.map((section) => ({
    key: section.key,
    title: section.title,
    lessons: (section.lessons ?? []).map(summaryOfLesson),
  }));
}

type ProgressState = "started" | "done";

/** A progress row's state, or null when it has none. */
const stateOf = (row: RecordShape | null | undefined): ProgressState | null => {
  const state = row?.values.state;
  return state === "started" || state === "done" ? state : null;
};

/** The keys of the lessons these progress rows mark done. */
const doneKeys = (rows: Map<string, RecordShape>): Set<string> =>
  new Set([...rows].filter(([, row]) => stateOf(row) === "done").map(([key]) => key));

/** The caller's own progress rows on a course, by lesson key. */
async function progressRows(ctx: ExtensionContext, courseId: string) {
  const page = await ctx.ops.call<ListShape>("my.list", {
    object: PROGRESS,
    filter: { field: "course", op: "eq", value: courseId },
    limit: 200,
  });
  return new Map(page.items.map((row) => [String(row.values.lessonKey), row]));
}

/** The caller's own progress row on one lesson of a course, if they have one. */
async function progressRow(ctx: ExtensionContext, courseId: string, lessonKey: string) {
  const page = await ctx.ops.call<ListShape>("my.list", {
    object: PROGRESS,
    filter: {
      and: [
        { field: "course", op: "eq", value: courseId },
        { field: "lessonKey", op: "eq", value: lessonKey },
      ],
    },
    limit: 1,
  });
  return page.items[0] ?? null;
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
        picture: pictureOf(t.values.picture),
      })),
      courses: courses.items.map(card),
      bundles: bundles.items.map((b) => ({
        id: b.id,
        title: text(b.values.title),
        slug: text(b.values.slug),
        summary: text(b.values.summary),
        cover: pictureOf(b.values.cover),
        courses: bundleCourses(b),
        price: num(b.values.price),
      })),
      currency: courses.currency ?? bundles.currency ?? null,
    };
  },
});

// --- Course plans --------------------------------------------------------------------------------

export const plans = defineTool({
  description:
    "The course plans on offer: a subscription to every published course, paid every month. Each " +
    "plan's title, description, price per month (in the major unit of `currency`) and the days of " +
    "its free trial. Whether a person gets the trial is the host's, when they subscribe " +
    "(subscription.start): one per person, signed in. Read-only.",
  input: z.object({}),
  output: z.object({
    plans: z.array(
      z.object({
        id: z.string(),
        title: z.string().nullable(),
        description: z.string().nullable(),
        price: z.number().nullable().describe("Per month, in the major unit of `currency`"),
        trialDays: z.number().nullable(),
      }),
    ),
    currency,
  }),
  risk: "read",
  audiences: ["customer", "public"],
  async handler(_input, ctx) {
    const page = await ctx.ops.call<ListShape>("public.list", {
      object: PLAN,
      sort: { field: "price", direction: "asc" },
      limit: 20,
    });
    return {
      plans: page.items.map((p) => ({
        id: p.id,
        title: text(p.values.title),
        description: text(p.values.description),
        price: num(p.values.price),
        trialDays: num(p.values.trialDays),
      })),
      currency: page.currency ?? null,
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
    const done = holds ? doneKeys(await progressRows(ctx, record.id)) : new Set<string>();
    return {
      ...card(record),
      description: record.values.description ?? null,
      sections: summaryOf(outline),
      currency: page.currency ?? null,
      holds,
      done: [...done],
      complete: completion(outline, done).complete,
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
      const record = await ctx.ops.call<RecordShape>("my.get", {
        object: COURSE,
        id: input.courseId,
      });
      outline = asOutline(record.values.outline);
    }
    const found = findLesson(outline, input.lessonKey);
    if (!found) throw notFound("lesson", input.lessonKey);
    const holds = isStaff(ctx) || (await held(ctx, [input.courseId])).has(input.courseId);
    if (!holds && found.preview !== true) throw notFound("lesson", input.lessonKey);
    const row = isCustomer(ctx) ? await progressRow(ctx, input.courseId, found.key) : null;
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
      state: stateOf(row),
      next: after ? summaryOfLesson(after) : null,
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
    const [record, rows] = await Promise.all([
      ctx.ops.call<RecordShape>("my.get", { object: COURSE, id: input.courseId }),
      progressRows(ctx, input.courseId),
    ]);
    const outline = asOutline(record.values.outline);
    if (!findLesson(outline, input.lessonKey)) throw notFound("lesson", input.lessonKey);
    const existing = rows.get(input.lessonKey);
    const now = new Date().toISOString();
    const ended = input.position !== undefined && watchedToEnd(input.position, input.duration);
    const before = stateOf(existing);
    const state: ProgressState =
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
    const done = doneKeys(rows);
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

/** Why a student holds a course, as My courses says it. */
const WHY = ["bought", "bundle", "given", "imported", "subscription"] as const;
type Why = (typeof WHY)[number];
/** An enrolment's source, as a reason; any other (a purchase) is "bought". */
const WHY_BY_SOURCE = new Map<unknown, Why>([
  ["staff", "given"],
  ["import", "imported"],
]);

export const myCourses = defineTool({
  description:
    "Every course the signed-in student holds access to and why (bought, in a bundle, given by " +
    "staff, imported, or through their course subscription), with how far they are (lessons " +
    "done of those that count, complete) and the lesson to continue with. The host says which " +
    "they hold; nothing here decides it. Read-only.",
  input: z.object({}),
  output: z.object({
    courses: z.array(
      courseCard.extend({
        why: z.enum(WHY),
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
    // A course subscription covers every published course (ADR 0488): the published ones the host
    // says they hold that no enrolment of theirs explains are through it.
    const [enrolments, published] = await Promise.all([
      ctx.ops.call<ListShape>("my.list", { object: ENROLMENT, limit: 200 }),
      ctx.ops.call<ListShape>("public.list", {
        object: COURSE,
        sort: { field: "title", direction: "asc" },
        limit: 100,
      }),
    ]);
    // Each bundle once, as its published version lists its courses; one no longer published
    // gives nothing to list.
    const bundleIds = new Set(enrolments.items.map((e) => text(e.values.bundle)));
    bundleIds.delete(null);
    const bundles = new Map(
      await Promise.all(
        [...bundleIds].map(async (bundleId) => {
          const bundle = await ctx.ops
            .call<RecordShape>("public.get", { object: BUNDLE, id: bundleId })
            .catch(() => null);
          return [bundleId, bundle ? bundleCourses(bundle) : []] as const;
        }),
      ),
    );
    const why = new Map<string, Why>();
    const completed = new Set<string>();
    for (const e of enrolments.items) {
      const courseId = text(e.values.course);
      const bundleId = text(e.values.bundle);
      if (courseId) {
        if (!why.has(courseId)) why.set(courseId, WHY_BY_SOURCE.get(e.values.source) ?? "bought");
        if (e.values.completed === true) completed.add(courseId);
      }
      for (const c of bundleId ? (bundles.get(bundleId) ?? []) : []) {
        if (!why.has(c)) why.set(c, "bundle");
      }
    }
    const others = published.items.map((c) => c.id).filter((c) => !why.has(c));
    // Which of these the host says they hold now (live, in its state, inside its until), asked once.
    const holding = await held(ctx, [...why.keys(), ...others]);
    for (const c of others) if (holding.has(c)) why.set(c, "subscription");
    const publishedById = new Map(published.items.map((c) => [c.id, c]));
    const out = [];
    for (const courseId of [...why.keys()].filter((c) => holding.has(c))) {
      // A published course is already here as the caller reads it; another is asked for.
      const record =
        publishedById.get(courseId) ??
        (await ctx.ops.call<RecordShape>("my.get", { object: COURSE, id: courseId }));
      const outline = asOutline(record.values.outline);
      const done = doneKeys(await progressRows(ctx, courseId));
      const sum = completion(outline, done, completed.has(courseId));
      const first = outline.sections
        .flatMap((s) => s.lessons ?? [])
        .find((l) => l.kind !== "download" && !done.has(l.key));
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
      agreements: z
        .array(z.record(z.string(), z.unknown()))
        .max(20)
        .optional()
        .describe(
          "A guest only: their acceptances of what is due, passed on to the host as they are (each " +
            "{ versionId, typedName, signature?, answers? }); the host checks and records them. A " +
            "signed-in member agrees first.",
        ),
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
      if (mine.items.some((e) => e.values.status === "active"))
        throw notFound(BUNDLE, input.bundleId);
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
      ...(input.agreements === undefined ? {} : { agreements: input.agreements }),
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
        reason:
          `${input.reason}${ctx.caller?.kind === "staff" ? ` (${ctx.caller.name})` : ""}`.slice(
            0,
            1000,
          ),
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
      sql: `SELECT ${WEEK("p.done_at")} AS week,
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
    const videos = [...library.items]
      .sort((a, b) => score(b) - score(a))
      .slice(0, sectionsWanted * 3);
    const lessons: Lesson[] = videos.map((v, i) => {
      const seconds = num(v.values.duration);
      return {
        kind: "video",
        key: `lesson-${i + 1}`,
        title: String(v.values.name ?? `Lesson ${i + 1}`)
          .replace(/\.[a-z0-9]{2,4}$/i, "")
          .slice(0, 200),
        video: { media: v.id },
        ...(seconds ? { duration: Math.ceil(seconds / 60) } : {}),
      };
    });
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
    // As many parts as the lessons fill, `per` lessons each; one empty part when there are none.
    const per = Math.max(1, Math.ceil(lessons.length / sectionsWanted));
    const sections = Array.from(
      { length: Math.max(1, Math.ceil(lessons.length / per)) },
      (_, s) => ({
        key: `part-${s + 1}`,
        title: `Part ${s + 1}`,
        lessons: lessons.slice(s * per, (s + 1) * per),
      }),
    );
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
    const record = await ctx.ops.call<RecordShape>("my.get", {
      object: COURSE,
      id: input.courseId,
    });
    const found = findLesson(asOutline(record.values.outline), input.lessonKey);
    if (found?.kind !== "session") throw notFound("lesson", input.lessonKey);
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
