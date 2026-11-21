// `cos content import` (ADR 0470), the command's own half: reading the folder in the interchange
// format and refusing a bad one before it signs anyone in or writes anything. Its writes against
// a real host are in apps/app/test/content-import.test.ts.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readFolder } from "../src/content-import/format.ts";
import { readImportFolder } from "../src/content-import/run.ts";
import { Redactor } from "../src/io.ts";
import { runCli } from "../src/main.ts";

/** A PNG's first bytes. */
const png = () =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);

function folder(posts: Record<string, unknown>, pictures: Record<string, Uint8Array> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cos-import-"));
  for (const [name, post] of Object.entries(posts)) {
    writeFileSync(join(dir, name), typeof post === "string" ? post : JSON.stringify(post));
  }
  mkdirSync(join(dir, "pictures"));
  for (const [name, bytes] of Object.entries(pictures))
    writeFileSync(join(dir, "pictures", name), bytes);
  return dir;
}

async function cos(...argv: string[]) {
  const lines: string[] = [];
  const calls: string[] = [];
  const code = await runCli(argv, {
    io: {
      interactive: false,
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
      ask: async () => {
        throw new Error("no prompts in tests");
      },
    },
    redactor: new Redactor(),
    env: {},
    ghVerifier: null,
    fetch: (async (url: string) => {
      calls.push(String(url));
      throw new Error("no network in this test");
    }) as never,
  });
  return { code, output: lines.join("\n"), calls };
}

describe("the interchange format", () => {
  it("reads posts in the platform's shapes, a picture named by file where it has a media id", () => {
    const dir = folder(
      {
        "hello.json": {
          title: "Hello",
          slug: "hello",
          body: {
            blocks: [
              { type: "paragraph", content: [{ type: "text", text: "Hi" }] },
              { type: "image", file: "hall.png", alt: "The hall" },
            ],
          },
          cover: { file: "hall.png", alt: "Cover", focal: { x: 0.5, y: 0.4 } },
          seoImage: { file: "hall.png", alt: "Share" },
          date: "2021-03-01T09:00:00+10:00",
          status: "published",
          category: "News",
          byline: "Sam",
          seoTitle: "Hello there",
          seoDescription: "A first post",
          noindex: true,
        },
      },
      { "hall.png": png() },
    );
    const plan = readFolder(readImportFolder(dir));
    expect(plan.problems).toEqual([]);
    expect(plan.categories).toEqual([
      { key: "category:news", values: { name: "News", slug: "news" } },
    ]);
    const [post] = plan.posts;
    expect(post).toMatchObject({ key: "hello", status: "published", category: "category:news" });
    expect(post?.values).toMatchObject({
      cover: { media: { $picture: "hall.png" }, alt: "Cover", focal: { x: 0.5, y: 0.4 } },
      date: "2021-02-28T23:00:00.000Z",
      noindex: true,
    });
    const blocks = (post?.values.body as { blocks: Record<string, unknown>[] }).blocks;
    expect(blocks[1]).toEqual({ type: "image", alt: "The hall", media: { $picture: "hall.png" } });
    expect([...plan.pictures.keys()]).toEqual(["hall.png"]);
  });

  it("names every problem with its file", () => {
    const dir = folder(
      {
        "a.json": { title: "A", body: { blocks: [{ type: "script", text: "x" }] } },
        "b.json": { title: "B", cover: { file: "nope.png", alt: "x" } },
        "c.json": "{",
        "d.json": { title: "D", status: "scheduled" },
        "e.json": { title: "E", cover: { file: "evil.svg", alt: "x" } },
        "f.json": { slug: "Bad Slug" },
        "g.json": { title: "A" },
      },
      { "evil.svg": new TextEncoder().encode("<svg><script>alert(1)</script></svg>") },
    );
    const { problems } = readFolder(readImportFolder(dir));
    const by = (file: string) => problems.filter((p) => p.file === file).map((p) => p.message);
    expect(by("a.json").join(" ")).toMatch(/body\.blocks\.0/);
    expect(by("b.json").join(" ")).toContain("pictures/nope.png is not there");
    expect(by("c.json").join(" ")).toContain("Not JSON");
    expect(by("d.json").join(" ")).toContain("A scheduled post has the date");
    expect(by("pictures/evil.svg").join(" ")).toContain("not a picture the library takes");
    expect(by("f.json")).toEqual(
      expect.arrayContaining(["title is required", expect.stringContaining("slug is lowercase")]),
    );
    // Two posts at one address.
    expect(by("g.json").join(" ")).toContain('The address "a" is a.json\'s too');
  });
});

describe("cos content import", () => {
  it("refuses a bad folder before it signs anyone in or calls the host", async () => {
    const dir = folder({ "a.json": { title: "A", colour: "red" } });
    const run = await cos("content", "import", dir, "--host", "https://host.test");
    expect(run.code).toBe(1);
    expect(run.output).toContain("Nothing was written");
    expect(run.output).toContain('a.json: Unknown field "colour"');
    expect(run.calls).toEqual([]);
  });

  it("says how to use it", async () => {
    expect((await cos("content", "import")).code).toBe(2);
    expect((await cos("content", "import", "x")).output).toContain("--host is the host's address");
    expect((await cos("content", "export")).code).toBe(2);
  });
});
