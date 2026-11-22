// Stage 31a step 6 (ADR 0540): the family link, on the platform's fixtures. Who may make and end a
// link (a person with people:link, nothing else); what a live link lets a guardian read and do,
// and nothing more (one hop, one direction, objects that opt in only); that ending a link, or the
// dependant going to the Trash, stops it at once, the write's own batch included (the guard); and
// a merge and an erase of either Person.
import { env } from "cloudflare:workers";
import { CompiledQuery } from "kysely";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { fieldStorage, objectTableOf } from "../src/extensions/schema.ts";
import {
  type ActingUser,
  adjudicatePendingAction,
  type CustomerPrincipal,
  coreRegistry,
  createInvoker,
  createRegistry,
  defineOperation,
  invoke,
  invokeByName,
  type ModelRunner,
  PendingApprovalError,
} from "../src/index.ts";
import {
  call,
  DAY,
  HOLDING,
  installShop,
  type Outcome,
  outside,
  TICKET,
  VISIT,
} from "./customer-fixtures.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";

let admin: ActingUser;
let member: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  await installShop();
}, 60_000);

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a refusal");
}

const person = async (label: string, email = false) =>
  (
    await invoke(
      "person.create",
      {
        givenName: unique(label),
        ...(email ? { emails: [{ email: `${unique(label).toLowerCase()}@family.test` }] } : {}),
      },
      context(admin),
    )
  ).id as string;

const link = (guardianId: string, dependantId: string, by = admin, extra = {}) =>
  invoke("person.link.add", { guardianId, dependantId }, context(by, extra as never));

const customer = (personId: string): CustomerPrincipal => ({
  kind: "customer",
  customerId: `cus_${unique("fam")}`,
  personId,
});

const visit = async (personId: string, note: string) =>
  (
    await invoke(
      "record.create",
      { object: VISIT, values: { note, person: personId } },
      context(admin),
    )
  ).id as string;

const items = (outcome: Outcome) =>
  (outcome as { value: { items: { id: string; values: Record<string, unknown> }[] } }).value.items;

const visitsOf = async (principal: CustomerPrincipal) =>
  items(await call("fixture.myList", { object: VISIT }, outside(principal))).map((i) => i.id);

describe("who makes and ends a link", () => {
  it("a person on the staff with people:link, and no other actor or audience", async () => {
    const parent = await person("Parent");
    const child = await person("Child");
    const actors = [
      {
        actor: "mcp",
        origin: { surface: "mcp", clientId: "c", clientName: "T", sessionId: unique("s") },
        grantedPermissions: ["records:read", "records:write", "people:link"],
      },
      { actor: "assistant", origin: { surface: "assistant", sessionId: unique("ath") } },
      { actor: "automation", origin: { surface: "automation", automationId: "x.y" } },
      { actor: "extension", origin: { surface: "extension", extensionId: "bookings" } },
    ];
    for (const extra of actors) {
      const refused = await refusal(link(parent, child, admin, extra));
      expect(refused.code, JSON.stringify(extra)).toBe("forbidden");
    }
    // A member without the grant is refused; granted, a member links.
    expect(await refusal(link(parent, child, member))).toMatchObject({
      code: "forbidden",
      details: { permission: "people:link" },
    });
    await invoke(
      "user.setPermissions",
      { id: member.id, permissions: ["people:link"] },
      context(admin),
    );
    const made = await link(parent, child, member);
    expect(made).toMatchObject({
      kind: "guardian",
      guardian: { id: parent },
      dependant: { id: child },
      createdBy: member.id,
      endedAt: null,
    });
    // Ending is the same: a person only.
    for (const extra of actors) {
      const refused = await refusal(
        invoke("person.link.end", { id: made.id }, context(admin, extra as never)),
      );
      expect(refused.code).toBe("forbidden");
    }
    await invoke("user.setPermissions", { id: member.id, permissions: [] }, context(admin));
    expect(
      await refusal(invoke("person.link.end", { id: made.id }, context(member))),
    ).toMatchObject({ code: "forbidden" });
    const ended = await invoke(
      "person.link.end",
      { id: made.id, reason: "asked at the desk" },
      context(admin),
    );
    expect(ended).toMatchObject({ endedBy: admin.id, endReason: "asked at the desk" });
    expect(await refusal(invoke("person.link.end", { id: made.id }, context(admin)))).toMatchObject(
      { code: "conflict" },
    );
    // A customer and the public cannot call them at all.
    for (const name of ["person.link.add", "person.link.end", "person.link.list"]) {
      expect(
        await call(name, { guardianId: parent, dependantId: child }, outside(customer(parent))),
      ).toMatchObject({ ok: false, error: { code: "unknown_operation" } });
    }
  });

  it("never a Person to themselves, twice, either way round, or someone not there", async () => {
    const parent = await person("Parent");
    const child = await person("Child");
    expect(await refusal(link(parent, parent))).toMatchObject({ code: "invalid_input" });
    await link(parent, child);
    expect(await refusal(link(parent, child))).toMatchObject({ code: "conflict" });
    expect(await refusal(link(child, parent))).toMatchObject({ code: "conflict" });
    expect(await refusal(link(parent, "per_01NOSUCHPERSON0000000000000"))).toMatchObject({
      code: "not_found",
    });
    // The database refuses a self-link and a second live link whatever code asks.
    await expect(
      env.DB.prepare(
        "INSERT INTO core_person_link (id, guardian_id, dependant_id, created_by, created_at) VALUES ('pln_x', ?, ?, 'usr_x', 'now')",
      )
        .bind(parent, parent)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "INSERT INTO core_person_link (id, guardian_id, dependant_id, created_by, created_at) VALUES ('pln_y', ?, ?, 'usr_x', 'now')",
      )
        .bind(parent, child)
        .run(),
    ).rejects.toThrow(/UNIQUE/);
    const listed = await invoke("person.link.list", { personId: child }, context(admin));
    expect(listed.items.map((l: { guardian: { id: string } }) => l.guardian.id)).toEqual([parent]);
  });
});

describe("what a live link gives, and only that", () => {
  it("a guardian reads and acts for their child; not a child's child, not the other way, not a stranger's child", async () => {
    const parent = await person("Parent", true);
    const child = await person("Child");
    const grandchild = await person("Grandchild");
    const stranger = await person("Stranger", true);
    const strangersChild = await person("StrangersChild");
    await link(parent, child);
    await link(child, grandchild);
    await link(stranger, strangersChild);
    const own = await visit(parent, "parent's");
    const childs = await visit(child, "child's");
    const grandchilds = await visit(grandchild, "grandchild's");
    const strangers = await visit(strangersChild, "stranger's child's");
    const p = customer(parent);
    expect((await visitsOf(p)).sort()).toEqual([own, childs].sort());
    // The child, given an account later, reads their own and their own child's, never the
    // parent's: the link has a direction.
    expect((await visitsOf(customer(child))).sort()).toEqual([childs, grandchilds].sort());
    for (const id of [grandchilds, strangers]) {
      expect(await call("fixture.myGet", { object: VISIT, id }, outside(p))).toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
    }
    // Making one: for the child, yes; for anyone else, a Person that is not there.
    const made = await call(
      "fixture.myCreate",
      { object: VISIT, values: { note: "for my child" }, forPersonId: child },
      outside(p),
    );
    expect(made.ok, JSON.stringify(made)).toBe(true);
    for (const forPersonId of [grandchild, strangersChild, stranger]) {
      expect(
        await call(
          "fixture.myCreate",
          { object: VISIT, values: { note: "x" }, forPersonId },
          outside(p),
        ),
      ).toEqual({
        ok: false,
        error: {
          code: "not_found",
          message: `No person with id ${forPersonId}`,
          details: { object: "person", id: forPersonId },
        },
      });
    }
    // Naming the child in the values instead is refused, as for any owner field.
    expect(
      await call(
        "fixture.myCreate",
        { object: VISIT, values: { note: "x", person: child } },
        outside(p),
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    // Who made it is the host's, never the caller's.
    expect(
      await call(
        "fixture.myCreate",
        { object: VISIT, values: { note: "x", madeBy: stranger }, forPersonId: child },
        outside(p),
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    // An object that does not open to guardians: nothing of the child's, even with the link.
    const ticket = await invoke(
      "record.create",
      { object: TICKET, values: { code: unique("T"), holder: child } },
      context(admin),
    );
    expect(
      await call("fixture.myGet", { object: TICKET, id: ticket.id }, outside(p)),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    // A read-only opening: the child's holding is read, never changed.
    const holding = await invoke(
      "record.create",
      { object: HOLDING, values: { label: "child's pass", person: child } },
      context(admin),
    );
    expect(
      await call("fixture.myGet", { object: HOLDING, id: holding.id }, outside(p)),
    ).toMatchObject({ ok: true });
    expect(
      await call(
        "fixture.myUpdate",
        { object: HOLDING, id: holding.id, values: { label: "mine now" } },
        outside(p),
      ),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("the record a guardian makes is the child's, with the guardian as who made it", async () => {
    const parent = await person("Parent", true);
    const child = await person("Child");
    await link(parent, child);
    const made = await call(
      "fixture.myCreate",
      { object: VISIT, values: { note: "Saturday" }, forPersonId: child },
      outside(customer(parent)),
    );
    const id = (made as { value: { id: string } }).value.id;
    const got = await invoke("record.get", { object: VISIT, id }, context(admin));
    expect(got.values).toMatchObject({ person: child, madeBy: parent, note: "Saturday" });
    // Their own: who made it is themselves.
    const mine = await call(
      "fixture.myCreate",
      { object: VISIT, values: { note: "Mine" } },
      outside(customer(parent)),
    );
    const own = await invoke(
      "record.get",
      { object: VISIT, id: (mine as { value: { id: string } }).value.id },
      context(admin),
    );
    expect(own.values).toMatchObject({ person: parent, madeBy: parent });
  });

  it("ending the link stops reads and writes at once; records made stay", async () => {
    const parent = await person("Parent", true);
    const child = await person("Child");
    const made = await link(parent, child);
    const p = customer(parent);
    const childs = await visit(child, "child's");
    const day = await invoke(
      "record.create",
      { object: DAY, values: { name: "Day of the child's visit" } },
      context(admin),
    );
    await invoke(
      "record.update",
      { object: VISIT, id: childs, values: { day: day.id } },
      context(admin),
    );
    expect(await visitsOf(p)).toContain(childs);
    expect(await call("fixture.myGet", { object: DAY, id: day.id }, outside(p))).toMatchObject({
      ok: true,
    });
    // A visit the parent made for the child, which stays: staff are told.
    await call(
      "fixture.myCreate",
      { object: VISIT, values: { note: "made by the parent" }, forPersonId: child },
      outside(p),
    );
    const ended = await invoke("person.link.end", { id: made.id }, context(admin));
    expect(ended.stays).toEqual([{ object: VISIT, label: "Visits", count: 1 }]);
    expect(await visitsOf(p)).not.toContain(childs);
    expect(await call("fixture.myGet", { object: DAY, id: day.id }, outside(p))).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(
      await call(
        "fixture.myUpdate",
        { object: VISIT, id: childs, values: { note: "after" } },
        outside(p),
      ),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(
      await call(
        "fixture.myCreate",
        { object: VISIT, values: { note: "after" }, forPersonId: child },
        outside(p),
      ),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await call("me.family", {}, outside(p))).toMatchObject({
      ok: true,
      value: { dependants: [] },
    });
    // The child's record stays, for staff.
    expect(await invoke("record.get", { object: VISIT, id: childs }, context(admin))).toMatchObject(
      { id: childs },
    );
    // Linked again, it reads again: a new link, the ended one kept as history.
    await link(parent, child);
    expect(await visitsOf(p)).toContain(childs);
    const history = await invoke(
      "person.link.list",
      { personId: parent, ended: true },
      context(admin),
    );
    expect(history.items.map((l: { endedAt: string | null }) => l.endedAt === null)).toEqual([
      true,
      false,
    ]);
  });

  it("the write's own batch fails if the link ended after it was checked (the guard)", async () => {
    const parent = await person("Parent");
    const child = await person("Child");
    const made = await link(parent, child);
    const guard = () =>
      env.DB.prepare(
        "INSERT INTO core_person_link_guard (guardian_id, dependant_id) VALUES (?, ?)",
      ).bind(parent, child);
    const table = objectTableOf(VISIT) as string;
    // Live: the guard passes and stores nothing.
    await env.DB.batch([guard()]);
    await invoke("person.link.end", { id: made.id }, context(admin));
    const before = await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{
      n: number;
    }>();
    // Ended: the whole batch fails, the write beside it included.
    await expect(
      env.DB.batch([
        guard(),
        env.DB.prepare(
          `INSERT INTO ${table} (id, created_at, updated_at) VALUES ('rec_guarded', 'now', 'now')`,
        ),
      ]),
    ).rejects.toThrow(/core_person_link_not_live/);
    const after = await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
    const stored = await env.DB.prepare("SELECT count(*) AS n FROM core_person_link_guard").first<{
      n: number;
    }>();
    expect(stored?.n).toBe(0);
  });

  it("the seam puts the guard in the guardian's own write: a link ended in the same batch, before it, fails it", async () => {
    // A bookkeeping operation (it keeps ctx.write) that ends the link first, then makes a visit
    // for the child through the seam: the seam's check (before the batch) passes, and its guard
    // (in the batch, after the end) fails the whole batch.
    const raced = defineOperation({
      name: "familyTest.endThenCreate",
      description: "Test: ends the caller's link to a child, then books for the child.",
      input: z.object({ linkId: z.string(), child: z.string() }),
      output: z.object({ id: z.string() }),
      permission: "records:write",
      risk: "write",
      audiences: ["customer"],
      hostInternal: true,
      async handler(input, ctx) {
        ctx.write(
          CompiledQuery.raw("UPDATE core_person_link SET ended_at = ? WHERE id = ?", [
            ctx.now,
            input.linkId,
          ]),
        );
        return ctx.records.create(VISIT, { note: "raced" }, { forPersonId: input.child });
      },
    });
    const invoker = createInvoker(createRegistry([...coreRegistry.list(), raced]));
    const parent = await person("Parent");
    const child = await person("Child");
    const made = await link(parent, child);
    const before = await visitsOf(customer(child));
    await expect(
      invoker.invokeByName(
        "familyTest.endThenCreate",
        { linkId: made.id, child },
        outside(customer(parent)),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    // Nothing of the batch was applied: the link is live, no visit was made.
    const row = await env.DB.prepare("SELECT ended_at FROM core_person_link WHERE id = ?")
      .bind(made.id)
      .first<{ ended_at: string | null }>();
    expect(row?.ended_at).toBeNull();
    expect(await visitsOf(customer(child))).toEqual(before);
  });

  it("a change to the child's record carries the guard too: a link ended in the same batch fails it", async () => {
    const raced = defineOperation({
      name: "familyTest.endThenUpdate",
      description: "Test: ends the caller's link to a child, then changes the child's visit.",
      input: z.object({ linkId: z.string(), visit: z.string() }),
      output: z.object({ ok: z.boolean() }),
      permission: "records:write",
      risk: "write",
      audiences: ["customer"],
      hostInternal: true,
      async handler(input, ctx) {
        ctx.write(
          CompiledQuery.raw("UPDATE core_person_link SET ended_at = ? WHERE id = ?", [
            ctx.now,
            input.linkId,
          ]),
        );
        await ctx.records.update(VISIT, input.visit, { note: "raced" });
        return { ok: true };
      },
    });
    const invoker = createInvoker(createRegistry([...coreRegistry.list(), raced]));
    const parent = await person("Parent");
    const child = await person("Child");
    const made = await link(parent, child);
    const childs = await visit(child, "before");
    await expect(
      invoker.invokeByName(
        "familyTest.endThenUpdate",
        { linkId: made.id, visit: childs },
        outside(customer(parent)),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    const row = await env.DB.prepare("SELECT ended_at FROM core_person_link WHERE id = ?")
      .bind(made.id)
      .first<{ ended_at: string | null }>();
    expect(row?.ended_at).toBeNull();
    const after = await invoke("record.get", { object: VISIT, id: childs }, context(admin));
    expect(after.values.note).toBe("before");
  });

  it("a write for the child recorded outside the seam's helpers is held to the link at commit", async () => {
    // The reviewer's probe: a bookkeeping operation ends the link, then writes a visit for the
    // child itself and records the create; the seam's final check adds the guard, which fails.
    const table = objectTableOf(VISIT) as string;
    const personColumn = fieldStorage(VISIT, "person")?.column as string;
    const noteColumn = fieldStorage(VISIT, "note")?.column as string;
    const unchecked = defineOperation({
      name: "familyTest.endThenRecord",
      description: "Test: ends the caller's link, then records a create for the child itself.",
      input: z.object({ linkId: z.string(), child: z.string(), id: z.string() }),
      output: z.object({ ok: z.boolean() }),
      permission: "records:write",
      risk: "write",
      audiences: ["customer"],
      hostInternal: true,
      async handler(input, ctx) {
        ctx.write(
          CompiledQuery.raw("UPDATE core_person_link SET ended_at = ? WHERE id = ?", [
            ctx.now,
            input.linkId,
          ]),
          CompiledQuery.raw(
            `INSERT INTO ${table} (id, ${personColumn}, ${noteColumn}, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
            [input.id, input.child, "unchecked", ctx.now, ctx.now],
          ),
        );
        ctx.recordChange({
          object: VISIT,
          id: input.id,
          action: "create",
          diff: {
            person: { before: null, after: input.child },
            note: { before: null, after: "unchecked" },
          },
        });
        return { ok: true };
      },
    });
    const invoker = createInvoker(createRegistry([...coreRegistry.list(), unchecked]));
    const parent = await person("Parent");
    const child = await person("Child");
    const made = await link(parent, child);
    const id = `rec_${unique("UNCHECKED").toUpperCase()}`;
    await expect(
      invoker.invokeByName(
        "familyTest.endThenRecord",
        { linkId: made.id, child, id },
        outside(customer(parent)),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    const row = await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(id).first();
    expect(row).toBeNull();
    const still = await env.DB.prepare("SELECT ended_at FROM core_person_link WHERE id = ?")
      .bind(made.id)
      .first<{ ended_at: string | null }>();
    expect(still?.ended_at).toBeNull();
  });

  it("a guardian in the Trash gives nothing; restored, the link gives again", async () => {
    const parent = await person("Parent");
    const child = await person("Child");
    await link(parent, child);
    const childs = await visit(child, "child's");
    const p = customer(parent);
    await invoke("person.delete", { id: parent }, context(admin));
    expect(await visitsOf(p)).not.toContain(childs);
    expect(
      await call(
        "fixture.myCreate",
        { object: VISIT, values: { note: "x" }, forPersonId: child },
        outside(p),
      ),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    await invoke("person.restore", { id: parent }, context(admin));
    expect(await visitsOf(p)).toContain(childs);
  });

  it("who made a record is the seam's alone: staff cannot set or change it", async () => {
    const parent = await person("Parent");
    const child = await person("Child");
    await link(parent, child);
    const made = await call(
      "fixture.myCreate",
      { object: VISIT, values: { note: "mine" }, forPersonId: child },
      outside(customer(parent)),
    );
    const id = (made as { value: { id: string } }).value.id;
    expect(
      await refusal(
        invoke("record.update", { object: VISIT, id, values: { madeBy: child } }, context(admin)),
      ),
    ).toMatchObject({ code: "invalid_input", details: { field: "madeBy" } });
    expect(
      await refusal(
        invoke(
          "record.create",
          { object: VISIT, values: { note: "x", person: child, madeBy: parent } },
          context(admin),
        ),
      ),
    ).toMatchObject({ code: "invalid_input", details: { field: "madeBy" } });
    const got = await invoke("record.get", { object: VISIT, id }, context(admin));
    expect(got.values.madeBy).toBe(parent);
  });

  it("staff are warned when the child's record has an account's email", async () => {
    const email = `${unique("shared").toLowerCase()}@family.test`;
    const parent = await person("Parent");
    // The parent's account signs in with this address (their Person has another).
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO core_customer (id, person_id, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    )
      .bind(`cus_${unique("acct")}`, parent, email, now, now)
      .run();
    const child = (
      await invoke(
        "person.create",
        { givenName: unique("Child"), emails: [{ email }] },
        context(admin),
      )
    ).id as string;
    const made = await link(parent, child);
    expect(made.warning).toContain(email);
    const listed = await invoke("person.link.list", { personId: child }, context(admin));
    expect(listed.items[0]?.warning).toContain(email);
    // Only to staff who make links: a member reading the links is not told an account exists.
    const asMember = await invoke("person.link.list", { personId: child }, context(member));
    expect(asMember.items[0]?.warning).toBeNull();
    // No warning when the child has no such address.
    const other = await person("OtherChild");
    expect((await link(parent, other)).warning).toBeNull();
  });

  it("a child in the Trash gives nothing until restored", async () => {
    const parent = await person("Parent");
    const child = await person("Child");
    await link(parent, child);
    const childs = await visit(child, "child's");
    const p = customer(parent);
    await invoke("person.delete", { id: child }, context(admin));
    expect(await visitsOf(p)).not.toContain(childs);
    expect(
      await call(
        "fixture.myCreate",
        { object: VISIT, values: { note: "x" }, forPersonId: child },
        outside(p),
      ),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    await invoke("person.restore", { id: child }, context(admin));
    expect(await visitsOf(p)).toContain(childs);
  });

  it("me.family: the caller, their children and their guardians, by name, live links only", async () => {
    const parent = await person("Parent");
    const other = await person("OtherParent");
    const child = await person("Child");
    await link(parent, child);
    const second = await link(other, child);
    const asChild = await call("me.family", {}, outside(customer(child)));
    expect(asChild).toMatchObject({
      ok: true,
      value: { self: { personId: child }, dependants: [] },
    });
    expect(
      (asChild as { value: { guardians: { personId: string }[] } }).value.guardians
        .map((g) => g.personId)
        .sort(),
    ).toEqual([parent, other].sort());
    await invoke("person.link.end", { id: second.id }, context(admin));
    const after = await call("me.family", {}, outside(customer(child)));
    expect(
      (after as { value: { guardians: { personId: string }[] } }).value.guardians.map(
        (g) => g.personId,
      ),
    ).toEqual([parent]);
  });
});

describe("merging and erasing People with links", () => {
  const links = async (id: string) =>
    (
      await env.DB.prepare(
        "SELECT guardian_id, dependant_id, ended_at, end_reason FROM core_person_link WHERE guardian_id = ? OR dependant_id = ? ORDER BY created_at",
      )
        .bind(id, id)
        .all<Record<string, string | null>>()
    ).results;

  it("a merge re-points links to the survivor, drops a self-link and ends a duplicate", async () => {
    const parent = await person("Parent");
    const parentAgain = await person("ParentAgain");
    const child = await person("Child");
    const childAgain = await person("ChildAgain");
    const sibling = await person("Sibling");
    await link(parent, child);
    await link(parentAgain, child); // a duplicate once the parents are one
    await link(parentAgain, sibling); // moves to the survivor
    await link(parentAgain, parent); // would be a self-link
    await link(parent, childAgain);
    const merged = await invoke(
      "person.merge",
      { survivorId: parent, mergedId: parentAgain },
      context(admin),
    );
    // One moves (the sibling), one ends (a duplicate), one is deleted (between the two).
    expect(merged.familyLinks).toEqual({ moved: 1, ended: 1, deleted: 1, history: 0 });
    const after = await links(parent);
    const live = after.filter((l) => l.ended_at === null);
    expect(live.map((l) => [l.guardian_id, l.dependant_id]).sort()).toEqual(
      [
        [parent, child],
        [parent, sibling],
        [parent, childAgain],
      ].sort(),
    );
    expect(after.filter((l) => l.ended_at !== null)).toEqual([
      expect.objectContaining({
        guardian_id: parent,
        dependant_id: child,
        end_reason: "merged: a duplicate",
      }),
    ]);
    expect(await links(parentAgain)).toEqual([]);
    // A child merged into their own record keeps their guardian.
    await invoke("person.merge", { survivorId: child, mergedId: childAgain }, context(admin));
    const childLinks = (await links(child)).filter((l) => l.ended_at === null);
    expect(childLinks.map((l) => l.guardian_id)).toEqual([parent]);
  });

  it("a merge never makes a two-way link: the moved link ends when its other way round is live", async () => {
    // The reviewer's probe: P is C's guardian; C's duplicate C2 was made P's guardian. Merging C2
    // into C would have made C the guardian of P, so the child would act for the parent.
    const parent = await person("Parent", true);
    const child = await person("Child", true);
    const childAgain = await person("ChildAgain");
    await link(parent, child);
    await link(childAgain, parent);
    const ownOfParent = await visit(parent, "the parent's own");
    const plan = await invoke(
      "person.link.mergePlan",
      { survivorId: child, mergedId: childAgain },
      context(admin),
    );
    expect(plan).toEqual({ moved: 0, ended: 1, deleted: 0, history: 0, needs: null });
    const merged = await invoke(
      "person.merge",
      { survivorId: child, mergedId: childAgain },
      context(admin),
    );
    expect(merged.familyLinks).toEqual({ moved: 0, ended: 1, deleted: 0, history: 0 });
    const live = (await links(child)).filter((l) => l.ended_at === null);
    expect(live.map((l) => [l.guardian_id, l.dependant_id])).toEqual([[parent, child]]);
    expect((await links(child)).find((l) => l.ended_at !== null)).toMatchObject({
      guardian_id: child,
      dependant_id: parent,
      end_reason: "merged: the other way round is linked",
    });
    // The child, signed in, reads nothing of the parent's.
    expect(await visitsOf(customer(child))).not.toContain(ownOfParent);
  });

  it("the database refuses a two-way link, from any writer and from a race of two links", async () => {
    const a = await person("A");
    const b = await person("B");
    await link(a, b);
    await expect(
      env.DB.prepare(
        "INSERT INTO core_person_link (id, guardian_id, dependant_id, created_by, created_at) VALUES (?, ?, ?, 'usr_x', 'now')",
      )
        .bind(`pln_${unique("r")}`, b, a)
        .run(),
    ).rejects.toThrow(/core_person_link_reverse/);
    // Two staff linking a new pair in opposite directions at once: one link is made.
    const c = await person("C");
    const d = await person("D");
    const both = await Promise.allSettled([link(c, d), link(d, c)]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const made = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_person_link WHERE ended_at IS NULL AND guardian_id IN (?, ?)",
    )
      .bind(c, d)
      .first<{ n: number }>();
    expect(made?.n).toBe(1);
  });

  it("a merge that touches a live link is a person's act: from any other actor it waits, whatever the preset", async () => {
    const parent = await person("Parent");
    const parentAgain = await person("ParentAgain");
    const child = await person("Child");
    await link(parent, child);
    await setPreset("autonomous");
    try {
      for (const extra of [
        {
          actor: "mcp",
          origin: { surface: "mcp", clientId: "c", clientName: "T", sessionId: unique("s") },
          grantedPermissions: ["records:read", "records:write"],
        },
        { actor: "assistant", origin: { surface: "assistant", sessionId: unique("ath") } },
      ]) {
        const refused = await refusal(
          invoke(
            "person.merge",
            { survivorId: parent, mergedId: parentAgain },
            context(admin, extra as never),
          ),
        );
        expect(refused.code, JSON.stringify(extra)).toBe("pending_approval");
      }
      // Nothing moved meanwhile.
      expect(await invoke("person.get", { id: parentAgain }, context(admin))).toMatchObject({
        id: parentAgain,
      });
    } finally {
      await setPreset("balanced");
    }
  });

  // Second review: who can move a link by merging.
  const mcpCall = () =>
    context(admin, {
      actor: "mcp",
      origin: { surface: "mcp", clientId: "c", clientName: "T", sessionId: `cap_${unique()}` },
      reason: "These two are the same person",
    } as never);
  const queueMerge = async (survivorId: string, mergedId: string) => {
    const error = await invoke("person.merge", { survivorId, mergedId }, mcpCall()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PendingApprovalError);
    return (error as PendingApprovalError).pending.actionId;
  };
  const pending = (id: string) =>
    env.DB.prepare("SELECT status, review_source FROM core_pending_action WHERE id = ?")
      .bind(id)
      .first<{ status: string; review_source: string | null }>();

  it("a merge queued with no links, a link made after: the adjudicator leaves it for a person", async () => {
    await setPreset("balanced");
    await invoke(
      "adjudicator.setPolicy",
      { text: "- Merging duplicates is fine." },
      context(admin),
    );
    await env.DB.prepare(
      "INSERT OR REPLACE INTO core_settings (key, value, updated_at) VALUES ('adjudicator', ?, ?)",
    )
      .bind(
        JSON.stringify({ mode: "active", threshold: 0.5, enabledAt: "2000-01-01T00:00:00.000Z" }),
        new Date().toISOString(),
      )
      .run();
    const approving: ModelRunner = {
      async run() {
        return {
          text: JSON.stringify({ verdict: "approve", confidence: 1, reason: "A duplicate." }),
          model: "fake",
          provider: "fake",
        };
      },
    } as unknown as ModelRunner;
    try {
      const stranger = await person("Stranger");
      const parent = await person("Parent");
      const child = await person("Child");
      const actionId = await queueMerge(stranger, parent);
      expect((await pending(actionId))?.review_source).toBe("policy");
      // Meanwhile staff link the parent to a child.
      await link(parent, child);
      const result = await adjudicatePendingAction(
        { db, models: approving, resolveOperation: (name) => coreRegistry.get(name) },
        actionId,
      );
      expect(result).toMatchObject({ status: "judged", outcome: "escalated" });
      expect(await pending(actionId)).toEqual({ status: "pending", review_source: "always" });
      // Not applied: the stranger is nobody's guardian.
      const strangerLinks = await links(stranger);
      expect(strangerLinks).toEqual([]);
      expect((await links(parent)).filter((l) => l.ended_at === null)).toHaveLength(1);
    } finally {
      await env.DB.prepare("DELETE FROM core_settings WHERE key = 'adjudicator'").run();
    }
  });

  it("a person approving a merge after a link was made gets a conflict, not the link moved", async () => {
    await setPreset("balanced");
    const stranger = await person("Stranger");
    const parent = await person("Parent");
    const child = await person("Child");
    const actionId = await queueMerge(stranger, parent);
    await link(parent, child);
    const approve = async () => {
      try {
        return (await invokeByName(
          "approval.approve",
          { actionIds: [actionId] },
          context(admin),
        )) as {
          results: { status: string; statusReason?: string | null }[];
        };
      } catch (error) {
        const label = (error as { details?: { confirmLabel?: string } }).details?.confirmLabel;
        if (!label) throw error;
        return (await invokeByName(
          "approval.approve",
          { actionIds: [actionId], confirm: label },
          context(admin),
        )) as { results: { status: string; statusReason?: string | null }[] };
      }
    };
    const result = await approve();
    expect(result.results[0]).toMatchObject({ status: "failed" });
    expect(result.results[0]?.statusReason).toContain("changed after this was queued");
    expect(await links(stranger)).toEqual([]);
    // Asked again, the fresh preview names the link: it moves, and it now waits for a person.
    const again = await queueMerge(stranger, parent);
    expect((await pending(again))?.review_source).toBe("always");
    const preview = await env.DB.prepare("SELECT preview FROM core_pending_action WHERE id = ?")
      .bind(again)
      .first<{ preview: string }>();
    expect(preview?.preview).toContain("1 moved, 0 ended, 0 deleted");
  });

  it("a merge that moves a live link needs people:link: a member is refused, an admin is not", async () => {
    const parent = await person("Parent");
    const parentAgain = await person("ParentAgain");
    const child = await person("Child");
    await link(parentAgain, child);
    const plan = await invoke(
      "person.link.mergePlan",
      { survivorId: parent, mergedId: parentAgain },
      context(member),
    );
    expect(plan).toMatchObject({ moved: 1, needs: "people:link" });
    expect(
      await refusal(
        invoke("person.merge", { survivorId: parent, mergedId: parentAgain }, context(member)),
      ),
    ).toMatchObject({ code: "forbidden", details: { permission: "people:link" } });
    expect((await links(parentAgain)).filter((l) => l.ended_at === null)).toHaveLength(1);
    // A merge that moves no live link is the member's to make, as before.
    const a = await person("Lone");
    const b = await person("LoneAgain");
    await expect(
      invoke("person.merge", { survivorId: a, mergedId: b }, context(member)),
    ).resolves.toMatchObject({ id: a });
    const done = await invoke(
      "person.merge",
      { survivorId: parent, mergedId: parentAgain },
      context(admin),
    );
    expect(done.familyLinks).toMatchObject({ moved: 1 });
  });

  it("erasing a guardian leaves the child, with no guardian, and tells staff", async () => {
    const parent = await person("Parent");
    const otherParent = await person("OtherParent");
    const child = await person("Child");
    const twin = await person("Twin");
    await link(parent, child);
    await link(parent, twin);
    await link(otherParent, twin);
    const erased = await invoke("person.erase", { id: parent }, context(admin));
    expect(erased.dependantsWithoutGuardian).toEqual([child]);
    expect(await links(parent)).toEqual([]);
    expect(await invoke("person.get", { id: child }, context(admin))).toMatchObject({ id: child });
    const notes = await env.DB.prepare(
      "SELECT a.subject FROM core_activity a JOIN core_activity_links l ON l.activity_id = a.id WHERE l.object_type = 'person' AND l.record_id = ?",
    )
      .bind(child)
      .all<{ subject: string }>();
    expect(notes.results.map((n) => n.subject)).toContain("No guardian linked any more");
    // The twin still has a guardian, so nothing is said there.
    expect(erased.dependantsWithoutGuardian).not.toContain(twin);
    // Erasing a dependant removes their links with them.
    await invoke("person.erase", { id: twin }, context(admin));
    expect(await links(otherParent)).toEqual([]);
  });
});
