// Dummy data the Knowledge previews share: a made-up gym's procedures and its help pages.
import type {
  KnowledgeOperations,
  Published,
  SearchHit,
} from "@composable-os/pack-knowledge/client";
import { at, dayAfter } from "../../src/fake.ts";

type Out<K extends keyof KnowledgeOperations> = KnowledgeOperations[K]["output"];

const text = (t: string, marks: { bold?: boolean; italic?: boolean } = {}) => ({
  type: "text" as const,
  text: t,
  ...marks,
});

const injuryBody = {
  blocks: [
    {
      type: "paragraph",
      content: [
        text("The coach on duty leads. "),
        text("Stay calm, keep the room calm", { bold: true }),
        text(", and send someone to the front desk for the first aid kit."),
      ],
    },
    { type: "heading", level: 1, content: [text("Straight away")] },
    {
      type: "list",
      style: "ordered",
      items: [
        { content: [text("Stop the class and give the person space.")] },
        {
          content: [
            text(
              "Ask what happened and where it hurts. Do not move them if it is their neck or back.",
            ),
          ],
        },
        { content: [text("Call 000 for anything serious, then the duty manager.")] },
      ],
    },
    {
      type: "callout",
      tone: "warning",
      content: [
        text("The defibrillator is on the wall beside the front desk. Everyone may use it."),
      ],
    },
    { type: "heading", level: 1, content: [text("Afterwards")] },
    {
      type: "paragraph",
      content: [
        text("Write it up in the incident book the same day, with "),
        text("what you saw", { italic: true }),
        text(", not what you think happened."),
      ],
    },
  ],
};

const pauseBody = {
  blocks: [
    {
      type: "paragraph",
      content: [
        text("You can pause your membership for "),
        text("up to three months a year", { bold: true }),
        text(", for any reason. Nothing is charged while it is paused."),
      ],
    },
    { type: "heading", level: 1, content: [text("How to pause")] },
    {
      type: "list",
      style: "ordered",
      items: [
        { content: [text("Open My account and choose your membership.")] },
        { content: [text("Choose Pause and the date it starts.")] },
        { content: [text("It starts again on its own on the date you chose.")] },
      ],
    },
    { type: "heading", level: 1, content: [text("Classes you have booked")] },
    {
      type: "paragraph",
      content: [text("Bookings during a pause are cancelled, with no late-cancel fee.")],
    },
  ],
};

export const SAFETY = "rec_sec_safety";
export const DESK = "rec_sec_desk";
export const CLEANING = "rec_sec_cleaning";

const published = (
  id: string,
  title: string,
  section: string,
  version: number,
  date: string,
  summary: string,
): Published => ({
  object: "knowledge.procedure",
  id,
  values: { title, slug: id.replace("rec_", ""), summary, section, body: injuryBody },
  version,
  publishedAt: at("09:00", date),
});

export const injury = published(
  "rec_injury",
  "When someone is hurt",
  SAFETY,
  4,
  dayAfter(-6),
  "What the coach on duty does first, and what is written up after.",
);

export const procedures: Out<"content.staffList"> = {
  items: [
    published(
      "rec_closing",
      "Closing down",
      DESK,
      2,
      dayAfter(-40),
      "Lights, doors and the till, last out.",
    ),
    published(
      "rec_floor",
      "Cleaning the floor",
      CLEANING,
      1,
      dayAfter(-90),
      "Every evening, and after a spill.",
    ),
    published(
      "rec_fire",
      "Fire alarm",
      SAFETY,
      3,
      dayAfter(-20),
      "Who leads everyone out, and where to meet.",
    ),
    published(
      "rec_opening",
      "Opening up",
      DESK,
      5,
      dayAfter(-12),
      "The alarm, the lights, the music and the first class.",
    ),
    injury,
  ],
  nextCursor: null,
};

export const sections: Out<"record.list"> = {
  items: [
    { id: SAFETY, values: { name: "Safety", order: 1 } },
    { id: DESK, values: { name: "Front desk", order: 2 } },
    { id: CLEANING, values: { name: "Cleaning", order: 3 } },
  ],
  nextCursor: null,
};

export const toRead: Out<"x.knowledge.toRead"> = {
  toRead: [
    {
      id: "rec_opening",
      title: "Opening up",
      version: 5,
      publishedAt: at("09:00", dayAfter(-12)),
      since: at("09:00", dayAfter(-12)),
    },
    {
      id: "rec_injury",
      title: "When someone is hurt",
      version: 4,
      publishedAt: at("09:00", dayAfter(-6)),
      since: at("09:00", dayAfter(-6)),
    },
  ],
  confirmed: [
    {
      id: "rec_fire",
      title: "Fire alarm",
      version: 3,
      publishedAt: at("09:00", dayAfter(-20)),
      confirmedAt: at("17:40", dayAfter(-19)),
    },
    {
      id: "rec_closing",
      title: "Closing down",
      version: 2,
      publishedAt: at("09:00", dayAfter(-40)),
      confirmedAt: at("21:05", dayAfter(-38)),
    },
  ],
};

export const readOverview: Out<"x.knowledge.readStatus"> = {
  procedures: [
    {
      id: "rec_closing",
      title: "Closing down",
      version: 2,
      publishedAt: at("09:00", dayAfter(-40)),
      mustRead: 6,
      confirmed: 6,
    },
    {
      id: "rec_fire",
      title: "Fire alarm",
      version: 3,
      publishedAt: at("09:00", dayAfter(-20)),
      mustRead: 11,
      confirmed: 9,
    },
    {
      id: "rec_opening",
      title: "Opening up",
      version: 5,
      publishedAt: at("09:00", dayAfter(-12)),
      mustRead: 6,
      confirmed: 4,
    },
    {
      id: "rec_injury",
      title: "When someone is hurt",
      version: 4,
      publishedAt: at("09:00", dayAfter(-6)),
      mustRead: 11,
      confirmed: 3,
    },
  ],
  procedure: null,
};

export const readOne: Out<"x.knowledge.readStatus"> = {
  procedures: [],
  procedure: {
    id: "rec_injury",
    title: "When someone is hurt",
    version: 4,
    publishedAt: at("09:00", dayAfter(-6)),
    everyone: false,
    roles: ["bookings.coach", "admin"],
    people: [
      {
        account: "usr_1",
        name: "Alex Moreno",
        email: "alex@example.com",
        confirmed: { version: 4, confirmedAt: at("07:15", dayAfter(-5)) },
        lastConfirmed: { version: 4, confirmedAt: at("07:15", dayAfter(-5)) },
        since: null,
      },
      {
        account: "usr_2",
        name: "Bea Lin",
        email: "bea@example.com",
        confirmed: { version: 4, confirmedAt: at("18:30", dayAfter(-5)) },
        lastConfirmed: { version: 4, confirmedAt: at("18:30", dayAfter(-5)) },
        since: null,
      },
      {
        account: "usr_3",
        name: "Chris Okafor",
        email: "chris@example.com",
        confirmed: null,
        lastConfirmed: { version: 3, confirmedAt: at("10:00", dayAfter(-70)) },
        since: at("09:00", dayAfter(-6)),
      },
      {
        account: "usr_4",
        name: "Dana Price",
        email: "dana@example.com",
        confirmed: { version: 4, confirmedAt: at("06:50", dayAfter(-4)) },
        lastConfirmed: { version: 4, confirmedAt: at("06:50", dayAfter(-4)) },
        since: null,
      },
      {
        account: "usr_5",
        name: "Eli Sato",
        email: "eli@example.com",
        confirmed: null,
        lastConfirmed: null,
        since: at("09:00", dayAfter(-6)),
      },
    ],
  },
};

export const procedureHits: Out<"content.search"> = {
  items: [
    {
      object: "knowledge.procedure",
      id: "rec_injury",
      slug: "injury",
      title: "When someone is hurt",
      titleHighlight: [],
      version: 4,
      section: {
        field: "body",
        anchor: "straight-away",
        heading: "Straight away",
        headingHighlight: [{ text: "Straight away", match: false }],
      },
      snippet: [
        { text: "…send someone to the front desk for the first ", match: false },
        { text: "aid", match: true },
        { text: " kit.", match: false },
      ],
    } satisfies SearchHit,
  ],
  nextCursor: null,
};

// --- Help pages ---------------------------------------------------------------------------------

export const topics: Out<"x.knowledge.helpTopics"> = {
  topics: [
    {
      id: "rec_top_book",
      name: "Booking and cancelling",
      slug: "booking",
      order: 1,
      icon: "calendar",
    },
    {
      id: "rec_top_member",
      name: "Your membership",
      slug: "membership",
      order: 2,
      icon: "credit-card",
    },
    { id: "rec_top_here", name: "Getting here", slug: "getting-here", order: 3, icon: "map-pin" },
  ],
};

const page = (
  id: string,
  title: string,
  topic: string,
  order: number,
  summary: string,
): Published => ({
  object: "knowledge.helppage",
  id,
  values: {
    title,
    slug: id.replace("rec_", ""),
    summary,
    topic,
    order,
    body: pauseBody,
    related: [],
  },
});

const allPages: Published[] = [
  page(
    "rec_book",
    "Booking a class",
    "rec_top_book",
    1,
    "From the timetable, up to two weeks ahead.",
  ),
  page(
    "rec_cancel",
    "Cancelling a booking",
    "rec_top_book",
    2,
    "Free until two hours before the class.",
  ),
  page(
    "rec_late",
    "What a late cancel costs",
    "rec_top_book",
    3,
    "When a place is held and not used.",
  ),
  page("rec_pause", "Pausing your membership", "rec_top_member", 1, "Up to three months a year."),
  page(
    "rec_end",
    "Ending your membership",
    "rec_top_member",
    2,
    "One month's notice, from My account.",
  ),
  page("rec_parking", "Parking", "rec_top_here", 1, "Free after 6pm in the car park behind us."),
  page("rec_bring", "What to bring", "rec_top_here", 2, "A towel, water and indoor shoes."),
];

export const pause: Published = {
  ...(allPages[3] as Published),
  values: { ...(allPages[3] as Published).values, related: ["rec_end", "rec_cancel"] },
};

/** `content.list` of help pages: a topic's, or the ones a page relates to. */
export function helpPages(input: { filter?: unknown }): Out<"content.list"> {
  const f = input.filter as { field?: string; value?: unknown } | undefined;
  const items =
    f?.field === "topic"
      ? allPages.filter((p) => p.values.topic === f.value)
      : f?.field === "id" && Array.isArray(f.value)
        ? allPages.filter((p) => (f.value as string[]).includes(p.id))
        : allPages;
  return { items, nextCursor: null };
}

export const pauseAnswer: Out<"content.get"> = { ...pause, kind: "record" };
