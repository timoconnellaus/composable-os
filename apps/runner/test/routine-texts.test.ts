// Routine messages by text (stage 30 step 3, ADRs 0672 and 0673), through the real text
// gatekeeper and its fake provider, under the default (Balanced) preset:
//   - which number is textable: one a person added, the member's own once they checked it by
//     code, one checked by code; never one an AI added, nor one another Person checked
//     (acceptance criterion 4);
//   - only the host's routine queue sends a text: a person's or an AI's own call to the text
//     connection is refused (criterion 7);
//   - a text whose values an AI changed is held and put to a person, sent once approved (3);
//   - a STOP reply stops every text to the number, the next is `stopped`, START lifts it, and the
//     number on another Person is not texted (criterion 9); a receipt settles the row;
//   - the month's limit: past it a text is `over_limit`, its email goes, admins are told once that
//     day and once at 80%; two claims at once cannot pass it (criterion 11);
//   - a text not handed over (a full pending pool) is back as it was, its spend given back, and
//     goes on the next try (criterion 12);
//   - the textable number and the claim read a bounded number of statements (criterion 21).
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type CustomerPrincipal,
  claimRoutineText,
  type ExtensionHost,
  type InvocationContext,
  invokeByName,
  newId,
  type OutsideInvocationContext,
  prepareRoutineMail,
  queueEventSink,
  refreshSchemaRegistry,
  sendReadyTexts,
  settleRoutineText,
  textReach,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it, vi } from "vitest";
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
const SITE = "https://gym.example";
const ZONE = "Australia/Sydney";
const PRICE = 10;
/** Midday in Sydney, so a text prepared now is outside quiet hours (ADR 0676). */
const middayNow = () => {
  const day = new Date().toISOString().slice(0, 10);
  const at = Date.parse(`${day}T12:00:00+11:00`);
  const shown = new Intl.DateTimeFormat("en-GB", {
    timeZone: ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(at));
  return new Date(shown === "12:00" ? at : at + HOUR).toISOString();
};

let admin: ActingUser;
let mailConnection: string;
let textConnection: string;
let type: string;
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

let numberSeq = 0;
/** A fresh Australian mobile: as typed (`04…`), and in international form. */
const mobile = () => {
  numberSeq += 1;
  const national = `4${String(Date.now() % 1_000_000).padStart(6, "0")}${String(numberSeq % 100).padStart(2, "0")}`;
  return {
    typed: `0${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`,
    to: `+61${national}`,
  };
};

interface Row {
  id: string;
  channel: string;
  status: string;
  routine: number;
  held_reason: string | null;
  recipient: string;
  body: string | null;
  error: string | null;
  pending_action_id: string | null;
  provider_ref: string | null;
  delivered_at: string | null;
  cost_minor: number | null;
}
const rowsOf = async (recordId: string, runId: string): Promise<Row[]> =>
  (
    await env.DB.prepare(
      "SELECT * FROM core_routine_mail WHERE record_id = ? AND run_id = ? ORDER BY channel",
    )
      .bind(recordId, runId)
      .all<Row>()
  ).results;
const textOf = async (recordId: string, runId: string) =>
  (await rowsOf(recordId, runId)).find((r) => r.channel === "text") as Row;
const rowById = async (id: string) =>
  (await env.DB.prepare("SELECT * FROM core_routine_mail WHERE id = ?")
    .bind(id)
    .first<Row>()) as Row;

/** A member: a Person with an address, maybe a phone (added by `by`), and a customer account. */
async function member(
  label: string,
  phone?: { typed: string },
  by: () => InvocationContext = staff,
): Promise<CustomerPrincipal & { email: string }> {
  const tag = unique(label).toLowerCase();
  const email = `${tag}@members.test`;
  const person = await run<{ id: string }>(
    "person.create",
    { givenName: `Given-${tag}`, emails: [{ email }] },
    staff(),
  );
  if (phone) {
    await run(
      "person.update",
      { id: person.id, phones: [{ number: phone.typed, primary: true }] },
      by(),
    );
  }
  const customerId = `cus_${tag}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_customer (id, person_id, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(customerId, person.id, email, now, now)
    .run();
  return { kind: "customer", customerId, personId: person.id, email };
}

async function klass(): Promise<string> {
  const startsAt = new Date(Date.now() + 2 * DAY).toISOString();
  return create("bookings.class", {
    classType: type,
    title: "Strength",
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + HOUR).toISOString(),
    timezone: ZONE,
    places: 10,
  });
}

async function booking(who: CustomerPrincipal, classId?: string) {
  const passType = await create("memberships.passtype", {
    title: unique("Pack "),
    price: 50,
    uses: 10,
    validDays: 60,
    status: "on_sale",
  });
  await run(
    "x.memberships.givePass",
    { personId: who.personId, passTypeId: passType, reason: "Integration test" },
    staff(),
  );
  const out = await run<{ result: string; bookingId: string }>(
    "x.bookings.book",
    { classId: classId ?? (await klass()) },
    as(who),
  );
  expect(out.result).toBe("booked");
  return out.bookingId;
}

/** Prepares a booking's confirmation as its automation's run would, at midday in Sydney. */
async function confirm(bookingId: string, extra: { db?: typeof db.query } = {}) {
  const runId = newId("automationRun");
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO core_automation_runs (id, automation_id, extension_id, trigger, record_object,
       record_id, status, started_at, updated_at)
     VALUES (?, 'bookings.bookingConfirmed', 'bookings', ?, 'bookings.booking', ?, 'running', ?, ?)`,
  )
    .bind(runId, JSON.stringify({ type: "record" }), bookingId, now, now)
    .run();
  await prepareRoutineMail(extra.db ?? db.query, {
    extensionId: "bookings",
    automationId: "bookings.bookingConfirmed",
    runId,
    connectionId: mailConnection,
    send: { kind: "confirmation", record: bookingId, message: "booked" },
    now: middayNow(),
  });
  return runId;
}

/** Prepares and sends a confirmation's text; returns its row. */
async function confirmAndText(bookingId: string): Promise<Row> {
  const runId = await confirm(bookingId);
  const text = await textOf(bookingId, runId);
  await sendReadyTexts({ db: db.query, integrations }, { ids: [text.id] });
  return rowById(text.id);
}

const sentTo = async (to: string) => (await env.TEST_TEXT_PHONES.sent()).filter((s) => s.to === to);

// The fake provider's webhook, signed as the provider signs it.
async function webhook(events: unknown[]): Promise<Response> {
  const body = JSON.stringify({ id: `evt_${crypto.randomUUID()}`, events });
  const t = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("fake-text-test-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)),
  );
  const v1 = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return env.GATEKEEPER_TEXT.fetch(
    new Request("http://crm.test/gatekeeper/text/in/fake", {
      method: "POST",
      headers: { "content-type": "application/json", "x-fake-signature": `t=${t},v1=${v1}` },
      body,
    }),
  );
}

const stopped = async (to: string) => {
  const { numberHash } = await import("@composable-os/core");
  const hash = await numberHash(db.query, to);
  return Boolean(
    await env.DB.prepare("SELECT 1 FROM core_text_stop WHERE number_hash = ?").bind(hash).first(),
  );
};

async function spend(): Promise<{ estimatedMinor: number; reportedMinor: number; month: string }> {
  return run("messages.textSpend", {}, staff());
}

/** Sets the month's limit to what is spent now and room for `texts` more one-segment texts. */
async function roomFor(texts: number): Promise<void> {
  const now = await spend();
  await run(
    "routineMail.settings.update",
    { textLimitMinor: now.estimatedMinor + texts * PRICE },
    staff(),
  );
}

beforeAll(async () => {
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
  await run("integration.setVendor", { vendor: "text", enabled: true }, staff());
  const text = await run<{ connection: { id: string } }>(
    "connection.create",
    { vendor: "text", scope: "org" },
    staff(),
  );
  textConnection = text.connection.id;
  await run("connection.bindResource", { id: textConnection, url: "text://sender" }, staff());
  await run(
    "routineMail.settings.update",
    {
      siteOrigin: SITE,
      packs: { bookings: true },
      senderName: "Example Gym",
      quietZone: ZONE,
      channels: { "bookings.confirmation": { text: true } },
      textSegmentPriceMinor: PRICE,
      textLimitMinor: 1_000_000,
      textCountries: ["AU"],
    },
    staff(),
  );
  await run(
    "extensionSettings.update",
    { extension: "bookings", values: { bookingsUrl: `${SITE}/bookings` } },
    staff(),
  );
  type = await create("programs.classtype", { name: unique("Strength") });
}, 120_000);

describe("which number is textable (ADR 0673)", { timeout: 60_000 }, () => {
  it("a number a person added is texted, from the business's number, in its words", async () => {
    const phone = mobile();
    const who = await member("person-added", phone);
    const row = await confirmAndText(await booking(who));
    expect(row).toMatchObject({ status: "sent", routine: 1, recipient: "", body: null });
    expect(row.cost_minor).toBe(PRICE);
    const sent = await sentTo(phone.to);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.from).toBe("+61400000999");
    expect(sent[0]?.text).toMatch(/^Example Gym: .+ Reply STOP to stop$/);
  });

  it("a number an AI added is never texted", async () => {
    const phone = mobile();
    const who = await member("ai-added", phone, mcp);
    const row = await confirmAndText(await booking(who));
    expect(row.status).toBe("no_channel");
    expect(row.error).toMatch(/an AI added/);
    expect(await sentTo(phone.to)).toEqual([]);
  });

  it("the member's own number is texted once they checked it by code", async () => {
    const phone = mobile();
    const who = await member("own");
    await run("me.update", { primaryPhone: phone.typed }, as(who));
    const first = await confirmAndText(await booking(who));
    expect(first.status).toBe("no_channel");
    expect(first.error).toMatch(/not yet checked by a code/);
    // A number not on their record gets no code: a code never goes to a number someone typed.
    await expect(run("me.phone.startCheck", { number: mobile().typed }, as(who))).rejects.toThrow(
      /Add the number to your details first/,
    );
    const started = await run<{ started: boolean; number: string }>(
      "me.phone.startCheck",
      { number: phone.typed },
      as(who),
    );
    expect(started.number).not.toContain(phone.to.slice(4, -3));
    const code = (await env.TEST_TEXT_PHONES.codeFor(phone.to)) as string;
    expect(code).toMatch(/^\d{6}$/);
    expect(
      await run(
        "me.phone.check",
        { number: phone.typed, code: code === "123456" ? "654321" : "123456" },
        as(who),
      ),
    ).toEqual({ checked: false });
    expect(await run("me.phone.check", { number: phone.typed, code }, as(who))).toEqual({
      checked: true,
    });
    const second = await confirmAndText(await booking(who));
    expect(second.status).toBe("sent");
    expect(await sentTo(phone.to)).toHaveLength(1);
  });

  it("a number an AI added becomes textable once its owner checks it by code", async () => {
    const phone = mobile();
    const who = await member("ai-then-checked", phone, mcp);
    await run("me.phone.startCheck", { number: phone.typed }, as(who));
    const code = (await env.TEST_TEXT_PHONES.codeFor(phone.to)) as string;
    expect(await run("me.phone.check", { number: phone.typed, code }, as(who))).toEqual({
      checked: true,
    });
    expect((await confirmAndText(await booking(who))).status).toBe("sent");
  });

  it("a number checked by another Person is not texted", async () => {
    const phone = mobile();
    const owner = await member("checker", phone);
    await run("me.phone.startCheck", { number: phone.typed }, as(owner));
    const code = (await env.TEST_TEXT_PHONES.codeFor(phone.to)) as string;
    await run("me.phone.check", { number: phone.typed, code }, as(owner));
    const other = await member("other", phone);
    const row = await confirmAndText(await booking(other));
    expect(row.status).toBe("no_channel");
    expect(row.error).toMatch(/checked by code by another person/);
  });

  it("three codes a day for a member", async () => {
    const phone = mobile();
    const who = await member("codes", phone);
    for (let i = 0; i < 3; i += 1) {
      await run("me.phone.startCheck", { number: phone.typed }, as(who));
    }
    await expect(run("me.phone.startCheck", { number: phone.typed }, as(who))).rejects.toThrow(
      /at most 3 codes a day/,
    );
  });
});

describe("only the host's routine messages send a text (ADR 0672)", { timeout: 60_000 }, () => {
  it("a person's and an AI's own call to the text connection are refused, not reviewed", async () => {
    for (const ctx of [staff(), mcp()]) {
      await expect(
        run(
          "integration.call",
          {
            connectionId: textConnection,
            resource: "TEXT",
            method: "send",
            args: [{ to: mobile().to, text: "Example Gym: hello Reply STOP to stop" }],
          },
          ctx,
        ),
      ).rejects.toThrow(/Refused: a text goes only from the host's own/);
    }
    const pending = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_pending_action WHERE connection_id = ?",
    )
      .bind(textConnection)
      .first<{ n: number }>();
    expect(pending?.n).toBe(0);
  });

  it("a text about a class an AI renamed is held, put to a person, and sent once approved", async () => {
    const phone = mobile();
    const who = await member("held", phone);
    const k = await klass();
    const bookingId = await booking(who, k);
    await run(
      "record.update",
      { object: "bookings.class", id: k, values: { title: "Strength+" } },
      mcp(),
    );
    const runId = await confirm(bookingId);
    const text = await textOf(bookingId, runId);
    expect(text).toMatchObject({ status: "held", routine: 0 });
    await sendReadyTexts({ db: db.query, integrations }, { ids: [text.id] });
    const waiting = await rowById(text.id);
    expect(waiting.status).toBe("waiting");
    expect(waiting.pending_action_id).toBeTruthy();
    expect(await sentTo(phone.to)).toEqual([]);
    await run("approval.approve", { actionIds: [waiting.pending_action_id] }, staff());
    expect(await sentTo(phone.to)).toHaveLength(1);
  });
});

describe("receipts, STOP and START (ADR 0672)", { timeout: 60_000 }, () => {
  it("a receipt settles its row as delivered, with what the provider charged", async () => {
    const phone = mobile();
    const who = await member("receipt", phone);
    const row = await confirmAndText(await booking(who));
    const ref = (await sentTo(phone.to))[0]?.providerRef as string;
    const before = await spend();
    expect(
      (await webhook([{ type: "receipt", ref, status: "delivered", costMinor: 7 }])).status,
    ).toBe(200);
    await vi.waitFor(async () => expect((await rowById(row.id)).status).toBe("delivered"), {
      timeout: 10_000,
    });
    expect(await rowById(row.id)).toMatchObject({ provider_ref: ref });
    expect((await spend()).reportedMinor).toBe(before.reportedMinor + 7);
  });

  it("STOP stops every text to the number, START lifts it, and on another Person it stays stopped", async () => {
    const phone = mobile();
    const who = await member("stop", phone);
    expect((await confirmAndText(await booking(who))).status).toBe("sent");
    await webhook([{ type: "reply", from: phone.to, text: "STOP" }]);
    await vi.waitFor(async () => expect(await stopped(phone.to)).toBe(true), { timeout: 10_000 });
    const next = await confirmAndText(await booking(who));
    expect(next.status).toBe("stopped");
    // The same number entered on someone else, by a person: still not texted.
    const other = await member("stop-other", phone);
    expect((await confirmAndText(await booking(other))).status).toBe("stopped");
    await webhook([{ type: "reply", from: phone.to, text: "start" }]);
    await vi.waitFor(async () => expect(await stopped(phone.to)).toBe(false), { timeout: 10_000 });
    expect((await confirmAndText(await booking(who))).status).toBe("sent");
    expect(await sentTo(phone.to)).toHaveLength(2);
  });

  it("a text claimed after its number replied STOP is stopped, not sent", async () => {
    const phone = mobile();
    const who = await member("stop-later", phone);
    const bookingId = await booking(who);
    const runId = await confirm(bookingId);
    const text = await textOf(bookingId, runId);
    expect(text.status).toBe("ready");
    await webhook([{ type: "reply", from: phone.to, text: "Stop" }]);
    await vi.waitFor(async () => expect(await stopped(phone.to)).toBe(true), { timeout: 10_000 });
    await sendReadyTexts({ db: db.query, integrations }, { ids: [text.id] });
    expect((await rowById(text.id)).status).toBe("stopped");
    expect(await sentTo(phone.to)).toEqual([]);
  });
});

describe("the month's text limit (ADR 0672)", { timeout: 60_000 }, () => {
  it("past it a text is over_limit, its email goes, and admins are told once that day and at 80%", async () => {
    await roomFor(2);
    const texts: Row[] = [];
    for (let i = 0; i < 4; i += 1) {
      const who = await member(`limit${i}`, mobile());
      const bookingId = await booking(who);
      const runId = await confirm(bookingId);
      const text = await textOf(bookingId, runId);
      await sendReadyTexts({ db: db.query, integrations }, { ids: [text.id] });
      texts.push(await rowById(text.id));
      const email = (await rowsOf(bookingId, runId)).find((r) => r.channel === "email");
      expect(email?.status).not.toBe("over_limit");
    }
    expect(texts.map((t) => t.status)).toEqual(["sent", "sent", "over_limit", "over_limit"]);
    const told = await env.DB.prepare(
      "SELECT dedupe_key FROM core_notifications WHERE user_id = ? AND dedupe_key LIKE 'routine-text.%'",
    )
      .bind(admin.id)
      .all<{ dedupe_key: string }>();
    const keys = told.results.map((r) => r.dedupe_key);
    expect(keys.filter((k) => k.startsWith("routine-text.limit:"))).toHaveLength(1);
    expect(keys.filter((k) => k.startsWith("routine-text.80:"))).toHaveLength(1);
    await run("routineMail.settings.update", { textLimitMinor: 1_000_000 }, staff());
  });

  it("two claims at once cannot pass it", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const who = await member(`race${i}`, mobile());
      const bookingId = await booking(who);
      ids.push((await textOf(bookingId, await confirm(bookingId))).id);
    }
    await roomFor(1);
    const claims = await Promise.all(
      ids.map((id) => claimRoutineText(db.query, id, textConnection)),
    );
    expect(claims.map((c) => c?.status).sort()).toEqual(["over_limit", "send"]);
    for (const claim of claims) {
      if (claim?.status === "send")
        await settleRoutineText(db.query, claim.row, { status: "back", error: "test" });
    }
    await run("routineMail.settings.update", { textLimitMinor: 1_000_000 }, staff());
  });
});

describe("back-pressure (criterion 12)", { timeout: 60_000 }, () => {
  it("a text not handed over is back as it was, its spend given back, and goes on the next try", async () => {
    const phone = mobile();
    const who = await member("back", phone);
    const bookingId = await booking(who);
    const text = await textOf(bookingId, await confirm(bookingId));
    const before = await spend();
    const claim = await claimRoutineText(db.query, text.id, textConnection);
    expect(claim?.status).toBe("send");
    expect((await spend()).estimatedMinor).toBe(before.estimatedMinor + PRICE);
    if (claim?.status !== "send") throw new Error("not claimed");
    await settleRoutineText(db.query, claim.row, {
      status: "back",
      error: "Too many pending actions; approve or reject some in the approval queue first.",
    });
    expect(await rowById(text.id)).toMatchObject({ status: "ready", cost_minor: null });
    expect((await spend()).estimatedMinor).toBe(before.estimatedMinor);
    await sendReadyTexts({ db: db.query, integrations }, { ids: [text.id] });
    expect((await rowById(text.id)).status).toBe("sent");
    expect(await sentTo(phone.to)).toHaveLength(1);
  });
});

describe("the review of PR #435", { timeout: 60_000 }, () => {
  it("finding 1: three codes a day for a member, even asked for at once", async () => {
    const [a, b, c] = [mobile(), mobile(), mobile()];
    const who = await member("codes-at-once");
    await run(
      "person.update",
      {
        id: who.personId,
        phones: [
          { number: a.typed, primary: true },
          { number: b.typed, primary: false },
          { number: c.typed, primary: false },
        ],
      },
      staff(),
    );
    const outcomes = await Promise.allSettled(
      [a, a, b, b, c, c].map((n) => run("me.phone.startCheck", { number: n.typed }, as(who))),
    );
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(3);
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_phone_check WHERE person_id = ?",
    )
      .bind(who.personId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(3);
  });

  it("finding 2a: a text left sending by a host that stopped is sent again, its spend counted once", async () => {
    const phone = mobile();
    const who = await member("stale", phone);
    const bookingId = await booking(who);
    const text = await textOf(bookingId, await confirm(bookingId));
    const before = await spend();
    expect((await claimRoutineText(db.query, text.id, textConnection))?.status).toBe("send");
    // The host stopped before it handed the text over: the row is left sending.
    await env.DB.prepare("UPDATE core_routine_mail SET updated_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - HOUR).toISOString(), text.id)
      .run();
    await sendReadyTexts({ db: db.query, integrations }, { ids: [text.id] });
    expect(await rowById(text.id)).toMatchObject({ status: "sent", recipient: "", body: null });
    expect(await sentTo(phone.to)).toHaveLength(1);
    expect((await spend()).estimatedMinor).toBe(before.estimatedMinor + PRICE);
  });

  it("finding 2b: a held text whose first submission was not recorded waits for that same approval", async () => {
    const phone = mobile();
    const who = await member("resubmit", phone);
    const k = await klass();
    const bookingId = await booking(who, k);
    await run(
      "record.update",
      { object: "bookings.class", id: k, values: { title: "Power" } },
      mcp(),
    );
    const text = await textOf(bookingId, await confirm(bookingId));
    await sendReadyTexts({ db: db.query, integrations }, { ids: [text.id] });
    const first = await rowById(text.id);
    expect(first.status).toBe("waiting");
    // As if the host stopped after the gatekeeper took it, before the row said so.
    await env.DB.prepare(
      "UPDATE core_routine_mail SET status = 'held', pending_action_id = NULL, recipient = ?, body = ?, cost_minor = NULL, claimed_at = NULL WHERE id = ?",
    )
      .bind(phone.to, "Example Gym: words Reply STOP to stop", text.id)
      .run();
    await sendReadyTexts({ db: db.query, integrations }, { ids: [text.id] });
    expect(await rowById(text.id)).toMatchObject({
      status: "waiting",
      pending_action_id: first.pending_action_id,
      recipient: "",
      body: null,
    });
  });

  it("finding 3: with the limit at 0 texts are off, and admins are not told the limit was reached", async () => {
    await run("routineMail.settings.update", { textLimitMinor: 0 }, staff());
    const since = new Date().toISOString();
    try {
      const who = await member("limit-zero", mobile());
      const bookingId = await booking(who);
      const runId = await confirm(bookingId);
      const text = await textOf(bookingId, runId);
      await sendReadyTexts({ db: db.query, integrations }, { ids: [text.id] });
      expect(await rowById(text.id)).toMatchObject({ status: "off" });
      const told = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM core_notifications WHERE user_id = ? AND title LIKE 'Texts reached%' AND created_at >= ?",
      )
        .bind(admin.id, since)
        .first<{ n: number }>();
      expect(told?.n).toBe(0);
    } finally {
      await run("routineMail.settings.update", { textLimitMinor: 1_000_000 }, staff());
    }
  });

  it("finding 5: two claims of one text near the limit send it once and never mark it over_limit", async () => {
    const who = await member("same-row", mobile());
    const bookingId = await booking(who);
    const text = await textOf(bookingId, await confirm(bookingId));
    await roomFor(1);
    try {
      const claims = await Promise.all([
        claimRoutineText(db.query, text.id, textConnection),
        claimRoutineText(db.query, text.id, textConnection),
      ]);
      expect(claims.filter((c) => c?.status === "send")).toHaveLength(1);
      expect((await rowById(text.id)).status).toBe("sending");
      for (const claim of claims) {
        if (claim?.status === "send") {
          await settleRoutineText(db.query, claim.row, { status: "back", error: "test" });
        }
      }
    } finally {
      await run("routineMail.settings.update", { textLimitMinor: 1_000_000 }, staff());
    }
  });

  it("finding 8: after three wrong guesses a code no longer checks, even the right one", async () => {
    const phone = mobile();
    const who = await member("guesses", phone);
    await run("me.phone.startCheck", { number: phone.typed }, as(who));
    const code = (await env.TEST_TEXT_PHONES.codeFor(phone.to)) as string;
    const wrong = code === "111111" ? "222222" : "111111";
    for (let i = 0; i < 3; i += 1) {
      expect(await run("me.phone.check", { number: phone.typed, code: wrong }, as(who))).toEqual({
        checked: false,
      });
    }
    expect(await run("me.phone.check", { number: phone.typed, code }, as(who))).toEqual({
      checked: false,
    });
  });
});

describe("the cost of a text (criterion 21)", { timeout: 60_000 }, () => {
  function counting() {
    let n = 0;
    const d1 = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (query: string) => {
            const statement = target.prepare(query);
            const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(s, {
                get(t, p) {
                  if (p === "bind") return (...args: unknown[]) => wrap(t.bind(...args));
                  const value = Reflect.get(t, p, t);
                  if (p === "all" || p === "run" || p === "first" || p === "raw") {
                    return (...a: unknown[]) => {
                      n += 1;
                      return (value as (...x: unknown[]) => unknown).apply(t, a);
                    };
                  }
                  return typeof value === "function" ? value.bind(t) : value;
                },
              });
            return wrap(statement);
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

  it("a textable number is six statements, and claiming a text a bounded few", async () => {
    const phone = mobile();
    const who = await member("cost", phone);
    const reach = counting();
    expect(await textReach(reach.db, who.personId)).toMatchObject({ to: phone.to });
    expect(reach.count()).toBe(6);
    const bookingId = await booking(who);
    const text = await textOf(bookingId, await confirm(bookingId));
    const claim = counting();
    const claimed = await claimRoutineText(claim.db, text.id, textConnection);
    expect(claimed?.status).toBe("send");
    expect(claim.count()).toBeLessThanOrEqual(12);
    if (claimed?.status === "send") {
      await settleRoutineText(db.query, claimed.row, { status: "back", error: "test" });
    }
  });
});
