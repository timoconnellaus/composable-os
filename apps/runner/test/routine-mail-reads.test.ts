// Routine mail (ADR 0590), the third security review of PR #267: how the mail check reads the
// marks. Each of the review's probes, as a regression test: an address an AI put on a Person is
// never made good by someone signing in or paying with it (A1, A2), nor an AI's choice of which
// address is primary (A3); every relation followed to a value is shown (B1); a series' classes are
// marked once per field (C1); an AI's given name never reaches an email (D1); approving one held
// email clears only what that email showed and its own address, and a rejection marks nothing
// (E1). Also: an erased person's orders keep no mark.
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { runMomentDateRelative } from "../src/automations/schedule.ts";
import { run, unique } from "./helpers.ts";
import {
  booked,
  CLASS,
  classType,
  create,
  DAY,
  get,
  givePass,
  klass,
  mailConnection,
  mailTo,
  mcp,
  member,
  moveClass,
  type Out,
  type Row,
  rowsFor,
  staff,
  useRoutineMail,
} from "./routine-mail-fixture.ts";

useRoutineMail();

// ---- The third review: how the mail check reads the marks (ADR 0590) ---------------------------

const markOf = async (object: string, id: string, field: string) =>
  env.DB.prepare(
    "SELECT standing FROM core_value_mark WHERE object_type = ? AND record_id = ? AND field = ?",
  )
    .bind(object, id, field)
    .first<{ standing: string }>();

/** A Person a person made, with a pass, and an address the AI then swaps in. */
async function swapped(label: string) {
  const own = `${unique(`${label}own`).toLowerCase()}@members.test`;
  const person = await run<{ id: string }>(
    "person.create",
    { givenName: "Alex", emails: [{ email: own }] },
    staff(),
  );
  await givePass(person.id);
  const attacker = `${unique(`${label}evil`).toLowerCase()}@evil.test`;
  await run("person.update", { id: person.id, emails: [{ email: attacker }] }, mcp());
  return { personId: person.id, attacker };
}

const bookFor = async (personId: string, classId?: string) =>
  run<Out>(
    "x.bookings.bookFor",
    { classId: classId ?? (await klass()), personId, paidAtDesk: true },
    staff(),
  );

describe("an address is its own (the third review, A1 and A2)", { timeout: 90_000 }, () => {
  it("A1: an address an AI put on a Person stays held after someone signs in with it", async () => {
    const { personId, attacker } = await swapped("a1");
    // The attacker signs in with it: the sign-in matches the Person by that address.
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO core_customer (id, person_id, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    )
      .bind(`cus_${unique("a1")}`, personId, attacker, now, now)
      .run();
    const out = await bookFor(personId);
    const [row] = await rowsFor(out.bookingId as string);
    expect(row).toMatchObject({ recipient: attacker, status: "waiting", routine: 0 });
    expect(row?.held_reason).toContain(`${attacker} (ai)`);
    expect(await mailTo(attacker)).toEqual([]);
  });

  it("A2: an address an AI put on a Person stays held after an order of the Person is paid from it", async () => {
    const { personId, attacker } = await swapped("a2");
    const cols = (
      await env.DB.prepare("PRAGMA table_info(core_order)").all<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>()
    ).results;
    const vals: Record<string, unknown> = {
      id: `ord_${unique("a2")}`,
      person_id: personId,
      email: attacker,
      paid: 100,
      total: 100,
      currency: "AUD",
      state: "paid",
      placed_as: "public",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
    };
    for (const c of cols) {
      if (c.notnull && c.dflt_value === null && !(c.name in vals)) vals[c.name] = 0;
    }
    const names = Object.keys(vals);
    await env.DB.prepare(
      `INSERT INTO core_order (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`,
    )
      .bind(...names.map((n) => vals[n]))
      .run();
    const out = await bookFor(personId);
    const [row] = await rowsFor(out.bookingId as string);
    expect(row).toMatchObject({ recipient: attacker, status: "waiting", routine: 0 });
    expect(row?.held_reason).toContain(`${attacker} (ai)`);
  });

  it("A3: an AI choosing which of a Person's own addresses is primary is held", async () => {
    const a = `${unique("a3a").toLowerCase()}@members.test`;
    const b = `${unique("a3b").toLowerCase()}@members.test`;
    const person = await run<{ id: string }>(
      "person.create",
      { givenName: "Casey", emails: [{ email: a, primary: true }, { email: b }] },
      staff(),
    );
    await givePass(person.id);
    await run(
      "person.update",
      { id: person.id, emails: [{ email: b, primary: true }, { email: a }] },
      mcp(),
    );
    // Both addresses keep the person's mark: the AI rewrote the list, it added nothing.
    expect(await markOf("person", person.id, `emails:${a}`)).toEqual({ standing: "person" });
    expect(await markOf("person", person.id, `emails:${b}`)).toEqual({ standing: "person" });
    const out = await bookFor(person.id);
    const [row] = await rowsFor(out.bookingId as string);
    expect(row).toMatchObject({ recipient: b, status: "waiting", routine: 0 });
    expect(row?.held_reason).toContain("which of their addresses is primary (ai)");
    // A person choosing it again makes it routine.
    await run(
      "person.update",
      { id: person.id, emails: [{ email: a }, { email: b, primary: true }] },
      staff(),
    );
    await run(
      "person.update",
      { id: person.id, emails: [{ email: a, primary: true }, { email: b }] },
      staff(),
    );
    const again = await bookFor(person.id);
    const [sent] = await rowsFor(again.bookingId as string);
    expect(sent).toMatchObject({ recipient: a, status: "sent", routine: 1 });
  });
});

describe("every relation on the way is shown (the third review, B1)", { timeout: 90_000 }, () => {
  it("B1: an AI re-pointing a class at another person-named room: the reminder is held", async () => {
    const r1 = await create("bookings.room", { name: unique("Studio One") });
    const two = unique("Studio Two");
    const r2 = await create("bookings.room", { name: two });
    const k = await klass({ room: r1 });
    const { bookingId, who } = await booked("b1-room", k);
    await run("record.update", { object: CLASS, id: k, values: { room: r2 } }, mcp());
    expect(await markOf(CLASS, k, "room")).toEqual({ standing: "ai" });
    const startsAt = Date.parse(String((await get(CLASS, k)).startsAt));
    await runMomentDateRelative(env, new Date(startsAt - 180 * 60_000));
    let reminder: Row | undefined;
    await vi.waitFor(
      async () => {
        const rows = (
          await env.DB.prepare(
            "SELECT * FROM core_routine_mail WHERE record_id = ? AND kind = 'bookings.reminder'",
          )
            .bind(bookingId)
            .all<Row>()
        ).results;
        reminder = rows.find((r) => r.status !== "ready" && r.status !== "sending");
        expect(reminder).toBeTruthy();
      },
      { timeout: 30_000, interval: 200 },
    );
    expect(reminder).toMatchObject({ status: "waiting", routine: 0 });
    expect(reminder?.held_reason).toContain(`${CLASS} ${k}'s room (ai)`);
    expect((await mailTo(who.email)).some((m) => m.text?.includes(two))).toBe(false);
  });
});

describe("what the marks cost (the third review, C1)", { timeout: 120_000 }, () => {
  it("C1: a series' classes are marked once per field, each from the series", async () => {
    const firstDate = new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10);
    const lastDate = new Date(Date.now() + 26 * DAY).toISOString().slice(0, 10);
    const series = await create("bookings.series", {
      classType,
      title: "Cost series",
      weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      time: "06:00",
      length: 60,
      places: 10,
      firstDate,
      lastDate,
      timezone: "Australia/Sydney",
    });
    const count = async () =>
      Number(
        (await env.DB.prepare("SELECT count(*) AS n FROM core_value_mark").first<{ n: number }>())
          ?.n,
      );
    const before = await count();
    await run(
      "recurring.generate",
      { object: "bookings.series", id: series },
      staff({ actor: "automation", origin: { surface: "automation" } }),
    );
    const made = await run<{ items: { id: string }[] }>(
      "record.list",
      { object: CLASS, filter: { field: "series", op: "eq", value: series }, limit: 200 },
      staff(),
    );
    expect(made.items.length).toBeGreaterThan(20);
    // One mark per field the class has, and its creation: never more.
    expect((await count()) - before).toBeLessThanOrEqual(made.items.length * 10);
    const one = made.items[0]?.id as string;
    expect(await markOf(CLASS, one, "startsAt")).toEqual({ standing: "person" });
    expect(await markOf(CLASS, one, "title")).toEqual({ standing: "person" });
    expect(await markOf(CLASS, one, "$created")).toEqual({ standing: "host" });
  });
});

describe("a name an AI changed (the third review, D1)", { timeout: 120_000 }, () => {
  it("D1: an AI's given name never reaches the email; the name it shows is a person's", async () => {
    const own = `${unique("d1").toLowerCase()}@members.test`;
    const person = await run<{ id: string }>(
      "person.create",
      { givenName: "Sam", familyName: "Lee", emails: [{ email: own }] },
      staff(),
    );
    await givePass(person.id);
    await run("person.update", { id: person.id, givenName: "Samuel Free Upgrade" }, mcp());
    expect(await markOf("person", person.id, "givenName")).toEqual({ standing: "ai" });
    await run("person.update", { id: person.id, familyName: "Leigh" }, staff());
    const out = await bookFor(person.id);
    const [row] = await rowsFor(out.bookingId as string);
    expect(row).toMatchObject({ status: "sent", routine: 1 });
    const mails = await mailTo(own);
    expect(mails.length).toBeGreaterThan(0);
    expect(mails.some((m) => `${m.subject} ${m.text}`.includes("Free Upgrade"))).toBe(false);
  });
});

describe("an approval clears only its own email (the third review, E1)", {
  timeout: 120_000,
}, () => {
  it("E1: approving a child's own email leaves the guardian's AI address held, and a rejection marks nothing", async () => {
    const kidEmail = `${unique("e1kid").toLowerCase()}@members.test`;
    const kid = await run<{ id: string }>(
      "person.create",
      { givenName: "Kid", emails: [{ email: kidEmail }] },
      staff(),
    );
    const parent = await run<{ id: string }>(
      "person.create",
      { givenName: "Parent", emails: [{ email: `${unique("e1par").toLowerCase()}@members.test` }] },
      staff(),
    );
    await run("person.link.add", { guardianId: parent.id, dependantId: kid.id }, staff());
    await givePass(kid.id);
    const attacker = `${unique("e1evil").toLowerCase()}@evil.test`;
    await run("person.update", { id: parent.id, emails: [{ email: attacker }] }, mcp());
    // Both emails are held for something they share: a title an AI wrote.
    const k = await klass();
    await run(
      "record.update",
      { object: CLASS, id: k, values: { title: unique("Strength") } },
      mcp(),
    );
    const out = await bookFor(kid.id, k);
    const rows = await rowsFor(out.bookingId as string, 2);
    const kidRow = rows.find((r) => r.recipient === kidEmail);
    const parRow = rows.find((r) => r.recipient === attacker);
    expect(kidRow?.status).toBe("waiting");
    expect(parRow?.status).toBe("waiting");
    // The child's email does not rest on the guardian's address.
    expect(kidRow?.held_reason).not.toContain(attacker);
    expect(parRow?.held_reason).toContain(`${attacker} (ai)`);
    const kidSources = JSON.parse(
      (
        await env.DB.prepare("SELECT sources FROM core_routine_mail WHERE id = ?")
          .bind(kidRow?.id)
          .first<{ sources: string }>()
      )?.sources ?? "[]",
    ) as { r: string }[];
    expect(kidSources.some((s) => s.r === parent.id)).toBe(false);
    // Gatekeeper actions are decided in order: the emails earlier tests left waiting are rejected
    // first, then whichever of these two was queued first is decided first.
    const earlier = (
      await env.DB.prepare(
        "SELECT id FROM core_pending_action WHERE status = 'pending' AND connection_id = ? AND id < ? AND id <> ? ORDER BY id",
      )
        .bind(mailConnection, String(kidRow?.pending_action_id), String(parRow?.pending_action_id))
        .all<{ id: string }>()
    ).results.map((r) => r.id);
    if (earlier.length) await run("approval.reject", { actionIds: earlier }, staff());
    const approve = () =>
      run("approval.approve", { actionIds: [kidRow?.pending_action_id] }, staff());
    const reject = () =>
      run("approval.reject", { actionIds: [parRow?.pending_action_id] }, staff());
    if (String(kidRow?.pending_action_id) < String(parRow?.pending_action_id)) {
      await approve();
      await reject();
    } else {
      await reject();
      await approve();
    }
    await vi.waitFor(async () => expect(await mailTo(kidEmail)).toHaveLength(1), {
      timeout: 30_000,
      interval: 200,
    });
    expect(await markOf("person", parent.id, `emails:${attacker}`)).toEqual({ standing: "ai" });
    expect(await markOf(CLASS, k, "title")).toEqual({ standing: "person" });
    // A person moves the class: the child is told on its own, the attacker's address waits.
    await moveClass(k, 3);
    let all: Row[] = [];
    await vi.waitFor(
      async () => {
        all = (
          await env.DB.prepare(
            "SELECT * FROM core_routine_mail WHERE record_id = ? AND kind = 'bookings.change'",
          )
            .bind(out.bookingId)
            .all<Row>()
        ).results;
        expect(all.filter((r) => r.status !== "ready" && r.status !== "sending").length).toBe(2);
      },
      { timeout: 30_000, interval: 200 },
    );
    expect(all.find((r) => r.recipient === kidEmail)).toMatchObject({ status: "sent", routine: 1 });
    expect(all.find((r) => r.recipient === attacker)).toMatchObject({
      status: "waiting",
      routine: 0,
    });
    expect(await mailTo(attacker)).toEqual([]);
  });
});

describe("erasure takes the marks of the person's orders (the third review, 6b)", {
  timeout: 60_000,
}, () => {
  it("an erased person's order keeps no mark", async () => {
    const who = await member("erase6b");
    const orderId = `ord_${unique("e6b")}`;
    const cols = (
      await env.DB.prepare("PRAGMA table_info(core_order)").all<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>()
    ).results;
    const vals: Record<string, unknown> = {
      id: orderId,
      person_id: who.personId,
      email: who.email,
      paid: 10,
      total: 10,
      currency: "AUD",
      state: "paid",
      placed_as: "customer",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
    };
    for (const c of cols) {
      if (c.notnull && c.dflt_value === null && !(c.name in vals)) vals[c.name] = 0;
    }
    const names = Object.keys(vals);
    await env.DB.prepare(
      `INSERT INTO core_order (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`,
    )
      .bind(...names.map((n) => vals[n]))
      .run();
    await env.DB.prepare(
      "INSERT INTO core_value_mark (object_type, record_id, field, value_hash, standing, by_id, at) VALUES ('order', ?, 'email', 'h', 'customer', NULL, ?)",
    )
      .bind(orderId, new Date().toISOString())
      .run();
    await run("person.erase", { id: who.personId }, staff());
    expect(await markOf("order", orderId, "email")).toBeNull();
    const left = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_value_mark WHERE record_id = ?",
    )
      .bind(who.personId)
      .first<{ n: number }>();
    expect(Number(left?.n)).toBe(0);
  });
});

describe("an address the host cannot be sure of (the fourth review, L5)", {
  timeout: 60_000,
}, () => {
  it("is kept for staff with the reason, never sent and never dropped in silence", async () => {
    const own = `${unique("l5").toLowerCase()}@members.test`;
    const person = await run<{ id: string }>(
      "person.create",
      { givenName: "Lee", emails: [{ email: own }] },
      staff(),
    );
    await givePass(person.id);
    // A trailing dot: an address the host's pattern does not take (written outside the rules).
    const odd = `${own}.`;
    await env.DB.prepare("UPDATE core_person_emails SET email = ? WHERE person_id = ?")
      .bind(odd, person.id)
      .run();
    const out = await bookFor(person.id);
    const [row] = await rowsFor(out.bookingId as string);
    // Kept, failed with the reason, in the log staff read: not sent, not dropped.
    expect(row).toMatchObject({ recipient: odd, status: "failed", routine: 0 });
    expect(row?.held_reason).toContain("the address is not one the host sends to on its own");
  });
});
