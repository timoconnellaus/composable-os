// The copy of a signed agreement (stage 44 step 4, ADR 0645): only the host's agreements queue
// may attach one, in the copy's shape; the gatekeeper makes the PDF from checked values when the
// send is applied (no answers ever, decision 21); the approval card names no name; and the PDF
// writer is deterministic and turns nothing it is given into PDF structure. All text here is
// fixture text, not wording anyone should use.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { type AgreementPdf, agreementPdf } from "../src/agreement-pdf";
import type { EmailSendReceipt } from "../src/types";
import { resetFakes, sentEmails, submissions } from "./fakes";

const SENDER_URL = "email-send://sender/crm%40example.com";
const HASH = "a".repeat(64);
const SIGNATURE = {
  width: 1000,
  height: 400,
  strokes: [
    [
      [100, 200],
      [200, 100],
      [300, 300],
      [400, 100],
    ],
  ],
};

let seq = 0;
async function host(
  options: {
    hostAgreement?: boolean;
    hostSignIn?: boolean;
    hostRoutine?: { siteOrigin: string | null };
  } = {},
) {
  seq += 1;
  const stub = env.TEST_HOST.getByName(`agreement-${seq}-${crypto.randomUUID()}`);
  await stub.open(SENDER_URL, options);
  return stub;
}
type Host = Awaited<ReturnType<typeof host>>;
const send = async (h: Host, message: unknown) =>
  (await h.call("send", [message])) as EmailSendReceipt;

const agreement = {
  business: "Fixture Studio",
  title: "Fixture waiver",
  versionNumber: 2,
  versionHash: HASH,
  body: {
    blocks: [
      { type: "heading", level: 1, content: [{ type: "text", text: "Fixture heading" }] },
      {
        type: "paragraph",
        content: [{ type: "text", text: "Fixture text, not a real document." }],
      },
      {
        type: "list",
        style: "bullet",
        items: [{ content: [{ type: "text", text: "Fixture point" }] }],
      },
    ],
  },
  tickLabel: "I have read this fixture",
  record: [
    { label: "For", value: "Fixture Person" },
    { label: "Name typed", value: "Fixture Name" },
  ],
  signature: SIGNATURE,
  acceptanceId: "aga_fixture1",
  summary: "agreed by the person, 2026-11-23 09:00 UTC",
};

const message = {
  to: ["member@members.test"],
  subject: "Fixture Studio: your copy of Fixture waiver",
  text: "This is your copy.",
  agreement,
  idempotencyKey: "agreement-copy:aga_fixture1",
};

/** Every string a content stream draws, decoded from its hex (WinAnsi, read as Latin-1). */
function drawnText(bytes: Uint8Array): string {
  const file = new TextDecoder("latin1").decode(bytes);
  const out: string[] = [];
  for (const match of file.matchAll(/<([0-9A-F]*)> Tj/g)) {
    const hex = match[1] ?? "";
    let text = "";
    for (let i = 0; i < hex.length; i += 2) {
      text += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
    }
    out.push(text);
  }
  return out.join(" ");
}

/** The file outside its hex strings: what a PDF reader parses as structure. */
function structure(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes).replace(/<[0-9A-F]*>/g, "<>");
}

beforeEach(resetFakes);

describe("the agreement part", () => {
  it("from the host's agreements queue: its own kind, a one-line card, and the PDF once applied", async () => {
    const h = await host({ hostAgreement: true });
    const receipt = await send(h, message);
    expect(receipt.status).toBe("pending");
    const [id, description] = submissions[0] ?? [];
    expect(description?.actionKind?.tag).toBe("email.agreement");
    // Applied by the host's decision (its callAsHost), never by an admin's switch.
    expect(description?.autoApprovable).toBe(false);
    const card = JSON.stringify(description);
    expect(card).toContain("Signed agreement: Fixture waiver, version 2");
    // No name typed, no strokes, nothing of the record reaches the card.
    expect(card).not.toContain("Fixture Name");
    expect(card).not.toContain("Fixture Person");
    expect(card).not.toContain("strokes");
    expect(sentEmails).toEqual([]);
    await h.apply(id as number);
    expect(sentEmails).toHaveLength(1);
    const [attachment, ...others] = sentEmails[0]?.attachments ?? [];
    expect(others).toEqual([]);
    expect(attachment).toMatchObject({
      disposition: "attachment",
      filename: "agreement.pdf",
      type: "application/pdf",
    });
    const bytes = attachment?.content as Uint8Array;
    // The same values make the same bytes: the host's download draws exactly this file.
    const { summary: _summary, ...values } = agreement;
    expect([...bytes]).toEqual([...agreementPdf(values as AgreementPdf)]);
    expect(drawnText(bytes)).toContain("Fixture Name");
  });

  it("is refused from every other queue: an extension's, sign-in mail's, routine mail's", async () => {
    for (const options of [
      {},
      { hostSignIn: true },
      { hostRoutine: { siteOrigin: "https://gym.example" } },
    ]) {
      resetFakes();
      const h = await host(options);
      // With the copy's key, refused for the key; without one, for the attachment.
      await expect(send(h, message)).rejects.toThrow(/is the host's own agreements mail's/);
      const { idempotencyKey: _key, ...keyless } = message;
      await expect(send(h, keyless)).rejects.toThrow(/agreement is attached only by the host/);
      expect(submissions).toEqual([]);
    }
  });

  it("is refused in any shape but the copy's, even from the host's queue", async () => {
    const variants = [
      { ...message, to: ["a@members.test", "b@members.test"] },
      { ...message, cc: ["c@members.test"] },
      { ...message, bcc: ["c@members.test"] },
      { ...message, replyTo: "other@members.test" },
      { ...message, html: "<p>Copy</p>", text: undefined },
      {
        ...message,
        calendar: {
          uid: "rec_1",
          start: "2026-12-07T06:00:00.000Z",
          end: "2026-12-07T07:00:00.000Z",
          title: "Strength",
        },
      },
    ];
    for (const variant of variants) {
      resetFakes();
      const h = await host({ hostAgreement: true });
      await expect(send(h, variant), JSON.stringify(Object.keys(variant))).rejects.toThrow(
        /Invalid email/,
      );
      expect(submissions).toEqual([]);
    }
  });

  it("carries no health answers, whatever is passed, and checks every value", async () => {
    const bad: [string, Record<string, unknown>][] = [
      ["answers", { answers: [{ key: "heart", yes: true, note: "Fixture note" }] }],
      ["withheld", { answers: "withheld" }],
      ["a blank", { blank: true }],
      ["an unknown key", { attachment: "data:application/pdf;base64,AAAA" }],
      ["a picture", { body: { blocks: [{ type: "image", media: "med_1", alt: "x" }] } }],
      ["a button", { body: { blocks: [{ type: "button", label: "Go", href: "https://x.test" }] } }],
      ["an unknown block", { body: { blocks: [{ type: "script", content: "x" }] } }],
      ["a bad hash", { versionHash: "nothash" }],
      ["a title over lines", { title: "Fixture\nwaiver" }],
      ["a control character", { tickLabel: "I agree\u0000" }],
      ["a signature outside its box", { signature: { ...SIGNATURE, strokes: [[[1001, 5]]] } }],
      ["a signature of another size", { signature: { ...SIGNATURE, width: 2000 } }],
      ["no acceptance", { acceptanceId: undefined }],
      ["a question with a strange key", { questions: [{ key: "Heart!", text: "Fixture?" }] }],
    ];
    for (const [what, change] of bad) {
      resetFakes();
      const h = await host({ hostAgreement: true });
      await expect(
        send(h, { ...message, agreement: { ...agreement, ...change } }),
        what,
      ).rejects.toThrow(/Invalid email: agreement/);
      expect(submissions).toEqual([]);
    }
    // A health form's copy says where the answers are, and only that.
    resetFakes();
    const h = await host({ hostAgreement: true });
    await send(h, {
      ...message,
      agreement: {
        ...agreement,
        questions: [{ key: "heart", text: "Fixture question one?" }],
        answers: "in-app",
      },
    });
    await h.apply(submissions[0]?.[0] as number);
    const text = drawnText(sentEmails[0]?.attachments?.[0]?.content as Uint8Array);
    expect(text).toContain("Fixture question one?");
    expect(text).toContain("Your answers are in the app.");
    expect(text).not.toMatch(/Answer: (Yes|No)/);
  });

  it("a retried send with the same key makes no second email", async () => {
    const h = await host({ hostAgreement: true });
    const first = await send(h, message);
    await h.apply(first.id);
    const again = await send(h, message);
    expect(again).toEqual({ status: "sent", id: first.id });
    expect(submissions).toHaveLength(1);
    expect(sentEmails).toHaveLength(1);
  });

  it("is never the sign-in or the routine kind", async () => {
    const h = await host({ hostAgreement: true, hostSignIn: true });
    await send(h, message);
    expect(submissions[0]?.[1].actionKind?.tag).toBe("email.agreement");
  });
});

const base: AgreementPdf = {
  business: "Fixture Studio",
  title: "Fixture waiver",
  versionNumber: 1,
  versionHash: HASH,
  body: {
    blocks: [{ type: "paragraph", content: [{ type: "text", text: "Fixture text." }] }],
  },
  tickLabel: "I have read this fixture",
  record: [{ label: "For", value: "Fixture Person" }],
  acceptanceId: "aga_fixture2",
};

describe("the PDF writer", () => {
  it("is a well-formed PDF: header, objects, cross-reference offsets and trailer", () => {
    const bytes = agreementPdf(base);
    const file = new TextDecoder("latin1").decode(bytes);
    expect(file.startsWith("%PDF-1.4\n")).toBe(true);
    expect(file.endsWith("%%EOF\n")).toBe(true);
    const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(file)?.[1]);
    expect(file.slice(startxref, startxref + 4)).toBe("xref");
    const entries = [...file.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) =>
      Number(m[1]),
    );
    expect(entries.length).toBeGreaterThan(5);
    entries.forEach((offset, i) => {
      expect(file.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
    // Each stream's /Length is its content's length.
    for (const m of file.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
      const start = (m.index ?? 0) + m[0].length;
      expect(file.slice(start + Number(m[1]), start + Number(m[1]) + 9)).toBe("endstream");
    }
  });

  it("is the same bytes for the same values, and embeds nothing remote", () => {
    const a = agreementPdf({ ...base, signature: SIGNATURE as AgreementPdf["signature"] });
    const b = agreementPdf({ ...base, signature: SIGNATURE as AgreementPdf["signature"] });
    expect([...a]).toEqual([...b]);
    const file = structure(a);
    for (const word of [
      "/URI",
      "/JavaScript",
      "/JS",
      "/Launch",
      "/OpenAction",
      "/AA",
      "/Annots",
      "/EmbeddedFile",
      "/FontFile",
      "/XObject",
      "/AcroForm",
      "/CreationDate",
      "http",
    ]) {
      expect(file, word).not.toContain(word);
    }
  });

  it("turns nothing in the document's words, a name typed or a note into PDF structure", () => {
    const hostile = [
      ") Tj ET BT /F1 99 Tf (owned) Tj ET (",
      "\\) Tj\nendstream\nendobj\n9 0 obj << /Type /Action /S /JavaScript /JS (app.alert(1)) >>",
      "<< /OpenAction << /S /URI /URI (https://evil.test) >> >>",
      "%%EOF\nxref\ntrailer << /Root 9 0 R >>",
      "<4142> Tj",
      "‮gnp.exe‬ and ​​",
    ];
    const doc: AgreementPdf = {
      ...base,
      title: hostile[0] as string,
      tickLabel: hostile[1] as string,
      body: {
        blocks: hostile.map((text) => ({
          type: "paragraph" as const,
          content: [{ type: "text" as const, text, href: "https://evil.test/x" }],
        })),
      },
      record: hostile.map((value, i) => ({ label: `Line ${i}`, value })),
    };
    const bytes = agreementPdf(doc);
    const file = structure(bytes);
    // The structure is exactly the writer's: one catalog, one page tree, the five fonts, the
    // info dictionary and each page with its content.
    expect(file.match(/\d+ 0 obj/g)?.length).toBe(file.match(/endobj/g)?.length);
    expect(file.match(/endstream/g)?.length).toBe(file.match(/\/Type \/Page /g)?.length);
    expect(file.match(/trailer/g)?.length).toBe(1);
    expect(file.match(/%%EOF/g)?.length).toBe(1);
    for (const word of ["/JavaScript", "/OpenAction", "/URI", "/Action", "owned", "evil"]) {
      expect(file, word).not.toContain(word);
    }
    // The words are still there, drawn as text, with the bidirectional and zero-width ones gone.
    const text = drawnText(bytes);
    expect(text).toContain("/S /JavaScript");
    expect(text).toContain("gnp.exe and");
    expect(text).not.toMatch(/[‪-‮​]/);
  });

  it("draws what the standard fonts cannot as ?, and says so", () => {
    const text = drawnText(
      agreementPdf({ ...base, record: [{ label: "Name typed", value: "名前 Zoë" }] }),
    );
    expect(text).toContain("?? Zoë");
    expect(text).toContain("could not be drawn in this file");
    expect(drawnText(agreementPdf(base))).not.toContain("could not be drawn");
  });

  it("a blank form has lines to sign and the version's hash at the foot of every page", () => {
    const long = Array.from({ length: 120 }, (_, i) => ({
      type: "paragraph" as const,
      content: [{ type: "text" as const, text: `Fixture paragraph ${i} `.repeat(8) }],
    }));
    const bytes = agreementPdf({
      ...base,
      record: undefined,
      acceptanceId: undefined,
      blank: true,
      body: { blocks: long },
      questions: [{ key: "heart", text: "Fixture question one?" }],
    });
    const file = new TextDecoder("latin1").decode(bytes);
    const pages = file.match(/\/Type \/Page /g)?.length ?? 0;
    expect(pages).toBeGreaterThan(2);
    const text = drawnText(bytes);
    expect(text.split(`SHA-256 ${HASH}`).length - 1).toBe(pages);
    expect(text).toContain(`page ${pages} of ${pages}`);
    expect(text).toContain("Signature: ____");
    expect(text).toContain("a form to sign on paper");
    expect(text).toContain("Fixture question one?");
    // A blank form has no tick in its box, and no record.
    expect(text).not.toContain("Record");
  });

  it("draws a signature as lines in its box", () => {
    const file = new TextDecoder("latin1").decode(
      agreementPdf({ ...base, signature: SIGNATURE as AgreementPdf["signature"] }),
    );
    // Four points: a move and three lines, stroked.
    expect(file).toMatch(/\d+(\.\d+)? \d+(\.\d+)? m( \d+(\.\d+)? \d+(\.\d+)? l){3} S/);
  });
});

describe("keys and lists are kept apart by who is sending (the review of PR #283)", () => {
  it("another caller cannot take the copy's key, and a key another caller used never answers the host's send", async () => {
    const h = await host({});
    // The copy's key itself: refused to every queue but the host's agreements mail.
    await expect(
      send(h, {
        to: ["attacker@outside.test"],
        subject: "anything",
        text: "hi",
        idempotencyKey: message.idempotencyKey,
      }),
    ).rejects.toThrow(/is the host's own agreements mail's/);
    for (const options of [{ hostSignIn: true }, { hostRoutine: { siteOrigin: null } }]) {
      await h.open(SENDER_URL, options);
      await expect(
        send(h, {
          to: ["a@outside.test"],
          subject: "x",
          text: "y",
          idempotencyKey: message.idempotencyKey,
        }),
      ).rejects.toThrow(/is the host's own agreements mail's/);
    }
    expect(submissions).toEqual([]);
    // Any other key two sessions share: each class's own send.
    await h.open(SENDER_URL, {});
    const theirs = await send(h, {
      to: ["attacker@outside.test"],
      subject: "anything",
      text: "hi",
      idempotencyKey: "shared-key-1",
    });
    await h.open(SENDER_URL, { hostSignIn: true });
    const ours = await send(h, {
      to: ["member@members.test"],
      subject: "x",
      text: "y",
      idempotencyKey: "shared-key-1",
    });
    expect(ours.id).not.toBe(theirs.id);
    expect(submissions).toHaveLength(2);
    // The host's copy, sent after a caller sent anything at all: its own, with its attachment.
    await h.open(SENDER_URL, { hostAgreement: true });
    const copy = await send(h, message);
    await h.apply(copy.id);
    expect(sentEmails.map((m) => [m.to, (m.attachments ?? []).length])).toEqual([
      [["member@members.test"], 1],
    ]);
  });

  it("a copy whose first submission was cut off is submitted again, once applied it is sent, and one turned down is refused", async () => {
    const h = await host({ hostAgreement: true });
    const first = await send(h, message);
    expect(first.status).toBe("pending");
    // The retry finds it still waiting: submitted to the queue again, the same action.
    const again = await send(h, message);
    expect(again.id).toBe(first.id);
    expect(submissions.map(([id]) => id)).toEqual([first.id, first.id]);
    await h.apply(first.id);
    expect((await send(h, message)).status).toBe("sent");
    expect(submissions).toHaveLength(2);
    expect(sentEmails).toHaveLength(1);
    // Turned down: refused plainly, never left waiting for nothing.
    resetFakes();
    const other = { ...message, idempotencyKey: "agreement-copy:aga_fixture9" };
    const pending = await send(h, other);
    await h.reject(pending.id);
    await expect(send(h, other)).rejects.toThrow(/Refused: this email was turned down/);
    expect(sentEmails).toEqual([]);
  });

  it("listSent shows the host's agreements, sign-in and orders mail only to that same queue", async () => {
    const h = await host({ hostAgreement: true });
    const copy = await send(h, message);
    await h.apply(copy.id);
    const waiting = await send(h, { ...message, idempotencyKey: "agreement-copy:aga_fixture3" });
    expect(waiting.status).toBe("pending");
    const own = (await h.call("listSent", [])) as { id: number }[];
    expect(own.map((r) => r.id).sort()).toEqual([copy.id, waiting.id].sort());
    for (const options of [{}, { hostSignIn: true }, { hostRoutine: { siteOrigin: null } }]) {
      await h.open(SENDER_URL, options);
      const listed = JSON.stringify(await h.call("listSent", []));
      expect(listed, JSON.stringify(options)).not.toContain("member@members.test");
      expect(listed).not.toContain("your copy of");
    }
    // A caller's own mail stays listed to callers.
    await h.open(SENDER_URL, {});
    const mine = await send(h, { to: ["colleague@example.com"], subject: "Mine", text: "x" });
    expect(((await h.call("listSent", [])) as { id: number }[]).map((r) => r.id)).toContain(
      mine.id,
    );
  });
});
