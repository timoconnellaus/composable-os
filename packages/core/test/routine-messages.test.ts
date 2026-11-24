// Routine messages (stage 30 step 1, ADRs 0670 and 0676): quiet hours and urgent kinds, the
// end of quiet hours releasing or expiring what waited, the host's own kinds (declared in core,
// checked as a pack's, off until a human admin turns them on, asked for by host code only), and
// the settings that switch text and push on, a human admin's only.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  declareHostRoutineKind,
  hostRoutineKind,
  invokeByName,
  newId,
  prepareHostRoutineMail,
  quietDecision,
  quietUntil,
  releaseWaitingRoutineMessages,
  routineKinds,
  sendHostRoutineMessage,
} from "../src/index.ts";
import { valueHash } from "../src/routine-mail/marks.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";

const QUIET = { start: "21:00", end: "07:00" };
const ZONE = "Australia/Sydney";
/** An instant at a local time in Sydney (+11:00 in summer, the dates below). */
const sydney = (local: string) => Date.parse(`${local}+11:00`);

describe("quiet hours (ADR 0676)", () => {
  it("a reminder due at 11pm waits until 7am; one at noon goes now", () => {
    expect(
      quietDecision(sydney("2026-12-01T23:00:00"), ZONE, QUIET, { urgent: false, until: null }),
    ).toEqual({
      waitUntil: new Date(sydney("2026-12-02T07:00:00")).toISOString(),
    });
    expect(
      quietDecision(sydney("2026-12-01T12:00:00"), ZONE, QUIET, { urgent: false, until: null }),
    ).toEqual({
      waitUntil: null,
    });
    // Just after midnight, the same morning's 7am.
    expect(quietUntil(sydney("2026-12-02T00:30:00"), ZONE, QUIET)).toBe(
      sydney("2026-12-02T07:00:00"),
    );
    // At 7am exactly it is over; at 9pm exactly it has begun.
    expect(quietUntil(sydney("2026-12-02T07:00:00"), ZONE, QUIET)).toBeNull();
    expect(quietUntil(sydney("2026-12-01T21:00:00"), ZONE, QUIET)).toBe(
      sydney("2026-12-02T07:00:00"),
    );
  });

  it("an urgent cancellation of a 6am class texts at once; of next week's class it waits until 7am", () => {
    const at = sydney("2026-12-02T05:00:00");
    expect(
      quietDecision(at, ZONE, QUIET, { urgent: true, until: sydney("2026-12-02T06:00:00") }),
    ).toEqual({
      waitUntil: null,
    });
    expect(
      quietDecision(at, ZONE, QUIET, { urgent: true, until: sydney("2026-12-09T06:00:00") }),
    ).toEqual({
      waitUntil: new Date(sydney("2026-12-02T07:00:00")).toISOString(),
    });
    // Not urgent: it waits even when its moment is before the end (and expires then).
    expect(
      quietDecision(at, ZONE, QUIET, { urgent: false, until: sydney("2026-12-02T06:00:00") }),
    ).toEqual({
      waitUntil: new Date(sydney("2026-12-02T07:00:00")).toISOString(),
    });
  });

  it("a business's own window that does not cross midnight, none at all, and a night the clocks change", () => {
    const early = { start: "05:00", end: "06:00" };
    expect(quietUntil(sydney("2026-12-02T05:30:00"), ZONE, early)).toBe(
      sydney("2026-12-02T06:00:00"),
    );
    expect(quietUntil(sydney("2026-12-02T06:30:00"), ZONE, early)).toBeNull();
    expect(
      quietUntil(sydney("2026-12-02T23:00:00"), ZONE, { start: "07:00", end: "07:00" }),
    ).toBeNull();
    // Sydney's clocks go forward at 2am on 4 October 2026 (+10:00 to +11:00): 7am that morning.
    const before = Date.parse("2026-10-03T23:00:00+10:00");
    expect(quietUntil(before, ZONE, QUIET)).toBe(Date.parse("2026-10-04T07:00:00+11:00"));
  });
});

/** A text or push row, waiting for quiet hours to end at `waitUntil`. */
async function waiting(waitUntil: string, untilAt: string | null, channel = "push") {
  const id = newId("routineMail");
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO core_routine_mail (id, kind, message, extension_id, record_object, record_id,
       channel, recipient, recipient_key, recipient_rule, automation_id, run_id, trigger_type,
       idempotency_key, routine, status, subject, body, wait_until, until_at, created_at, updated_at)
     VALUES (?, 'bookings.reminder', 'reminder', 'bookings', 'bookings.booking', 'rec_1', ?,
       'device_1', ?, 'person', 'bookings.classReminder', 'arn_1', 'dateRelative', ?, 1, 'waiting',
       'Reminder', 'Strength at 06:30.', ?, ?, ?, ?)`,
  )
    .bind(id, channel, `${channel}:per_1`, unique("k"), waitUntil, untilAt, now, now)
    .run();
  return id;
}

describe("the end of quiet hours (ADR 0676)", () => {
  it("what waited goes at 7am; one whose class started before then is expired, its words and device cleared", async () => {
    const seven = "2031-01-02T07:00:00.000Z";
    const goes = await waiting(seven, "2031-01-02T09:00:00.000Z", "text");
    const late = await waiting(seven, "2031-01-02T06:30:00.000Z");
    const notYet = await waiting("2031-01-03T07:00:00.000Z", null);
    const released = await releaseWaitingRoutineMessages(db.query, seven);
    expect(released.ready).toContainEqual({ id: goes, channel: "text" });
    expect(released.ready.map((r) => r.id)).not.toContain(late);
    expect(released.expired).toBeGreaterThanOrEqual(1);
    const row = (id: string) =>
      env.DB.prepare("SELECT status, recipient, body FROM core_routine_mail WHERE id = ?")
        .bind(id)
        .first();
    expect(await row(goes)).toEqual({
      status: "ready",
      recipient: "device_1",
      body: "Strength at 06:30.",
    });
    expect(await row(late)).toEqual({ status: "expired", recipient: "", body: null });
    expect(await row(notYet)).toMatchObject({ status: "waiting" });
    // Released once: the next tick finds nothing more of these.
    const again = await releaseWaitingRoutineMessages(db.query, seven);
    expect(again.ready.map((r) => r.id)).not.toContain(goes);
  });
});

// --- Host kinds --------------------------------------------------------------------------------

let admin: ActingUser;
const KIND = `note${Date.now().toString(36)}`;

beforeAll(async () => {
  admin = await createUser("admin");
  await setPreset("balanced");
  declareHostRoutineKind(KIND, {
    label: "Order notes",
    description: "A note about a paid order, from host code.",
    about: "order",
    channels: ["email", "text", "push"],
    open: { screen: "orders" },
    slots: { total: { field: "total", format: "money", currency: "currency" } },
    messages: {
      note: {
        subject: "About your order",
        text: "Your order of {total} is noted.",
        textMessage: "Your order of {total} is noted.",
        push: { title: "Order noted", body: "Your order of {total}." },
      },
    },
  });
});

/** A paid order the host made, marked as the host's own. */
async function paidOrder(email: string): Promise<string> {
  const id = `ord_${unique("o")}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO core_order (id, state, email, currency, total, paid, placed_as, created_at, updated_at)
     VALUES (?, 'paid', ?, 'AUD', 2500, 2500, 'public', ?, ?)`,
  )
    .bind(id, email.toLowerCase(), now, now)
    .run();
  // The order's creation is the host's; its total, as a verified payment event writes it (the
  // standing host kinds' own columns get in step 2), stands as a default here.
  for (const [field, value, standing] of [
    ["$created", "", "host"],
    ["total", 2500, "default"],
    ["currency", "AUD", "default"],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO core_value_mark (object_type, record_id, field, value_hash, standing, at)
       VALUES ('order', ?, ?, ?, ?, ?)`,
    )
      .bind(id, field, await valueHash(value), standing, now)
      .run();
  }
  return id;
}

const rowsOf = async (recordId: string) =>
  (
    await env.DB.prepare(
      "SELECT kind, extension_id, channel, status, routine, held_reason, automation_id, run_id, trigger_type, error FROM core_routine_mail WHERE record_id = ? ORDER BY created_at, channel",
    )
      .bind(recordId)
      .all()
  ).results;

describe("host kinds (ADR 0670)", () => {
  it("are declared with the same contract checks as a pack's", () => {
    expect(hostRoutineKind(KIND)?.about).toBe("order");
    expect(() =>
      declareHostRoutineKind("bad", {
        label: "Bad",
        description: "Words with a link.",
        about: "order",
        messages: { one: { subject: "Pay", text: "Pay at https://evil.test" } },
      }),
    ).toThrow(/link, an address or markup/);
    expect(() =>
      declareHostRoutineKind("tooLong", {
        label: "Long",
        description: "A push too long.",
        about: "order",
        channels: ["email", "push"],
        open: { screen: "orders" },
        slots: { state: { field: "state", max: 200 } },
        messages: { one: { subject: "S", text: "T", push: { title: "{state}", body: "B" } } },
      }),
    ).toThrow(/at most 60/);
  });

  it("are listed as the host's, off until a human admin turns them on: off writes an off row and sends nothing", async () => {
    const kind = (await routineKinds(db.query)).find((k) => k.id === `core.${KIND}`);
    expect(kind).toMatchObject({ host: true, on: false, extensionId: "core" });
    const order = await paidOrder(`${unique("off")}@buyers.test`);
    const prepared = await prepareHostRoutineMail(db.query, {
      kind: KIND,
      record: order,
      occasion: "first",
      connectionId: "con_x",
    });
    expect(prepared).toMatchObject({ off: true, toSend: [], phone: [] });
    expect(await rowsOf(order)).toEqual([
      expect.objectContaining({ kind: `core.${KIND}`, channel: "email", status: "off" }),
    ]);
  });

  it("turned on: an email row with no automation, started by the host; the same occasion sends nothing twice", async () => {
    await invokeByName(
      "routineMail.settings.update",
      { kinds: { [`core.${KIND}`]: true } },
      context(admin),
    );
    const order = await paidOrder(`${unique("on")}@buyers.test`);
    const first = await prepareHostRoutineMail(db.query, {
      kind: KIND,
      record: order,
      occasion: "evt_1",
      connectionId: "con_x",
    });
    expect(first.toSend).toEqual([{ id: expect.any(String), routine: true }]);
    // An order's own address is not a Person's phone or app: email only.
    expect(first.phone).toEqual([]);
    expect(await rowsOf(order)).toEqual([
      {
        kind: `core.${KIND}`,
        extension_id: "core",
        channel: "email",
        status: "ready",
        routine: 1,
        held_reason: null,
        automation_id: null,
        run_id: null,
        trigger_type: "host",
        error: null,
      },
    ]);
    const again = await prepareHostRoutineMail(db.query, {
      kind: KIND,
      record: order,
      occasion: "evt_1",
      connectionId: "con_x",
    });
    expect(again.toSend.map((r) => r.id)).toEqual(first.toSend.map((r) => r.id));
    await prepareHostRoutineMail(db.query, {
      kind: KIND,
      record: order,
      occasion: "evt_2",
      connectionId: "con_x",
    });
    expect(await rowsOf(order)).toHaveLength(2);
  });

  it("with no email channel set in Settings → Notification delivery, the email is kept, failed, and nothing is sent", async () => {
    const order = await paidOrder(`${unique("nochannel")}@buyers.test`);
    let called = 0;
    const result = await sendHostRoutineMessage(
      {
        db: db.query,
        integrations: {
          sendRoutineMessage: async () => {
            called += 1;
            return { status: "sent" };
          },
        } as never,
      },
      { kind: KIND, record: order, occasion: "evt_1" },
    );
    expect(called).toBe(0);
    expect(result).toMatchObject({ sent: 0 });
    expect(await rowsOf(order)).toEqual([
      expect.objectContaining({
        status: "failed",
        error: "No email channel is set in Settings → Notification delivery",
      }),
    ]);
  });

  it("a kind the host does not declare, or a pack's kind named as the host's, is refused", async () => {
    const order = await paidOrder(`${unique("undeclared")}@buyers.test`);
    await expect(
      prepareHostRoutineMail(db.query, {
        kind: "nope",
        record: order,
        occasion: "x",
        connectionId: null,
      }),
    ).rejects.toThrow(/declares no routine message/);
    await expect(
      prepareHostRoutineMail(db.query, {
        kind: KIND,
        record: order,
        occasion: "x",
        connectionId: null,
        values: { total: 1 },
      }),
    ).rejects.toThrow(/filled by the host/);
  });
});

describe("the channel switches, a human admin's only", () => {
  it("text and push are switched on per kind, only channels it declares; an AI cannot", async () => {
    const id = `core.${KIND}`;
    const out = (await invokeByName(
      "routineMail.settings.update",
      { channels: { [id]: { push: true } }, quietHours: { start: "22:00", end: "06:30" } },
      context(admin),
    )) as { channels: Record<string, unknown>; quietHours: unknown; textOnlyWithoutApp: boolean };
    expect(out.channels[id]).toEqual({ push: true });
    expect(out).toMatchObject({
      quietHours: { start: "22:00", end: "06:30" },
      textOnlyWithoutApp: true,
    });
    const view = (await invokeByName("routineMail.get", {}, context(admin))) as {
      kinds: {
        id: string;
        channels: { channel: string; on: boolean }[];
        essential: boolean;
        host: boolean;
      }[];
      quietHours: unknown;
    };
    expect(view.kinds.find((k) => k.id === id)).toMatchObject({
      host: true,
      essential: true,
      channels: [
        { channel: "email", on: true },
        { channel: "text", on: false },
        { channel: "push", on: true },
      ],
    });
    for (const actor of ["assistant", "mcp"] as const) {
      await expect(
        invokeByName(
          "routineMail.settings.update",
          { channels: { [id]: { text: true } } },
          context(admin, {
            actor,
            origin:
              actor === "mcp"
                ? { surface: "mcp", sessionId: unique("s") }
                : { surface: "assistant", sessionId: unique("s") },
          }),
        ),
      ).rejects.toThrow();
    }
    await expect(
      invokeByName(
        "routineMail.settings.update",
        { channels: { "nope.kind": { text: true } } },
        context(admin),
      ),
    ).rejects.toThrow(/declares routine email/);
    await invokeByName(
      "routineMail.settings.update",
      { channels: { [id]: { push: false } }, quietHours: QUIET },
      context(admin),
    );
  });
});
