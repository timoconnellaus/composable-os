// Stage 49 step 5 (ADR 0764): appointments booked by staff, in the real host and sandbox, with the
// shipped Programs, Bookings and Memberships packs. Every rule here is the host's, declared by the
// pack: one coach never on a class and an appointment at once, the service's buffer kept free, a
// private room taken once (the first free one chosen by the host), no appointment without a coach
// account, a pass that covers the service paying (a class pass never does, a session pass never
// pays for a class), a late cancel and a no-show keeping the session with no fee until a person
// excuses it, a move carrying the session, a reassignment refused over a clash, and the coach's day.
//
// Clocks: a tool's own calls read the real clock, so the appointments are placed from now, on whole
// hours (every service's step lands on them in any whole-hour zone).
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type ExtensionHost,
  type InvocationContext,
  refreshSchemaRegistry,
  runTimedMovesDue,
} from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { setPreset } from "./automation-fixture.ts";
import {
  createAdmin,
  createMember,
  db,
  host,
  newCustomer,
  refusal,
  run,
  unique,
} from "./helpers.ts";
import { packFiles } from "./pack-files.ts";

const files: Record<string, Record<string, string>> = {
  programs: packFiles("programs"),
  bookings: packFiles("bookings"),
  memberships: packFiles("memberships"),
  rostering: packFiles("rostering"),
};

const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [
    ...(await host.shipped()),
    { id: "bookings", version: "0.1.0" },
    { id: "memberships", version: "0.1.0" },
    { id: "programs", version: "0.1.0" },
    { id: "rostering", version: "0.1.0" },
  ],
  commitShipped: (id) =>
    files[id]
      ? host.commit({
          id,
          files: files[id] as Record<string, string>,
          message: `Shipped ${id} 0.1.0`,
          author: { name: "Composable OS", email: "release@composableos.dev" },
        })
      : host.commitShipped(id),
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const APPT = "bookings.appointment";
let admin: ActingUser;
let classType: string;

const staff = (extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user: admin,
  origin: { surface: "ui" },
  db,
  extensionHost: shippedHost,
  ...extra,
});
const create = async (object: string, values: Record<string, unknown>) =>
  (await run<{ id: string }>("record.create", { object, values }, staff())).id;
const get = async (object: string, id: string) =>
  (await run<{ values: Record<string, unknown> }>("record.get", { object, id }, staff())).values;

/** A whole hour `days` days and `hours` hours from now. */
const at = (days: number, hours = 0) =>
  Math.ceil(Date.now() / HOUR) * HOUR + days * DAY + hours * HOUR;
const iso = (instant: number) => new Date(instant).toISOString();

/** A coach with a staff account, qualified for `services`, open around the clock for 40 days. */
async function newCoach(services: string[]) {
  const user = await createMember();
  const coach = await create("bookings.coach", { name: unique("Coach "), user: user.id });
  const now = new Date().toISOString();
  for (const service of services) {
    await env.DB.prepare(
      "INSERT INTO core_staff_qualification (account_id, kind_object, kind_record, set_by, set_at) VALUES (?, 'bookings.service', ?, ?, ?)",
    )
      .bind(user.id, service, admin.id, now)
      .run();
  }
  await env.DB.prepare(
    "INSERT INTO core_staff_hours (id, account_id, kind, starts_at, ends_at, zone, set_by, set_at) VALUES (?, ?, 'extra', ?, ?, 'UTC', ?, ?)",
  )
    .bind(unique("hrs_"), user.id, iso(Date.now() - DAY), iso(Date.now() + 40 * DAY), admin.id, now)
    .run();
  return { user, coach };
}

async function newService(values: Record<string, unknown> = {}) {
  return create("bookings.service", {
    title: unique("Personal training "),
    length: 60,
    step: 60,
    ...values,
  });
}

interface Answer {
  result: string;
  reason?: string;
  appointmentId?: string;
  coachId?: string | null;
  roomId?: string | null;
  holderId?: string | null;
  paidAtDesk?: boolean;
  state?: string;
  warnings?: { code: string }[];
  message?: string;
}
const tool = (name: string, input: Record<string, unknown>, ctx = staff()) =>
  run<Answer>(`x.bookings.${name}`, input, ctx);

const client = async (label: string) => (await newCustomer(staff(), label)).principal.personId;

/** A pass of `uses` given by hand from a new pass type with `values`. */
async function passFor(personId: string, values: Record<string, unknown>, uses = 10) {
  const type = await create("memberships.passtype", {
    title: unique("Pass "),
    price: 100,
    uses,
    validDays: 60,
    status: "on_sale",
    ...values,
  });
  const given = await run<{ passId: string }>(
    "x.memberships.givePass",
    { personId, passTypeId: type, reason: "Integration test" },
    staff(),
  );
  return given.passId;
}
const left = async (passId: string) => (await get("memberships.pass", passId)).left;
/** A pass valid from a day ago (given now, it would not pay for a session that has started). */
async function backdate(passId: string) {
  await env.DB.prepare(
    "UPDATE core_allowance SET valid_from = ?, from_date = NULL WHERE object_type = 'memberships.pass' AND record_id = ?",
  )
    .bind(iso(Date.now() - DAY), passId)
    .run();
}

beforeAll(async () => {
  admin = await createAdmin();
  await setPreset("balanced");
  await refreshSchemaRegistry(db.query);
  for (const id of ["bookings", "memberships"]) {
    await run("extension.install", { id, shipped: true }, staff());
  }
  await refreshSchemaRegistry(db.query);
  classType = await create("bookings.classtype", { name: unique("Strength") });
});

describe("one claim across classes and appointments (criterion 1, 2)", () => {
  it("refuses an appointment over the coach's class, keeps the buffer, books the first free coach", async () => {
    const service = await newService({ bufferAfter: 15 });
    const a = await newCoach([service]);
    const b = await newCoach([service]);
    const person = await client("claim");
    const t = at(3);
    // A class the coach teaches.
    await create("bookings.class", {
      classType,
      coach: a.coach,
      startsAt: iso(t),
      endsAt: iso(t + HOUR),
      timezone: "UTC",
      places: 10,
    });
    const over = await tool("bookAppointment", {
      serviceId: service,
      startsAt: iso(t),
      personId: person,
      coachId: a.coach,
      paidAtDesk: true,
    });
    expect(over).toMatchObject({ result: "refused", reason: "double_booked" });

    // "Any coach": the coach on the class is not free, so the other one is booked.
    const any = await tool("bookAppointment", {
      serviceId: service,
      startsAt: iso(t),
      personId: person,
      paidAtDesk: true,
    });
    expect(any).toMatchObject({ result: "booked", coachId: b.coach, paidAtDesk: true });

    // The buffer: 15 minutes after a 60-minute session are kept free in the coach's time.
    const first = await tool("bookAppointment", {
      serviceId: service,
      startsAt: iso(t + 2 * HOUR),
      personId: await client("buffer"),
      coachId: a.coach,
      paidAtDesk: true,
    });
    expect(first.result).toBe("booked");
    const tooSoon = await tool("bookAppointment", {
      serviceId: service,
      startsAt: iso(t + 3 * HOUR),
      personId: await client("buffer2"),
      coachId: a.coach,
      paidAtDesk: true,
    });
    expect(tooSoon).toMatchObject({ result: "refused", reason: "double_booked" });
    // A class right after the session's buffer is fine; two classes back to back still are.
    await create("bookings.class", {
      classType,
      coach: a.coach,
      startsAt: iso(t + 3 * HOUR + 15 * MINUTE),
      endsAt: iso(t + 4 * HOUR + 15 * MINUTE),
      timezone: "UTC",
      places: 10,
    });
    await create("bookings.class", {
      classType,
      coach: a.coach,
      startsAt: iso(t + 4 * HOUR + 15 * MINUTE),
      endsAt: iso(t + 5 * HOUR + 15 * MINUTE),
      timezone: "UTC",
      places: 10,
    });
  });

  it("refuses a coach profile with no staff account (criterion 4)", async () => {
    const service = await newService();
    const visiting = await create("bookings.coach", { name: unique("Visiting ") });
    const answer = await tool("bookAppointment", {
      serviceId: service,
      startsAt: iso(at(4)),
      personId: await client("noaccount"),
      coachId: visiting,
      paidAtDesk: true,
    });
    expect(answer).toMatchObject({ result: "refused", reason: "no_account" });
  });
});

describe("rooms (criterion 3)", () => {
  it("gives the first free exclusive room, refuses when none is, and a class over a session", async () => {
    const one = await create("bookings.room", { name: unique("Treatment 1 "), exclusive: true });
    const two = await create("bookings.room", { name: unique("Treatment 2 "), exclusive: true });
    const service = await newService({ rooms: [one, two] });
    const coaches = [
      await newCoach([service]),
      await newCoach([service]),
      await newCoach([service]),
    ];
    const t = at(5);
    const people = [await client("room0"), await client("room1"), await client("room2")];
    const first = await tool("bookAppointment", {
      serviceId: service,
      startsAt: iso(t),
      personId: people[0],
      coachId: coaches[0]?.coach,
      paidAtDesk: true,
    });
    expect(first).toMatchObject({ result: "booked", roomId: one });
    const second = await tool("bookAppointment", {
      serviceId: service,
      startsAt: iso(t),
      personId: people[1],
      coachId: coaches[1]?.coach,
      paidAtDesk: true,
    });
    expect(second).toMatchObject({ result: "booked", roomId: two });
    const third = await tool("bookAppointment", {
      serviceId: service,
      startsAt: iso(t),
      personId: people[2],
      coachId: coaches[2]?.coach,
      paidAtDesk: true,
    });
    expect(third).toMatchObject({ result: "refused", reason: "room_taken" });
    // A class in the first room at that time is refused by the database.
    expect(
      await refusal(
        run(
          "record.create",
          {
            object: "bookings.class",
            values: {
              classType,
              room: one,
              startsAt: iso(t + 30 * MINUTE),
              endsAt: iso(t + 90 * MINUTE),
              timezone: "UTC",
              places: 5,
            },
          },
          staff(),
        ),
      ),
    ).toMatchObject({ code: "conflict", details: { rule: "room_taken" } });
  });
});

describe("paying (criterion 8, 9)", () => {
  it("a session pass pays for its service; a class pass never does; a session pass never pays a class", async () => {
    const service = await newService();
    const other = await newService();
    const { coach } = await newCoach([service, other]);
    const person = await client("pays");
    const sessions = await passFor(person, { covers: ["sessions"], services: [service] });
    expect(await left(sessions)).toBe(10);
    const booked = await tool("bookAppointment", {
      serviceId: service,
      startsAt: iso(at(6)),
      personId: person,
      coachId: coach,
    });
    expect(booked).toMatchObject({ result: "booked", holderId: sessions, paidAtDesk: false });
    expect(await left(sessions)).toBe(9);
    // Another service: not covered by this pass.
    const notCovered = await tool("bookAppointment", {
      serviceId: other,
      startsAt: iso(at(6, 3)),
      personId: person,
      coachId: coach,
    });
    expect(notCovered).toMatchObject({ result: "refused", reason: "no_use" });

    // A class pass (pays for classes only, as every pass did before sessions) pays for no session.
    const classOnly = await client("classonly");
    await passFor(classOnly, {});
    const refused = await tool("bookAppointment", {
      serviceId: service,
      startsAt: iso(at(6, 6)),
      personId: classOnly,
      coachId: coach,
    });
    expect(refused).toMatchObject({ result: "refused", reason: "no_use" });

    // ...and the session pass pays for no class.
    const klass = await create("bookings.class", {
      classType,
      startsAt: iso(at(6, 9)),
      endsAt: iso(at(6, 10)),
      timezone: "UTC",
      places: 10,
    });
    const classBooking = await run<unknown>(
      "x.bookings.bookFor",
      { classId: klass, personId: person },
      staff(),
    );
    expect(classBooking).toMatchObject({ result: "refused", reason: "no_use" });
    expect(await left(sessions)).toBe(9);

    // Paid at the desk: no session spent.
    const desk = await tool("bookAppointment", {
      serviceId: service,
      startsAt: iso(at(6, 12)),
      personId: person,
      coachId: coach,
      paidAtDesk: true,
    });
    expect(desk).toMatchObject({ result: "booked", holderId: null, paidAtDesk: true });
    expect(await left(sessions)).toBe(9);
  });

  it("in time gives the session back; late keeps it with no fee; a person excuses it", async () => {
    const service = await newService();
    const { coach } = await newCoach([service]);
    const person = await client("late");
    const pass = await passFor(person, { covers: ["sessions"] });
    // Three days ahead: in time.
    const early = await tool("bookAppointment", {
      serviceId: service,
      startsAt: iso(at(3, 2)),
      personId: person,
      coachId: coach,
    });
    expect(await left(pass)).toBe(9);
    expect(await tool("cancelAppointment", { appointmentId: early.appointmentId })).toMatchObject({
      result: "preview",
      state: "cancelled",
    });
    expect(
      await tool("cancelAppointment", { appointmentId: early.appointmentId, confirm: true }),
    ).toMatchObject({ result: "cancelled" });
    expect(await left(pass)).toBe(10);

    // Three hours ahead: inside the 24 hours, late.
    const soon = await tool("bookAppointment", {
      serviceId: service,
      startsAt: iso(at(0, 3)),
      personId: person,
      coachId: coach,
    });
    expect(soon.result).toBe("booked");
    expect(await left(pass)).toBe(9);
    expect(
      await tool("cancelAppointment", { appointmentId: soon.appointmentId, confirm: true }),
    ).toMatchObject({ result: "late_cancelled" });
    expect(await left(pass)).toBe(9);
    // No other staff write gives it back (a person's own act, excuseAppointment).
    for (const state of ["cancelled", "excused"]) {
      expect(
        await refusal(
          run(
            "record.update",
            { object: APPT, id: soon.appointmentId, values: { state } },
            staff(),
          ),
        ),
      ).toMatchObject({ code: "invalid_input" });
    }
    // ...but a person excusing it does.
    expect(
      await tool("excuseAppointment", { appointmentId: soon.appointmentId, reason: "Was ill" }),
    ).toMatchObject({ result: "excused" });
    expect(await left(pass)).toBe(10);
    // The assistant cannot excuse one (a person's act).
    const late2 = await tool("bookAppointment", {
      serviceId: service,
      startsAt: iso(at(0, 5)),
      personId: person,
      coachId: coach,
    });
    await tool("cancelAppointment", { appointmentId: late2.appointmentId, confirm: true });
    expect(
      await refusal(
        run(
          "x.bookings.excuseAppointment",
          { appointmentId: late2.appointmentId, reason: "Asked" },
          staff({ actor: "assistant" }),
        ),
      ),
    ).toMatchObject({ code: expect.stringMatching(/forbidden|actor/) });
    expect(await left(pass)).toBe(9);
  });

  it("a no-show keeps the session; marked, corrected and excused", async () => {
    const service = await newService();
    const { coach } = await newCoach([service]);
    const person = await client("noshow");
    const pass = await passFor(person, { covers: ["sessions"] });
    await backdate(pass);
    // Started ten minutes ago (staff may book any time).
    const started = Date.now() - 10 * MINUTE;
    const made = await tool("bookAppointment", {
      serviceId: service,
      startsAt: iso(started),
      personId: person,
      coachId: coach,
    });
    expect(made.result).toBe("booked");
    expect(await left(pass)).toBe(9);
    expect(
      await tool("markAppointment", { appointmentId: made.appointmentId, mark: "no_show" }),
    ).toMatchObject({ result: "no_show" });
    expect(await left(pass)).toBe(9);
    expect(
      await tool("markAppointment", { appointmentId: made.appointmentId, mark: "attended" }),
    ).toMatchObject({ result: "attended" });
    expect(
      await tool("markAppointment", { appointmentId: made.appointmentId, mark: "no_show" }),
    ).toMatchObject({ result: "no_show" });
    expect(
      await tool("excuseAppointment", { appointmentId: made.appointmentId, reason: "Car broke" }),
    ).toMatchObject({ result: "excused" });
    expect(await left(pass)).toBe(10);

    // One not started yet cannot be marked.
    const ahead = await tool("bookAppointment", {
      serviceId: service,
      startsAt: iso(at(2)),
      personId: person,
      coachId: coach,
    });
    expect(
      await tool("markAppointment", { appointmentId: ahead.appointmentId, mark: "attended" }),
    ).toMatchObject({ result: "refused", reason: "not_started" });
  });
});

describe("move, reassign and the coach's day (criterion 10)", () => {
  it("moves with its session, reassigns to a free coach, refuses a busy one", async () => {
    const service = await newService();
    const a = await newCoach([service]);
    const b = await newCoach([service]);
    const person = await client("move");
    const pass = await passFor(person, { covers: ["sessions"] });
    const t = at(7);
    const made = await tool("bookAppointment", {
      serviceId: service,
      startsAt: iso(t),
      personId: person,
      coachId: a.coach,
    });
    expect(await left(pass)).toBe(9);
    // Half an hour later, overlapping its own old time: the old one is moved in the same batch.
    const moved = await run<Answer & { fromAppointmentId: string }>(
      "x.bookings.moveAppointment",
      { appointmentId: made.appointmentId, startsAt: iso(t + HOUR) },
      staff(),
    );
    expect(moved).toMatchObject({ result: "booked", holderId: pass });
    expect((await get(APPT, made.appointmentId as string)).state).toBe("moved");
    expect(await left(pass)).toBe(9);

    // Coach B teaches a class then: reassigning to B is refused, nothing changed.
    await create("bookings.class", {
      classType,
      coach: b.coach,
      startsAt: iso(t + HOUR),
      endsAt: iso(t + 2 * HOUR),
      timezone: "UTC",
      places: 10,
    });
    expect(
      await tool("reassignAppointment", { appointmentId: moved.appointmentId, coachId: b.coach }),
    ).toMatchObject({ result: "refused", reason: "double_booked" });
    expect((await get(APPT, moved.appointmentId as string)).coach).toBe(a.coach);

    // A third coach who is free takes it; the session stays paid as it was.
    const c = await newCoach([]);
    const reassigned = await tool("reassignAppointment", {
      appointmentId: moved.appointmentId,
      coachId: c.coach,
    });
    expect(reassigned).toMatchObject({ result: "booked", coachId: c.coach, holderId: pass });
    // Not qualified for the service: made, and said so.
    expect(reassigned.warnings?.map((w) => w.code)).toContain("not_qualified");
    expect(await left(pass)).toBe(9);

    // The coach's day: their appointment, with its service and client, beside their classes.
    const date = iso(t + HOUR).slice(0, 10);
    const day = await run<{
      coaches: { coachId: string; items: { kind: string; client: { id: string } | null }[] }[];
    }>("x.bookings.coachDay", { date, coachId: c.coach }, staff());
    expect(day.coaches).toHaveLength(1);
    expect(day.coaches[0]?.items).toEqual([
      expect.objectContaining({
        kind: "appointment",
        client: expect.objectContaining({ id: person }),
      }),
    ]);

    // The business cancels it: the session given back.
    await run(
      "x.bookings.cancelAppointmentByUs",
      { appointmentId: moved.appointmentId, reason: "Coach ill" },
      staff(),
    );
    expect((await get(APPT, moved.appointmentId as string)).state).toBe("cancelled_by_us");
    expect(await left(pass)).toBe(10);
  });
});

describe("a used session never comes back by a change of time (B1, ADR 0764)", () => {
  const ai = () => staff({ actor: "assistant", origin: { surface: "assistant" } });

  it("refuses a retime by record.update, for staff and an AI alike", async () => {
    const service = await newService();
    const { coach } = await newCoach([service]);
    const person = await client("retime");
    const pass = await passFor(person, { covers: ["sessions"] });
    const t = at(0, 3);
    const late = await tool("bookAppointment", {
      serviceId: service,
      startsAt: iso(t),
      personId: person,
      coachId: coach,
    });
    expect(await left(pass)).toBe(9);
    const later = { startsAt: iso(at(5)), endsAt: iso(at(5, 1)) };
    expect(
      await refusal(
        run("record.update", { object: APPT, id: late.appointmentId, values: later }, staff()),
      ),
    ).toMatchObject({ code: "invalid_input", details: { reason: "moves_only" } });
    // The service is fixed too: another one is a move.
    const other = await newService();
    expect(
      await refusal(
        run(
          "record.update",
          { object: APPT, id: late.appointmentId, values: { service: other } },
          staff(),
        ),
      ),
    ).toMatchObject({ code: "invalid_input", details: { reason: "moves_only" } });
    // An AI's retime is refused the same way (or, queued, is refused when a person applies it).
    const byAi = await refusal(
      run("record.update", { object: APPT, id: late.appointmentId, values: later }, ai()),
    );
    expect(["invalid_input", "pending_approval"]).toContain(byAi.code);
    expect((await get(APPT, late.appointmentId as string)).startsAt).toBe(iso(t));
    // Cancelling now is late: the session stays used.
    expect(
      await tool("cancelAppointment", { appointmentId: late.appointmentId, confirm: true }),
    ).toMatchObject({ result: "late_cancelled" });
    expect(await left(pass)).toBe(9);
  });

  it("a move keeps the original's late point: moved when late, cancelling it is late", async () => {
    const service = await newService();
    const { coach } = await newCoach([service]);
    const person = await client("movelate");
    const pass = await passFor(person, { covers: ["sessions"] });
    const t = at(0, 3);
    const late = await tool("bookAppointment", {
      serviceId: service,
      startsAt: iso(t),
      personId: person,
      coachId: coach,
    });
    const moved = await tool("moveAppointment", {
      appointmentId: late.appointmentId,
      startsAt: iso(at(8)),
    });
    expect(moved.result).toBe("booked");
    expect((await get(APPT, moved.appointmentId as string)).lateAnchor).toBe(iso(t));
    expect(await left(pass)).toBe(9);
    expect(await tool("cancelAppointment", { appointmentId: moved.appointmentId })).toMatchObject({
      result: "preview",
      state: "late_cancelled",
    });
    expect(
      await tool("cancelAppointment", { appointmentId: moved.appointmentId, confirm: true }),
    ).toMatchObject({ result: "late_cancelled" });
    expect(await left(pass)).toBe(9);

    // The same as an AI: moved when late, its cancel resolves late (or waits for a person).
    const again = await tool("bookAppointment", {
      serviceId: service,
      startsAt: iso(at(0, 5)),
      personId: person,
      coachId: coach,
    });
    const movedAgain = await tool("moveAppointment", {
      appointmentId: again.appointmentId,
      startsAt: iso(at(9)),
    });
    expect(await left(pass)).toBe(8);
    const asked = await run<{ values: { state: string } }>(
      "record.update",
      { object: APPT, id: movedAgain.appointmentId, values: { state: "cancel" } },
      ai(),
    ).catch((e: { code?: string }) => ({ values: { state: e.code ?? "" } }));
    expect(["late_cancelled", "pending_approval"]).toContain(asked.values.state);
    expect(await left(pass)).toBe(8);
  });

  it("moved in time, it is cancelled in time until the original's late point", async () => {
    const service = await newService();
    const { coach } = await newCoach([service]);
    const person = await client("moveearly");
    const pass = await passFor(person, { covers: ["sessions"] });
    const t = at(5);
    const early = await tool("bookAppointment", {
      serviceId: service,
      startsAt: iso(t),
      personId: person,
      coachId: coach,
    });
    const moved = await tool("moveAppointment", {
      appointmentId: early.appointmentId,
      startsAt: iso(at(6)),
    });
    expect((await get(APPT, moved.appointmentId as string)).lateAnchor).toBe(iso(t));
    expect(
      await tool("cancelAppointment", { appointmentId: moved.appointmentId, confirm: true }),
    ).toMatchObject({ result: "cancelled" });
    expect(await left(pass)).toBe(10);
  });
});

describe("erase, leaving and the host's attended mark (S1, S2, F4)", () => {
  it("an appointment is made for a client, and erasing the client keeps it with no client", async () => {
    const service = await newService();
    const { coach } = await newCoach([service]);
    expect(
      await refusal(
        run(
          "record.create",
          {
            object: APPT,
            values: {
              service,
              coach,
              startsAt: iso(at(10)),
              endsAt: iso(at(10, 1)),
            },
          },
          staff(),
        ),
      ),
    ).toMatchObject({ code: "invalid_input", details: { rule: "state_required_fields" } });
    const person = await client("erase");
    const past = await tool("bookAppointment", {
      serviceId: service,
      startsAt: iso(Date.now() - 2 * DAY),
      personId: person,
      coachId: coach,
      paidAtDesk: true,
    });
    await tool("markAppointment", { appointmentId: past.appointmentId, mark: "attended" });
    await run("person.erase", { id: person }, staff());
    const kept = await get(APPT, past.appointmentId as string);
    expect(kept).toMatchObject({ state: "attended", coach });
    expect(kept.person ?? null).toBeNull();
  });

  it("the host marks an unmarked appointment attended 30 minutes after it ends, never one whose coach left", async () => {
    const service = await newService();
    const a = await newCoach([service]);
    const leaver = await newCoach([service]);
    const ends = Date.now() - 40 * MINUTE;
    const done = await tool("bookAppointment", {
      serviceId: service,
      startsAt: iso(ends - HOUR),
      personId: await client("attended"),
      coachId: a.coach,
      paidAtDesk: true,
    });
    // Not yet 30 minutes after its end: still booked.
    await runTimedMovesDue(db, { clock: () => new Date(ends + 29 * MINUTE) });
    expect((await get(APPT, done.appointmentId as string)).state).toBe("booked");
    await runTimedMovesDue(db, { clock: () => new Date(ends + 31 * MINUTE) });
    expect((await get(APPT, done.appointmentId as string)).state).toBe("attended");

    // A leaver's appointment still to come is left with no coach (the spec's leaving: uncovered,
    // the rosterers told), and the host never marks it attended for a session nobody gave.
    const start = at(1);
    const ahead = await tool("bookAppointment", {
      serviceId: service,
      startsAt: iso(start),
      personId: await client("leaver"),
      coachId: leaver.coach,
      paidAtDesk: true,
    });
    const asked = await run("user.deactivate", { id: leaver.user.id }, staff()).then(
      () => null,
      (e: { details?: { count?: number } }) => e,
    );
    if (asked) {
      await run(
        "user.deactivate",
        { id: leaver.user.id, confirm: Number(asked.details?.count ?? 0) },
        staff(),
      );
    }
    const uncovered = await get(APPT, ahead.appointmentId as string);
    expect(uncovered.coach ?? null).toBeNull();
    expect(uncovered.state).toBe("booked");
    await runTimedMovesDue(db, { clock: () => new Date(start + 2 * HOUR) });
    expect((await get(APPT, ahead.appointmentId as string)).state).toBe("booked");
  });
});

describe("booking is not rostering (ADR 0764, amending ADR 0626)", () => {
  it("with Rostering installed, a member books a coach's appointment but still cannot set a class's coach", async () => {
    await run("extension.install", { id: "rostering", shipped: true }, staff());
    await refreshSchemaRegistry(db.query);
    const service = await newService();
    const { coach } = await newCoach([service]);
    const member = await createMember();
    const asMember = staff({ user: member });
    const booked = await tool(
      "bookAppointment",
      {
        serviceId: service,
        startsAt: iso(at(9)),
        personId: await client("roster"),
        coachId: coach,
        paidAtDesk: true,
      },
      asMember,
    );
    expect(booked).toMatchObject({ result: "booked", coachId: coach });
    expect(
      await refusal(
        run(
          "record.create",
          {
            object: "bookings.class",
            values: {
              classType,
              coach,
              startsAt: iso(at(9, 3)),
              endsAt: iso(at(9, 4)),
              timezone: "UTC",
              places: 5,
            },
          },
          asMember,
        ),
      ),
    ).toMatchObject({ code: "forbidden", details: { rule: "rostering" } });
  });

  it("but not for a session that has started or is over, and an AI's change of coach waits", async () => {
    const service = await newService();
    const a = await newCoach([service]);
    const b = await newCoach([service]);
    const member = await createMember();
    const asMember = staff({ user: member });
    // A past session made now, naming who gave it: who is counted for pay is a rosterer's.
    expect(
      await refusal(
        run(
          "record.create",
          {
            object: APPT,
            values: {
              service,
              person: await client("pastroster"),
              coach: a.coach,
              startsAt: iso(Date.now() - 2 * DAY),
              endsAt: iso(Date.now() - 2 * DAY + HOUR),
              state: "attended",
            },
          },
          asMember,
        ),
      ),
    ).toMatchObject({ code: "forbidden", details: { rule: "rostering" } });
    // One that has started, made by an admin (who rosters): its coach is not a member's to change.
    const started = await tool("bookAppointment", {
      serviceId: service,
      startsAt: iso(Date.now() - 10 * MINUTE),
      personId: await client("startedroster"),
      coachId: a.coach,
      paidAtDesk: true,
    });
    expect(
      await refusal(
        run(
          "record.update",
          { object: APPT, id: started.appointmentId, values: { coach: b.coach } },
          asMember,
        ),
      ),
    ).toMatchObject({ code: "forbidden", details: { rule: "rostering" } });
    // Still to come: a member changes it; an AI's change waits for a person.
    const ahead = await tool("bookAppointment", {
      serviceId: service,
      startsAt: iso(at(11)),
      personId: await client("aheadroster"),
      coachId: a.coach,
      paidAtDesk: true,
    });
    await run(
      "record.update",
      { object: APPT, id: ahead.appointmentId, values: { coach: b.coach } },
      asMember,
    );
    expect((await get(APPT, ahead.appointmentId as string)).coach).toBe(b.coach);
    expect(
      await refusal(
        run(
          "record.update",
          { object: APPT, id: ahead.appointmentId, values: { coach: a.coach } },
          staff({ actor: "assistant", origin: { surface: "assistant" } }),
        ),
      ),
    ).toMatchObject({ code: "pending_approval" });
    expect((await get(APPT, ahead.appointmentId as string)).coach).toBe(b.coach);
    // A person's reassignment through the tool is applied at once.
    expect(
      await tool("reassignAppointment", { appointmentId: ahead.appointmentId, coachId: a.coach }),
    ).toMatchObject({ result: "booked", coachId: a.coach });
  });
});
