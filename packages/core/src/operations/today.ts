// today.get and today.rows (stage 60 step 3, ADR 0874): the owner's Today, for whoever asks. One
// read returns the items the caller may see for the business's local day, each a number with its
// label, a comparison, whether it needs attention and what a tap opens; the other returns the rows
// behind one item. Both are staff reads any staff account reaches (a pack role's too:
// `PACK_ROLE_TODAY`), and each item is gated for the caller by what they could already call
// (today/items.ts). Nothing is opened to customers or the public.
import { z } from "zod";
import { NotFoundError } from "../errors.ts";
import { defineOperation } from "../operation.ts";
import { HOST_ITEMS } from "../today/host.ts";
import { inOrder, loadViewer, type PlacedItem, type TodayRow } from "../today/items.ts";
import { packItemRows, packItemValues, visiblePackItems } from "../today/pack.ts";

const target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rows") }).describe("Its rows: today.rows with its key"),
  z.object({ kind: z.literal("approvals") }).describe("The approvals waiting (approval.list)"),
  z.object({ kind: z.literal("notices") }).describe("The notice inbox (notification.list)"),
  z
    .object({ kind: z.literal("screen"), pack: z.string(), screen: z.string() })
    .describe("On the web, a pack's staff screen; elsewhere its rows"),
]);

const itemSchema = z.object({
  key: z
    .string()
    .describe("host.<item> for the host's own, <pack>.<item> for a pack's; pass to today.rows"),
  label: z.string(),
  format: z
    .enum(["count", "percent", "money"])
    .describe("money only for the host's own figures, in the currency's minor unit"),
  value: z.number(),
  currency: z.string().nullable(),
  detail: z.string().nullable().describe("A second line, such as how many payments"),
  compare: z
    .object({ against: z.enum(["yesterday", "lastWeek"]), value: z.number() })
    .nullable()
    .describe("The same figure at the same local time yesterday or a week ago"),
  state: z.enum(["ok", "attention"]),
  target,
});

const rowSchema = z.object({
  label: z.string(),
  detail: z.string().nullable(),
  record: z.object({ object: z.string(), id: z.string() }).nullable(),
});

export const todayGet = defineOperation({
  name: "today.get",
  description:
    "Today at a glance, for the business's current local day in its own time zone: the items " +
    "you may see, attention first, each with its key, label, value (a count, a percent, or " +
    "money in the currency's minor unit), a comparison with the same time yesterday or last " +
    "week, whether it needs attention, and what it opens. Items include takings (for those who " +
    "may read the finance reports), the changes waiting for your approval, shifts with nobody " +
    "on them and checklists missed (for those who roster), unread notices, and the numbers " +
    "installed packs add (such as classes today and who came). An assistant or MCP client gets " +
    "only the packs' items and the money its user may see. today.rows gives an item's rows. " +
    "Read-only.",
  input: z.object({}),
  output: z.object({
    day: z.string().describe("The business's local date, YYYY-MM-DD"),
    zone: z.string().describe("The business's time zone"),
    items: z.array(itemSchema),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true, title: "Today" },
  async handler(_input, ctx) {
    const viewer = await loadViewer(ctx);
    const [host, packs] = await Promise.all([
      Promise.all(HOST_ITEMS.map((item) => item.item(viewer))),
      packItemValues(viewer),
    ]);
    const items: PlacedItem[] = [
      ...host.filter((item): item is PlacedItem => item !== null),
      ...packs,
    ];
    return { day: viewer.windows.today.day.date, zone: viewer.zone, items: inOrder(items) };
  },
});

export const todayRows = defineOperation({
  name: "today.rows",
  description:
    "The rows behind one item of today.get (its key), at most 50: for each a name, a second " +
    "line and the record it opens, if any. Only an item today.get gives you: any other key is " +
    "not found. Names and record ids only, never notes, health answers, pay or leave. A look " +
    "at a money item's rows is audited. Read-only.",
  input: z.object({ key: z.string().min(1).max(120) }),
  output: z.object({ items: z.array(rowSchema) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const viewer = await loadViewer(ctx);
    const host = HOST_ITEMS.find((item) => item.key === input.key);
    let rows: TodayRow[] | null = null;
    if (host) {
      rows = await host.rows(viewer);
      // Who looked at the money's rows (the spec's audit), naming the item, never a figure.
      if (rows && host.money) ctx.auditRead?.({ todayItem: host.key, rows: rows.length });
    } else {
      const item = (await visiblePackItems(viewer)).find((i) => i.key === input.key);
      if (item) rows = await packItemRows(viewer, item);
    }
    if (!rows) throw new NotFoundError("Today item", input.key);
    return { items: rows };
  },
});

export const todayOperations = [todayGet, todayRows] as const;
