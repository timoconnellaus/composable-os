// Stage 61 step 4 (ADR 0882): the outbox runner sends each entry to the books once, through the
// real integration host as the host, against the fake books. An answer lost, a run that stops
// between the books' answer and the record, two runs at once, a storm of refusals and a
// fortnight's outage each end with every entry in the books exactly once (counted at the fake),
// in order, and none lost. One run is bounded whatever the backlog.
import { env } from "cloudflare:workers";
import { LOOKUPS_PER_RUN, runAccounting, SENDS_PER_RUN, STALE_MS } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type Books,
  books,
  clearOutbox,
  connectBooks,
  integrations,
  minutes,
  post,
  queue,
  runAt,
  summaryEntry,
} from "./accounting-fixture.ts";
import { meterStatements } from "./statement-meter.ts";

const NOW = "2026-11-26T03:00:00.000Z";
let b: Books;

beforeAll(async () => {
  b = await connectBooks();
});

beforeEach(async () => {
  await clearOutbox(b);
});

/** Each reference's writes at the fake: every one must be exactly one. */
async function writes(references: string[]): Promise<number[]> {
  return Promise.all(references.map((r) => books.writesOf(b.name, r)));
}

describe("an entry sent", () => {
  it("goes once, with its mapping resolved, and keeps the call it sent", async () => {
    const q = await queue(summaryEntry(b, "2026-11-20"));
    expect(q.state).toBe("queued");
    const result = await runAt(NOW);
    expect(result).toMatchObject({ state: "ran", sent: 1, held: 0 });
    const row = await post(q.id);
    expect(row.state).toBe("sent");
    expect(row.books_ref).toMatch(/^fake-summary-/);
    const request = JSON.parse(row.request ?? "{}");
    expect(request).toMatchObject({
      reference: q.reference,
      currency: "AUD",
      date: "2026-11-20",
      lines: [
        { account: "acc-clearing", taxRate: null, net: 1100 },
        { account: "acc-memberships", taxRate: "tax-gst", net: -1000, tax: -100 },
      ],
    });
    // Queued again, and run again: nothing new anywhere.
    await queue(summaryEntry(b, "2026-11-20", { sourceId: q.reference.split(":")[2] }));
    await runAt(minutes(NOW, 1));
    expect(await writes([q.reference])).toEqual([1]);
    expect(await post(q.id)).toMatchObject({ state: "sent", attempts: 1 });
  });
});

describe("an uncertain outcome", () => {
  it("written, then the answer lost: the next run finds it by reference and never sends it again", async () => {
    const q = await queue(summaryEntry(b, "2026-11-20"));
    await books.failNext(b.name, "postSummary", "unknown_after_write");
    expect(await runAt(NOW)).toMatchObject({ unknown: 1, sent: 0 });
    expect(await post(q.id)).toMatchObject({ state: "unknown", error_code: "unknown" });
    expect(await writes([q.reference])).toEqual([1]);

    const next = await runAt(minutes(NOW, 1));
    expect(next).toMatchObject({ found: 1, requeued: 0, sent: 0 });
    const row = await post(q.id);
    expect(row).toMatchObject({ state: "sent", attempts: 1 });
    const record = (await books.state(b.name)).records.find((r) => r.reference === q.reference);
    expect(row.books_ref).toBe(record?.ref);
    expect(await writes([q.reference])).toEqual([1]);
  });

  it("lost with nothing written: looked up, not found, queued again, and only then sent", async () => {
    const q = await queue(summaryEntry(b, "2026-11-20"));
    await books.failNext(b.name, "postSummary", "unknown");
    await runAt(NOW);
    expect((await post(q.id)).state).toBe("unknown");
    expect(await writes([q.reference])).toEqual([0]);
    const next = await runAt(minutes(NOW, 1));
    // Looked up first (not found), then sent in the same run.
    expect(next).toMatchObject({ found: 0, requeued: 1, sent: 1 });
    expect(await post(q.id)).toMatchObject({ state: "sent", attempts: 2 });
    expect(await writes([q.reference])).toEqual([1]);
  });

  it("a run that stops between the books' answer and the record: resolved by reference after the claim goes stale", async () => {
    const q = await queue(summaryEntry(b, "2026-11-20"));
    const crash = await runAt(NOW, {
      fault: (point) => {
        if (point === "sent") throw new Error("the Worker stopped here");
      },
    }).catch((error: Error) => error);
    expect(String(crash)).toContain("the Worker stopped here");
    // In the books, not yet recorded: the claim stands.
    expect(await writes([q.reference])).toEqual([1]);
    expect((await post(q.id)).state).toBe("sending");

    // While the claim is fresh nothing touches it: no second send.
    await runAt(minutes(NOW, 1));
    expect((await post(q.id)).state).toBe("sending");
    expect(await writes([q.reference])).toEqual([1]);

    const later = new Date(Date.parse(NOW) + STALE_MS + 60_000);
    expect(await runAt(later)).toMatchObject({ found: 1, sent: 0 });
    const row = await post(q.id);
    expect(row.state).toBe("sent");
    expect(row.books_ref).toMatch(/^fake-summary-/);
    expect(await writes([q.reference])).toEqual([1]);
  });

  it("a run that stops after the claim, before the books: looked up, not found, sent once", async () => {
    const q = await queue(summaryEntry(b, "2026-11-20"));
    await runAt(NOW, {
      fault: (point) => {
        if (point === "claimed") throw new Error("stopped before the call");
      },
    }).catch(() => null);
    expect((await post(q.id)).state).toBe("sending");
    expect(await writes([q.reference])).toEqual([0]);
    const later = new Date(Date.parse(NOW) + STALE_MS + 60_000);
    expect(await runAt(later)).toMatchObject({ requeued: 1, sent: 1 });
    expect(await writes([q.reference])).toEqual([1]);
  });
});

describe("two runs at once", () => {
  it("claim each entry once between them: every entry is in the books exactly once", async () => {
    const queued = [];
    for (let i = 0; i < 12; i++) {
      queued.push(await queue(summaryEntry(b, `2026-11-${String(10 + i).padStart(2, "0")}`)));
    }
    const [one, two] = await Promise.all([runAt(NOW), runAt(NOW)]);
    expect((one?.sent ?? 0) + (two?.sent ?? 0)).toBe(12);
    expect(await writes(queued.map((q) => q.reference))).toEqual(queued.map(() => 1));
    for (const q of queued) expect((await post(q.id)).state).toBe("sent");
  });

  it("look an unknown entry up once between them, and send it once", async () => {
    const queued = [];
    for (let i = 0; i < 4; i++) {
      queued.push(await queue(summaryEntry(b, `2026-11-${String(10 + i).padStart(2, "0")}`)));
      await books.failNext(b.name, "postSummary", i % 2 ? "unknown" : "unknown_after_write");
    }
    await runAt(NOW);
    for (const q of queued) expect((await post(q.id)).state).toBe("unknown");
    const [one, two] = await Promise.all([runAt(minutes(NOW, 1)), runAt(minutes(NOW, 1))]);
    expect((one?.found ?? 0) + (two?.found ?? 0)).toBe(2);
    expect((one?.requeued ?? 0) + (two?.requeued ?? 0)).toBe(2);
    await runAt(minutes(NOW, 2));
    expect(await writes(queued.map((q) => q.reference))).toEqual([1, 1, 1, 1]);
    for (const q of queued) expect((await post(q.id)).state).toBe("sent");
  });
});

describe("a storm of refusals", () => {
  it("retries on the schedule, sends nothing else meanwhile, then holds; a person's retries send it once", async () => {
    const first = await queue(summaryEntry(b, "2026-11-20"));
    const second = await queue(summaryEntry(b, "2026-11-21"));
    for (let i = 0; i < 6; i++) {
      await books.failNext(b.name, "postSummary", { refuse: "rate_limited" });
    }
    // Run after run, every few seconds, for a day: the books are asked only on the schedule.
    const t0 = Date.parse(NOW);
    let at = t0;
    const tried: string[] = [];
    while (at < t0 + 16 * 3_600_000) {
      const before = (await post(first.id)).attempts;
      await runAt(new Date(at));
      if ((await post(first.id)).attempts !== before) tried.push(new Date(at).toISOString());
      if ((await post(first.id)).state === "held") break;
      // The second entry waits behind the first while it waits to retry.
      expect((await post(second.id)).state).toBe("queued");
      // Every minute for the first hour, every five to the fourth, then every fifteen.
      const elapsed = at - t0;
      at += elapsed < 3_600_000 ? 60_000 : elapsed < 4 * 3_600_000 ? 5 * 60_000 : 15 * 60_000;
    }
    const gaps = tried
      .slice(1)
      .map((t, i) => (Date.parse(t) - Date.parse(tried[i] as string)) / 60_000);
    // 1, 5 and 30 minutes, 2 and 12 hours (each gap at least the wait, at most one step more).
    expect(gaps.length).toBe(5);
    [1, 5, 30, 120, 720].forEach((wait, i) => {
      expect(gaps[i]).toBeGreaterThanOrEqual(wait);
      expect(gaps[i]).toBeLessThanOrEqual(wait + 15);
    });
    const held = await post(first.id);
    expect(held).toMatchObject({ state: "held", error_code: "rate_limited", attempts: 6 });
    expect(await writes([first.reference])).toEqual([0]);

    // Held, it holds only itself: the next run sends the other one.
    await runAt(new Date(at + 60_000));
    expect((await post(second.id)).state).toBe("sent");

    // A person presses retry again and again while runs go: one write.
    for (let i = 0; i < 5; i++) {
      await integrationsRetry(first.id).catch(() => null);
      await Promise.all([runAt(new Date(at + 120_000 + i)), runAt(new Date(at + 120_000 + i))]);
    }
    expect((await post(first.id)).state).toBe("sent");
    expect(await writes([first.reference, second.reference])).toEqual([1, 1]);
  }, 120_000);
});

async function integrationsRetry(id: string) {
  const { invokeByName } = await import("@composable-os/core");
  return invokeByName(
    "accounting.post.retry",
    { id },
    {
      actor: "human",
      user: b.admin,
      origin: { surface: "ui" },
      db: createCrmDb(env.DB),
      integrations,
    },
  );
}

describe("a fortnight's outage", () => {
  it("touches no entry while the books are down, then sends every one once, in order", async () => {
    await books.setUnavailable(b.name, true);
    const queued: { id: string; reference: string }[] = [];
    const start = Date.parse("2026-12-01T03:00:00.000Z");
    for (let day = 0; day < 14; day++) {
      const dayAt = start + day * 86_400_000;
      const date = new Date(dayAt).toISOString().slice(0, 10);
      // Each day's entries, as step 5 queues them: a summary and a second entry.
      queued.push(await queue(summaryEntry(b, date), new Date(dayAt).toISOString()));
      queued.push(
        await queue(summaryEntry(b, date, { net: 500 }), new Date(dayAt + 1).toISOString()),
      );
      for (let run = 0; run < 4; run++) {
        const result = await runAt(new Date(start + day * 86_400_000 + run * 6 * 3_600_000));
        expect(result.state).toBe("unavailable");
      }
    }
    for (const q of queued) {
      expect(await post(q.id)).toMatchObject({ state: "queued", attempts: 0 });
    }
    expect(await writes(queued.map((q) => q.reference))).toEqual(queued.map(() => 0));

    await books.setUnavailable(b.name, false);
    let at = start + 14 * 86_400_000;
    for (let i = 0; i < 5; i++, at += 60_000) await runAt(new Date(at));
    for (const q of queued) expect((await post(q.id)).state).toBe("sent");
    expect(await writes(queued.map((q) => q.reference))).toEqual(queued.map(() => 1));
    // In the books in the order they were queued: by day, then as queued.
    const order = (await books.state(b.name)).records
      .filter((r) => r.kind === "summary")
      .map((r) => r.reference);
    expect(order).toEqual(queued.map((q) => q.reference));
  }, 120_000);
});

describe("one run", () => {
  async function measure(backlog: number, state: "queued" | "unknown" = "queued") {
    await clearOutbox(b);
    const queued = [];
    for (let i = 0; i < backlog; i++) {
      queued.push(await queue(summaryEntry(b, "2026-11-20", { net: 1000 + i * 10 })));
    }
    if (state === "unknown") {
      // A backlog of answers lost (none of them in the books): each is looked up first.
      await env.DB.prepare(
        "UPDATE core_accounting_post SET state = 'unknown' WHERE state = 'queued'",
      ).run();
    }
    const meter = meterStatements(env.DB);
    const result = await runAccounting({
      db: createCrmDb(meter.db).query,
      integrations,
      clock: () => new Date(NOW),
    });
    return { result, statements: meter.statements.length, rowsWritten: meter.rowsWritten };
  }

  it(`sends at most ${SENDS_PER_RUN} entries in a bounded number of statements, whatever the backlog`, async () => {
    const small = await measure(SENDS_PER_RUN + 5);
    const large = await measure(SENDS_PER_RUN * 8);
    expect(small.result).toMatchObject({ sent: SENDS_PER_RUN, more: true });
    expect(large.result).toMatchObject({ sent: SENDS_PER_RUN, more: true });
    // The same statements for 30 entries on file as for 200: the backlog adds none.
    expect(large.statements).toBe(small.statements);
    // Three statements an entry and about a dozen a run: 86 on 2026-11-26, far inside D1's 1,000
    // a Worker invocation (a run of look-ups adds two or three each, at most 25 of them).
    expect(small.statements).toBeLessThanOrEqual(100);
  }, 120_000);

  it(`looks up at most ${LOOKUPS_PER_RUN} entries of unknown outcome, whatever the backlog`, async () => {
    const small = await measure(LOOKUPS_PER_RUN + 5, "unknown");
    const large = await measure(LOOKUPS_PER_RUN * 4, "unknown");
    expect(small.result).toMatchObject({ requeued: LOOKUPS_PER_RUN, more: true });
    expect(large.result).toMatchObject({ requeued: LOOKUPS_PER_RUN, more: true });
    expect(large.statements).toBe(small.statements);
    expect(small.statements).toBeLessThanOrEqual(200);
  }, 120_000);
});
