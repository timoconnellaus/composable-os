// Stage 31a step 7's platform pieces on a fixture class and booking (ADRs 0550 and 0551):
//   - a timed move (`states.after`): the minute cron's step makes a booking still booked 30
//     minutes after its class ends a no-show, only when another booking of the class was marked
//     (`ifAnyIn`), within the look-back, once, from the host's own origin only;
//   - a window on a move staff alone make (`bindsStaff` without `customer`): ticking from an hour
//     before the class;
//   - the races a class's cancel has with a booking of it, each in one batch planned from a read
//     the other changes: a booking planned before the cancel commits fails on the class having
//     moved (the `unmoved` guard, migration 0670); a cancel planned before a booking commits
//     fails on the class's counter (the cascade's `claimed` guard).
// The same rules through the shipped Bookings pack: apps/runner/test/bookings-attendance.test.ts.
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
  runTimedMovesDue,
  timedMovesDue,
  updateRecord,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, refusal as refused, unique } from "./helpers.ts";

const ext = extId("att");
const KLASS = `${ext}.klass`;
const BOOKING = `${ext}.booking`;
const STATES = ["booked", "attended", "no_show", "cancelled", "cancelled_by_us", "aside"];

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
          endsAt: { type: "datetime", label: "Ends at" },
          places: { type: "number", label: "Places" },
          state: {
            type: "select",
            label: "State",
            options: [
              { value: "scheduled", label: "Scheduled" },
              { value: "cancelled", label: "Cancelled" },
            ],
          },
          closed: {
            type: "formula",
            label: "Closed",
            expression: 'coalesce(state, "scheduled") != "scheduled"',
          },
        },
        states: {
          field: "state",
          initial: "scheduled",
          moves: [{ from: "scheduled", to: "cancelled", by: ["staff", "host"], final: true }],
        },
        capacity: { places: "places" },
      },
      visit: {
        label: "Visit",
        plural: "Visits",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          at: { type: "datetime", label: "At" },
          code: { type: "text", label: "Code" },
          state: {
            type: "select",
            label: "State",
            options: [
              { value: "open", label: "Open" },
              { value: "lapsed", label: "Lapsed" },
            ],
          },
        },
        states: {
          field: "state",
          initial: "open",
          moves: [{ from: "open", to: "lapsed", by: ["host"], requires: ["code"] }],
          after: [{ from: "open", to: "lapsed", at: "at" }],
        },
      },
      zticket: {
        label: "Ticket",
        plural: "Tickets",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          at: { type: "datetime", label: "At" },
          state: {
            type: "select",
            label: "State",
            options: [
              { value: "open", label: "Open" },
              { value: "lapsed", label: "Lapsed" },
            ],
          },
        },
        states: {
          field: "state",
          initial: "open",
          moves: [{ from: "open", to: "lapsed", by: ["host"] }],
          after: [{ from: "open", to: "lapsed", at: "at" }],
        },
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
        },
        states: {
          field: "state",
          initial: "booked",
          create: { closed: "klass.closed" },
          follows: { relation: "klass", when: { cancelled: "cancelled_by_us" }, from: ["booked"] },
          moves: [
            {
              from: "booked",
              to: "attended",
              by: ["staff"],
              window: { from: { at: "klass.startsAt", minutesBefore: 60 } },
              bindsStaff: true,
            },
            { from: "attended", to: "booked", by: ["staff"] },
            { from: "booked", to: "no_show", by: ["staff", "host"] },
            { from: "booked", to: "cancelled", by: ["staff", "customer"], final: true },
            { from: "booked", to: "cancelled_by_us", by: ["host"], final: true },
            // Set aside (holding no place), and back: what a closed class must refuse.
            { from: "booked", to: "aside", by: ["staff"] },
            { from: "aside", to: "booked", by: ["staff", "host"] },
          ],
          after: [
            {
              from: "booked",
              to: "no_show",
              at: "klass.endsAt",
              minutesAfter: 30,
              ifAnyIn: ["attended", "no_show"],
            },
          ],
        },
        claims: { on: "klass", confirmed: ["booked", "attended", "no_show"] },
      },
    },
  });

let admin: ActingUser;
const MINUTE = 60_000;
// The class: 08:00 to 09:00 UTC on 10 March.
const STARTS = "2026-03-10T08:00:00.000Z";
const ENDS = "2026-03-10T09:00:00.000Z";
const at = (now: string) => context(admin, { clock: () => new Date(now) });
const plus = (iso: string, minutes: number) =>
  new Date(Date.parse(iso) + minutes * MINUTE).toISOString();

async function person(label: string): Promise<string> {
  const tag = unique(label);
  return (await invoke("person.create", { givenName: tag }, context(admin))).id as string;
}
async function klass(values: Record<string, unknown> = {}) {
  const created = await invoke(
    "record.create",
    {
      object: KLASS,
      values: { name: unique("Class"), startsAt: STARTS, endsAt: ENDS, places: 10, ...values },
    },
    context(admin),
  );
  return created.id as string;
}
async function book(k: string) {
  const created = await invoke(
    "record.create",
    { object: BOOKING, values: { klass: k, person: await person("p") } },
    context(admin),
  );
  return created.id as string;
}
async function stateOf(id: string) {
  const record = await invoke("record.get", { object: BOOKING, id }, context(admin));
  return (record.values as Record<string, unknown>).state;
}
const move = (id: string, state: string, now: string) =>
  invoke("record.update", { object: BOOKING, id, values: { state } }, at(now));
async function counter(id: string) {
  return env.DB.prepare(
    "SELECT places, held, taken FROM core_capacity WHERE object_type = ? AND record_id = ?",
  )
    .bind(KLASS, id)
    .first();
}

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(fixture(ext));
}, 60_000);

describe("the declarations", () => {
  it("pass the contract, and their mistakes are named", () => {
    expect(validateManifest(fixture("okatt")).issues).toEqual([]);
    const broken = fixture("badatt");
    const booking = (broken.objects as Record<string, Record<string, unknown>>).booking as {
      states: { moves: Record<string, unknown>[]; after: Record<string, unknown>[] };
    };
    // No host move from cancelled to no_show; a moment that is not a datetime; ifAnyIn's state.
    booking.states.after = [
      { from: "cancelled", to: "no_show", at: "klass.name", ifAnyIn: ["gone"] },
    ];
    // A window on a move staff alone make, without bindsStaff, binds nobody: refused.
    booking.states.moves[0] = {
      from: "booked",
      to: "attended",
      by: ["staff"],
      window: { from: "klass.startsAt" },
    };
    const paths = validateManifest(broken).issues.map((i) => `${i.path}: ${i.message}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/states\.after\.0\.from: .*host move from "cancelled"/),
        expect.stringMatching(/states\.after\.0\.at: /),
        expect.stringMatching(/states\.after\.0\.ifAnyIn: "gone"/),
        expect.stringMatching(/states\.moves\.0: A window binds customers/),
      ]),
    );
  });
});

describe("a window on a move staff alone make (ADR 0551)", () => {
  it("binds a person on the staff: a name is ticked from an hour before the class, and any time after", async () => {
    const k = await klass();
    const b = await book(k);
    const early = await refused(move(b, "attended", plus(STARTS, -61)));
    expect(early.details).toMatchObject({
      rule: "state_window_not_open",
      opensAt: plus(STARTS, -60),
    });
    await move(b, "attended", plus(STARTS, -60));
    expect(await stateOf(b)).toBe("attended");
    // Unticked and ticked again days later: a late correction is not bound.
    await move(b, "booked", plus(ENDS, 3 * 24 * 60));
    await move(b, "attended", plus(ENDS, 3 * 24 * 60));
    expect(await stateOf(b)).toBe("attended");
  });
});

describe("timed moves (ADR 0550)", () => {
  it("after the moment, the host makes the still-booked no-shows, only where someone was marked", async () => {
    const taken = await klass();
    const forgotten = await klass();
    const came = await book(taken);
    const absent = [await book(taken), await book(taken)];
    const untouched = [await book(forgotten), await book(forgotten)];
    await move(came, "attended", STARTS);

    // 29 minutes after the end: not yet.
    expect(await timedMovesDue({ db: db.query }, BOOKING, 0, new Date(plus(ENDS, 29)))).toEqual([]);
    expect((await runTimedMovesDue(db, { clock: () => new Date(plus(ENDS, 29)) })).moved).toBe(0);
    // 30 minutes after: the two absent, oldest moment first; the forgotten list is not due.
    const due = await timedMovesDue({ db: db.query }, BOOKING, 0, new Date(plus(ENDS, 30)));
    expect(new Set(due)).toEqual(new Set(absent));
    const tick = await runTimedMovesDue(db, { clock: () => new Date(plus(ENDS, 30)) });
    expect(tick).toMatchObject({ failed: 0 });
    for (const id of absent) expect(await stateOf(id)).toBe("no_show");
    expect(await stateOf(came)).toBe("attended");
    for (const id of untouched) expect(await stateOf(id)).toBe("booked");
    // Their places stay taken (a no-show keeps the class).
    expect(await counter(taken)).toMatchObject({ taken: 3 });
    // A second tick finds nothing.
    expect(await timedMovesDue({ db: db.query }, BOOKING, 0, new Date(plus(ENDS, 31)))).toEqual([]);
    // Past the look-back (14 days) a class's list is no longer acted on.
    const old = await klass();
    const oldCame = await book(old);
    const oldAbsent = await book(old);
    await move(oldCame, "attended", STARTS);
    expect(
      await timedMovesDue({ db: db.query }, BOOKING, 0, new Date(plus(ENDS, 15 * 24 * 60))),
    ).not.toContain(oldAbsent);
  });

  it("its step is the host's: refused from any origin but the system's, and to a moved record", async () => {
    const k = await klass();
    const came = await book(k);
    const b = await book(k);
    await move(came, "attended", STARTS);
    const pack = context(admin, { actor: "automation", clock: () => new Date(plus(ENDS, 60)) });
    const out = await refused(
      invoke("state.after", { object: BOOKING, id: b, rule: 0, from: "booked" }, pack),
    );
    expect(out.code).toBe("forbidden");
    expect(await stateOf(b)).toBe("booked");
    // Cancelled by staff meanwhile: the step finds it no longer due.
    await move(b, "cancelled", STARTS);
    const host = {
      ...pack,
      origin: { surface: "system" as const, automationId: "test" },
    };
    const late = await refused(
      invoke("state.after", { object: BOOKING, id: b, rule: 0, from: "booked" }, host),
    );
    expect(late).toMatchObject({ code: "conflict", details: { reason: "not_due" } });
  });
});

// A booking and its class's cancel in one batch, each planned from a read the other changes:
// what two requests a moment apart do when one commits between the other's read and its commit.
const cancelThenBook = defineOperation({
  name: "fixture.cancelThenBook",
  description: "Test fixture: cancels a class, then books it from a read before that committed.",
  input: z.object({ klass: z.string(), person: z.string() }),
  output: z.object({ ok: z.boolean() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    await updateRecord(ctx, requireExtensionObject(KLASS), input.klass, { state: "cancelled" });
    await createRecord(ctx, requireExtensionObject(BOOKING), {
      klass: input.klass,
      person: input.person,
    });
    return { ok: true };
  },
});
const bookThenCancel = defineOperation({
  name: "fixture.bookThenCancel",
  description: "Test fixture: books a class, then cancels it from a read before that committed.",
  input: z.object({ klass: z.string(), person: z.string() }),
  output: z.object({ ok: z.boolean() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    await createRecord(ctx, requireExtensionObject(BOOKING), {
      klass: input.klass,
      person: input.person,
    });
    await updateRecord(ctx, requireExtensionObject(KLASS), input.klass, { state: "cancelled" });
    return { ok: true };
  },
});
const fixtures = createInvoker(
  createRegistry([...coreRegistry.list(), cancelThenBook, bookThenCancel]),
);

describe("nothing takes a place on a closed record (ADR 0553)", () => {
  it("a booking set aside cannot come back on a cancelled class, for staff or the host", async () => {
    const k = await klass();
    const b = await book(k);
    await move(b, "aside", STARTS);
    expect(await counter(k)).toMatchObject({ taken: 0 });
    await invoke(
      "record.update",
      { object: KLASS, id: k, values: { state: "cancelled" } },
      at(STARTS),
    );
    const out = await refused(move(b, "booked", STARTS));
    expect(out.details).toMatchObject({ rule: "state_closed" });
    expect(await stateOf(b)).toBe("aside");
    expect(await counter(k)).toMatchObject({ taken: 0 });
  });
});

describe("the sweep pages past records that keep failing (ADR 0550)", () => {
  it("a front of failures never starves the records behind it", async () => {
    const VISIT = `${ext}.visit`;
    const made = async (minutes: number, code: string | null) =>
      (
        await invoke(
          "record.create",
          {
            object: VISIT,
            values: { name: unique("v"), at: plus(STARTS, minutes), ...(code ? { code } : {}) },
          },
          context(admin),
        )
      ).id as string;
    // Three older ones that can never move (no code), then one that can.
    for (const m of [0, 1, 2]) await made(m, null);
    const good = await made(3, "ok");
    const tick = await runTimedMovesDue(db, {
      clock: () => new Date(plus(STARTS, 10)),
      maxRecords: 2,
    });
    expect(tick.failed).toBe(3);
    const record = await invoke("record.get", { object: VISIT, id: good }, context(admin));
    expect((record.values as Record<string, unknown>).state).toBe("lapsed");
  });
});

describe("one tick's budget is shared, and the rule that goes first turns (ADR 0550)", () => {
  it("a rule whose records keep failing cannot take every tick from the rules after it", async () => {
    const VISIT = `${ext}.visit`;
    const TICKET = `${ext}.zticket`;
    // Three visits that never move (no code), and one ticket that can.
    for (const m of [0, 1, 2]) {
      await invoke(
        "record.create",
        { object: VISIT, values: { name: unique("v"), at: plus(STARTS, m) } },
        context(admin),
      );
    }
    const ticket = (
      await invoke(
        "record.create",
        { object: TICKET, values: { name: unique("t"), at: plus(STARTS, 1) } },
        context(admin),
      )
    ).id as string;
    const state = async () =>
      (
        (await invoke("record.get", { object: TICKET, id: ticket }, context(admin)))
          .values as Record<string, unknown>
      ).state;
    // Two ticks a minute apart, three records each: whichever rule went first in one, the other
    // goes first in the next, so the ticket moves within two.
    for (const minute of [20, 21]) {
      if ((await state()) === "lapsed") break;
      await runTimedMovesDue(db, { clock: () => new Date(plus(STARTS, minute)), maxPerTick: 3 });
    }
    expect(await state()).toBe("lapsed");
  });
});

describe("a cascade cannot follow a pool (ADR 0550)", () => {
  it("is refused at the contract check", () => {
    const pooled = fixture("poolatt");
    const objects = pooled.objects as Record<string, Record<string, unknown>>;
    objects.seat = {
      label: "Seat",
      plural: "Seats",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        places: { type: "number", label: "Places" },
        klass: { type: "relation", label: "Class", to: "poolatt.klass" },
      },
      capacity: { places: "places", pool: "klass" },
    };
    const issues = validateManifest(pooled).issues.map((i) => `${i.path}: ${i.message}`);
    expect(issues).toEqual(
      expect.arrayContaining([expect.stringMatching(/follows\.relation: .*pool/)]),
    );
  });
});

describe("a booking racing its class's cancel (ADR 0550)", () => {
  it("a cancel that commits first fails the booking planned before it (the class moved)", async () => {
    const k = await klass();
    const kept = await book(k);
    const out = await refused(
      fixtures.invoke(
        "fixture.cancelThenBook",
        { klass: k, person: await person("late") },
        at(STARTS),
      ),
    );
    expect(out).toMatchObject({
      code: "conflict",
      details: { rule: "state_closed", reason: "moved_meanwhile" },
    });
    // Nothing of the batch applied: the class runs, its booking stands, one place taken.
    const record = await invoke("record.get", { object: KLASS, id: k }, context(admin));
    expect((record.values as Record<string, unknown>).state).toBe("scheduled");
    expect(await stateOf(kept)).toBe("booked");
    expect(await counter(k)).toMatchObject({ held: 0, taken: 1 });
  });

  it("a booking that commits first fails the cancel planned before it (the counter moved)", async () => {
    const k = await klass();
    await book(k);
    const out = await refused(
      fixtures.invoke(
        "fixture.bookThenCancel",
        { klass: k, person: await person("early") },
        at(STARTS),
      ),
    );
    expect(out.code).toBe("conflict");
    expect(await counter(k)).toMatchObject({ held: 0, taken: 1 });
    // Asked again, the cancel reads the class as it is and takes every booking with it.
    await invoke(
      "record.update",
      { object: KLASS, id: k, values: { state: "cancelled" } },
      at(STARTS),
    );
    expect(await counter(k)).toMatchObject({ held: 0, taken: 0 });
  });
});
