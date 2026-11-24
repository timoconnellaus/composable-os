// The agreements PDF's bytes are unchanged by the writer's generalisation (stage 35 step 1,
// criterion 14; ADR 0737). `golden/agreement.json` holds the SHA-256 of each fixture's file as the
// writer drew it before it was split (`packages/agreement-pdf` at stage 44). A change that moves a
// single byte of any agreement fails here. Fixture text only.
//
// To see a deliberate change (there should be none: a signed copy is evidence and its bytes are
// what a download and the emailed copy share), print `hashes()` and replace the file in the same
// PR, saying why in an ADR.
import { describe, expect, it } from "vitest";
import { type AgreementPdf, agreementPdf } from "../src/agreement.ts";
import { randomAgreement, rng } from "./fixtures.ts";
import golden from "./golden/agreement.json";

const HASH = "3f".repeat(32);

const SIGNATURE = {
  width: 1000,
  height: 400,
  strokes: [
    [
      [100, 300],
      [200, 100],
      [300, 300],
      [400, 100],
    ],
    [[620, 210]],
  ],
};

const signed: AgreementPdf = {
  business: "Fixture Studio",
  title: "Fixture waiver",
  versionNumber: 2,
  versionHash: HASH,
  body: {
    blocks: [
      { type: "heading", level: 1, content: [{ type: "text", text: "Fixture heading" }] },
      { type: "heading", level: 2, content: [{ type: "text", text: "Second heading" }] },
      { type: "heading", level: 3, content: [{ type: "text", text: "Third heading" }] },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Fixture text, " },
          { type: "text", text: "bold", bold: true },
          { type: "text", text: ", italic", italic: true },
          { type: "text", text: ", both", bold: true, italic: true },
          { type: "text", text: " and code", code: true },
          { type: "break" },
          { type: "text", text: "a link", href: "https://example.test/terms" },
          { type: "text", text: " and https://example.test", href: "https://example.test" },
        ],
      },
      {
        type: "list",
        style: "bullet",
        items: [
          {
            content: [{ type: "text", text: "Fixture point" }],
            list: {
              style: "ordered",
              items: [
                { content: [{ type: "text", text: "Nested one" }] },
                { content: [{ type: "text", text: "Nested two" }] },
              ],
            },
          },
          { content: [{ type: "text", text: "Another point" }] },
        ],
      },
      {
        type: "quote",
        content: [{ type: "text", text: "A quoted line" }],
        attribution: "Fixture",
      },
      { type: "callout", tone: "warning", content: [{ type: "text", text: "Take care." }] },
      { type: "callout", tone: "info", content: [{ type: "text", text: "For information." }] },
      { type: "divider" },
      { type: "image", alt: "A fixture picture" },
      { type: "image" },
    ],
  },
  tickLabel: "I have read this fixture",
  record: [
    { label: "For", value: "Fixture Person" },
    { label: "Name typed", value: "Fixture Name" },
    { label: "Agreed", value: "2026-11-23 09:00 UTC" },
  ],
  signature: SIGNATURE,
  acceptanceId: "aga_fixture1",
};

const questions = [
  { key: "heart", text: "Fixture question one?" },
  { key: "back", text: "Fixture question two, a longer one that wraps ".repeat(4) },
];

const hostile = [
  ") Tj ET BT /F1 99 Tf (owned) Tj ET (",
  "\\) Tj\nendstream\nendobj\n9 0 obj << /Type /Action /S /JavaScript /JS (app.alert(1)) >>",
  "<< /OpenAction << /S /URI /URI (https://evil.test) >> >>",
  "%%EOF\nxref\ntrailer << /Root 9 0 R >>",
  "‮gnp.exe‬ and ​​",
];

const FIXTURES: Record<string, AgreementPdf> = {
  signed,
  typed: { ...signed, signature: undefined },
  answered: {
    ...signed,
    questions,
    answers: [
      { key: "heart", yes: true, note: "A fixture note" },
      { key: "back", yes: false },
    ],
  },
  "not answered": { ...signed, questions, answers: [{ key: "heart", yes: false }] },
  "in app": { ...signed, questions, answers: "in-app" },
  withheld: { ...signed, questions, answers: "withheld" },
  blank: {
    ...signed,
    record: undefined,
    signature: undefined,
    acceptanceId: undefined,
    blank: true,
    questions,
  },
  lossy: { ...signed, record: [{ label: "Name typed", value: "名前 Zoë — “quoted” €5 …" }] },
  hostile: {
    ...signed,
    title: hostile[0] as string,
    tickLabel: hostile[1] as string,
    body: {
      blocks: hostile.map((text) => ({
        type: "paragraph" as const,
        content: [{ type: "text" as const, text, href: "https://evil.test/x" }],
      })),
    },
    record: hostile.map((value, i) => ({ label: `Line ${i}`, value })),
  },
  "long title": { ...signed, title: "A very long fixture title that will not fit ".repeat(6) },
  "many pages": {
    ...signed,
    body: {
      blocks: Array.from({ length: 120 }, (_, i) => ({
        type: "paragraph" as const,
        content: [{ type: "text" as const, text: `Fixture paragraph ${i} `.repeat(8) }],
      })),
    },
  },
  "long word": {
    ...signed,
    body: { blocks: [{ type: "paragraph", content: [{ type: "text", text: "W".repeat(400) }] }] },
  },
  "odd strokes": {
    ...signed,
    signature: { width: 0, height: 0, strokes: [[], [[Number.NaN, 5]], [[1, 2], [3]]] },
  },
};

const r = rng(35_2026_11_24);
for (let i = 0; i < 60; i++) FIXTURES[`random ${i}`] = randomAgreement(r, Math.floor(r() * 30));

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Each fixture's file hash, as `golden/agreement.json` holds them. */
async function hashes(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, doc] of Object.entries(FIXTURES)) out[name] = await sha256(agreementPdf(doc));
  return out;
}

describe("the agreements PDF after the writer's generalisation", () => {
  it("draws every fixture to the same bytes as before", async () => {
    expect(await hashes()).toEqual(golden);
  });
});
