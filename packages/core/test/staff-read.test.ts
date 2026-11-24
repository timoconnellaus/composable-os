// Stage 38 step 2 (ADR 0701): staff read. A publishable object that declares `staffRead` is read
// by every staff account as it was published, never as it is being edited: `content.staffGet`
// (by id or slug), `content.staffList`, and `content.search` over its published words. Pack-role
// accounts (a cleaner, a coach, the door) read it too, and are refused everything else as before:
// no other object through these reads, no record read, no public content. The public and
// customers get the one not-found answer for it, published or not.
import { env } from "cloudflare:workers";
import { type ExtensionManifest, toManifest } from "@composable-os/sdk";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type Actor,
  coreRegistry,
  getObject,
  invoke,
  setContentCacheStore,
} from "../src/index.ts";
import { holdRoleLooksAfter } from "../src/pack-role-looks-after.ts";
import { type HeldPackRole, loadPackRole, packRoleAllows } from "../src/pack-roles.ts";
import { getPublished, listPublished, staffReadObject } from "../src/visibility/staff-read.ts";
import { call, outside, PUBLIC } from "./customer-fixtures.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";
import { releasePackExtensions } from "./release-packs.ts";

const EXT = extId("sr");
const PROC = `${EXT}.procedure`;
/** Public and staff read: a staff-only content field the public never searches. */
const HELP = `${EXT}.help`;
/** Publishable and public, not staff read: a blog post. */
const POST = `${EXT}.post`;
const ROLE = `${EXT}.team`;

const text = (t: string) => ({ type: "text", text: t });
const paragraph = (t: string) => ({ type: "paragraph", content: [text(t)] });
const heading = (t: string) => ({ type: "heading", level: 2, content: [text(t)] });
const doc = (...blocks: unknown[]) => ({ blocks });

const m = manifest(EXT, {
  roles: {
    team: {
      label: "Team",
      description: "Fixture: a cleaner's own tools only.",
      permissions: [`${EXT}:team`],
      read: [],
    },
  },
  objects: {
    procedure: {
      label: "Procedure",
      plural: "Procedures",
      titleField: "title",
      fields: {
        title: { type: "text", label: "Title", required: true },
        slug: { type: "slug", label: "Slug" },
        body: { type: "richText", label: "Body" },
        keeper: { type: "text", label: "Who keeps it right" },
      },
      publishable: { content: ["title", "body"], slug: "slug", staffRead: true },
    },
    help: {
      label: "Help page",
      plural: "Help pages",
      titleField: "title",
      fields: {
        title: { type: "text", label: "Title", required: true },
        slug: { type: "slug", label: "Slug" },
        body: { type: "richText", label: "Body" },
        staffNote: { type: "longText", label: "Note for staff" },
      },
      publishable: { content: ["title", "body", "staffNote"], slug: "slug", staffRead: true },
      public: { read: ["title", "slug", "body"] },
    },
    post: {
      label: "Post",
      plural: "Posts",
      titleField: "title",
      fields: {
        title: { type: "text", label: "Title", required: true },
        slug: { type: "slug", label: "Slug" },
      },
      publishable: { content: ["title"], slug: "slug" },
      public: { read: ["title", "slug"] },
    },
  },
});

let admin: ActingUser;
let viewer: ActingUser;
let cleaner: ActingUser;

const as = (user: ActingUser, actor: Actor = "human") =>
  context(user, {
    actor,
    ...(actor === "human" ? {} : { origin: { surface: "assistant", sessionId: unique("s") } }),
  } as never);

async function create(object: string, values: Record<string, unknown>) {
  const out = (await invoke("record.create", { object, values }, context(admin))) as {
    id: string;
  };
  return out.id;
}
const update = (object: string, id: string, values: Record<string, unknown>) =>
  invoke("record.update", { object, id, values }, context(admin));
const publish = (object: string, id: string) =>
  invoke("record.publish", { object, id }, context(admin)) as Promise<{ version: number }>;

interface Published {
  id: string;
  values: Record<string, unknown>;
  version: number;
  publishedAt: string;
  redirect?: string | null;
}
const staffGet = (user: ActingUser, input: Record<string, unknown>, actor: Actor = "human") =>
  invoke("content.staffGet", { object: PROC, ...input }, as(user, actor)) as Promise<Published>;
const staffList = async (user: ActingUser, input: Record<string, unknown> = {}) =>
  (
    (await invoke("content.staffList", { object: PROC, ...input }, as(user))) as {
      items: Published[];
      nextCursor: string | null;
    }
  ).items;
interface Hit {
  id: string;
  slug: string;
  title: string | null;
  version: number;
  section: { field: string; anchor: string | null };
}
const staffSearch = async (user: ActingUser, q: string, object = PROC) =>
  ((await invoke("content.search", { object, q }, as(user))) as { items: Hit[] }).items;

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a refusal");
}

async function installShipped(manifestJson: ExtensionManifest | ReturnType<typeof toManifest>) {
  const now = new Date().toISOString();
  await env.DB.prepare("DELETE FROM core_extensions WHERE id = ?").bind(manifestJson.id).run();
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', ?, 'c1', ?, ?, ?, ?)",
  )
    .bind(manifestJson.id, manifestJson.version, JSON.stringify(manifestJson), admin.id, now, now)
    .run();
}

async function account(role: "admin" | "member" | "viewer", packRole?: string) {
  const user = await createUser(role);
  if (packRole) {
    await env.DB.prepare("UPDATE core_user SET pack_role = ? WHERE id = ?")
      .bind(packRole, user.id)
      .run();
  }
  return user;
}

/** The three shipped pack roles criterion 3 names. */
const SHIPPED_ROLES = ["rostering.team", "bookings.coach", "ticketing.door"] as const;

beforeAll(async () => {
  admin = await createUser("admin");
  viewer = await createUser("viewer");
  await reconcile(m);
  await installShipped(m);
  for (const id of ["rostering", "bookings", "ticketing"]) {
    const pack = releasePackExtensions.find((e) => e.id === id);
    if (!pack) throw new Error(`no pack ${id}`);
    await installShipped(toManifest(pack));
  }
  cleaner = await account("viewer", ROLE);
});

beforeEach(() => setContentCacheStore(null));

describe("the declaration", () => {
  it("is carried to the registry, and only `true` opens it", () => {
    expect(getObject(PROC)?.publishable?.staffRead).toBe(true);
    expect(getObject(POST)?.publishable?.staffRead).toBeUndefined();
  });

  it("the operations are staff's, read-only", () => {
    for (const name of ["content.staffGet", "content.staffList"]) {
      const op = coreRegistry.get(name);
      expect(op?.audiences, name).toEqual(["staff"]);
      expect(op?.risk, name).toBe("read");
    }
  });
});

describe("staff read what was published (criterion 2)", () => {
  it("a draft is not found; the published version is read, unchanged by an edit until published again", async () => {
    const id = await create(PROC, {
      title: "Opening up",
      slug: unique("open"),
      body: doc(heading("Lights"), paragraph("Switch on the hall lights first")),
      keeper: "the owner",
    });
    expect((await refusal(staffGet(viewer, { id }))).code).toBe("not_found");
    expect((await staffList(viewer)).some((r) => r.id === id)).toBe(false);

    const { version } = await publish(PROC, id);
    const read = await staffGet(viewer, { id });
    expect(read).toMatchObject({ id, version, redirect: null });
    expect(read.values.title).toBe("Opening up");
    expect(read.publishedAt).toMatch(/^\d{4}-/);
    // The content and the slug only: no field outside the published version.
    expect(Object.keys(read.values).sort()).toEqual(["body", "slug", "title"]);

    await update(PROC, id, {
      title: "Opening up the hall",
      body: doc(heading("Lights"), paragraph("Unpublishedwordzz goes here")),
    });
    expect((await staffGet(viewer, { id })).values.title).toBe("Opening up");
    const listed = (await staffList(viewer)).find((r) => r.id === id);
    expect(listed).toMatchObject({ version, values: { title: "Opening up" } });
    expect(await staffSearch(viewer, "unpublishedword")).toEqual([]);
    expect((await staffSearch(viewer, "hall lights")).map((h) => h.id)).toContain(id);

    const second = await publish(PROC, id);
    expect(await staffGet(viewer, { id })).toMatchObject({
      version: second.version,
      values: { title: "Opening up the hall" },
    });
    expect((await staffSearch(viewer, "unpublishedword")).map((h) => h.id)).toEqual([id]);

    await invoke("record.unpublish", { object: PROC, id }, context(admin));
    expect((await refusal(staffGet(viewer, { id }))).code).toBe("not_found");
    expect((await staffList(viewer)).some((r) => r.id === id)).toBe(false);
    expect(await staffSearch(viewer, "unpublishedword")).toEqual([]);
  });

  it("by slug, and by an old slug with where it is now", async () => {
    const slug = unique("injury");
    const id = await create(PROC, { title: "Injuries", slug });
    await publish(PROC, id);
    expect((await staffGet(viewer, { slug })).id).toBe(id);
    const moved = unique("injury-now");
    await update(PROC, id, { slug: moved });
    expect(await staffGet(viewer, { slug })).toMatchObject({ id, redirect: moved });
    expect((await staffGet(viewer, { slug: moved })).redirect).toBeNull();
    expect((await refusal(staffGet(viewer, { slug: unique("nothing") }))).code).toBe("not_found");
    expect((await refusal(staffGet(viewer, { slug, id }))).code).toBe("invalid_input");
  });

  it("filters and sorts on the published fields only", async () => {
    const id = await create(PROC, { title: unique("Fire alarm"), keeper: "the desk" });
    await publish(PROC, id);
    const title = (await staffGet(viewer, { id })).values.title;
    expect(
      (await staffList(viewer, { filter: { field: "title", op: "eq", value: title } })).map(
        (r) => r.id,
      ),
    ).toEqual([id]);
    // A field outside the published version is not a field here.
    const out = await refusal(
      staffList(viewer, { filter: { field: "keeper", op: "eq", value: "the desk" } }),
    );
    expect(out.code).toBe("invalid_input");
  });

  it("an object that does not declare staff read is not found, whoever asks", async () => {
    const id = await create(POST, { title: "News", slug: unique("news") });
    await publish(POST, id);
    expect(
      (await refusal(invoke("content.staffGet", { object: POST, id }, context(admin)))).code,
    ).toBe("not_found");
    expect(
      (await refusal(invoke("content.staffList", { object: POST }, context(admin)))).code,
    ).toBe("not_found");
    expect(
      (await refusal(invoke("content.staffList", { object: "person" }, context(admin)))).code,
    ).toBe("not_found");
  });

  it("an AI actor reads the published version too, never the working copy", async () => {
    const id = await create(PROC, { title: "Complaints" });
    await publish(PROC, id);
    await update(PROC, id, { title: "Handling a complaint" });
    expect((await staffGet(admin, { id }, "assistant")).values.title).toBe("Complaints");
  });
});

describe("never public (criterion 1)", () => {
  it("the public and customers do not reach the staff reads, and find no procedure", async () => {
    const slug = unique("closing");
    const id = await create(PROC, {
      title: "Closing",
      slug,
      body: doc(paragraph("Lock the back door")),
    });
    await publish(PROC, id);
    for (const [name, input] of [
      ["content.staffGet", { object: PROC, id }],
      ["content.staffList", { object: PROC }],
    ] as const) {
      const out = await call(name, input, outside(PUBLIC));
      expect(out.ok, name).toBe(false);
    }
    for (const [name, input] of [
      ["content.get", { object: PROC, slug }],
      ["content.list", { object: PROC }],
      ["content.search", { object: PROC, q: "back door" }],
    ] as const) {
      const out = await call(name, input, outside(PUBLIC));
      expect(out, name).toMatchObject({ ok: false, error: { code: "not_found" } });
    }
  });

  it("the seam's staff-read source is the unknown object for anyone but staff", async () => {
    const object = staffReadObject(PROC);
    if (!object) throw new Error("not staff read");
    for (const principal of [PUBLIC, { kind: "customer", personId: "p1" } as const]) {
      await expect(
        getPublished({ db: db.query, principal } as never, object, { id: "x" }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(
        listPublished({ db: db.query, principal } as never, object, { limit: 10 }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
  });

  it("on an object both public and staff read, the public never searches a staff-only field", async () => {
    const id = await create(HELP, {
      title: "Parking",
      slug: unique("parking"),
      body: doc(paragraph("Park behind the hall")),
      staffNote: "Staffsecretword: the side gate code",
    });
    await publish(HELP, id);
    const publicSearch = async (q: string) => {
      const out = (await call("content.search", { object: HELP, q }, outside(PUBLIC))) as {
        ok: boolean;
        value?: { items: Hit[] };
      };
      return (out.value?.items ?? []).map((h) => h.id);
    };
    expect(await publicSearch("behind")).toEqual([id]);
    expect(await publicSearch("staffsecret")).toEqual([]);
    expect((await staffSearch(viewer, "staffsecret", HELP)).map((h) => h.id)).toEqual([id]);
    const read = (await invoke("content.staffGet", { object: HELP, id }, context(viewer))) as {
      values: Record<string, unknown>;
    };
    expect(read.values.staffNote).toMatch(/side gate/);
    const pub = (await call(
      "content.get",
      { object: HELP, slug: read.values.slug },
      outside(PUBLIC),
    )) as { value: { values: Record<string, unknown> } };
    expect(pub.value.values).not.toHaveProperty("staffNote");
  });
});

describe("pack roles read (criterion 3)", () => {
  it("a pack-role account reads published procedures, and is refused everything else as before", async () => {
    const id = await create(PROC, {
      title: "Cleaning the mats",
      body: doc(paragraph("Spray and wipe each mat")),
    });
    const { version } = await publish(PROC, id);
    for (const name of [ROLE, ...SHIPPED_ROLES]) {
      const user = name === ROLE ? cleaner : await account("viewer", name);
      expect(await staffGet(user, { id }), name).toMatchObject({ id, version });
      expect(
        (await staffList(user)).some((r) => r.id === id),
        name,
      ).toBe(true);
      expect(
        (await staffSearch(user, "wipe")).map((h) => h.id),
        name,
      ).toContain(id);
      // Not another object through the same reads, not the working copy, not a public read.
      for (const [op, input] of [
        ["content.staffList", { object: POST }],
        ["content.search", { object: POST, q: "news" }],
        ["content.get", { object: POST, slug: "news" }],
        ["content.list", { object: POST }],
        ["record.get", { object: PROC, id }],
        ["record.list", { object: PROC }],
        ["search.global", { q: "mats" }],
      ] as const) {
        const out = await refusal(invoke(op as never, input as never, as(user)));
        expect(out.code, `${name} ${op}`).toBe("forbidden");
      }
    }
  });

  it("a role limited to the people its holder looks after reads published procedures, never a limited object", async () => {
    const limit = {
      userId: cleaner.id,
      teams: [],
      reach: { [`${EXT}.session`]: "person" },
    };
    await expect(
      holdRoleLooksAfter(db.query, limit, "content.staffGet", { object: PROC, id: "x" }),
    ).resolves.toBeUndefined();
    await expect(
      holdRoleLooksAfter(db.query, limit, "content.staffList", { object: `${EXT}.session` }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("the role is allowed the staff reads only on an object that declares staff read", async () => {
    const role = (await loadPackRole(db.query, cleaner.id)) as HeldPackRole;
    for (const name of ["content.staffGet", "content.staffList", "content.search"]) {
      const op = coreRegistry.get(name);
      if (!op) throw new Error(name);
      expect(packRoleAllows(role, op, { object: PROC }), name).toBe(true);
      expect(packRoleAllows(role, op, { object: POST }), name).toBe(false);
      expect(packRoleAllows(role, op, { object: "nothing.here" }), name).toBe(false);
      expect(packRoleAllows(role, op, {}), name).toBe(false);
    }
  });
});
