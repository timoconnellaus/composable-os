// A cheap upper bound on how many pages the signed PDF of a document takes (stage 44 step 4, ADR
// 0645, after the second review of PR #283). The host's core asks it when a document is published,
// so a body the PDF writer would refuse (over its page limit) is refused there, without carrying
// the writer itself. It never says fewer pages than the writer draws (test/estimate.test.ts); it
// may say more.
//
// How it bounds:
// - every character is as wide as the widest the standard fonts draw (1.015 em);
// - a greedy line break wastes less than one word per line, so any two consecutive lines hold
//   more than a line's width less two characters: a run of text of width W on lines of width w
//   takes at most 2 * ceil(W / (w - 2c)) + 2 lines;
// - every line is as narrow as the deepest indent leaves it;
// - a page holds its height less the tallest block the writer keeps together (a signature box).
//
// Imports only types: nothing of the writer comes with it.
import type { AgreementPdf, PdfBlock, PdfInline, PdfList } from "./writer.ts";

// The writer's page, as laid out in writer.ts.
const PAGE_HEIGHT = 841.89;
const TOP = PAGE_HEIGHT - 60;
const BOTTOM = 76;
const TEXT_WIDTH = 595.28 - 2 * 56;
/** The deepest indent (a nested list's) and its marker. */
const NARROWEST = TEXT_WIDTH - 6 * 14 - 20;
/** The most the writer keeps together, so the most a page can leave unused at its foot. */
const KEPT_TOGETHER = 120;
const BODY = 10.5;
/** The widest character of the standard fonts, in em (Helvetica's `@`). */
const WIDEST = 1.015;

/** The writer's page limit: a document over it is refused. */
export const AGREEMENT_PDF_PAGE_LIMIT = 400;

/** Lines a run of `chars` characters at `size` can take, at most. */
function lines(chars: number, size: number): number {
  const c = WIDEST * size;
  const width = chars * c;
  return 2 * Math.ceil(width / (NARROWEST - 2 * c)) + 2;
}

const textLength = (s: string | undefined) => (s ? [...s].length : 0);

/** Height of runs at `size` with `leading`: each line they hold (a break starts one) at most. */
function runsHeight(
  content: readonly PdfInline[] | undefined,
  size: number,
  leading: number,
  extra = 0,
): number {
  let total = 0;
  let chars = extra;
  const flush = () => {
    total += lines(chars, size) * leading;
    chars = 0;
  };
  for (const run of content ?? []) {
    if (run.type === "break") {
      flush();
      continue;
    }
    const shown = textLength(run.text) + (run.href ? textLength(run.href) + 3 : 0);
    // A newline inside a run starts a line too.
    const newlines = (run.text.match(/\r\n|\r|\n/g) ?? []).length;
    chars += shown;
    for (let i = 0; i < newlines; i++) flush();
  }
  flush();
  return total;
}

function listHeight(list: PdfList): number {
  let total = 0;
  for (const item of list.items ?? []) {
    total += runsHeight(item.content, BODY, BODY * 1.4, 6);
    if (item.list) total += listHeight(item.list);
  }
  return total;
}

function blockHeight(block: PdfBlock): number {
  const gap = 5;
  switch (block.type) {
    case "heading":
      return 4 + runsHeight(block.content, 15, 15 * 1.3) + gap;
    case "paragraph":
      return runsHeight(block.content, BODY, BODY * 1.4) + gap;
    case "list":
      return listHeight(block) + gap;
    case "quote":
      return (
        runsHeight(block.content, BODY, BODY * 1.4) +
        (block.attribution ? lines(textLength(block.attribution) + 2, 9.5) * 9.5 * 1.4 : 0) +
        gap
      );
    case "callout":
      return runsHeight(block.content, BODY, BODY * 1.4, 13) + gap;
    case "divider":
      return 10 + gap;
    case "image":
      return lines(textLength(block.alt) + 40, BODY) * BODY * 1.4 + gap;
    default:
      return lines(40, BODY) * BODY * 1.4 + gap;
  }
}

const textHeight = (text: string, size: number, leading: number, extra = 0) =>
  lines(textLength(text) + extra, size) * leading;

/** At most how many pages the signed PDF of `doc` takes. */
export function estimateAgreementPdfPages(doc: AgreementPdf): number {
  let total = 0;
  // The header: the business, the title, the version line, a rule.
  total += textHeight(doc.business, 10, 14) + 4;
  total += textHeight(doc.title, 18, 23);
  total += textHeight("Version 1000000: a form to sign on paper", 10, 14);
  total += 10 + 4;
  for (const block of doc.body?.blocks ?? []) total += blockHeight(block);
  total += 4 + 10 + 4;
  // The tick and its label.
  total += 20 + textHeight(doc.tickLabel, BODY, BODY * 1.4);
  // A health form's questions, and their answers or boxes.
  const questions = doc.questions ?? [];
  if (questions.length) {
    total += 8 + 40 + 17 + 2;
    const answers = Array.isArray(doc.answers) ? new Map(doc.answers.map((a) => [a.key, a])) : null;
    for (const q of questions) {
      total += textHeight(q.text, BODY, BODY * 1.4, 4);
      if (doc.blank)
        total +=
          18 +
          2 *
            textHeight("If yes: ______________________________________________", BODY, BODY * 1.4);
      else if (answers) {
        total += textHeight("Answer: Not answered", BODY, BODY * 1.4);
        const note = answers.get(q.key)?.note;
        if (note) total += textHeight(note, BODY, BODY * 1.4);
      }
      total += 3;
    }
    total += textHeight(
      "The answers are shown only to staff who may read health forms.",
      BODY,
      BODY * 1.4,
    );
  }
  // The record, or the lines to fill in on paper.
  total += 8 + 40 + 17 + 2;
  if (doc.blank) {
    total +=
      4 *
      (14 +
        textHeight(
          "For a child: who signs, and how they are related: ______________________________________________",
          BODY,
          BODY * 1.4,
        ));
  } else {
    for (const entry of doc.record ?? []) {
      total += textHeight(`${entry.label}: ${entry.value}`, BODY, BODY * 1.4);
    }
    if (doc.signature) total += 4 + textHeight("Signature drawn:", BODY, BODY * 1.4) + 96 + 10;
  }
  // The note about characters the fonts cannot draw.
  total +=
    8 +
    textHeight(
      "Some characters could not be drawn in this file and are shown as ?. The record holds them exactly.",
      9,
      9 * 1.4,
    );
  return Math.floor(total / (TOP - BOTTOM - KEPT_TOGETHER)) + 1;
}

/** Whether the signed PDF of `doc` surely fits the writer's page limit. */
export function fitsAgreementPdf(doc: AgreementPdf): boolean {
  return estimateAgreementPdfPages(doc) <= AGREEMENT_PDF_PAGE_LIMIT;
}
