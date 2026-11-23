// A full approval queue holds member emails back; it never loses them (ADR 0573, the review of PR
// #256's second round). With 500 sends waiting for a person at the email-send sender (its most),
// a class the gym cancels starts its run: the gatekeeper refuses the send as back-pressure
// (`rate_limited`), the run waits (held, the admins told) rather than failing, and once the queue
// has room its emails are sent, each member's once (routine email, ADR 0590). Its own file: it fills
// a sender's queue.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type ExtensionHost,
  type InvocationContext,
  invokeByName,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { HELD_REASON } from "../src/automations/run.ts";
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
let admin: ActingUser;
let connectionId: string;
const staff = (): InvocationContext => ({
  actor: "human",
  user: admin,
  origin: { surface: "ui" },
  db,
  integrations,
  extensionHost: shippedHost,
});
const run = <T = Record<string, unknown>>(name: string, input: unknown) =>
  invokeByName(name, input, staff()) as Promise<T>;

async function pendingIds(where: string, value: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT id FROM core_pending_action WHERE status = 'pending' AND action_kind = 'email.send' AND ${where}`,
  )
    .bind(value)
    .all<{ id: string }>();
  return rows.results.map((r) => r.id);
}

beforeAll(async () => {
  admin = await createAdmin();
  await setPreset("balanced");
  await refreshSchemaRegistry(db.query);
  for (const id of ["programs", "bookings", "memberships"]) {
    await run("extension.install", { id, shipped: true });
  }
  await refreshSchemaRegistry(db.query);
  await run("integration.setVendor", { vendor: "email-send", enabled: true });
  const mail = await run<{ connection: { id: string } }>("connection.create", {
    vendor: "email-send",
    scope: "org",
  });
  connectionId = mail.connection.id;
  await run("connection.bindResource", {
    id: connectionId,
    url: `email-send://sender/${encodeURIComponent("held@example.com")}`,
  });
  await run("automation.bindConnection", {
    id: "bookings.classCancelled",
    slot: "mail",
    connectionId,
  });
}, 120_000);

describe("a full approval queue (ADR 0573)", () => {
  it("holds a cancelled class's emails and sends them, each once, when there is room", async () => {
    // The sender's queue at its most: 500 sends the assistant asked for, waiting for a person.
    const assistant = { ...staff(), actor: "assistant" as const };
    for (let i = 0; i < 500; i++) {
      await invokeByName(
        "integration.call",
        {
          connectionId,
          resource: "EMAIL_SEND",
          method: "send",
          args: [{ to: [`filler${i}@elsewhere.test`], subject: `Filler ${i}`, text: "x" }],
        },
        assistant,
      );
    }
    expect(await pendingIds("input LIKE ?", "%Filler %")).toHaveLength(500);

    const type = await run<{ id: string }>("record.create", {
      object: "programs.classtype",
      values: { name: unique("Strength") },
    });
    const startsAt = new Date(Date.now() + 2 * DAY).toISOString();
    const classId = (
      await run<{ id: string }>("record.create", {
        object: "bookings.class",
        values: {
          classType: type.id,
          startsAt,
          endsAt: new Date(Date.parse(startsAt) + HOUR).toISOString(),
          timezone: "UTC",
          places: 5,
        },
      })
    ).id;
    const emails: string[] = [];
    for (const n of [1, 2]) {
      const email = `${unique("held").toLowerCase()}@members.test`;
      const personId = (
        await run<{ id: string }>("person.create", {
          givenName: `Held ${n}`,
          emails: [{ email }],
        })
      ).id;
      await run("x.bookings.bookFor", { classId, personId, paidAtDesk: true });
      emails.push(email);
    }
    await run("x.bookings.cancelClass", { classId, reason: "Storm" });

    // The run waits, held, rather than failing; the admins are told it is holding emails.
    await vi.waitFor(
      async () => {
        const row = await env.DB.prepare(
          "SELECT status, status_reason FROM core_automation_runs WHERE automation_id = 'bookings.classCancelled' AND record_id = ?",
        )
          .bind(classId)
          .first<{ status: string; status_reason: string | null }>();
        expect(row).toMatchObject({ status: "waiting", status_reason: HELD_REASON });
      },
      { timeout: 60_000, interval: 500 },
    );
    const notice = await env.DB.prepare(
      "SELECT title FROM core_notifications WHERE title LIKE '%is holding what it sends%'",
    ).first<{ title: string }>();
    expect(notice?.title).toContain("Class cancelled by the gym");
    for (const email of emails) expect(await pendingIds("input LIKE ?", `%${email}%`)).toEqual([]);

    // Room again: a person rejects the filler.
    const filler = await pendingIds("input LIKE ?", "%Filler %");
    for (let i = 0; i < filler.length; i += 100) {
      await run("approval.reject", { actionIds: filler.slice(i, i + 100) });
    }
    // On its next try (30 seconds on) the run sends each member's email, once: routine email
    // (ADR 0590) goes on its own once the sender has room.
    await vi.waitFor(
      async () => {
        for (const email of emails) {
          const rows = await env.DB.prepare(
            "SELECT status FROM core_routine_mail WHERE kind = 'bookings.cancellation' AND recipient = ?",
          )
            .bind(email)
            .all<{ status: string }>();
          expect(rows.results).toEqual([{ status: "sent" }]);
        }
      },
      { timeout: 120_000, interval: 1_000 },
    );
    for (const email of emails) expect(await pendingIds("input LIKE ?", `%${email}%`)).toEqual([]);
  }, 600_000);
});
