// What the routine mail tests share (ADR 0590): Programs, Bookings and Memberships as shipped, an
// email-send connection bound to every Bookings automation that mails, routine email turned on,
// and the members, passes, classes and bookings the tests make.
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type CustomerPrincipal,
  type InvocationContext,
  type OutsideInvocationContext,
  queueEventSink,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { afterAll, beforeAll, expect, vi } from "vitest";
import { integrationRuntime } from "../src/integrations/runtime.ts";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, db, newCustomer, run, unique } from "./helpers.ts";
import { gymHost } from "./pack-files.ts";

export const shippedHost = gymHost;

export const integrations = integrationRuntime(env);
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const CLASS = "bookings.class";
export const SITE = "https://gym.example";
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
export let admin: ActingUser;
export let mailConnection: string;
const sink = queueEventSink(env.AUTOMATION_EVENTS);
export const staff = (extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user: admin,
  origin: { surface: "ui" },
  db,
  integrations,
  extensionHost: shippedHost,
  events: sink,
  ...extra,
});
export const as = (principal: CustomerPrincipal): OutsideInvocationContext => ({
  principal,
  db,
  integrations,
  extensionHost: shippedHost,
  events: sink,
});
export const create = async (object: string, values: Record<string, unknown>) =>
  (await run<{ id: string }>("record.create", { object, values }, staff())).id;

export interface Sent {
  to: string[];
  subject: string;
  text?: string;
}
export async function mailTo(address: string): Promise<Sent[]> {
  const all = (await env.TEST_EMAIL_OUTBOX.list()) as Sent[];
  return all.filter((m) => m.to.includes(address.toLowerCase()));
}

export interface Row {
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
export async function rowsFor(recordId: string, count = 1): Promise<Row[]> {
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

export async function member(
  label: string,
  name?: string,
): Promise<CustomerPrincipal & { email: string }> {
  const { principal, email } = await newCustomer(staff(), label, { givenName: name });
  return { ...principal, email };
}

export async function givePass(personId: string): Promise<void> {
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

/** The class type `klass` makes classes of. */
export let classType: string;
export async function klass(extra: Record<string, unknown> = {}): Promise<string> {
  const startsAt = new Date(Date.now() + 2 * DAY).toISOString();
  return create(CLASS, {
    classType,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + HOUR).toISOString(),
    timezone: "Australia/Sydney",
    places: 10,
    ...extra,
  });
}

export type Out = Record<string, unknown> & { result: string; bookingId?: string };
export const book = (
  who: CustomerPrincipal,
  classId: string,
  extra: Record<string, unknown> = {},
) => run<Out>("x.bookings.book", { classId, ...extra }, as(who));

/** A booked member, their booking's confirmation decided. */
export async function booked(label: string, classId?: string) {
  const who = await member(label);
  await givePass(who.personId);
  const k = classId ?? (await klass());
  const out = await book(who, k);
  expect(out.result).toBe("booked");
  const [row] = await rowsFor(out.bookingId as string);
  return { who, classId: k, bookingId: out.bookingId as string, row: row as Row };
}

/** Installs the packs and turns routine email on for the file's tests (and back after). */
export function useRoutineMail() {
  beforeAll(async () => {
    introspector = await introspectWorkflow(env.AUTOMATION_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    admin = await createAdmin();
    await setPreset("balanced");
    await refreshSchemaRegistry(db.query);
    for (const id of ["bookings", "memberships"]) {
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
    // Off until a human admin turns it on (D1): these tests are about routine email turned on.
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
    classType = await create("bookings.classtype", { name: unique("Strength") });
  }, 120_000);

  afterAll(async () => {
    await setPreset("balanced");
    await introspector[Symbol.asyncDispose]();
  });
}

export const mcp = () =>
  staff({ actor: "mcp", origin: { surface: "mcp", sessionId: unique("cap"), clientName: "Bot" } });
export const get = async (object: string, id: string) =>
  (await run<{ values: Record<string, unknown> }>("record.get", { object, id }, staff())).values;
export const moveClass = (classId: string, hours: number, ctx = staff()) => {
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
