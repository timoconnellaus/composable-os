// Stage 61 step 4, the review of PR #504 (ADR 0882): what must never post twice or loop for ever.
// A write the host knows was applied is never sent again, however long the books take to find
// its reference; an uncertain outcome is looked up for 36 minutes before it is sent again, and at
// most three times; an error with no refusal code is held, not looped; a call that hangs is cut
// off and its late outcome never lands on another run's claim; one entry refused for hours holds
// up only its own day, and the bookkeepers hear of it; a change of books strands nothing; a
// person's details stay where an erase can clear them; an entry left in Approvals is recorded
// once a person decides it there. Through the real integration host against the fake books,
// with the host's answer changed only where the fake cannot be made to give it.
import { env } from "cloudflare:workers";
import {
  APPLIED_LOOKUP_MINUTES,
  accountingDue,
  MAX_UNKNOWNS,
  newId,
  queuePost,
  runAccounting,
  STALE_MS,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type Books,
  books,
  changedWrites,
  clearOutbox,
  connectBooks,
  integrations,
  minutes,
  noticesTitled,
  op,
  post,
  queue,
  refusal,
  runAt,
  summaryEntry,
  transferEntry,
  writesAt,
} from "./accounting-fixture.ts";
import { meterStatements } from "./statement-meter.ts";

const NOW = "2026-11-26T03:00:00.000Z";
let b: Books;

beforeAll(async () => {
  b = await connectBooks();
});

beforeEach(async () => {
  await clearOutbox(b);
  await books.setLookupLag(b.name, 0);
});

const HELD_NOTICE = "Entries are held back from the books";

/** The runner's own audit rows for an entry and an event. */
async function audited(postId: string, event: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM core_audit WHERE operation = 'accounting.run' AND json_extract(input, '$.post') = ? AND json_extract(input, '$.event') = ?",
  )
    .bind(postId, event)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** The real host's answer, with the books' ref taken off the applied action (as a facet that cannot name it). */
const withoutRef = changedWrites(async (input, real) => {
  const result = await real(input);
  return { ...result, applied: result.applied.map(({ ref: _ref, ...a }) => a) };
});

/** Runs at each of `offsets` minutes after `from`, with `extra`. */
async function runsAt(from: string, offsets: number[], extra = {}) {
  for (const m of offsets) await runAt(minutes(from, m), extra);
}

describe("a write the host knows was applied", () => {
  it("is recorded with the ref that comes with the applied action, without a look-up", async () => {
    // The books' search lags: a look-up straight after would miss, so only the action's ref works.
    await books.setLookupLag(b.name, 5);
    const q = await queue(summaryEntry(b, "2026-11-20"));
    expect(await runAt(NOW)).toMatchObject({ sent: 1, unknown: 0 });
    const row = await post(q.id);
    expect(row.state).toBe("sent");
    const record = (await books.state(b.name)).records.find((r) => r.reference === q.reference);
    expect(row.books_ref).toBe(record?.ref);
    expect(await writesAt(b, q.reference)).toBe(1);
  });

  it("whose ref does not come with it is looked up while the books lag, and written once", async () => {
    await books.setLookupLag(b.name, 2);
    const q = await queue(summaryEntry(b, "2026-11-20"));
    await runAt(NOW, { integrations: withoutRef });
    expect(await post(q.id)).toMatchObject({ state: "unknown", error_code: "applied" });
    expect((await post(q.id)).applied_at).not.toBeNull();
    // 1, 6 and 36 minutes later: missed twice, then found.
    await runsAt(NOW, [1, 6, 36], { integrations: withoutRef });
    expect(await post(q.id)).toMatchObject({ state: "sent", attempts: 1 });
    expect(await writesAt(b, q.reference)).toBe(1);
  });

  it("whose reference is never found is held, never sent again, and a retry only looks again", async () => {
    await books.setLookupLag(b.name, 1000);
    const q = await queue(summaryEntry(b, "2026-11-20"));
    const told = await noticesTitled(b.admin, HELD_NOTICE);
    await runAt(NOW, { integrations: withoutRef });
    // Every look-up on the schedule misses: 1, 5, 30, 120 and 720 minutes apart.
    let at = 0;
    for (const wait of APPLIED_LOOKUP_MINUTES) {
      at += wait;
      await runAt(minutes(NOW, at), { integrations: withoutRef });
    }
    const held = await post(q.id);
    expect(held).toMatchObject({ state: "held", error_code: "not_found", attempts: 1 });
    expect(held.error_text).toContain(q.reference);
    expect(await noticesTitled(b.admin, HELD_NOTICE)).toBe(told + 1);
    // Runs and retries for a day: looked up again, never queued, never written again.
    expect(
      await op<{ state: string }>("accounting.post.retry", { id: q.id }, b.admin),
    ).toMatchObject({ state: "unknown" });
    for (let i = 1; i <= 30; i++)
      await runAt(minutes(NOW, at + i * 60), { integrations: withoutRef });
    expect((await post(q.id)).attempts).toBe(1);
    expect(await writesAt(b, q.reference)).toBe(1);
    expect(
      (await refusal(op("accounting.post.skip", { id: q.id, reason: "x" }, b.admin))).code,
    ).toBe("conflict");
    // The database refuses it too.
    await expect(
      env.DB.prepare("UPDATE core_accounting_post SET state = 'queued' WHERE id = ?")
        .bind(q.id)
        .run(),
    ).rejects.toThrow(/core_accounting_post_applied/);
  }, 120_000);
});

describe("an uncertain outcome", () => {
  it("written and the answer lost, while the books lag, is looked up and written once", async () => {
    await books.setLookupLag(b.name, 2);
    const q = await queue(summaryEntry(b, "2026-11-20"));
    await books.failNext(b.name, "postSummary", "unknown_after_write");
    await runAt(NOW);
    await runsAt(NOW, [1, 6, 36]);
    expect(await post(q.id)).toMatchObject({ state: "sent", attempts: 1 });
    expect(await writesAt(b, q.reference)).toBe(1);
    expect(await audited(q.id, "sent")).toBe(1);
  });

  it("lost every time is sent again at most three times, then held, and the admins told once", async () => {
    const q = await queue(summaryEntry(b, "2026-11-20"));
    for (let i = 0; i < 20; i++) await books.failNext(b.name, "postSummary", "unknown");
    const told = await noticesTitled(b.admin, HELD_NOTICE);
    // Every minute for three hours.
    for (let m = 0; m < 180; m++) await runAt(minutes(NOW, m));
    const row = await post(q.id);
    expect(row).toMatchObject({
      state: "held",
      error_code: "unknown_outcome",
      attempts: MAX_UNKNOWNS,
    });
    expect(row.unknowns).toBe(MAX_UNKNOWNS);
    expect(await noticesTitled(b.admin, HELD_NOTICE)).toBe(told + 1);
    // What the runner decided alone is audited: each move to unknown, and the hold.
    expect(await audited(q.id, "unknown")).toBe(MAX_UNKNOWNS);
    expect(await audited(q.id, "held")).toBe(1);
    expect(await writesAt(b, q.reference)).toBe(0);
  }, 120_000);

  it("an error with no refusal code (a configuration error) is looked up and held, never looped", async () => {
    const broken = changedWrites(async () => {
      throw new Error("ConfigError: APPROVAL_FLOOR is not a floor this host knows");
    });
    const q = await queue(summaryEntry(b, "2026-11-20"));
    for (let m = 0; m < 120; m++) await runAt(minutes(NOW, m), { integrations: broken });
    const row = await post(q.id);
    expect(row).toMatchObject({ state: "held", error_code: "error", attempts: 1 });
    expect(row.error_text).toContain("ConfigError");
    expect(await writesAt(b, q.reference)).toBe(0);
  }, 120_000);
});

describe("a call that hangs", () => {
  it("is cut off at its deadline, taken as uncertain, and its late write is found, never doubled", async () => {
    const q = await queue(summaryEntry(b, "2026-11-20"));
    await books.hangNext(b.name, 1500);
    const first = await runAt(NOW, { callDeadlineMs: 200 });
    expect(first).toMatchObject({ unknown: 1 });
    expect(await post(q.id)).toMatchObject({ state: "unknown", error_code: "timeout" });
    // The hung write lands at the books after the deadline.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await runAt(minutes(NOW, 1));
    expect(await post(q.id)).toMatchObject({ state: "sent", attempts: 1 });
    expect(await writesAt(b, q.reference)).toBe(1);
  });

  it("an outcome arriving after another run claimed the entry never lands on that claim", async () => {
    const q = await queue(summaryEntry(b, "2026-11-20"));
    await books.failNext(b.name, "postSummary", { refuse: "invalid" });
    await runAt(NOW, {
      fault: async (point) => {
        // Another run took the entry meanwhile: its claim counts the next attempt.
        if (point === "sent") {
          await env.DB.prepare(
            "UPDATE core_accounting_post SET attempts = attempts + 1 WHERE id = ?",
          )
            .bind(q.id)
            .run();
        }
      },
    });
    // The first run's refusal did not hold the second run's claim.
    expect(await post(q.id)).toMatchObject({ state: "sending", attempts: 2 });
    // The second claim, never settled, is taken as a stopped run's once stale, and sent once.
    await runAt(new Date(Date.parse(NOW) + STALE_MS + 60_000));
    for (const m of [32, 37, 67]) await runAt(minutes(NOW, m));
    expect((await post(q.id)).state).toBe("sent");
    expect(await writesAt(b, q.reference)).toBe(1);
  });
});

describe("one entry refused for hours", () => {
  it("holds up its own day, not the others, and the bookkeepers hear of it", async () => {
    const stuck = await queue(summaryEntry(b, "2026-11-20"));
    const sameDay = await queue(summaryEntry(b, "2026-11-20", { net: 300 }));
    // Another day's entry, a payout (the books refuse only summaries here).
    const otherDay = await queue(transferEntry(b, "2026-11-21"));
    for (let i = 0; i < 6; i++)
      await books.failNext(b.name, "postSummary", { refuse: "unavailable" });
    const title = "An entry has been refused by the books for over half an hour";
    const told = await noticesTitled(b.admin, title);
    // The first two tries: nothing else goes (six minutes at most).
    await runAt(NOW);
    await runAt(minutes(NOW, 1));
    expect((await post(otherDay.id)).state).toBe("queued");
    // After them, the other day goes; the same day waits behind it, in order.
    await runAt(minutes(NOW, 6));
    await runAt(minutes(NOW, 7));
    expect((await post(otherDay.id)).state).toBe("sent");
    expect((await post(sameDay.id)).state).toBe("queued");
    await runAt(minutes(NOW, 36));
    expect(await noticesTitled(b.admin, title)).toBe(told + 1);
    for (const m of [156, 876, 877]) await runAt(minutes(NOW, m));
    expect(await post(stuck.id)).toMatchObject({ state: "held", error_code: "unavailable" });
    expect((await post(sameDay.id)).state).toBe("sent");
    expect(await noticesTitled(b.admin, title)).toBe(told + 1);
    expect(await writesAt(b, stuck.reference)).toBe(0);
  });
});

describe("a person's details", () => {
  it("go to the books but are kept only in detail, which an erase can clear on a sent entry", async () => {
    const q = await queue({
      connectionId: b.connectionId,
      kind: "contact",
      sourceKind: "organisation",
      sourceId: `org${Date.now().toString(36)}`,
      belongsDate: "2026-11-20",
      amount: 0,
      body: { name: { detail: "name" }, email: { detail: "email" } },
      detail: { name: "Probe Pty Ltd", email: "probe@example.com" },
    });
    await runAt(NOW);
    const row = await post(q.id);
    expect(row.state).toBe("sent");
    const contact = (await books.state(b.name)) as unknown as {
      contacts: { reference: string | null; name: string }[];
    };
    expect(contact.contacts.find((c) => c.reference === q.reference)?.name).toBe("Probe Pty Ltd");
    expect(row.request).not.toContain("Probe Pty");
    expect(row.body).not.toContain("Probe Pty");
    expect(JSON.parse(row.request ?? "{}")).toMatchObject({ name: { detail: "name" } });
    await env.DB.prepare("UPDATE core_accounting_post SET detail = NULL WHERE id = ?")
      .bind(q.id)
      .run();
    expect((await post(q.id)).detail).toBeNull();
  });
});

describe("an entry left waiting in Approvals", () => {
  async function pendingAction(): Promise<string> {
    const set = newId("changeSet");
    const id = newId("pendingAction");
    const at = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO core_change_set (id, user_id, actor, origin, created_at, updated_at) VALUES (?, ?, 'automation', '{}', ?, ?)",
      ).bind(set, b.admin.id, at, at),
      env.DB.prepare(
        `INSERT INTO core_pending_action (id, change_set_id, operation, risk, input, reason, actor,
           user_id, origin, preview, simulated, created_at, expires_at)
         VALUES (?, ?, 'outbound', 'outbound', '{}', 'test', 'automation', ?, '{}', '[]', '{}', ?, ?)`,
      ).bind(id, set, b.admin.id, at, "2099-01-01T00:00:00.000Z"),
    ]);
    return id;
  }

  const reviewed = (actionId: string) =>
    changedWrites(async () => ({
      value: { status: "pending", id: 1, ref: null },
      pending: [{ actionId } as never],
      applied: [],
    }));

  it("is recorded as sent once a person approves it there; a retry meanwhile is refused", async () => {
    const actionId = await pendingAction();
    const q = await queue(summaryEntry(b, "2026-11-20"));
    await runAt(NOW, { integrations: reviewed(actionId) });
    expect(await post(q.id)).toMatchObject({
      state: "held",
      error_code: "pending_review",
      pending_action_id: actionId,
    });
    expect((await refusal(op("accounting.post.retry", { id: q.id }, b.admin))).code).toBe(
      "conflict",
    );
    // A person approves it: the gatekeeper writes it, the pending action is applied.
    await integrations.callAsHost?.({
      connectionId: b.connectionId,
      resource: b.resource,
      method: "postSummary",
      args: [
        {
          reference: q.reference,
          currency: "AUD",
          date: "2026-11-20",
          text: "Card sales",
          lines: [
            { account: "acc-clearing", taxRate: null, net: 1100, tax: 0, text: "Card sales" },
            {
              account: "acc-memberships",
              taxRate: "tax-gst",
              net: -1000,
              tax: -100,
              text: "Memberships",
            },
          ],
        },
      ],
      purpose: "accounting",
    });
    await env.DB.prepare("UPDATE core_pending_action SET status = 'applied' WHERE id = ?")
      .bind(actionId)
      .run();
    await runAt(minutes(NOW, 1));
    await runAt(minutes(NOW, 2));
    expect(await post(q.id)).toMatchObject({ state: "sent" });
    expect(await writesAt(b, q.reference)).toBe(1);
  });

  it("skipped, turns the pending action down with it", async () => {
    const actionId = await pendingAction();
    const q = await queue(summaryEntry(b, "2026-11-20"));
    await runAt(NOW, { integrations: reviewed(actionId) });
    await op("accounting.post.skip", { id: q.id, reason: "Entered by hand" }, b.admin);
    const action = await env.DB.prepare("SELECT status FROM core_pending_action WHERE id = ?")
      .bind(actionId)
      .first<{ status: string }>();
    expect(action?.status).toBe("rejected");
    expect((await post(q.id)).state).toBe("skipped");
  });
});

describe("a raced retry or skip", () => {
  it("only one of two at once says it happened, and only it is audited", async () => {
    const q = await queue(summaryEntry(b, "2026-11-20"));
    const outcomes = await Promise.allSettled([
      op("accounting.post.skip", { id: q.id, reason: "one" }, b.admin),
      op("accounting.post.skip", { id: q.id, reason: "two" }, b.admin),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const audits = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_audit WHERE operation = 'accounting.post.skip' AND outcome = 'ok' AND input LIKE ?",
    )
      .bind(`%${q.id}%`)
      .first<{ n: number }>();
    expect(audits?.n).toBe(1);
  });
});

describe("a change of books", () => {
  it("skips the old books' unsent entries, queues the same day for the new books, and the old ones are not work", async () => {
    const old = await queue(summaryEntry(b, "2026-11-20", { sourceId: "changeday" }));
    const otherName = `${b.name.slice(0, 30)}-two`;
    await books.reset(otherName);
    const bound = await op<{ resource: { key: string } }>(
      "connection.bindResource",
      { id: b.connectionId, url: `accounting-fake://books/${otherName}` },
      b.admin,
    );
    // The same connection with other books: refused, references are per connection.
    await op("accounting.settings.update", { enabled: false }, b.admin);
    const same = await refusal(
      op(
        "accounting.settings.update",
        { books: { connectionId: b.connectionId, resource: bound.resource.key } },
        b.admin,
      ),
    );
    expect(same.code).toBe("conflict");
    // Other books on their own connection.
    const second = await op<{ connection: { id: string } }>(
      "connection.create",
      { vendor: "accounting-fake", scope: "org" },
      b.admin,
    );
    const secondBound = await op<{ resource: { key: string } }>(
      "connection.bindResource",
      { id: second.connection.id, url: `accounting-fake://books/${otherName}` },
      b.admin,
    );
    try {
      await op(
        "accounting.settings.update",
        {
          books: { connectionId: second.connection.id, resource: secondBound.resource.key },
          enabled: true,
        },
        b.admin,
      );
      expect(await post(old.id)).toMatchObject({ state: "skipped" });
      // The old books' entries are not work (the new books' daily pass aside).
      await env.DB.prepare("UPDATE core_accounting_settings SET daily_date = '2099-12-31'").run();
      expect(await accountingDue(createCrmDb(env.DB).query, NOW)).toBe(false);
      const again = await queuePost(
        createCrmDb(env.DB).query,
        {
          ...summaryEntry(b, "2026-11-20", { sourceId: "changeday" }),
          connectionId: second.connection.id,
        },
        new Date().toISOString(),
      );
      expect(again?.id).not.toBe(old.id);
      expect(again?.reference).toBe(old.reference);
      // The new books are mapped by a person from their own lists.
      for (const row of [
        { kind: "clearing", booksRef: "acc-clearing", booksName: "Card clearing" },
        {
          kind: "category",
          hostKey: "memberships",
          booksRef: "acc-memberships",
          booksName: "Memberships",
        },
        { kind: "tax", hostKey: "gst", booksRef: "tax-gst", booksName: "GST on income" },
      ]) {
        await op("accounting.map.set", row, b.admin);
      }
      await runAt(NOW);
      expect(await books.writesOf(otherName, old.reference)).toBe(1);
      expect(await writesAt(b, old.reference)).toBe(0);
    } finally {
      await op("accounting.settings.update", { enabled: false }, b.admin);
      await op(
        "accounting.settings.update",
        { books: { connectionId: b.connectionId, resource: b.resource }, enabled: true },
        b.admin,
      );
    }
  });
});

describe("one run, with dependencies", () => {
  it("stays bounded with payments waiting on invoices", async () => {
    await clearOutbox(b);
    for (let i = 0; i < 30; i++) {
      const first = await queue(summaryEntry(b, "2026-11-20", { net: 1000 + i * 10 }));
      await queue(summaryEntry(b, "2026-11-20", { net: 2000 + i * 10, dependsOn: first.id }));
    }
    const meter = meterStatements(env.DB);
    const result = await runAccounting({
      db: createCrmDb(meter.db).query,
      integrations,
      clock: () => new Date(NOW),
    });
    expect(result.sent).toBe(25);
    // 25 sends, about half of them waiting on the one before and sent right after it: 99 on
    // 2026-11-26 (86 with no dependencies), far inside D1's 1,000 a Worker invocation.
    expect(meter.statements.length).toBeLessThanOrEqual(120);
  }, 120_000);
});
