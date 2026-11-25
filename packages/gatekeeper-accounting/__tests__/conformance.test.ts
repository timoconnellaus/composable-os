// Stage 61 acceptance criterion 1: the conformance suite passes against the fake, in memory and
// through the fake gatekeeper's own session as the host reaches it; checks that need the fake's
// controls are skipped against a target without them; and the suite fails a system that breaks
// the contract.

import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  CONFORMANCE_CHECKS,
  type ConformanceControl,
  type ConformanceTarget,
  prepareConformance,
  runCheck,
  runConformance,
} from "../src/conformance.js";
import { directSession } from "../src/direct.js";
import { FakeBooks } from "../src/fake.js";
import type { AccountingReceipt, AccountingSession } from "../src/types.js";

let counter = 0;
function unique(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;
}

/** The in-memory fake, its controls as the suite needs them. */
function memoryTarget(withControl = true): ConformanceTarget {
  const books = new FakeBooks();
  const { session, approve } = directSession(books);
  const control: ConformanceControl = {
    failNext: async (method, failure) => books.failNext(method, failure),
    writesOf: async (reference) => books.writesOf(reference),
    setLockDate: async (date) => books.setLockDate(date),
    recordPaymentInBooks: async (document, amount, date) =>
      books.recordPaymentInBooks(document, amount, date),
    addInvoiceInBooks: async (contact, number, total, date) =>
      books.addInvoiceInBooks(contact, number, total, date),
  };
  return { session, approve, ...(withControl ? { control } : {}) };
}

const WRITES = new Set([
  "upsertContact",
  "postSummary",
  "postTransfer",
  "postInvoice",
  "postCreditNote",
  "postPayment",
  "postRefund",
  "voidDocument",
]);

/**
 * The fake gatekeeper as the host reaches it: each call through a facet's session, an
 * auto-approvable write applied right after the call, its ref then found by its reference.
 */
async function gatekeeperTarget(): Promise<ConformanceTarget> {
  const books = unique("books-");
  const host = env.TEST_HOST.getByName(unique("host"));
  await host.open(books);
  const call = async (method: string, args: unknown[]) => {
    const value = await host.call(method, args);
    if (!WRITES.has(method)) return value;
    const receipt = value as AccountingReceipt;
    if (!(await host.recorded()).applied.includes(receipt.id)) return receipt;
    const reference = (args[0] as { reference: string }).reference;
    const found = (await host.call("findByReference", [reference])) as { ref: string } | null;
    return { status: "sent", id: receipt.id, ref: found?.ref ?? null };
  };
  const session = new Proxy(
    {},
    {
      get: (_target, method: string) => (input: unknown) =>
        call(method, input === undefined ? [] : [input]),
    },
  ) as AccountingSession;
  const c = exports.FakeBooksControl;
  return {
    session,
    approve: (id) => host.approve(id),
    control: {
      failNext: (method, failure) => c.failNext(books, method, failure),
      writesOf: (reference) => c.writesOf(books, reference),
      setLockDate: (date) => c.setLockDate(books, date),
      recordPaymentInBooks: (document, amount, date) =>
        c.recordPaymentInBooks(books, document, amount, date),
      addInvoiceInBooks: (contact, number, total, date) =>
        c.addInvoiceInBooks(books, contact, number, total, date),
    },
  };
}

const DATE = "2026-11-20";

describe("the conformance suite against the fake books in memory", () => {
  for (const check of CONFORMANCE_CHECKS) {
    it(check.name, async () => {
      const ctx = await prepareConformance(memoryTarget(), { run: unique("m"), date: DATE });
      expect(await runCheck(check, ctx)).toEqual({ name: check.name, status: "passed" });
    });
  }
});

describe("the conformance suite against the fake gatekeeper, through its session", () => {
  for (const check of CONFORMANCE_CHECKS) {
    it(check.name, async () => {
      const ctx = await prepareConformance(await gatekeeperTarget(), {
        run: unique("g"),
        date: DATE,
      });
      expect(await runCheck(check, ctx)).toEqual({ name: check.name, status: "passed" });
    });
  }
});

describe("the suite itself", () => {
  it("skips the checks that need the fake's controls against a target without them", async () => {
    const results = await runConformance(memoryTarget(false), { run: unique("n"), date: DATE });
    const skipped = results.filter((r) => r.status === "skipped").map((r) => r.name);
    expect(results.filter((r) => r.status === "failed")).toEqual([]);
    expect(skipped).toEqual([
      // Unlocked books and no control to lock them.
      "refuses an entry dated on or before the books' lock date, and posts the day after",
      ...CONFORMANCE_CHECKS.filter((c) => c.needsControl).map((c) => c.name),
    ]);
  });

  it("checks the lock date against locked books without controls", async () => {
    const books = new FakeBooks();
    books.setLockDate("2026-10-31");
    const { session, approve } = directSession(books);
    const results = await runConformance({ session, approve }, { run: unique("l"), date: DATE });
    expect(results.find((r) => r.name.startsWith("refuses an entry dated on"))?.status).toBe(
      "passed",
    );
  });

  it("refuses to run on a day inside the lock", async () => {
    const books = new FakeBooks();
    books.setLockDate(DATE);
    const { session, approve } = directSession(books);
    await expect(
      prepareConformance({ session, approve }, { run: "x", date: DATE }),
    ).rejects.toThrow(/locked to 2026-11-20/);
  });

  it("fails a system that does not keep the host's reference", async () => {
    const books = new FakeBooks();
    // Writes, but never finds anything by reference again: a second send writes a second entry.
    books.findByReference = async () => null;
    const { session, approve } = directSession(books);
    const results = await runConformance({ session, approve }, { run: unique("b"), date: DATE });
    const failed = results.filter((r) => r.status === "failed").map((r) => r.name);
    expect(failed).toContain(
      "posts a summary, finds it by its reference, and never writes it twice",
    );
    expect(failed).toContain("creates a contact once, finds it by its reference, and updates it");
  });

  it("fails a session that offers a delete", async () => {
    const target = memoryTarget();
    (target.session as unknown as Record<string, unknown>).deleteDocument = async () => {};
    const ctx = await prepareConformance(target, { run: unique("d"), date: DATE });
    const check = CONFORMANCE_CHECKS.find((c) => c.name.startsWith("has no delete"));
    expect((await runCheck(check as never, ctx)).status).toBe("failed");
  });
});
