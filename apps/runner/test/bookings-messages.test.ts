// Stage 31a step 9 (ADRs 0570 to 0572) on the shipped packs: Programs, Bookings and Memberships in
// the real host and sandbox, the Bookings automations bound to a real email-send connection whose
// Email Service is the fake outbox. Acceptance criterion 13: booking (with a valid calendar file),
// promotion from the waiting list, a change and a cancellation by the gym, and the reminder before
// a class (a class type's own setting honoured) are each sent once; a coach swap sends nothing; a
// member cancelling sends nothing; a parent hears about their child's class; nothing is sent from
// an approval's dry run, and an AI's cancel of a class sends nothing until a person approves it.
//
// Sends: every operation's record events go through the real events queue to the runner's own
// consumer, which starts the runs (a tool's calls send theirs there too); a test waits for the
// runs to finish. The minute scan of the triggers counted in minutes is run with a chosen clock
// (`runMomentDateRelative`). A redelivered message, or a second tick over the same moment, starts
// nothing more.
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type AutomationQueueMessage,
  type CustomerPrincipal,
  type EventSink,
  type ExtensionHost,
  type InvocationContext,
  invokeByName,
  memoryEventSink,
  memoryRateLimit,
  type OutsideInvocationContext,
  queueEventSink,
  refreshSchemaRegistry,
  runWaitlistDue,
} from "@composable-os/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dispatchAutomationMessages, runDeferredDue } from "../src/automations/dispatch.ts";
import { runMomentDateRelative } from "../src/automations/schedule.ts";
import { integrationRuntime } from "../src/integrations/runtime.ts";
import { dispatch, setPreset } from "./automation-fixture.ts";
import { createAdmin, db, host, unique } from "./helpers.ts";

const packFiles = (glob: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(glob)
      .map(([path, text]) => [path.split("/").pop() as string, text] as const)
      .filter(([name]) => name !== "vitest.config.ts"),
  );
const files: Record<string, Record<string, string>> = {
  programs: packFiles(
    import.meta.glob<string>("../../../packs/programs/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
  bookings: packFiles(
    import.meta.glob<string>("../../../packs/bookings/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
  memberships: packFiles(
    import.meta.glob<string>("../../../packs/memberships/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
};
const OURS = new Set(Object.keys(files));

const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [
    ...(await host.shipped()).filter((s) => !OURS.has(s.id)),
    { id: "bookings", version: "0.1.0" },
    { id: "memberships", version: "0.1.0" },
    { id: "programs", version: "0.1.0" },
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

const integrations = integrationRuntime(env);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ZONE = "Australia/Sydney";
const CLASS = "bookings.class";
const BOOKING = "bookings.booking";
const AUTOMATIONS = [
  "bookingConfirmed",
  "waitlistPassedOver",
  "placeFree",
  "classChanged",
  "classCancelled",
  "classReminder",
  "dropInOrder",
];

/** Workflows started in this file skip their waits (a class change settles for two minutes). */
let introspector: Awaited<ReturnType<typeof introspectWorkflow>>;

let admin: ActingUser;
/** The events queue, as the app's own calls send to it; what was sent is kept for redelivery. */
const sent: AutomationQueueMessage[] = [];
const queue = queueEventSink(env.AUTOMATION_EVENTS);
const sink: EventSink = {
  async send(messages, options) {
    sent.push(...messages);
    await queue.send(messages, options);
  },
};
const staff = (extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user: admin,
  origin: { surface: "ui" },
  db,
  integrations,
  extensionHost: shippedHost,
  events: sink,
  ...extra,
});
const as = (principal: CustomerPrincipal): OutsideInvocationContext => ({
  principal,
  db,
  integrations,
  extensionHost: shippedHost,
  events: sink,
});
const run = <T = Record<string, unknown>>(
  name: string,
  input: unknown,
  ctx: InvocationContext | OutsideInvocationContext,
) => invokeByName(name, input, ctx) as Promise<T>;
const create = async (object: string, values: Record<string, unknown>) =>
  (await run<{ id: string }>("record.create", { object, values }, staff())).id;
const get = async (object: string, id: string) =>
  (await run<{ values: Record<string, unknown> }>("record.get", { object, id }, staff())).values;

const TERMINAL = ["completed", "failed", "skipped", "cancelled", "expired"];

/**
 * Waits until `automation` has at least `count` runs for a record and every one has finished. (A
 * record created and changed at once may start a run for each event, which the run itself tells
 * apart: what is asserted to happen once is the email.)
 */
async function finished(automation: string, recordId: string, count = 1) {
  await vi.waitFor(
    async () => {
      const runs = await runsFor(automation, recordId);
      expect(runs.length).toBeGreaterThanOrEqual(count);
      expect(runs.map((r) => r.status).filter((s) => !TERMINAL.includes(s))).toEqual([]);
    },
    { timeout: 30_000, interval: 200 },
  );
}

/** Waits until `address` has `count` emails, then a moment more, and returns them. */
async function mailsOnce(address: string, count: number): Promise<Sent[]> {
  await vi.waitFor(async () => expect(await mailTo(address)).toHaveLength(count), {
    timeout: 30_000,
    interval: 200,
  });
  return mailTo(address);
}

interface Sent {
  to: string[];
  subject: string;
  text?: string;
  attachments?: { filename: string; type: string; content: string }[];
}
async function mailTo(address: string): Promise<Sent[]> {
  const all = (await env.TEST_EMAIL_OUTBOX.list()) as Sent[];
  return all.filter((m) => m.to.includes(address.toLowerCase()));
}

async function member(label: string): Promise<CustomerPrincipal & { email: string }> {
  const tag = unique(label).toLowerCase();
  const email = `${tag}@members.test`;
  const person = await run<{ id: string }>(
    "person.create",
    { givenName: `Given-${tag}`, emails: [{ email }] },
    staff(),
  );
  const customerId = `cus_${tag}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_customer (id, person_id, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(customerId, person.id, email, now, now)
    .run();
  return { kind: "customer", customerId, personId: person.id, email };
}

async function givePass(personId: string, uses = 5): Promise<string> {
  const type = await create("memberships.passtype", {
    title: unique("Pack "),
    price: 50,
    uses,
    validDays: 60,
    status: "on_sale",
  });
  const given = await run<{ passId: string }>(
    "x.memberships.givePass",
    { personId, passTypeId: type, reason: "Integration test" },
    staff(),
  );
  return given.passId;
}

async function klass(typeId: string, inMs: number, places = 10): Promise<string> {
  const startsAt = new Date(Date.now() + inMs).toISOString();
  return create(CLASS, {
    classType: typeId,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + HOUR).toISOString(),
    timezone: ZONE,
    places,
  });
}

type Out = Record<string, unknown> & { result: string; bookingId?: string };
const book = (who: CustomerPrincipal, classId: string, extra: Record<string, unknown> = {}) =>
  run<Out>("x.bookings.book", { classId, ...extra }, as(who));

/** The runs an automation of Bookings started, by trigger record. */
async function runsFor(automation: string, recordId: string) {
  const rows = await env.DB.prepare(
    "SELECT status FROM core_automation_runs WHERE automation_id = ? AND record_id = ? AND test = 0",
  )
    .bind(`bookings.${automation}`, recordId)
    .all<{ status: string }>();
  return rows.results;
}

let type: string;

beforeAll(async () => {
  introspector = await introspectWorkflow(env.AUTOMATION_WORKFLOW);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
  admin = await createAdmin();
  // Sends are outbound actions: under Autonomous an automation's are applied at once, so they
  // reach the outbox; Balanced (routine email goes on its own, ADR 0590) is tested at the end.
  await setPreset("autonomous");
  await refreshSchemaRegistry(db.query);
  for (const id of ["programs", "bookings", "memberships"]) {
    await run("extension.install", { id, shipped: true }, staff());
  }
  await refreshSchemaRegistry(db.query);
  await run("settings.update", { timezone: ZONE }, staff()).catch(() => undefined);
  await run("integration.setVendor", { vendor: "email-send", enabled: true }, staff());
  const mail = await run<{ connection: { id: string } }>(
    "connection.create",
    { vendor: "email-send", scope: "org" },
    staff(),
  );
  await run(
    "connection.bindResource",
    {
      id: mail.connection.id,
      url: `email-send://sender/${encodeURIComponent("gym@example.com")}`,
    },
    staff(),
  );
  // Each automation that mails waits for a person to bind its connection (ADR 0170).
  for (const name of AUTOMATIONS) {
    const automation = await run<{ pausedReason: string | null }>(
      "automation.bindConnection",
      { id: `bookings.${name}`, slot: "mail", connectionId: mail.connection.id },
      staff(),
    );
    expect(automation.pausedReason).toBeNull();
  }
  type = await create("programs.classtype", { name: unique("Strength") });
}, 120_000);

afterAll(async () => {
  await setPreset("balanced");
  await introspector[Symbol.asyncDispose]();
});

describe("booked (criterion 13)", () => {
  it("emails the member once, with a valid calendar file; a redelivery sends nothing more", async () => {
    const k = await klass(type, 2 * DAY);
    const who = await member("booked");
    await givePass(who.personId);
    const out = await book(who, k);
    expect(out.result).toBe("booked");
    await finished("bookingConfirmed", out.bookingId as string);
    const [mail, ...more] = await mailsOnce(who.email, 1);
    expect(more).toEqual([]);
    expect(mail?.subject).toMatch(/^Booked: /);
    expect(mail?.text).toContain("You are booked into");
    const [ics] = mail?.attachments ?? [];
    expect(ics).toMatchObject({ filename: "invite.ics" });
    expect(ics?.type).toContain("text/calendar");
    const start = String((await get(CLASS, k)).startsAt);
    const lines = (ics?.content ?? "").replace(/\r\n /g, "").split("\r\n");
    expect(lines).toEqual(
      expect.arrayContaining([
        "BEGIN:VCALENDAR",
        "METHOD:PUBLISH",
        `UID:${out.bookingId}@example.com`,
        `DTSTART:${new Date(start)
          .toISOString()
          .replace(/[-:]/g, "")
          .replace(/\.\d{3}/, "")}`,
        "END:VCALENDAR",
      ]),
    );
    expect(await runsFor("bookingConfirmed", out.bookingId as string)).toHaveLength(1);
  });

  it("tells a parent about their child's booking, naming the child; the child has no address", async () => {
    const k = await klass(type, 2 * DAY);
    const parent = await member("parent");
    const childId = (await run<{ id: string }>("person.create", { givenName: "Robin" }, staff()))
      .id;
    await run("person.link.add", { guardianId: parent.personId, dependantId: childId }, staff());
    await givePass(childId);
    const out = await book(parent, k, { forPersonId: childId });
    expect(out.result).toBe("booked");
    await finished("bookingConfirmed", out.bookingId as string);
    const [mail, ...more] = await mailsOnce(parent.email, 1);
    expect(more).toEqual([]);
    expect(mail?.subject).toMatch(/\(Robin\)$/);
    expect(mail?.text).toContain("Robin is booked into");
  });

  it("sends nothing when a member cancels their own booking", async () => {
    const k = await klass(type, 2 * DAY);
    const who = await member("cancels");
    await givePass(who.personId);
    const out = await book(who, k);
    await mailsOnce(who.email, 1);
    const preview = await run<Out>("x.bookings.cancel", { bookingId: out.bookingId }, as(who));
    expect(preview).toMatchObject({ result: "preview", state: "cancelled" });
    await run(
      "x.bookings.cancel",
      { bookingId: out.bookingId, confirm: true, expect: "cancelled" },
      as(who),
    );
    // Its place was given back after the cut-off? No: two days ahead, the waiting list's.
    await finished("placeFree", out.bookingId as string);
    expect(await mailTo(who.email)).toHaveLength(1);
  });
});

describe("the waiting list (criterion 5's emails)", () => {
  it("a waiter moved in is emailed once that they are in", async () => {
    const k = await klass(type, 2 * DAY, 1);
    const first = await member("first");
    const second = await member("second");
    await givePass(first.personId);
    await givePass(second.personId);
    const a = await book(first, k);
    await mailsOnce(first.email, 1);
    const b = await book(second, k);
    expect([a.result, b.result]).toEqual(["booked", "waiting"]);
    await run(
      "x.bookings.cancel",
      { bookingId: a.bookingId, confirm: true, expect: "cancelled" },
      as(first),
    );
    await runWaitlistDue(db, { events: sink });
    expect((await get(BOOKING, b.bookingId as string)).state).toBe("booked");
    await finished("bookingConfirmed", b.bookingId as string);
    const mails = await mailsOnce(second.email, 1);
    expect(mails.map((m) => m.subject)).toEqual([expect.stringMatching(/^You're in: /)]);
    expect(mails[0]?.attachments?.[0]?.filename).toBe("invite.ics");
    // The member who cancelled heard only of their own booking.
    expect((await mailTo(first.email)).map((m) => m.subject)).toEqual([
      expect.stringMatching(/^Booked: /),
    ]);
  });
});

describe("a change or a cancellation by the gym (criterion 13)", () => {
  it("a coach swap sends nothing; a new time sends each member one email with an updated file", async () => {
    const k = await klass(type, 2 * DAY);
    const who = await member("change");
    await givePass(who.personId);
    await book(who, k);
    await mailsOnce(who.email, 1);
    const coach = await create("bookings.coach", { name: unique("Coach") });
    await run("record.update", { object: CLASS, id: k, values: { coach } }, staff());
    // The coach swap's run finds nothing to tell (decision 16).
    await finished("classChanged", k);
    expect(await mailTo(who.email)).toHaveLength(1);
    const later = new Date(Date.now() + 2 * DAY + HOUR).toISOString();
    await run(
      "record.update",
      {
        object: CLASS,
        id: k,
        values: { startsAt: later, endsAt: new Date(Date.parse(later) + HOUR).toISOString() },
      },
      staff(),
    );
    const mails = await mailsOnce(who.email, 2);
    expect(mails[1]?.subject).toMatch(/^Class changed: /);
    expect(mails[1]?.attachments?.[0]?.content).toMatch(/SEQUENCE:[1-9]\d*/);
    // The queue delivers the change again: no second run, no second email.
    await finished("classChanged", k, 2);
    await dispatch(sent.filter((m) => JSON.stringify(m).includes(k)));
    await finished("classChanged", k, 2);
    expect(await mailTo(who.email)).toHaveLength(2);
  });

  it("cancelling a class emails each member once; an AI's request sends nothing until approved", async () => {
    const k = await klass(type, 2 * DAY);
    const who = await member("cancelled");
    const other = await member("cancelled2");
    await givePass(who.personId);
    await givePass(other.personId);
    await book(who, k);
    await book(other, k);
    await mailsOnce(who.email, 1);
    await mailsOnce(other.email, 1);
    const asked = await run(
      "x.bookings.cancelClass",
      { classId: k, reason: "The coach is unwell" },
      staff({ actor: "assistant" }),
    ).catch((e: { code?: string; details?: { actionId?: string } }) => e);
    expect((asked as { code?: string }).code).toBe("pending_approval");
    // Queued with its dry run: nothing changed, nothing started, nothing sent.
    expect((await get(CLASS, k)).state).toBe("scheduled");
    expect(await runsFor("classCancelled", k)).toEqual([]);
    expect(await mailTo(who.email)).toHaveLength(1);
    const actionId = String((asked as { details?: { actionId?: string } }).details?.actionId);
    const approve = (confirm?: string) =>
      run("approval.approve", { actionIds: [actionId], ...(confirm ? { confirm } : {}) }, staff());
    await approve().catch(async (error: { details?: { confirmLabel?: string } }) => {
      const label = error.details?.confirmLabel;
      if (!label) throw error;
      return approve(label);
    });
    expect((await get(CLASS, k)).state).toBe("cancelled");
    await finished("classCancelled", k);
    for (const person of [who, other]) {
      const mails = await mailsOnce(person.email, 2);
      expect(mails.map((m) => m.subject)).toEqual([
        expect.stringMatching(/^Booked: /),
        expect.stringMatching(/^Cancelled by the gym: /),
      ]);
      expect(mails[1]?.text).toContain("The reason: The coach is unwell");
      expect(mails[1]?.attachments?.[0]?.content).toContain("METHOD:CANCEL");
    }
    // The reminder of a cancelled class is never sent (its conditions: scheduled).
    const startsAt = Date.parse(String((await get(CLASS, k)).startsAt));
    await runMomentDateRelative(env, new Date(startsAt - 180 * MINUTE + MINUTE));
    expect(await runsFor("classReminder", k)).toEqual([]);
  });
});

describe("the reminder (criterion 13)", () => {
  it("is sent once, 3 hours before by default, to those booked, and not to someone who cancelled", async () => {
    const k = await klass(type, 2 * DAY);
    const stays = await member("stays");
    const goes = await member("goes");
    await givePass(stays.personId);
    await givePass(goes.personId);
    await book(stays, k);
    const left = await book(goes, k);
    await mailsOnce(goes.email, 1);
    await run(
      "x.bookings.cancel",
      { bookingId: left.bookingId, confirm: true, expect: "cancelled" },
      as(goes),
    );
    await mailsOnce(stays.email, 1);
    const startsAt = Date.parse(String((await get(CLASS, k)).startsAt));
    // Before the moment: nothing. At it, and on the next two ticks: one run, one email.
    await runMomentDateRelative(env, new Date(startsAt - 181 * MINUTE));
    expect(await runsFor("classReminder", k)).toEqual([]);
    for (const late of [0, 1, 2]) {
      await runMomentDateRelative(env, new Date(startsAt - 180 * MINUTE + late * MINUTE));
    }
    await finished("classReminder", k);
    expect((await mailsOnce(stays.email, 2)).map((m) => m.subject)).toEqual([
      expect.stringMatching(/^Booked: /),
      expect.stringMatching(/^Reminder: /),
    ]);
    expect((await mailTo(goes.email)).map((m) => m.subject)).toEqual([
      expect.stringMatching(/^Booked: /),
    ]);
  });

  it("honours the class type's own setting", async () => {
    const own = await create("programs.classtype", {
      name: unique("Yoga"),
      "bookings.reminderMinutes": 60,
    });
    const k = await klass(own, 2 * DAY);
    const startsAt = Date.parse(String((await get(CLASS, k)).startsAt));
    await runMomentDateRelative(env, new Date(startsAt - 180 * MINUTE));
    expect(await runsFor("classReminder", k)).toEqual([]);
    await runMomentDateRelative(env, new Date(startsAt - 59 * MINUTE));
    await finished("classReminder", k);
  });
});

describe("under Balanced (routine mail, ADR 0590)", () => {
  it("a member's confirmation is routine email: it goes on its own, and nothing waits", async () => {
    await setPreset("balanced");
    try {
      const k = await klass(type, 2 * DAY);
      const who = await member("balanced");
      await givePass(who.personId);
      const out = await book(who, k);
      await finished("bookingConfirmed", out.bookingId as string);
      const [mail] = await mailsOnce(who.email, 1);
      expect(mail?.subject).toMatch(/^Booked: /);
      const row = await env.DB.prepare(
        "SELECT status, routine, recipient_rule, pending_action_id FROM core_routine_mail WHERE record_id = ? AND kind = 'bookings.confirmation'",
      )
        .bind(out.bookingId)
        .first();
      expect(row).toEqual({
        status: "sent",
        routine: 1,
        recipient_rule: "person",
        pending_action_id: null,
      });
    } finally {
      await setPreset("autonomous");
    }
  });
});

describe("the family link at send time (ADR 0540)", () => {
  it("a parent whose link ended, or who is in the Trash, is not written to", async () => {
    const k = await klass(type, 2 * DAY);
    const live = await member("live");
    const ended = await member("ended");
    const trashed = await member("trashed");
    const childId = (await run<{ id: string }>("person.create", { givenName: "Kai" }, staff())).id;
    const links: Record<string, string> = {};
    for (const parent of [live, ended, trashed]) {
      links[parent.personId] = (
        await run<{ id: string }>(
          "person.link.add",
          { guardianId: parent.personId, dependantId: childId },
          staff(),
        )
      ).id;
    }
    await run("person.link.end", { id: links[ended.personId], reason: "Test" }, staff());
    await run("person.delete", { id: trashed.personId }, staff());
    await givePass(childId);
    const out = await book(live, k, { forPersonId: childId });
    expect(out.result).toBe("booked");
    await finished("bookingConfirmed", out.bookingId as string);
    expect((await mailsOnce(live.email, 1))[0]?.subject).toMatch(/\(Kai\)$/);
    expect(await mailTo(ended.email)).toEqual([]);
    expect(await mailTo(trashed.email)).toEqual([]);
  });
});

describe("a reminder for a class moved after its reminder went", () => {
  it("is sent again for the new time, once", async () => {
    const k = await klass(type, 2 * DAY);
    const who = await member("moved");
    await givePass(who.personId);
    await book(who, k);
    await mailsOnce(who.email, 1);
    const first = Date.parse(String((await get(CLASS, k)).startsAt));
    await runMomentDateRelative(env, new Date(first - 180 * MINUTE));
    await finished("classReminder", k);
    const later = first + DAY;
    await run(
      "record.update",
      {
        object: CLASS,
        id: k,
        values: {
          startsAt: new Date(later).toISOString(),
          endsAt: new Date(later + HOUR).toISOString(),
        },
      },
      staff(),
    );
    await finished("classChanged", k);
    // The old moment again: nothing. The new one: a second reminder.
    await runMomentDateRelative(env, new Date(first - 180 * MINUTE + MINUTE));
    await runMomentDateRelative(env, new Date(later - 180 * MINUTE));
    await runMomentDateRelative(env, new Date(later - 180 * MINUTE + MINUTE));
    await finished("classReminder", k, 2);
    expect(await runsFor("classReminder", k)).toHaveLength(2);
    const reminders = (await mailsOnce(who.email, 4)).filter((m) =>
      m.subject.startsWith("Reminder:"),
    );
    expect(reminders).toHaveLength(2);
  });
});

describe("the booking link is a person's to change", () => {
  it("an assistant's change waits for a person", async () => {
    const asked = await run(
      "extensionSettings.update",
      { extension: "bookings", values: { bookingsUrl: "https://elsewhere.test/phish" } },
      staff({ actor: "assistant" }),
    ).catch((e: { code?: string }) => e);
    expect((asked as { code?: string }).code).toBe("pending_approval");
  });
});

describe("a closure of more classes than the runs-per-minute rail (ADR 0573)", () => {
  it("tells every member once: the runs past the rail wait their turn, none is lost", async () => {
    const COUNT = 70;
    // Ten days ahead, in UTC, a day no other class of this file is on.
    const day = new Date(Date.now() + 10 * DAY);
    day.setUTCHours(0, 0, 0, 0);
    const date = day.toISOString().slice(0, 10);
    const people: { personId: string; email: string }[] = [];
    for (let i = 0; i < COUNT; i++) {
      const startsAt = new Date(day.getTime() + (6 * 60 + i * 10) * MINUTE).toISOString();
      const classId = await create(CLASS, {
        classType: type,
        startsAt,
        endsAt: new Date(Date.parse(startsAt) + 5 * MINUTE).toISOString(),
        timezone: "UTC",
        places: 5,
      });
      const email = `${unique("closed").toLowerCase()}@members.test`;
      const personId = (
        await run<{ id: string }>(
          "person.create",
          { givenName: `Closed ${i}`, emails: [{ email }] },
          staff(),
        )
      ).id;
      const booked = await run<Out>(
        "x.bookings.bookFor",
        { classId, personId, paidAtDesk: true },
        staff(),
      );
      expect(booked.result).toBe("booked");
      people.push({ personId, email });
    }
    // The closure's own events, dispatched with a rail of 60 runs a minute.
    const closureSink = memoryEventSink();
    const closure = { name: "Holiday", fromDate: date, untilDate: date };
    const asked = await run(
      "record.create",
      { object: "bookings.closure", values: closure },
      staff(),
    ).catch((e: { details?: { count?: number } }) => e);
    const count = (asked as { details?: { count?: number } }).details?.count ?? COUNT;
    await run(
      "recurring.close",
      { object: "bookings.closure", values: closure, confirm: count },
      staff({ events: closureSink }),
    );
    const limiter = memoryRateLimit(60);
    const limited = { ...env, AUTOMATION_RATE_LIMIT: limiter };
    const result = await dispatchAutomationMessages(limited, closureSink.messages);
    expect(result.paused).toEqual([]);
    expect(result.deferred).toBeGreaterThanOrEqual(COUNT - 60);
    // The next tick, the rail allows the rest.
    limiter.reset();
    const drained = await runDeferredDue(limited, new Date(Date.now() + 2 * MINUTE));
    expect(drained.started).toBeGreaterThanOrEqual(COUNT - 60);
    for (const person of people) {
      await vi.waitFor(
        async () =>
          expect(
            (await mailTo(person.email)).filter((m) =>
              m.subject.startsWith("Cancelled by the gym"),
            ),
          ).toHaveLength(1),
        { timeout: 60_000, interval: 250 },
      );
    }
    const row = await env.DB.prepare(
      "SELECT paused_reason FROM core_automations WHERE id = 'bookings.classCancelled'",
    ).first<{ paused_reason: string | null }>();
    expect(row?.paused_reason).toBeNull();
  }, 600_000);
});
