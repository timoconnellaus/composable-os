// Stage 28, step 5 (ADR 0440): the editor's edge. What the rich text editor holds is turned into
// the platform's schema on its way out, and nothing else leaves it: a pasted table or code block
// keeps its words, a script's text loses its markup, a link or an embed the host would refuse is
// dropped, and what comes out is always what the host stores. A stored document goes into the
// editor and out again unchanged.
import { RICH_TEXT_FIXTURE, RICH_TEXT_SCHEMA, validateDocument } from "@composable-os/sdk";
import { describe, expect, it } from "vitest";
import {
  cleanText,
  fromRichText,
  type PmNode,
  richTextProblem,
  richTextSummary,
  toRichText,
} from "../src/lib/rich-text-map.ts";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("out of the editor", () => {
  it("keeps the platform's blocks and marks, and only them", () => {
    const pasted: PmNode = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hello ", marks: [{ type: "bold" }, { type: "strike" }] },
            { type: "text", text: "<script>alert(1)</script>world", marks: [{ type: "italic" }] },
            { type: "text", text: "&lt;b&gt;loud&lt;/b&gt; &amp; clear" },
            {
              type: "text",
              text: "bad link",
              marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
            },
            {
              type: "text",
              text: "good link",
              marks: [{ type: "link", attrs: { href: "https://example.com" } }],
            },
          ],
        },
        // A pasted table and code block: their words, as paragraphs.
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Cell" }] }],
                },
              ],
            },
          ],
        },
        { type: "codeBlock", content: [{ type: "text", text: "rm -rf /" }] },
        { type: "embed", attrs: { url: "data:text/html,<script>alert(1)</script>" } },
        { type: "embed", attrs: { url: "https://vimeo.com/76979871", caption: "<i>Trailer</i>" } },
        { type: "ctaButton", attrs: { label: "Go", href: "javascript:void(0)" } },
        { type: "image", attrs: { src: "https://evil.test/x.png" } },
        { type: "paragraph" },
      ],
    };
    const out = toRichText(pasted);
    expect(richTextProblem(out)).toBeNull();
    expect(validateDocument(RICH_TEXT_SCHEMA, out)).toMatchObject({ ok: true });
    expect(out.blocks).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Hello ", bold: true },
          { type: "text", text: "alert(1)world", italic: true },
          { type: "text", text: "loud & clear" },
          { type: "text", text: "bad link" },
          { type: "text", text: "good link", href: "https://example.com" },
        ],
      },
      { type: "paragraph", content: [{ type: "text", text: "Cell" }] },
      { type: "paragraph", content: [{ type: "text", text: "rm -rf /" }] },
      { type: "embed", url: "https://vimeo.com/76979871", caption: "Trailer" },
    ]);
    expect(JSON.stringify(out)).not.toMatch(/<|javascript:|data:/);
  });

  it("text never keeps markup, however it is spelled", () => {
    for (const hostile of [
      "<img src=x onerror=alert(1)>",
      "&#60;script&#62;",
      "&#x3C;b&#x3E;",
      "<<b>b>",
      "&amp;lt;script&amp;gt;",
      "<!-- x -->",
    ]) {
      const cleaned = cleanText(hostile);
      const value = {
        blocks: [{ type: "paragraph", content: [{ type: "text", text: cleaned || "x" }] }],
      };
      expect(richTextProblem(value), `${hostile} → ${cleaned}`).toBeNull();
    }
    expect(cleanText("Fish & chips, a < b")).toBe("Fish & chips, a < b");
  });
});

describe("into the editor and out", () => {
  it("a stored document comes back as it was (a picture's caption as plain text)", () => {
    const expected = clone(RICH_TEXT_FIXTURE) as unknown as { blocks: Record<string, unknown>[] };
    const image = expected.blocks.find((b) => b.type === "image") as Record<string, unknown>;
    image.caption = [{ type: "text", text: "Last summer, sold out" }];
    expect(toRichText(fromRichText(RICH_TEXT_FIXTURE))).toEqual(expected);
  });

  it("an empty one is an empty paragraph, and words summarise a document", () => {
    expect(fromRichText(null)).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
    expect(toRichText(fromRichText(null))).toEqual({ blocks: [] });
    expect(richTextSummary(RICH_TEXT_FIXTURE)).toMatch(/^Summer at the hall Doors open at seven/);
  });
});
