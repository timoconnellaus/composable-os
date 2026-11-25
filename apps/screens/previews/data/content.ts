// Dummy data the Content previews share: a neighbourhood bakery's blog, and its pictures.
import type { ContentOperations, PublicPost, RichText } from "@composable-os/pack-content/client";
import { at } from "../../src/fake.ts";

type Out<K extends keyof ContentOperations> = ContentOperations[K]["output"];

const SCENES: Readonly<Record<string, readonly [string, string, string]>> = {
  med_loaves: ["#f6d9a8", "#c9874a", "#7a4a26"],
  med_starter: ["#f3efe6", "#d8c7a2", "#8c7652"],
  med_market: ["#cfe3d4", "#7fae8c", "#3f6b4d"],
  med_hours: ["#f8e1d4", "#e2a07c", "#9c5537"],
  med_rye: ["#e8dcc8", "#a98a5e", "#5b4329"],
  med_crumb: ["#fbf3e4", "#e4c48f", "#a8743b"],
};

/**
 * A picture for each media id, drawn here (soft hills under a sun, in the post's colours) rather
 * than fetched: what an app's `mediaUrl` gives, as an address the browser can show offline.
 */
export function pictureUrl(id: string, _width: number): string {
  const [sky, hill, ground] = SCENES[id] ?? ["#e5e7eb", "#9ca3af", "#4b5563"];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="680" viewBox="0 180 1600 680" preserveAspectRatio="xMidYMid slice">` +
    `<rect width="1600" height="900" fill="${sky}"/>` +
    `<circle cx="1180" cy="250" r="120" fill="#ffffff" opacity="0.65"/>` +
    `<path d="M0 620 C300 470 560 520 820 600 S1350 520 1600 560 V900 H0Z" fill="${hill}"/>` +
    `<path d="M0 760 C380 650 700 700 1000 760 S1450 700 1600 720 V900 H0Z" fill="${ground}"/>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const text = (t: string, marks: { bold?: boolean; italic?: boolean; href?: string } = {}) => ({
  type: "text" as const,
  text: t,
  ...marks,
});

export const starterBody: RichText = {
  blocks: [
    {
      type: "paragraph",
      content: [
        text(
          "Every loaf we sell starts with the same jar of starter, fed twice a day since 2019. ",
        ),
        text("You can keep one at home", { bold: true }),
        text(" with ten minutes a day and a little patience. Here is how we do it."),
      ],
    },
    { type: "heading", level: 1, content: [text("What you need")] },
    {
      type: "list",
      style: "bullet",
      items: [
        { content: [text("A clean jar with a loose lid")] },
        { content: [text("Strong white flour and a little wholemeal rye")] },
        { content: [text("Water at room temperature")] },
        { content: [text("A kitchen scale, "), text("not", { italic: true }), text(" cups")] },
      ],
    },
    { type: "heading", level: 1, content: [text("Feeding it")] },
    {
      type: "paragraph",
      content: [
        text(
          "Keep 50 g of starter and discard the rest. Add 50 g of flour and 50 g of water, stir, and leave it somewhere warm. In four to six hours it should have doubled and smell of yoghurt and green apples.",
        ),
      ],
    },
    {
      type: "list",
      style: "ordered",
      items: [
        { content: [text("Feed it in the morning, before work.")] },
        { content: [text("Feed it again in the evening.")] },
        { content: [text("Bake when it peaks, usually the next morning.")] },
      ],
    },
    {
      type: "quote",
      content: [text("The starter is the slowest member of the team, and the most reliable.")],
      attribution: "Hannah Brooks, head baker",
    },
    {
      type: "image",
      media: "med_crumb",
      alt: "An open crumb on a halved loaf",
      caption: [text("Our country loaf, 36 hours from feed to slice.")],
    },
    {
      type: "callout",
      tone: "info",
      content: [
        text("Short of time? Bring a jar on a Saturday and we will give you some of ours, "),
        text("free", { bold: true }),
        text("."),
      ],
    },
  ],
};

const post = (
  id: string,
  values: PublicPost["values"] & Required<Pick<PublicPost["values"], "title" | "slug">>,
): PublicPost => ({
  object: "content.post",
  id,
  values: { byline: "Hannah Brooks", ...values },
});

export const starterPost = post("post_1", {
  title: "How to keep a sourdough starter alive",
  slug: "keep-a-sourdough-starter-alive",
  excerpt: "Ten minutes a day and a little patience: how we feed the starter behind every loaf.",
  cover: { media: "med_starter", alt: "A jar of bubbling starter on the counter" },
  body: starterBody,
  publishedAt: at("08:00", "2026-02-27"),
});

export const posts: Out<"content.list"> = {
  items: [
    starterPost,
    post("post_2", {
      title: "New Saturday hours from March",
      slug: "new-saturday-hours",
      excerpt:
        "We open at 7 on Saturdays from the 7th, with the first loaves out of the oven at half past.",
      cover: { media: "med_hours", alt: "The shop front in the early morning" },
      byline: "Tom Becker",
      publishedAt: at("09:00", "2026-02-20"),
    }),
    post("post_3", {
      title: "Meet our rye: a darker loaf for winter",
      slug: "meet-our-rye",
      excerpt: "Seventy per cent rye, a long cold proof and a spoon of black treacle.",
      cover: { media: "med_rye", alt: "Three dark rye loaves on a board" },
      publishedAt: at("10:00", "2026-02-11"),
    }),
    post("post_4", {
      title: "Find us at the Harbourside market",
      slug: "harbourside-market",
      excerpt: "Every second Sunday, from ten until the bread runs out.",
      cover: { media: "med_market", alt: "Our stall at the market" },
      byline: "Ella Novak",
      publishedAt: at("12:00", "2026-01-30"),
    }),
  ],
  nextCursor: "c_older",
};

export const starterAnswer: Out<"content.get"> = { kind: "record", ...starterPost };
