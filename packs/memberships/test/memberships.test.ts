// The Memberships pack against the SDK's test host: the manifest passes the contract (a plan whose
// subscription grants a membership, a pass type that grants a pass with an expiry and an intro
// offer once per person, both holders of an allowance spent by stage 31's bookings), and every
// tool asks the host what it should and passes on what the host answered. The host's rules (the
// grant following its subscription, the pass's uses and expiry, one intro offer per person, the
// spend refused past the limit) are tested against the real host in
// apps/runner/test/memberships.test.ts and packages/core/test/memberships-platform.test.ts.
import { createTestHost, type TestHost } from "@composable-os/sdk/testing";
import { describe, expect, it } from "vitest";
import {
  allowsWords,
  type Holding,
  leftWords,
  refusalWords,
  subscriptionStatus,
} from "../client/index.ts";
import memberships from "../index.ts";

const STAFF = { kind: "staff", userId: "usr_admin", name: "Sam" } as const;
const MEMBER = { kind: "customer", customerId: "cus_1", personId: "per_member" } as const;
const PUBLIC = { kind: "public" } as const;
const KNOWN = { knownObjects: ["programs.classtype", "bookings.booking"] };

function hostWith(): TestHost {
  const host: TestHost = createTestHost(memberships, {
    validate: KNOWN,
    records: {
      "memberships.plan": [
        {
          id: "rec_plan",
          title: "Three a week",
          price: 45,
          uses: 3,
          per: "week",
          classTypes: ["rec_ct"],
          weekdays: [],
          trialDays: 7,
          status: "on_sale",
        },
      ],
      "memberships.passtype": [
        {
          id: "rec_pack",
          title: "Ten classes",
          price: 200,
          uses: 10,
          validDays: 90,
          classTypes: [],
          weekdays: ["1", "2"],
          fromMinute: 540,
          untilMinute: 960,
          status: "on_sale",
        },
        {
          id: "rec_intro",
          title: "Intro week",
          price: 20,
          uses: 3,
          validDays: 7,
          onePerPerson: true,
          status: "on_sale",
        },
      ],
      "memberships.membership": [
        {
          id: "rec_m",
          title: "Three a week",
          person: "per_member",
          uses: 3,
          per: "week",
          status: "active",
          from: "2026-11-01T00:00:00.000Z",
        },
      ],
      "memberships.pass": [
        {
          id: "rec_p",
          title: "Ten classes",
          person: "per_member",
          uses: 10,
          status: "active",
          source: "purchase",
          until: "2027-02-01T00:00:00.000Z",
        },
        {
          id: "rec_given",
          title: "Ten classes",
          person: "per_member",
          uses: 2,
          status: "active",
          source: "staff",
        },
      ],
    },
    operations: {
      "public.list": (input) => ({
        items: [...(host.records.get(String(input.object))?.values() ?? [])].map((v) => ({
          id: v.id,
          values: v,
        })),
        nextCursor: null,
        currency: "AUD",
      }),
      // A customer's own: the test host's record store holds only the member's.
      "my.list": (input) => ({
        items: [...(host.records.get(String(input.object))?.values() ?? [])].map((v) => ({
          id: v.id,
          values: v,
        })),
        nextCursor: null,
      }),
      "allowance.get": (input) => ({
        object: input.object,
        id: input.id,
        live: true,
        at: "2026-11-24T00:00:00.000Z",
        period:
          input.object === "memberships.membership"
            ? {
                key: "week:2026-11-23",
                startsAt: "2026-11-22T13:00:00.000Z",
                endsAt: "2026-11-29T13:00:00.000Z",
                used: 1,
                left: 2,
              }
            : { key: "total", startsAt: "x", endsAt: "y", used: 4, left: 6 },
      }),
      "order.start": (input) => ({
        id: "ord_1",
        state: "pending",
        currency: "AUD",
        total: 20000,
        token: input.email ? "tok" : null,
        lines: input.lines,
      }),
    },
  });
  return host;
}

describe("the manifest", () => {
  it("passes the contract, requires Programs, and declares what the host enforces", () => {
    const host = createTestHost(memberships, { validate: KNOWN });
    expect(host.issues).toEqual([]);
    expect(host.manifest.requires).toEqual(["programs"]);
    const { plan, membership, passtype, pass } = host.manifest.objects as Record<
      string,
      // biome-ignore lint/suspicious/noExplicitAny: reading the declaration's shape in a test.
      any
    >;
    // A subscription to a plan grants a membership that follows it (ADR 0510).
    expect(plan.sellable.recurring.grants.object).toBe("membership");
    expect(plan.sellable.recurring.grants.set.person).toBe("subscription.holder");
    expect(plan.sellable.recurring.grants.until).toBe("until");
    // Only the membership says empty uses is unlimited; a pass's empty uses is none.
    expect(membership.allowance.holds.emptyIsUnlimited).toBe(true);
    expect(pass.allowance.holds.emptyIsUnlimited).toBeUndefined();
    expect(membership.allowance.holds.live).toEqual(["trialing", "active", "past_due"]);
    // A pass's expiry is the host's, from the pass type's days (ADR 0511), and the intro offer is
    // one per person (ADR 0512).
    expect(passtype.sellable.grants.valid).toEqual({
      from: "from",
      until: "until",
      days: "item.validDays",
    });
    expect(passtype.sellable.onePerPerson).toBe("onePerPerson");
    // Stage 31's booking spends them, by class type and the local weekday and minute.
    for (const holder of [membership, pass]) {
      expect(holder.allowance.holds.spendsOn.object).toBe("bookings.booking");
      expect(holder.allowance.holds.spendsOn.when.map((c: { field: string }) => c.field)).toEqual([
        "classType",
        "weekday",
        "minute",
        "minute",
      ]);
    }
    // No term of what a member holds is writable by anyone but the host and this pack's tools.
    for (const holder of [membership, pass]) {
      for (const [name, field] of Object.entries(holder.fields as Record<string, { readOnly?: boolean }>)) {
        if (name !== "status") expect(field.readOnly, name).toBe(true);
      }
      expect(holder.customer.write).toEqual([]);
    }
    // Giving and voiding a pass by hand: a person only, with the pack's grantable permission.
    expect(host.manifest.tools?.givePass?.humanOnly).toBe(true);
    expect(host.manifest.tools?.voidPass?.humanOnly).toBe(true);
    expect(host.manifest.tools?.givePass?.permission).toBe("memberships:passes");
    expect(host.manifest.grantable).toEqual(["memberships:passes"]);
  });
});

describe("the tools", () => {
  it("plans: the plans on sale with the host's prices and currency", async () => {
    const host = hostWith();
    const out = await host.runTool<{ plans: { id: string; uses: number; per: string }[]; currency: string }>(
      "plans",
      {},
      { caller: PUBLIC },
    );
    expect(out.plans).toEqual([
      expect.objectContaining({ id: "rec_plan", uses: 3, per: "week", price: 45, trialDays: 7 }),
    ]);
    expect(out.currency).toBe("AUD");
    expect(host.calls.map((c) => c.operation)).toEqual(["public.list"]);
  });

  it("passTypes: the passes on sale, the intro offer marked", async () => {
    const host = hostWith();
    const out = await host.runTool<{ passTypes: { id: string; onePerPerson: boolean }[] }>(
      "passTypes",
      {},
      { caller: PUBLIC },
    );
    expect(out.passTypes.map((p) => [p.id, p.onePerPerson])).toEqual([
      ["rec_pack", false],
      ["rec_intro", true],
    ]);
  });

  it("buy: starts an order for one pass, a guest with their email; the host prices it", async () => {
    const host = hostWith();
    const out = await host.runTool<{ id: string; token: string | null }>(
      "buy",
      { passTypeId: "rec_pack", email: "a@b.test" },
      { caller: PUBLIC },
    );
    expect(out).toEqual(expect.objectContaining({ id: "ord_1", token: "tok" }));
    expect(host.calls.find((c) => c.operation === "order.start")?.input).toEqual({
      lines: [{ object: "memberships.passtype", id: "rec_pack", quantity: 1 }],
      pay: "full",
      email: "a@b.test",
    });
  });

  it("mine: the member's own holdings, with the host's count of what is left", async () => {
    const host = hostWith();
    const out = await host.runTool<{ holdings: Holding[] }>("mine", {}, { caller: MEMBER });
    const membership = out.holdings.find((h) => h.kind === "membership");
    expect(membership?.period?.left).toBe(2);
    expect(membership && leftWords(membership)).toBe("2 of 3 left this week");
    const pass = out.holdings.find((h) => h.id === "rec_p");
    expect(pass && leftWords(pass)).toBe("6 of 10 left");
    expect(host.calls.filter((c) => c.operation === "allowance.get")).toHaveLength(3);
    expect(host.calls.filter((c) => c.operation === "my.list")).toHaveLength(2);
  });

  it("holdings: staff read one person's holdings", async () => {
    const host = hostWith();
    const out = await host.runTool<{ holdings: Holding[] }>(
      "holdings",
      { personId: "per_member" },
      { caller: STAFF },
    );
    expect(out.holdings).toHaveLength(3);
    const list = host.calls.find((c) => c.operation === "record.list");
    expect(list?.input).toEqual(
      expect.objectContaining({ filter: { field: "person", op: "eq", value: "per_member" } }),
    );
  });

  it("givePass: a pass from the pass type's terms, given by staff, with who and why", async () => {
    const host = hostWith();
    const out = await host.runTool<{ passId: string; source: string }>(
      "givePass",
      { personId: "per_member", passTypeId: "rec_pack", reason: "Sorry for the cancelled class" },
      { caller: STAFF },
    );
    expect(out.source).toBe("staff");
    const created = host.calls.find((c) => c.operation === "record.create")?.input as {
      values: Record<string, unknown>;
    };
    expect(created.values).toEqual(
      expect.objectContaining({
        person: "per_member",
        passtype: "rec_pack",
        uses: 10,
        weekdays: ["1", "2"],
        fromMinute: 540,
        source: "staff",
        reason: "Sorry for the cancelled class (Sam)",
      }),
    );
    expect(typeof created.values.until).toBe("string");
  });

  it("voidPass: voids a pass staff gave, from a current read; a bought one is refused", async () => {
    const host = hostWith();
    await host.runTool("voidPass", { passId: "rec_given", reason: "Given in error" }, { caller: STAFF });
    expect(host.calls.find((c) => c.operation === "record.update")?.input).toEqual(
      expect.objectContaining({ values: { status: "void", reason: "Given in error (Sam)" }, from: "active" }),
    );
    await expect(
      host.runTool("voidPass", { passId: "rec_p", reason: "Given in error" }, { caller: STAFF }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("display helpers", () => {
  it("say what a plan allows and why the host refused a pass, in words", () => {
    expect(
      allowsWords({ uses: 3, per: "week", weekdays: ["1", "3"], fromMinute: 540, untilMinute: 960 }),
    ).toBe("3 classes a week · Mon, Wed · from 09:00 before 16:00");
    expect(allowsWords({ uses: null, per: "week", weekdays: [], fromMinute: null, untilMinute: null })).toBe(
      "Unlimited classes",
    );
    expect(refusalWords({ rule: "once_per_person", reason: "used" })).toContain("had yours");
    expect(refusalWords({ rule: "once_per_person", reason: "sign_in" })).toContain("sign in");
    expect(
      subscriptionStatus({
        id: "s",
        state: "active",
        planObject: "memberships.plan",
        planId: "p",
        planTitle: "x",
        amount: 4500,
        currency: "AUD",
        interval: "month",
        trialEnd: null,
        currentPeriodEnd: "2026-12-24T00:00:00.000Z",
        cancelAtPeriodEnd: true,
        cancelAt: null,
        endedAt: null,
        actionUrl: null,
        createdAt: "x",
      }),
    ).toContain("then it ends");
  });
});
