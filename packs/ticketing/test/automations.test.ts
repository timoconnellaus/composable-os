// The Ticketing automations against @composable-os/sdk/testing's in-memory host: their declared
// triggers, the steps they take, and the mail they hand the email-send gatekeeper. That the host
// starts them from an order's first payment, on the day before or after an event, and every
// morning, is the host's automation engine (apps/runner/test/automations.test.ts and the
// stage 25 order event test); this tests what the pack does when it runs.
import { createTestHost } from "@composable-os/sdk/testing";
import { describe, expect, it } from "vitest";
import { BALANCE_SQL } from "../automations.ts";
import extension from "../index.ts";

const settings = {
  items: [
    {
      id: "ticketing",
      values: { ticketsUrl: "https://gym.test/tickets", payUrl: "https://gym.test/pay" },
    },
  ],
};

function host(records: Record<string, Record<string, unknown>[]> = {}, extra = {}) {
  return createTestHost(extension, {
    records: records as never,
    operations: {
      "extensionSettings.list": () => settings,
      "order.get": (input) => ({ id: input.id, email: "ann@buyers.test", state: "paid" }),
      "person.get": (input) =>
        input.id === "per_ann" ? { id: "per_ann", primaryEmail: "ann@buyers.test" } : null,
      ...extra,
    },
  });
}

const sent = (h: ReturnType<typeof host>) =>
  h.gatekeeperCalls.map((c) => ({
    ...c,
    message: c.args[0] as { to: string[]; subject: string; text: string },
  }));

describe("ticketsByEmail", () => {
  it("is started by an order's first payment, in full or by deposit, and not by the rest", () => {
    const trigger = extension.automations?.ticketsByEmail?.trigger;
    expect(trigger).toEqual({
      type: "fieldChanged",
      object: "order",
      field: "state",
      from: { in: ["pending", "expired"] },
      to: { in: ["paid", "part_paid"] },
    });
    expect(createTestHost(extension).issues).toEqual([]);
  });

  it("emails the buyer every ticket's code and the page to see them, once", async () => {
    const h = host({
      "ticketing.ticket": [
        { id: "t1", name: "Shared room", code: "AAAA", order: "ord_1", holder: "per_ann" },
        { id: "t2", name: "Shared room", code: "BBBB", order: "ord_1", holder: "per_ann" },
        { id: "t3", name: "Other", code: "CCCC", order: "ord_2", holder: "per_ann" },
      ],
      order: [{ id: "ord_1", state: "paid", email: "ann@buyers.test" }],
    });
    const run = await h.runAutomation("ticketsByEmail", {
      record: { object: "order", id: "ord_1" },
    });
    expect(run.undeclared).toEqual([]);
    const mail = sent(h);
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({
      gatekeeper: "email-send",
      connectionId: "mail",
      method: "send",
      step: "sendTickets",
    });
    expect(mail[0]?.message.to).toEqual(["ann@buyers.test"]);
    expect(mail[0]?.message.subject).toBe("Your 2 tickets");
    expect(mail[0]?.message.text).toContain("Shared room: AAAA");
    expect(mail[0]?.message.text).toContain("Shared room: BBBB");
    expect(mail[0]?.message.text).not.toContain("CCCC");
    expect(mail[0]?.message.text).toContain("https://gym.test/tickets?order=ord_1");
  });

  it("sends nothing for an order that granted no ticket", async () => {
    const h = host({ "ticketing.ticket": [], order: [{ id: "ord_9", state: "paid" }] });
    const run = await h.runAutomation("ticketsByEmail", {
      record: { object: "order", id: "ord_9" },
    });
    expect(run.undeclared).toEqual([]);
    expect(h.gatekeeperCalls).toEqual([]);
  });
});

describe("eventReminder", () => {
  it("runs the day before an event on sale", () => {
    const automation = extension.automations?.eventReminder;
    expect(automation?.trigger).toMatchObject({
      type: "dateRelative",
      field: "startsAt",
      offsetDays: -1,
    });
    expect(automation?.conditions).toEqual({ field: "status", op: "eq", value: "on_sale" });
  });

  it("emails each holder of a valid ticket once, and nobody else", async () => {
    const h = host({
      "ticketing.event": [
        {
          id: "ev1",
          name: "Camp",
          status: "on_sale",
          startsAt: "2027-02-01T08:00:00Z",
          venue: "The gym",
        },
      ],
      "ticketing.ticket": [
        { id: "t1", event: "ev1", state: "valid", holder: "per_ann" },
        { id: "t2", event: "ev1", state: "valid", holder: "per_ann" },
        { id: "t3", event: "ev1", state: "void", holder: "per_bob" },
        { id: "t4", event: "ev2", state: "valid", holder: "per_bob" },
      ],
    });
    const run = await h.runAutomation("eventReminder", {
      record: { object: "ticketing.event", id: "ev1" },
    });
    expect(run.undeclared).toEqual([]);
    const mail = sent(h);
    expect(mail.map((m) => m.message.to)).toEqual([["ann@buyers.test"]]);
    expect(mail[0]?.message.subject).toBe("Tomorrow: Camp");
    expect(mail[0]?.message.text).toContain("at The gym");
    expect(mail[0]?.message.text).toContain("2 tickets");
  });

  it("does not run for an event that is not on sale", async () => {
    const h = host({ "ticketing.event": [{ id: "ev1", name: "Camp", status: "cancelled" }] });
    const run = await h.runAutomation("eventReminder", {
      record: { object: "ticketing.event", id: "ev1" },
    });
    expect(run.steps).toEqual([]);
    expect(h.gatekeeperCalls).toEqual([]);
  });
});

describe("eventEnded", () => {
  it("moves an event on sale to ended the day after it ends", async () => {
    const automation = extension.automations?.eventEnded;
    expect(automation?.trigger).toMatchObject({
      type: "dateRelative",
      field: "endsAt",
      offsetDays: 1,
    });
    const h = host({ "ticketing.event": [{ id: "ev1", name: "Camp", status: "on_sale" }] });
    const run = await h.runAutomation("eventEnded", {
      record: { object: "ticketing.event", id: "ev1" },
    });
    expect(run.undeclared).toEqual([]);
    expect(h.records.get("ticketing.event")?.get("ev1")).toMatchObject({ status: "ended" });
    expect(h.calls.find((c) => c.operation === "record.update")?.input).toMatchObject({
      from: "on_sale",
    });
  });
});

describe("balanceReminders", () => {
  it("every morning, emails buyers whose balance is due in a week or tomorrow, with the link to pay", async () => {
    let asked: { sql?: string; params?: unknown[] } = {};
    const h = host(
      {},
      {
        "query.sql": (input: { sql: string; params: unknown[] }) => {
          asked = input;
          return {
            rows: [
              {
                id: "ord_1",
                email: "ann@buyers.test",
                balance: 80000,
                currency: "AUD",
                due: "2026-11-28T23:59:59.999Z",
              },
            ],
          };
        },
      },
    );
    expect(extension.automations?.balanceReminders?.trigger).toEqual({
      type: "schedule",
      cron: "0 9 * * *",
    });
    const run = await h.runAutomation("balanceReminders", { period: "2026-11-21" });
    expect(run.undeclared).toEqual([]);
    expect(asked.sql).toBe(BALANCE_SQL);
    // A week from the period and the day after it.
    expect(asked.params).toEqual(["2026-11-28", "2026-11-22"]);
    expect(BALANCE_SQL).toContain("o.state = 'part_paid'");
    const mail = sent(h);
    expect(mail).toHaveLength(1);
    expect(mail[0]?.message.subject).toBe("Balance due 2026-11-28");
    expect(mail[0]?.message.text).toContain("800.00 AUD");
    expect(mail[0]?.message.text).toContain("https://gym.test/pay?order=ord_1");
  });

  it("sends nothing on a day nothing falls due", async () => {
    const h = host({}, { "query.sql": () => ({ rows: [] }) });
    const run = await h.runAutomation("balanceReminders", { period: "2026-11-21" });
    expect(run.undeclared).toEqual([]);
    expect(h.gatekeeperCalls).toEqual([]);
  });
});
