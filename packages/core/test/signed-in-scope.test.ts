// Stage 41, build step 1: what every signed-in customer may read (ADR 0447). A class's
// assignment and its sessions are read by any signed-in member, beside each client's own; an
// exercise bank is read by every signed-in customer and changed by none; the public reads none
// of it. A customer's write may point a relation only at what they can see, so a log can be
// written against one's own session or a class's, never another client's.
import { validateManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, type CustomerPrincipal, getObject, invoke } from "../src/index.ts";
import { call, outside, PUBLIC } from "./customer-fixtures.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, unique } from "./helpers.ts";

const EXT = extId("gym");
const GROUP = `${EXT}.group`;
const PLAN = `${EXT}.plan`;
const SLOT = `${EXT}.slot`;
const ENTRY = `${EXT}.entry`;

let admin: ActingUser;
let a: CustomerPrincipal;
let b: CustomerPrincipal;
const ids: Record<string, string> = {};

const items = (outcome: Awaited<ReturnType<typeof call>>) =>
  outcome.ok
    ? (outcome.value as { items: { id: string; values: Record<string, unknown> }[] }).items
    : [];

async function create(object: string, values: Record<string, unknown>) {
  return (await invoke("record.create", { object, values }, context(admin))).id;
}

async function customer(label: string): Promise<CustomerPrincipal> {
  const person = await invoke(
    "person.create",
    { givenName: label, familyName: unique("Member") },
    context(admin),
  );
  return { kind: "customer", customerId: `cus_${unique(label)}`, personId: person.id };
}

beforeAll(async () => {
  admin = await createUser("admin");
  const kind = {
    type: "select" as const,
    label: "Kind",
    options: [
      { value: "personal", label: "Personal" },
      { value: "class", label: "Class" },
    ],
  };
  await reconcile(
    manifest(EXT, {
      objects: {
        group: {
          label: "Group",
          plural: "Groups",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            margin: { type: "number", label: "Margin" },
          },
          signedIn: { read: ["name"] },
        },
        plan: {
          label: "Plan",
          plural: "Plans",
          titleField: "label",
          fields: {
            label: { type: "text", label: "Label", required: true },
            kind,
            person: { type: "relation", label: "Person", to: "person" },
            group: { type: "relation", label: "Group", to: `${EXT}.group` },
            privateGoal: { type: "text", label: "Goal" },
            staffNote: { type: "text", label: "Staff note" },
          },
          customer: { field: "person", read: ["label", "kind", "group", "privateGoal"], write: [] },
          signedIn: { read: ["label", "kind", "group"], when: { field: "kind", in: ["class"] } },
        },
        slot: {
          label: "Slot",
          plural: "Slots",
          titleField: "label",
          fields: {
            label: { type: "text", label: "Label", required: true },
            plan: { type: "relation", label: "Plan", to: `${EXT}.plan` },
            person: { type: "relation", label: "Person", to: "person" },
            note: { type: "text", label: "Note" },
          },
          customer: { field: "person", read: ["label", "plan", "note"], write: ["note"] },
          signedIn: {
            read: ["label", "plan"],
            when: { via: "plan", field: "kind", in: ["class"] },
          },
        },
        entry: {
          label: "Entry",
          plural: "Entries",
          titleField: "label",
          fields: {
            label: { type: "text", label: "Label" },
            slot: { type: "relation", label: "Slot", to: `${EXT}.slot` },
            person: { type: "relation", label: "Person", to: "person" },
            reps: { type: "number", label: "Reps" },
          },
          customer: {
            field: "person",
            read: ["label", "slot", "reps"],
            write: ["label", "slot", "reps"],
          },
        },
      },
    }),
  );
  a = await customer("A");
  b = await customer("B");
  ids.group = await create(GROUP, { name: "Mobility", margin: 42 });
  ids.classPlan = await create(PLAN, {
    label: "Class plan",
    kind: "class",
    group: ids.group,
    staffNote: "S-class",
  });
  ids.classSlot = await create(SLOT, { label: "Class slot", plan: ids.classPlan, note: "N-class" });
  for (const [who, p] of [
    ["a", a],
    ["b", b],
  ] as const) {
    ids[`${who}Plan`] = await create(PLAN, {
      label: `Plan of ${who}`,
      kind: "personal",
      person: p.personId,
      group: ids.group,
      privateGoal: `Goal-${who}`,
      staffNote: `S-${who}`,
    });
    ids[`${who}Slot`] = await create(SLOT, {
      label: `Slot of ${who}`,
      plan: ids[`${who}Plan`],
      person: p.personId,
      note: `Note-${who}`,
    });
  }
});

describe("the declaration (ADR 0447)", () => {
  it("is carried to the registry and checked", () => {
    expect(getObject(SLOT)?.signedIn).toEqual({
      read: ["label", "plan"],
      when: { via: "plan", field: "kind", in: ["class"] },
    });
    const { issues } = validateManifest(
      manifest(extId("bad"), {
        objects: {
          thing: {
            label: "Thing",
            plural: "Things",
            titleField: "name",
            fields: {
              name: { type: "text", label: "Name" },
              who: { type: "relation", label: "Who", to: "person" },
              secret: { type: "text", label: "Secret" },
            },
            customer: { field: "who", read: ["name"], write: [] },
            signedIn: { read: ["name", "secret"] },
          },
          both: {
            label: "Both",
            plural: "Both",
            titleField: "name",
            fields: { name: { type: "text", label: "Name" } },
            public: { read: ["name"] },
            signedIn: { read: ["name"] },
          },
        },
      }),
    );
    expect(issues.map((i) => i.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('signedIn.read lists "secret", which customer.read does not'),
        "An object declares public or signedIn, not both: the public's is read by customers too",
      ]),
    );
  });
});

describe("reads", () => {
  it("a customer reads their own and the shared, never another's, with no more than declared", async () => {
    const plans = items(await call("my.list", { object: PLAN }, outside(a)));
    expect(plans.map((p) => p.id).sort()).toEqual([ids.aPlan, ids.classPlan].sort());
    const own = plans.find((p) => p.id === ids.aPlan);
    expect(own?.values).toEqual({
      label: "Plan of a",
      kind: "personal",
      group: ids.group,
      privateGoal: "Goal-a",
    });
    // A shared record shows signedIn.read; a field only customer.read lists is empty on it.
    const shared = plans.find((p) => p.id === ids.classPlan);
    expect(shared?.values).toEqual({
      label: "Class plan",
      kind: "class",
      group: ids.group,
      privateGoal: null,
    });
    const text = JSON.stringify(plans);
    for (const secret of ["S-class", "S-a", "Goal-b", ids.bPlan])
      expect(text).not.toContain(secret);

    const slots = items(await call("my.list", { object: SLOT }, outside(a)));
    expect(slots.map((s) => s.id).sort()).toEqual([ids.aSlot, ids.classSlot].sort());
    expect(slots.find((s) => s.id === ids.classSlot)?.values).toEqual({
      label: "Class slot",
      plan: ids.classPlan,
      note: null,
    });
    expect(await call("my.get", { object: SLOT, id: ids.bSlot }, outside(a))).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    // A filter on a field the shared rows do not show finds only the caller's own.
    const byNote = items(
      await call(
        "my.list",
        { object: SLOT, filter: { field: "note", op: "is_not_null" } },
        outside(a),
      ),
    );
    expect(byNote.map((s) => s.id)).toEqual([ids.aSlot]);
  });

  it("an object every signed-in customer reads alone is read-only, and the public read none of it", async () => {
    const groups = items(await call("my.list", { object: GROUP }, outside(a)));
    expect(groups.find((g) => g.id === ids.group)?.values).toEqual({ name: "Mobility" });
    expect(
      await call(
        "fixture.myUpdate",
        { object: GROUP, id: ids.group, values: { name: "x" } },
        outside(a),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: `Unknown object "${GROUP}"` },
    });
    for (const object of [GROUP, PLAN, SLOT]) {
      expect(await call("fixture.publicPeek", { object }, outside(PUBLIC)), object).toMatchObject({
        ok: false,
        error: { code: "invalid_input", message: `Unknown object "${object}"` },
      });
    }
  });
});

describe("writes", () => {
  it("a shared record is read by a customer, never changed; their own is", async () => {
    const shared = await call(
      "fixture.myUpdate",
      { object: SLOT, id: ids.classSlot, values: { note: "A was here" } },
      outside(a),
    );
    expect(shared).toMatchObject({ ok: false, error: { code: "not_found" } });
    const own = await call(
      "fixture.myUpdate",
      { object: SLOT, id: ids.aSlot, values: { note: "A's own" } },
      outside(a),
    );
    expect(own).toMatchObject({ ok: true, value: { values: { note: "A's own" } } });
    const after = await invoke("record.get", { object: SLOT, id: ids.classSlot }, context(admin));
    expect(after.values.note).toBe("N-class");
  });

  it("a relation a customer sets points only at what they can see", async () => {
    const onTheirs = await call(
      "fixture.myCreate",
      { object: ENTRY, values: { label: "set", slot: ids.bSlot, reps: 5 } },
      outside(a),
    );
    // Another customer's session answers as one that does not exist.
    const onNothing = await call(
      "fixture.myCreate",
      { object: ENTRY, values: { label: "set", slot: "rec_01NOSUCHSLOT0000000000000", reps: 5 } },
      outside(a),
    );
    expect(onTheirs).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(JSON.stringify(onTheirs).replaceAll(ids.bSlot as string, "<id>")).toBe(
      JSON.stringify(onNothing).replaceAll("rec_01NOSUCHSLOT0000000000000", "<id>"),
    );
    for (const slot of [ids.aSlot, ids.classSlot]) {
      const ok = await call(
        "fixture.myCreate",
        { object: ENTRY, values: { label: "set", slot, reps: 5 } },
        outside(a),
      );
      expect(ok.ok, JSON.stringify(ok)).toBe(true);
    }
    // And an update cannot move one's entry onto another's session.
    const mine = items(await call("my.list", { object: ENTRY }, outside(a)))[0]?.id as string;
    const moved = await call(
      "fixture.myUpdate",
      { object: ENTRY, id: mine, values: { slot: ids.bSlot } },
      outside(a),
    );
    expect(moved).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(items(await call("my.list", { object: ENTRY }, outside(b)))).toEqual([]);
  });
});
