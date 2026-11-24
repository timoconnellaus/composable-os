// The contract's own rules, beside the conformance suite: what the input checks refuse, how a
// refusal travels, that nothing outside the contract leaves the shared reads, how the fake counts
// its calls and records hints, and the fake gatekeeper's vendor, account and facet: no action of
// any kind, each read an observation.

import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { directSession } from "../src/direct.js";
import { FakeBookingSystem, fakeBookingSystemState } from "../src/fake.js";
import {
  EXPIRING_REFUSALS,
  REFUSAL_CODES,
  refusalCode,
  refuse,
  TRANSIENT_REFUSALS,
} from "../src/refusal.js";
import { BOOKING_SYSTEM_SESSION_METHODS } from "../src/session.js";
import {
  CONTRACT_KEYS,
  parseBookingsInput,
  parseClassesQuery,
  parseHintsInput,
  parseMembershipsInput,
  parsePeopleQuery,
  parseVisitsQuery,
} from "../src/validate.js";

const NOW = "2026-11-20T09:00:00.000Z";

function code(fn: () => unknown): string | null {
  try {
    fn();
  } catch (error) {
    return refusalCode(error);
  }
  return "accepted";
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
  } catch (error) {
    return refusalCode(error);
  }
  return "accepted";
}

function fake(options = {}) {
  return new FakeBookingSystem(fakeBookingSystemState({ now: NOW, ...options }));
}

describe("input checks", () => {
  it("takes a query with only its known keys, and times only with an offset", () => {
    expect(parsePeopleQuery(undefined)).toEqual({});
    expect(parsePeopleQuery({ modifiedSince: "2026-11-20T09:00:00+11:00" })).toEqual({
      modifiedSince: "2026-11-20T09:00:00+11:00",
    });
    expect(code(() => parsePeopleQuery({ since: NOW }))).toBe("invalid");
    expect(code(() => parsePeopleQuery({ modifiedSince: "2026-11-20T09:00:00" }))).toBe("invalid");
    expect(code(() => parsePeopleQuery({ modifiedSince: "2026-11-20" }))).toBe("invalid");
    expect(code(() => parsePeopleQuery({ cursor: "" }))).toBe("invalid");
  });

  it("holds people to 1 to 200 and classes to 1 to 50, each ref once", () => {
    const refs = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`);
    expect(parseMembershipsInput({ people: refs(200) }).people).toHaveLength(200);
    expect(code(() => parseMembershipsInput({ people: refs(201) }))).toBe("invalid");
    expect(code(() => parseMembershipsInput({ people: [] }))).toBe("invalid");
    expect(code(() => parsePeopleQuery({ refs: refs(201) }))).toBe("invalid");
    expect(code(() => parseMembershipsInput({ people: ["a", "a"] }))).toBe("invalid");
    expect(code(() => parseMembershipsInput({ people: ["has space"] }))).toBe("invalid");
    expect(parseBookingsInput({ classes: refs(50) }).classes).toHaveLength(50);
    expect(code(() => parseBookingsInput({ classes: refs(51) }))).toBe("invalid");
  });

  it("holds classes to 35 days and visits to 366, each window ending after it starts", () => {
    const from = "2026-11-01T00:00:00Z";
    expect(parseClassesQuery({ from, until: "2026-12-06T00:00:00Z" })).toEqual({
      from,
      until: "2026-12-06T00:00:00Z",
    });
    expect(code(() => parseClassesQuery({ from, until: "2026-12-06T00:00:01Z" }))).toBe("invalid");
    expect(code(() => parseClassesQuery({ from, until: from }))).toBe("invalid");
    expect(code(() => parseClassesQuery({ from }))).toBe("invalid");
    expect(
      parseVisitsQuery({
        person: "p1",
        from: "2025-11-01T00:00:00Z",
        until: "2026-11-01T00:00:00Z",
      }),
    ).toMatchObject({ person: "p1" });
    expect(
      code(() => parseVisitsQuery({ person: "p1", from: "2025-10-30T00:00:00Z", until: from })),
    ).toBe("invalid");
  });

  it("takes 1 to 100 hints", () => {
    expect(parseHintsInput({ max: 100 })).toEqual({ max: 100 });
    for (const max of [0, 101, 1.5, "10"])
      expect(code(() => parseHintsInput({ max }))).toBe("invalid");
  });
});

describe("refusals", () => {
  it("carry their code at the front of the message, and are found behind other text", () => {
    for (const c of REFUSAL_CODES) {
      const error = refuse(c, "why");
      expect(error.message).toBe(`[booking-system:${c}] why`);
      expect(refusalCode(`Error: ${error.message}`)).toBe(c);
    }
    expect(refusalCode("[booking-system:made_up] no")).toBeNull();
    expect(refusalCode("[accounting:invalid] no")).toBeNull();
    expect(TRANSIENT_REFUSALS).toEqual(["rate_limited", "unavailable"]);
    expect(EXPIRING_REFUSALS).toEqual(["unauthorised", "not_activated"]);
  });
});

describe("the shared reads", () => {
  it("copy only the contract's fields, whatever the system answers, and cut long text", async () => {
    const site = fake();
    const listPeople = site.listPeople.bind(site);
    site.listPeople = async (query) => {
      const page = await listPeople(query);
      return {
        ...page,
        items: page.items.map((p) => ({
          ...p,
          phone: "0000",
          birthDate: "2000-01-01",
          notes: "x",
        })),
      };
    };
    const listClasses = site.listClasses.bind(site);
    site.listClasses = async (query) => {
      const page = await listClasses(query);
      return { ...page, items: page.items.map((c) => ({ ...c, title: "t".repeat(900) })) };
    };
    const session = directSession(site);
    const { items } = await session.listPeople({});
    for (const p of items) expect(Object.keys(p).sort()).toEqual([...CONTRACT_KEYS.person].sort());
    const classes = await session.listClasses({
      from: "2026-11-20T00:00:00Z",
      until: "2026-11-22T00:00:00Z",
    });
    expect(classes.items[0]?.title).toHaveLength(500);
  });

  it("answer memberships and bookings only for what was asked", async () => {
    const site = fake();
    site.listMemberships = async () => structuredClone(site.state.memberships);
    site.listBookings = async () => structuredClone(site.state.bookings);
    const session = directSession(site);
    const memberships = await session.listMemberships({ people: ["fake-person-001"] });
    expect(new Set(memberships.map((m) => m.person))).toEqual(new Set(["fake-person-001"]));
    const bookings = await session.listBookings({ classes: ["fake-class-0001"] });
    expect(bookings.length).toBeGreaterThan(0);
    expect(new Set(bookings.map((b) => b.class))).toEqual(new Set(["fake-class-0001"]));
  });
});

describe("the fake booking system", () => {
  it("counts a failed call, but not a rate-limited one or one over budget", async () => {
    const site = fake();
    await site.listStaff();
    site.failNext("listStaff", "unavailable");
    expect(await codeOf(site.listStaff())).toBe("unavailable");
    site.failNext("listStaff", "rate_limited");
    expect(await codeOf(site.listStaff())).toBe("rate_limited");
    expect(site.callCount()).toEqual({ used: 2, byMethod: { listStaff: 2 } });
    site.setBudget(2);
    expect(await codeOf(site.listPeople({}))).toBe("over_budget");
    expect(site.callCount().used).toBe(2);
    // The site is still described, with the counter, over budget.
    expect((await site.describeSite()).calls).toMatchObject({ used: 2, budget: 2 });
  });

  it("starts the count again when the month turns", async () => {
    const site = fake({ now: "2026-11-30T23:59:00Z" });
    await site.listStaff();
    expect((await site.describeSite()).calls.month).toBe("2026-11");
    site.advance(120);
    expect((await site.describeSite()).calls).toMatchObject({ month: "2026-12", used: 0 });
  });

  it("records a hint for each change, naming what to read again", async () => {
    const site = fake();
    site.change("person", "fake-person-002", { familyName: "Changed" });
    site.change("membership", "fake-membership-1", { status: "cancelled" });
    site.change("booking", "fake-booking-1-1", { state: "cancelled" });
    expect(await site.takeHints(10)).toEqual([
      { kind: "person", refs: ["fake-person-002"] },
      { kind: "membership", refs: ["fake-person-001"] },
      { kind: "booking", refs: ["fake-class-0001"] },
    ]);
    expect(await site.takeHints(10)).toEqual([]);
    site.setHints("none");
    site.change("person", "fake-person-002", { familyName: "Again" });
    expect(await site.takeHints(10)).toEqual([]);
  });

  it("holds invented people only, with example addresses and nothing else about them", () => {
    const { people, staff } = fakeBookingSystemState({ now: NOW });
    for (const p of [...people, ...staff]) {
      expect(p.email === null || p.email.endsWith("@example.com")).toBe(true);
    }
    expect(people.some((p) => p.email === null)).toBe(true);
  });
});

describe("the fake gatekeeper", () => {
  async function open() {
    const site = `site-${crypto.randomUUID().slice(0, 8)}`;
    await exports.FakeBookingSystemControl.reset(site, { now: NOW });
    const host = env.TEST_HOST.getByName(site);
    return { host, site, resource: await host.open(site) };
  }

  it("describes its vendor as auto-provisioned, with no sign-in", async () => {
    const vendor = exports.GatekeeperVendor as unknown as {
      describe(): Promise<{
        displayName: string;
        autoProvisionsAccount?: boolean;
        providesAuth?: boolean;
      }>;
      getSupportedResources(): Promise<{ urlPattern: string }[]>;
    };
    expect(await vendor.describe()).toMatchObject({
      displayName: "Fake booking system (development)",
      autoProvisionsAccount: true,
      providesAuth: false,
    });
    expect((await vendor.getSupportedResources()).map((r) => r.urlPattern)).toEqual([
      "booking-system-fake://site/:name",
    ]);
  });

  it("refuses a resource that is not a fake site", async () => {
    const account = exports.FakeBookingSystemAccount as unknown as {
      getGatekeeperClassFor(url: string): Promise<unknown>;
    };
    await expect(
      account.getGatekeeperClassFor("booking-system-fake://site/Bad Name"),
    ).rejects.toThrow(/Not a fake booking site/);
  });

  it("serves the contract's types, with no write, and describes its resource", async () => {
    const { host, site, resource } = await open();
    expect(resource).toMatchObject({
      url: `booking-system-fake://site/${site}`,
      title: "Fake booking system (development)",
      tsType: "BookingSystemSession",
    });
    const types = await host.types();
    expect(types).toContain("export interface BookingSystemSession");
    const methods = [...types.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1]);
    expect(methods.sort()).toEqual([...BOOKING_SYSTEM_SESSION_METHODS].sort());
  });

  it("declares no action, and has none to apply, reject or revert", async () => {
    const { host } = await open();
    expect(await host.autoApprovable()).toEqual([]);
    await expect(host.apply(1)).rejects.toThrow(/read only/);
    await expect(host.reject(1)).rejects.toThrow(/read only/);
    await expect(host.revert(1)).rejects.toThrow(/read only/);
  });

  it("records each read as an observation, and submits nothing", async () => {
    const { host } = await open();
    await host.call("describeSite", []);
    await host.call("listPeople", [{}]);
    await host.call("listMemberships", [{ people: ["fake-person-001"] }]);
    const { observations, submitted } = await host.recorded();
    expect(observations.map((o) => o.title)).toEqual([
      "Read the booking system's site",
      "Read people in the booking system",
      "Read memberships in the booking system",
    ]);
    expect(observations[2]?.description).toContain("1 person(s)");
    expect(submitted).toEqual([]);
  });

  it("refuses an input before it is observed or reaches the site", async () => {
    const { host, site } = await open();
    const many = Array.from({ length: 201 }, (_, i) => `r${i}`);
    expect(await codeOf(host.call("listMemberships", [{ people: many }]))).toBe("invalid");
    expect((await host.recorded()).observations).toEqual([]);
    expect(await exports.FakeBookingSystemControl.callCount(site)).toEqual({
      used: 0,
      byMethod: {},
    });
  });

  it("serves exactly the contract's methods", async () => {
    const { host } = await open();
    for (const method of BOOKING_SYSTEM_SESSION_METHODS) {
      // Each is there: a call answers or is refused by its input check, never "not implemented".
      let outcome = "answered";
      try {
        await host.call(method, []);
      } catch (error) {
        outcome = (error as Error).message;
      }
      expect(outcome).not.toMatch(/does not implement|not a function/);
    }
  });
});
