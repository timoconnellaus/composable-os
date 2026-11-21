// Criterion 1 (local half): the Ticketing pack passes its contract and formula checks, and each
// tool does what it says against @composable-os/sdk/testing's in-memory host. What only the real
// host can show (granting in the paid batch, the sale rules, places, isolation through the seam,
// two scanners at once, the door role over the whole registry) is in
// apps/runner/test/ticketing.test.ts, which runs this same pack in the sandbox.
import { createTestHost } from "@composable-os/sdk/testing";
import { describe, expect, it } from "vitest";
import extension from "../index.ts";
import { normaliseCode } from "../tools.ts";

const CODE = "0123456789ABCDEFGHJKMNPQRS";
const OTHER = "ZZZZZZZZZZZZZZZZZZZZZZZZZZ";

function host(
  tickets: (Record<string, unknown> & { id: string })[] = [],
  order?: Record<string, unknown>,
) {
  return createTestHost(extension, {
    records: {
      person: [{ id: "per_ann", displayName: "Ann Buyer" }],
      "ticketing.event": [{ id: "ev1", name: "Gains in the Ghetto", status: "on_sale" }],
      "ticketing.ticket": tickets,
    },
    operations: {
      // The host's person.get answers with the person's fields (displayName), not a record.
      "person.get": (input) =>
        input.id === "per_ann" ? { id: "per_ann", displayName: "Ann Buyer" } : null,
      "order.get": () =>
        order ?? { state: "paid", balance: 0, currency: "AUD", balanceDueAt: null },
    },
  });
}

const ticket = (values: Record<string, unknown> = {}) => ({
  id: "tkt1",
  name: "Shared room",
  code: CODE,
  tickettype: "tt1",
  event: "ev1",
  holder: "per_ann",
  order: "ord_1",
  state: "valid",
  ...values,
});

describe("ticketing pack (test host)", () => {
  it("passes the contract and formula checks, and declares its objects and the door role", () => {
    const h = host();
    expect(h.issues).toEqual([]);
    expect(Object.keys(h.manifest.objects)).toEqual(["event", "tickettype", "ticket"]);
    expect(Object.keys(h.manifest.tools)).toEqual([
      "eventsOnSale",
      "orderStart",
      "myTickets",
      "salesSummary",
      "checkIn",
      "undoCheckIn",
    ]);
    expect(h.manifest.tools.orderStart?.audiences).toEqual(["customer", "public"]);
    expect(h.manifest.tools.eventsOnSale).toMatchObject({
      risk: "read",
      audiences: ["customer", "public"],
    });
    expect(h.manifest.objects.event?.public?.when).toEqual({ field: "status", in: ["on_sale"] });
    expect(h.manifest.objects.tickettype?.public?.when).toEqual({
      via: "event",
      field: "status",
      in: ["on_sale"],
    });
    expect(h.manifest.tools.myTickets?.audiences).toEqual(["customer"]);
    expect(h.manifest.tools.salesSummary?.audiences).toBeUndefined();
    expect(h.manifest.tools.checkIn).toMatchObject({
      risk: "write",
      permission: "ticketing:checkin",
    });
    expect(h.manifest.tools.undoCheckIn?.permission).toBe("ticketing:checkin");
    expect(h.manifest.roles).toEqual({
      door: {
        label: "Door",
        description: expect.any(String),
        permissions: ["ticketing:checkin"],
        read: ["ticketing.event", "ticketing.tickettype", "ticketing.ticket"],
      },
    });
    expect(h.manifest.objects.ticket?.customer).toEqual({
      field: "holder",
      read: ["event", "tickettype", "code", "state"],
      write: [],
    });
    expect(h.manifest.objects.tickettype?.sellable?.grants?.object).toBe("ticket");
  });

  it("orderStart asks the host for the order and sends no price", async () => {
    let asked: unknown = null;
    const h = createTestHost(extension, {
      operations: {
        "order.start": (input) => {
          asked = input;
          return {
            id: "ord_1",
            state: "pending",
            currency: "AUD",
            total: 9000,
            paid: 0,
            balance: 9000,
            pay: "full",
            deposit: null,
            balanceDueAt: null,
            expiresAt: "2026-11-21T10:15:00.000Z",
            lines: [
              {
                id: "oln_1",
                recordId: "tt1",
                title: "Shared room",
                quantity: 2,
                unitPrice: 4500,
                total: 9000,
              },
            ],
            token: "tok",
          };
        },
      },
    });
    const out = await h.runTool<{ total: number; token: string; lines: unknown[] }>(
      "orderStart",
      { lines: [{ ticketTypeId: "tt1", quantity: 2, price: 1 }], email: "a@b.test" },
      { caller: { kind: "public" } },
    );
    expect(asked).toEqual({
      lines: [{ object: "ticketing.tickettype", id: "tt1", quantity: 2 }],
      pay: "full",
      email: "a@b.test",
    });
    expect(out.total).toBe(9000);
    expect(out.token).toBe("tok");
    expect(out.lines).toEqual([
      {
        id: "oln_1",
        ticketTypeId: "tt1",
        title: "Shared room",
        quantity: 2,
        unitPrice: 4500,
        total: 9000,
      },
    ]);
  });

  it("myTickets lists through my.list and filters only by what the caller asks", async () => {
    const asked: unknown[] = [];
    const h = createTestHost(extension, {
      operations: {
        "my.list": (input) => {
          // The ticket's event and type, as the seam gives a holder them (ADR 0439).
          if (input.object === "ticketing.event") {
            return {
              items: [
                {
                  id: "ev1",
                  title: null,
                  values: {
                    name: "Camp",
                    startsAt: "2027-02-01T00:00:00Z",
                    endsAt: null,
                    timezone: "Asia/Bangkok",
                    venue: "Phuket",
                    status: "ended",
                  },
                },
              ],
              nextCursor: null,
            };
          }
          if (input.object === "ticketing.tickettype") {
            return {
              items: [{ id: "tt1", title: null, values: { name: "Shared" } }],
              nextCursor: null,
            };
          }
          asked.push(input);
          return {
            items: [
              {
                id: "tkt1",
                title: null,
                values: { event: "ev1", tickettype: "tt1", code: CODE, state: "valid" },
              },
            ],
            nextCursor: null,
          };
        },
      },
    });
    const out = await h.runTool<{ items: unknown[] }>(
      "myTickets",
      {},
      { caller: { kind: "customer" } },
    );
    expect(out.items).toEqual([
      {
        id: "tkt1",
        event: "ev1",
        ticketType: "tt1",
        code: CODE,
        state: "valid",
        eventName: "Camp",
        startsAt: "2027-02-01T00:00:00Z",
        endsAt: null,
        timeZone: "Asia/Bangkok",
        venue: "Phuket",
        eventStatus: "ended",
        ticketTypeName: "Shared",
      },
    ]);
    await h.runTool("myTickets", { code: CODE, event: "ev1" }, { caller: { kind: "customer" } });
    expect(asked[0]).toMatchObject({ object: "ticketing.ticket", limit: 50 });
    expect(asked[0]).not.toHaveProperty("filter");
    expect(asked[1]).toMatchObject({
      filter: {
        and: [
          { field: "event", op: "eq", value: "ev1" },
          { field: "code", op: "eq", value: CODE },
        ],
      },
    });
  });

  it("salesSummary adds up the host's numbers per ticket type", async () => {
    const h = createTestHost(extension, {
      records: {
        "ticketing.event": [{ id: "ev1", name: "Camp", status: "on_sale", available: 30 }],
        "ticketing.tickettype": [
          { id: "tt1", event: "ev1", name: "Shared", price: 450, taken: 12, held: 2, available: 6 },
          {
            id: "tt2",
            event: "ev1",
            name: "Single",
            price: 650,
            taken: 3,
            held: 0,
            available: null,
          },
          { id: "tt3", event: "other", name: "Elsewhere", price: 1, taken: 99 },
        ],
      },
      operations: {
        "query.sql": (input) => {
          expect(String(input.sql)).toContain("o.state IN ('paid', 'part_paid')");
          expect(input.params).toEqual(["ticketing.tickettype", "tt1", "tt2"]);
          return { rows: [{ id: "tt1", revenue: 540000 }], columns: [], rowCount: 1 };
        },
        // The currency the amounts are in is the host's setting, not the pack's.
        "order.settings.get": () => ({ currency: "AUD" }),
      },
    });
    const out = await h.runTool<{
      ticketTypes: { id: string; sold: number; revenue: number; remaining: number | null }[];
      totals: Record<string, unknown>;
      currency: string | null;
    }>("salesSummary", { eventId: "ev1" });
    expect(out.currency).toBe("AUD");
    const rows = out.ticketTypes.map((t) => [t.id, t.sold, t.revenue, t.remaining]);
    expect(rows.sort()).toEqual([
      ["tt1", 12, 540000, 6],
      ["tt2", 3, 0, null],
    ]);
    expect(out.totals).toEqual({ sold: 15, held: 2, remaining: 30, revenue: 540000 });
  });
});

describe("eventsOnSale (test host)", () => {
  it("lists through public.list and asks capacity.get for places: the host decides what is public", async () => {
    const asked: Record<string, unknown>[] = [];
    const h = createTestHost(extension, {
      operations: {
        "public.list": (input) => {
          asked.push(input);
          return input.object === "ticketing.event"
            ? {
                items: [
                  {
                    id: "ev1",
                    title: null,
                    values: { name: "Camp", startsAt: "2027-02-01T00:00:00Z", status: "on_sale" },
                  },
                ],
                nextCursor: null,
              }
            : {
                items: [
                  {
                    id: "tt1",
                    title: null,
                    values: { event: "ev1", name: "Shared", price: 450, depositAmount: 100 },
                  },
                ],
                nextCursor: null,
                currency: "AUD",
              };
        },
        "capacity.get": (input) =>
          input.object === "ticketing.event"
            ? { status: "available" }
            : { status: "low", available: 3 },
      },
    });
    const out = await h.runTool<{ events: Record<string, unknown>[] }>(
      "eventsOnSale",
      {},
      { caller: { kind: "public" } },
    );
    expect(out.events).toEqual([
      expect.objectContaining({
        id: "ev1",
        name: "Camp",
        availability: { status: "available" },
        ticketTypes: [
          expect.objectContaining({
            id: "tt1",
            price: 450,
            // Passed on from the host's answer, beside the price.
            currency: "AUD",
            deposit: 100,
            availability: { status: "low", available: 3 },
          }),
        ],
      }),
    ]);
    // No filter of its own on status: which events are on sale is the seam's to say.
    expect(asked[0]).toEqual({
      object: "ticketing.event",
      sort: { field: "startsAt", direction: "asc" },
      limit: 20,
    });
    expect(asked[1]).toMatchObject({ filter: { field: "event", op: "eq", value: "ev1" } });
  });
});

describe("checkIn (test host)", () => {
  const scanner = { kind: "staff" as const, userId: "usr_coach", name: "Coach Kim" };

  it("accepts a valid ticket once and records who and when", async () => {
    const h = host([ticket()]);
    const out = await h.runTool<{
      result: string;
      accepted: boolean;
      ticket: { usedBy: unknown; holder: unknown };
    }>("checkIn", { code: CODE.toLowerCase() }, { caller: scanner });
    expect(out.result).toBe("accepted");
    expect(out.accepted).toBe(true);
    expect(out.ticket.usedBy).toEqual({ id: "usr_coach", name: "Coach Kim" });
    expect(out.ticket.holder).toEqual({ id: "per_ann", name: "Ann Buyer" });
    const stored = h.records.get("ticketing.ticket")?.get("tkt1");
    expect(stored).toMatchObject({ state: "used", usedBy: "usr_coach", usedByName: "Coach Kim" });
    // The write asked the host to move it out of `valid` only (ADR 0437).
    expect(h.calls.find((c) => c.operation === "record.update")?.input).toMatchObject({
      from: "valid",
    });

    const again = await h.runTool<{ result: string; accepted: boolean; message: string }>(
      "checkIn",
      { code: CODE },
      { caller: { kind: "staff", userId: "usr_other", name: "Other" } },
    );
    expect(again).toMatchObject({ result: "already_used", accepted: false });
    expect(again.message).toContain("Coach Kim");
  });

  it("refuses void and unknown codes, each with its own reason", async () => {
    const h = host([ticket({ state: "void" })]);
    const voided = await h.runTool<{ result: string; message: string }>("checkIn", { code: CODE });
    expect(voided.result).toBe("void");
    const unknown = await h.runTool<{ result: string; message: string }>("checkIn", {
      code: OTHER,
    });
    expect(unknown.result).toBe("unknown");
    expect(unknown.message).not.toBe(voided.message);
    const garbage = await h.runTool<{ result: string }>("checkIn", { code: "hello" });
    expect(garbage.result).toBe("unknown");
  });

  it("lets a ticket with a balance owing in and says how much", async () => {
    const h = host([ticket()], {
      state: "part_paid",
      balance: 30000,
      currency: "AUD",
      balanceDueAt: "2027-01-31T23:59:59.999Z",
    });
    const out = await h.runTool<{ accepted: boolean; balanceOwing: unknown; message: string }>(
      "checkIn",
      { code: CODE },
      { caller: scanner },
    );
    expect(out.accepted).toBe(true);
    expect(out.balanceOwing).toEqual({
      amount: 30000,
      currency: "AUD",
      dueAt: "2027-01-31T23:59:59.999Z",
    });
    expect(out.message).toContain("300.00 AUD");
  });

  it("normalises a typed code", () => {
    expect(normaliseCode(" 0123-4567 89ab ")).toBe("0123456789AB");
  });
});

describe("undoCheckIn (test host)", () => {
  it("makes a used ticket valid again, and leaves any other alone", async () => {
    const h = host([
      ticket({ state: "used", usedAt: "2026-11-21T09:00:00.000Z", usedBy: "usr_coach" }),
    ]);
    const out = await h.runTool<{ undone: boolean; ticket: { state: string; usedBy: unknown } }>(
      "undoCheckIn",
      { ticketId: "tkt1" },
    );
    expect(out.undone).toBe(true);
    expect(out.ticket).toMatchObject({ state: "valid", usedBy: null });
    const again = await h.runTool<{ undone: boolean; message: string }>("undoCheckIn", {
      ticketId: "tkt1",
    });
    expect(again.undone).toBe(false);
    expect(again.message).toContain("not checked in");
  });
});
