// The signed agreement as a PDF (stage 44 step 4, ADR 0645): the renderer the email gatekeeper
// uses for the copy's attachment and the host's download routes use, so the two files are the
// same bytes for the same values. It lays an agreement out on the shared core (`core.ts`, ADR
// 0737): the version's rich text blocks, the tick, a health form's questions, the record and the
// drawn strokes. Links are drawn as their text. Strokes are numbers checked by the caller.
//
// Its bytes are pinned by `test/agreement-golden.test.ts`: the generalisation changed none.
import {
  BODY_SIZE,
  encode,
  type Font,
  hex,
  Layout,
  LEFT,
  MAX_PAGES,
  num,
  type Piece,
  pdfFile,
  RIGHT,
  type Segment,
  widthOf,
} from "./core.ts";

/** A run of text in a block (ADR 0440's inline runs). */
export type PdfInline =
  | { type: "text"; text: string; bold?: boolean; italic?: boolean; code?: boolean; href?: string }
  | { type: "break" };

/** A list (ADR 0440): items with their own nested list. */
export interface PdfList {
  style: "bullet" | "ordered";
  items: { content: PdfInline[]; list?: PdfList }[];
}

/** The blocks of a version's body an agreement may hold (ADR 0640 refuses the others). */
export type PdfBlock =
  | { type: "paragraph"; content: PdfInline[] }
  | { type: "heading"; level: number; content: PdfInline[] }
  | ({ type: "list" } & PdfList)
  | { type: "quote"; content: PdfInline[]; attribution?: string }
  | { type: "callout"; tone: "info" | "note" | "success" | "warning"; content: PdfInline[] }
  | { type: "divider" }
  /** A picture: left out and named (an agreement's body holds none, ADR 0640). */
  | { type: "image"; alt?: string };

export interface PdfAnswer {
  key: string;
  yes: boolean;
  note?: string;
}

/** What the PDF says: the version, and the record of one acceptance (or blank lines for paper). */
export interface AgreementPdf {
  /** The business's name. */
  business: string;
  title: string;
  versionNumber: number;
  /** The version's SHA-256, 64 hex characters. */
  versionHash: string;
  body: { blocks: PdfBlock[] };
  tickLabel: string;
  /** A health form's questions. */
  questions?: { key: string; text: string }[];
  /**
   * A health form's answers, or where they are instead: `in-app` (the emailed copy, decision 21)
   * or `withheld` (staff without agreements:health).
   */
  answers?: PdfAnswer[] | "in-app" | "withheld";
  /** The record of the acceptance, as label and value; left out for a blank. */
  record?: { label: string; value: string }[];
  /** The drawn signature, in its 1000 × 400 box. */
  signature?: { width: number; height: number; strokes: number[][][] };
  /** The acceptance's id; left out for a blank. */
  acceptanceId?: string;
  /** A blank form to print for paper: lines to fill in instead of a record. */
  blank?: boolean;
}

/** The deepest a nested list indents: deeper items stay at this indent, on the page. */
const MAX_INDENT = 6 * 14;

const fontOf = (run: { bold?: boolean; italic?: boolean; code?: boolean }, base: Font): Font => {
  if (run.code) return "F5";
  const bold = run.bold || base === "F2" || base === "F4";
  const italic = run.italic || base === "F3" || base === "F4";
  return bold ? (italic ? "F4" : "F2") : italic ? "F3" : "F1";
};

/** A block's runs as lines of pieces (a `break`, or a newline in text, starts a new line). */
function piecesOf(content: readonly PdfInline[], base: Font): Piece[][] {
  const lines: Piece[][] = [[]];
  for (const run of content) {
    if (run.type === "break") {
      lines.push([]);
      continue;
    }
    const font = fontOf(run, base);
    // A link is drawn as its text, and its address beside it when the two differ.
    const shown = run.href && run.href !== run.text ? `${run.text} (${run.href})` : run.text;
    const parts = shown.split(/\r\n|\r|\n/);
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      (lines[lines.length - 1] as Piece[]).push({ font, text: part });
    });
  }
  return lines;
}

// --- Rendering ---------------------------------------------------------------------------------

const TONES: Record<string, string> = {
  info: "Information",
  note: "Note",
  success: "Note",
  warning: "Warning",
};

function blockGap(layout: Layout): void {
  layout.space(5);
}

function renderList(layout: Layout, list: PdfList, x: number): void {
  list.items.forEach((item, index) => {
    const marker = list.style === "ordered" ? `${index + 1}.` : "•";
    const prefix: Segment = { font: "F1", bytes: layout.encode(`${marker} `) };
    const indent = Math.min(x + 14, LEFT + MAX_INDENT);
    layout.paragraph(piecesOf(item.content, "F1"), indent, BODY_SIZE, { firstPrefix: prefix });
    if (item.list) renderList(layout, item.list, indent);
  });
}

function renderBlock(layout: Layout, block: PdfBlock): void {
  switch (block.type) {
    case "heading": {
      const size = block.level <= 1 ? 15 : block.level === 2 ? 13 : 11.5;
      layout.space(4);
      layout.ensure(size * 3);
      layout.paragraph(piecesOf(block.content, "F2"), LEFT, size, { leading: size * 1.3 });
      break;
    }
    case "paragraph":
      layout.paragraph(piecesOf(block.content, "F1"), LEFT, BODY_SIZE);
      break;
    case "list":
      renderList(layout, block, LEFT);
      break;
    case "quote":
      layout.paragraph(piecesOf(block.content, "F3"), LEFT + 18, BODY_SIZE);
      if (block.attribution) {
        layout.paragraph([[{ font: "F1", text: `— ${block.attribution}` }]], LEFT + 18, 9.5);
      }
      break;
    case "callout": {
      const label = TONES[block.tone] ?? "Note";
      layout.paragraph(
        piecesOf([{ type: "text", text: `${label}: `, bold: true }, ...block.content], "F1"),
        LEFT + 10,
        BODY_SIZE,
      );
      break;
    }
    case "divider":
      layout.rule(LEFT, RIGHT);
      break;
    case "image":
      layout.paragraph(
        [
          [
            {
              font: "F3",
              text: `[A picture is left out of this file${block.alt ? `: ${block.alt}` : ""}]`,
            },
          ],
        ],
        LEFT,
        BODY_SIZE,
      );
      break;
    default:
      // A block this writer does not know is named, never drawn from its contents.
      layout.paragraph(
        [[{ font: "F3", text: "[Something is left out of this file]" }]],
        LEFT,
        BODY_SIZE,
      );
  }
  blockGap(layout);
}

function heading(layout: Layout, text: string): void {
  layout.space(8);
  layout.ensure(40);
  layout.paragraph([[{ font: "F2", text }]], LEFT, 12, { leading: 17 });
  layout.space(2);
}

/** The signature's strokes, drawn in a box at the cursor. */
function drawSignature(layout: Layout, signature: NonNullable<AgreementPdf["signature"]>): void {
  const boxWidth = 240;
  const scale = boxWidth / Math.max(1, signature.width);
  const boxHeight = Math.max(1, signature.height) * scale;
  layout.ensure(boxHeight + 8);
  const top = layout.y - 2;
  const bottom = top - boxHeight;
  const ops = [
    `0.75 G 0.5 w ${num(LEFT)} ${num(bottom)} ${num(boxWidth)} ${num(boxHeight)} re S`,
    "0 G 1.2 w 1 J 1 j",
  ];
  for (const stroke of signature.strokes) {
    const points = stroke.map(([x, y]) => [
      LEFT + (x ?? 0) * scale,
      bottom + (signature.height - (y ?? 0)) * scale,
    ]);
    const first = points[0];
    if (!first) continue;
    const path = [`${num(first[0] as number)} ${num(first[1] as number)} m`];
    const rest = points.length > 1 ? points.slice(1) : [first];
    for (const p of rest) path.push(`${num(p[0] as number)} ${num(p[1] as number)} l`);
    ops.push(`${path.join(" ")} S`);
  }
  layout.page.push(ops.join("\n"));
  layout.y = bottom - 8;
}

function renderTick(layout: Layout, label: string, ticked: boolean): void {
  layout.ensure(20);
  const baseline = layout.y - BODY_SIZE;
  layout.box(LEFT, baseline, ticked);
  layout.paragraph([[{ font: "F2", text: label }]], LEFT + 16, BODY_SIZE);
}

function renderQuestions(layout: Layout, doc: AgreementPdf): void {
  const questions = doc.questions ?? [];
  if (!questions.length) return;
  heading(layout, "Health questions");
  const answers = Array.isArray(doc.answers) ? new Map(doc.answers.map((a) => [a.key, a])) : null;
  questions.forEach((q, index) => {
    const prefix: Segment = { font: "F1", bytes: layout.encode(`${index + 1}. `) };
    layout.paragraph([[{ font: "F1", text: q.text }]], LEFT + 16, BODY_SIZE, {
      firstPrefix: prefix,
    });
    if (doc.blank) {
      layout.ensure(18);
      const baseline = layout.y - BODY_SIZE;
      layout.box(LEFT + 16, baseline, false);
      layout.box(LEFT + 66, baseline, false);
      layout.line(
        [{ font: "F1", bytes: layout.encode("Yes") }],
        LEFT + 30,
        BODY_SIZE,
        BODY_SIZE * 1.4,
      );
      layout.page.push(
        `BT ${num(LEFT + 80)} ${num(baseline)} Td /F1 ${num(BODY_SIZE)} Tf ${hex(layout.encode("No"))} Tj ET`,
      );
      layout.paragraph(
        [[{ font: "F1", text: "If yes: ______________________________________________" }]],
        LEFT + 16,
        BODY_SIZE,
      );
    } else if (answers) {
      const answer = answers.get(q.key);
      const value = answer ? (answer.yes ? "Yes" : "No") : "Not answered";
      layout.paragraph(
        [
          [
            { font: "F2", text: "Answer: " },
            { font: "F1", text: value },
          ],
        ],
        LEFT + 16,
        BODY_SIZE,
      );
      if (answer?.note) {
        layout.paragraph([[{ font: "F3", text: answer.note }]], LEFT + 16, BODY_SIZE);
      }
    }
    layout.space(3);
  });
  if (doc.answers === "in-app") {
    layout.paragraph([[{ font: "F2", text: "Your answers are in the app." }]], LEFT, BODY_SIZE);
  } else if (doc.answers === "withheld") {
    layout.paragraph(
      [[{ font: "F3", text: "The answers are shown only to staff who may read health forms." }]],
      LEFT,
      BODY_SIZE,
    );
  }
}

function renderRecord(layout: Layout, doc: AgreementPdf): void {
  if (doc.blank) {
    heading(layout, "Signed on paper");
    for (const label of [
      "Name",
      "Signature",
      "Date",
      "For a child: who signs, and how they are related",
    ]) {
      layout.space(14);
      layout.paragraph(
        [[{ font: "F1", text: `${label}: ______________________________________________` }]],
        LEFT,
        BODY_SIZE,
      );
    }
    return;
  }
  heading(layout, "Record");
  for (const entry of doc.record ?? []) {
    layout.paragraph(
      [
        [
          { font: "F2", text: `${entry.label}: ` },
          { font: "F1", text: entry.value },
        ],
      ],
      LEFT,
      BODY_SIZE,
    );
  }
  if (doc.signature) {
    layout.space(4);
    layout.paragraph([[{ font: "F2", text: "Signature drawn:" }]], LEFT, BODY_SIZE);
    drawSignature(layout, doc.signature);
  }
}

function footer(doc: AgreementPdf, index: number, count: number): string {
  const size = 7.5;
  const tail = ` · version ${doc.versionNumber} · page ${index + 1} of ${count}`;
  const tailBytes = encode(tail).bytes;
  let title = encode(doc.title).bytes;
  const room = RIGHT - LEFT - widthOf(tailBytes, "F1", size);
  if (widthOf(title, "F1", size) > room) {
    const dots = encode("...").bytes;
    while (title.length && widthOf([...title, ...dots], "F1", size) > room)
      title = title.slice(0, -1);
    title = [...title, ...dots];
  }
  const second = encode(
    `SHA-256 ${doc.versionHash}${doc.acceptanceId ? ` · ${doc.acceptanceId}` : ""}`,
  ).bytes;
  return [
    "0.35 g",
    `BT /F1 ${num(size)} Tf ${num(LEFT)} 44 Td ${hex([...title, ...tailBytes])} Tj ET`,
    `BT /F5 ${num(size - 0.5)} Tf ${num(LEFT)} 33 Td ${hex(second)} Tj ET`,
    "0 g",
  ].join("\n");
}

/** Lays the document out, page by page, as content streams. */
function layoutPages(doc: AgreementPdf): string[] {
  const layout = new Layout("The agreement is too long for a PDF");
  layout.paragraph([[{ font: "F1", text: doc.business }]], LEFT, 10, { grey: true });
  layout.space(4);
  layout.paragraph([[{ font: "F2", text: doc.title }]], LEFT, 18, { leading: 23 });
  layout.paragraph(
    [
      [
        {
          font: "F1",
          text: doc.blank
            ? `Version ${doc.versionNumber}: a form to sign on paper`
            : `Version ${doc.versionNumber}`,
        },
      ],
    ],
    LEFT,
    10,
    { grey: true },
  );
  layout.rule(LEFT, RIGHT, 0.75);
  layout.space(4);
  for (const block of doc.body.blocks) renderBlock(layout, block);
  layout.space(4);
  layout.rule(LEFT, RIGHT, 0.75);
  layout.space(4);
  renderTick(layout, doc.tickLabel, !doc.blank);
  renderQuestions(layout, doc);
  renderRecord(layout, doc);
  if (layout.lossy) {
    layout.space(8);
    layout.paragraph(
      [
        [
          {
            font: "F3",
            text: "Some characters could not be drawn in this file and are shown as ?. The record holds them exactly.",
          },
        ],
      ],
      LEFT,
      9,
    );
  }
  const count = layout.pages.length;
  return layout.pages.map((ops, i) => `${ops.join("\n")}\n${footer(doc, i, count)}\n`);
}

/** The most pages a file may have: a document longer than this is refused when published. */
export const AGREEMENT_PDF_MAX_PAGES = MAX_PAGES;

/** How many pages `doc` takes, or throws when it is longer than the writer draws. */
export function agreementPdfPages(doc: AgreementPdf): number {
  return layoutPages(doc).length;
}

/** The PDF file of `doc`. The same `doc` always gives the same bytes. */
export function agreementPdf(doc: AgreementPdf): Uint8Array<ArrayBuffer> {
  return pdfFile(layoutPages(doc), {
    title: `${doc.title}, version ${doc.versionNumber}`,
    producer: "Composable OS agreements",
  });
}
