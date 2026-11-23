// The signed agreement as a PDF (stage 44 step 4, ADR 0645): a small PDF writer of our own, used
// by the email gatekeeper for the copy's attachment and by the host's download routes, so the two
// files are the same bytes for the same values. Its own package (`@composable-os/agreement-pdf`),
// with no dependencies, so neither the host's core nor its runner carries it.
//
// - Plain PDF 1.4: the standard Helvetica and Courier fonts (no font is embedded, no file or
//   network is read), WinAnsi text, no compression, no dates, no ids: the same values always make
//   the same bytes. It runs anywhere JavaScript runs (no Node API).
// - Nothing given can become PDF structure. Every piece of text (the document's words, a name
//   typed, a note) is written as a hex string of WinAnsi bytes, `<48656C6C6F>`, so no parenthesis,
//   backslash, newline or `endstream` in it can close a string, start an operator or end a stream.
//   Control, bidirectional and zero-width characters are dropped; a character the standard fonts
//   cannot draw is written as `?`, and the file says so. Links are drawn as their text; no action,
//   annotation, script or form field is ever written.
// - Strokes are numbers checked by the caller, written as fixed-precision numbers.
//
// No imports.

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

// --- Fonts and text ----------------------------------------------------------------------------

type Font = "F1" | "F2" | "F3" | "F4" | "F5";
const FONTS: Record<Font, string> = {
  F1: "Helvetica",
  F2: "Helvetica-Bold",
  F3: "Helvetica-Oblique",
  F4: "Helvetica-BoldOblique",
  F5: "Courier",
};

// Advance widths (1/1000 em) of WinAnsi 32 to 126, from the standard fonts' metrics.
const REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
  611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

// WinAnsi bytes 0x80 to 0x9F, by Unicode code point.
const WIN_ANSI_HIGH: Record<number, number> = {
  8364: 0x80,
  8218: 0x82,
  402: 0x83,
  8222: 0x84,
  8230: 0x85,
  8224: 0x86,
  8225: 0x87,
  710: 0x88,
  8240: 0x89,
  352: 0x8a,
  8249: 0x8b,
  338: 0x8c,
  381: 0x8e,
  8216: 0x91,
  8217: 0x92,
  8220: 0x93,
  8221: 0x94,
  8226: 0x95,
  8211: 0x96,
  8212: 0x97,
  732: 0x98,
  8482: 0x99,
  353: 0x9a,
  8250: 0x9b,
  339: 0x9c,
  382: 0x9e,
  376: 0x9f,
};
// Widths of the wide ones above 126 (the rest take their base letter's, or an average).
const WIDE: Record<number, number> = {
  133: 1000,
  137: 1000,
  140: 1000,
  151: 1000,
  153: 1000,
  156: 944,
  169: 737,
  174: 737,
  188: 834,
  189: 834,
  190: 834,
  198: 1000,
  230: 889,
};

/** Characters dropped from any text: controls, bidirectional controls and zero-width ones. */
function dropped(code: number): boolean {
  return (
    code < 32 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff ||
    code === 0xad
  );
}

/** One character as its WinAnsi byte, or null when the standard fonts cannot draw it. */
function winAnsi(code: number): number | null {
  if (code >= 32 && code <= 126) return code;
  if (code >= 0xa0 && code <= 0xff) return code;
  return WIN_ANSI_HIGH[code] ?? null;
}

/** A text's WinAnsi bytes, and whether any character had to be written as `?`. */
interface Encoded {
  bytes: number[];
  lossy: boolean;
}

function encode(text: string): Encoded {
  const bytes: number[] = [];
  let lossy = false;
  for (const char of text.normalize("NFC")) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 9) {
      bytes.push(32);
      continue;
    }
    if (dropped(code)) continue;
    const byte = winAnsi(code);
    if (byte === null) {
      lossy = true;
      bytes.push(63);
    } else bytes.push(byte);
  }
  return { bytes, lossy };
}

function byteWidth(byte: number, font: Font): number {
  if (font === "F5") return 600;
  const bold = font === "F2" || font === "F4";
  if (byte >= 32 && byte <= 126) return ((bold ? BOLD : REGULAR)[byte - 32] as number) ?? 556;
  const wide = WIDE[byte];
  if (wide) return wide;
  if (byte === 0xa0) return 278;
  // An accented letter is about as wide as its letter.
  const base = String.fromCharCode(byte).normalize("NFD").charCodeAt(0);
  if (base >= 65 && base <= 122) {
    return Math.max(((bold ? BOLD : REGULAR)[base - 32] as number) ?? 556, 278);
  }
  return bold ? 611 : 556;
}

function widthOf(bytes: readonly number[], font: Font, size: number): number {
  let total = 0;
  for (const b of bytes) total += byteWidth(b, font);
  return (total * size) / 1000;
}

function hex(bytes: readonly number[]): string {
  let out = "<";
  for (const b of bytes) out += b.toString(16).padStart(2, "0").toUpperCase();
  return `${out}>`;
}

/** A number as PDF writes it: fixed precision, so the same input gives the same bytes. */
function num(n: number): string {
  // Values are checked by their callers; anything not a finite number is drawn at 0, never as
  // `NaN` or `Infinity` in the file.
  if (!Number.isFinite(n)) return "0";
  const fixed = (Math.round(n * 100) / 100).toFixed(2);
  return fixed.replace(/\.?0+$/, "") || "0";
}

// --- Layout ------------------------------------------------------------------------------------

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const LEFT = 56;
const RIGHT = PAGE_WIDTH - 56;
const TOP = PAGE_HEIGHT - 60;
const BOTTOM = 76;
const MAX_PAGES = 400;
/** The deepest a nested list indents: deeper items stay at this indent, on the page. */
const MAX_INDENT = 6 * 14;

const BODY_SIZE = 10.5;

interface Segment {
  font: Font;
  bytes: number[];
}

interface Piece {
  font: Font;
  text: string;
}

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

class Layout {
  readonly pages: string[][] = [];
  y = TOP;
  lossy = false;

  constructor() {
    this.newPage();
  }

  get page(): string[] {
    return this.pages[this.pages.length - 1] as string[];
  }

  newPage(): void {
    if (this.pages.length >= MAX_PAGES) throw new Error("The agreement is too long for a PDF");
    this.pages.push([]);
    this.y = TOP;
  }

  /** Room for `height` more below the cursor, on this page or the next. */
  ensure(height: number): void {
    if (this.y - height < BOTTOM) this.newPage();
  }

  space(height: number): void {
    this.y -= height;
  }

  encode(text: string): number[] {
    const e = encode(text);
    if (e.lossy) this.lossy = true;
    return e.bytes;
  }

  /** Draws one line of segments with its baseline `size` below the cursor. */
  line(segments: readonly Segment[], x: number, size: number, leading: number, grey = false): void {
    this.ensure(leading);
    const baseline = this.y - size;
    const ops: string[] = [];
    if (grey) ops.push("0.35 g");
    ops.push("BT", `${num(x)} ${num(baseline)} Td`);
    for (const s of segments) {
      if (!s.bytes.length) continue;
      ops.push(`/${s.font} ${num(size)} Tf`, `${hex(s.bytes)} Tj`);
    }
    ops.push("ET");
    if (grey) ops.push("0 g");
    this.page.push(ops.join("\n"));
    this.y -= leading;
  }

  /** Wraps pieces to the width from `x` to RIGHT, then draws them. */
  paragraph(
    lines: readonly Piece[][],
    x: number,
    size: number,
    options: { leading?: number; firstPrefix?: Segment; grey?: boolean } = {},
  ): void {
    const leading = options.leading ?? size * 1.4;
    const width = RIGHT - x;
    let first = true;
    for (const pieces of lines) {
      for (const wrapped of this.wrap(pieces, width, size)) {
        const segments = first && options.firstPrefix ? [options.firstPrefix, ...wrapped] : wrapped;
        this.line(
          segments,
          first && options.firstPrefix ? x - this.prefixWidth(options.firstPrefix, size) : x,
          size,
          leading,
          options.grey,
        );
        first = false;
      }
    }
  }

  prefixWidth(prefix: Segment, size: number): number {
    return widthOf(prefix.bytes, prefix.font, size);
  }

  /** Breaks pieces into lines no wider than `width`, at spaces, or inside a word too long. */
  wrap(pieces: readonly Piece[], width: number, size: number): Segment[][] {
    const out: Segment[][] = [];
    let line: Segment[] = [];
    let used = 0;
    let pendingSpace: Segment | null = null;
    const push = (font: Font, bytes: number[]) => {
      const last = line[line.length - 1];
      if (last && last.font === font) last.bytes.push(...bytes);
      else line.push({ font, bytes: [...bytes] });
    };
    const flush = () => {
      out.push(line);
      line = [];
      used = 0;
      pendingSpace = null;
    };
    for (const piece of pieces) {
      const bytes = this.encode(piece.text);
      // Words and the spaces between them.
      let word: number[] = [];
      const words: { bytes: number[]; space: boolean }[] = [];
      for (const b of bytes) {
        if (b === 32) {
          if (word.length) words.push({ bytes: word, space: false });
          word = [];
          words.push({ bytes: [32], space: true });
        } else word.push(b);
      }
      if (word.length) words.push({ bytes: word, space: false });
      for (const w of words) {
        if (w.space) {
          if (used > 0) pendingSpace = { font: piece.font, bytes: [32] };
          continue;
        }
        const spaceWidth = pendingSpace ? widthOf([32], pendingSpace.font, size) : 0;
        let ww = widthOf(w.bytes, piece.font, size);
        if (used > 0 && used + spaceWidth + ww > width) flush();
        else if (pendingSpace) {
          push(pendingSpace.font, pendingSpace.bytes);
          used += spaceWidth;
        }
        pendingSpace = null;
        let rest = w.bytes;
        // A word wider than the line is broken where it must be.
        while (ww > width - used && rest.length > 1) {
          let take = 0;
          let taken = 0;
          while (take < rest.length) {
            const cw = widthOf([rest[take] as number], piece.font, size);
            if (taken + cw > width - used && take > 0) break;
            taken += cw;
            take += 1;
          }
          push(piece.font, rest.slice(0, take));
          flush();
          rest = rest.slice(take);
          ww = widthOf(rest, piece.font, size);
        }
        if (rest.length) {
          push(piece.font, rest);
          used += ww;
        }
      }
    }
    if (line.length || !out.length) out.push(line);
    return out;
  }

  rule(x1: number, x2: number, grey = 0.6): void {
    this.ensure(10);
    const y = this.y - 5;
    this.page.push(`${num(grey)} G 0.5 w ${num(x1)} ${num(y)} m ${num(x2)} ${num(y)} l S 0 G`);
    this.y -= 10;
  }

  /** A box the size of a checkbox at the cursor's line, ticked or empty. */
  box(x: number, baseline: number, ticked: boolean): void {
    const ops = [`0 G 0.8 w ${num(x)} ${num(baseline - 1)} 9 9 re S`];
    if (ticked) {
      ops.push(
        `1.4 w 1 J 1 j ${num(x + 1.8)} ${num(baseline + 3.4)} m ${num(x + 3.8)} ${num(baseline + 1)} l ${num(x + 7.4)} ${num(baseline + 6.8)} l S`,
      );
    }
    this.page.push(ops.join("\n"));
  }
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
  const layout = new Layout();
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

/** A text as a PDF text string in UTF-16BE hex (for the document's title in its properties). */
function utf16Hex(text: string): string {
  let out = "<FEFF";
  for (const char of text.normalize("NFC")) {
    const code = char.codePointAt(0) ?? 0;
    if (dropped(code)) continue;
    const units =
      code > 0xffff
        ? [0xd800 + ((code - 0x10000) >> 10), 0xdc00 + ((code - 0x10000) & 0x3ff)]
        : [code];
    for (const u of units) out += u.toString(16).padStart(4, "0").toUpperCase();
  }
  return `${out}>`;
}

/** The most pages a file may have: a document longer than this is refused when published. */
export const AGREEMENT_PDF_MAX_PAGES = MAX_PAGES;

/** How many pages `doc` takes, or throws when it is longer than the writer draws. */
export function agreementPdfPages(doc: AgreementPdf): number {
  return layoutPages(doc).length;
}

/** The PDF file of `doc`. The same `doc` always gives the same bytes. */
export function agreementPdf(doc: AgreementPdf): Uint8Array<ArrayBuffer> {
  const streams = layoutPages(doc);
  const fontNames = Object.keys(FONTS) as Font[];
  // 1 catalog, 2 pages, fonts, the info dictionary, then each page and its content.
  const firstFont = 3;
  const info = firstFont + fontNames.length;
  const firstPage = info + 1;
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Count ${streams.length} /Kids [${streams
    .map((_, i) => `${firstPage + i * 2} 0 R`)
    .join(" ")}] >>`;
  fontNames.forEach((name, i) => {
    objects[firstFont + i] =
      `<< /Type /Font /Subtype /Type1 /BaseFont /${FONTS[name]} /Encoding /WinAnsiEncoding >>`;
  });
  objects[info] =
    `<< /Title ${utf16Hex(`${doc.title}, version ${doc.versionNumber}`)} /Producer (Composable OS agreements) >>`;
  const fontRefs = fontNames.map((name, i) => `/${name} ${firstFont + i} 0 R`).join(" ");
  streams.forEach((stream, i) => {
    const page = firstPage + i * 2;
    objects[page] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(PAGE_WIDTH)} ${num(PAGE_HEIGHT)}] ` +
      `/Resources << /Font << ${fontRefs} >> >> /Contents ${page + 1} 0 R >>`;
    objects[page + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}endstream`;
  });
  // Every character of the file is one byte: the header's marker bytes, and ASCII after them.
  let file = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = file.length;
    file += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = file.length;
  file += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++) {
    file += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  }
  file += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(file.length);
  for (let i = 0; i < file.length; i++) bytes[i] = file.charCodeAt(i);
  return bytes;
}
