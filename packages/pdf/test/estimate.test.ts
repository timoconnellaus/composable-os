// The page estimate the host's core asks at publish (ADR 0645, after the second review of PR #283)
// never says fewer pages than the writer draws, so it never passes a document the writer refuses.
// Checked against the writer itself, over seeded random documents of every block, mark, width and
// nesting, and over documents built to sit just past the page limit.
import { describe, expect, it } from "vitest";
import {
  AGREEMENT_PDF_PAGE_LIMIT,
  estimateAgreementPdfPages,
  fitsAgreementPdf,
} from "../src/estimate.ts";
import { AGREEMENT_PDF_MAX_PAGES, type AgreementPdf, agreementPdfPages } from "../src/writer.ts";
import { randomAgreement as doc, rng } from "./fixtures.ts";

/** The writer's page count, or null when it refuses the document. */
function drawn(d: AgreementPdf): number | null {
  try {
    return agreementPdfPages(d);
  } catch {
    return null;
  }
}

describe("the page estimate", () => {
  it("names the writer's own limit", () => {
    expect(AGREEMENT_PDF_PAGE_LIMIT).toBe(AGREEMENT_PDF_MAX_PAGES);
  });

  it("is never below the pages the writer draws, over seeded random documents", () => {
    const r = rng(20261123);
    for (let i = 0; i < 150; i++) {
      const d = doc(r, Math.floor(r() ** 2 * 120));
      const pages = drawn(d);
      const estimate = estimateAgreementPdfPages(d);
      if (pages === null)
        expect(estimate, `document ${i}`).toBeGreaterThan(AGREEMENT_PDF_PAGE_LIMIT);
      else expect(estimate, `document ${i}`).toBeGreaterThanOrEqual(pages);
    }
  });

  it("never passes a document the writer refuses, at and past the limit", () => {
    const r = rng(7);
    let refused = 0;
    for (let n = 6_000; n <= 14_000; n += 1_000) {
      // Many short lines: the shape that fills pages fastest.
      const d: AgreementPdf = {
        ...doc(r, 0),
        body: {
          blocks: Array.from({ length: n }, () => ({
            type: "paragraph" as const,
            content: [
              { type: "text" as const, text: "W" },
              { type: "break" as const },
              { type: "text" as const, text: "W" },
            ],
          })),
        },
      };
      if (drawn(d) === null) {
        refused += 1;
        expect(fitsAgreementPdf(d), `${n} blocks`).toBe(false);
      }
    }
    expect(refused).toBeGreaterThan(0);
  });

  it("passes an ordinary document", () => {
    const d: AgreementPdf = {
      business: "Fixture Studio",
      title: "Fixture waiver",
      versionNumber: 1,
      versionHash: "a".repeat(64),
      body: { blocks: [{ type: "paragraph", content: [{ type: "text", text: "Fixture text." }] }] },
      tickLabel: "I agree",
    };
    expect(fitsAgreementPdf(d)).toBe(true);
    expect(estimateAgreementPdfPages(d)).toBeLessThan(5);
  });
});
