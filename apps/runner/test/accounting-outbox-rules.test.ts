// Stage 61 step 4 (ADR 0882): the outbox runner's rules, through the real integration host
// against the fake books. What depends on another entry waits for it and is held while it is
// held; a refusal holds only what it touches; nothing is dated inside the books' lock (decision
// 7) and nothing before the start date is sent (decision 6); an entry nobody mapped waits for the
// mapping, and a mapping changed before an entry is sent applies to it; a connection that is not
// active or books in another currency block everything and the admins are told once; the daily
// pass builds each settled day once, from 02:00 in the organisation's zone.
import { env } from "cloudflare:workers";
import { DAYS_PER_RUN, type DayBuilder, runAccountingDue } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { minuteTick } from "../src/index.ts";
import {
  type Books,
  books,
  clearOutbox,
  connectBooks,
  integrations,
  minutes,
  op,
  post,
  queue,
  refusal,
  runAt,
  START,
  source,
  summaryEntry,
} from "./accounting-fixture.ts";

const NOW = "2026-11-26T03:00:00.000Z";
let b: Books;

beforeAll(async () => {
  b = await connectBooks();
});

beforeEach(async () => {
  await clearOutbox(b);
});

const writesOf = (reference: string) => books.writesOf(b.name, reference);

/** A contact, then an invoice under it, then a payment against the invoice. */
async function invoiceChain(day = "2026-11-20") {
  const id = source("inv");
  const contact = await queue({
    connectionId: b.connectionId,
    kind: "contact",
    sourceKind: "organisation",
    sourceId: id,
    belongsDate: day,
    amount: 0,
    body: { name: `Customer ${id}`, email: `${id}@example.com` },
  });
  const invoice = await queue({
    connectionId: b.connectionId,
    kind: "invoice",
    sourceKind: "invoice",
    sourceId: id,
    belongsDate: day,
    amount: 2200,
    lines: [
      {
        text: "Room hire",
        account: { map: "category", key: "memberships" },
        taxRate: { map: "tax", key: "gst" },
        quantity: 1,
        unitPrice: 2000,
        net: 2000,
        tax: 200,
      },
    ],
    body: {
      number: `INV-${id}`.slice(0, 40),
      contact: { dep: "books_ref" },
      dueDate: "2026-12-04",
    },
    dependsOn: contact.id,
  });
  const payment = await queue({
    connectionId: b.connectionId,
    kind: "payment",
    sourceKind: "payment",
    sourceId: id,
    belongsDate: day,
    amount: 1000,
    body: {
      document: { dep: "books_ref" },
      account: { map: "clearing" },
      amount: 1000,
      text: "Part payment by card",
    },
    dependsOn: invoice.id,
  });
  return { contact, invoice, payment };
}

describe("dependencies", () => {
  it("each waits for the one before it and names its books ref, in one run", async () => {
    const { contact, invoice, payment } = await invoiceChain();
    const result = await runAt(NOW);
    expect(result.sent).toBe(3);
    const [c, i, p] = await Promise.all([post(contact.id), post(invoice.id), post(payment.id)]);
    expect(JSON.parse(i.request ?? "{}").contact).toBe(c.books_ref);
    expect(JSON.parse(p.request ?? "{}")).toMatchObject({
      document: i.books_ref,
      account: "acc-clearing",
    });
    for (const q of [contact, invoice, payment]) expect(await writesOf(q.reference)).toBe(1);
  });

  it("a held invoice holds its payment and nothing else; sent on retry, it releases the payment", async () => {
    const { contact, invoice, payment } = await invoiceChain();
    const other = await queue(summaryEntry(b, "2026-11-21"));
    await books.failNext(b.name, "postInvoice", { refuse: "duplicate_number" });
    await runAt(NOW);
    expect(await post(contact.id)).toMatchObject({ state: "sent" });
    expect(await post(invoice.id)).toMatchObject({ state: "held", error_code: "duplicate_number" });
    expect(await post(payment.id)).toMatchObject({ state: "held", error_code: "waits_for" });
    expect((await post(payment.id)).error_text).toContain(invoice.reference);
    // An unrelated day still went.
    expect(await post(other.id)).toMatchObject({ state: "sent" });
    expect(await writesOf(payment.reference)).toBe(0);

    await op("accounting.post.retry", { id: invoice.id }, b.admin);
    await runAt(minutes(NOW, 1));
    expect(await post(invoice.id)).toMatchObject({ state: "sent" });
    expect(await post(payment.id)).toMatchObject({ state: "sent" });
    for (const q of [contact, invoice, payment, other]) expect(await writesOf(q.reference)).toBe(1);
  });

  it("an entry whose dependency waits for approval waits too, without being held", async () => {
    const { contact, invoice } = await invoiceChain();
    await env.DB.prepare("UPDATE core_accounting_post SET state = 'awaiting_approval' WHERE id = ?")
      .bind(contact.id)
      .run();
    await runAt(NOW);
    expect(await post(invoice.id)).toMatchObject({ state: "queued" });
    expect((await post(invoice.id)).next_attempt_at).not.toBeNull();
    expect(await writesOf(invoice.reference)).toBe(0);
  });

  it("an entry whose dependency a person skipped is held, never sent", async () => {
    const { contact, invoice } = await invoiceChain();
    await op("accounting.post.skip", { id: contact.id, reason: "Entered by hand" }, b.admin);
    await runAt(NOW);
    const held = await post(invoice.id);
    expect(held).toMatchObject({ state: "held", error_code: "waits_for" });
    expect(held.error_text).toContain("skipped");
    expect(await writesOf(invoice.reference)).toBe(0);
  });
});

describe("refusals", () => {
  it("a refusal a person must fix holds the entry with its reason; the rest carry on", async () => {
    const bad = await queue(summaryEntry(b, "2026-11-20"));
    const good = await queue(summaryEntry(b, "2026-11-21"));
    await books.failNext(b.name, "postSummary", { refuse: "invalid" });
    const result = await runAt(NOW);
    expect(result).toMatchObject({ held: 1, sent: 1 });
    expect(await post(bad.id)).toMatchObject({ state: "held", error_code: "invalid" });
    expect((await post(bad.id)).error_text).not.toContain("[apply-outcome");
    expect(await post(good.id)).toMatchObject({ state: "sent" });
  });

  it("a person skips a held entry with why; it is never sent and never changes again", async () => {
    const bad = await queue(summaryEntry(b, "2026-11-20"));
    await books.failNext(b.name, "postSummary", { refuse: "invalid" });
    await runAt(NOW);
    await op("accounting.post.skip", { id: bad.id, reason: "Entered by hand already" }, b.admin);
    await runAt(minutes(NOW, 1));
    expect(await post(bad.id)).toMatchObject({ state: "skipped" });
    expect(await writesOf(bad.reference)).toBe(0);
    const again = await refusal(op("accounting.post.retry", { id: bad.id }, b.admin));
    expect(again.code).toBe("conflict");
  });

  it("refuses to skip an entry that may be in the books", async () => {
    const q = await queue(summaryEntry(b, "2026-11-20"));
    await books.failNext(b.name, "postSummary", "unknown_after_write");
    await runAt(NOW);
    expect((await post(q.id)).state).toBe("unknown");
    const skip = await refusal(op("accounting.post.skip", { id: q.id, reason: "no" }, b.admin));
    expect(skip.code).toBe("conflict");
    await runAt(minutes(NOW, 1));
    expect((await post(q.id)).state).toBe("sent");
    const sent = await refusal(op("accounting.post.skip", { id: q.id, reason: "no" }, b.admin));
    expect(sent.code).toBe("conflict");
  });
});

describe("the lock date (decision 7)", () => {
  it("an entry dated on or before it carries the first open day, its real date in the text", async () => {
    await books.setLockDate(b.name, "2026-11-30");
    const late = await queue(summaryEntry(b, "2026-11-12"));
    const onLock = await queue(summaryEntry(b, "2026-11-30"));
    await runAt(NOW);
    for (const q of [late, onLock]) {
      const row = await post(q.id);
      expect(row).toMatchObject({ state: "sent", carries_date: "2026-12-01" });
    }
    const records = (await books.state(b.name)).records;
    const lateRecord = records.find((r) => r.reference === late.reference);
    expect(lateRecord?.date).toBe("2026-12-01");
    expect(lateRecord?.input.text).toContain(
      "dated 12 November 2026, the books are locked to 30 November 2026",
    );
    // Nothing is ever dated inside the lock.
    for (const r of records) expect(r.date > "2026-11-30").toBe(true);
  });

  it("is read again each run: a lock moved after a refusal re-dates the entry", async () => {
    const q = await queue(summaryEntry(b, "2026-11-20"));
    // The books lock between the run's read and the send: refused, nothing written.
    await books.failNext(b.name, "postSummary", { refuse: "locked_period" });
    await runAt(NOW);
    expect(await post(q.id)).toMatchObject({ state: "retrying", error_code: "locked_period" });
    await books.setLockDate(b.name, "2026-11-25");
    await runAt(minutes(NOW, 2));
    expect(await post(q.id)).toMatchObject({ state: "sent", carries_date: "2026-11-26" });
    expect(await writesOf(q.reference)).toBe(1);
  });

  it("a document moved past the lock says so on its first line and falls due no earlier", async () => {
    await books.setLockDate(b.name, "2026-12-10");
    const { invoice } = await invoiceChain("2026-11-20");
    await runAt(NOW);
    const sent = JSON.parse((await post(invoice.id)).request ?? "{}");
    expect(sent).toMatchObject({ issueDate: "2026-12-11", dueDate: "2026-12-11" });
    expect(sent.lines[0].text).toContain("dated 20 November 2026");
  });
});

describe("the start date (decision 6)", () => {
  it("nothing before it is queued", async () => {
    const before = await queue(summaryEntry(b, "2026-10-31")).catch((e: Error) => e);
    expect(String(before)).toContain("not queued");
  });

  it("an entry before it that reached the outbox anyway is held, never sent, and not retried", async () => {
    const q = await queue(summaryEntry(b, START));
    await env.DB.prepare(
      "UPDATE core_accounting_post SET belongs_date = '2026-10-15', carries_date = '2026-10-15' WHERE id = ?",
    )
      .bind(q.id)
      .run();
    await runAt(NOW);
    expect(await post(q.id)).toMatchObject({ state: "held", error_code: "before_start" });
    expect(await writesOf(q.reference)).toBe(0);
    expect((await refusal(op("accounting.post.retry", { id: q.id }, b.admin))).code).toBe(
      "conflict",
    );
  });
});

describe("the mapping", () => {
  it("an entry nobody mapped is held saying what to map; once mapped it is sent", async () => {
    const q = await queue({
      ...summaryEntry(b, "2026-11-20"),
      lines: [
        { account: { map: "clearing" }, taxRate: null, net: 1100, tax: 0, text: "Card sales" },
        {
          account: { map: "category", key: "passes" },
          taxRate: { map: "tax", key: "gst" },
          net: -1000,
          tax: -100,
          text: "Passes",
        },
      ],
    });
    await runAt(NOW);
    expect(await post(q.id)).toMatchObject({
      state: "held",
      error_code: "unmapped",
      error_text: "map passes to an account",
    });
    expect(await writesOf(q.reference)).toBe(0);
    await op(
      "accounting.map.set",
      {
        kind: "category",
        hostKey: "passes",
        booksRef: "acc-passes",
        booksName: "Passes and drop-ins",
      },
      b.admin,
    );
    expect((await post(q.id)).state).toBe("queued");
    await runAt(minutes(NOW, 1));
    expect(await post(q.id)).toMatchObject({ state: "sent" });
    expect(JSON.parse((await post(q.id)).request ?? "{}").lines[1].account).toBe("acc-passes");
  });

  it("a change applies to entries not yet sent, never to one sent", async () => {
    const sent = await queue(summaryEntry(b, "2026-11-20"));
    await runAt(NOW);
    const waiting = await queue(summaryEntry(b, "2026-11-21"));
    await op(
      "accounting.map.set",
      { kind: "category", hostKey: "memberships", booksRef: "acc-sales", booksName: "Sales" },
      b.admin,
    );
    await runAt(minutes(NOW, 1));
    const lineAccount = async (id: string) =>
      JSON.parse((await post(id)).request ?? "{}").lines[1].account;
    expect(await lineAccount(sent.id)).toBe("acc-memberships");
    expect(await lineAccount(waiting.id)).toBe("acc-sales");
    await op(
      "accounting.map.set",
      {
        kind: "category",
        hostKey: "memberships",
        booksRef: "acc-memberships",
        booksName: "Memberships",
      },
      b.admin,
    );
  });
});

describe("blocked", () => {
  async function noticeCount(): Promise<number> {
    const row = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_notifications WHERE user_id = ? AND title LIKE 'Nothing is going to the books%'",
    )
      .bind(b.admin.id)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  it("an expired connection sends nothing, loses nothing, and tells the admins once", async () => {
    const q = await queue(summaryEntry(b, "2026-11-20"));
    const told = await noticeCount();
    await env.DB.prepare("UPDATE core_integration_connection SET status = 'expired' WHERE id = ?")
      .bind(b.connectionId)
      .run();
    try {
      for (let i = 0; i < 5; i++) {
        expect(await runAt(minutes(NOW, i))).toMatchObject({
          state: "blocked",
          blocked: "connection",
        });
      }
      expect(await noticeCount()).toBe(told + 1);
      expect(await post(q.id)).toMatchObject({ state: "queued", attempts: 0 });
    } finally {
      await env.DB.prepare("UPDATE core_integration_connection SET status = 'active' WHERE id = ?")
        .bind(b.connectionId)
        .run();
    }
    await runAt(minutes(NOW, 10));
    expect(await post(q.id)).toMatchObject({ state: "sent" });
  });

  it("books in another currency send nothing and tell the admins once", async () => {
    const q = await queue(summaryEntry(b, "2026-11-20"));
    await books.reset(b.name, { baseCurrency: "NZD" });
    const told = await noticeCount();
    for (let i = 0; i < 3; i++) {
      expect(await runAt(minutes(NOW, i))).toMatchObject({ state: "blocked", blocked: "currency" });
    }
    expect(await noticeCount()).toBe(told + 1);
    expect(await writesOf(q.reference)).toBe(0);
    await books.reset(b.name);
    await runAt(minutes(NOW, 5));
    expect(await post(q.id)).toMatchObject({ state: "sent" });
  });

  it("turned off, the runner sends nothing; the entries wait", async () => {
    const q = await queue(summaryEntry(b, "2026-11-20"));
    await env.DB.prepare("UPDATE core_accounting_settings SET enabled = 0").run();
    try {
      expect(await runAt(NOW)).toMatchObject({ state: "off" });
      expect(await post(q.id)).toMatchObject({ state: "queued" });
    } finally {
      await env.DB.prepare("UPDATE core_accounting_settings SET enabled = 1").run();
    }
  });
});

describe("the daily pass", () => {
  it("from 02:00 in the organisation's zone builds each settled day once, a few a run", async () => {
    const built: string[] = [];
    const builder: DayBuilder = async ({ day }) => {
      built.push(day);
      // Builds as step 5 will: one entry a day, queued once by its reference.
      await queue(summaryEntry(b, day, { sourceId: `daily-${day}` }));
    };
    await env.DB.prepare("UPDATE core_accounting_settings SET daily_date = NULL").run();
    const run = (iso: string) =>
      runAccountingDue({
        db: createCrmDb(env.DB).query,
        integrations,
        clock: () => new Date(iso),
        builders: [builder],
      });
    // 01:30 on 26 November in Sydney (14:30 UTC the day before): not yet.
    expect(await run("2026-11-25T14:30:00.000Z")).toBeNull();
    expect(built).toEqual([]);
    // 02:05 in Sydney: the start date onwards, settled two days (to the 24th), a few a run.
    const first = await run("2026-11-25T15:05:00.000Z");
    expect(first?.days).toBe(DAYS_PER_RUN);
    expect(first?.more).toBe(true);
    for (let i = 1; i < 6; i++)
      await run(`2026-11-25T15:${String(5 + i).padStart(2, "0")}:00.000Z`);
    const days = Array.from({ length: 24 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`);
    expect(built).toEqual(days);
    // A day built twice (a run that stopped, two at once) queues nothing twice.
    await Promise.all([
      builder({ day: "2026-11-24" } as never),
      builder({ day: "2026-11-24" } as never),
    ]);
    const rows = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_accounting_post WHERE source_id LIKE 'daily-%' AND state != 'skipped'",
    ).first<{ n: number }>();
    expect(rows?.n).toBe(24);
    // The same local day later: nothing more to build.
    await run("2026-11-26T05:00:00.000Z");
    expect(built).toHaveLength(26);
  });
});

describe("the minute cron", () => {
  it("sends what is due as one of its steps, and a quiet minute after it finds nothing to do", async () => {
    const q = await queue(summaryEntry(b, "2026-11-20"));
    const tick = await minuteTick(env, new Date(NOW));
    expect(tick.accounting).toMatchObject({ state: "ran", sent: 1 });
    expect(await post(q.id)).toMatchObject({ state: "sent" });
    expect((await minuteTick(env, new Date(minutes(NOW, 1)))).accounting).toBeNull();
  });
});
