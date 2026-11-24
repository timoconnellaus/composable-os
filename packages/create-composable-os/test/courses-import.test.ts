// `cos courses import`'s folder (stage 42, ADR 0495): what it reads and the problems it names
// before anyone signs in. The import against a real host is apps/app/test/courses-import.test.ts.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sendVideo } from "../src/courses-import/engine.ts";
import {
  type CoursesFolder,
  parseCsv,
  readCoursesFolder,
  srtToVtt,
} from "../src/courses-import/format.ts";
import { readCoursesDisk } from "../src/courses-import/run.ts";
import { Redactor } from "../src/io.ts";
import { runCli } from "../src/main.ts";

const PDF = new TextEncoder().encode("%PDF-1.7\n%…\n");
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

const course = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    title: "Handstands",
    price: 99,
    outline: {
      sections: [
        {
          key: "basics",
          title: "Basics",
          lessons: [
            {
              kind: "video",
              key: "wrists",
              title: "Wrists",
              sourceId: "lw-1",
              video: { file: "wrists.mp4", captions: [{ language: "en", file: "wrists.srt" }] },
            },
            { kind: "download", key: "sheet", title: "Sheet", sourceId: "lw-2", file: "sheet.pdf" },
          ],
        },
      ],
    },
    ...over,
  });

const folder = (edit: (f: CoursesFolder) => void = () => {}): CoursesFolder => {
  const f: CoursesFolder = {
    courses: new Map([["handstands.json", course()]]),
    bundles: new Map([
      ["all.json", JSON.stringify({ title: "All", price: 150, courses: ["handstands"] })],
    ]),
    videos: new Map([["wrists.mp4", 1000]]),
    captions: new Map([
      ["wrists.srt", new TextEncoder().encode("1\n00:00:01,000 --> 00:00:02,500\nHello\n")],
    ]),
    pictures: new Map([["cover.png", PNG]]),
    downloads: new Map([["sheet.pdf", PDF]]),
    access:
      "email,course,bundle,completed\nana@example.com,handstands,,yes\nben@example.com,,all,\n",
    progress: "email,course,lesson,state\nana@example.com,handstands,lw-1,done\n",
  };
  edit(f);
  return f;
};

describe("the courses folder", () => {
  it("reads CSV with quotes, doubled quotes, CRLF and the line each row starts on", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n\n"two\nlines",z\n')).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 2, cells: ["x, y", 'say "hi"'] },
      { line: 4, cells: ["two\nlines", "z"] },
    ]);
  });

  it("turns SubRip into WebVTT", () => {
    expect(srtToVtt("1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n")).toBe(
      "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nHello\n",
    );
  });

  it("plans a good folder: videos with captions, files, access and progress by sourceId", () => {
    const plan = readCoursesFolder(folder());
    expect(plan.problems).toEqual([]);
    expect([...plan.videos.keys()]).toEqual(["file:wrists.mp4"]);
    expect(plan.videos.get("file:wrists.mp4")?.captions.map((c) => c.language)).toEqual(["en"]);
    expect([...plan.files.keys()]).toEqual(["download:sheet.pdf"]);
    expect(plan.courses[0]?.lessons).toEqual(
      new Map([
        ["lw-1", "wrists"],
        ["lw-2", "sheet"],
      ]),
    );
    expect(plan.access.map((a) => [a.line, a.course, a.bundle, a.completed])).toEqual([
      [2, "handstands", null, true],
      [3, null, "all", false],
    ]);
    expect(plan.progress?.[0]).toMatchObject({ line: 2, sourceId: "lw-1", state: "done" });
  });

  it("makes slugs from titles as the host does: accents dropped, never ending in a hyphen", () => {
    const long = `${"a".repeat(79)} b`;
    const plan = readCoursesFolder(
      folder((f) => {
        f.courses.set("handstands.json", course({ title: "Crème Brûlée" }));
        f.bundles.set("all.json", JSON.stringify({ title: long, price: 150, courses: [] }));
      }),
    );
    expect(plan.courses[0]?.values.slug).toBe("creme-brulee");
    expect(plan.bundles[0]?.values.slug).toBe("a".repeat(79));
  });

  it("names every problem with its file and line", () => {
    const plan = readCoursesFolder(
      folder((f) => {
        f.courses.set("broken.json", "{ nope");
        f.courses.set(
          "twice.json",
          course({
            title: "Twice",
            outline: {
              sections: [
                {
                  key: "s",
                  title: "S",
                  lessons: [
                    {
                      kind: "video",
                      key: "a",
                      title: "A",
                      sourceId: "x",
                      video: { file: "missing.mp4" },
                    },
                    { kind: "text", key: "a", title: "B", sourceId: "x" },
                  ],
                },
              ],
            },
          }),
        );
        f.bundles.set("bad.json", JSON.stringify({ title: "Bad", price: 1, courses: ["nope"] }));
        f.access =
          "email,course,bundle\nnot-an-email,handstands,\nana@example.com,handstands,all\n";
        f.progress = "email,lesson\nana@example.com,lw-1\n";
      }),
    );
    expect(plan.problems).toEqual([
      expect.objectContaining({ file: "courses/broken.json" }),
      {
        file: "courses/twice.json",
        message: "outline.sections.0.lessons.0.video: videos/missing.mp4 is not there",
      },
      { file: "courses/twice.json", message: 'outline.sections.0.lessons.1.key "a" is used twice' },
      {
        file: "courses/twice.json",
        message: 'outline.sections.0.lessons.1.sourceId "x" is outline.sections.0.lessons.0\'s too',
      },
      { file: "bundles/bad.json", message: 'courses: "nope" is no course in courses/' },
      { file: "access.csv:2", message: "email is an address" },
      { file: "access.csv:3", message: "name a course or a bundle, not both" },
      { file: "progress.csv", message: 'The header has no "course" column' },
      { file: "progress.csv:2", message: '"" is no course in courses/' },
    ]);
  });

  it("a progress row whose lesson the folder lacks is not a folder problem (the import reports it)", () => {
    const plan = readCoursesFolder(
      folder((f) => (f.progress = "email,course,lesson\nana@example.com,handstands,lw-999\n")),
    );
    expect(plan.problems).toEqual([]);
  });

  it("reads the folder from disk, videos by size only", () => {
    const dir = mkdtempSync(join(tmpdir(), "cos-courses-"));
    for (const sub of ["courses", "videos", "captions", "downloads"]) mkdirSync(join(dir, sub));
    writeFileSync(join(dir, "courses", "handstands.json"), course());
    writeFileSync(join(dir, "videos", "wrists.mp4"), new Uint8Array(1234));
    writeFileSync(join(dir, "captions", "wrists.srt"), "1\n00:00:01,000 --> 00:00:02,000\nHi\n");
    writeFileSync(join(dir, "downloads", "sheet.pdf"), PDF);
    const disk = readCoursesDisk(dir);
    expect(disk.videos).toEqual(new Map([["wrists.mp4", 1234]]));
    expect(disk.access).toBeNull();
    expect(readCoursesFolder(disk).problems).toEqual([]);
  });

  it("sends a large video in tus chunks, picks up where Stream is after a drop, and shows progress", async () => {
    const bytes = Uint8Array.from({ length: 10 }, (_, i) => i);
    let received = 0;
    let patches = 0;
    const got: number[] = [];
    const send = async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (init?.method === "HEAD")
        return new Response(null, { headers: { "Upload-Offset": String(received) } });
      patches += 1;
      const chunk = init?.body as Uint8Array;
      if (patches === 2) {
        // The connection drops after Stream took the bytes, before the answer came back.
        received += chunk.byteLength;
        throw new Error("connection reset");
      }
      if (Number(headers.get("upload-offset")) !== received)
        return new Response("Offset mismatch", { status: 409 });
      got.push(...chunk);
      received += chunk.byteLength;
      return new Response(null, { status: 204, headers: { "Upload-Offset": String(received) } });
    };
    const shares: number[] = [];
    await sendVideo(
      { call: async () => ({}) as never, upload: async () => ({}) as never, send } as never,
      { url: "https://upload.example.com/x", protocol: "tus", chunkBytes: 4 },
      {
        size: bytes.byteLength,
        sha256: "0".repeat(64),
        read: async (o, l) => bytes.slice(o, o + l),
      },
      (share) => shares.push(share),
    );
    expect(received).toBe(10);
    // The dropped chunk (4 to 8) is not sent again: Stream said it had it.
    expect(got).toEqual([0, 1, 2, 3, 8, 9]);
    expect(shares).toEqual([0.4, 1]);
  });

  it("stops on a bad folder before signing in, and asks for --host", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cos-courses-"));
    mkdirSync(join(dir, "courses"));
    writeFileSync(join(dir, "courses", "bad.json"), "[]");
    const out: string[] = [];
    const deps: Parameters<typeof runCli>[1] = {
      io: {
        interactive: false,
        out: (l) => out.push(l),
        err: (l) => out.push(l),
        ask: async () => {
          throw new Error("no prompts in tests");
        },
      },
      redactor: new Redactor(),
      env: {},
      ghVerifier: null,
      fetch: (async () => {
        throw new Error("no network in this test");
      }) as never,
    };
    expect(await runCli(["courses", "import", dir], deps)).toBe(2);
    expect(out.join("\n")).toContain("--host");
    out.length = 0;
    expect(
      await runCli(["courses", "import", dir, "--host", "https://admin.example.com"], deps),
    ).toBe(1);
    expect(out.join("\n")).toContain("courses/bad.json: A course is a JSON object");
    expect(await runCli(["courses", "export"], deps)).toBe(2);
  });
});
