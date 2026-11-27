// Stage 61 step 4 (ADR 0882), decision 4: for the first fourteen approved days a person approves
// each day's entries before any of them goes to the books; a day nobody approved does not count;
// after the fourteenth, entries go on their own and the admins are told once. What a person must
// do stays a person's: no assistant, MCP client, automation or extension approves a day, retries
// or skips an entry, changes the start date or approval, maps, or reaches the books, under the
// balanced or the autonomous preset. Through the real integration host, against the fake books.
import { env } from "cloudflare:workers";
import { ACCOUNTING_HOST_ONLY, type ActingUser } from "@composable-os/core";
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
  summaryEntry,
} from "./accounting-fixture.ts";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin } from "./helpers.ts";

const NOW = "2026-11-26T03:00:00.000Z";
const day = (n: number) => `2026-11-${String(n).padStart(2, "0")}`;
let b: Books;
let member: ActingUser;
let granted: ActingUser;
/** Each day's entries, queued while approval is on. */
const entries = new Map<number, { id: string; reference: string }[]>();

async function approvedDays(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT approved_days FROM core_accounting_settings WHERE id = 1",
  ).first<{ approved_days: number }>();
  return row?.approved_days ?? -1;
}

async function automaticNotices(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM core_notifications WHERE user_id = ? AND title = 'Entries now go to the books without approval'",
  )
    .bind(b.admin.id)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeAll(async () => {
  b = await connectBooks({ approved: false });
  await env.DB.prepare("UPDATE core_accounting_settings SET daily_date = '2099-12-31'").run();
  member = await createAdmin();
  await env.DB.prepare("UPDATE core_user SET role = 'member' WHERE id = ?").bind(member.id).run();
  member = { ...member, role: "member" };
  granted = await createAdmin();
  await env.DB.prepare("UPDATE core_user SET role = 'member' WHERE id = ?").bind(granted.id).run();
  granted = { ...granted, role: "member" };
  await op("user.setPermissions", { id: granted.id, permissions: ["accounting:manage"] }, b.admin);
  for (let n = 1; n <= 16; n++) {
    entries.set(n, [
      await queue(summaryEntry(b, day(n))),
      await queue(summaryEntry(b, day(n), { net: 400 })),
    ]);
  }
});

describe("while approval is on", () => {
  it("nothing goes to the books until a person approves the day", async () => {
    for (const list of entries.values()) {
      for (const e of list) expect((await post(e.id)).state).toBe("awaiting_approval");
    }
    await runAt(NOW);
    await runAt(minutes(NOW, 1));
    for (const list of entries.values()) {
      for (const e of list) {
        expect((await post(e.id)).state).toBe("awaiting_approval");
        expect(await books.writesOf(b.name, e.reference)).toBe(0);
      }
    }
  });

  it("no assistant, MCP client, automation or extension approves, retries, skips, maps or moves the start, under either preset", async () => {
    const [first] = entries.get(1) ?? [];
    try {
      for (const preset of ["balanced", "autonomous"] as const) {
        await setPreset(preset);
        for (const actor of ["assistant", "mcp", "automation", "extension"] as const) {
          const calls: [string, unknown][] = [
            ["accounting.approveDay", { day: day(1) }],
            ["accounting.post.retry", { id: first?.id }],
            ["accounting.post.skip", { id: first?.id, reason: "not mine to skip" }],
            ["accounting.settings.update", { startDate: "2026-10-01" }],
            ["accounting.settings.update", { restartApproval: true }],
            ["accounting.settings.update", { approveUntil: 14, enabled: false }],
            [
              "accounting.map.set",
              { kind: "clearing", booksRef: "acc-bank", booksName: "Business account" },
            ],
          ];
          for (const [name, input] of calls) {
            const refused = await refusal(op(name, input, b.admin, actor));
            // Refused outright, never queued for someone's approval in its name.
            expect(refused.code, `${preset} ${actor} ${name}`).toBe("forbidden");
          }
          // And the books themselves only through the host (ADR 0881).
          const call = await refusal(
            op(
              "integration.call",
              {
                connectionId: b.connectionId,
                resource: b.resource,
                method: "postSummary",
                args: [{ reference: first?.reference }],
              },
              b.admin,
              actor,
            ),
          );
          expect(call.code).toBe("forbidden");
          if (actor !== "extension") {
            expect(call.details).toMatchObject({ rule: ACCOUNTING_HOST_ONLY });
          }
        }
      }
    } finally {
      await setPreset("balanced");
    }
    expect(await approvedDays()).toBe(0);
    expect((await post(first?.id as string)).state).toBe("awaiting_approval");
    const settings = await env.DB.prepare(
      "SELECT start_date, enabled FROM core_accounting_settings",
    ).first<{ start_date: string; enabled: number }>();
    expect(settings).toMatchObject({ start_date: "2026-11-01", enabled: 1 });
    await runAt(minutes(NOW, 2));
    expect(await books.writesOf(b.name, first?.reference as string)).toBe(0);
  });

  it("a member without accounting:manage is refused; a person granted it approves", async () => {
    expect((await refusal(op("accounting.approveDay", { day: day(1) }, member))).code).toBe(
      "forbidden",
    );
    const [kept, left] = entries.get(1) ?? [];
    // One entry is left out first, with why; the rest of the day goes.
    await op("accounting.post.skip", { id: left?.id, reason: "Entered by hand" }, granted);
    const approved = await op<{ approved: number; approvedDays: number; automatic: boolean }>(
      "accounting.approveDay",
      { day: day(1) },
      granted,
    );
    expect(approved).toMatchObject({ approved: 1, approvedDays: 1, automatic: false });
    await runAt(minutes(NOW, 3));
    expect(await post(kept?.id as string)).toMatchObject({ state: "sent" });
    expect((await post(left?.id as string)).state).toBe("skipped");
    expect(await books.writesOf(b.name, left?.reference as string)).toBe(0);
    // Its other days still wait.
    expect((await post(entries.get(2)?.[0]?.id as string)).state).toBe("awaiting_approval");
  });

  it("a day counts once, however often it is approved", async () => {
    expect((await refusal(op("accounting.approveDay", { day: day(1) }, b.admin))).code).toBe(
      "conflict",
    );
    // A late entry for an approved day waits for that day's approval again, which does not count.
    const late = await queue(summaryEntry(b, day(1), { net: 300 }));
    expect((await post(late.id)).state).toBe("awaiting_approval");
    await op("accounting.approveDay", { day: day(1) }, b.admin);
    expect(await approvedDays()).toBe(1);
  });
});

describe("after the fourteenth approved day", () => {
  it("a day nobody approved does not count; the fourteenth ends approval and the admins are told once", async () => {
    // Days 2 to 13 approved (13 in all); day 14 is not.
    for (let n = 2; n <= 13; n++) await op("accounting.approveDay", { day: day(n) }, b.admin);
    expect(await approvedDays()).toBe(13);
    const before = await queue(summaryEntry(b, day(20)));
    expect((await post(before.id)).state).toBe("awaiting_approval");
    expect(await automaticNotices()).toBe(0);

    const fourteenth = await op<{ automatic: boolean; approvedDays: number }>(
      "accounting.approveDay",
      { day: day(15) },
      b.admin,
    );
    expect(fourteenth).toMatchObject({ approvedDays: 14, automatic: true });
    for (let i = 0; i < 3; i++) await runAt(minutes(NOW, 10 + i));
    expect(await automaticNotices()).toBe(1);

    // From now on an entry goes without approval.
    const after = await queue(summaryEntry(b, day(21)));
    expect((await post(after.id)).state).toBe("queued");
    await runAt(minutes(NOW, 20));
    expect(await post(after.id)).toMatchObject({ state: "sent" });
    // What was put for a person's approval stays a person's: never sent unchecked.
    for (const e of entries.get(14) ?? []) {
      expect((await post(e.id)).state).toBe("awaiting_approval");
      expect(await books.writesOf(b.name, e.reference)).toBe(0);
    }
    expect((await post(before.id)).state).toBe("awaiting_approval");
  });

  it("a human admin puts approval back on: entries wait again, and the admins are told again when it ends", async () => {
    await op("accounting.settings.update", { restartApproval: true }, b.admin);
    expect(await approvedDays()).toBe(0);
    const again = await queue(summaryEntry(b, day(22)));
    expect((await post(again.id)).state).toBe("awaiting_approval");
    await runAt(minutes(NOW, 30));
    expect(await books.writesOf(b.name, again.reference)).toBe(0);
    await env.DB.prepare("UPDATE core_accounting_settings SET approved_days = approve_until").run();
    await runAt(minutes(NOW, 31));
    expect(await automaticNotices()).toBe(2);
  });
});
