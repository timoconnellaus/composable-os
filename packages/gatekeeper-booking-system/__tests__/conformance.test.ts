// Stage 65 acceptance criterion 1: the conformance suite passes against the fake, in memory and
// through the fake gatekeeper's own session as the host reaches it; checks that need the fake's
// controls are skipped against a target without them; and the suite fails a system that breaks
// the contract.

import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  CONFORMANCE_CHECKS,
  type ConformanceControl,
  type ConformanceTarget,
  prepareConformance,
  runCheck,
  runConformance,
} from "../src/conformance.js";
import { directSession } from "../src/direct.js";
import { FakeBookingSystem, fakeBookingSystemState } from "../src/fake.js";
import type { BookingSystemSession } from "../src/types.js";

const NOW = "2026-11-20T09:00:00.000Z";

let counter = 0;
function unique(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;
}

function controlOf(site: FakeBookingSystem): ConformanceControl {
  return {
    failNext: async (method, code) => site.failNext(method, code),
    setAccess: async (access) => site.setAccess(access),
    setBudget: async (budget) => site.setBudget(budget),
    spendBudget: async () => site.spendBudget(),
    change: async (kind, ref, patch) => site.change(kind, ref, patch),
    advance: async (seconds) => site.advance(seconds),
    shareAddress: async (from, to) => site.shareAddress(from, to),
    callCount: async () => site.callCount(),
  };
}

/** The in-memory fake, its controls as the suite needs them. */
function memoryTarget(
  site = new FakeBookingSystem(fakeBookingSystemState({ now: NOW })),
  withControl = true,
): ConformanceTarget {
  return {
    session: directSession(site),
    declaredActions: async () => [],
    ...(withControl ? { control: controlOf(site) } : {}),
  };
}

/** The fake gatekeeper as the host reaches it: each call through a facet's session. */
async function gatekeeperTarget(): Promise<ConformanceTarget> {
  const site = unique("site-");
  const c = exports.FakeBookingSystemControl;
  await c.reset(site, { now: NOW });
  const host = env.TEST_HOST.getByName(unique("host"));
  await host.open(site);
  const session = new Proxy(
    {},
    {
      get: (_target, method: string) => (input: unknown) =>
        host.call(method, input === undefined ? [] : [input]),
    },
  ) as BookingSystemSession;
  return {
    session,
    declaredActions: async () => (await host.autoApprovable()).map((k) => k.tag),
    control: {
      failNext: (method, code) => c.failNext(site, method, code),
      setAccess: (access) => c.setAccess(site, access),
      setBudget: (budget) => c.setBudget(site, budget),
      spendBudget: () => c.spendBudget(site),
      change: (kind, ref, patch) => c.change(site, kind, ref, patch),
      advance: (seconds) => c.advance(site, seconds),
      shareAddress: (from, to) => c.shareAddress(site, from, to),
      callCount: () => c.callCount(site),
    },
  };
}

describe("the conformance suite against the fake booking system in memory", () => {
  for (const check of CONFORMANCE_CHECKS) {
    it(check.name, async () => {
      const ctx = await prepareConformance(memoryTarget(), { now: NOW });
      expect(await runCheck(check, ctx)).toEqual({ name: check.name, status: "passed" });
    });
  }

  it("passes every check in one run, in order", async () => {
    const results = await runConformance(memoryTarget(), { now: NOW });
    expect(results.filter((r) => r.status !== "passed")).toEqual([]);
  });
});

describe("the conformance suite against the fake gatekeeper, through its session", () => {
  for (const check of CONFORMANCE_CHECKS) {
    it(check.name, async () => {
      const ctx = await prepareConformance(await gatekeeperTarget(), { now: NOW });
      expect(await runCheck(check, ctx)).toEqual({ name: check.name, status: "passed" });
    });
  }
});

describe("the suite itself", () => {
  it("skips the checks that need the fake's controls against a target without them", async () => {
    const site = new FakeBookingSystem(fakeBookingSystemState({ now: NOW }));
    const results = await runConformance(memoryTarget(site, false), { now: NOW });
    expect(results.filter((r) => r.status === "failed")).toEqual([]);
    expect(results.filter((r) => r.status === "skipped").map((r) => r.name)).toEqual(
      CONFORMANCE_CHECKS.filter((c) => c.needsControl).map((c) => c.name),
    );
  });

  it("checks a system without hints or modifiedSince", async () => {
    const site = new FakeBookingSystem(fakeBookingSystemState({ now: NOW, hints: "none" }));
    const describeSite = site.describeSite.bind(site);
    site.describeSite = async () => {
      const s = await describeSite();
      return { ...s, offers: { ...s.offers, modifiedSince: { people: false, classes: false } } };
    };
    // A system that does not offer it refuses it.
    const listPeople = site.listPeople.bind(site);
    site.listPeople = async (query) => {
      if (query.modifiedSince) throw new Error("[booking-system:invalid] not offered");
      return listPeople(query);
    };
    const listClasses = site.listClasses.bind(site);
    site.listClasses = async (query) => {
      if (query.modifiedSince) throw new Error("[booking-system:invalid] not offered");
      return listClasses(query);
    };
    const results = await runConformance(memoryTarget(site), { now: NOW });
    expect(results.filter((r) => r.status !== "passed")).toEqual([]);
  });

  it("fails a system that answers a field outside the contract", async () => {
    const site = new FakeBookingSystem(fakeBookingSystemState({ now: NOW }));
    const ctx = await prepareConformance(memoryTarget(site), { now: NOW });
    // Bypassing the shared reads, as a gatekeeper that did not use them would.
    const session = directSession(site);
    const leaky: BookingSystemSession = {
      ...session,
      listStaff: async () => (await site.listStaff()).map((s) => ({ ...s, phone: "0000" })),
    };
    const check = CONFORMANCE_CHECKS.find((c) => c.name.startsWith("lists staff"));
    const result = await runCheck(check as never, { ...ctx, session: leaky });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/keys/);
  });

  it("fails a system whose modifiedSince answers older people", async () => {
    const site = new FakeBookingSystem(fakeBookingSystemState({ now: NOW }));
    const listPeople = site.listPeople.bind(site);
    site.listPeople = async ({ modifiedSince: _ignored, ...query }) => listPeople(query);
    const ctx = await prepareConformance(memoryTarget(site), { now: NOW });
    const check = CONFORMANCE_CHECKS.find((c) => c.name.startsWith("reads people changed"));
    expect((await runCheck(check as never, ctx)).status).toBe("failed");
  });

  it("fails a system that repeats a person across pages", async () => {
    const site = new FakeBookingSystem(fakeBookingSystemState({ now: NOW }));
    const ctx = await prepareConformance(memoryTarget(site), { now: NOW });
    const listPeople = site.listPeople.bind(site);
    site.listPeople = async (query) => {
      const page = await listPeople(query);
      return query.cursor
        ? { ...page, items: [...ctx.people.slice(0, 1), ...page.items.slice(1)] }
        : page;
    };
    const check = CONFORMANCE_CHECKS.find((c) => c.name.startsWith("pages through people"));
    expect((await runCheck(check as never, ctx)).status).toBe("failed");
  });

  it("fails a gatekeeper that declares an action, or a session that offers a write", async () => {
    const target = memoryTarget();
    const ctx = await prepareConformance(target, { now: NOW });
    const check = CONFORMANCE_CHECKS.find((c) => c.name.startsWith("declares no outbound action"));
    const declaring = { ...target, declaredActions: async () => ["booking-system.book"] };
    expect((await runCheck(check as never, { ...ctx, target: declaring })).status).toBe("failed");
    const writing = { ...ctx.session, book: async () => ({}) } as BookingSystemSession;
    expect((await runCheck(check as never, { ...ctx, session: writing })).status).toBe("failed");
  });

  it("fails a gatekeeper whose call counter does not match the system's", async () => {
    const site = new FakeBookingSystem(fakeBookingSystemState({ now: NOW }));
    const describeSite = site.describeSite.bind(site);
    site.describeSite = async () => {
      const s = await describeSite();
      return { ...s, calls: { ...s.calls, used: 0, byMethod: {} } };
    };
    const ctx = await prepareConformance(memoryTarget(site), { now: NOW });
    const check = CONFORMANCE_CHECKS.find((c) => c.name.startsWith("counts its calls"));
    expect((await runCheck(check as never, ctx)).status).toBe("failed");
  });
});
