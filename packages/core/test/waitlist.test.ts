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
import { type ActingUser, invoke, runWaitlistDue } from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";

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

async function refused(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).not.toBeNull();
  return error as { code: string; details: Record<string, unknown>; message: string };
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
    // Nobody moves themselves ahead of the waitlist.
    const ahead = fixture("aheadwl");
    const moves = (ahead.objects as Record<string, { states: { moves: { by: string[] }[] } }>)
      .booking?.states.moves as { by: string[] }[];
    (moves[0] as { by: string[] }).by = ["host", "customer"];
    expect(
      validateManifest(ahead)
        .issues.map((i) => i.message)
        .join("\n"),
    ).toContain("nobody moves themselves ahead of the waitlist");
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
      invoke("waitlist.promote", { object: BOOKING, id: w }, sys),
      invoke("waitlist.promote", { object: BOOKING, id: w }, sys),
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
      invoke("waitlist.promote", { object: BOOKING, id: w }, context(admin)),
    );
    expect(person.code).toBe("forbidden");
    // A pack's automation runs as the automation actor too, from its own origin: refused.
    const pack = context(admin, {
      actor: "automation",
      origin: { surface: "automation", automationId: "x.pack.jump", extensionId: ext },
    });
    for (const [name, input] of [
      ["waitlist.promote", { object: BOOKING, id: w }],
      ["waitlist.passOver", { object: BOOKING, id: w, reason: "nope" }],
      ["waitlist.release", { object: BOOKING, on: k, before: LATE }],
    ] as const) {
      const out = await refused(invoke(name, input, pack));
      expect(out.code).toBe("forbidden");
    }
    expect((await values(w)).state).toBe("waiting");
    expect(await holds(k)).toBe(1);
  });
});
