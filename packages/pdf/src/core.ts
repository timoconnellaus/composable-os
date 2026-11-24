// The safe core of the platform's PDF writer (ADR 0645, generalised by stage 35 step 1, ADR
// 0737): fonts, text encoding, the page and its cursor, and the file. The renderers (an
// agreement, an invoice, a quote, a credit note, a receipt) lay their documents out with it, so
// every one of them keeps the same rules:
//
// - Plain PDF 1.4: the standard Helvetica and Courier fonts (no font is embedded, no file or
//   network is read), WinAnsi text, no compression, no dates, no ids: the same values always make
//   the same bytes. It runs anywhere JavaScript runs (no Node API).
// - Nothing given can become PDF structure. Every piece of text is written as a hex string of
//   WinAnsi bytes, `<48656C6C6F>`, so no parenthesis, backslash, newline or `endstream` in it can
//   close a string, start an operator or end a stream. Control, bidirectional and zero-width
//   characters are dropped; a character the standard fonts cannot draw is written as `?`, and the
//   layout remembers it (`lossy`) so the renderer can say so. No action, annotation, script or
//   form field is ever written.
// - Numbers (positions, strokes) are written at fixed precision; anything not finite is 0.
//
// No imports.

// --- Fonts and text ----------------------------------------------------------------------------

export type Font = "F1" | "F2" | "F3" | "F4" | "F5";
export const FONTS: Record<Font, string> = {
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
export function dropped(code: number): boolean {
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

export function encode(text: string): Encoded {
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

export function widthOf(bytes: readonly number[], font: Font, size: number): number {
  let total = 0;
  for (const b of bytes) total += byteWidth(b, font);
  return (total * size) / 1000;
}

export function hex(bytes: readonly number[]): string {
  let out = "<";
  for (const b of bytes) out += b.toString(16).padStart(2, "0").toUpperCase();
  return `${out}>`;
}

/** A number as PDF writes it: fixed precision, so the same input gives the same bytes. */
export function num(n: number): string {
  // Values are checked by their callers; anything not a finite number is drawn at 0, never as
  // `NaN` or `Infinity` in the file.
  if (!Number.isFinite(n)) return "0";
  const fixed = (Math.round(n * 100) / 100).toFixed(2);
  return fixed.replace(/\.?0+$/, "") || "0";
}

// --- Layout ------------------------------------------------------------------------------------

export const PAGE_WIDTH = 595.28;
export const PAGE_HEIGHT = 841.89;
export const LEFT = 56;
export const RIGHT = PAGE_WIDTH - 56;
export const TOP = PAGE_HEIGHT - 60;
export const BOTTOM = 76;
export const MAX_PAGES = 400;

export const BODY_SIZE = 10.5;

export interface Segment {
  font: Font;
  bytes: number[];
}

export interface Piece {
  font: Font;
  text: string;
}

export class Layout {
  readonly pages: string[][] = [];
  y = TOP;
  lossy = false;

  /** `tooLong` is the error a document past the page limit throws. */
  constructor(private readonly tooLong = "The document is too long for a PDF") {
    this.newPage();
  }

  get page(): string[] {
    return this.pages[this.pages.length - 1] as string[];
  }

  newPage(): void {
    if (this.pages.length >= MAX_PAGES) throw new Error(this.tooLong);
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

/** A text as a PDF text string in UTF-16BE hex (for the document's title in its properties). */
export function utf16Hex(text: string): string {
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

/** What a file says about itself: its title (any text) and the renderer that made it (ASCII). */
export interface PdfProperties {
  title: string;
  /** Written as a literal string: a constant of the renderer's, never a value given to it. */
  producer: string;
}

/** The PDF file of pages laid out as content streams. The same streams give the same bytes. */
export function pdfFile(
  streams: readonly string[],
  properties: PdfProperties,
): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9 .,-]*$/.test(properties.producer)) throw new Error("A producer is plain words");
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
  objects[info] = `<< /Title ${utf16Hex(properties.title)} /Producer (${properties.producer}) >>`;
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
