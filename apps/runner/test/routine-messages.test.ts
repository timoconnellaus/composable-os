// Routine messages on the shipped packs (stage 30 step 1, ADRs 0670 and 0676), through a real
// email-send gatekeeper and the fake Email Service, under the default (Balanced) preset:
//   - with a kind's text and push switched on, each recipient gets a row per channel: the email
//     as before, and a push and a text kept `no_channel` while nobody can be reached that way
//     (the text and push steps are not built), the email unchanged;
//   - with a way to reach people (the seam those steps fill): a member with the app gets a push
//     and no text, one with a textable mobile a text, one with neither email only;
//   - a class title an AI changed holds the email, the text and the push alike;
//   - quiet hours hold a text or push (never the email): a 6:30am class's reminder prepared at
//     11pm expires at 7am, a 9am class's goes then; an urgent cancellation of a 6am class goes at
//     once, of next week's class waits;
//   - a host kind's email, asked for by host code, goes through the same queue and gatekeeper;
//   - preparing one message for one recipient on every channel reads a bounded number of
//     statements (the cost test).
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type ChannelReach,
  type CustomerPrincipal,
  declareHostRoutineKind,
  type ExtensionHost,
  type InvocationContext,
  invokeByName,
  newId,
  type OutsideInvocationContext,
  prepareRoutineMail,
  queueEventSink,
  refreshSchemaRegistry,
  releaseWaitingRoutineMessages,
  sendHostRoutineMessage,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { integrationRuntime } from "../src/integrations/runtime.ts";
import { setPreset } from "./automation-fixture.ts";
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
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CLASS = "bookings.class";
const SITE = "https://gym.example";
const ZONE = "Australia/Sydney";

let introspector: Awaited<ReturnType<typeof introspectWorkflow>>;
let admin: ActingUser;
let mailConnection: string;
const sink = queueEventSink(env.AUTOMATION_EVENTS);
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
const mcp = () =>
  staff({ actor: "mcp", origin: { surface: "mcp", sessionId: unique("cap"), clientName: "Bot" } });

interface Row {
  id: string;
  kind: string;
  channel: string;
  status: string;
  routine: number;
  held_reason: string | null;
  recipient: string;
  recipient_person_id: string | null;
  subject: string | null;
  body: string | null;
  segments: number | null;
  wait_until: string | null;
  until_at: string | null;
  error: string | null;
}
const rowsOf = async (recordId: string, runId?: string): Promise<Row[]> =>
  (
    await env.DB.prepare(
      `SELECT * FROM core_routine_mail WHERE record_id = ?${runId ? " AND run_id = ?" : ""} ORDER BY channel, created_at`,
    )
      .bind(...(runId ? [recordId, runId] : [recordId]))
      .all<Row>()
  ).results;

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

async function givePass(personId: string): Promise<void> {
  const type = await create("memberships.passtype", {
    title: unique("Pack "),
    price: 50,
    uses: 10,
    validDays: 60,
    status: "on_sale",
  });
  await run(
    "x.memberships.givePass",
    { personId, passTypeId: type, reason: "Integration test" },
    staff(),
  );
}

let type: string;
async function klass(startsAt = new Date(Date.now() + 2 * DAY).toISOString()): Promise<string> {
  return create(CLASS, {
    classType: type,
    title: "Strength",
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + HOUR).toISOString(),
    timezone: ZONE,
    places: 10,
  });
}

/** A booked member: a booking of theirs, made by them, in a class. */
async function booking(label: string, classId?: string) {
  const who = await member(label);
  await givePass(who.personId);
  const k = classId ?? (await klass());
  const out = await run<{ result: string; bookingId: string }>(
    "x.bookings.book",
    { classId: k, ...{} },
    as(who),
  );
  expect(out.result).toBe("booked");
  return { who, classId: k, bookingId: out.bookingId };
}

/** A recorded run of one of Bookings' automations about a booking, as the runner starts one. */
async function runOf(automation: string, bookingId: string, triggerType: string): Promise<string> {
  const id = newId("automationRun");
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO core_automation_runs (id, automation_id, extension_id, trigger, record_object,
       record_id, status, started_at, updated_at)
     VALUES (?, ?, 'bookings', ?, 'bookings.booking', ?, 'running', ?, ?)`,
  )
    .bind(id, `bookings.${automation}`, JSON.stringify({ type: triggerType }), bookingId, now, now)
    .run();
  return id;
}

/** The seam the text and push steps fill: who has the app, who a textable mobile. */
function reachOf(app: Set<string>, mobile: Set<string>): ChannelReach {
  return {
    push: async (_db, personId) =>
      app.has(personId)
        ? { to: `device:${personId}`, key: `push:${personId}` }
        : { reason: "no device" },
    text: async (_db, personId) =>
      mobile.has(personId)
        ? { to: "+61400000000", key: `text:${personId}` }
        : { reason: "no number" },
  };
}

const prepare = (
  automation: string,
  runId: string,
  send: Record<string, unknown>,
  extra: { reach?: ChannelReach; now?: string; db?: typeof db.query } = {},
) =>
  prepareRoutineMail(extra.db ?? db.query, {
    extensionId: "bookings",
    automationId: `bookings.${automation}`,
    runId,
    connectionId: mailConnection,
    send,
    ...(extra.reach ? { reach: extra.reach } : {}),
    ...(extra.now ? { now: extra.now } : {}),
  });

const setting = (key: string, value: unknown) =>
  env.DB.prepare(
    "INSERT INTO core_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, JSON.stringify(value), new Date().toISOString())
    .run();

beforeAll(async () => {
  introspector = await introspectWorkflow(env.AUTOMATION_WORKFLOW);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
  admin = await createAdmin();
  await setPreset("balanced");
  await refreshSchemaRegistry(db.query);
  for (const id of ["programs", "bookings", "memberships"]) {
    await run("extension.install", { id, shipped: true }, staff());
  }
  await refreshSchemaRegistry(db.query);
  await run("integration.setVendor", { vendor: "email-send", enabled: true }, staff());
  const mail = await run<{ connection: { id: string } }>(
    "connection.create",
    { vendor: "email-send", scope: "org" },
    staff(),
  );
  mailConnection = mail.connection.id;
  await run(
    "connection.bindResource",
    { id: mailConnection, url: `email-send://sender/${encodeURIComponent("gym@example.com")}` },
    staff(),
  );
  for (const name of ["bookingConfirmed", "classCancelled", "classReminder"]) {
    await run(
      "automation.bindConnection",
      { id: `bookings.${name}`, slot: "mail", connectionId: mailConnection },
      staff(),
    );
  }
  await run(
    "routineMail.settings.update",
    {
      siteOrigin: SITE,
      packs: { bookings: true },
      // A human admin's, in the routine settings: never the general name and zone (the review
      // of PR #339).
      senderName: "Example Gym",
      quietZone: ZONE,
      channels: {
        "bookings.confirmation": { text: true, push: true },
        "bookings.reminder": { text: true, push: true },
        "bookings.cancellation": { text: true, push: true },
      },
    },
    staff(),
  );
  await run(
    "extensionSettings.update",
    { extension: "bookings", values: { bookingsUrl: `${SITE}/bookings` } },
    staff(),
  );
  // The general settings, which others may change, say something else: texts never read them.
  await setting("org_name", "Example Fitness Company");
  await setting("org_timezone", ZONE);
  type = await create("programs.classtype", { name: unique("Strength") });
}, 120_000);

afterAll(async () => {
  await setPreset("balanced");
  await introspector[Symbol.asyncDispose]();
});

describe("a row per channel", { timeout: 60_000 }, () => {
  it("text and push switched on: the email goes as before, the text and push are kept no_channel while nobody can be reached", async () => {
    const { who, bookingId } = await booking("channels");
    let rows: Row[] = [];
    await vi.waitFor(
      async () => {
        rows = await rowsOf(bookingId);
        expect(rows.find((r) => r.channel === "email")?.status).toBe("sent");
      },
      { timeout: 30_000, interval: 200 },
    );
    expect(rows.map((r) => [r.channel, r.status])).toEqual([
      ["email", "sent"],
      ["push", "no_channel"],
      ["text", "no_channel"],
    ]);
    // Nothing of the number or device, and no words, on a row that cannot go.
    for (const row of rows.filter((r) => r.channel !== "email")) {
      expect(row).toMatchObject({ recipient: "", subject: null, body: null, routine: 1 });
      expect(row.recipient_person_id).toBe(who.personId);
    }
    const log = await run<{ items: { id: string; channel: string; status: string }[] }>(
      "routineMail.log",
      { kind: "bookings.confirmation", channel: "push" },
      staff(),
    );
    expect(log.items.find((i) => i.id === rows[1]?.id)).toMatchObject({
      channel: "push",
      status: "no_channel",
    });
  });

  it("with the app a push and no text; without it a text to a textable mobile; with neither, email only", async () => {
    const k = await klass();
    const withApp = await booking("app", k);
    const withMobile = await booking("mobile", k);
    const neither = await booking("neither", k);
    const reach = reachOf(
      new Set([withApp.who.personId]),
      new Set([withApp.who.personId, withMobile.who.personId]),
    );
    const statuses: Record<string, string[][]> = {};
    for (const b of [withApp, withMobile, neither]) {
      const runId = await runOf("bookingConfirmed", b.bookingId, "record");
      await prepare(
        "bookingConfirmed",
        runId,
        { kind: "confirmation", record: b.bookingId, message: "booked" },
        { reach },
      );
      statuses[b.who.personId] = (await rowsOf(b.bookingId, runId)).map((r) => [
        r.channel,
        r.status,
        r.error ?? "",
      ]);
    }
    expect(statuses[withApp.who.personId]).toEqual([
      ["email", "ready", ""],
      ["push", "ready", ""],
      ["text", "no_channel", "reached by push (text only without the app)"],
    ]);
    expect(statuses[withMobile.who.personId]).toEqual([
      ["email", "ready", ""],
      ["push", "no_channel", "no device"],
      ["text", "ready", ""],
    ]);
    expect(statuses[neither.who.personId]).toEqual([
      ["email", "ready", ""],
      ["push", "no_channel", "no device"],
      ["text", "no_channel", "no number"],
    ]);
    // The words: the business's name first, the stop line last; a push's title and line.
    const runId = await runOf("bookingConfirmed", withMobile.bookingId, "record");
    await prepare(
      "bookingConfirmed",
      runId,
      { kind: "confirmation", record: withMobile.bookingId, message: "booked" },
      { reach },
    );
    const text = (await rowsOf(withMobile.bookingId, runId)).find((r) => r.channel === "text");
    expect(text?.body).toMatch(
      /^Example Gym: Booked: Strength, \w+day \d+ \w+ at \d\d:\d\d\. Reply STOP to stop$/,
    );
    expect(text).toMatchObject({ segments: 1, recipient: "+61400000000", routine: 1 });
    // The log never shows the number, even while the text waits to go.
    const log = await run<{ items: { id: string; recipient: string }[] }>(
      "routineMail.log",
      { channel: "text" },
      staff(),
    );
    expect(log.items.find((i) => i.id === text?.id)?.recipient).toBe("");
    const pushRunId = await runOf("bookingConfirmed", withApp.bookingId, "record");
    await prepare(
      "bookingConfirmed",
      pushRunId,
      { kind: "confirmation", record: withApp.bookingId, message: "booked" },
      { reach },
    );
    const push = (await rowsOf(withApp.bookingId, pushRunId)).find((r) => r.channel === "push");
    expect(push?.subject).toMatch(/^Booked for \w+day \d+ \w+$/);
    expect(push?.body).toMatch(/^Strength at \d\d:\d\d\.$/);
  });

  it("a class title an AI changed holds the email, the text and the push alike", async () => {
    const k = await klass();
    const b = await booking("ai-title", k);
    await run(
      "record.update",
      { object: CLASS, id: k, values: { title: "Strength and more" } },
      mcp(),
    );
    const everyone = new Set([b.who.personId]);
    const runId = await runOf("bookingConfirmed", b.bookingId, "record");
    await prepare(
      "bookingConfirmed",
      runId,
      { kind: "confirmation", record: b.bookingId, message: "booked" },
      { reach: reachOf(everyone, everyone) },
    );
    const rows = await rowsOf(b.bookingId, runId);
    expect(rows.map((r) => [r.channel, r.routine, r.status])).toEqual([
      ["email", 0, "ready"],
      // Held for a person: never `ready`, the state a sender acts on (the review of PR #339).
      ["push", 0, "held"],
      ["text", 0, "held"],
    ]);
    for (const row of rows.filter((r) => r.channel !== "text")) {
      expect(row.held_reason).toMatch(/no person stands behind bookings\.class \S+'s title \(ai\)/);
    }
    // The text is held too (the push reached them, so it is not sent at all; held all the same).
    expect(rows[2]?.held_reason).toMatch(/title \(ai\)/);
  });
});

describe("what an AI may change does not reach a text (the review of PR #339)", {
  timeout: 60_000,
}, () => {
  it("an MCP client renaming the organisation changes nothing a text begins with", async () => {
    const b = await booking("ai-name");
    const reach = reachOf(new Set(), new Set([b.who.personId]));
    await run("settings.update", { orgName: "Gym: book free now" }, mcp());
    const runId = await runOf("classReminder", b.bookingId, "dateRelative");
    await prepare("classReminder", runId, { kind: "reminder", record: b.bookingId }, { reach });
    const text = (await rowsOf(b.bookingId, runId)).find((r) => r.channel === "text");
    expect(text?.body).toMatch(/^Example Gym: Reminder: /);
    expect(text?.body).not.toMatch(/book free/);
    await setting("org_name", "Example Fitness Company");
  });

  it("an MCP client changing the organisation's time zone does not move quiet hours", async () => {
    const local = (days: number, clock: string) => {
      const day = new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
      const at = Date.parse(`${day}T${clock}:00+11:00`);
      const shown = new Intl.DateTimeFormat("en-GB", {
        timeZone: ZONE,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(at));
      return shown === clock ? at : at + HOUR;
    };
    await run("settings.update", { timezone: "Europe/London" }, mcp());
    try {
      const b = await booking("ai-zone", await klass(new Date(local(6, "09:00")).toISOString()));
      const runId = await runOf("classReminder", b.bookingId, "dateRelative");
      await prepare(
        "classReminder",
        runId,
        { kind: "reminder", record: b.bookingId },
        {
          reach: reachOf(new Set(), new Set([b.who.personId])),
          now: new Date(local(5, "23:00")).toISOString(),
        },
      );
      const text = (await rowsOf(b.bookingId, runId)).find((r) => r.channel === "text");
      expect(text).toMatchObject({
        status: "waiting",
        wait_until: new Date(local(6, "07:00")).toISOString(),
      });
    } finally {
      await setting("org_timezone", ZONE);
    }
  });
});

describe("quiet hours (ADR 0676)", { timeout: 60_000 }, () => {
  /** An instant at a local time in Sydney, `days` from now (summer: +11:00). */
  const local = (days: number, clock: string) => {
    const day = new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
    const at = Date.parse(`${day}T${clock}:00+11:00`);
    // Correct for winter (+10:00): put it on that local clock.
    const shown = new Intl.DateTimeFormat("en-GB", {
      timeZone: ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(at));
    return shown === clock ? at : at + HOUR;
  };
  const everyone = (personId: string) => reachOf(new Set([personId]), new Set([personId]));

  it("a reminder at 11pm for a 6:30am class waits, then expires at 7am; its email was ready at once. A 9am class's goes at 7am", async () => {
    const elevenPm = new Date(local(5, "23:00")).toISOString();
    const early = await booking("early", await klass(new Date(local(6, "06:30")).toISOString()));
    const later = await booking("later", await klass(new Date(local(6, "09:00")).toISOString()));
    const ids: Record<string, Row[]> = {};
    for (const b of [early, later]) {
      const runId = await runOf("classReminder", b.bookingId, "dateRelative");
      await prepare(
        "classReminder",
        runId,
        { kind: "reminder", record: b.bookingId },
        {
          reach: reachOf(new Set(), new Set([b.who.personId])),
          now: elevenPm,
        },
      );
      ids[b.bookingId] = await rowsOf(b.bookingId, runId);
    }
    const sevenAm = new Date(local(6, "07:00")).toISOString();
    for (const rows of Object.values(ids)) {
      expect(rows.find((r) => r.channel === "email")?.status).toBe("ready");
      expect(rows.find((r) => r.channel === "text")).toMatchObject({
        status: "waiting",
        wait_until: sevenAm,
      });
    }
    const released = await releaseWaitingRoutineMessages(db.query, sevenAm);
    const textOf = (b: { bookingId: string }) =>
      ids[b.bookingId]?.find((r) => r.channel === "text")?.id;
    expect(released.ready.map((r) => r.id)).toContain(textOf(later));
    expect(released.ready.map((r) => r.id)).not.toContain(textOf(early));
    const status = async (id: string | undefined) =>
      (
        await env.DB.prepare("SELECT status FROM core_routine_mail WHERE id = ?")
          .bind(id)
          .first<{ status: string }>()
      )?.status;
    expect(await status(textOf(early))).toBe("expired");
    expect(await status(textOf(later))).toBe("ready");
  });

  it("an urgent cancellation of a 6am class at 5am pushes at once; of a class days away it waits until 7am", async () => {
    const fiveAm = new Date(local(1, "05:00")).toISOString();
    const soon = await booking(
      "urgent-soon",
      await klass(new Date(local(1, "06:00")).toISOString()),
    );
    const nextWeek = await booking(
      "urgent-later",
      await klass(new Date(local(5, "06:00")).toISOString()),
    );
    const out: Record<string, string[][]> = {};
    for (const b of [soon, nextWeek]) {
      const runId = await runOf("classCancelled", b.bookingId, "fieldChanged");
      await prepare(
        "classCancelled",
        runId,
        { kind: "cancellation", record: b.bookingId, values: { money: "membership" } },
        { reach: everyone(b.who.personId), now: fiveAm },
      );
      out[b.bookingId] = (await rowsOf(b.bookingId, runId)).map((r) => [r.channel, r.status]);
    }
    expect(out[soon.bookingId]).toEqual([
      ["email", "ready"],
      ["push", "ready"],
      ["text", "no_channel"],
    ]);
    expect(out[nextWeek.bookingId]).toEqual([
      ["email", "ready"],
      ["push", "waiting"],
      ["text", "no_channel"],
    ]);
  });
});

describe("a host kind's email, from host code (ADR 0670)", { timeout: 60_000 }, () => {
  it("goes through the host's email channel, the routine queue and the gatekeeper, as a pack's does", async () => {
    declareHostRoutineKind("orderThanks", {
      label: "Order thanks",
      description: "A test kind: thanks for a paid order.",
      about: "order",
      slots: { total: { field: "total", format: "money", currency: "currency" } },
      messages: { thanks: { subject: "Thank you", text: "We received {total}." } },
    });
    await run("notification.updateDeliverySettings", { email: mailConnection }, staff());
    await run("routineMail.settings.update", { kinds: { "core.orderThanks": true } }, staff());
    const email = `${unique("buyer").toLowerCase()}@buyers.test`;
    const order = `ord_${unique("o")}`;
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO core_order (id, state, email, currency, total, paid, placed_as, created_at, updated_at)
       VALUES (?, 'paid', ?, 'AUD', 2500, 2500, 'public', ?, ?)`,
    )
      .bind(order, email, now, now)
      .run();
    const { valueHash } = await import("../../../packages/core/src/routine-mail/marks.ts");
    for (const [field, value, standing] of [
      ["$created", "", "host"],
      ["total", 2500, "default"],
      ["currency", "AUD", "default"],
    ] as const) {
      await env.DB.prepare(
        "INSERT INTO core_value_mark (object_type, record_id, field, value_hash, standing, at) VALUES ('order', ?, ?, ?, ?, ?)",
      )
        .bind(order, field, await valueHash(value), standing, now)
        .run();
    }
    const result = await sendHostRoutineMessage(
      { db: db.query, integrations },
      { kind: "orderThanks", record: order, occasion: "paid" },
    );
    expect(result).toEqual({ sent: 1, held: 0, off: false, none: false });
    const mail = (
      (await env.TEST_EMAIL_OUTBOX.list()) as { to: string[]; subject: string; text?: string }[]
    ).filter((m) => m.to.includes(email));
    expect(mail).toEqual([
      expect.objectContaining({ subject: "Thank you", text: "We received 25.00 AUD." }),
    ]);
    expect(await rowsOf(order)).toEqual([
      expect.objectContaining({ channel: "email", status: "sent", routine: 1, body: null }),
    ]);
    // Asked again for the same occasion: nothing is sent twice.
    await sendHostRoutineMessage(
      { db: db.query, integrations },
      { kind: "orderThanks", record: order, occasion: "paid" },
    );
    expect(
      ((await env.TEST_EMAIL_OUTBOX.list()) as { to: string[] }[]).filter((m) =>
        m.to.includes(email),
      ),
    ).toHaveLength(1);
  });
});

describe("the cost of one message on every channel", { timeout: 60_000 }, () => {
  /** A database handle that counts every statement it runs, batches included. */
  function counting() {
    let n = 0;
    const d1 = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            return new Proxy(statement, {
              get(s, p) {
                if (p === "bind") {
                  return (...args: unknown[]) => {
                    const bound = s.bind(...args);
                    return new Proxy(bound, {
                      get(b, q) {
                        const value = Reflect.get(b, q, b);
                        if (q === "all" || q === "run" || q === "first" || q === "raw") {
                          return (...a: unknown[]) => {
                            n += 1;
                            return (value as (...x: unknown[]) => unknown).apply(b, a);
                          };
                        }
                        return typeof value === "function" ? value.bind(b) : value;
                      },
                    });
                  };
                }
                const value = Reflect.get(s, p, s);
                if (p === "all" || p === "run" || p === "first" || p === "raw") {
                  return (...a: unknown[]) => {
                    n += 1;
                    return (value as (...x: unknown[]) => unknown).apply(s, a);
                  };
                }
                return typeof value === "function" ? value.bind(s) : value;
              },
            });
          };
        }
        if (prop === "batch") {
          return (statements: unknown[]) => {
            n += statements.length;
            return target.batch(statements as never);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { db: createCrmDb(d1 as D1Database).query, count: () => n };
  }

  it("preparing a confirmation for one recipient on email, push and text reads a bounded number of statements", async () => {
    const b = await booking("cost");
    const everyone = reachOf(new Set([b.who.personId]), new Set([b.who.personId]));
    const switches = (on: boolean) =>
      run(
        "routineMail.settings.update",
        { channels: { "bookings.confirmation": { text: on, push: on } }, textOnlyWithoutApp: on },
        staff(),
      );
    const emailOnly = counting();
    await switches(false);
    try {
      await prepare(
        "bookingConfirmed",
        await runOf("bookingConfirmed", b.bookingId, "record"),
        { kind: "confirmation", record: b.bookingId, message: "booked" },
        { db: emailOnly.db },
      );
    } finally {
      await switches(true);
    }
    await run("routineMail.settings.update", { textOnlyWithoutApp: false }, staff());
    const all = counting();
    const runId = await runOf("bookingConfirmed", b.bookingId, "record");
    try {
      await prepare(
        "bookingConfirmed",
        runId,
        { kind: "confirmation", record: b.bookingId, message: "booked" },
        { db: all.db, reach: everyone },
      );
    } finally {
      await run("routineMail.settings.update", { textOnlyWithoutApp: true }, staff());
    }
    expect((await rowsOf(b.bookingId, runId)).map((r) => [r.channel, r.status])).toEqual([
      ["email", "ready"],
      ["push", "ready"],
      ["text", "ready"],
    ]);
    // Email only: the reads of what it shows and their marks, and its row (a few dozen, as
    // before). Text and push add the business's name and zone once, then per channel the reach
    // (none here: the seam's fake) and one row: a fixed handful, never a loop over anything.
    expect(emailOnly.count()).toBeLessThanOrEqual(40);
    expect(all.count() - emailOnly.count()).toBeLessThanOrEqual(3);
  });
});
