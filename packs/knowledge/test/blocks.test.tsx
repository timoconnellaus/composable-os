// Stage 38 step 6 (ADR 0708), acceptance criterion 14: the help centre and the procedure reader
// draw the same fixtures through the web and the native blocks, every rich-text block type and
// the section anchors included; and the blocks show only what the host answered: the confirm
// button names what is confirmed and exists only for a version on screen that the reader is asked
// to confirm, and read status shows a refusal and nothing else to an account the host refused.
// The native blocks are drawn with React Native's components as plain elements
// (react-native-shim.tsx): which element each part becomes is checked, not how a phone paints it.
import { RICH_TEXT_BLOCKS, RICH_TEXT_FIXTURE } from "@composable-os/sdk";
import { headingAnchors } from "@composable-os/sdk/rich-text";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HelpCentre } from "../blocks/knowledge-help-centre/help-centre.tsx";
import { HelpArticle, HelpPageHead } from "../blocks/knowledge-help-page/help-page.tsx";
import { HelpPageScreen } from "../blocks/knowledge-native-help/help-screen.tsx";
import { ProcedureScreen as NativeReader } from "../blocks/knowledge-native-procedures/procedures-screen.tsx";
import { ToReadScreen } from "../blocks/knowledge-native-to-read/to-read-screen.tsx";
import { ProcedureReader, Procedures } from "../blocks/knowledge-procedures/procedures.tsx";
import { ReadStatus } from "../blocks/knowledge-read-status/read-status.tsx";
import { ToRead } from "../blocks/knowledge-to-read/to-read.tsx";
import type { KnowledgeHooks, Published, ToReadAnswer } from "../client/index.ts";

const BODY = RICH_TEXT_FIXTURE;
const ANCHORS = headingAnchors(BODY);

const procedure: Published = {
  object: "knowledge.procedure",
  id: "rec_injury",
  values: {
    title: "When someone is hurt",
    slug: "when-someone-is-hurt",
    summary: "What the coach on duty does first.",
    body: BODY,
    section: "rec_safety",
  },
  version: 4,
  publishedAt: "2026-03-03T09:00:00.000Z",
};

const helpPage: Published = {
  object: "knowledge.helppage",
  id: "rec_pause",
  values: {
    title: "Pausing your membership",
    slug: "pausing",
    summary: "Up to three months a year.",
    body: BODY,
    related: [],
  },
};

const asked: ToReadAnswer = {
  toRead: [
    {
      id: "rec_injury",
      title: "When someone is hurt",
      version: 4,
      publishedAt: "2026-03-03T09:00:00.000Z",
      since: "2026-03-03T09:00:00.000Z",
    },
  ],
  confirmed: [],
};

type Answer = { data?: unknown; error?: unknown; isPending?: boolean };
const answered = ({ data, error = null, isPending = false }: Answer) => ({
  data,
  error,
  isPending,
  refetch: async () => undefined,
});
const mutation = () => ({
  mutate() {},
  mutateAsync: async () => ({ id: "rec_injury", version: 4, confirmedAt: "2026-03-04T08:00:00Z" }),
  data: undefined,
  isPending: false,
  error: null,
});

/** The blocks' hooks, each answering as given (what the host would have answered). */
function hooks(answers: {
  procedure?: Answer;
  toRead?: Answer;
  sections?: Answer;
  procedures?: Answer;
  readStatus?: (id?: string) => Answer;
  topics?: Answer;
  pages?: Answer;
}): KnowledgeHooks {
  return {
    useProcedure: () => answered(answers.procedure ?? { data: procedure }),
    useProcedures: () =>
      answered(answers.procedures ?? { data: { items: [procedure], nextCursor: null } }),
    useSearchProcedures: () => answered({ data: { items: [], nextCursor: null } }),
    useToRead: () => answered(answers.toRead ?? { data: asked }),
    useConfirm: mutation,
    useSections: () =>
      answered(
        answers.sections ?? {
          data: { items: [{ id: "rec_safety", values: { name: "Safety" } }], nextCursor: null },
        },
      ),
    useReadStatus: (id?: string) => answered(answers.readStatus?.(id) ?? { data: undefined }),
    useHelpTopics: () => answered(answers.topics ?? { data: { topics: [] } }),
    useHelpPages: () => answered(answers.pages ?? { data: { items: [], nextCursor: null } }),
    useHelpPage: () => answered({ data: { ...helpPage, kind: "record" } }),
    useSearchHelp: () => answered({ data: { items: [], nextCursor: null } }),
  } as unknown as KnowledgeHooks;
}

const web = (node: ReactElement) => renderToStaticMarkup(node);
const nativeProps = {
  openUrl: () => {},
  mediaUrl: (id: string, w: number) => `https://host.test/api/v1/media/${id}?w=${w}`,
  width: 750,
};

function expectEveryBlock(html: string, tree: string) {
  for (const type of RICH_TEXT_BLOCKS) {
    expect(html, `web ${type}`).toContain(`data-block="${type}"`);
    expect(tree, `native ${type}`).toMatch(new RegExp(`data-testid="rt-block-${type}`));
  }
  const webAnchors = [...html.matchAll(/<h\d id="([^"]+)" data-block="heading"/g)].map((m) => m[1]);
  const nativeAnchors = [...tree.matchAll(/data-native-id="([^"]+)"/g)].map((m) => m[1]);
  expect(webAnchors).toEqual(ANCHORS);
  expect(nativeAnchors).toEqual(ANCHORS);
}

describe("the procedure reader, web and native, from one fixture", () => {
  const html = web(<ProcedureReader knowledge={hooks({})} id="rec_injury" />);
  const tree = web(<NativeReader knowledge={hooks({})} id="rec_injury" {...nativeProps} />);

  it("draws every rich-text block type with the host's anchors, in both skins", () => {
    expectEveryBlock(html, tree);
  });

  it("says which wording it is: the version and when it was published, and its section", () => {
    for (const out of [html, tree]) {
      expect(out).toContain("Version 4, published 3 March 2026");
      expect(out).toContain("When someone is hurt");
      expect(out).toContain("Safety");
    }
  });

  it("asks for the confirmation at the end, naming the procedure and the version shown", () => {
    const label = "I have read and understood &quot;When someone is hurt&quot; (version 4)";
    expect(html).toContain(label);
    expect(tree).toContain(label);
    // After the body: the text comes first, the button last.
    expect(html.lastIndexOf('data-block="')).toBeLessThan(html.indexOf(label));
  });

  it("offers no confirm button for a version older than the one to confirm: it asks to read that", () => {
    const newer = {
      ...asked,
      toRead: [{ ...(asked.toRead[0] as ToReadAnswer["toRead"][number]), version: 5 }],
    };
    const stale = web(
      <ProcedureReader knowledge={hooks({ toRead: { data: newer } })} id="rec_injury" />,
    );
    expect(stale).not.toContain("I have read and understood");
    expect(stale).toContain("Version 5 has been published since you opened this one");
    const staleNative = web(
      <NativeReader
        knowledge={hooks({ toRead: { data: newer } })}
        id="rec_injury"
        {...nativeProps}
      />,
    );
    expect(staleNative).not.toContain("I have read and understood");
  });

  it("offers no confirm button to someone not asked, or already confirmed", () => {
    const none = web(
      <ProcedureReader
        knowledge={hooks({ toRead: { data: { toRead: [], confirmed: [] } } })}
        id="rec_injury"
      />,
    );
    expect(none).not.toContain("I have read and understood");
    expect(none).toContain("You are not asked to confirm this procedure.");
    const done = web(
      <ProcedureReader
        knowledge={hooks({
          toRead: {
            data: {
              toRead: [],
              confirmed: [
                {
                  id: "rec_injury",
                  title: "x",
                  version: 4,
                  publishedAt: "",
                  confirmedAt: "2026-03-04T08:00:00Z",
                },
              ],
            },
          },
        })}
        id="rec_injury"
      />,
    );
    expect(done).not.toContain("I have read and understood");
    expect(done).toContain(
      "You confirmed this procedure on 4 March 2026: it counts for version 4.",
    );
  });

  it("lists procedures without sections for an account refused them (a pack role)", () => {
    const refused = { error: { code: "forbidden", message: "no" } };
    const list = web(<Procedures knowledge={hooks({ sections: refused })} />);
    expect(list).toContain("When someone is hurt");
    expect(list).not.toContain("Safety");
    expect(list).toContain('data-to-read=""');
    const reader = web(
      <ProcedureReader knowledge={hooks({ sections: refused })} id="rec_injury" />,
    );
    expect(reader).not.toContain('data-section=""');
  });

  it("says a procedure that is not published is not here, never showing anything else", () => {
    const gone = web(
      <ProcedureReader
        knowledge={hooks({ procedure: { error: { code: "not_found", message: "No published" } } })}
        id="rec_injury"
      />,
    );
    expect(gone).toContain("This procedure is not published, or it has been unpublished.");
    expect(gone).not.toContain("I have read and understood");
  });
});

describe("to read, web and native", () => {
  it("lists what is mine to read with its version and since when", () => {
    const html = web(<ToRead knowledge={hooks({})} />);
    const tree = web(<ToReadScreen knowledge={hooks({})} {...nativeProps} />);
    for (const out of [html, tree]) {
      expect(out).toContain("When someone is hurt");
      expect(out).toContain("Version 4, published 3 March 2026 · to read since 3 March 2026");
    }
    const empty = web(
      <ToRead knowledge={hooks({ toRead: { data: { toRead: [], confirmed: [] } } })} />,
    );
    expect(empty).toContain("Nothing to read: you are up to date.");
  });
});

describe("read status", () => {
  const status = {
    procedures: [],
    procedure: {
      id: "rec_injury",
      title: "When someone is hurt",
      version: 4,
      publishedAt: "2026-03-03T09:00:00.000Z",
      everyone: true,
      roles: [],
      people: [
        {
          account: "usr_sam",
          name: "Sam Lee",
          email: "sam@example.com",
          confirmed: null,
          lastConfirmed: null,
          since: "2026-03-03T09:00:00.000Z",
        },
      ],
    },
  };

  it("shows every procedure's counts from the host's answer", () => {
    const html = web(
      <ReadStatus
        knowledge={hooks({
          readStatus: () => ({
            data: {
              procedures: [
                {
                  id: "rec_injury",
                  title: "When someone is hurt",
                  version: 4,
                  publishedAt: "2026-03-03T09:00:00.000Z",
                  mustRead: 6,
                  confirmed: 2,
                },
              ],
              procedure: null,
            },
          }),
        })}
      />,
    );
    expect(html).toContain("2 of 6 confirmed");
  });

  it("shows only the refusal to an account the host refused: no procedure, no person", () => {
    const html = web(
      <ReadStatus
        knowledge={hooks({
          readStatus: () => ({
            error: { code: "forbidden", message: "no" },
            // Whatever else came with the refusal is not shown.
            data: status,
          }),
        })}
      />,
    );
    expect(html).toContain(
      "Read status is for admins and the people they allow to manage procedures.",
    );
    expect(html).not.toContain("When someone is hurt");
    expect(html).not.toContain("Sam Lee");
    expect(html).not.toContain("confirmed");
  });
});

describe("the help centre, web and native, from one fixture", () => {
  it("draws a help page's every rich-text block type with the host's anchors, in both skins", () => {
    const html = web(
      <HelpArticle knowledge={hooks({})} page={helpPage} hrefOf={(s) => `/help/${s}`} />,
    );
    const tree = web(
      <HelpPageScreen
        knowledge={hooks({})}
        slug="pausing"
        onOpenPage={() => {}}
        onRedirect={() => {}}
        {...nativeProps}
      />,
    );
    expectEveryBlock(html, tree);
    for (const out of [html, tree]) expect(out).toContain("Pausing your membership");
  });

  it("escapes what a page says: nothing is markup", () => {
    const hostile: Published = {
      ...helpPage,
      values: {
        ...helpPage.values,
        title: "<img src=x onerror=alert(1)>",
        body: {
          blocks: [{ type: "paragraph", content: [{ type: "text", text: "<script>x</script>" }] }],
        },
      },
    };
    const html = web(
      <HelpArticle knowledge={hooks({})} page={hostile} hrefOf={(s) => `/help/${s}`} />,
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("lists the topics with their pages, linking each page by its address", () => {
    const html = web(
      <HelpCentre
        knowledge={hooks({
          topics: {
            data: {
              topics: [
                {
                  id: "rec_t",
                  name: "Memberships",
                  slug: "memberships",
                  order: 1,
                  icon: "credit-card",
                },
              ],
            },
          },
          pages: { data: { items: [helpPage], nextCursor: null } },
        })}
        hrefOf={(s) => `/help/${s}`}
      />,
    );
    expect(html).toContain("Memberships");
    expect(html).toContain('href="/help/pausing"');
    expect(html).toContain("<search");
  });

  it("gives the page's head its search title, description and noindex", () => {
    const html = web(
      <HelpPageHead
        page={{ ...helpPage, values: { ...helpPage.values, seoTitle: "Pause", noindex: true } }}
      />,
    );
    expect(html).toContain("<title>Pause</title>");
    expect(html).toContain('<meta name="description" content="Up to three months a year."/>');
    expect(html).toContain('<meta name="robots" content="noindex"/>');
  });
});
