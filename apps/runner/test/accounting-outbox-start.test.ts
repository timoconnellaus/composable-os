// Stage 61 step 4 (ADR 0882), the review of PR #504: an entry held because its day is before the
// start date is never sent, nor retried, until a human admin moves the start date earlier than its
// day (possible only before anything was sent to these books); then a retry sends it. Its own
// file: the start date is fixed once an entry may be in the books.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type Books,
  books,
  connectBooks,
  minutes,
  op,
  post,
  queue,
  refusal,
  runAt,
  START,
  summaryEntry,
} from "./accounting-fixture.ts";

const NOW = "2026-11-26T03:00:00.000Z";
let b: Books;

beforeAll(async () => {
  b = await connectBooks();
  await env.DB.prepare("UPDATE core_accounting_settings SET daily_date = '2099-12-31'").run();
});

describe("a hold for the start date", () => {
  it("is retryable once the start date is moved earlier than the entry's day", async () => {
    const q = await queue(summaryEntry(b, START));
    await env.DB.prepare(
      "UPDATE core_accounting_post SET belongs_date = '2026-10-15', carries_date = '2026-10-15' WHERE id = ?",
    )
      .bind(q.id)
      .run();
    await runAt(NOW);
    expect(await post(q.id)).toMatchObject({ state: "held", error_code: "before_start" });
    expect((await refusal(op("accounting.post.retry", { id: q.id }, b.admin))).code).toBe(
      "conflict",
    );
    await op("accounting.settings.update", { startDate: "2026-10-01" }, b.admin);
    await op("accounting.post.retry", { id: q.id }, b.admin);
    await runAt(minutes(NOW, 1));
    expect(await post(q.id)).toMatchObject({ state: "sent" });
    expect(await books.writesOf(b.name, q.reference)).toBe(1);
  });
});
