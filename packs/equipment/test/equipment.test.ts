// Stage 59 step 3: the Equipment pack against @composable-os/sdk/testing's in-memory host. Its
// manifest passes the contract checks with the uniqueness, states and permissions the host
// enforces; nothing is opened to customers or the public; every tool composes the host's record
// operations and moves a record only from a current read. apps/runner/test/equipment.test.ts runs
// the same pack in the real host: the tag refused twice, the moves refused to everyone but their
// tools, a coach's grant, and what the assistant may and may not do.
import { createTestHost } from "@composable-os/sdk/testing";
import { describe, expect, it } from "vitest";
import extension from "../index.ts";

const ITEM = "equipment.item";
const FAULT = "equipment.fault";
const COACH = { kind: "staff" as const, userId: "usr_coach", name: "Coach Kim" };

type Rows = Record<string, ({ id: string } & Record<string, unknown>)[]>;

function hostWith(
  records: Rows = {},
  sql: (input: Record<string, unknown>) => unknown = () => ({ rows: [] }),
) {
  const calls: Record<string, unknown>[] = [];
  const host = createTestHost(extension, {
    records,
    operations: {
      "query.sql": (input) => {
        calls.push(input);
        return sql(input);
      },
    },
  });
  return { host, calls };
}

/** A record as the in-memory host holds it. */
const rowOf = (
  host: ReturnType<typeof hostWith>["host"],
  object: string,
  id: string,
): Record<string, unknown> => host.records.get(object)?.get(id) ?? {};

const treadmill = (extra: Record<string, unknown> = {}) => ({
  id: "itm_1",
  name: "Treadmill 3",
  tag: "TM-03",
  category: "cardio",
  place: "Cardio floor",
  state: "in_service",
  warrantyUntil: "2999-01-01",
  cost: 4200,
  ...extra,
});

describe("the Equipment pack (test host)", () => {
  it("passes the contract checks, with the tag unique and the states declared for the host", () => {
    const { host } = hostWith();
    expect(host.issues).toEqual([]);
    const { item, fault } = host.manifest.objects;
    // Folded (case and outer spaces never count), among items in or out of service.
    expect(item?.unique).toEqual([
      { fields: ["tag"], states: ["in_service", "out_of_service"], fold: true },
    ]);
    // One open fault per report key: a retry makes no second.
    expect(fault?.unique).toEqual([
      { fields: ["reportKey"], states: ["reported", "acknowledged"] },
    ]);
    // Nobody reports a fault on a retired item.
    expect(fault?.states?.create).toEqual({ closed: "item.retiredFlag", requires: ["item"] });
    // An open fault holds its item out of the Trash; the item it is about is the report's.
    expect(fault?.states?.holds).toBe("item");
    expect(fault?.fields.item?.readOnly).toBe(true);
    // The sticker stays with an item out of service.
    expect(item?.fields.tag?.lockedIn).toEqual(["in_service", "out_of_service", "retired"]);
    // Out of service only through takeOut and reportFault, with why; back only through putBack;
    // retired only through retire, with why. No staff record write makes any of them.
    expect(item?.states?.moves).toEqual([
      {
        from: "in_service",
        to: "out_of_service",
        by: ["host"],
        tools: ["takeOut", "reportFault"],
        requires: ["outReason"],
      },
      { from: "out_of_service", to: "in_service", by: ["host"], tools: ["putBack"] },
      {
        from: ["in_service", "out_of_service"],
        to: "retired",
        by: ["host"],
        tools: ["retire"],
        requires: ["notes"],
        final: true,
      },
    ]);
    for (const move of fault?.states?.moves ?? []) {
      expect(move.by).toEqual(["host"]);
      expect(move.tools).toEqual(["triage"]);
      if (move.to !== "acknowledged") expect(move.requires).toEqual(["closedWhy"]);
    }
    // Written by the pack's tools only: why it is out, and the report's words and severity.
    for (const field of ["outSince", "outReason"]) {
      expect(item?.fields[field]?.readOnly, field).toBe(true);
    }
    for (const field of ["description", "severity", "reportKey", "reportedByName"]) {
      expect(fault?.fields[field]?.readOnly, field).toBe(true);
    }
    expect(item?.fields.listForMembers?.default).toBe("not_listed");
    expect(fault?.fields.reportedBy?.readOnly).toBe(true);
  });

  it("reports as every staff member's, manages as a restricted grant, and opens nothing outside", () => {
    const { host } = hostWith();
    const m = host.manifest;
    expect(m.grantable).toEqual(["equipment:report", "equipment:manage"]);
    expect(m.restricted).toEqual(["equipment:manage"]);
    const tools = m.tools;
    const report = ["register", "item", "reportFault", "reportFaultOnly", "takeOut"];
    const manage = [
      "putBack",
      "retire",
      "triage",
      "correctFault",
      "correctOutReason",
      "correctTag",
    ];
    for (const name of report) expect(tools[name]?.permission, name).toBe("equipment:report");
    for (const name of manage) expect(tools[name]?.permission, name).toBe("equipment:manage");
    // An AI asks and a person decides; putting back is a person's own act only.
    for (const name of [
      "reportFault",
      "takeOut",
      "retire",
      "triage",
      "correctFault",
      "correctOutReason",
      "correctTag",
    ]) {
      expect(tools[name]?.personApproves, name).toBe(true);
    }
    // A report alone changes nothing for members: the assistant may make it as a write.
    expect(tools.reportFaultOnly?.personApproves).toBeFalsy();
    expect(tools.reportFaultOnly?.humanOnly).toBeFalsy();
    expect(tools.reportFaultOnly?.risk).toBe("write");
    expect(tools.putBack?.humanOnly).toBe(true);
    expect(tools.putBack?.personApproves).toBeFalsy();
    expect(tools.register?.risk).toBe("read");
    expect(tools.item?.risk).toBe("read");
    expect(tools.retire?.risk).toBe("destructive");
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.audiences ?? ["staff"], name).toEqual(["staff"]);
    }
    for (const object of Object.values(m.objects)) {
      expect(object.customer).toBeUndefined();
      expect(object.public).toBeUndefined();
      expect(object.signedIn).toBeUndefined();
    }
  });
});

describe("register", () => {
  it("reads the register in one statement, leaving retired items out by default", async () => {
    const { host, calls } = hostWith({}, () => ({
      rows: [
        {
          id: "itm_1",
          name: "Treadmill 3",
          tag: "TM-03",
          state: "out_of_service",
          out_since: "2026-11-26T01:00:00.000Z",
          out_reason: "Belt slips",
          supplier: "Gym Supply Co",
          open_faults: 2,
          safety_risks: 1,
        },
      ],
    }));
    const out = await host.runTool<{
      items: { id: string; openFaults: number; safetyRisks: number; supplier: string }[];
      truncated: boolean;
    }>("register", {}, { caller: COACH });
    expect(out.truncated).toBe(false);
    expect(out.items[0]).toMatchObject({
      id: "itm_1",
      state: "out_of_service",
      outReason: "Belt slips",
      supplier: "Gym Supply Co",
      openFaults: 2,
      safetyRisks: 1,
    });
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.sql)).toContain("i.state <> 'retired'");
    expect(calls[0]?.params).toEqual([]);
    expect(calls[0]?.maxRows).toBe(200);
  });

  it("binds every filter as a parameter", async () => {
    const { host, calls } = hostWith();
    await host.runTool("register", {
      state: "retired",
      category: "cardio",
      place: "floor",
      q: "TM-03",
    });
    expect(String(calls[0]?.sql)).toContain("i.state = ?");
    expect(String(calls[0]?.sql)).not.toContain("TM-03");
    expect(calls[0]?.params).toEqual(["retired", "cardio", "floor", "TM-03", "TM-03", "TM-03"]);
  });

  it("says when the register is longer than one answer", async () => {
    const { host } = hostWith({}, () => ({
      rows: Array.from({ length: 200 }, (_, i) => ({ id: `itm_${i}`, name: `Item ${i}` })),
      truncated: true,
    }));
    const out = await host.runTool<{ items: unknown[]; truncated: boolean }>("register", {});
    expect(out.items).toHaveLength(200);
    expect(out.truncated).toBe(true);
  });
});

describe("item", () => {
  it("shows the item, its supplier, purchase cost and faults with whether each was under warranty", async () => {
    const { host } = hostWith(
      {
        [ITEM]: [treadmill({ supplier: "org_1", warrantyUntil: "2026-06-30" })],
        [FAULT]: [
          { id: "flt_1", item: "itm_1", description: "Belt slips", severity: "not_working" },
        ],
      },
      () => ({ rows: [{ name: "Gym Supply Co" }] }),
    );
    const out = await host.runTool<{
      supplier: string;
      costs: { purchase: number };
      faults: { id: string; state: string; underWarranty: boolean }[];
    }>("item", { itemId: "itm_1" }, { caller: COACH });
    expect(out).toMatchObject({
      name: "Treadmill 3",
      tag: "TM-03",
      supplier: "Gym Supply Co",
      costs: { purchase: 4200 },
    });
    expect(out.faults.map((f) => f.id)).toEqual(["flt_1"]);
    // The test host keeps no created time: a fault without one is not said to be under warranty.
    expect(out.faults[0]?.underWarranty).toBe(false);
  });
});

describe("reportFault", () => {
  it("records the report as the caller's, and leaves the item in service without takeOut", async () => {
    const { host } = hostWith({ [ITEM]: [treadmill()] });
    const out = await host.runTool<{ faultId: string; takenOut: boolean; underWarranty: boolean }>(
      "reportFault",
      { itemId: "itm_1", description: "The belt slips at speed", severity: "not_working" },
      { caller: COACH },
    );
    expect(out).toMatchObject({ takenOut: false, itemState: "in_service", underWarranty: true });
    const fault = { values: rowOf(host, FAULT, out.faultId) };
    expect(fault.values).toMatchObject({
      item: "itm_1",
      severity: "not_working",
      state: "reported",
      reportedBy: "usr_coach",
      reportedByName: "Coach Kim",
    });
  });

  it("with takeOut, takes the item out of service from in service, with why and since when", async () => {
    const { host } = hostWith({ [ITEM]: [treadmill()] });
    const out = await host.runTool<{ takenOut: boolean; message: string }>(
      "reportFault",
      {
        itemId: "itm_1",
        description: "A cable is fraying",
        severity: "safety_risk",
        takeOut: { reason: "Fraying cable: do not use" },
      },
      { caller: COACH },
    );
    expect(out).toMatchObject({ takenOut: true, itemState: "out_of_service" });
    expect(out.message).toContain("out of service");
    const update = host.calls.find((c) => c.operation === "record.update");
    expect(update?.input).toMatchObject({
      object: ITEM,
      id: "itm_1",
      from: "in_service",
      values: { state: "out_of_service", outReason: "Fraying cable: do not use" },
    });
    const after = { values: rowOf(host, ITEM, "itm_1") };
    expect(typeof after.values.outSince).toBe("string");
  });

  it("keeps the report when the item was already out of service, and says so", async () => {
    const { host } = hostWith({ [ITEM]: [treadmill({ state: "out_of_service" })] });
    const out = await host.runTool<{ faultId: string; takenOut: boolean; message: string }>(
      "reportFault",
      {
        itemId: "itm_1",
        description: "Still broken",
        severity: "safety_risk",
        takeOut: { reason: "Unsafe: do not use" },
      },
    );
    expect(out.takenOut).toBe(false);
    expect(out.faultId).toMatch(/^rec_/);
    expect(out.message).toContain("is out of service");
  });

  it("makes no second fault when the same report comes again, or a retry with its requestId", async () => {
    const { host } = hostWith({ [ITEM]: [treadmill()] });
    const report = { itemId: "itm_1", description: "Belt slips", severity: "not_working" };
    const first = await host.runTool<{ faultId: string; alreadyReported: boolean }>(
      "reportFaultOnly",
      report,
      { caller: COACH },
    );
    const again = await host.runTool<{
      faultId: string;
      alreadyReported: boolean;
      message: string;
    }>("reportFault", { ...report, description: "belt slips" }, { caller: COACH });
    expect(first.alreadyReported).toBe(false);
    expect(again).toMatchObject({ faultId: first.faultId, alreadyReported: true });
    expect(again.message).toMatch(/^Already reported/);
    // By request id: the same call retried finds it; the same id with other words is refused.
    const a = await host.runTool<{ faultId: string }>(
      "reportFaultOnly",
      { ...report, description: "Squeaks", requestId: "req-1" },
      { caller: COACH },
    );
    const b = await host.runTool<{ faultId: string; alreadyReported: boolean }>(
      "reportFaultOnly",
      { ...report, description: "Squeaks", requestId: "req-1" },
      { caller: COACH },
    );
    expect(b).toMatchObject({ faultId: a.faultId, alreadyReported: true });
    await expect(
      host.runTool(
        "reportFaultOnly",
        { ...report, description: "Squeaks loudly", requestId: "req-1" },
        { caller: COACH },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    // Another person's same words are their own report.
    const other = await host.runTool<{ faultId: string; alreadyReported: boolean }>(
      "reportFaultOnly",
      report,
    );
    expect(other.alreadyReported).toBe(false);
    expect([...(host.records.get(FAULT)?.values() ?? [])]).toHaveLength(3);
  });

  it("says truthfully when the fault was recorded but the take-out failed", async () => {
    const host = createTestHost(extension, {
      records: { [ITEM]: [treadmill()] },
      operations: {
        "record.update": () => {
          throw Object.assign(new Error("The host is busy"), { code: "internal" });
        },
      },
    });
    const out = await host.runTool<{
      faultId: string;
      takenOut: boolean;
      takeOutFailed: string | null;
      message: string;
    }>("reportFault", {
      itemId: "itm_1",
      description: "Sparks from the motor",
      severity: "safety_risk",
      takeOut: { reason: "Sparks: do not use" },
    });
    expect(out.takenOut).toBe(false);
    expect(out.takeOutFailed).toContain("could not be taken out of service");
    expect(out.message).toContain("The fault is recorded, but");
    expect(host.records.get(FAULT)?.get(out.faultId)).toBeTruthy();
  });
});

describe("reportFaultOnly", () => {
  it("records the fault and changes nothing else", async () => {
    const { host } = hostWith({ [ITEM]: [treadmill()] });
    const out = await host.runTool<{ faultId: string; takenOut: boolean; takeOutFailed: null }>(
      "reportFaultOnly",
      { itemId: "itm_1", description: "Display flickers", severity: "worn" },
      { caller: COACH },
    );
    expect(out).toMatchObject({ takenOut: false, takeOutFailed: null, itemState: "in_service" });
    expect(host.calls.some((c) => c.operation === "record.update")).toBe(false);
    expect(rowOf(host, FAULT, out.faultId)).toMatchObject({ severity: "worn", state: "reported" });
  });
});

describe("takeOut", () => {
  it("moves the item out from in service", async () => {
    const { host } = hostWith({ [ITEM]: [treadmill()] });
    const out = await host.runTool<{ state: string; outSince: string }>(
      "takeOut",
      { itemId: "itm_1", reason: "Being serviced or repaired" },
      { caller: COACH },
    );
    expect(out.state).toBe("out_of_service");
    expect(out.outSince).not.toBe("");
  });

  it("is refused with the item's state when it is not in service", async () => {
    const { host } = hostWith({ [ITEM]: [treadmill({ state: "retired" })] });
    await expect(
      host.runTool("takeOut", { itemId: "itm_1", reason: "Broken: do not use" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("putBack", () => {
  it("puts an item out of service back, clearing why and since when", async () => {
    const { host } = hostWith({
      [ITEM]: [
        treadmill({ state: "out_of_service", outReason: "Belt", outSince: "2026-11-26T00:00Z" }),
      ],
    });
    expect(await host.runTool("putBack", { itemId: "itm_1" })).toEqual({
      itemId: "itm_1",
      state: "in_service",
    });
    const after = { values: rowOf(host, ITEM, "itm_1") };
    expect(after.values).toMatchObject({ state: "in_service", outReason: null, outSince: null });
  });

  it("is refused when the item is not out of service", async () => {
    const { host } = hostWith({ [ITEM]: [treadmill()] });
    await expect(host.runTool("putBack", { itemId: "itm_1" })).rejects.toMatchObject({
      code: "conflict",
    });
  });
});

describe("retire", () => {
  it("retires from the state just read, unlists it and keeps why in its notes", async () => {
    const { host } = hostWith({
      [ITEM]: [treadmill({ state: "out_of_service", listForMembers: "listed", notes: "Old" })],
    });
    expect(await host.runTool("retire", { itemId: "itm_1", reason: "Worn out" })).toEqual({
      itemId: "itm_1",
      state: "retired",
    });
    const update = host.calls.find((c) => c.operation === "record.update");
    expect(update?.input).toMatchObject({ from: "out_of_service" });
    const after = { values: rowOf(host, ITEM, "itm_1") };
    expect(after.values.listForMembers).toBe("not_listed");
    expect(after.values).toMatchObject({ outReason: null, outSince: null });
    expect(String(after.values.notes)).toMatch(/^Old\n\nRetired \d{4}-\d{2}-\d{2}: Worn out$/);
  });

  it("says so when the item is already retired", async () => {
    const { host } = hostWith({ [ITEM]: [treadmill({ state: "retired" })] });
    await expect(
      host.runTool("retire", { itemId: "itm_1", reason: "Worn out" }),
    ).rejects.toMatchObject({ code: "conflict", message: "The item is already retired" });
    expect(host.calls.some((c) => c.operation === "record.update")).toBe(false);
  });
});

describe("correctFault and correctOutReason", () => {
  it("a manager corrects a fault's severity and words", async () => {
    const { host } = hostWith({
      [FAULT]: [
        {
          id: "flt_1",
          item: "itm_1",
          description: "Belt",
          severity: "safety_risk",
          state: "reported",
        },
        { id: "flt_2", item: "itm_1", description: "Old", severity: "worn", state: "fixed" },
      ],
    });
    expect(
      await host.runTool("correctFault", {
        faultId: "flt_1",
        severity: "worn",
        description: "Belt worn at the edge, safe to use",
      }),
    ).toEqual({
      faultId: "flt_1",
      severity: "worn",
      description: "Belt worn at the edge, safe to use",
    });
    await expect(host.runTool("correctFault", { faultId: "flt_1" })).rejects.toBeTruthy();
    // A closed fault is kept as it was closed.
    await expect(
      host.runTool("correctFault", { faultId: "flt_2", severity: "safety_risk" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(rowOf(host, FAULT, "flt_2").severity).toBe("worn");
  });

  it("a manager corrects why an item is out, only while it is out", async () => {
    const { host } = hostWith({
      [ITEM]: [treadmill({ state: "out_of_service", outReason: "Broken" })],
    });
    expect(
      await host.runTool("correctOutReason", { itemId: "itm_1", reason: "Motor burnt out" }),
    ).toEqual({ itemId: "itm_1", outReason: "Motor burnt out" });
    const { host: inService } = hostWith({ [ITEM]: [treadmill()] });
    await expect(
      inService.runTool("correctOutReason", { itemId: "itm_1", reason: "Motor burnt out" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("triage", () => {
  it("acknowledges and closes a fault from its current state, with why", async () => {
    const { host } = hostWith({
      [FAULT]: [{ id: "flt_1", item: "itm_1", description: "Belt", state: "reported" }],
    });
    expect(await host.runTool("triage", { faultId: "flt_1", action: "acknowledge" })).toEqual({
      faultId: "flt_1",
      state: "acknowledged",
    });
    expect(
      await host.runTool("triage", {
        faultId: "flt_1",
        action: "fixed",
        why: "New belt fitted by the supplier",
      }),
    ).toEqual({ faultId: "flt_1", state: "fixed" });
    const updates = host.calls.filter((c) => c.operation === "record.update");
    expect(updates.map((c) => (c.input as { from: string }).from)).toEqual([
      "reported",
      "acknowledged",
    ]);
    expect(updates[1]?.input).toMatchObject({
      values: { state: "fixed", closedWhy: "New belt fitted by the supplier" },
    });
  });
});

describe("correctTag", () => {
  it("a manager changes the tag while the item is in service, never while it is out", async () => {
    const { host } = hostWith({ [ITEM]: [treadmill()] });
    expect(await host.runTool("correctTag", { itemId: "itm_1", tag: "TM-03B" })).toEqual({
      itemId: "itm_1",
      tag: "TM-03B",
    });
    const update = host.calls.find((c) => c.operation === "record.update");
    expect(update?.input).toMatchObject({ while: "in_service", values: { tag: "TM-03B" } });
    const { host: out } = hostWith({ [ITEM]: [treadmill({ state: "out_of_service" })] });
    await expect(out.runTool("correctTag", { itemId: "itm_1", tag: "X-1" })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(rowOf(out, ITEM, "itm_1").tag).toBe("TM-03");
  });
});
