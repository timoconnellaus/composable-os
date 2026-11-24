// Documents to draw in the PDF tests: seeded random agreements of every block, mark, width and
// nesting (the page estimate's test and the agreements golden test share them). Fixture text only.
import type { AgreementPdf, PdfBlock, PdfInline, PdfList } from "../src/agreement.ts";

/** Mulberry32: the same documents every run. */
export function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ["W", "@", "i", "m", " ", " ", " ", "—", "é", "名", "\n", "a", "e", "M", "%"];

function text(r: () => number, max: number): string {
  const n = 1 + Math.floor(r() ** 3 * max);
  let out = "";
  // Words of any length, a few very long.
  while (out.length < n) {
    const word = Math.floor(r() ** 4 * 300) + 1;
    const ch = ALPHABET[Math.floor(r() * ALPHABET.length)] as string;
    out +=
      r() < 0.5
        ? ch.repeat(word)
        : Array.from({ length: word }, () => ALPHABET[Math.floor(r() * ALPHABET.length)]).join("");
    out += " ";
  }
  return out.slice(0, n) || "x";
}

function runs(r: () => number): PdfInline[] {
  return Array.from({ length: 1 + Math.floor(r() * 6) }, () =>
    r() < 0.15
      ? { type: "break" as const }
      : {
          type: "text" as const,
          text: text(r, 900),
          ...(r() < 0.3 ? { bold: true } : {}),
          ...(r() < 0.2 ? { italic: true } : {}),
          ...(r() < 0.1 ? { code: true } : {}),
          ...(r() < 0.1
            ? { href: `https://example.test/${"p".repeat(Math.floor(r() * 80))}` }
            : {}),
        },
  );
}

function list(r: () => number, depth: number): PdfList {
  return {
    style: r() < 0.5 ? "bullet" : "ordered",
    items: Array.from({ length: 1 + Math.floor(r() * 4) }, () => ({
      content: runs(r),
      ...(depth < 9 && r() < 0.4 ? { list: list(r, depth + 1) } : {}),
    })),
  };
}

function block(r: () => number): PdfBlock {
  const k = r();
  if (k < 0.15) return { type: "heading", level: 1 + Math.floor(r() * 6), content: runs(r) };
  if (k < 0.3) return { type: "list", ...list(r, 0) };
  if (k < 0.4)
    return { type: "quote", content: runs(r), ...(r() < 0.5 ? { attribution: text(r, 200) } : {}) };
  if (k < 0.5) return { type: "callout", tone: "warning", content: runs(r) };
  if (k < 0.55) return { type: "divider" };
  if (k < 0.58) return { type: "image", alt: text(r, 300) };
  return { type: "paragraph", content: runs(r) };
}

export function randomAgreement(r: () => number, blocks: number): AgreementPdf {
  const questions =
    r() < 0.4
      ? Array.from({ length: 1 + Math.floor(r() * 40) }, (_, i) => ({
          key: `q${i}`,
          text: text(r, 500),
        }))
      : undefined;
  const blank = r() < 0.2;
  return {
    business: text(r, 200),
    title: text(r, 200),
    versionNumber: 1 + Math.floor(r() * 1000),
    versionHash: "a".repeat(64),
    body: { blocks: Array.from({ length: blocks }, () => block(r)) },
    tickLabel: text(r, 1000),
    ...(questions ? { questions } : {}),
    ...(questions && !blank
      ? {
          answers: questions.map((q) => ({
            key: q.key,
            yes: r() < 0.5,
            ...(r() < 0.5 ? { note: text(r, 1000) } : {}),
          })),
        }
      : {}),
    ...(blank
      ? { blank: true }
      : {
          record: Array.from({ length: Math.floor(r() * 12) }, (_, i) => ({
            label: `Line ${i}`,
            value: text(r, 300),
          })),
          ...(r() < 0.5
            ? {
                signature: {
                  width: 1000,
                  height: 400,
                  strokes: [
                    [
                      [0, 0],
                      [1000, 400],
                    ],
                  ],
                },
              }
            : {}),
          acceptanceId: "aga_x",
        }),
  };
}
