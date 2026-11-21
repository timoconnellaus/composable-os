// Content (stage 28, step 6): blog posts and their categories, which staff write and the public
// reads. Any product can turn it on (`packs` in its product.ts).
//
// Everything that is a rule is the host's, declared here as behaviours (ADR 0404):
//   - a post is `publishable` (ADRs 0446, 0441): staff and the assistant edit its working copy;
//     a person with the publish permission publishes it, now or at a time; its versions are kept;
//   - the public reads only its published version, by its slug, with only the fields
//     `public.read` lists (ADR 0442): `content.get` and `content.list`, which the hooks call;
//   - its body is `richText` (ADR 0440) and its cover an `image` (ADR 0444): structured data,
//     never HTML, and a picture the public is served only while a published post shows it.
// The pack adds no rule of its own. Its one tool lists the categories for a site's menu.
import { defineExtension } from "@composable-os/sdk";
import { categories } from "./tools.ts";

export default defineExtension({
  id: "content",
  version: "0.2.0",
  contractVersion: 1,
  label: "Content",
  description:
    "Blog posts and their categories: staff write and schedule them, a person publishes them, " +
    "and the public reads what was published, on the web and in the app.",
  permissions: {
    // public.list: the categories the public may read, for the categories tool.
    operations: ["public.list"],
    modules: ["ops"],
  },
  objects: {
    post: {
      label: "Post",
      plural: "Posts",
      icon: "newspaper",
      titleField: "title",
      description:
        "A blog post. Its working copy is what staff edit; the public reads the version last " +
        "published.",
      fields: {
        title: { type: "text", label: "Title", required: true },
        slug: {
          type: "slug",
          label: "Address",
          description: "Where the post is read: /blog/<address>. Made from the title.",
        },
        excerpt: {
          type: "text",
          label: "Excerpt",
          description: "One or two sentences for lists and link previews.",
        },
        body: { type: "richText", label: "Body" },
        cover: { type: "image", label: "Cover picture" },
        author: { type: "user", label: "Author" },
        // What readers see as who wrote it (ADR 0470): plain text, because a post's author is a
        // staff account, which the public never reads.
        byline: {
          type: "text",
          label: "Byline",
          description: 'Who wrote it, as readers see it: "Words by Sam Lee". Left empty, none.',
        },
        category: { type: "relation", label: "Category", to: "content.category" },
        date: {
          type: "datetime",
          label: "Date",
          description: "The date readers are shown. Left empty, it is when the post goes live.",
        },
        // What search engines and link previews show (ADR 0470). Each is optional: left empty,
        // the page uses the title, the excerpt and the cover.
        seoTitle: { type: "text", label: "Search title" },
        seoDescription: { type: "text", label: "Search description" },
        seoImage: { type: "image", label: "Share picture" },
        noindex: {
          type: "boolean",
          label: "Hide from search engines",
          description: "Asks search engines not to list the post's page.",
        },
      },
      indexes: [["category"], ["date"]],
      publishable: {
        content: [
          "title",
          "excerpt",
          "body",
          "cover",
          "author",
          "byline",
          "category",
          "date",
          "seoTitle",
          "seoDescription",
          "seoImage",
          "noindex",
        ],
        slug: "slug",
        date: "date",
      },
      // The author is a staff account, which the public does not read; a post shows its date.
      public: {
        read: [
          "title",
          "slug",
          "excerpt",
          "body",
          "cover",
          "byline",
          "category",
          "date",
          "publishedAt",
          "seoTitle",
          "seoDescription",
          "seoImage",
          "noindex",
        ],
      },
    },
    category: {
      label: "Category",
      plural: "Categories",
      icon: "tags",
      titleField: "name",
      navigation: "settings",
      fields: {
        name: { type: "text", label: "Name", required: true },
        slug: { type: "slug", label: "Address" },
      },
      // Every live category is public: a site's menu and a post's label.
      public: { read: ["name", "slug"] },
    },
  },
  views: {
    drafts: {
      label: "Drafts",
      object: "content.post",
      filter: { field: "publishState", op: "eq", value: "draft" },
      sort: { field: "updatedAt", direction: "desc" },
      columns: ["title", "category", "author", "updatedAt"],
    },
    scheduled: {
      label: "Scheduled",
      object: "content.post",
      filter: { field: "publishState", op: "eq", value: "scheduled" },
      sort: { field: "publishAt", direction: "asc" },
      columns: ["title", "category", "author", "publishAt"],
    },
    published: {
      label: "Published",
      object: "content.post",
      filter: { field: "publishState", op: "eq", value: "published" },
      sort: { field: "date", direction: "desc" },
      columns: ["title", "category", "date", "publishedAt", "publishedVersion"],
    },
  },
  tools: { categories },
});
