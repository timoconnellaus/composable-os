// A table on the shared core (stage 35 step 1, ADR 0737): columns of a fixed width or the width
// left, each aligned left or right, a header row drawn again at the top of every page the table
// runs onto, and cells that wrap inside their column. A row is kept on one page when it fits on
// one; a row taller than a page is broken between its lines. Every cell is text, so it is written
// as the core writes all text: a hex string of WinAnsi bytes.
import {
  BOTTOM,
  type Font,
  hex,
  type Layout,
  LEFT,
  num,
  RIGHT,
  type Segment,
  TOP,
  widthOf,
} from "./core.ts";

/** One line of a cell: its text (a newline starts another), bold or grey when asked. */
export interface PdfCellLine {
  text: string;
  bold?: boolean;
  grey?: boolean;
}

/** A cell: text, or lines of their own weight. */
export type PdfCell = string | readonly PdfCellLine[];

export interface PdfColumn {
  header: string;
  /** Points, or `fill` for the width the other columns leave (one column at most). */
  width: number | "fill";
  align: "left" | "right";
}

export interface PdfTable {
  columns: readonly PdfColumn[];
  rows: readonly (readonly PdfCell[])[];
  /** Draw the header row (default true). */
  header?: boolean;
  /** A light rule between rows (default true). */
  rules?: boolean;
  /** The text size (default 9.5). */
  size?: number;
  /** Where the table starts and ends across the page (default the margins). */
  left?: number;
  right?: number;
}

/** Space between a cell's text and its column's edge. */
const PAD = 4;

interface Drawn {
  segments: Segment[];
  grey: boolean;
}

/** The columns' left edges and widths, the `fill` column taking what the others leave. */
function edges(columns: readonly PdfColumn[], left: number, right: number): [number, number][] {
  const fixed = columns.reduce(
    (sum, c) => sum + (c.width === "fill" ? 0 : Math.max(0, c.width)),
    0,
  );
  const fills = columns.filter((c) => c.width === "fill").length;
  if (fills > 1) throw new Error("A table has one fill column at most");
  const rest = Math.max(0, right - left - fixed);
  let x = left;
  return columns.map((c) => {
    const w = c.width === "fill" ? rest : Math.max(0, c.width);
    const edge: [number, number] = [x, w];
    x += w;
    return edge;
  });
}

/** A cell's lines, wrapped to its column. */
function wrapCell(
  layout: Layout,
  cell: PdfCell | undefined,
  width: number,
  size: number,
  base: Font,
): Drawn[] {
  const lines: readonly PdfCellLine[] = typeof cell === "string" ? [{ text: cell }] : (cell ?? []);
  const out: Drawn[] = [];
  for (const line of lines) {
    const font: Font = line.bold || base === "F2" ? "F2" : "F1";
    for (const part of line.text.split(/\r\n|\r|\n/)) {
      for (const segments of layout.wrap(
        [{ font, text: part }],
        Math.max(1, width - 2 * PAD),
        size,
      )) {
        out.push({ segments, grey: line.grey ?? false });
      }
    }
  }
  return out;
}

/** Draws one line of text with its baseline at `baseline`, without moving the cursor. */
function drawAt(layout: Layout, line: Drawn, x: number, baseline: number, size: number): void {
  const ops: string[] = [];
  if (line.grey) ops.push("0.35 g");
  ops.push("BT", `${num(x)} ${num(baseline)} Td`);
  for (const s of line.segments) {
    if (!s.bytes.length) continue;
    ops.push(`/${s.font} ${num(size)} Tf`, `${hex(s.bytes)} Tj`);
  }
  ops.push("ET");
  if (line.grey) ops.push("0 g");
  layout.page.push(ops.join("\n"));
}

const lineWidth = (line: Drawn, size: number) =>
  line.segments.reduce((sum, s) => sum + widthOf(s.bytes, s.font, size), 0);

/** Draws `table` from the cursor down, onto as many pages as it needs. */
export function drawTable(layout: Layout, table: PdfTable): void {
  const size = table.size ?? 9.5;
  const leading = size * 1.35;
  const left = table.left ?? LEFT;
  const right = table.right ?? RIGHT;
  const columns = edges(table.columns, left, right);
  const rules = table.rules ?? true;
  const showHeader = table.header ?? true;

  const drawRow = (cells: readonly (PdfCell | undefined)[], base: Font, onNewPage: () => void) => {
    const wrapped = table.columns.map((_, i) =>
      wrapCell(layout, cells[i], (columns[i] as [number, number])[1], size, base),
    );
    const count = Math.max(1, ...wrapped.map((w) => w.length));
    const height = count * leading + 3;
    // Kept on one page when it fits on one.
    if (layout.y - height < BOTTOM && height <= TOP - BOTTOM - 3 * leading) {
      layout.newPage();
      onNewPage();
    }
    layout.space(1.5);
    for (let n = 0; n < count; n++) {
      if (layout.y - leading < BOTTOM) {
        layout.newPage();
        onNewPage();
      }
      const baseline = layout.y - size;
      table.columns.forEach((column, i) => {
        const line = wrapped[i]?.[n];
        if (!line) return;
        const [x, w] = columns[i] as [number, number];
        const at = column.align === "right" ? x + w - PAD - lineWidth(line, size) : x + PAD;
        drawAt(layout, line, at, baseline, size);
      });
      layout.y -= leading;
    }
    layout.space(1.5);
  };

  const header = () => {
    if (!showHeader) return;
    drawRow(
      table.columns.map((c) => c.header),
      "F2",
      () => {},
    );
    layout.rule(left, right, 0.35);
  };

  // A header is never left alone at the foot of a page.
  layout.ensure(leading * 3 + 13);
  header();
  table.rows.forEach((row, i) => {
    if (i > 0 && rules)
      layout.page.push(
        `0.85 G 0.5 w ${num(left)} ${num(layout.y)} m ${num(right)} ${num(layout.y)} l S 0 G`,
      );
    drawRow(row, "F1", header);
  });
}
