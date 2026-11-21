// One rich text document with every block type and every mark (stage 28, ADR 0440): what the
// host's tests store and what both renderers (web and native, stage 28 step 6) must draw in full.
// The picture names a media item by an id of the right shape; the host refuses one that is not a
// live media item, so a test that stores this replaces it (or leaves the image out).
/** A media id in the fixture; replace it with a real one before storing. */
export const RICH_TEXT_FIXTURE_MEDIA = "med_01FIXTURE0000000000000000";

export const RICH_TEXT_FIXTURE = {
  blocks: [
    { type: "heading", level: 2, content: [{ type: "text", text: "Summer at the hall" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Doors open at " },
        { type: "text", text: "seven", bold: true },
        { type: "text", text: ", the bar a little " },
        { type: "text", text: "earlier", italic: true },
        { type: "text", text: ". Bring " },
        { type: "text", text: "ID", code: true },
        { type: "break" },
        { type: "text", text: "Tickets are on the ", bold: true, italic: true },
        { type: "text", text: "events page", href: "/events" },
        { type: "text", text: " or by " },
        { type: "text", text: "email", href: "mailto:hello@example.com" },
        { type: "text", text: "." },
      ],
    },
    {
      type: "list",
      style: "bullet",
      items: [
        { content: [{ type: "text", text: "Friday: open mic" }] },
        {
          content: [{ type: "text", text: "Saturday: two bands" }],
          list: {
            style: "ordered",
            items: [
              { content: [{ type: "text", text: "The first" }] },
              { content: [{ type: "text", text: "The second" }] },
            ],
          },
        },
      ],
    },
    {
      type: "quote",
      content: [{ type: "text", text: "Best night of the year." }],
      attribution: "A regular",
    },
    {
      type: "image",
      media: RICH_TEXT_FIXTURE_MEDIA,
      alt: "The hall from the stage, full",
      caption: [
        { type: "text", text: "Last summer, " },
        { type: "text", text: "sold out", bold: true },
      ],
    },
    { type: "divider" },
    { type: "embed", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", caption: "The trailer" },
    {
      type: "callout",
      tone: "warning",
      content: [{ type: "text", text: "Under 18s with an adult only." }],
    },
    { type: "button", label: "Get tickets", href: "https://tickets.example.com/summer" },
  ],
} as const;
