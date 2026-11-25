// Dummy data the Courses previews share: an online movement school's courses, one student's
// progress, and the course builder's working copy.
import type { RichText } from "@composable-os/pack-content/client";
import type {
  CourseSubscription,
  CoursesOperations,
  Outline,
  Playback,
} from "@composable-os/pack-courses/client";
import { at, dayAfter } from "../../src/fake.ts";

type Out<K extends keyof CoursesOperations> = CoursesOperations[K]["output"];
type Card = Out<"x.courses.catalogue">["courses"][number];

export const CURRENCY = "GBP";

function card(c: Partial<Card> & Pick<Card, "id" | "title">): Card {
  return {
    slug: (c.title ?? c.id).toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    theme: null,
    level: 1,
    summary: null,
    cover: { media: `med_${c.id}`, alt: c.title ?? "" },
    trailer: null,
    price: 49,
    lessons: 10,
    ...c,
  };
}

export const themes: Out<"x.courses.catalogue">["themes"] = [
  { id: "th_mobility", name: "Mobility", slug: "mobility", summary: null, picture: null },
  { id: "th_strength", name: "Strength", slug: "strength", summary: null, picture: null },
  { id: "th_skills", name: "Skills", slug: "skills", summary: null, picture: null },
  { id: "th_recovery", name: "Recovery", slug: "recovery", summary: null, picture: null },
];

export const courseCards: Card[] = [
  card({
    id: "crs_1",
    title: "Mobility Foundations",
    theme: "th_mobility",
    level: 1,
    lessons: 12,
    price: 49,
    summary: "Ten minutes a day to open your hips, shoulders and spine, with no kit beyond a mat.",
  }),
  card({
    id: "crs_2",
    title: "Handstand Basics",
    theme: "th_skills",
    level: 2,
    lessons: 10,
    price: 79,
    summary: "Wrist prep, wall drills and your first freestanding holds, step by step.",
  }),
  card({
    id: "crs_3",
    title: "Kettlebell Strength",
    theme: "th_strength",
    level: 2,
    lessons: 14,
    price: 89,
    summary: "Swings, cleans, presses and get-ups in a six-week plan you log as you go.",
  }),
  card({
    id: "crs_4",
    title: "Strong Back, Happy Hips",
    theme: "th_strength",
    level: 1,
    lessons: 8,
    price: 39,
    summary: "Build a back that copes with long days at a desk and weekends in the garden.",
  }),
  card({
    id: "crs_5",
    title: "Advanced Splits",
    theme: "th_mobility",
    level: 3,
    lessons: 16,
    price: 99,
    summary: "Front and middle splits for people who already have the basics down.",
  }),
  card({
    id: "crs_6",
    title: "Breathwork for Recovery",
    theme: "th_recovery",
    level: 1,
    lessons: 6,
    price: 29,
    summary: "Short guided sessions to calm down after training and sleep better.",
  }),
];

export const catalogue: Out<"x.courses.catalogue"> = {
  themes,
  courses: courseCards,
  bundles: [
    {
      id: "bdl_1",
      title: "Move Well Starter Pack",
      slug: "move-well-starter-pack",
      summary: "Mobility Foundations, Strong Back, Happy Hips and Breathwork, together.",
      cover: { media: "med_bdl_1", alt: "Move Well Starter Pack" },
      courses: ["crs_1", "crs_4", "crs_6"],
      price: 89,
    },
    {
      id: "bdl_2",
      title: "The Whole Library",
      slug: "the-whole-library",
      summary: "Every course we teach, and every one we add this year.",
      cover: { media: "med_bdl_2", alt: "The Whole Library" },
      courses: courseCards.map((c) => c.id),
      price: 299,
    },
  ],
  currency: CURRENCY,
};

/** The catalogue as one theme's button shows it. */
export function catalogueFor(input: { theme?: string }): Out<"x.courses.catalogue"> {
  return input.theme
    ? { ...catalogue, courses: courseCards.filter((c) => c.theme === input.theme) }
    : catalogue;
}

// --- One course: Mobility Foundations ------------------------------------------------------------

type Summary = Out<"x.courses.course">["sections"][number]["lessons"][number];
const video = (key: string, title: string, duration: number, preview = false): Summary => ({
  key,
  title,
  kind: "video",
  duration,
  preview,
});

const sections: Out<"x.courses.course">["sections"] = [
  {
    key: "start-here",
    title: "Start here",
    lessons: [
      video("welcome", "Welcome and how the course works", 4, true),
      video("mobility-check", "Your mobility check", 9, true),
      {
        key: "kit-list",
        title: "Printable practice plan",
        kind: "download",
        duration: null,
        preview: false,
      },
    ],
  },
  {
    key: "hips",
    title: "Hips",
    lessons: [
      video("ninety-ninety", "The 90/90 position", 12),
      video("hip-cars", "Hip circles (CARs)", 8),
      video("deep-squat", "Sitting in a deep squat", 14),
      {
        key: "hips-session",
        title: "Hip session: follow along",
        kind: "session",
        duration: 25,
        preview: false,
      },
    ],
  },
  {
    key: "shoulders-spine",
    title: "Shoulders and spine",
    lessons: [
      video("thoracic", "Opening the upper back", 11),
      video("shoulder-cars", "Shoulder circles (CARs)", 7),
      video("bridge-prep", "Getting ready for a bridge", 15),
      {
        key: "daily-ten",
        title: "Your daily ten minutes",
        kind: "text",
        duration: 5,
        preview: false,
      },
    ],
  },
];

const mobility = courseCards[0] as Card;

/** The course page as a visitor reads it: the free previews open, the rest to buy. */
export const mobilityForGuest: Out<"x.courses.course"> = {
  ...mobility,
  description: null,
  sections,
  currency: CURRENCY,
  holds: false,
  done: [],
  complete: false,
};

/** The course page as its student reads it, partway through. */
export const mobilityForStudent: Out<"x.courses.course"> = {
  ...mobilityForGuest,
  holds: true,
  done: ["welcome", "mobility-check", "ninety-ninety", "hip-cars"],
};

// --- One lesson: The 90/90 position --------------------------------------------------------------

const t = (text: string, marks: { bold?: boolean } = {}) => ({
  type: "text" as const,
  text,
  ...marks,
});

export const lessonNotes: RichText = {
  blocks: [
    {
      type: "paragraph",
      content: [
        t("The 90/90 trains both hips at once: one turning out, one turning in. Sit tall, with "),
        t("both knees bent to 90 degrees", { bold: true }),
        t(", and move slowly between sides."),
      ],
    },
    {
      type: "list",
      style: "bullet",
      items: [
        { content: [t("Two rounds of five switches each side")] },
        { content: [t("Hold the last switch for 30 seconds, breathing out into it")] },
        { content: [t("Hands behind you on the floor if your back rounds")] },
      ],
    },
    {
      type: "callout",
      tone: "info",
      content: [
        t("A pinch at the front of the hip means you have gone too deep: back off a little."),
      ],
    },
  ],
};

/** A still from the lesson's video, drawn here so the picture has one (no media route serves it). */
export const POSTER = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d9c7b3"/><stop offset="1" stop-color="#8d7560"/></linearGradient></defs>
<rect width="1280" height="720" fill="url(#g)"/>
<rect x="0" y="540" width="1280" height="180" fill="#6b5847" opacity="0.55"/>
<g transform="translate(-250 0)"><rect x="420" y="500" width="440" height="40" rx="8" fill="#3f6f73"/>
<circle cx="640" cy="300" r="46" fill="#3b2f27"/>
<path d="M600 350 h80 l30 150 h-140 z" fill="#2f4f5a"/>
<path d="M570 500 l-120 -10 l0 30 l130 10 z M710 500 l120 -40 l10 28 l-120 42 z" fill="#2f4f5a"/></g>
</svg>`,
)
  .replace(/\(/g, "%28")
  .replace(/\)/g, "%29")}`;

export const ninetyNinety: Out<"x.courses.lesson"> = {
  courseId: "crs_1",
  lesson: {
    kind: "video",
    key: "ninety-ninety",
    title: "The 90/90 position",
    duration: 12,
    video: { media: "vid_9090" },
    notes: lessonNotes,
  },
  video: {
    media: "vid_9090",
    poster: POSTER,
    record: { object: "courses.course", id: "crs_1" },
    field: "outline",
  },
  position: 214,
  state: "started",
  next: video("hip-cars", "Hip circles (CARs)", 8),
};

export const ninetyNinetyPlayback: Playback = {
  id: "vid_9090",
  token: "preview-token",
  expiresAt: at("23:00"),
  hls: "https://video.example.com/vid_9090/manifest.m3u8",
  dash: "https://video.example.com/vid_9090/manifest.mpd",
  iframe: "https://video.example.com/vid_9090/iframe",
  poster: POSTER,
  duration: 724,
  captions: [
    { language: "en", label: "English" },
    { language: "es", label: "Español" },
  ],
};

// --- What one student holds ----------------------------------------------------------------------

type Mine = Out<"x.courses.myCourses">["courses"][number];
const mine = (
  index: number,
  m: Pick<Mine, "why" | "done" | "counted" | "complete" | "continueWith">,
): Mine => ({ ...(courseCards[index] as Card), ...m });

export const myCourses: Out<"x.courses.myCourses"> = {
  courses: [
    mine(0, { why: "bought", done: 4, counted: 10, complete: false, continueWith: "deep-squat" }),
    mine(1, {
      why: "subscription",
      done: 2,
      counted: 9,
      complete: false,
      continueWith: "wall-walks",
    }),
    mine(3, { why: "bundle", done: 8, counted: 8, complete: true, continueWith: null }),
    mine(5, { why: "bundle", done: 0, counted: 6, complete: false, continueWith: "box-breathing" }),
    mine(2, {
      why: "imported",
      done: 11,
      counted: 13,
      complete: false,
      continueWith: "turkish-get-up",
    }),
  ],
};

// --- The course subscription ---------------------------------------------------------------------

export const plans: Out<"x.courses.plans"> = {
  plans: [
    {
      id: "pln_1",
      title: "All courses",
      description: "Every course in the library, and each new one the day it comes out.",
      price: 19,
      trialDays: 14,
    },
    {
      id: "pln_2",
      title: "All courses + coaching",
      description:
        "Everything in All courses, plus a monthly video check-in on your form with a coach.",
      price: 45,
      trialDays: 7,
    },
  ],
  currency: CURRENCY,
};

export const subscription: CourseSubscription = {
  id: "sub_1",
  state: "active",
  planObject: "courses.plan",
  planId: "pln_1",
  planTitle: "All courses",
  amount: 1900,
  currency: CURRENCY,
  interval: "month",
  trialEnd: at("09:00", dayAfter(-44)),
  currentPeriodEnd: at("09:00", dayAfter(18)),
  cancelAtPeriodEnd: false,
  cancelAt: null,
  endedAt: null,
  actionUrl: null,
  createdAt: at("09:00", dayAfter(-58)),
};

export const mySubscriptions: Out<"subscription.list"> = {
  items: [subscription],
  nextCursor: null,
};

export const noOffers: Out<"subscription.offer.mine"> = { offers: [] };

// --- The course builder's working copy -----------------------------------------------------------

export const workingOutline: Outline = {
  sections: [
    {
      key: "start-here",
      title: "Start here",
      lessons: [
        {
          kind: "video",
          key: "welcome",
          title: "Welcome and how the course works",
          duration: 4,
          preview: true,
          video: { media: "vid_welcome" },
        },
        { kind: "download", key: "kit-list", title: "Printable practice plan", file: "file_plan" },
      ],
    },
    {
      key: "hips",
      title: "Hips",
      lessons: [
        {
          kind: "video",
          key: "ninety-ninety",
          title: "The 90/90 position",
          duration: 12,
          video: { media: "vid_9090" },
        },
        {
          kind: "video",
          key: "hip-cars",
          title: "Hip circles (CARs)",
          duration: 8,
          video: { media: "vid_hipcars" },
        },
        {
          kind: "session",
          key: "hips-session",
          title: "Hip session: follow along",
          duration: 25,
          program: "prg_1",
          week: 1,
          session: 0,
        },
        { kind: "text", key: "daily-ten", title: "Your daily ten minutes" },
      ],
    },
  ],
};

export const workingCopy: Out<"record.get"> = {
  id: "crs_1",
  values: { title: "Mobility Foundations", outline: workingOutline },
};

export const libraryVideos: Out<"media.list"> = {
  items: [
    { id: "vid_welcome", values: { name: "Welcome to Mobility Foundations.mp4" } },
    { id: "vid_9090", values: { name: "90-90 hip switches.mp4" } },
    { id: "vid_hipcars", values: { name: "Hip CARs, slow tempo.mp4" } },
    { id: "vid_squat", values: { name: "Deep squat hold.mp4" } },
  ],
  nextCursor: null,
};

export const publishedPrograms: Out<"record.list"> = {
  items: [
    { id: "prg_1", title: "Hips in Six Weeks", values: { title: "Hips in Six Weeks" } },
    { id: "prg_2", title: "Kettlebell Basics", values: { title: "Kettlebell Basics" } },
  ],
};
