// The Courses pack's headless entry (stage 42, step 7; ADRs 0418 and 0453): functions and hooks
// over the typed client, no markup. A client app imports it as `@composable-os/pack-courses/client`
// and hands it its generated client; the courses blocks render what it returns.
//
// Nothing here decides who may watch, what is for sale or what a course costs. A lesson's material
// arrives only for a holder (the host removes it for everyone else), and a video plays only with a
// token the host signs in `media.play`, which `usePlayback` asks for again before it expires.
import { type ClientHolding, type PackClient, packHooks } from "@composable-os/client";
import type { z } from "@composable-os/sdk";
import {
  LESSON_KINDS,
  type Lesson,
  type LessonKind,
  type Outline,
  type Section,
} from "../outline.ts";
import type {
  buy,
  catalogue,
  course,
  endEnrolment,
  enrol,
  lesson,
  myCourses,
  plans,
  progress,
  startSession,
  stats,
} from "../tools.ts";

export { completion, findLesson, lessonsOf, nextLesson, watchedToEnd } from "../outline.ts";
export type { Lesson, LessonKind, Outline, Section };

type Io<T extends { input: z.ZodType; output: z.ZodType }> = {
  input: z.input<T["input"]>;
  output: z.output<T["output"]>;
};

export const COURSE = "courses.course";

/** What media.play answers (ADR 0476). */
export interface Playback {
  id: string;
  token: string;
  expiresAt: string;
  hls: string;
  dash: string;
  iframe: string;
  poster: string;
  duration: number | null;
  captions: { language: string; label: string }[];
}

export const PLAN = "courses.plan";

/** A subscription as its payer reads it (`subscription.list`, stage 32a). */
export interface CourseSubscription {
  id: string;
  state:
    | "incomplete"
    | "expired"
    | "trialing"
    | "active"
    | "past_due"
    | "unpaid"
    | "paused"
    | "ended";
  planObject: string;
  planId: string;
  planTitle: string;
  /** One period's price, in the currency's minor unit, tax included. */
  amount: number;
  currency: string;
  interval: "week" | "month" | "year";
  trialEnd: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
  endedAt: string | null;
  /** The provider's page to confirm a renewal on (3D Secure), while one waits. */
  actionUrl: string | null;
  createdAt: string;
}

/** Why the host gave no free trial on a plan that has one (subscription.start's `noTrial`). */
export type NoTrial = "sign_in" | "used" | "permission" | "held" | "unconfirmed";

/** What a member is told about a trial the host did not give. Display only. */
export function noTrialWords(reason: NoTrial): string {
  switch (reason) {
    case "sign_in":
      return "The free trial is for signed-in members. Sign in for it, or continue and pay from today.";
    case "used":
      return "You have had your free trial on this plan, so this one is paid from today.";
    case "held":
      return "A checkout with your free trial is already open. Finish that one, or continue and pay from today.";
    case "unconfirmed":
      return "We could not check your earlier checkout with the payment provider just now, so no free trial can be given yet. Try again in a few minutes, or continue and pay from today.";
    case "permission":
      return "A free trial cannot be given from here; this one is paid from today.";
  }
}

/** What subscription.start answers. */
export interface StartedSubscription {
  subscriptionId: string;
  url: string;
  amount: number;
  currency: string;
  interval: "week" | "month" | "year";
  trialDays: number | null;
  noTrial: NoTrial | null;
  expiresAt: string | null;
}

/** The operations this entry calls, as the generated client types them. */
export type CoursesOperations = {
  "x.courses.plans": { kind: "query" } & Io<typeof plans>;
  // The course subscription (stage 32a): the host's own operations, on the web only.
  "subscription.start": {
    kind: "mutation";
    input: {
      plan: { object: string; id: string };
      returnUrl: string;
      email?: string;
    };
    output: StartedSubscription;
  };
  "subscription.list": {
    kind: "query";
    input: { filter?: unknown; limit?: number };
    output: { items: CourseSubscription[]; nextCursor: string | null };
  };
  "subscription.cancel": {
    kind: "mutation";
    input: { id: string; reason?: string };
    output: { id: string; requested: true };
  };
  "subscription.resume": {
    kind: "mutation";
    input: { id: string };
    output: { id: string; requested: true };
  };
  "subscription.portal": {
    kind: "mutation";
    input: { returnUrl: string };
    output: { url: string };
  };
  "x.courses.catalogue": { kind: "query" } & Io<typeof catalogue>;
  "x.courses.course": { kind: "query" } & Io<typeof course>;
  "x.courses.lesson": { kind: "query" } & Io<typeof lesson>;
  "x.courses.myCourses": { kind: "query" } & Io<typeof myCourses>;
  "x.courses.startSession": { kind: "query" } & Io<typeof startSession>;
  "x.courses.progress": { kind: "mutation" } & Io<typeof progress>;
  "x.courses.buy": { kind: "mutation" } & Io<typeof buy>;
  "x.courses.enrol": { kind: "mutation" } & Io<typeof enrol>;
  "x.courses.endEnrolment": { kind: "mutation" } & Io<typeof endEnrolment>;
  "x.courses.stats": { kind: "query" } & Io<typeof stats>;
  "media.play": {
    kind: "query";
    input: {
      id: string;
      record?: { object: string; id: string };
      field?: string;
      purpose?: "stream";
      seconds?: number;
    };
    output: Playback;
  };
  "order.checkout": {
    kind: "mutation";
    input: { id: string; token?: string; returnUrl: string };
    output: { url: string };
  };
  // Staff: the course builder saves the working copy; a person publishes (ADR 0480: an assistant's
  // publish waits for one).
  "record.update": {
    kind: "mutation";
    input: { object: string; id: string; values: Record<string, unknown> };
    output: { id: string; values: Record<string, unknown> };
  };
  "record.get": {
    kind: "query";
    input: { object: string; id: string };
    output: { id: string; values: Record<string, unknown> };
  };
  "record.publish": {
    kind: "mutation";
    input: { object: string; id: string; note?: string };
    output: { version: number; publishedAt: string };
  };
  "media.list": {
    kind: "query";
    input: { filter?: unknown; limit?: number };
    output: { items: { id: string; values: Record<string, unknown> }[]; nextCursor: string | null };
  };
  "record.list": {
    kind: "query";
    input: { object: string; filter?: unknown; limit?: number };
    output: { items: { id: string; title?: string | null; values: Record<string, unknown> }[] };
  };
};

type In<N extends keyof CoursesOperations> = CoursesOperations[N]["input"];

export type CoursesClient = PackClient<CoursesOperations>;

// --- Plain functions ------------------------------------------------------------------------------

/** A token is asked for again this long before it expires. */
export const PLAYBACK_REFRESH_BEFORE_MS = 5 * 60_000;

/**
 * How long to wait before asking for a new token: until `PLAYBACK_REFRESH_BEFORE_MS` before it
 * expires, never less than 10 seconds (a token about to expire is asked for again at once after).
 */
export function refreshInMs(expiresAt: string, now = Date.now()): number {
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return 10_000;
  return Math.max(10_000, at - PLAYBACK_REFRESH_BEFORE_MS - now);
}

/** A price as the host gave it, in its currency (`99.00 AUD`). Display only: never worked out. */
export function formatPrice(
  price: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (price === null || price === undefined) return "";
  try {
    return currency
      ? new Intl.NumberFormat(undefined, { style: "currency", currency }).format(price)
      : String(price);
  } catch {
    return `${price}${currency ? ` ${currency}` : ""}`;
  }
}

/**
 * An amount the host gave in the currency's minor unit (a subscription's price per period), in
 * that currency: `29.00 AUD`. Display only: the minor unit's digits are the currency's own.
 */
export function formatMinor(minor: number, currency: string): string {
  try {
    const format = new Intl.NumberFormat(undefined, { style: "currency", currency });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(minor / 10 ** digits);
  } catch {
    return `${minor} ${currency}`;
  }
}

/** A date as a reader sees it (`3 Dec 2026`), from the host's ISO timestamp. Display only. */
export function day(iso: string | null | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? ""
    : at.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/**
 * What a subscription's state means to its member, in words, from what the host reports. Display
 * only: whether it gives access is the host's (the seam), never worked out from this.
 */
export function subscriptionStatus(sub: CourseSubscription): string {
  const ends = sub.cancelAtPeriodEnd ? sub.currentPeriodEnd : sub.cancelAt;
  switch (sub.state) {
    case "trialing":
      return ends
        ? `Free trial, ending on ${day(ends)}: nothing will be charged`
        : `Free trial until ${day(sub.trialEnd ?? sub.currentPeriodEnd)}, then charged each ${sub.interval}`;
    case "active":
      return ends
        ? `Active until ${day(ends)}, then it ends`
        : `Active: next charge on ${day(sub.currentPeriodEnd)}`;
    case "past_due":
      return sub.actionUrl
        ? "A payment needs you to confirm it"
        : "A payment failed: the payment provider will try again";
    case "unpaid":
      return "Unpaid: update your card to keep watching";
    case "paused":
      return "Paused";
    case "incomplete":
      return "Waiting for its first payment";
    case "expired":
      return "Never started: its first payment did not go through";
    case "ended":
      return `Ended${sub.endedAt ? ` on ${day(sub.endedAt)}` : ""}`;
  }
}

/** Whether a subscription is still the member's to cancel, resume or pay (not ended). */
export const isLive = (sub: CourseSubscription) => sub.state !== "ended" && sub.state !== "expired";

/** A lesson's length as a reader sees it: `12 min`. Display only. */
export function minutes(duration: number | null | undefined): string {
  return typeof duration === "number" && duration > 0 ? `${duration} min` : "";
}

/** Where a phone asks the host for a picture (the course cover): as the Content pack's. */
export function hostMediaUrl(hostUrl: string): (id: string, width: number) => string {
  const host = hostUrl.replace(/\/+$/, "");
  return (id, width) =>
    `${host}/api/v1/media/${encodeURIComponent(id)}${width ? `?w=${Math.round(width)}` : ""}`;
}

/** A picture on the site's own media route (`/api/media/<id>?w=`), for the web blocks. */
export function mediaPath(id: string, width?: number, base = ""): string {
  return `${base.replace(/\/+$/, "")}/api/media/${encodeURIComponent(id)}${width ? `?w=${Math.round(width)}` : ""}`;
}

// --- The course builder's pure outline edits (as Programs' layoutEdits) -------------------------

/** A key from a title, unused in `taken`: `wrist-prep`, `wrist-prep-2`. */
export function newKey(title: string, taken: ReadonlySet<string>): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "lesson";
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}-${n}`;
  return key;
}

const keysOf = (outline: Outline) =>
  new Set(outline.sections.flatMap((s) => [s.key, ...(s.lessons ?? []).map((l) => l.key)]));

/**
 * Pure edits of an outline: each returns a new outline and never changes a lesson's key once it
 * has one (progress is kept by it). The builder block saves the result with `record.update`.
 */
export const outlineEdits = {
  addSection(outline: Outline, title: string): Outline {
    return {
      sections: [...outline.sections, { key: newKey(title, keysOf(outline)), title, lessons: [] }],
    };
  },
  renameSection(outline: Outline, key: string, title: string): Outline {
    return {
      sections: outline.sections.map((s) => (s.key === key ? { ...s, title } : s)),
    };
  },
  removeSection(outline: Outline, key: string): Outline {
    return { sections: outline.sections.filter((s) => s.key !== key) };
  },
  addLesson(outline: Outline, section: string, kind: LessonKind, title: string): Outline {
    if (!LESSON_KINDS.includes(kind)) return outline;
    const key = newKey(title, keysOf(outline));
    const lesson = { kind, key, title } as Lesson;
    return {
      sections: outline.sections.map((s) =>
        s.key === section ? { ...s, lessons: [...(s.lessons ?? []), lesson] } : s,
      ),
    };
  },
  /** Changes a lesson's fields; its key and kind stay. */
  updateLesson(outline: Outline, key: string, patch: Record<string, unknown>): Outline {
    const { key: _key, kind: _kind, ...rest } = patch;
    return {
      sections: outline.sections.map((s) => ({
        ...s,
        lessons: (s.lessons ?? []).map((l) => (l.key === key ? ({ ...l, ...rest } as Lesson) : l)),
      })),
    };
  },
  removeLesson(outline: Outline, key: string): Outline {
    return {
      sections: outline.sections.map((s) => ({
        ...s,
        lessons: (s.lessons ?? []).filter((l) => l.key !== key),
      })),
    };
  },
  /** Moves a lesson to `index` of `section` (by drag or by keyboard). */
  moveLesson(outline: Outline, key: string, section: string, index: number): Outline {
    const moving = outline.sections.flatMap((s) => s.lessons ?? []).find((l) => l.key === key);
    if (!moving || !outline.sections.some((s) => s.key === section)) return outline;
    const without = outlineEdits.removeLesson(outline, key);
    return {
      sections: without.sections.map((s) => {
        if (s.key !== section) return s;
        const lessons = [...(s.lessons ?? [])];
        lessons.splice(Math.max(0, Math.min(index, lessons.length)), 0, moving);
        return { ...s, lessons };
      }),
    };
  },
};

// --- Hooks ---------------------------------------------------------------------------------------

/** The app's `useQuery`, as far as these hooks use it. */
export type UseQuery = <T>(options: {
  queryKey: readonly unknown[];
  queryFn: () => Promise<T>;
  enabled?: boolean;
  refetchInterval?:
    | number
    | false
    | ((query: { state: { data: T | undefined } }) => number | false);
}) => { data: T | undefined; isPending: boolean; error: unknown };

/** What a query hook returns, as `UseQuery` gives it. */
export interface QueryResult<T> {
  data: T | undefined;
  isPending: boolean;
  error: unknown;
}

/** A query's key and function, as the typed client gives them. */
interface QueryOptions<T> {
  queryKey: readonly unknown[];
  queryFn: () => Promise<T>;
}

type Out<N extends keyof CoursesOperations> = CoursesOperations[N]["output"];

/** The app's `useMutation`, as far as these hooks use it. */
export type UseMutation = <I, O>(options: {
  mutationKey: readonly unknown[];
  mutationFn: (input: I) => Promise<O>;
}) => {
  mutate(input: I): void;
  mutateAsync(input: I): Promise<O>;
  data: O | undefined;
  isPending: boolean;
  error: unknown;
};

/**
 * The operations each hook calls (ADR 0453). The public's client gets the catalogue, the course
 * page and buying; a customer's client also their lessons, playback, progress and courses; the
 * staff client the course builder's and the enrolment hooks too.
 */
export const COURSES_HOOKS_CALL = {
  useCatalogue: ["x.courses.catalogue"],
  useCourse: ["x.courses.course"],
  useBuy: ["x.courses.buy", "order.checkout"],
  useLesson: ["x.courses.lesson"],
  usePlayback: ["media.play"],
  useProgress: ["x.courses.progress"],
  useMyCourses: ["x.courses.myCourses"],
  useStartSession: ["x.courses.startSession"],
  useEnrol: ["x.courses.enrol"],
  useEndEnrolment: ["x.courses.endEnrolment"],
  useStats: ["x.courses.stats"],
  // The course subscription (stage 32a). Every billing action is the web's: a native block may
  // read the subscription only (the block lint's noPurchase).
  usePlans: ["x.courses.plans"],
  useSubscribe: ["subscription.start"],
  useMySubscriptions: ["subscription.list"],
  useCancelSubscription: ["subscription.cancel"],
  useResumeSubscription: ["subscription.resume"],
  useBillingPortal: ["subscription.portal"],
  useWorkingCopy: ["record.get"],
  useSaveOutline: ["record.update"],
  usePublishCourse: ["record.publish"],
  useLibraryVideos: ["media.list"],
  usePublishedPrograms: ["record.list"],
} as const;

/**
 * Hooks for a React or React Native app:
 * `const courses = createCoursesHooks({ useQuery, useMutation }, api)`. The hooks a client cannot
 * back are not there, and calling one does not compile.
 */
export function createCoursesHooks<C extends ClientHolding>(
  react: { useQuery: UseQuery; useMutation: UseMutation },
  client: C,
) {
  return packHooks(client, COURSES_HOOKS_CALL, (api: CoursesClient) => allCoursesHooks(react, api));
}

const none = <T>(name: string) => ({
  queryKey: [name, "none"] as readonly unknown[],
  queryFn: async () => undefined as T,
});

function allCoursesHooks(
  react: { useQuery: UseQuery; useMutation: UseMutation },
  api: CoursesClient,
) {
  const { useQuery, useMutation } = react;
  return {
    /** The catalogue: published courses, bundles and themes, with the host's prices. */
    useCatalogue(input: In<"x.courses.catalogue"> = {}) {
      return useQuery(api.query("x.courses.catalogue", input));
    },
    /** One published course by its address, with whether the caller holds it. */
    useCourse(slug: string | null): QueryResult<Out<"x.courses.course">> {
      const options: QueryOptions<Out<"x.courses.course">> = slug
        ? api.query("x.courses.course", { slug })
        : none("course");
      return useQuery({ ...options, enabled: slug !== null });
    },
    /** Start an order for a course or a bundle; then `checkout` it (web only). */
    useBuy() {
      return {
        start: useMutation(api.mutation("x.courses.buy")),
        checkout: useMutation(api.mutation("order.checkout")),
      };
    },
    /** One lesson for a holder (or a free preview). */
    useLesson(
      courseId: string | null,
      lessonKey: string | null,
    ): QueryResult<Out<"x.courses.lesson">> {
      const options: QueryOptions<Out<"x.courses.lesson">> =
        courseId && lessonKey
          ? api.query("x.courses.lesson", { courseId, lessonKey })
          : none("lesson");
      return useQuery({ ...options, enabled: Boolean(courseId && lessonKey) });
    },
    /**
     * A token to play a lesson's video (or a trailer), from the host's `media.play`; asked for
     * again `PLAYBACK_REFRESH_BEFORE_MS` before it expires, so a long video keeps playing.
     */
    usePlayback(
      video: { media: string; record?: { object: string; id: string }; field?: string } | null,
    ): QueryResult<Playback> {
      const input = video
        ? {
            id: video.media,
            ...(video.record ? { record: video.record } : {}),
            ...(video.field ? { field: video.field } : {}),
          }
        : null;
      const options = input ? api.query("media.play", input) : none<Playback>("playback");
      return useQuery<Playback>({
        ...(options as { queryKey: readonly unknown[]; queryFn: () => Promise<Playback> }),
        enabled: input !== null,
        refetchInterval: (query) => {
          const data = query.state.data;
          return data ? refreshInMs(data.expiresAt) : false;
        },
      });
    },
    /** Mark a lesson started or done, and keep where its video was left. */
    useProgress() {
      return useMutation(api.mutation("x.courses.progress"));
    },
    /** What the caller holds, with progress. */
    useMyCourses() {
      return useQuery(api.query("x.courses.myCourses", {}));
    },
    /** A session lesson's own Programs session, once it is assigned. */
    useStartSession(
      courseId: string | null,
      lessonKey: string | null,
    ): QueryResult<Out<"x.courses.startSession">> {
      const options: QueryOptions<Out<"x.courses.startSession">> =
        courseId && lessonKey
          ? api.query("x.courses.startSession", { courseId, lessonKey })
          : none("session");
      return useQuery({
        ...options,
        enabled: Boolean(courseId && lessonKey),
        // "Preparing your sessions": ask again in a few seconds until it is there.
        refetchInterval: (query) => (query.state.data?.preparing ? 3000 : false),
      });
    },
    /** Staff: give a person access, with a reason. */
    useEnrol() {
      return useMutation(api.mutation("x.courses.enrol"));
    },
    /** Staff: end an enrolment staff gave or one imported. */
    useEndEnrolment() {
      return useMutation(api.mutation("x.courses.endEnrolment"));
    },
    /** Staff: enrolments and lessons done. */
    useStats(courseId?: string) {
      return useQuery(api.query("x.courses.stats", courseId ? { courseId } : {}));
    },
    /** The course plans on offer, with the host's prices and trial days. */
    usePlans() {
      return useQuery(api.query("x.courses.plans", {}));
    },
    /**
     * Start a course subscription: the host opens the provider's page (web only). Whether the
     * trial is given is the host's (`noTrial` says why not).
     */
    useSubscribe() {
      return useMutation(api.mutation("subscription.start"));
    },
    /** The signed-in customer's own course subscriptions, newest first. */
    useMySubscriptions() {
      return useQuery(
        api.query("subscription.list", {
          filter: { field: "planObject", op: "eq", value: PLAN },
          limit: 20,
        }),
      );
    },
    /** End their own subscription when its period ends (web only). */
    useCancelSubscription() {
      return useMutation(api.mutation("subscription.cancel"));
    },
    /** Undo that, before the period ends (web only). */
    useResumeSubscription() {
      return useMutation(api.mutation("subscription.resume"));
    },
    /** The provider's portal for their card and past invoices (web only, never in a frame). */
    useBillingPortal() {
      return useMutation(api.mutation("subscription.portal"));
    },
    /** Staff: a course's working copy, as the builder edits it. */
    useWorkingCopy(courseId: string) {
      return useQuery(api.query("record.get", { object: COURSE, id: courseId }));
    },
    /** Staff: save the course's working copy (its outline). */
    useSaveOutline() {
      return useMutation(api.mutation("record.update"));
    },
    /** Staff: publish the course (a person; an assistant's request waits for one). */
    usePublishCourse() {
      return useMutation(api.mutation("record.publish"));
    },
    /** Staff: the library's ready videos, to pick a lesson's video. */
    useLibraryVideos() {
      return useQuery(
        api.query("media.list", {
          filter: {
            and: [
              { field: "kind", op: "eq", value: "video" },
              { field: "state", op: "eq", value: "ready" },
            ],
          },
          limit: 100,
        }),
      );
    },
    /** Staff: the published Programs programs, to pick a session lesson's program. */
    usePublishedPrograms() {
      return useQuery(
        api.query("record.list", {
          object: "programs.program",
          filter: { field: "publishState", op: "eq", value: "published" },
          limit: 100,
        }),
      );
    },
  };
}

/** Every hook of this entry. A block takes the ones it calls: `Pick<CoursesHooks, "useLesson">`. */
export type CoursesHooks = ReturnType<typeof allCoursesHooks>;
