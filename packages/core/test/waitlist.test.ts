// Stage 31a step 5 (ADR 0520), on a fixture class and booking: a waitlist on a capacity
// claimant. A booking may wait only while its class is full and before the cut-off (2 hours before
// the class here); a place given back before the cut-off goes to the waitlist in the same batch, as
// a hold nobody booking directly can take; the minute cron's step promotes the first waiter from a
// current read, or gives the hold back when nobody waits or the cut-off has come; after the
// cut-off a freed place goes to whoever books first. The races: 50 at once into a class of 12, and
// a cancel, a direct booking and two promotions at once, leave the class at its places with no
// place lost. Spending at promotion and passing a waiter over are proved on the real packs
// (apps/runner/test/bookings-waitlist.test.ts). Every clock is injected.
import { env } from "cloudflare:workers";
import { validateManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ActingUser,
  coreRegistry,
  createInvoker,
  createRecord,
  createRegistry,
  defineOperation,
  invoke,
  requireExtensionObject,
  runWaitlistDue,
  updateRecord,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, refusal as refused, unique } from "./helpers.ts";

const ext = extId("wl");
const KLASS = `${ext}.klass`;
const BOOKING = `${ext}.booking`;

const STATES = ["booked", "waiting", "cancelled", "left", "attended"];

const fixture = (id: string) =>
  manifest(id, {
    objects: {
      klass: {
        label: "Class",
        plural: "Classes",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          startsAt: { type: "datetime", label: "Starts at" },
          places: { type: "number", label: "Places" },
          promoMinutes: { type: "number", label: "Waitlist stops (minutes before)" },
        },
        capacity: { places: "places" },
      },
      booking: {
        label: "Booking",
        plural: "Bookings",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          klass: { type: "relation", label: "Class", to: `${id}.klass` },
          person: { type: "relation", label: "Person", to: "person" },
          state: {
            type: "select",
            label: "State",
            options: STATES.map((value) => ({ value, label: value })),
          },
          promotedAt: { type: "datetime", label: "Promoted", readOnly: true },
          passedOverAt: { type: "datetime", label: "Passed over", readOnly: true },
          passedOverReason: { type: "text", label: "Why", readOnly: true },
        },
        states: {
          field: "state",
          initial: "booked",
          create: { in: { waiting: ["staff", "customer"] } },
          moves: [
            { from: "waiting", to: "booked", by: ["host"] },
            { from: "waiting", to: "left", by: ["staff", "customer"], final: true },
            { from: "booked", to: "cancelled", by: ["staff", "customer"], final: true },
            { from: "booked", to: "attended", by: ["staff"] },
          ],
        },
        claims: {
          on: "klass",
          confirmed: ["booked", "attended"],
          waitlist: {
            state: "waiting",
            promote: "booked",
            until: { at: "klass.startsAt", minutesBefore: "klass.promoMinutes" },
            promotedAt: "promotedAt",
            passedOverAt: "passedOverAt",
            passedOverReason: "passedOverReason",
          },
        },
        unique: [{ fields: ["person", "klass"], states: ["booked", "waiting", "attended"] }],
      },
    },
  });

let admin: ActingUser;
const at = (now: string) => context(admin, { clock: () => new Date(now) });
// The class starts at 08:00 UTC on 10 March; promotion stops two hours before.
const STARTS = "2026-03-10T08:00:00.000Z";
const NOW = "2026-03-05T00:00:00.000Z";
const LATE = "2026-03-10T06:30:00.000Z";
const tick = (now: string) => runWaitlistDue(db, { clock: () => new Date(now) });

async function person(label: string): Promise<string> {
  const tag = unique(label);
  const created = await invoke(
    "person.create",
    { givenName: tag, emails: [{ email: `${tag}@waitlist.example` }] },
    context(admin),
  );
  return created.id as string;
}

async function klass(places: number) {
  const created = await invoke(
    "record.create",
    {
      object: KLASS,
      values: { name: unique("Class"), startsAt: STARTS, places, promoMinutes: 120 },
    },
    at(NOW),
  );
  return created.id as string;
}

async function book(k: string, state: "booked" | "waiting" = "booked", now = NOW) {
  const created = await invoke(
    "record.create",
    { object: BOOKING, values: { klass: k, person: await person("p"), state } },
    at(now),
  );
  return created.id as string;
}

const move = (id: string, state: string, now = NOW) =>
  invoke("record.update", { object: BOOKING, id, values: { state } }, at(now));

async function counter(id: string) {
  return env.DB.prepare(
    "SELECT places, held, taken FROM core_capacity WHERE object_type = ? AND record_id = ?",
  )
    .bind(KLASS, id)
    .first();
}

async function holds(k: string) {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM core_capacity_claim WHERE object_type = ? AND record_id = ? AND for_type = 'waitlist' AND state = 'held'",
  )
    .bind(KLASS, k)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function values(id: string) {
  const record = await invoke("record.get", { object: BOOKING, id }, context(admin));
  return record.values as Record<string, unknown>;
}

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(fixture(ext));
}, 60_000);

describe("the declaration", () => {
  it("passes the contract, and its mistakes are named", () => {
    expect(validateManifest(fixture("okwl")).issues).toEqual([]);
    const broken = fixture("badwl");
    const booking = (broken.objects as Record<string, Record<string, unknown>>).booking as {
      claims: { waitlist: Record<string, unknown> };
      states: { moves: { from: string; to: string; by: string[] }[] };
      fields: Record<string, Record<string, unknown>>;
    };
    booking.claims.waitlist.state = "booked";
    booking.claims.waitlist.promote = "cancelled";
    booking.claims.waitlist.until = { at: "klass.name" };
    booking.fields.promotedAt = { type: "datetime", label: "Promoted" };
    const paths = validateManifest(broken).issues.map((i) => `${i.path}: ${i.message}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        expect.stringContaining("claims.waitlist.state"),
        expect.stringContaining("claims.waitlist.promote"),
        expect.stringContaining("claims.waitlist.until.at"),
        expect.stringContaining("claims.waitlist.promotedAt"),
      ]),
    );
    // A customer moving their own waiting record in needs the booking's window.
    const ahead = fixture("aheadwl");
    const moves = (ahead.objects as Record<string, { states: { moves: { by: string[] }[] } }>)
      .booking?.states.moves as { by: string[] }[];
    (moves[0] as { by: string[] }).by = ["host", "customer"];
    expect(
      validateManifest(ahead)
        .issues.map((i) => i.message)
        .join("\n"),
    ).toContain("needs a window");
  });
});

describe("joining", () => {
  it("only while the class is full, and spends and holds nothing", async () => {
    const k = await klass(2);
    const early = await refused(book(k, "waiting"));
    expect(early.details).toMatchObject({ rule: "waitlist", reason: "not_full" });
    await book(k);
    await book(k);
    const w = await book(k, "waiting");
    expect((await values(w)).state).toBe("waiting");
    expect(await counter(k)).toEqual({ places: 2, held: 0, taken: 2 });
    const at = await invoke("waitlist.position", { object: BOOKING, id: w }, context(admin));
    expect(at).toEqual({ position: 1, waiting: 1 });
  });

  it("not once the cut-off has come", async () => {
    const k = await klass(1);
    await book(k);
    const late = await refused(book(k, "waiting", LATE));
    expect(late.details).toMatchObject({ rule: "waitlist", reason: "closed" });
  });
});

describe("a place given back before the cut-off", () => {
  it("is the waitlist's: nobody booking directly takes it; the first waiter is moved in", async () => {
    const k = await klass(2);
    const a = await book(k);
    await book(k);
    const w1 = await book(k, "waiting");
    const w2 = await book(k, "waiting");
    await move(a, "cancelled");
    expect(await counter(k)).toEqual({ places: 2, held: 1, taken: 1 });
    expect(await holds(k)).toBe(1);
    // Someone booking directly finds the class full.
    const direct = await refused(book(k));
    expect(direct.details).toMatchObject({ rule: "capacity" });

    const result = await tick(NOW);
    expect(result.promoted).toBeGreaterThanOrEqual(1);
    expect(await values(w1)).toMatchObject({ state: "booked", promotedAt: NOW });
    expect((await values(w2)).state).toBe("waiting");
    expect(await counter(k)).toEqual({ places: 2, held: 0, taken: 2 });
    expect(await holds(k)).toBe(0);
    expect(await invoke("waitlist.position", { object: BOOKING, id: w2 }, context(admin))).toEqual({
      position: 1,
      waiting: 1,
    });
  });

  it("goes back to everyone when the last waiter leaves", async () => {
    const k = await klass(1);
    const a = await book(k);
    const w = await book(k, "waiting");
    await move(a, "cancelled");
    expect(await counter(k)).toEqual({ places: 1, held: 1, taken: 0 });
    await move(w, "left");
    expect(await counter(k)).toEqual({ places: 1, held: 0, taken: 0 });
    expect(await holds(k)).toBe(0);
    await book(k);
  });

  it("with nobody waiting is free at once", async () => {
    const k = await klass(1);
    const a = await book(k);
    await move(a, "cancelled");
    expect(await counter(k)).toEqual({ places: 1, held: 0, taken: 0 });
  });

  it("held when the cut-off comes is given back to everyone; the waiter stays waiting", async () => {
    const k = await klass(1);
    const a = await book(k);
    const w = await book(k, "waiting");
    await move(a, "cancelled");
    expect(await holds(k)).toBe(1);
    await tick(LATE);
    expect(await holds(k)).toBe(0);
    expect(await counter(k)).toEqual({ places: 1, held: 0, taken: 0 });
    expect((await values(w)).state).toBe("waiting");
    // First to book gets it.
    await book(k, "booked", LATE);
  });
});

describe("a place given back after the cut-off", () => {
  it("goes to whoever books first", async () => {
    const k = await klass(1);
    const a = await book(k);
    const w = await book(k, "waiting");
    await move(a, "cancelled", LATE);
    expect(await counter(k)).toEqual({ places: 1, held: 0, taken: 0 });
    expect(await holds(k)).toBe(0);
    await tick(LATE);
    expect((await values(w)).state).toBe("waiting");
    await book(k, "booked", LATE);
    expect(await counter(k)).toEqual({ places: 1, held: 0, taken: 1 });
  });
});

describe("races", () => {
  it("50 at once into a class of 12: exactly 12 booked and 38 waiting", async () => {
    const k = await klass(12);
    const people = await Promise.all(Array.from({ length: 50 }, () => person("r")));
    const outcomes = await Promise.all(
      people.map(async (p) => {
        try {
          await invoke(
            "record.create",
            { object: BOOKING, values: { klass: k, person: p, state: "booked" } },
            at(NOW),
          );
          return "booked";
        } catch {
          await invoke(
            "record.create",
            { object: BOOKING, values: { klass: k, person: p, state: "waiting" } },
            at(NOW),
          );
          return "waiting";
        }
      }),
    );
    expect(outcomes.filter((o) => o === "booked")).toHaveLength(12);
    expect(outcomes.filter((o) => o === "waiting")).toHaveLength(38);
    expect(await counter(k)).toEqual({ places: 12, held: 0, taken: 12 });
  });

  it("a cancel, a direct booking and two promotions at once: the class at its places, no place lost", async () => {
    for (let round = 0; round < 4; round++) {
      const k = await klass(3);
      const first = await book(k);
      await book(k);
      await book(k);
      const w = await book(k, "waiting");
      const outsider = await person("x");
      const settled = await Promise.allSettled([
        move(first, "cancelled"),
        invoke(
          "record.create",
          { object: BOOKING, values: { klass: k, person: outsider, state: "booked" } },
          at(NOW),
        ),
        tick(NOW),
        tick(NOW),
      ]);
      expect(settled[0].status).toBe("fulfilled");
      // Whatever the order, one more tick settles it: the waiter has the place, never the outsider.
      await tick(NOW);
      expect(await counter(k)).toEqual({ places: 3, held: 0, taken: 3 });
      expect((await values(w)).state).toBe("booked");
      expect(settled[1].status).toBe("rejected");
      expect(await holds(k)).toBe(0);
    }
  });

  it("two promotions of one waiter at once: one moves them in, the other finds nothing", async () => {
    const k = await klass(1);
    const a = await book(k);
    const w = await book(k, "waiting");
    await move(a, "cancelled");
    const sys = context(admin, {
      clock: () => new Date(NOW),
      actor: "automation",
      origin: { surface: "system", automationId: "system.waitlist" },
    });
    const [one, two] = await Promise.allSettled([
      invoke("waitlist.promote", { object: BOOKING, id: w, on: k }, sys),
      invoke("waitlist.promote", { object: BOOKING, id: w, on: k }, sys),
    ]);
    expect([one.status, two.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(await counter(k)).toEqual({ places: 1, held: 0, taken: 1 });
  });
});

describe("who may move the waitlist", () => {
  it("promote, pass over and release are the host's (the minute cron), never a person's or a pack's", async () => {
    const k = await klass(1);
    const a = await book(k);
    const w = await book(k, "waiting");
    await move(a, "cancelled");
    const person = await refused(
      invoke("waitlist.promote", { object: BOOKING, id: w, on: k }, context(admin)),
    );
    expect(person.code).toBe("forbidden");
    // A pack's automation runs as the automation actor too, from its own origin: refused.
    const pack = context(admin, {
      actor: "automation",
      origin: { surface: "automation", automationId: "x.pack.jump", extensionId: ext },
    });
    for (const [name, input] of [
      ["waitlist.promote", { object: BOOKING, id: w, on: k }],
      ["waitlist.passOver", { object: BOOKING, id: w, on: k, reason: "nope" }],
      ["waitlist.release", { object: BOOKING, on: k, before: LATE }],
    ] as const) {
      const out = await refused(invoke(name, input, pack));
      expect(out.code).toBe("forbidden");
    }
    expect((await values(w)).state).toBe("waiting");
    expect(await holds(k)).toBe(1);
  });
});

// A place given back and a join planned from the same read, in one batch: what a cancel and a
// join a moment apart would do, with the join's read before the cancel commits.
const cancelThenJoin = defineOperation({
  name: "fixture.cancelThenJoin",
  description: "Test fixture: cancels a booking, then joins the class's waitlist, in one batch.",
  input: z.object({ cancel: z.string(), klass: z.string(), person: z.string() }),
  output: z.object({ ok: z.boolean() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const booking = requireExtensionObject(BOOKING);
    await updateRecord(ctx, booking, input.cancel, { state: "cancelled" });
    await createRecord(ctx, booking, {
      klass: input.klass,
      person: input.person,
      state: "waiting",
    });
    return { ok: true };
  },
});
const fixtures = createInvoker(createRegistry([...coreRegistry.list(), cancelThenJoin]));

describe("review findings (PR #248)", () => {
  it("a join whose class came free before it commits is refused by the database (the full guard)", async () => {
    const k = await klass(1);
    const a = await book(k);
    const out = await refused(
      fixtures.invoke(
        "fixture.cancelThenJoin",
        { cancel: a, klass: k, person: await person("late") },
        at(NOW),
      ),
    );
    expect(out.details).toMatchObject({ rule: "waitlist", reason: "not_full" });
    // Nothing of the batch applied: a is still booked, and nobody waits.
    expect((await values(a)).state).toBe("booked");
    expect(await counter(k)).toEqual({ places: 1, held: 0, taken: 1 });
  });

  it("finding 1: under an approval floor the host step still promotes; a deny is counted, never silent", async () => {
    // A class far ahead: the approved action runs on the real clock.
    const k = (
      await invoke(
        "record.create",
        {
          object: KLASS,
          values: {
            name: unique("Ahead"),
            startsAt: "2099-03-10T08:00:00.000Z",
            places: 1,
            promoMinutes: 120,
          },
        },
        at(NOW),
      )
    ).id as string;
    const a = await book(k);
    const w = await book(k, "waiting");
    await move(a, "cancelled");
    // A deploy floor that sends every automation write to a person: the host's own step is not
    // queued (a queued system step could never be applied), so the waiter is moved in.
    const floor = { automation: { write: "review" as const } };
    await runWaitlistDue(db, { floor });
    expect((await values(w)).state).toBe("booked");
    expect(await counter(k)).toEqual({ places: 1, held: 0, taken: 1 });
    const queued = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_pending_action WHERE operation LIKE 'waitlist.%' AND json_extract(input, '$.on') = ?",
    )
      .bind(k)
      .first<{ n: number }>();
    expect(queued?.n).toBe(0);
    // A deny still applies, and is not silent: counted as a failure, the hold kept for the waiter.
    const k2 = (
      await invoke(
        "record.create",
        {
          object: KLASS,
          values: {
            name: unique("Denied"),
            startsAt: "2099-03-10T08:00:00.000Z",
            places: 1,
            promoMinutes: 120,
          },
        },
        at(NOW),
      )
    ).id as string;
    const a2 = await book(k2);
    const w2 = await book(k2, "waiting");
    await move(a2, "cancelled");
    const denied = await runWaitlistDue(db, { floor: { automation: { write: "deny" } } });
    expect(denied.failed).toBeGreaterThanOrEqual(1);
    expect((await values(w2)).state).toBe("waiting");
  });

  it("finding 2: erasing a booked Person hands their place to the waitlist; their kept booking hands on nothing later", async () => {
    const k = await klass(2);
    const erased = await person("gone");
    const a = (
      await invoke(
        "record.create",
        { object: BOOKING, values: { klass: k, person: erased, state: "booked" } },
        at(NOW),
      )
    ).id as string;
    await book(k);
    const w = await book(k, "waiting");
    await invoke("person.erase", { id: erased }, at(NOW));
    // The place is the waitlist's: a direct booking finds the class full.
    expect(await counter(k)).toEqual({ places: 2, held: 1, taken: 1 });
    expect(await holds(k)).toBe(1);
    expect((await refused(book(k))).details).toMatchObject({ rule: "capacity" });
    // The erased Person's booking is kept, anonymous, holding nothing: cancelling it later gives
    // nothing back and hands nothing on (the class full of holds does not refuse it either).
    await move(a, "cancelled");
    expect(await counter(k)).toEqual({ places: 2, held: 1, taken: 1 });
    expect(await holds(k)).toBe(1);
    await tick(NOW);
    expect((await values(w)).state).toBe("booked");
    expect(await counter(k)).toEqual({ places: 2, held: 0, taken: 2 });
  });

  it("round two, finding 1: erasing a waiter's Person takes them out of the queue; nobody is promoted for no one", async () => {
    const k = await klass(1);
    const a = await book(k);
    const erased = await person("waiter-gone");
    const w1 = (
      await invoke(
        "record.create",
        { object: BOOKING, values: { klass: k, person: erased, state: "waiting" } },
        at(NOW),
      )
    ).id as string;
    const w2 = await book(k, "waiting");
    expect(await invoke("waitlist.position", { object: BOOKING, id: w2 }, context(admin))).toEqual({
      position: 2,
      waiting: 2,
    });
    await invoke("person.erase", { id: erased }, at(NOW));
    // The erased waiter's record is gone (its relation is optional here: deleted all the same).
    const gone = await env.DB.prepare(
      `SELECT count(*) AS n FROM core_capacity_claim WHERE for_type = ? AND for_id = ?`,
    )
      .bind(BOOKING, w1)
      .first<{ n: number }>();
    expect(gone?.n).toBe(0);
    await expect(
      invoke("record.get", { object: BOOKING, id: w1 }, context(admin)),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await invoke("waitlist.position", { object: BOOKING, id: w2 }, context(admin))).toEqual({
      position: 1,
      waiting: 1,
    });
    // The next place goes to the next waiter, not to a record of no one.
    await move(a, "cancelled");
    await tick(NOW);
    expect((await values(w2)).state).toBe("booked");
    expect(await counter(k)).toEqual({ places: 1, held: 0, taken: 1 });
  });

  it("round two: the last waiter erased gives the waitlist's holds back at once", async () => {
    const k = await klass(1);
    const a = await book(k);
    const erased = await person("last-gone");
    await invoke(
      "record.create",
      { object: BOOKING, values: { klass: k, person: erased, state: "waiting" } },
      at(NOW),
    );
    await move(a, "cancelled");
    expect(await counter(k)).toEqual({ places: 1, held: 1, taken: 0 });
    await invoke("person.erase", { id: erased }, at(NOW));
    expect(await counter(k)).toEqual({ places: 1, held: 0, taken: 0 });
    expect(await holds(k)).toBe(0);
  });

  it("finding 3: a waiting booking cannot be pointed at another class", async () => {
    const full = await klass(1);
    await book(full);
    const w = await book(full, "waiting");
    const free = await klass(5);
    const out = await refused(
      invoke("record.update", { object: BOOKING, id: w, values: { klass: free } }, at(NOW)),
    );
    expect(out.details).toMatchObject({ rule: "claim_relation_kept" });
    expect((await values(w)).klass).toBe(full);
  });

  it("finding 4: holds of an object that no longer declares a waitlist are given back", async () => {
    const k = await klass(2);
    await book(k);
    // A hold the sweep cannot promote into: its claimant object (here the class) has no waitlist,
    // as after a waitlist is dropped between the reconciler's read and its write.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE core_capacity SET held = held + 1 WHERE object_type = ? AND record_id = ?",
      ).bind(KLASS, k),
      env.DB.prepare(
        "INSERT INTO core_capacity_claim (id, object_type, record_id, quantity, state, for_type, for_id, created_at, updated_at) VALUES (?, ?, ?, 1, 'held', 'waitlist', ?, ?, ?)",
      ).bind(`clm_${unique("orphan")}`, KLASS, k, KLASS, NOW, NOW),
    ]);
    expect(await counter(k)).toEqual({ places: 2, held: 1, taken: 1 });
    const result = await tick(NOW);
    expect(result.released).toBeGreaterThanOrEqual(1);
    expect((await counter(k))?.held).toBe(0);
  });
});
