// The Content pack's tools (stage 28, step 6). Posts need none: the public reads them with the
// host's `content.get` and `content.list`, which serve published versions only. This one lists
// the categories for a site's menu, through `public.list`, so the seam decides what is shown.
import { defineTool, z } from "@composable-os/sdk";

const CATEGORY = "content.category";

interface ListShape {
  items: { id: string; values: Record<string, unknown> }[];
  nextCursor: string | null;
}

const text = (value: unknown) => (typeof value === "string" ? value : null);

export const categories = defineTool({
  description:
    "Every category of posts, by name: its id, name and address (slug), for a site's menu or " +
    "a post's label. Read-only.",
  input: z.object({ limit: z.number().int().min(1).max(200).default(100) }),
  output: z.object({
    categories: z.array(
      z.object({ id: z.string(), name: z.string().nullable(), slug: z.string().nullable() }),
    ),
  }),
  risk: "read",
  audiences: ["staff", "customer", "public"],
  async handler(input, ctx) {
    const page = await ctx.ops.call<ListShape>("public.list", {
      object: CATEGORY,
      sort: { field: "name", direction: "asc" },
      limit: input.limit,
    });
    return {
      categories: page.items.map((item) => ({
        id: item.id,
        name: text(item.values.name),
        slug: text(item.values.slug),
      })),
    };
  },
});
