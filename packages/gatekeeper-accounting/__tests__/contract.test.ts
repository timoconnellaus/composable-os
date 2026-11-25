// The contract's own rules, beside the conformance suite: what the input checks refuse, how a
// refusal travels, which kinds a host may approve automatically (never a void), what a person
// reads before a write goes, and the fake gatekeeper's vendor and account.

import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { applyWrite } from "../src/apply.js";
import { describeWrite } from "../src/describe.js";
import { FakeBooks } from "../src/fake.js";
import { REFUSAL_CODES, refusalCode, refuse } from "../src/refusal.js";
import { ACCOUNTING_SESSION_METHODS } from "../src/session.js";
import type { AccountingSummaryInput } from "../src/types.js";
import {
  parseContactInput,
  parseDocumentInput,
  parseReference,
  parseStatusRefs,
  parseSummaryInput,
  parseTransferInput,
  parseVoidInput,
} from "../src/validate.js";

const SUMMARY: AccountingSummaryInput = {
  reference: "cos:summary:2026-11-20:1",
  currency: "AUD",
  date: "2026-11-20",
  text: "Card sales, 20 November",
  lines: [
    { account: "acc-clearing", taxRate: null, net: 1100, tax: 0, text: "Card sales" },
    { account: "acc-passes", taxRate: "tax-gst", net: -1000, tax: -100, text: "Passes" },
  ],
};

function code(fn: () => unknown): string | null {
  try {
    fn();
  } catch (error) {
    return refusalCode(error);
  }
  return "accepted";
}

describe("input checks", () => {
  it("takes a balanced summary and copies only its known keys", () => {
    expect(parseSummaryInput(SUMMARY)).toEqual(SUMMARY);
    expect(code(() => parseSummaryInput({ ...SUMMARY, extra: 1 }))).toBe("invalid");
  });

  it("refuses lines that do not balance, tax without a rate, and amounts that are not whole", () => {
    const [a, b] = SUMMARY.lines as [
      AccountingSummaryInput["lines"][0],
      AccountingSummaryInput["lines"][0],
    ];
    expect(code(() => parseSummaryInput({ ...SUMMARY, lines: [{ ...a, net: 1101 }, b] }))).toBe(
      "invalid",
    );
    expect(code(() => parseSummaryInput({ ...SUMMARY, lines: [a, { ...b, taxRate: null }] }))).toBe(
      "invalid",
    );
    expect(
      code(() =>
        parseSummaryInput({
          ...SUMMARY,
          lines: [
            { ...a, net: 11.5 },
            { ...b, net: -10.5 },
          ],
        }),
      ),
    ).toBe("invalid");
    expect(code(() => parseSummaryInput({ ...SUMMARY, lines: [a] }))).toBe("invalid");
  });

  it("takes only the host's own references and real calendar days", () => {
    expect(parseReference("cos:summary:2026-11-20:1")).toBe("cos:summary:2026-11-20:1");
    expect(parseReference("cos:person:p_123")).toBe("cos:person:p_123");
    for (const bad of ["INV-001", "cos:", "cos:Summary:1", `cos:x:${"a".repeat(99)}`, 7]) {
      expect(code(() => parseReference(bad))).toBe("invalid");
    }
    expect(code(() => parseSummaryInput({ ...SUMMARY, date: "2026-02-30" }))).toBe("invalid");
    expect(code(() => parseSummaryInput({ ...SUMMARY, currency: "aud" }))).toBe("invalid");
  });

  it("refuses a transfer from clearing to clearing, and one that moves nothing", () => {
    const transfer = {
      reference: "cos:payout:po_1:1",
      currency: "AUD",
      date: "2026-11-20",
      text: "Payout",
      clearingAccount: "acc-clearing",
      bankAccount: "acc-bank",
      amount: 9650,
      lines: [{ account: "acc-fees", amount: 350, text: "Fees" }],
    };
    expect(parseTransferInput(transfer)).toEqual(transfer);
    expect(code(() => parseTransferInput({ ...transfer, bankAccount: "acc-clearing" }))).toBe(
      "invalid",
    );
    expect(code(() => parseTransferInput({ ...transfer, amount: 0, lines: [] }))).toBe("invalid");
  });

  it("refuses a document due before it is issued, with no total, or a quantity of 5 decimals", () => {
    const doc = {
      reference: "cos:invoice:inv_1:1",
      currency: "AUD",
      number: "INV-0001",
      contact: "con-example",
      issueDate: "2026-11-20",
      dueDate: "2026-12-04",
      lines: [
        {
          text: "Room hire",
          account: "acc-sales",
          taxRate: "tax-gst",
          quantity: 1.5,
          unitPrice: 2000,
          net: 3000,
          tax: 300,
        },
      ],
    };
    expect(parseDocumentInput(doc)).toEqual(doc);
    expect(code(() => parseDocumentInput({ ...doc, dueDate: "2026-11-19" }))).toBe("invalid");
    const line = doc.lines[0] as (typeof doc.lines)[0];
    expect(
      code(() =>
        parseDocumentInput({ ...doc, lines: [{ ...line, net: -3300, tax: 0, taxRate: null }] }),
      ),
    ).toBe("invalid");
    expect(
      code(() => parseDocumentInput({ ...doc, lines: [{ ...line, quantity: 1.00001 }] })),
    ).toBe("invalid");
  });

  it("checks a contact's email, a status read's refs and a void's reason", () => {
    expect(
      code(() =>
        parseContactInput({ reference: "cos:person:p1", name: "A", email: "not an email" }),
      ),
    ).toBe("invalid");
    expect(code(() => parseStatusRefs(["a", "a"]))).toBe("invalid");
    expect(code(() => parseStatusRefs(Array.from({ length: 101 }, (_, i) => `r${i}`)))).toBe(
      "invalid",
    );
    expect(
      code(() => parseVoidInput({ reference: "cos:invoice:i1:1", ref: "x", reason: "" })),
    ).toBe("invalid");
  });
});

describe("refusals", () => {
  it("carry their code at the front of the message, and are found behind the host's tag", () => {
    for (const c of REFUSAL_CODES) {
      const error = refuse(c, "why");
      expect(error.message).toBe(`[accounting:${c}] why`);
      expect(refusalCode(`[apply-outcome:refused] ${error.message}`)).toBe(c);
    }
    expect(refusalCode("[apply-outcome:unknown] the answer was lost")).toBeNull();
    expect(refusalCode("[accounting:made_up] no")).toBeNull();
  });

  it("are given before anything is written: another currency, a locked day", async () => {
    const books = new FakeBooks();
    books.setLockDate("2026-11-20");
    const write = { kind: "summary", input: SUMMARY } as const;
    await expect(applyWrite(books, write)).rejects.toThrow(/\[accounting:locked_period\]/);
    books.setLockDate(null);
    await expect(
      applyWrite(books, { kind: "summary", input: { ...SUMMARY, currency: "NZD" } }),
    ).rejects.toThrow(/\[accounting:invalid\] The books keep AUD/);
    expect(books.state.records).toEqual([]);
    expect(books.writesOf(SUMMARY.reference)).toBe(0);
  });

  it("hold an entry to an archived account or an unknown tax rate as unmapped", async () => {
    const books = new FakeBooks();
    const [a, b] = SUMMARY.lines as [
      AccountingSummaryInput["lines"][0],
      AccountingSummaryInput["lines"][0],
    ];
    await expect(
      applyWrite(books, {
        kind: "summary",
        input: { ...SUMMARY, lines: [a, { ...b, account: "acc-old-sales" }] },
      }),
    ).rejects.toThrow(/\[accounting:unmapped\]/);
    await expect(
      applyWrite(books, {
        kind: "summary",
        input: { ...SUMMARY, lines: [a, { ...b, taxRate: "tax-old" }] },
      }),
    ).rejects.toThrow(/\[accounting:unmapped\]/);
  });

  it("refuse a document to an archived contact", async () => {
    const books = new FakeBooks();
    await expect(
      applyWrite(books, {
        kind: "invoice",
        input: {
          reference: "cos:invoice:i1:1",
          currency: "AUD",
          number: "INV-1",
          contact: "con-closed",
          issueDate: "2026-11-20",
          dueDate: "2026-11-20",
          lines: [
            {
              text: "Hire",
              account: "acc-sales",
              taxRate: null,
              quantity: 1,
              unitPrice: 500,
              net: 500,
              tax: 0,
            },
          ],
        },
      }),
    ).rejects.toThrow(/\[accounting:contact_archived\]/);
  });
});

describe("what a person reads", () => {
  it("names the books, the date, every line and the reference", () => {
    const description = describeWrite({
      books: "Fake books",
      write: { kind: "summary", input: SUMMARY },
    });
    expect(description.title).toBe("Post the entry of 2026-11-20");
    const text = JSON.stringify(description);
    for (const part of [
      "Fake books",
      "acc-passes",
      "-10.00 AUD",
      "tax -1.00 AUD at tax-gst",
      SUMMARY.reference,
    ]) {
      expect(text).toContain(part);
    }
  });

  it("says a void leaves the document in the books", () => {
    const description = describeWrite({
      books: "Fake books",
      write: {
        kind: "void",
        input: { reference: "cos:invoice:i1:1", ref: "fake-invoice-3", reason: "Wrong customer" },
      },
    });
    expect(description.description).toContain("nothing is deleted");
    expect(JSON.stringify(description.fields)).toContain("Wrong customer");
  });
});

describe("the fake gatekeeper", () => {
  async function open() {
    const books = `books-${crypto.randomUUID().slice(0, 8)}`;
    const host = env.TEST_HOST.getByName(books);
    return { host, books, resource: await host.open(books) };
  }

  it("describes its vendor as auto-provisioned, with no sign-in", async () => {
    const vendor = exports.GatekeeperVendor as unknown as {
      describe(): Promise<{
        displayName: string;
        autoProvisionsAccount?: boolean;
        providesAuth?: boolean;
      }>;
      getSupportedResources(): Promise<{ urlPattern: string }[]>;
    };
    expect(await vendor.describe()).toMatchObject({
      displayName: "Fake books (development)",
      autoProvisionsAccount: true,
      providesAuth: false,
    });
    expect((await vendor.getSupportedResources()).map((r) => r.urlPattern)).toEqual([
      "accounting-fake://books/:name",
    ]);
  });

  it("refuses a resource that is not fake books", async () => {
    const account = exports.FakeBooksAccount as unknown as {
      getGatekeeperClassFor(url: string): Promise<unknown>;
    };
    await expect(account.getGatekeeperClassFor("accounting-fake://books/Bad Name")).rejects.toThrow(
      /Not fake books/,
    );
  });

  it("serves the contract's types and describes its resource", async () => {
    const { host, books, resource } = await open();
    expect(resource).toMatchObject({
      url: `accounting-fake://books/${books}`,
      title: "Fake books (development)",
      tsType: "AccountingSession",
    });
    const types = await host.types();
    expect(types).toContain("export interface AccountingSession");
    // The contract has no delete, and no edit of a posted entry.
    expect(types).not.toMatch(/\bdelete[A-Z]\w*\(/);
    expect(types).not.toMatch(
      /\b(update|edit)(Summary|Transfer|Invoice|CreditNote|Payment|Refund|Entry|Document)\(/,
    );
  });

  it("approves contacts and entries automatically, and never a void", async () => {
    const { host } = await open();
    expect((await host.autoApprovable()).map((k) => k.tag).sort()).toEqual([
      "accounting.contact",
      "accounting.post",
    ]);
  });

  it("records each read as an observation and each write as an action of its kind", async () => {
    const { host } = await open();
    await host.call("describeBooks", []);
    await host.call("postSummary", [SUMMARY]);
    const receipt = (await host.call("voidDocument", [
      { reference: "cos:invoice:i1:1", ref: "fake-invoice-1", reason: "Mistake" },
    ])) as { status: string };
    expect(receipt.status).toBe("pending");
    const { observations, submitted } = await host.recorded();
    expect(observations.map((o) => o.title)).toEqual(["Read the books' settings"]);
    expect(
      submitted.map((s) => [s.description.actionKind?.tag, s.description.autoApprovable]),
    ).toEqual([
      ["accounting.post", true],
      ["accounting.void", false],
    ]);
  });

  it("refuses to take back an applied entry", async () => {
    const { host } = await open();
    await host.call("postSummary", [SUMMARY]);
    const { applied } = await host.recorded();
    await expect(host.revert(applied[0] as number)).rejects.toThrow(/a correction is a new entry/);
  });

  it("serves exactly the contract's methods", async () => {
    const { host } = await open();
    for (const method of ACCOUNTING_SESSION_METHODS) {
      // Each is there: an empty call is refused by its input check, never "not implemented".
      let outcome = "answered";
      try {
        await host.call(method, []);
      } catch (error) {
        outcome = (error as Error).message;
      }
      expect(outcome).not.toMatch(/does not implement/);
    }
  });
});
