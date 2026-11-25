// The Knowledge pack's tools (stage 38 step 5, ADR 0706). Each composes host operations and adds
// no rule of its own: who must read a procedure, whether a confirmation counts, who may see who has
// confirmed, what staff and the public read, and who publishes are all the host's (ADRs 0700 to
// 0702, 0480).
//
//   toRead          every staff account, a person    what I must read, and what I confirmed
//   confirm         every staff account, a person    "I have read and understood this", one tap
//   readStatus      knowledge:manage, a person       who has confirmed, who has not
//   helpTopics      anyone                           the help topics, for a site's menu
//   draftProcedure  knowledge:write (and members)    write a procedure's working copy
//   draftHelpPage   knowledge:write (and members)    write a help page's working copy
//
// The two draft tools write the working copy only: publishing is a person's (`record.publish`,
// ADR 0480; an AI's call of it is a request a person approves), and who must read a procedure is
// set by a person (the host refuses an AI actor's write of it).
import { defineTool, type ExtensionContext, OpsCallError, z } from "@composable-os/sdk";

export const PROCEDURE = "knowledge.procedure";
export const SECTION = "knowledge.section";
export const HELP_PAGE = "knowledge.helppage";
export const HELP_TOPIC = "knowledge.helptopic";

export const MANAGE = "knowledge:manage";
export const WRITE = "knowledge:write";

interface ListShape {
  items: { id: string; values: Record<string, unknown> }[];
  nextCursor: string | null;
}

const text = (value: unknown) => (typeof value === "string" ? value : null);
const num = (value: unknown) => (typeof value === "number" ? value : null);

// --- Rich text from notes -------------------------------------------------------------------------

type Inline = { type: "text"; text: string };
type Block =
  | { type: "paragraph"; content: Inline[] }
  | { type: "heading"; level: number; content: Inline[] }
  | { type: "list"; style: "bullet" | "ordered"; items: { content: Inline[] }[] };

const run = (value: string): Inline[] => [{ type: "text", text: value }];

/**
 * Notes as the platform's rich text (ADR 0440): `#`, `##` and `###` start a heading (a section of
 * the procedure, which search and citations link to), `-` or `*` a bullet, `1.` a numbered step,
 * and a blank line ends a paragraph. Everything else is plain words: no HTML, no marks.
 */
export function notesToRichText(notes: string): { blocks: Block[] } {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: Extract<Block, { type: "list" }> | null = null;
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", content: run(paragraph.join(" ")) });
    paragraph = [];
    list = null;
  };
  for (const raw of notes.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    const step = /^\d{1,3}[.)]\s+(.+)$/.exec(line);
    if (heading?.[1] && heading[2]) {
      flush();
      blocks.push({ type: "heading", level: heading[1].length + 1, content: run(heading[2]) });
    } else if ((bullet?.[1] || step?.[1]) && !paragraph.length) {
      const style = bullet ? "bullet" : "ordered";
      const words = (bullet?.[1] ?? step?.[1]) as string;
      if (!list || list.style !== style) {
        list = { type: "list", style, items: [] };
        blocks.push(list);
      }
      list.items.push({ content: run(words) });
    } else {
      if (list) list = null;
      paragraph.push(line);
    }
  }
  flush();
  return { blocks };
}

// --- Read and understood ------------------------------------------------------------------------

const procedureLine = z.object({
  id: z.string(),
  title: z.string().nullable(),
  version: z.number().int().describe("The current published version"),
  publishedAt: z.string(),
});

interface Mine {
  toRead: {
    object: string;
    id: string;
    title: string | null;
    version: number;
    publishedAt: string;
    since: string;
  }[];
  confirmed: {
    object: string;
    id: string;
    title: string | null;
    version: number;
    publishedAt: string;
    confirmedAt: string;
  }[];
}

export const toRead = defineTool({
  description:
    "My procedures: the published ones I must read and have not yet confirmed (oldest first, " +
    "with the version to read and since when), and the ones I have confirmed (with when). For " +
    "the person themselves, every staff account. Read-only.",
  input: z.object({}),
  output: z.object({
    toRead: z.array(procedureLine.extend({ since: z.string() })),
    confirmed: z.array(procedureLine.extend({ confirmedAt: z.string() })),
  }),
  risk: "read",
  // Every staff account, pack roles included (ADR 0652): the host's ack.mine decides what is
  // theirs, from who the person is (never from the input).
  humanOnly: true,
  anyStaff: true,
  async handler(_input, ctx) {
    const mine = await ctx.ops.call<Mine>("ack.mine", {});
    const strip = <T extends { object: string }>({ object: _object, ...rest }: T) => rest;
    return {
      toRead: mine.toRead.filter((r) => r.object === PROCEDURE).map(strip),
      confirmed: mine.confirmed.filter((r) => r.object === PROCEDURE).map(strip),
    };
  },
});

export const confirm = defineTool({
  description:
    "Confirm that I have read and understood a procedure's current published version: one tap, " +
    "by the person themselves. Refused for a version that is not the current one (read it again " +
    "and confirm that), a procedure I am not asked to read, and a second time for the same " +
    "version. A confirmation is kept for good and never changed. Not for an AI.",
  input: z.object({
    id: z.string().min(1).max(64).describe("The procedure"),
    version: z.number().int().min(1).describe("The version I read: the current one"),
  }),
  output: z.object({ id: z.string(), version: z.number().int(), confirmedAt: z.string() }),
  risk: "write",
  humanOnly: true,
  anyStaff: true,
  async handler(input, ctx) {
    const out = await ctx.ops.call<{ id: string; version: number; confirmedAt: string }>(
      "ack.confirm",
      { object: PROCEDURE, id: input.id, version: input.version },
    );
    return { id: out.id, version: out.version, confirmedAt: out.confirmedAt };
  },
});

const statusPerson = z.object({
  account: z.string(),
  name: z.string(),
  email: z.string(),
  confirmed: z.object({ version: z.number().int(), confirmedAt: z.string() }).nullable(),
  lastConfirmed: z.object({ version: z.number().int(), confirmedAt: z.string() }).nullable(),
  since: z.string().nullable(),
});

export const readStatus = defineTool({
  description:
    "Who has read what. With a procedure's id: for its current version, everyone who must read " +
    "it, who has confirmed it and when, and who has not and since when. Without one: every " +
    "published procedure staff must read, with how many have confirmed it of how many must. For " +
    "admins and people granted Read status; never for an AI. Read-only.",
  input: z.object({ id: z.string().min(1).max(64).optional().describe("One procedure") }),
  output: z.object({
    procedures: z.array(
      procedureLine.extend({ mustRead: z.number().int(), confirmed: z.number() }),
    ),
    procedure: procedureLine
      .extend({
        everyone: z.boolean(),
        roles: z.array(z.string()),
        people: z.array(statusPerson),
      })
      .nullable(),
  }),
  risk: "read",
  permission: MANAGE,
  humanOnly: true,
  async handler(input, ctx) {
    if (input.id !== undefined) {
      const s = await ctx.ops.call<{
        id: string;
        title: string | null;
        version: number;
        publishedAt: string;
        everyone: boolean;
        roles: string[];
        people: z.infer<typeof statusPerson>[];
      }>("ack.status", { object: PROCEDURE, id: input.id });
      return {
        procedures: [],
        procedure: {
          id: s.id,
          title: s.title,
          version: s.version,
          publishedAt: s.publishedAt,
          everyone: s.everyone,
          roles: s.roles,
          people: s.people,
        },
      };
    }
    const all = await ctx.ops.call<{
      items: {
        object: string;
        id: string;
        title: string | null;
        version: number;
        publishedAt: string;
        mustRead: number;
        confirmed: number;
      }[];
    }>("ack.overview", {});
    return {
      procedures: all.items
        .filter((i) => i.object === PROCEDURE)
        .map(({ object: _object, ...rest }) => rest),
      procedure: null,
    };
  },
});

// --- Help pages -----------------------------------------------------------------------------------

export const helpTopics = defineTool({
  description:
    "Every help topic, in their order: its id, name, address (slug) and icon, for a help " +
    "centre's menu. Open to anyone. Read-only.",
  input: z.object({ limit: z.number().int().min(1).max(200).default(100) }),
  output: z.object({
    topics: z.array(
      z.object({
        id: z.string(),
        name: z.string().nullable(),
        slug: z.string().nullable(),
        order: z.number().nullable(),
        icon: z.string().nullable(),
      }),
    ),
  }),
  risk: "read",
  audiences: ["staff", "customer", "public"],
  async handler(input, ctx) {
    const page = await ctx.ops.call<ListShape>("public.list", {
      object: HELP_TOPIC,
      sort: { field: "order", direction: "asc" },
      limit: input.limit,
    });
    return {
      topics: page.items.map((item) => ({
        id: item.id,
        name: text(item.values.name),
        slug: text(item.values.slug),
        order: num(item.values.order),
        icon: text(item.values.icon),
      })),
    };
  },
});

// --- Drafting -------------------------------------------------------------------------------------

const draftCommon = {
  id: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("Change this one's working copy; left out, a new one is made"),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(500).optional().describe("One or two sentences for lists"),
  notes: z
    .string()
    .max(60_000)
    .optional()
    .describe(
      "The words, as notes: '# ' or '## ' starts a section heading, '- ' a bullet, '1. ' a " +
        "numbered step, a blank line ends a paragraph",
    ),
};

const draftOut = z.object({
  id: z.string(),
  created: z.boolean(),
  open: z.object({ object: z.string(), id: z.string() }),
});

async function draft(
  ctx: ExtensionContext,
  object: string,
  id: string | undefined,
  values: Record<string, unknown>,
) {
  if (id !== undefined) {
    await ctx.ops.call("record.update", { object, id, values });
    return { id, created: false, open: { object, id } };
  }
  const made = await ctx.ops.call<{ id: string }>("record.create", { object, values });
  if (!made?.id) throw new OpsCallError("conflict", "The draft was not made");
  return { id: made.id, created: true, open: { object, id: made.id } };
}

export const draftProcedure = defineTool({
  description:
    "Write a procedure's working copy from notes: a new one, or the draft of one that exists. " +
    "Staff read only what a person publishes, so this changes nothing anyone reads until then; " +
    "ask a person to publish it (record.publish waits for their approval). Who must read it and " +
    "how often it is reviewed are set by a person. Name a role, not a person, in the words " +
    "('the duty manager', not 'Sam').",
  input: z.object({
    ...draftCommon,
    section: z.string().min(1).max(64).optional().describe("A section's id"),
  }),
  output: draftOut,
  risk: "write",
  permission: WRITE,
  async handler(input, ctx) {
    return draft(ctx, PROCEDURE, input.id, {
      title: input.title,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.notes !== undefined ? { body: notesToRichText(input.notes) } : {}),
      ...(input.section !== undefined ? { section: input.section } : {}),
    });
  },
});

export const draftHelpPage = defineTool({
  description:
    "Write a help page's working copy from notes: a new one, or the draft of one that exists. " +
    "The public reads only what a person publishes; ask a person to publish it (record.publish " +
    "waits for their approval). Never put a customer's name or details in a help page drafted " +
    "from their question.",
  input: z.object({
    ...draftCommon,
    topic: z.string().min(1).max(64).optional().describe("A help topic's id"),
  }),
  output: draftOut,
  risk: "write",
  permission: WRITE,
  async handler(input, ctx) {
    return draft(ctx, HELP_PAGE, input.id, {
      title: input.title,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.notes !== undefined ? { body: notesToRichText(input.notes) } : {}),
      ...(input.topic !== undefined ? { topic: input.topic } : {}),
    });
  },
});
