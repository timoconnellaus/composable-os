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
  // The section's name, as the host gives it with the procedure (staffNames, ADR 0708).
  names: { section: { id: "rec_safety", title: "Safety", order: 2 } },
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

  it("groups procedures by their section, in its order, labelled by the name the host gave, asking for no sections", () => {
    const fire: Published = {
      ...procedure,
      id: "rec_fire",
      values: { ...procedure.values, title: "Fire alarm" },
      names: { section: { id: "rec_desk", title: "Front desk", order: 1 } },
    };
    // First by its order, though its name sorts last; and a second "Safety" stays its own group.
    const yard: Published = {
      ...procedure,
      id: "rec_yard",
      values: { ...procedure.values, title: "Yard gates" },
      names: { section: { id: "rec_zone", title: "Zones outside", order: 0 } },
    };
    const twin: Published = {
      ...procedure,
      id: "rec_twin",
      values: { ...procedure.values, title: "Pool safety" },
      names: { section: { id: "rec_safety_2", title: "Safety", order: 5 } },
    };
    const loose: Published = {
      ...procedure,
      id: "rec_loose",
      values: { ...procedure.values, title: "Lost property", section: null },
      names: {},
    };
    const list = web(
      <Procedures
        knowledge={hooks({
          procedures: {
            data: { items: [procedure, fire, loose, yard, twin], nextCursor: null },
          },
        })}
      />,
    );
    const order = [
      "Zones outside",
      "Yard gates",
      "Front desk",
      "Fire alarm",
      "Safety",
      "When someone is hurt",
      "Pool safety",
      "Other",
      "Lost property",
    ];
    const at = order.map((words) => list.indexOf(words));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(list).toContain('data-to-read=""');
    expect(list.match(/<h2[^>]*>Safety<\/h2>/g)).toHaveLength(2);
    // The hooks the blocks are given hold no sections read: none can be asked for.
    expect(Object.keys(hooks({}))).not.toContain("useSections");
  });

  it("asks for no picture the host said it will not serve this reader (a pack role)", () => {
    const shown = web(<ProcedureReader knowledge={hooks({})} id="rec_injury" />);
    expect(shown).toMatch(/<img [^>]*src="\/api\/media\/med_01FIXTURE/);
    const withheld = web(
      <ProcedureReader
        knowledge={hooks({ procedure: { data: { ...procedure, pictures: false } } })}
        id="rec_injury"
      />,
    );
    expect(withheld).not.toContain("<img");
    expect(withheld).toContain("This picture cannot be shown here: The hall from the stage, full.");
    const native = web(
      <NativeReader
        knowledge={hooks({ procedure: { data: { ...procedure, pictures: false } } })}
        id="rec_injury"
        {...nativeProps}
      />,
    );
    expect(native).not.toContain("<rn-image");
    expect(native).toContain("This picture cannot be shown here");
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

  it("draws a page's related pages, each linked by its address", () => {
    const parking: Published = {
      object: "knowledge.helppage",
      id: "rec_parking",
      values: { title: "Parking", slug: "parking", order: 1 },
    };
    const html = web(
      <HelpArticle
        knowledge={hooks({ pages: { data: { items: [parking], nextCursor: null } } })}
        page={{ ...helpPage, values: { ...helpPage.values, related: ["rec_parking"] } }}
      />,
    );
    expect(html).toMatch(
      /<nav aria-label="Related pages"[^>]*>.*href="\/help\/parking"[^>]*>Parking<\/a>/s,
    );
    // With none related, no list is drawn.
    expect(web(<HelpArticle knowledge={hooks({})} page={helpPage} />)).not.toContain("Related");
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
