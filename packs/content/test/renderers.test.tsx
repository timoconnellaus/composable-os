// Stage 28, acceptance criterion 7: two renderers. The one fixture document (RICH_TEXT_FIXTURE,
// every block type and every mark) renders through the web block and through the native block,
// each drawing every block type and mark as its own element, with the same words, and nothing as
// HTML. The native block is drawn with React Native's components as plain elements
// (react-native-shim.tsx): which element each part becomes is checked, not how a phone paints it.
import { RICH_TEXT_BLOCKS, RICH_TEXT_FIXTURE } from "@composable-os/sdk";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RichTextView } from "../blocks/content-native-rich-text/rich-text-view.tsx";
import { RichText } from "../blocks/content-rich-text/rich-text.tsx";
import { plainText, type RichText as RichTextValue } from "../client/index.ts";

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
    expect(html).toMatch(/<h3 data-block="heading" data-level="2"/);
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
