// Stage 28, step 6: the Content pack (packs/content) in the real host. Its source is installed
// the way a product that lists the pack installs it (a shipped extension, run in the sandbox),
// with real D1. A post is written, published, read by the public through the host's content
// operations with the pack's hooks, and its categories through the pack's tool; the assistant
// drafts a post's working copy and cannot publish it (ADR 0446; criterion 12 is undecided).
import {
  type ActingUser,
  type ExtensionHost,
  getObject,
  type InvocationContext,
  invokeByName,
  type OutsideInvocationContext,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { CONTENT_HOOKS_CALL, createContentHooks } from "../../../packs/content/client/index.ts";
import { createAdmin, db, host, unique } from "./helpers.ts";

const files = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("../../../packs/content/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  )
    .map(([path, text]) => [path.split("/").pop() as string, text] as const)
    .filter(([name]) => name !== "vitest.config.ts"),
);

const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [...(await host.shipped()), { id: "content", version: "0.2.0" }],
  commitShipped: (id) =>
    id === "content"
      ? host.commit({
          id,
          files,
          message: "Shipped content 0.2.0",
          author: { name: "Composable OS", email: "release@composableos.dev" },
        })
      : host.commitShipped(id),
};

const POST = "content.post";
const CATEGORY = "content.category";
let admin: ActingUser;

const staff = (user: ActingUser, extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user,
  origin: { surface: "ui" },
  db,
  extensionHost: shippedHost,
  ...extra,
});
const guest: OutsideInvocationContext = {
  principal: { kind: "public" },
  db,
  extensionHost: shippedHost,
};
const run = <T = Record<string, unknown>>(
  name: string,
  input: unknown,
  ctx: InvocationContext | OutsideInvocationContext,
) => invokeByName(name, input, ctx) as Promise<T>;

/** The public's client, as a client app's generated one calls the host. */
const publicClient = {
  operations: Object.fromEntries(
    ["content.get", "content.list", "content.preview", "x.content.categories"].map((n) => [n, {}]),
  ),
  query: (name: string, input: unknown) => ({
    queryKey: [name, input],
    queryFn: () => run(name, input, guest),
  }),
  mutation: (name: string) => ({
    mutationKey: [name],
    mutationFn: (input: unknown) => run(name, input, guest),
  }),
};

/** The app's useQuery, as a test runs it: the query's function, called at once. */
const react: Parameters<typeof createContentHooks>[0] = {
  useQuery: (options) =>
    ({ data: undefined, isPending: true, error: null, run: options.queryFn }) as never,
  useMutation: () => ({}) as never,
};

const doc = (text: string) => ({
  blocks: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

beforeAll(async () => {
  admin = await createAdmin();
  await refreshSchemaRegistry(db.query);
  expect(getObject(POST)).toBeUndefined();
  await run("extension.install", { id: "content", shipped: true }, staff(admin));
  await refreshSchemaRegistry(db.query);
  expect(getObject(POST)?.publishable?.slug).toBe("slug");
}, 120_000);

describe("the Content pack in the host", () => {
  it("a post is written, published and read by the public through the pack's hooks", async () => {
    const category = await run<{ id: string }>(
      "record.create",
      { object: CATEGORY, values: { name: "News" } },
      staff(admin),
    );
    const title = unique("Opening night");
    const post = await run<{ id: string; values: Record<string, unknown> }>(
      "record.create",
      {
        object: POST,
        values: { title, body: doc("Doors at seven"), category: category.id, author: admin.id },
      },
      staff(admin),
    );
    const slug = post.values.slug as string;
    const hooks = createContentHooks(react, publicClient) as unknown as Record<
      string,
      (...a: unknown[]) => { run: () => Promise<unknown> }
    >;
    expect(Object.keys(hooks).sort()).toEqual(
      ["useCategories", "usePost", "usePosts", "usePreview"].sort(),
    );
    await expect(hooks.usePost?.(slug)?.run()).rejects.toMatchObject({ code: "not_found" });
    await run("record.publish", { object: POST, id: post.id }, staff(admin));
    const read = (await hooks.usePost?.(slug)?.run()) as {
      kind: string;
      values: Record<string, unknown>;
    };
    expect(read).toMatchObject({ kind: "record", values: { title, body: doc("Doors at seven") } });
    // The author is a staff account: not the public's to read.
    expect(read.values).not.toHaveProperty("author");
    const page = (await hooks.usePosts?.()?.run()) as { items: { id: string }[] };
    expect(page.items.map((i) => i.id)).toContain(post.id);
    const categories = (await hooks.useCategories?.()?.run()) as {
      categories: { id: string; name: string }[];
    };
    expect(categories.categories).toContainEqual({ id: category.id, name: "News", slug: "news" });
  });

  it("the assistant drafts a post's working copy; publishing it is a person's", async () => {
    const assistant = staff(admin, {
      actor: "assistant",
      origin: { surface: "assistant", sessionId: unique("s") },
    });
    const draft = await run<{ id: string }>(
      "record.create",
      { object: POST, values: { title: unique("Drafted"), body: doc("A first go") } },
      assistant,
    ).catch((error: { code?: string }) => error);
    // Under the default policy an assistant's write may wait for a person; either way it is a
    // working copy, never a published version.
    if ("id" in draft) {
      await expect(
        run("record.publish", { object: POST, id: draft.id }, assistant),
      ).rejects.toMatchObject({ code: "forbidden" });
    } else {
      expect(draft.code).toBe("pending_approval");
    }
    expect(CONTENT_HOOKS_CALL.usePublish).toEqual(["record.publish"]);
  });
});
