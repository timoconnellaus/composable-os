// Stage 59 step 3 (ADR 0862): the Equipment pack (packs/equipment) in the real host, its tools run
// in the sandbox, installed the way a product that lists the pack installs it, with real D1.
// Bookings (with Programs, which it requires) is installed beside it for a pack-role account: a
// coach granted equipment:report.
//
// What it shows: a manager adds an item with a tag, supplier, cost and warranty, and a second item
// with the same tag is refused by the host, by a record write and by the admin's import (a second
// import run creates nothing twice); an item goes out of service only through takeOut and
// reportFault, back only through putBack (a manager's, a person's own), and is retired only
// through retire; a coach granted equipment:report reports a safety-risk fault and takes the
// machine out in one call and can do nothing else in the pack; a fault is triaged only by a
// manager through triage, each close with why; the assistant reads the register, its reports,
// take-outs, retirements and triage wait for a person, and it can never put an item back; and the
// register is one statement whatever its size.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type ExtensionHost,
  type InvocationContext,
  invokeByName,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, createMember, db, host, queriesOf, unique } from "./helpers.ts";

const packFiles = (sources: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(sources)
      .map(([path, text]) => [path.split("/").pop() as string, text] as const)
      .filter(([name]) => name !== "vitest.config.ts"),
  );
const files: Record<string, Record<string, string>> = {
  equipment: packFiles(
    import.meta.glob<string>("../../../packs/equipment/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
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
};
const OURS = new Set(Object.keys(files));

/** The extension host of a deployment whose product lists Equipment and Bookings. */
const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [
    ...(await host.shipped()).filter((s) => !OURS.has(s.id)),
    { id: "equipment", version: "0.1.0" },
    { id: "programs", version: "0.1.0" },
    { id: "bookings", version: "0.1.0" },
  ],
  commitShipped: (id) =>
    files[id]
      ? host.commit({
          id,
          files: files[id] as Record<string, string>,
          message: `Shipped ${id}`,
          author: { name: "Composable OS", email: "release@composableos.dev" },
        })
      : host.commitShipped(id),
};

const ITEM = "equipment.item";
const FAULT = "equipment.fault";

let admin: ActingUser;
let member: ActingUser;
let manager: ActingUser;
let coach: ActingUser;
let plainCoach: ActingUser;
let supplier: string;

const staff = (user: ActingUser, extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user,
  origin: { surface: "ui" },
  db,
  extensionHost: shippedHost,
  ...extra,
});
const assistant = (user: ActingUser) =>
  staff(user, { actor: "assistant", origin: { surface: "assistant", sessionId: unique("s") } });
const mcp = (user: ActingUser) => staff(user, { actor: "mcp", origin: { surface: "mcp" } });

function run<T = Record<string, unknown>>(
  name: string,
  input: unknown,
  ctx: InvocationContext,
): Promise<T> {
  return invokeByName(name, input, ctx) as Promise<T>;
}

/** What a call was refused with: its code and the host's details (unwrapped from a tool's). */
async function refusal(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    const e = error as { code?: string; message?: string; details?: Record<string, unknown> };
    const inner = (e.details?.details ?? e.details) as Record<string, unknown> | undefined;
    return { code: e.code, message: e.message, inner: e.details?.code, details: inner };
  }
  throw new Error("expected a refusal");
}

async function staffAccount(name: string) {
  const id = `usr_${unique("e")}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, role) VALUES (?, ?, ?, 1, ?, ?, 'member')",
  )
    .bind(id, name, `${unique("e")}@example.com`, now, now)
    .run();
  return { id, email: "", name, role: "member" } as ActingUser;
}

type Rec = { id: string; values: Record<string, unknown> };

const get = (object: string, id: string) => run<Rec>("record.get", { object, id }, staff(admin));

/** An item, added by the admin (in service). */
async function newItem(name: string, extra: Record<string, unknown> = {}) {
  return (
    await run<Rec>(
      "record.create",
      { object: ITEM, values: { name, category: "cardio", place: "Cardio floor", ...extra } },
      staff(admin),
    )
  ).id;
}

beforeAll(async () => {
  admin = await createAdmin();
  for (const id of ["programs", "bookings", "equipment"]) {
    await run("extension.install", { id, shipped: true }, staff(admin));
  }
  await refreshSchemaRegistry(db.query);
  member = await createMember();
  manager = await staffAccount("Mo Manager");
  await run(
    "user.setPermissions",
    { id: manager.id, permissions: ["equipment:manage"] },
    staff(admin),
  );
  coach = await staffAccount("Coach Kim");
  await run("user.setPackRole", { id: coach.id, role: "bookings.coach" }, staff(admin));
  await run(
    "user.setPermissions",
    { id: coach.id, permissions: ["equipment:report"] },
    staff(admin),
  );
  plainCoach = await staffAccount("Coach Lee");
  await run("user.setPackRole", { id: plainCoach.id, role: "bookings.coach" }, staff(admin));
  supplier = (
    await run<{ id: string }>("organisation.create", { name: unique("Gym Supply ") }, staff(admin))
  ).id;
}, 180_000);

afterAll(() => setPreset("balanced"));

describe("the pack in a product", () => {
  it("is installed as shipped, with the tag unique and the moves the tools' alone", async () => {
    const row = await env.DB.prepare("SELECT source, status FROM core_extensions WHERE id = ?")
      .bind("equipment")
      .first();
    expect(row).toEqual({ source: "shipped", status: "active" });
  });
});

describe("the register's tag (AC 1, 15)", () => {
  it("a manager adds a treadmill with a tag, supplier, cost and warranty; the same tag again is refused", async () => {
    const tag = unique("TM-");
    const made = await run<Rec>(
      "record.create",
      {
        object: ITEM,
        values: {
          name: "Treadmill 1",
          category: "cardio",
          tag,
          supplier,
          cost: 4200.5,
          warrantyUntil: "2027-06-30",
        },
      },
      staff(manager),
    );
    expect(made.values).toMatchObject({ tag, supplier, cost: 4200.5, state: "in_service" });
    const twice = await refusal(
      run("record.create", { object: ITEM, values: { name: "Treadmill 2", tag } }, staff(manager)),
    );
    expect(twice.code).toBe("conflict");
    expect(JSON.stringify(twice.details)).toContain("unique");
    // Nor by changing another item's tag to it.
    const other = await newItem("Treadmill 2", { tag: unique("TM-") });
    expect(
      (
        await refusal(
          run("record.update", { object: ITEM, id: other, values: { tag } }, staff(admin)),
        )
      ).code,
    ).toBe("conflict");
    // Items without a tag are not compared.
    await newItem("Mat 1");
    await newItem("Mat 2");
  });

  it("a register loads through the admin's import; a second run creates nothing twice", async () => {
    const a = unique("RK-");
    const b = unique("RK-");
    const csv = `Name,Category,Place,Tag\nSquat rack 1,strength,Weights room,${a}\nSquat rack 2,strength,Weights room,${b}\n`;
    const first = await run<{ created: string[]; skipped: unknown[] }>(
      "import.records.commit",
      { object: ITEM, csv, skipInvalid: true },
      staff(admin),
    );
    expect(first.created).toHaveLength(2);
    expect(first.skipped).toEqual([]);
    const again = await run<{ created: string[]; skipped: { row: number }[] }>(
      "import.records.commit",
      { object: ITEM, csv, skipInvalid: true },
      staff(admin),
    );
    expect(again.created).toEqual([]);
    expect(again.skipped.map((s) => s.row)).toEqual([1, 2]);
    const { results } = await env.DB.prepare(
      "SELECT count(*) AS n FROM rec_x_equipment_item WHERE tag IN (?, ?)",
    )
      .bind(a, b)
      .all<{ n: number }>();
    expect(results[0]?.n).toBe(2);
  });
});

describe("out of service and back (AC 6, 7)", () => {
  it("no record write moves an item, whoever makes it: only the tools do", async () => {
    const id = await newItem("Bike 1");
    for (const values of [
      { state: "out_of_service", outReason: "Broken" },
      { state: "retired", notes: "Gone" },
    ]) {
      expect(
        (await refusal(run("record.update", { object: ITEM, id, values }, staff(admin)))).code,
      ).toBe("invalid_input");
    }
    // Created in service, never in another state.
    expect(
      (
        await refusal(
          run(
            "record.create",
            { object: ITEM, values: { name: "Bike 2", state: "out_of_service", outReason: "x" } },
            staff(admin),
          ),
        )
      ).code,
    ).toBe("invalid_input");
    expect((await get(ITEM, id)).values.state).toBe("in_service");
  });

  it("any staff member takes an item out with why; it is out since then; twice is refused", async () => {
    const id = await newItem("Bike 3");
    const out = await run<{ state: string; outSince: string }>(
      "x.equipment.takeOut",
      { itemId: id, reason: "Broken: do not use" },
      staff(member),
    );
    expect(out.state).toBe("out_of_service");
    const after = await get(ITEM, id);
    expect(after.values).toMatchObject({
      state: "out_of_service",
      outReason: "Broken: do not use",
    });
    expect(Date.parse(String(after.values.outSince))).toBeGreaterThan(Date.now() - 60_000);
    const twice = await refusal(
      run("x.equipment.takeOut", { itemId: id, reason: "Again" }, staff(member)),
    );
    expect(twice.inner ?? twice.code).toBe("conflict");
    // Nobody writes the time it went out but the tools.
    expect(
      (
        await refusal(
          run(
            "record.update",
            { object: ITEM, id, values: { outSince: new Date(0).toISOString() } },
            staff(admin),
          ),
        )
      ).code,
    ).toBe("invalid_input");
    // While it is out, why cannot be emptied (the move requires it).
    expect(
      (
        await refusal(
          run("record.update", { object: ITEM, id, values: { outReason: null } }, staff(admin)),
        )
      ).code,
    ).toBe("invalid_input");
    expect((await get(ITEM, id)).values.outReason).toBe("Broken: do not use");
  });

  it("putting it back is refused to anyone without equipment:manage and by any record write; a manager does", async () => {
    const id = await newItem("Bike 4");
    await run("x.equipment.takeOut", { itemId: id, reason: "Unsafe" }, staff(member));
    for (const who of [member, coach]) {
      expect((await refusal(run("x.equipment.putBack", { itemId: id }, staff(who)))).code).toBe(
        "forbidden",
      );
    }
    expect(
      (
        await refusal(
          run(
            "record.update",
            { object: ITEM, id, values: { state: "in_service" } },
            staff(manager),
          ),
        )
      ).code,
    ).toBe("invalid_input");
    expect((await get(ITEM, id)).values.state).toBe("out_of_service");
    expect(await run("x.equipment.putBack", { itemId: id }, staff(manager))).toEqual({
      itemId: id,
      state: "in_service",
    });
    expect((await get(ITEM, id)).values).toMatchObject({
      state: "in_service",
      outReason: null,
      outSince: null,
    });
  });

  it("retiring is a manager's, needs why, unlists the item and is final", async () => {
    const id = await newItem("Rower 1", { listForMembers: "listed" });
    expect(
      (await refusal(run("x.equipment.retire", { itemId: id, reason: "Worn out" }, staff(member))))
        .code,
    ).toBe("forbidden");
    await run("x.equipment.retire", { itemId: id, reason: "Worn out" }, staff(manager));
    const after = await get(ITEM, id);
    expect(after.values).toMatchObject({ state: "retired", listForMembers: "not_listed" });
    expect(String(after.values.notes)).toContain("Worn out");
    // Why it was retired stays: the move requires it.
    expect(
      (
        await refusal(
          run("record.update", { object: ITEM, id, values: { notes: null } }, staff(admin)),
        )
      ).code,
    ).toBe("invalid_input");
    // Final: nothing moves it again, not the tools, not a record write.
    const again = await refusal(
      run("x.equipment.takeOut", { itemId: id, reason: "Broken" }, staff(member)),
    );
    expect(again.inner ?? again.code).toBe("conflict");
    expect(
      (
        await refusal(
          run("record.update", { object: ITEM, id, values: { state: "in_service" } }, staff(admin)),
        )
      ).code,
    ).toBe("invalid_input");
    // Retired items leave the register's usual list.
    const register = await run<{ items: { id: string }[] }>(
      "x.equipment.register",
      {},
      staff(member),
    );
    expect(register.items.map((i) => i.id)).not.toContain(id);
  });
});

describe("a coach granted equipment:report (AC 6)", () => {
  it("reports a safety-risk fault and takes the machine out of service in one call", async () => {
    const id = await newItem("Cable machine 1", { tag: unique("CB-") });
    const out = await run<{ faultId: string; takenOut: boolean; itemState: string }>(
      "x.equipment.reportFault",
      {
        itemId: id,
        description: "The cable is fraying near the pulley",
        severity: "safety_risk",
        takeOut: { reason: "Fraying cable: do not use" },
      },
      staff(coach),
    );
    expect(out).toMatchObject({ takenOut: true, itemState: "out_of_service" });
    const fault = await get(FAULT, out.faultId);
    expect(fault.values).toMatchObject({
      item: id,
      severity: "safety_risk",
      state: "reported",
      reportedBy: coach.id,
      reportedByName: "Coach Kim",
    });
    expect((await get(ITEM, id)).values.outReason).toBe("Fraying cable: do not use");
    // The register and the item are theirs to read.
    const register = await run<{
      items: { id: string; openFaults: number; safetyRisks: number }[];
    }>("x.equipment.register", { q: "Cable machine" }, staff(coach));
    expect(register.items.find((i) => i.id === id)).toMatchObject({
      openFaults: 1,
      safetyRisks: 1,
    });
    const one = await run<{ faults: { id: string }[] }>(
      "x.equipment.item",
      { itemId: id },
      staff(coach),
    );
    expect(one.faults.map((f) => f.id)).toEqual([out.faultId]);
  });

  it("can do nothing else in the pack", async () => {
    const id = await newItem("Cable machine 2");
    await run("x.equipment.takeOut", { itemId: id, reason: "Broken" }, staff(coach));
    const fault = await run<{ faultId: string }>(
      "x.equipment.reportFault",
      { itemId: id, description: "Pin missing", severity: "not_working" },
      staff(coach),
    );
    for (const [name, input] of [
      ["x.equipment.putBack", { itemId: id }],
      ["x.equipment.retire", { itemId: id, reason: "Worn out" }],
      ["x.equipment.triage", { faultId: fault.faultId, action: "acknowledge" }],
    ] as const) {
      expect((await refusal(run(name, input, staff(coach)))).code, name).toBe("forbidden");
    }
    // No record reads or writes of the pack's objects but through its tools.
    for (const [name, input] of [
      ["record.get", { object: ITEM, id }],
      ["record.list", { object: FAULT }],
      ["record.create", { object: ITEM, values: { name: "Mine" } }],
      ["record.update", { object: ITEM, id, values: { name: "Renamed" } }],
      ["record.update", { object: FAULT, id: fault.faultId, values: { closedWhy: "x" } }],
    ] as const) {
      expect((await refusal(run(name, input, staff(coach)))).code, name).toBe("forbidden");
    }
  });

  it("a coach without the grant reaches none of the tools", async () => {
    const id = await newItem("Cable machine 3");
    for (const [name, input] of [
      ["x.equipment.register", {}],
      ["x.equipment.item", { itemId: id }],
      ["x.equipment.takeOut", { itemId: id, reason: "Broken" }],
      ["x.equipment.reportFault", { itemId: id, description: "Broken", severity: "worn" }],
    ] as const) {
      expect((await refusal(run(name, input, staff(plainCoach)))).code, name).toBe("forbidden");
    }
  });
});

describe("triage", () => {
  it("is a manager's, through the tool only; every close says why; a closed fault stays closed", async () => {
    const id = await newItem("Sauna");
    const { faultId } = await run<{ faultId: string }>(
      "x.equipment.reportFault",
      { itemId: id, description: "Heater does not warm", severity: "not_working" },
      staff(member),
    );
    expect(
      (await refusal(run("x.equipment.triage", { faultId, action: "acknowledge" }, staff(member))))
        .code,
    ).toBe("forbidden");
    expect(
      (
        await refusal(
          run(
            "record.update",
            { object: FAULT, id: faultId, values: { state: "fixed", closedWhy: "x" } },
            staff(admin),
          ),
        )
      ).code,
    ).toBe("invalid_input");
    expect(
      await run("x.equipment.triage", { faultId, action: "acknowledge" }, staff(manager)),
    ).toEqual({ faultId, state: "acknowledged" });
    const noWhy = await refusal(
      run("x.equipment.triage", { faultId, action: "fixed" }, staff(manager)),
    );
    expect(noWhy.inner ?? noWhy.code).toBe("invalid_input");
    expect((await get(FAULT, faultId)).values.state).toBe("acknowledged");
    await run(
      "x.equipment.triage",
      { faultId, action: "fixed", why: "Element replaced by the supplier" },
      staff(manager),
    );
    expect((await get(FAULT, faultId)).values).toMatchObject({
      state: "fixed",
      closedWhy: "Element replaced by the supplier",
    });
    const reopened = await refusal(
      run("x.equipment.triage", { faultId, action: "duplicate", why: "Oops" }, staff(manager)),
    );
    expect(reopened.inner ?? reopened.code).toBe("invalid_input");
    // Fixing the fault does not put anything back in service: that is putBack's.
    expect((await get(ITEM, id)).values.state).toBe("in_service");
  });
});

describe("what the assistant may do, under the balanced preset", () => {
  it("reads the register and an item", async () => {
    await setPreset("balanced");
    const id = await newItem("Treadmill AI 1");
    const register = await run<{ items: { id: string }[] }>(
      "x.equipment.register",
      { q: "Treadmill AI 1" },
      assistant(admin),
    );
    expect(register.items.map((i) => i.id)).toContain(id);
    expect(
      (await run<{ id: string }>("x.equipment.item", { itemId: id }, assistant(admin))).id,
    ).toBe(id);
  });

  it("asks to report, take out, retire and triage, and each waits for a person; nothing changes", async () => {
    await setPreset("balanced");
    const id = await newItem("Treadmill AI 2");
    const { faultId } = await run<{ faultId: string }>(
      "x.equipment.reportFault",
      { itemId: id, description: "Squeaks", severity: "worn" },
      staff(member),
    );
    for (const [name, input] of [
      [
        "x.equipment.reportFault",
        {
          itemId: id,
          description: "The member says it sparks",
          severity: "safety_risk",
          takeOut: { reason: "Sparks" },
        },
      ],
      ["x.equipment.takeOut", { itemId: id, reason: "Sparks" }],
      ["x.equipment.retire", { itemId: id, reason: "Worn out" }],
      ["x.equipment.triage", { faultId, action: "not_a_fault", why: "Normal noise" }],
    ] as const) {
      for (const ctx of [assistant(admin), mcp(admin)]) {
        expect((await refusal(run(name, input, ctx))).code, name).toBe("pending_approval");
      }
    }
    expect((await get(ITEM, id)).values.state).toBe("in_service");
    expect((await get(FAULT, faultId)).values.state).toBe("reported");
    const { results } = await env.DB.prepare(
      "SELECT count(*) AS n FROM rec_x_equipment_fault WHERE item = ?",
    )
      .bind(id)
      .all<{ n: number }>();
    expect(results[0]?.n).toBe(1);
  });

  it("a person approves the assistant's take-out: it is applied", async () => {
    const id = await newItem("Treadmill AI 3");
    const asked = await refusal(
      run("x.equipment.takeOut", { itemId: id, reason: "Belt torn" }, assistant(admin)),
    );
    expect(asked.code).toBe("pending_approval");
    const actionId = String((asked.details as { actionId?: string } | undefined)?.actionId);
    const approve = (confirm?: string) =>
      run<{ results: { status: string }[] }>(
        "approval.approve",
        { actionIds: [actionId], ...(confirm ? { confirm } : {}) },
        staff(admin),
      );
    const decided = await approve().catch(
      async (error: { details?: { confirmLabel?: string } }) => {
        const label = error.details?.confirmLabel;
        if (!label) throw error;
        return approve(label);
      },
    );
    expect(decided.results.map((r) => r.status)).toEqual(["applied"]);
    expect((await get(ITEM, id)).values).toMatchObject({
      state: "out_of_service",
      outReason: "Belt torn",
    });
  });

  it("never puts an item back in service, whatever the preset", async () => {
    const id = await newItem("Treadmill AI 4");
    await run("x.equipment.takeOut", { itemId: id, reason: "Broken" }, staff(admin));
    for (const preset of ["balanced", "autonomous"] as const) {
      await setPreset(preset);
      for (const ctx of [assistant(admin), mcp(admin)]) {
        const refused = await refusal(run("x.equipment.putBack", { itemId: id }, ctx));
        expect(refused.code).toBe("forbidden");
      }
    }
    await setPreset("balanced");
    expect((await get(ITEM, id)).values.state).toBe("out_of_service");
  });
});

describe("the register's cost (AC 17)", () => {
  it("is one statement's read however many items there are: the same at 500 as at 20", async () => {
    const category = "test_gear";
    const batch = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({
        name: `Tester ${from + i}`,
        category,
        tag: unique("TG-"),
      }));
    for (let i = 0; i < 20; i += 20) {
      await run("record.createMany", { object: ITEM, records: batch(20, i) }, staff(admin));
    }
    const small = await queriesOf(() => run("x.equipment.register", { category }, staff(member)));
    for (let i = 20; i < 500; i += 50) {
      await run("record.createMany", { object: ITEM, records: batch(50, i) }, staff(admin));
    }
    const large = await queriesOf(() =>
      run<{ items: unknown[]; truncated: boolean }>(
        "x.equipment.register",
        { category },
        staff(member),
      ),
    );
    expect(small.outcome).toBe("ok");
    expect(large.outcome).toBe("ok");
    expect(large.queries).toBe(small.queries);
    const page = await run<{ items: unknown[]; truncated: boolean }>(
      "x.equipment.register",
      { category },
      staff(member),
    );
    expect(page.items).toHaveLength(200);
    expect(page.truncated).toBe(true);
  }, 120_000);
});
