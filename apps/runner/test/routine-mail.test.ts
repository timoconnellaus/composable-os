// Routine mail (ADR 0590) on the shipped packs, through a real email-send gatekeeper and the fake
// Email Service, under the default (Balanced) preset. A member's routine email goes out on its
// own; and every way of getting an email out without a person's approval that is not a shipped
// pack's own declared email to the record's own people is tried here, and fails:
//   - as the assistant or an MCP client (a change an AI made, not approved: held for a person);
//   - a replay of a run (automation.replay, which an AI may call): held;
//   - Code Mode, a tool, a customer's call: the routine-mail module does not answer;
//   - an extension that is not shipped (or a shipped one ejected), another extension's kind, a
//     run that is not the automation's own: refused;
//   - text or a link in a member's name or a class's title: held;
//   - naming an address, free text for a slot, a choice not declared: refused;
//   - naming a record the run is not about: refused;
//   - the kind switched off: nothing sent, nothing queued;
//   - the Cautious preset, and over the daily cap per recipient: held.
// The deploy floor's review and deny are tested in packages/core/test/routine-mail.test.ts.
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type CustomerPrincipal,
  type ExtensionHost,
  type InvocationContext,
  invokeByName,
  type OutsideInvocationContext,
  prepareRoutineMail,
  queueEventSink,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { automationHost } from "../src/automations/host.ts";
import { runMomentDateRelative } from "../src/automations/schedule.ts";
import { RunHost } from "../src/executor/host.ts";
import { routineMailConnection } from "../src/integrations/code.ts";
import { hostFor, integrationRuntime } from "../src/integrations/runtime.ts";
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
const MAILING = [
  "bookingConfirmed",
  "waitlistPassedOver",
  "placeFree",
  "classChanged",
  "classCancelled",
  "classReminder",
  "dropInOrder",
];

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

interface Sent {
  to: string[];
  subject: string;
  text?: string;
}
async function mailTo(address: string): Promise<Sent[]> {
  const all = (await env.TEST_EMAIL_OUTBOX.list()) as Sent[];
  return all.filter((m) => m.to.includes(address.toLowerCase()));
}

interface Row {
  id: string;
  kind: string;
  status: string;
  routine: number;
  held_reason: string | null;
  recipient: string;
  recipient_rule: string;
  pending_action_id: string | null;
  run_id: string;
  trigger_type: string;
}
/** The routine mail rows about a record, once there are `count` decided ones. */
async function rowsFor(recordId: string, count = 1): Promise<Row[]> {
  let rows: Row[] = [];
  await vi.waitFor(
    async () => {
      rows = (
        await env.DB.prepare(
          "SELECT * FROM core_routine_mail WHERE record_id = ? ORDER BY created_at, id",
        )
          .bind(recordId)
          .all<Row>()
      ).results;
      expect(rows.filter((r) => r.status !== "ready" && r.status !== "sending")).toHaveLength(
        count,
      );
    },
    { timeout: 30_000, interval: 200 },
  );
  return rows;
}

async function pendingOf(actionId: string) {
  return env.DB.prepare(
    "SELECT operation, action_kind, status, input FROM core_pending_action WHERE id = ?",
  )
    .bind(actionId)
    .first<{ operation: string; action_kind: string; status: string; input: string }>();
}

async function member(
  label: string,
  name?: string,
): Promise<CustomerPrincipal & { email: string }> {
  const tag = unique(label).toLowerCase();
  const email = `${tag}@members.test`;
  const person = await run<{ id: string }>(
    "person.create",
    { givenName: name ?? `Given-${tag}`, emails: [{ email }] },
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
async function klass(extra: Record<string, unknown> = {}): Promise<string> {
  const startsAt = new Date(Date.now() + 2 * DAY).toISOString();
  return create(CLASS, {
    classType: type,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + HOUR).toISOString(),
    timezone: "Australia/Sydney",
    places: 10,
    ...extra,
  });
}

type Out = Record<string, unknown> & { result: string; bookingId?: string };
const book = (who: CustomerPrincipal, classId: string, extra: Record<string, unknown> = {}) =>
  run<Out>("x.bookings.book", { classId, ...extra }, as(who));

/** A booked member, their booking's confirmation decided. */
async function booked(label: string, classId?: string) {
  const who = await member(label);
  await givePass(who.personId);
  const k = classId ?? (await klass());
  const out = await book(who, k);
  expect(out.result).toBe("booked");
  const [row] = await rowsFor(out.bookingId as string);
  return { who, classId: k, bookingId: out.bookingId as string, row: row as Row };
}

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
  for (const name of MAILING) {
    await run(
      "automation.bindConnection",
      { id: `bookings.${name}`, slot: "mail", connectionId: mailConnection },
      staff(),
    );
  }
  // Off until a human admin turns it on (D1): this file is about routine email turned on.
  await run(
    "routineMail.settings.update",
    { siteOrigin: SITE, packs: { bookings: true } },
    staff(),
  );
  await run(
    "extensionSettings.update",
    { extension: "bookings", values: { bookingsUrl: `${SITE}/bookings` } },
    staff(),
  );
  type = await create("programs.classtype", { name: unique("Strength") });
}, 120_000);

afterAll(async () => {
  await setPreset("balanced");
  await introspector[Symbol.asyncDispose]();
});

describe("a member's routine email under Balanced", { timeout: 60_000 }, () => {
  it("goes on its own, to the booking's person, linking only to the gym's site; the log says so", async () => {
    const { who, row } = await booked("routine");
    expect(row).toMatchObject({
      kind: "bookings.confirmation",
      status: "sent",
      routine: 1,
      recipient: who.email,
      recipient_rule: "person",
      trigger_type: "record",
      pending_action_id: null,
    });
    const [mail] = await mailTo(who.email);
    expect(mail?.subject).toMatch(/^Booked: Strength/);
    expect(mail?.text).toContain(`You can see your bookings when you sign in: ${SITE}/bookings.`);
    // The words are cleared once it is decided; the kind, record and recipient stay.
    const stored = await env.DB.prepare("SELECT subject, body FROM core_routine_mail WHERE id = ?")
      .bind(row.id)
      .first();
    expect(stored).toEqual({ subject: null, body: null });
    const log = await run<{ items: { id: string; status: string; triggeredBy: unknown }[] }>(
      "routineMail.log",
      { kind: "bookings.confirmation" },
      staff(),
    );
    expect(log.items.find((i) => i.id === row.id)).toMatchObject({
      status: "sent",
      triggeredBy: { actor: "customer", approved: false },
    });
    const view = await run<{ kinds: { id: string; lastWeek: { sent: number } }[] }>(
      "routineMail.get",
      {},
      staff(),
    );
    expect(view.kinds.find((k) => k.id === "bookings.confirmation")?.lastWeek.sent).toBeGreaterThan(
      0,
    );
    expect(view.kinds.map((k) => k.id)).toEqual(
      expect.arrayContaining([
        "bookings.confirmation",
        "bookings.waitingList",
        "bookings.change",
        "bookings.cancellation",
        "bookings.reminder",
        "bookings.dropIn",
      ]),
    );
  });

  it("a retried step sends nothing twice: the host finds the row it made", async () => {
    const { bookingId, row } = await booked("retry");
    const again = await prepareRoutineMail(db.query, {
      extensionId: "bookings",
      automationId: "bookings.bookingConfirmed",
      runId: row.run_id,
      connectionId: mailConnection,
      send: { kind: "confirmation", record: bookingId, message: "booked" },
    });
    expect(again.toSend).toEqual([]);
    expect(again.done).toEqual([{ id: row.id, status: "sent", routine: true }]);
  });
});

describe("the switch per kind", { timeout: 60_000 }, () => {
  it("off sends nothing and queues nothing, and the admin sees it; on again sends", async () => {
    await run(
      "routineMail.settings.update",
      { kinds: { "bookings.confirmation": false } },
      staff(),
    );
    try {
      const who = await member("off");
      await givePass(who.personId);
      const out = await book(who, await klass());
      const [row] = await rowsFor(out.bookingId as string);
      expect(row).toMatchObject({ status: "off", routine: 0, pending_action_id: null });
      expect(await mailTo(who.email)).toEqual([]);
      const pending = await env.DB.prepare(
        "SELECT count(*) AS n FROM core_pending_action WHERE operation = 'integration.outbound' AND status = 'pending' AND input LIKE ?",
      )
        .bind(`%${who.email}%`)
        .first<{ n: number }>();
      expect(pending?.n).toBe(0);
      const view = await run<{ kinds: { id: string; on: boolean; lastWeek: { off: number } }[] }>(
        "routineMail.get",
        {},
        staff(),
      );
      expect(view.kinds.find((k) => k.id === "bookings.confirmation")).toMatchObject({
        on: false,
        lastWeek: { off: expect.any(Number) },
      });
    } finally {
      await run(
        "routineMail.settings.update",
        { kinds: { "bookings.confirmation": true } },
        staff(),
      );
    }
    const { row } = await booked("on-again");
    expect(row.status).toBe("sent");
  });
});

describe("never on an AI's say-so alone", { timeout: 60_000 }, () => {
  it("a booking the assistant made (an extension tool) is told only once a person approves the email", async () => {
    const who = await member("assistant");
    await givePass(who.personId);
    const out = await run<Out>(
      "x.bookings.bookFor",
      { classId: await klass(), personId: who.personId, paidAtDesk: true },
      staff({ actor: "assistant", origin: { surface: "assistant", sessionId: unique("ses") } }),
    );
    expect(out.result).toBe("booked");
    const [row] = await rowsFor(out.bookingId as string);
    expect(row).toMatchObject({ status: "waiting", routine: 0 });
    expect(row?.held_reason).toMatch(/an AI made the change/);
    expect(await mailTo(who.email)).toEqual([]);
    // The approval is the ordinary one: an email.send a person reads in full.
    const pending = await pendingOf(row?.pending_action_id as string);
    expect(pending).toMatchObject({
      operation: "integration.outbound",
      action_kind: "email.send",
      status: "pending",
    });
    expect(pending?.input).toContain("You are booked into");
  });

  it("an MCP client's change to a class time is told only once a person approves each email", async () => {
    const { who, classId, bookingId } = await booked("mcp");
    const later = new Date(Date.now() + 3 * DAY).toISOString();
    await run(
      "record.update",
      {
        object: CLASS,
        id: classId,
        values: { startsAt: later, endsAt: new Date(Date.parse(later) + HOUR).toISOString() },
      },
      staff({
        actor: "mcp",
        origin: { surface: "mcp", sessionId: unique("cap"), clientName: "Bot" },
      }),
    );
    const rows = await rowsFor(bookingId, 2);
    const change = rows.find((r) => r.kind === "bookings.change");
    expect(change).toMatchObject({ status: "waiting", routine: 0 });
    expect((await mailTo(who.email)).map((m) => m.subject)).toEqual([
      expect.stringMatching(/^Booked: /),
    ]);
  });

  it("a replay of a run (which an AI may ask for) is held: it would send the email again", async () => {
    const { who, bookingId, row } = await booked("replay");
    const replayed = await run<{ runId: string }>(
      "automation.replay",
      { runId: row.run_id },
      staff({
        actor: "assistant",
        origin: { surface: "assistant", sessionId: unique("ses") },
        automationHost: automationHost(env as never),
      }),
    );
    expect(replayed.runId).not.toBe(row.run_id);
    const rows = await rowsFor(bookingId, 2);
    const again = rows.find((r) => r.run_id === replayed.runId);
    expect(again).toMatchObject({ status: "waiting", routine: 0 });
    expect(again?.held_reason).toMatch(/the run is a replay/);
    expect((await mailTo(who.email)).length).toBe(1);
  });

  it("there is no operation to send routine mail: the assistant and MCP cannot name one", async () => {
    for (const actor of ["assistant", "mcp"] as const) {
      await expect(
        run(
          "routineMail.send",
          { kind: "confirmation", record: "rec_x" },
          staff({ actor, origin: { surface: actor === "mcp" ? "mcp" : "assistant" } }),
        ),
      ).rejects.toMatchObject({ code: expect.stringMatching(/unknown|not_found|validation/) });
    }
  });
});

describe("only an automation of a shipped pack", { timeout: 60_000 }, () => {
  const runState = (over: Record<string, unknown>) =>
    ({
      runId: "xrn_1",
      extensionId: "bookings",
      modules: new Set(["ops", "routine-mail"]),
      user: admin,
      permissions: { read: [], write: [], operations: [], modules: ["ops", "routine-mail"] },
      deadline: Date.now() + 60_000,
      logs: [],
      operations: [],
      ...over,
    }) as never;
  const ask = (state: never) =>
    new RunHost(env, state).call("routine-mail", "send", [
      { kind: "confirmation", record: "rec_x", message: "booked" },
    ]) as Promise<{ ok: boolean; error?: { code: string; message: string } }>;

  it("Code Mode, a tool and a customer's call get no routine mail", async () => {
    const code = await ask(
      runState({
        code: {
          caller: { actor: "assistant", user: admin, origin: { surface: "assistant" } },
          pending: [],
          calls: 0,
        },
        automation: {
          automationId: "bookings.bookingConfirmed",
          runId: "arn_x",
          depth: 0,
          chain: [],
          rootEventId: "x",
        },
      }),
    );
    expect(code).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const tool = await ask(
      runState({ tool: { name: "book", humanOnly: false, permission: null } }),
    );
    expect(tool).toMatchObject({ ok: false, error: { code: "forbidden" } });
    await expect(
      ask(runState({ outside: { principal: { kind: "public" }, tool: "book" } })),
    ).rejects.toThrow(/not available in a tool called by a customer/);
  });

  it("refuses an extension that is not shipped, a kind it does not declare, and a run not its own", async () => {
    const { bookingId, row } = await booked("refused");
    const send = { kind: "confirmation", record: bookingId, message: "booked" };
    const prepare = (over: Record<string, unknown>) =>
      prepareRoutineMail(db.query, {
        extensionId: "bookings",
        automationId: "bookings.bookingConfirmed",
        runId: row.run_id,
        connectionId: mailConnection,
        send,
        ...over,
      });
    // Ejected (now a runtime extension, the assistant's to change): refused.
    await env.DB.prepare(
      "UPDATE core_extensions SET source = 'runtime' WHERE id = 'bookings'",
    ).run();
    try {
      await expect(prepare({})).rejects.toMatchObject({ code: "forbidden" });
    } finally {
      await env.DB.prepare(
        "UPDATE core_extensions SET source = 'shipped' WHERE id = 'bookings'",
      ).run();
    }
    // Another extension naming Bookings' kind, or Bookings' run claimed by another automation.
    await expect(
      prepare({ extensionId: "memberships", automationId: "memberships.renewal" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(prepare({ automationId: "bookings.classReminder" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(prepare({ runId: "arn_not_a_run" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(prepare({ send: { ...send, kind: "newsletter" } })).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});

describe("the words are the declaration's, and the recipient the host's", {
  timeout: 60_000,
}, () => {
  it("refuses an address, free text for a slot the host fills, and a choice not declared", async () => {
    const { bookingId, row } = await booked("words");
    const prepare = (send: unknown, automationId = "bookings.bookingConfirmed") =>
      prepareRoutineMail(db.query, {
        extensionId: "bookings",
        automationId,
        runId: row.run_id,
        connectionId: mailConnection,
        send,
      });
    for (const send of [
      { kind: "confirmation", record: bookingId, message: "booked", to: "victim@evil.test" },
      { kind: "confirmation", record: bookingId, message: "booked", text: "Free money" },
      {
        kind: "confirmation",
        record: bookingId,
        message: "booked",
        values: { class: "Claim your prize at https://evil.test" },
      },
      {
        kind: "confirmation",
        record: bookingId,
        message: "booked",
        values: { link: "https://evil.test" },
      },
      { kind: "confirmation", record: bookingId, message: "phishing" },
    ]) {
      await expect(prepare(send), JSON.stringify(send)).rejects.toMatchObject({
        name: "ValidationError",
      });
    }
  });

  it("refuses a record the run is not about (another member's booking in another class)", async () => {
    // Both of one class type, in different classes: sharing the type ties nothing.
    const a = await booked("mine");
    const b = await booked("theirs");
    await expect(
      prepareRoutineMail(db.query, {
        extensionId: "bookings",
        automationId: "bookings.bookingConfirmed",
        runId: a.row.run_id,
        connectionId: mailConnection,
        send: { kind: "confirmation", record: b.bookingId, message: "booked" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("a link or an address in a child's name, or a link in a class title, is held for a person", async () => {
    const parent = await member("parent");
    const childId = (
      await run<{ id: string }>("person.create", { givenName: "Robin www.evil.test" }, staff())
    ).id;
    await run("person.link.add", { guardianId: parent.personId, dependantId: childId }, staff());
    await givePass(childId);
    const out = await book(parent, await klass(), { forPersonId: childId });
    expect(out.result).toBe("booked");
    const [held] = await rowsFor(out.bookingId as string);
    expect(held).toMatchObject({ recipient_rule: "guardian", status: "waiting", routine: 0 });
    expect(held?.held_reason).toMatch(/member's name holds a link/);
    expect(await mailTo(parent.email)).toEqual([]);

    const titled = await klass({ title: "Strength: claim your refund at https://evil.test" });
    const who = await member("title");
    await givePass(who.personId);
    const second = await book(who, titled);
    const [row] = await rowsFor(second.bookingId as string);
    expect(row).toMatchObject({ status: "waiting", routine: 0 });
    expect(row?.held_reason).toMatch(/class holds a link/);
    expect(await mailTo(who.email)).toEqual([]);
  });
});

describe("the policy and the rails", { timeout: 60_000 }, () => {
  it("under Cautious, routine email waits for a person", async () => {
    await setPreset("cautious");
    try {
      const who = await member("cautious");
      await givePass(who.personId);
      const out = await book(who, await klass());
      const [row] = await rowsFor(out.bookingId as string);
      expect(row).toMatchObject({ status: "waiting", routine: 1 });
      expect((await pendingOf(row?.pending_action_id as string))?.action_kind).toBe(
        "email.routine",
      );
      expect(await mailTo(who.email)).toEqual([]);
    } finally {
      await setPreset("balanced");
    }
  });

  it("over the daily cap per recipient, the next one waits for a person", async () => {
    const who = await member("capped");
    await givePass(who.personId);
    const now = new Date().toISOString();
    for (let i = 0; i < 20; i++) {
      await env.DB.prepare(
        `INSERT INTO core_routine_mail (id, kind, message, extension_id, record_object, record_id,
           recipient, recipient_key, recipient_rule, automation_id, run_id, trigger_type,
           idempotency_key, routine, status, claimed_at, created_at, updated_at)
         VALUES (?, 'bookings.reminder', 'reminder', 'bookings', 'bookings.booking', ?, ?, ?,
           'person', 'bookings.classReminder', 'arn_cap', 'dateRelative', ?, 1, 'sent', ?, ?, ?)`,
      )
        .bind(
          `rml_cap_${who.customerId}_${i}`,
          `rec_${i}`,
          // A plus-tagged, upper-cased address of the same mailbox counts against it (D4).
          who.email.replace("@", `+tag${i}@`).toUpperCase(),
          who.email,
          `cap:${who.email}:${i}`,
          now,
          now,
          now,
        )
        .run();
    }
    const out = await book(who, await klass());
    const [row] = await rowsFor(out.bookingId as string);
    expect(row).toMatchObject({ status: "waiting", routine: 0 });
    expect(row?.held_reason).toMatch(/has had 20 routine emails today/);
    expect(await mailTo(who.email)).toEqual([]);
  });
});

// --- The review of PR #267 ---------------------------------------------------------------------

const mcp = () =>
  staff({ actor: "mcp", origin: { surface: "mcp", sessionId: unique("cap"), clientName: "Bot" } });
const get = async (object: string, id: string) =>
  (await run<{ values: Record<string, unknown> }>("record.get", { object, id }, staff())).values;
const moveClass = (classId: string, hours: number, ctx = staff()) => {
  const later = new Date(Date.now() + 2 * DAY + hours * HOUR).toISOString();
  return run(
    "record.update",
    {
      object: CLASS,
      id: classId,
      values: { startsAt: later, endsAt: new Date(Date.parse(later) + HOUR).toISOString() },
    },
    ctx,
  );
};

describe("never on an AI's say-so, for the record's life (B1)", { timeout: 60_000 }, () => {
  it("a booking an MCP client made: its later reminder, a clock run, is held too", async () => {
    const who = await member("ai-later");
    await givePass(who.personId);
    const k = await klass();
    const out = await run<Out>(
      "x.bookings.bookFor",
      { classId: k, personId: who.personId, paidAtDesk: true },
      mcp(),
    );
    expect(out.result).toBe("booked");
    await rowsFor(out.bookingId as string, 1);
    const startsAt = Date.parse(String((await get(CLASS, k)).startsAt));
    await runMomentDateRelative(env, new Date(startsAt - 180 * 60_000));
    const rows = await rowsFor(out.bookingId as string, 2);
    const reminder = rows.find((r) => r.kind === "bookings.reminder");
    expect(reminder).toMatchObject({ status: "waiting", routine: 0 });
    expect(reminder?.held_reason).toMatch(/no person stands behind the booking itself \(ai\)/);
    expect(await mailTo(who.email)).toEqual([]);
  });

  it("a Person an AI made, booked by a person: held", async () => {
    const email = `${unique("ai-person").toLowerCase()}@members.test`;
    const person = await run<{ id: string }>(
      "person.create",
      { givenName: "Made by AI", emails: [{ email }] },
      mcp(),
    );
    await givePass(person.id);
    const out = await run<Out>(
      "x.bookings.bookFor",
      { classId: await klass(), personId: person.id, paidAtDesk: true },
      staff(),
    );
    const [row] = await rowsFor(out.bookingId as string);
    expect(row).toMatchObject({ status: "waiting", routine: 0 });
    expect(row?.held_reason).toMatch(/no person stands behind .*@members\.test \(ai\)/);
    expect(await mailTo(email)).toEqual([]);
  });

  it("an address an AI changed, then a person's booking: held", async () => {
    const who = await member("ai-address");
    await givePass(who.personId);
    const moved = `${unique("moved").toLowerCase()}@elsewhere.test`;
    await run("person.update", { id: who.personId, emails: [{ email: moved }] }, mcp());
    const out = await run<Out>(
      "x.bookings.bookFor",
      { classId: await klass(), personId: who.personId, paidAtDesk: true },
      staff(),
    );
    const [row] = await rowsFor(out.bookingId as string);
    expect(row).toMatchObject({ recipient: moved, status: "waiting", routine: 0 });
    expect(row?.held_reason).toMatch(/no person stands behind .*@elsewhere\.test \(ai\)/);
    expect(await mailTo(moved)).toEqual([]);
  });

  it("an AI's booking a person later approved: the approval clears it, and later email flows", async () => {
    const who = await member("ai-approved");
    await givePass(who.personId);
    const k = await klass();
    const out = await run<Out>(
      "x.bookings.bookFor",
      { classId: k, personId: who.personId, paidAtDesk: true },
      mcp(),
    );
    const [held] = await rowsFor(out.bookingId as string);
    expect(held).toMatchObject({ status: "waiting", routine: 0 });
    // Gatekeeper actions apply in order: earlier held emails of this file's other tests first.
    const before = await env.DB.prepare(
      "SELECT id FROM core_pending_action WHERE status = 'pending' AND operation = 'integration.outbound' AND id <= ? ORDER BY id",
    )
      .bind(held?.pending_action_id)
      .all<{ id: string }>();
    await run("approval.approve", { actionIds: before.results.map((r) => r.id) }, staff());
    await vi.waitFor(async () => expect(await mailTo(who.email)).toHaveLength(1), {
      timeout: 30_000,
      interval: 200,
    });
    await moveClass(k, 3);
    const rows = await rowsFor(out.bookingId as string, 2);
    expect(rows.find((r) => r.kind === "bookings.change")).toMatchObject({
      status: "sent",
      routine: 1,
    });
  });
});

describe("never words an AI wrote (B2)", { timeout: 60_000 }, () => {
  it("a class title an MCP client set, then a person's change: the change email is held", async () => {
    const { who, classId, bookingId } = await booked("ai-title");
    await run(
      "record.update",
      {
        object: CLASS,
        id: classId,
        values: { title: "Strength - CANCELLED call 0400 123 456 for your refund" },
      },
      mcp(),
    );
    await moveClass(classId, 4);
    const rows = await rowsFor(bookingId, 2);
    const change = rows.find((r) => r.kind === "bookings.change");
    expect(change).toMatchObject({ status: "waiting", routine: 0 });
    expect(change?.held_reason).toMatch(/'s title \(ai\)/);
    expect(change?.held_reason).toMatch(/a phone number/);
    expect((await mailTo(who.email)).map((m) => m.subject)).toEqual([
      expect.stringMatching(/^Booked: /),
    ]);
  });

  it("a plain title an AI set is held too, until a person writes it", async () => {
    const { classId, bookingId } = await booked("ai-plain");
    await run(
      "record.update",
      { object: CLASS, id: classId, values: { title: "Strength Plus" } },
      mcp(),
    );
    await moveClass(classId, 5);
    const rows = await rowsFor(bookingId, 2);
    expect(rows.find((r) => r.kind === "bookings.change")?.held_reason).toMatch(/'s title \(ai\)/);
    await run(
      "record.update",
      { object: CLASS, id: classId, values: { title: "Strength Plus" } },
      staff(),
    );
    await run(
      "record.update",
      { object: CLASS, id: classId, values: { title: "Strength Max" } },
      staff(),
    );
    await moveClass(classId, 6);
    const after = await rowsFor(bookingId, 3);
    expect(after.filter((r) => r.kind === "bookings.change").at(-1)).toMatchObject({
      status: "sent",
      routine: 1,
    });
  });
});

describe("the switch at send time (F2), and off until turned on (D1)", { timeout: 60_000 }, () => {
  it("a prepared email whose kind is turned off before it is sent sends nothing", async () => {
    const { who, bookingId, row } = await booked("f2");
    const prepared = await prepareRoutineMail(db.query, {
      extensionId: "bookings",
      automationId: "bookings.bookingConfirmed",
      runId: row.run_id,
      connectionId: mailConnection,
      send: { kind: "confirmation", record: bookingId, message: "paid" },
    });
    expect(prepared.toSend).toHaveLength(1);
    await run(
      "routineMail.settings.update",
      { kinds: { "bookings.confirmation": false } },
      staff(),
    );
    try {
      const connection = await routineMailConnection(env, "bookings.bookingConfirmed");
      const outcome = await hostFor(env, connection.connectionId).sendRoutineMail({
        id: prepared.toSend[0]?.id as string,
        resource: connection.resource,
      });
      expect(outcome).toEqual({ status: "off" });
      const stored = await env.DB.prepare("SELECT status FROM core_routine_mail WHERE id = ?")
        .bind(prepared.toSend[0]?.id)
        .first();
      expect(stored).toEqual({ status: "off" });
      expect(await mailTo(who.email)).toHaveLength(1);
    } finally {
      await run(
        "routineMail.settings.update",
        { kinds: { "bookings.confirmation": true } },
        staff(),
      );
    }
  });

  it("until a human admin turns a pack on, its emails are ordinary sends; the admins were told", async () => {
    const notice = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_notifications WHERE dedupe_key = 'routine-mail.available:bookings'",
    ).first<{ n: number }>();
    expect(notice?.n).toBeGreaterThan(0);
    await run("routineMail.settings.update", { packs: { bookings: false } }, staff());
    try {
      const who = await member("pack-off");
      await givePass(who.personId);
      const out = await book(who, await klass());
      const [row] = await rowsFor(out.bookingId as string);
      expect(row).toMatchObject({ status: "waiting", routine: 0 });
      expect((await pendingOf(row?.pending_action_id as string))?.action_kind).toBe("email.send");
      expect(await mailTo(who.email)).toEqual([]);
    } finally {
      await run("routineMail.settings.update", { packs: { bookings: true } }, staff());
    }
  });
});

// --- The second review of PR #267: default deny, marks the host keeps ---------------------------

/** A class a series made, as the minute cron makes it (the host). */
async function seriesClass(ctx: InvocationContext, title?: string): Promise<string> {
  const firstDate = new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10);
  const series = await run<{ id: string }>(
    "record.create",
    {
      object: "bookings.series",
      values: {
        classType: type,
        ...(title ? { title } : {}),
        weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        time: "06:00",
        length: 60,
        places: 10,
        firstDate,
        lastDate: firstDate,
        timezone: "Australia/Sydney",
      },
    },
    ctx,
  );
  await run(
    "recurring.generate",
    { object: "bookings.series", id: series.id },
    staff({ actor: "automation", origin: { surface: "automation" } }),
  );
  const made = await run<{ items: { id: string }[] }>(
    "record.list",
    { object: CLASS, filter: { field: "series", op: "eq", value: series.id }, limit: 5 },
    staff(),
  );
  expect(made.items.length).toBeGreaterThan(0);
  return made.items[0]?.id as string;
}

describe("copies carry their source's mark (the second review, B1)", { timeout: 60_000 }, () => {
  it("a series an MCP client titled: the class the host makes from it is held, a person's is sent", async () => {
    const aiClass = await seriesClass(
      mcp(),
      "Strength: your membership is suspended, bring your card details to reception",
    );
    const who = await member("series-ai");
    await givePass(who.personId);
    const out = await book(who, aiClass);
    expect(out.result).toBe("booked");
    const [row] = await rowsFor(out.bookingId as string);
    expect(row).toMatchObject({ status: "waiting", routine: 0 });
    expect(row?.held_reason).toMatch(/'s title \(ai\)/);
    expect(await mailTo(who.email)).toEqual([]);

    const personClass = await seriesClass(staff(), "Strength by a person");
    const { row: sent } = await booked("series-person", personClass);
    expect(sent).toMatchObject({ status: "sent", routine: 1 });
  });

  it("a class type an MCP client named, taken as a class's title by the host: held", async () => {
    const aiType = await run<{ id: string }>(
      "record.create",
      {
        object: "programs.classtype",
        values: { name: "Free class: reply with your card details" },
      },
      mcp(),
    );
    const startsAt = new Date(Date.now() + 2 * DAY).toISOString();
    const k = await create(CLASS, {
      classType: aiType.id,
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + HOUR).toISOString(),
      timezone: "Australia/Sydney",
      places: 10,
    });
    expect((await get(CLASS, k)).title).toBe("Free class: reply with your card details");
    const who = await member("type-ai");
    await givePass(who.personId);
    const out = await book(who, k);
    const [row] = await rowsFor(out.bookingId as string);
    expect(row).toMatchObject({ status: "waiting", routine: 0 });
    expect(row?.held_reason).toMatch(/'s title \(ai\)/);
  });

  it("a room an MCP client named, two relations away (class.room.name): held", async () => {
    const room = await run<{ id: string }>(
      "record.create",
      { object: "bookings.room", values: { name: "Studio A" } },
      staff(),
    );
    await run(
      "record.update",
      { object: "bookings.room", id: room.id, values: { name: "Studio B" } },
      mcp(),
    );
    const k = await klass({ room: room.id });
    const who = await member("room-ai");
    await givePass(who.personId);
    const out = await book(who, k);
    const [row] = await rowsFor(out.bookingId as string);
    expect(row).toMatchObject({ status: "waiting", routine: 0 });
    expect(row?.held_reason).toMatch(/bookings\.room .*'s name \(ai\)/);
  });
});

describe("what a person's approval clears (the second review, B2)", { timeout: 60_000 }, () => {
  it("approving an AI's booking's email does not clear an address the AI changed after it was prepared", async () => {
    const who = await member("b2-addr");
    await givePass(who.personId);
    const k = await klass();
    const out = await run<Out>(
      "x.bookings.bookFor",
      { classId: k, personId: who.personId, paidAtDesk: true },
      mcp(),
    );
    const [held] = await rowsFor(out.bookingId as string);
    expect(held).toMatchObject({ recipient: who.email, status: "waiting" });
    const attacker = `${unique("attacker").toLowerCase()}@evil.test`;
    await run("person.update", { id: who.personId, emails: [{ email: attacker }] }, mcp());
    const before = await env.DB.prepare(
      "SELECT id FROM core_pending_action WHERE status = 'pending' AND operation = 'integration.outbound' AND id <= ? ORDER BY id",
    )
      .bind(held?.pending_action_id)
      .all<{ id: string }>();
    await run("approval.approve", { actionIds: before.results.map((r) => r.id) }, staff());
    // The reminder, a clock run: to the address the AI put there, so held.
    const startsAt = Date.parse(String((await get(CLASS, k)).startsAt));
    await runMomentDateRelative(env, new Date(startsAt - 180 * 60_000));
    const rows = await rowsFor(out.bookingId as string, 2);
    const reminder = rows.find((r) => r.kind === "bookings.reminder");
    expect(reminder).toMatchObject({ recipient: attacker, status: "waiting", routine: 0 });
    expect(await mailTo(attacker)).toEqual([]);
  });
});

describe("the pack switch when a row is claimed (the second review)", { timeout: 60_000 }, () => {
  it("a backlog prepared while on and claimed after the pack is turned off waits as before", async () => {
    const { bookingId, row } = await booked("pack-claim");
    const prepared = await prepareRoutineMail(db.query, {
      extensionId: "bookings",
      automationId: "bookings.bookingConfirmed",
      runId: row.run_id,
      connectionId: mailConnection,
      send: { kind: "confirmation", record: bookingId, message: "paid" },
    });
    expect(prepared.toSend).toEqual([{ id: expect.any(String), routine: true }]);
    await run("routineMail.settings.update", { packs: { bookings: false } }, staff());
    try {
      const connection = await routineMailConnection(env, "bookings.bookingConfirmed");
      const outcome = await hostFor(env, connection.connectionId).sendRoutineMail({
        id: prepared.toSend[0]?.id as string,
        resource: connection.resource,
      });
      expect(outcome.status).toBe("waiting");
      const stored = await env.DB.prepare(
        "SELECT routine, ordinary, pending_action_id FROM core_routine_mail WHERE id = ?",
      )
        .bind(prepared.toSend[0]?.id)
        .first<{ routine: number; ordinary: number; pending_action_id: string }>();
      expect(stored).toMatchObject({ routine: 0, ordinary: 1 });
      expect((await pendingOf(stored?.pending_action_id as string))?.action_kind).toBe(
        "email.send",
      );
    } finally {
      await run("routineMail.settings.update", { packs: { bookings: true } }, staff());
    }
  });
});
