// Stage 38 step 1 (ADR 0700): the published-text index and `content.search`. A help page is found
// by a word of its published version, as a prefix, with the section it is in (heading and
// anchor) and a highlighted snippet as plain parts, and only once published: never by a word of
// its working copy, never after it is unpublished or deleted, never by a field the public does
// not read. The minute cron fills the index for what was published before it and catches it up
// when the declaration changes. A document of a thousand headings costs one publish the same few
// statements as a short one.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { type ExtensionManifest, headingAnchors } from "@composable-os/sdk";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  getObject,
  invoke,
  runReindexDue,
  setContentCacheStore,
} from "../src/index.ts";
import { SNIPPET_CLOSE, SNIPPET_OPEN } from "../src/operations/search.ts";
import { publishWrites } from "../src/records/publish.ts";
import { call, outside, PUBLIC } from "./customer-fixtures.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db } from "./helpers.ts";

const EXT = extId("help");
const PAGE = `${EXT}.page`;
/** Publishable, not public: never searched. */
const NOTE = `${EXT}.note`;
let admin: ActingUser;

const text = (t: string) => ({ type: "text", text: t });
const paragraph = (t: string) => ({ type: "paragraph", content: [text(t)] });
const heading = (t: string, level = 2) => ({ type: "heading", level, content: [text(t)] });
const doc = (...blocks: unknown[]) => ({ blocks });

const pageObject = (read: string[]): ExtensionManifest["objects"][string] => ({
  label: "Help page",
  plural: "Help pages",
  titleField: "title",
  fields: {
    title: { type: "text", label: "Title", required: true },
    slug: { type: "slug", label: "Slug" },
    summary: { type: "longText", label: "Summary" },
    body: { type: "richText", label: "Body" },
    staffOnly: { type: "text", label: "Staff only" },
  },
  publishable: { content: ["title", "summary", "body", "staffOnly"], slug: "slug" },
  public: { read },
});

const declare = (read: string[]) =>
  reconcile(
    manifest(EXT, {
      objects: {
        page: pageObject(read),
        note: {
          label: "Note",
          plural: "Notes",
          titleField: "title",
          fields: {
            title: { type: "text", label: "Title" },
            slug: { type: "slug", label: "Slug" },
          },
          publishable: { content: ["title"], slug: "slug" },
        },
      },
    }),
  );

async function create(values: Record<string, unknown>, object = PAGE) {
  const out = (await invoke("record.create", { object, values }, context(admin))) as {
    id: string;
  };
  return out.id;
}
const update = (id: string, values: Record<string, unknown>) =>
  invoke("record.update", { object: PAGE, id, values }, context(admin));
const publish = (id: string, object = PAGE) =>
  invoke("record.publish", { object, id }, context(admin));
const unpublish = (id: string) => invoke("record.unpublish", { object: PAGE, id }, context(admin));

interface Hit {
  id: string;
  slug: string;
  title: string | null;
  titleHighlight: { text: string; match: boolean }[];
  version: number;
  section: { field: string; anchor: string | null; heading: string };
  snippet: { text: string; match: boolean }[] | null;
}
type Answer =
  | { ok: true; value: { items: Hit[]; nextCursor: string | null } }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

const search = async (q: string, object = PAGE, extra: Record<string, unknown> = {}) =>
  (await call("content.search", { object, q, ...extra }, outside(PUBLIC))) as Answer;
const ids = async (q: string) => {
  const answer = await search(q);
  if (!answer.ok) throw new Error(JSON.stringify(answer.error));
  return answer.value.items.map((h) => h.id);
};

const indexRows = async (id: string) =>
  (
    await env.DB.prepare("SELECT count(*) AS n FROM core_published_text WHERE record_id = ?")
      .bind(id)
      .first<{ n: number }>()
  )?.n;

beforeAll(async () => {
  admin = await createUser("admin");
  await declare(["title", "slug", "summary", "body"]);
});

beforeEach(() => setContentCacheStore(null));

describe("content.search", () => {
  it("finds a published page by a word of its body, as a prefix, with its section", async () => {
    const id = await create({
      title: "Where do I park",
      summary: "Getting here by car.",
      body: doc(
        paragraph("We are on the high street."),
        heading("Parking"),
        paragraph("The zebrafish car park behind the hall is free after six."),
        heading("Parking"),
        paragraph("Bicycles go in the rack."),
      ),
    });
    expect(await ids("zebrafi")).toEqual([]);
    await publish(id);
    const answer = await search("zebrafi car");
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    const [hit] = answer.value.items;
    expect(hit?.id).toBe(id);
    expect(hit?.title).toBe("Where do I park");
    expect(hit?.version).toBe(1);
    expect(hit?.section).toMatchObject({ field: "body", anchor: "parking", heading: "Parking" });
    expect(hit?.snippet?.some((s) => s.match && s.text.toLowerCase().startsWith("zebrafish"))).toBe(
      true,
    );
    // Segments are plain text: no markup, no snippet markers.
    const json = JSON.stringify(hit);
    for (const c of ["<", ">", SNIPPET_OPEN, SNIPPET_CLOSE]) expect(json).not.toContain(c);
    // The second "Parking" is told apart by its place, as the renderers number it.
    const bikes = await search("bicycl");
    expect(bikes.ok && bikes.value.items[0]?.section.anchor).toBe("parking-2");
    // A title word is found too, at the top of the page.
    const title = await search("park where");
    expect(title.ok && title.value.items[0]?.section.anchor).toBeNull();
    expect(title.ok && title.value.items[0]?.titleHighlight.some((s) => s.match)).toBe(true);
  });

  it("never finds a draft's words, and an edit only once it is published again", async () => {
    const id = await create({ title: "Opening hours", body: doc(paragraph("Open from nine.")) });
    await update(id, { body: doc(paragraph("A quokka greets you.")) });
    expect(await ids("quokka")).toEqual([]);
    await publish(id);
    expect(await ids("quokka")).toEqual([id]);
    await update(id, { body: doc(paragraph("A wombat greets you now.")) });
    expect(await ids("wombat")).toEqual([]);
    expect(await ids("quokka")).toEqual([id]);
    await publish(id);
    expect(await ids("wombat")).toEqual([id]);
    expect(await ids("quokka")).toEqual([]);
  });

  it("does not find an unpublished page, or a deleted one", async () => {
    const id = await create({ title: "Lost property", body: doc(paragraph("Ask the axolotl.")) });
    await publish(id);
    expect(await ids("axolotl")).toEqual([id]);
    await unpublish(id);
    expect(await ids("axolotl")).toEqual([]);
    // The index holds the current version or nothing (the seam would hide it anyway).
    expect(await indexRows(id)).toBe(0);
    await publish(id);
    expect(await ids("axolotl")).toEqual([id]);
    await invoke("record.delete", { object: PAGE, id }, context(admin));
    expect(await ids("axolotl")).toEqual([]);
  });

  it("never finds a word of a content field the public does not read", async () => {
    const id = await create({
      title: "Lockers",
      staffOnly: "The narwhal code is 1234.",
      body: doc(paragraph("Lockers are by the door.")),
    });
    await publish(id);
    expect(await ids("narwhal")).toEqual([]);
    expect(await ids("lockers")).toEqual([id]);
  });

  it("answers an object that is not public content as content.get does", async () => {
    const note = await create({ title: "Pelican" }, NOTE);
    await publish(note, NOTE);
    for (const object of [NOTE, `${EXT}.nothing`, "person"]) {
      expect(await search("pelican", object)).toEqual({
        ok: false,
        error: { code: "not_found", message: "Not found", details: { object } },
      });
    }
  });

  it("pages through results with a cursor", async () => {
    const made: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = await create({ title: `Kiwi ${i}`, body: doc(paragraph("About kiwis.")) });
      await publish(id);
      made.push(id);
    }
    const first = await search("kiwi", PAGE, { limit: 2 });
    expect(first.ok && first.value.items.length).toBe(2);
    const next = first.ok ? first.value.nextCursor : null;
    expect(next).toBe("2");
    const second = await search("kiwi", PAGE, { limit: 2, cursor: next });
    expect(second.ok && second.value.items.length).toBe(1);
    expect(second.ok && second.value.nextCursor).toBeNull();
    const all = [
      ...(first.ok ? first.value.items : []),
      ...(second.ok ? second.value.items : []),
    ].map((h) => h.id);
    expect(all.sort()).toEqual([...made].sort());
  });
});

describe("the minute cron's catching up", () => {
  it("fills the index for what was published before it, and follows the declaration", async () => {
    const id = await create({
      title: "Showers",
      summary: "The platypus showers are downstairs.",
      body: doc(paragraph("Bring a towel.")),
    });
    await publish(id);
    expect(await ids("platypus")).toEqual([id]);
    // As a database from before the index: no rows, nothing caught up.
    await env.DB.prepare("DELETE FROM core_published_text WHERE object_type = ?").bind(PAGE).run();
    await env.DB.prepare("DELETE FROM core_settings WHERE key = 'published_text_index'").run();
    expect(await ids("platypus")).toEqual([]);
    const first = await runReindexDue(db);
    expect(first.records).toBeGreaterThan(0);
    expect(first.more).toBe(false);
    expect(await ids("platypus")).toEqual([id]);
    // Nothing to do: one read, nothing written.
    expect((await runReindexDue(db)).records).toBe(0);
    // The summary is no longer the public's: its words leave the index.
    await declare(["title", "slug", "body"]);
    await runReindexDue(db);
    expect(await ids("platypus")).toEqual([]);
    expect(await ids("towel")).toEqual([id]);
    await declare(["title", "slug", "summary", "body"]);
    await runReindexDue(db);
    expect(await ids("platypus")).toEqual([id]);
  });
});

describe("what one publish costs", () => {
  const long = doc(
    ...Array.from({ length: 500 }, (_, i) => [
      heading(`Step ${i}`, 3),
      paragraph(`Do thing number ${i}${i === 499 ? " with the capybara" : ""}.`),
    ]).flat(),
  );

  it("is a fixed few statements, whatever the number of sections", () => {
    const object = getObject(PAGE);
    if (!object) throw new Error("no object");
    const by = { at: "2026-01-01T00:00:00.000Z", user: null, note: null };
    const short = publishWrites(object, "rec_1", 1, { content: { body: doc() }, bytes: 1 }, by);
    const writes = publishWrites(object, "rec_1", 1, { content: { body: long }, bytes: 1 }, by);
    expect(writes.length).toBe(short.length + 1);
    expect(writes.length).toBeLessThan(10);
    for (const w of writes) expect(w.parameters.length).toBeLessThanOrEqual(100);
  });

  it("publishes and finds the last of 500 sections, in a bounded number of statements", async () => {
    const id = await create({ title: "Every step", body: long });
    let prepared = 0;
    const metered = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (query: string) => {
            prepared += 1;
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await invoke(
      "record.publish",
      { object: PAGE, id },
      context(admin, { db: createCrmDb(metered) }),
    );
    expect(prepared).toBeLessThan(100);
    const answer = await search("capybara");
    expect(answer.ok && answer.value.items[0]?.section.anchor).toBe(headingAnchors(long).at(-1));
    expect(answer.ok && answer.value.items[0]?.section.anchor).toBe("step-499");
  });
});
