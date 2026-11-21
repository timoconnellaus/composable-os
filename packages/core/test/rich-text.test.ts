// Stage 28, step 1 (ADR 0440), acceptance criterion 6: rich text is data. A `richText` value is a
// document with the platform's one schema; HTML, script and block types or marks the schema does
// not name are refused on write, for every actor and every way in (create, update, createMany,
// the CSV import); and a fuzz test of malformed input never stores one.
import {
  hasMarkup,
  isDocumentHref,
  RICH_TEXT_BLOCKS,
  RICH_TEXT_FIXTURE,
  RICH_TEXT_SCHEMA,
  validateDocument,
} from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invoke } from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, unique } from "./helpers.ts";

const EXT = extId("rt");
const PAGE = `${EXT}.page`;
let admin: ActingUser;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The fixture without its picture: until media lands (stage 28, step 4) no media id is live. */
function storable(): { blocks: Json[] } {
  const value = clone(RICH_TEXT_FIXTURE) as unknown as { blocks: { type: string }[] };
  return { blocks: value.blocks.filter((b) => b.type !== "image") as unknown as Json[] };
}

const ACTORS = ["human", "assistant", "mcp", "automation", "extension"] as const;
type ActorName = (typeof ACTORS)[number];

function as(actor: ActorName) {
  const origins = {
    human: { surface: "ui" },
    assistant: { surface: "assistant", sessionId: `rt_${unique()}` },
    mcp: { surface: "mcp", clientId: "c", clientName: "Test", sessionId: `rt_${unique()}` },
    automation: { surface: "automation", automationId: "rt" },
    extension: { surface: "extension" },
  } as const;
  return context(admin, {
    actor,
    origin: origins[actor],
    ...(actor === "extension"
      ? {
          extension: {
            id: EXT,
            version: "1.0.0",
            permissions: { read: [], write: [], operations: [], modules: ["ops"] },
          },
        }
      : {}),
  } as never);
}

async function attempt(promise: Promise<unknown>) {
  try {
    return { ok: true as const, value: await promise };
  } catch (error) {
    return { ok: false as const, error: error as { code: string; message: string } };
  }
}

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(
    manifest(EXT, {
      objects: {
        page: {
          label: "Page",
          plural: "Pages",
          titleField: "title",
          fields: {
            title: { type: "text", label: "Title" },
            body: { type: "richText", label: "Body" },
          },
        },
      },
    }),
  );
});

// --- The schema ------------------------------------------------------------------------------

const HOSTILE_TEXT = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "</p><p>",
  "<!-- hidden -->",
  "<?php echo 1 ?>",
  "<svg/onload=alert(1)>",
  '<a href="javascript:alert(1)">x</a>',
  "&lt;script&gt;",
  "&#60;script&#62;",
  "&#x3C;b&#x3E;",
  "&nbsp;",
  "<B>shout</B>",
  "<iframe src=//evil>",
];
const HOSTILE_HREFS = [
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  " javascript:alert(1)",
  "java\tscript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "vbscript:msgbox(1)",
  "//evil.example.com",
  "/\\evil.example.com",
  "http://exa mple.com",
  'https://example.com/"onmouseover="alert(1)',
  "https://example.com/<script>",
  "file:///etc/passwd",
  "",
];
const UNKNOWN_BLOCKS: Json[] = [
  { type: "html", html: "<b>bold</b>" },
  { type: "script", content: [] },
  { type: "table", rows: [] },
  { type: "code", text: "rm -rf /" },
  { type: "Paragraph", content: [] },
  { content: [{ type: "text", text: "no type" }] },
];
const UNKNOWN_KEYS: [string, Json][] = [
  ["underline", true],
  ["style", "color:red"],
  ["html", "<b>x</b>"],
  ["onClick", "alert(1)"],
  ["className", "x"],
  ["__proto__", { polluted: true }],
];

describe("the richText schema", () => {
  it("is a valid document schema whose fixture has every block type and mark", () => {
    expect(validateDocument(RICH_TEXT_SCHEMA, RICH_TEXT_FIXTURE)).toMatchObject({ ok: true });
    const blocks = RICH_TEXT_FIXTURE.blocks.map((b) => b.type);
    expect([...new Set(blocks)].sort()).toEqual([...RICH_TEXT_BLOCKS].sort());
    const text = JSON.stringify(RICH_TEXT_FIXTURE);
    for (const mark of ['"bold":true', '"italic":true', '"code":true', '"href":']) {
      expect(text).toContain(mark);
    }
  });

  it("refuses HTML and character references in every text, and links by their scheme", () => {
    for (const hostile of HOSTILE_TEXT) {
      for (const where of ["run", "alt", "attribution", "label", "caption"] as const) {
        const value = clone(RICH_TEXT_FIXTURE) as unknown as { blocks: Record<string, Json>[] };
        const block = (type: string) =>
          value.blocks.find((b) => b.type === type) as Record<string, Json>;
        if (where === "run")
          (block("paragraph").content as Record<string, Json>[])[0] = {
            type: "text",
            text: `a ${hostile} b`,
          };
        if (where === "alt") block("image").alt = hostile;
        if (where === "attribution") block("quote").attribution = hostile;
        if (where === "label") block("button").label = hostile;
        if (where === "caption") block("embed").caption = hostile;
        const result = validateDocument(RICH_TEXT_SCHEMA, value);
        expect(result.ok, `${where}: ${hostile}`).toBe(false);
      }
    }
    for (const href of HOSTILE_HREFS) {
      expect(isDocumentHref(href, "link"), href).toBe(false);
      expect(isDocumentHref(href, "web"), href).toBe(false);
    }
    for (const fine of [
      "https://example.com/a?b=c#d",
      "http://localhost:8080",
      "/events",
      "#top",
      "mailto:a@b.co",
      "tel:+61 2 9999 0000",
    ]) {
      expect(isDocumentHref(fine, "link"), fine).toBe(true);
    }
    // An embed is a web address only.
    expect(isDocumentHref("/events", "web")).toBe(false);
    // Prose that only looks like it: a lone < before a space or digit, an ampersand in words.
    for (const prose of ["a < b", "<3 this", "Fish & chips", "AT&T", "x <= y"]) {
      expect(hasMarkup(prose), prose).toBe(false);
    }
  });
});

// --- Every actor, every way in ----------------------------------------------------------------

describe("refused on write, for every actor (criterion 6)", () => {
  it("stores the fixture, and refuses HTML, script, unknown blocks and marks from each actor", async () => {
    const created = await invoke(
      "record.create",
      { object: PAGE, values: { title: "Fixture", body: storable() } },
      context(admin),
    );
    expect(created.values.body).toEqual(storable());
    const bad: [string, Json][] = [
      ["an HTML string", "<p>Hello</p>"],
      [
        "script in a run",
        {
          blocks: [{ type: "paragraph", content: [{ type: "text", text: "<script>x</script>" }] }],
        },
      ],
      [
        "a javascript link",
        {
          blocks: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "x", href: "javascript:alert(1)" }],
            },
          ],
        },
      ],
      ["an unknown block", { blocks: [{ type: "html", html: "<b>x</b>" }] }],
      [
        "an unknown mark",
        {
          blocks: [{ type: "paragraph", content: [{ type: "text", text: "x", underline: true }] }],
        },
      ],
      ["an embed of a script", { blocks: [{ type: "embed", url: "data:text/html,<script>" }] }],
    ];
    for (const actor of ACTORS) {
      for (const [what, body] of bad) {
        const made = await attempt(
          invoke("record.create", { object: PAGE, values: { title: what, body } }, as(actor)),
        );
        expect(made.ok, `${actor} create ${what}`).toBe(false);
        if (!made.ok) expect(made.error.code, `${actor} create ${what}`).toBe("invalid_input");
        const changed = await attempt(
          invoke("record.update", { object: PAGE, id: created.id, values: { body } }, as(actor)),
        );
        expect(changed.ok, `${actor} update ${what}`).toBe(false);
        const many = await attempt(
          invoke(
            "record.createMany",
            {
              object: PAGE,
              records: [
                { title: "ok", body: storable() },
                { title: what, body },
              ],
            },
            as(actor),
          ),
        );
        expect(many.ok, `${actor} createMany ${what}`).toBe(false);
      }
    }
    // The CSV import holds the same line.
    const csv = `title,body\nImported,"${JSON.stringify(bad[1]?.[1]).replaceAll('"', '""')}"\n`;
    const imported = await attempt(
      invoke("import.records.commit", { object: PAGE, csv }, context(admin)),
    );
    expect(imported.ok).toBe(false);
    // Nothing above changed the record.
    const after = await invoke("record.get", { object: PAGE, id: created.id }, context(admin));
    expect(after.values.body).toEqual(storable());
  });

  it("a picture names a live media item: until media exists, none can be stored", async () => {
    const withImage = await attempt(
      invoke(
        "record.create",
        { object: PAGE, values: { title: "Pictured", body: clone(RICH_TEXT_FIXTURE) } },
        context(admin),
      ),
    );
    expect(withImage).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});

// --- The fuzz test ---------------------------------------------------------------------------

/** A small seeded generator, so a failure is the same failure on every run. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(list: readonly T[]): T => list[int(list.length)] as T;
  return { next, int, pick };
}

type Rng = ReturnType<typeof random>;

/** Every place in a value: the containers and keys (or indexes) under them. */
function places(value: Json): { parent: Json[] | { [key: string]: Json }; key: string | number }[] {
  const out: { parent: Json[] | { [key: string]: Json }; key: string | number }[] = [];
  const walk = (v: Json) => {
    if (Array.isArray(v)) {
      v.forEach((child, i) => {
        out.push({ parent: v, key: i });
        walk(child);
      });
    } else if (v && typeof v === "object") {
      for (const [key, child] of Object.entries(v)) {
        out.push({ parent: v, key });
        walk(child);
      }
    }
  };
  walk(value);
  return out;
}

const set = (
  place: { parent: Json[] | { [key: string]: Json }; key: string | number },
  v: Json,
) => {
  (place.parent as Record<string | number, Json>)[place.key] = v;
};
const get = (place: { parent: Json[] | { [key: string]: Json }; key: string | number }) =>
  (place.parent as Record<string | number, Json>)[place.key];

const RANDOM_VALUES: Json[] = [
  null,
  true,
  false,
  0,
  -1,
  1e308,
  "",
  "x",
  [],
  {},
  [1],
  { type: "text" },
];

/**
 * One malformed value made from a valid one. `hostile` says whether the change can only make it
 * invalid (markup, a bad link, an unknown block, key or mark): those must all be refused. Other
 * changes (a value swapped for a random one) may by chance leave it valid.
 */
function mutate(rng: Rng, base: Json): { value: Json; hostile: boolean; what: string } {
  const value = clone(base);
  const all = places(value);
  const strings = all.filter((p) => typeof get(p) === "string" && p.key !== "type");
  const objects = all.filter((p) => {
    const v = get(p);
    return v !== null && typeof v === "object" && !Array.isArray(v);
  });
  const lists = all.filter((p) => Array.isArray(get(p)));
  switch (rng.int(9)) {
    case 0: {
      const place = rng.pick(strings.filter((p) => p.key !== "href" && p.key !== "url"));
      const hostile = rng.pick(HOSTILE_TEXT);
      set(place, rng.next() < 0.5 ? hostile : `${String(get(place))} ${hostile}`);
      return { value, hostile: true, what: `markup at ${String(place.key)}` };
    }
    case 1: {
      const links = strings.filter((p) => p.key === "href" || p.key === "url");
      const place = rng.pick(links);
      set(place, rng.pick(HOSTILE_HREFS));
      return { value, hostile: true, what: `link ${String(get(place))}` };
    }
    case 2: {
      const blocks = (value as { blocks: Json[] }).blocks;
      blocks.splice(rng.int(blocks.length + 1), 0, clone(rng.pick(UNKNOWN_BLOCKS)));
      return { value, hostile: true, what: "unknown block" };
    }
    case 3: {
      const place = rng.pick(objects);
      const [key, extra] = rng.pick(UNKNOWN_KEYS);
      // `__proto__` set by assignment would not be an own key: define it as JSON would.
      Object.defineProperty(get(place), key, {
        value: extra,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      return { value, hostile: true, what: `unknown key ${key}` };
    }
    case 4: {
      const place = rng.pick(all.filter((p) => p.key === "type"));
      set(place, rng.pick(["html", "script", "TEXT", "image ", "strong", "iframe"]));
      return { value, hostile: true, what: "unknown type" };
    }
    case 5: {
      const place = rng.pick(all);
      set(place, clone(rng.pick(RANDOM_VALUES)));
      return { value, hostile: false, what: `random value at ${String(place.key)}` };
    }
    case 6: {
      const place = rng.pick(lists);
      const list = get(place) as Json[];
      if (list.length) list.splice(rng.int(list.length), 1);
      else list.push(clone(rng.pick(RANDOM_VALUES)));
      return { value, hostile: false, what: "a list changed" };
    }
    case 7: {
      // Deep nesting: lists in lists, past the schema's depth.
      let item: Json = { content: [{ type: "text", text: "deep" }] };
      for (let i = 0; i < 20; i += 1)
        item = { content: [], list: { style: "bullet", items: [item] } };
      (value as { blocks: Json[] }).blocks.push({ type: "list", style: "bullet", items: [item] });
      return { value, hostile: true, what: "too deep" };
    }
    default:
      return {
        value: rng.pick<Json>(["<p>hi</p>", 42, [], { blocks: "<p>x</p>" }, { html: "<b>" }]),
        hostile: true,
        what: "not a document",
      };
  }
}

/** Whether a stored value is clean: valid, and no markup in any text, no bad link. */
function clean(value: unknown): boolean {
  if (!validateDocument(RICH_TEXT_SCHEMA, value, { maxBytes: 524_288 }).ok) return false;
  const bad: string[] = [];
  const walk = (v: unknown, key: string) => {
    if (typeof v === "string") {
      if (key !== "type" && hasMarkup(v)) bad.push(v);
      if ((key === "href" || key === "url") && !isDocumentHref(v, key === "url" ? "web" : "link"))
        bad.push(v);
    } else if (Array.isArray(v)) {
      for (const c of v) walk(c, key);
    } else if (v && typeof v === "object") for (const [k, c] of Object.entries(v)) walk(c, k);
  };
  walk(value, "");
  return bad.length === 0;
}

describe("the fuzz test: malformed input is never stored (criterion 6)", () => {
  it("the check refuses every hostile change of thousands, and passes only clean values", () => {
    const rng = random(20261121);
    let hostile = 0;
    let passed = 0;
    for (let i = 0; i < 5000; i += 1) {
      const mutation = mutate(rng, clone(RICH_TEXT_FIXTURE) as unknown as Json);
      const result = validateDocument(RICH_TEXT_SCHEMA, mutation.value);
      if (mutation.hostile) {
        hostile += 1;
        expect(result.ok, `${i}: ${mutation.what}`).toBe(false);
      }
      if (result.ok) {
        passed += 1;
        expect(clean(mutation.value), `${i}: ${mutation.what}`).toBe(true);
      }
    }
    expect(hostile).toBeGreaterThan(3000);
    expect(passed).toBeGreaterThan(0);
  });

  it("through the host, by every actor: what is stored is exactly what was sent, and clean", async () => {
    const rng = random(28);
    const target = await invoke(
      "record.create",
      { object: PAGE, values: { title: "Fuzz target", body: storable() } },
      context(admin),
    );
    let stored = 0;
    let refused = 0;
    for (let i = 0; i < 160; i += 1) {
      const mutation = mutate(rng, storable());
      const actor = ACTORS[i % ACTORS.length] as ActorName;
      const how = i % 3;
      const outcome =
        how === 0
          ? await attempt(
              invoke(
                "record.create",
                { object: PAGE, values: { title: `f${i}`, body: mutation.value } },
                as(actor),
              ),
            )
          : how === 1
            ? await attempt(
                invoke(
                  "record.update",
                  { object: PAGE, id: target.id, values: { body: mutation.value } },
                  as(actor),
                ),
              )
            : await attempt(
                invoke(
                  "record.createMany",
                  { object: PAGE, records: [{ title: `f${i}`, body: mutation.value }] },
                  as(actor),
                ),
              );
      if (!outcome.ok) {
        refused += 1;
        expect(["invalid_input", "pending_approval"], `${i}: ${mutation.what}`).toContain(
          outcome.error.code,
        );
        continue;
      }
      expect(mutation.hostile, `${i}: ${mutation.what} was stored`).toBe(false);
      stored += 1;
      const id =
        how === 2
          ? (outcome.value as { ids: string[] }).ids[0]
          : (outcome.value as { id: string }).id;
      const read = await invoke("record.get", { object: PAGE, id: id as string }, context(admin));
      expect(read.values.body).toEqual(mutation.value);
      expect(clean(read.values.body), `${i}: ${mutation.what}`).toBe(true);
    }
    expect(refused).toBeGreaterThan(100);
    expect(stored + refused).toBe(160);
  });
});
