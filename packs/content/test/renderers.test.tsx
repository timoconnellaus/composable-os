// Stage 28, acceptance criterion 7: two renderers. The one fixture document (RICH_TEXT_FIXTURE,
// every block type and every mark) renders through the web block and through the native block,
// each drawing every block type and mark as its own element, with the same words, and nothing as
// HTML. The native block is drawn with React Native's components as plain elements
// (react-native-shim.tsx): which element each part becomes is checked, not how a phone paints it.
import { RICH_TEXT_BLOCKS, RICH_TEXT_FIXTURE } from "@composable-os/sdk";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RichTextView } from "../blocks/content-native-rich-text/rich-text-view.tsx";
import { PostHead } from "../blocks/content-post/post-page.tsx";
import { RichText } from "../blocks/content-rich-text/rich-text.tsx";
import { headingAnchors, plainText, type RichText as RichTextValue } from "../client/index.ts";

const fixture = RICH_TEXT_FIXTURE as unknown as RichTextValue;
const words = plainText(fixture)
  .split(/\s+/)
  .map((w) => w.replace(/[.,:]/g, ""))
  .filter((w) => w.length > 3);

describe("the web renderer", () => {
  const html = renderToStaticMarkup(
    <RichText value={fixture} mediaUrl={(id, w) => `https://cdn.test/media/${id}?w=${w}`} />,
  );

  it("draws every block type", () => {
    for (const type of RICH_TEXT_BLOCKS) expect(html, type).toContain(`data-block="${type}"`);
    expect(html).toContain('data-style="bullet"');
    expect(html).toContain('data-style="ordered"');
    expect(html).toMatch(/<h3 id="summer-at-the-hall" data-block="heading" data-level="2"/);
    expect(html).toContain('data-tone="warning"');
    expect(html).toContain('<hr data-block="divider"/>');
  });

  it("draws every mark", () => {
    for (const mark of ["bold", "italic", "code", "link", "break"]) {
      expect(html, mark).toContain(`data-mark="${mark}"`);
    }
    expect(html).toContain('<a data-mark="link" href="/events"');
    expect(html).toContain('href="mailto:hello@example.com"');
    // Bold and italic on one run nest.
    expect(html).toMatch(/<strong data-mark="bold"><em data-mark="italic">Tickets are on the /);
  });

  it("shows a picture from the media route, a video from its player, and a button as a link", () => {
    expect(html).toContain('src="https://cdn.test/media/med_01FIXTURE0000000000000000?w=960"');
    expect(html).toContain('alt="The hall from the stage, full"');
    expect(html).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
    expect(html).toContain('href="https://tickets.example.com/summer"');
    expect(html).toContain(">Get tickets</a>");
  });

  it("asks this site's /api/media route for pictures by default, or another base (issue #181)", () => {
    const here = renderToStaticMarkup(<RichText value={fixture} />);
    expect(here).toContain('src="/api/media/med_01FIXTURE0000000000000000?w=960"');
    const there = renderToStaticMarkup(<RichText value={fixture} mediaBase="https://cdn.test/" />);
    expect(there).toContain('src="https://cdn.test/api/media/med_01FIXTURE0000000000000000?w=960"');
  });

  it("says every word of the document, and nothing as markup", () => {
    for (const word of words) expect(html, word).toContain(word);
    const hostile = {
      blocks: [
        { type: "paragraph", content: [{ type: "text", text: "<script>alert(1)</script>" }] },
      ],
    } as RichTextValue;
    const escaped = renderToStaticMarkup(<RichText value={hostile} />);
    expect(escaped).not.toContain("<script>");
    expect(escaped).toContain("&lt;script&gt;");
  });
});

describe("the native renderer", () => {
  const tree = renderToStaticMarkup(
    <RichTextView
      value={fixture}
      openUrl={() => {}}
      mediaUrl={(id, w) => `https://host.test/api/media/${id}?w=${w}`}
      width={750}
    />,
  );

  it("draws every block type", () => {
    for (const type of RICH_TEXT_BLOCKS) {
      expect(tree, type).toMatch(new RegExp(`data-testid="rt-block-${type}`));
    }
    expect(tree).toContain('data-testid="rt-block-list-bullet"');
    expect(tree).toContain('data-testid="rt-block-list-ordered"');
    expect(tree).toContain('data-testid="rt-block-embed-youtube"');
    expect(tree).toContain('data-testid="rt-block-callout-warning"');
    expect(tree).toContain('data-role="header"');
    expect(tree).toContain('data-role="button"');
  });

  it("draws every mark", () => {
    for (const mark of ["bold", "italic", "code", "link", "break"]) {
      expect(tree, mark).toMatch(new RegExp(`data-testid="rt-mark-[a-z-]*${mark}`));
    }
    expect(tree).toContain('data-testid="rt-mark-bold-italic"');
    expect(tree).toContain('data-role="link"');
  });

  it("shows the picture at the screen's width, with its alt text", () => {
    expect(tree).toContain(
      'data-src="https://host.test/api/media/med_01FIXTURE0000000000000000?w=750"',
    );
    expect(tree).toContain('data-label="The hall from the stage, full"');
  });

  it("says every word of the document", () => {
    for (const word of words) expect(tree, word).toContain(word);
  });
});

describe("section anchors (stage 38, ADR 0700)", () => {
  // Two headings with the same words, one with none: told apart by their order.
  const doc = {
    blocks: [
      ...fixture.blocks,
      { type: "heading", level: 2, content: [{ type: "text", text: "Summer at the hall!" }] },
      { type: "heading", level: 3, content: [{ type: "text", text: "…" }] },
    ],
  } as RichTextValue;
  const anchors = headingAnchors(doc);

  it("are made from a heading's words and its place, the host's rule", () => {
    expect(anchors).toEqual(["summer-at-the-hall", "summer-at-the-hall-2", "section"]);
  });

  it("are each heading's id on the web and its nativeID in the app, the same in both", () => {
    const html = renderToStaticMarkup(<RichText value={doc} />);
    const tree = renderToStaticMarkup(
      <RichTextView value={doc} openUrl={() => {}} mediaUrl={() => ""} />,
    );
    const web = [...html.matchAll(/<h\d id="([^"]+)" data-block="heading"/g)].map((m) => m[1]);
    const native = [...tree.matchAll(/data-native-id="([^"]+)"/g)].map((m) => m[1]);
    expect(web).toEqual(anchors);
    expect(native).toEqual(anchors);
  });
});

describe("a post page's head (ADR 0470)", () => {
  const post = {
    object: "content.post",
    id: "rec_1",
    values: {
      title: "Opening night",
      excerpt: "Doors at seven.",
      cover: { media: "med_cover", alt: "The stage" },
      seoTitle: "Opening night at the hall",
      seoImage: { media: "med_share", alt: "The poster" },
      noindex: true,
      byline: "Words by Sam Lee",
    },
  };

  it("renders the search title, description, share picture, canonical and noindex", () => {
    const html = renderToStaticMarkup(
      <PostHead post={post} url="https://hall.test/blog/opening" origin="https://hall.test" />,
    );
    expect(html).toContain("<title>Opening night at the hall</title>");
    expect(html).toContain('<meta name="description" content="Doors at seven."/>');
    expect(html).toContain('content="https://hall.test/api/media/med_share?w=1200"');
    expect(html).toContain('<link rel="canonical" href="https://hall.test/blog/opening"/>');
    expect(html).toContain('<meta name="robots" content="noindex"/>');
  });

  it("falls back to the title with the site's name, and the cover", () => {
    const plain = { ...post, values: { title: "Second week", cover: post.values.cover } };
    const html = renderToStaticMarkup(<PostHead post={plain} siteName="The Hall" />);
    expect(html).toContain("<title>Second week · The Hall</title>");
    expect(html).toContain('content="/api/media/med_cover?w=1200"');
    expect(html).not.toContain("robots");
  });
});
