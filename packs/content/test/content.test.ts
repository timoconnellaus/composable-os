// The Content pack (stage 28, step 6): its contract and formula checks pass, its tool does what it
// says against @composable-os/sdk/testing's in-memory host, and its hooks are the ones a client
// can back (ADR 0453). What only the real host shows (published versions, the not-found rule,
// slugs, preview, the cache) is in packages/core/test/content.test.ts and
// apps/runner/test/content.test.ts, which runs this same pack in the sandbox.
import { createTestHost } from "@composable-os/sdk/testing";
import { describe, expect, it } from "vitest";
import {
  CONTENT_HOOKS_CALL,
  createContentHooks,
  embedKind,
  embedPlayer,
  hostMediaUrl,
  mediaPath,
  plainText,
  postDate,
} from "../client/index.ts";
import extension from "../index.ts";

describe("the pack", () => {
  it("passes the host's checks", () => {
    const host = createTestHost(extension);
    expect(host.issues).toEqual([]);
  });

  it("categories: every category the public may read, by name", async () => {
    const host = createTestHost(extension, {
      records: {
        "content.category": [
          { id: "cat_b", name: "News", slug: "news" },
          { id: "cat_a", name: "Events", slug: "events" },
        ],
      },
      operations: {
        "public.list": () => ({
          items: [
            { object: "content.category", id: "cat_a", values: { name: "Events", slug: "events" } },
            { object: "content.category", id: "cat_b", values: { name: "News", slug: "news" } },
          ],
          nextCursor: null,
        }),
      },
    });
    const out = await host.runTool("categories", {}, { caller: { kind: "public" } });
    expect(out).toEqual({
      categories: [
        { id: "cat_a", name: "Events", slug: "events" },
        { id: "cat_b", name: "News", slug: "news" },
      ],
    });
  });
});

describe("the headless entry", () => {
  const client = (names: string[]) => ({
    operations: Object.fromEntries(names.map((n) => [n, {}])),
    query: (name: string, input: unknown) => ({
      queryKey: [name, input],
      queryFn: async () => null,
    }),
    mutation: (name: string) => ({ mutationKey: [name], mutationFn: async () => null }),
  });
  const react: Parameters<typeof createContentHooks>[0] = {
    useQuery: (options) => ({ data: undefined, isPending: true, error: null, options }) as never,
    useMutation: () => ({}) as never,
  };

  it("a public client gets the reading hooks, and the staff client the publish controls too", () => {
    const reading = ["content.get", "content.list", "content.preview", "x.content.categories"];
    const publicHooks = createContentHooks(react, client(reading));
    expect(Object.keys(publicHooks).sort()).toEqual(
      ["useCategories", "usePost", "usePosts", "usePreview"].sort(),
    );
    const staff = createContentHooks(
      react,
      client([...reading, "record.publish", "record.schedulePublish", "record.unpublish"]),
    );
    expect(Object.keys(staff).sort()).toEqual(Object.keys(CONTENT_HOOKS_CALL).sort());
  });

  it("reads posts with the host's content operations, by the post object", () => {
    const hooks = createContentHooks(react, client(["content.get", "content.list"])) as unknown as {
      usePost: (slug: string) => { options: { queryKey: unknown[] } };
      usePosts: () => { options: { queryKey: unknown[] } };
    };
    expect(hooks.usePost("summer").options.queryKey).toEqual([
      "content.get",
      { object: "content.post", slug: "summer" },
    ]);
    expect(hooks.usePosts().options.queryKey).toEqual(["content.list", { object: "content.post" }]);
  });

  it("knows a video from a link, builds the player from the id, and says the words", () => {
    expect(embedKind("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({
      kind: "youtube",
      id: "dQw4w9WgXcQ",
    });
    expect(embedKind("https://youtu.be/dQw4w9WgXcQ")).toMatchObject({ kind: "youtube" });
    expect(embedKind("https://vimeo.com/76979871")).toEqual({ kind: "vimeo", id: "76979871" });
    expect(embedKind("https://www.youtube.com.evil.test/watch?v=x")).toEqual({ kind: "link" });
    expect(embedPlayer({ kind: "vimeo", id: "76979871" })).toBe(
      "https://player.vimeo.com/video/76979871",
    );
    expect(mediaPath("med_1", 640)).toBe("/api/media/med_1?w=640");
    expect(hostMediaUrl("https://admin.example.com/")("med_1", 750)).toBe(
      "https://admin.example.com/api/v1/media/med_1?w=750",
    );
    expect(
      plainText({
        blocks: [
          { type: "heading", level: 2, content: [{ type: "text", text: "Hi" }] },
          { type: "divider" },
          { type: "button", label: "Go", href: "/go" },
        ],
      }),
    ).toBe("Hi\nGo");
    expect(
      postDate(
        { object: "content.post", id: "rec_1", values: { date: "2026-11-21T09:00:00Z" } },
        "en-AU",
      ),
    ).toBe("21 Nov 2026");
  });
});
