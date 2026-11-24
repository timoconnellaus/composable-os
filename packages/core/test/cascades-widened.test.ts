// Stage 57 step 2 (ADR 0841): the state cascade widened. A child that draws no places may follow
// a parent others draw places from as a pool (crew shifts follow their event, whose ticket types
// draw on it); one that draws places is still refused. A child may follow a parent in another
// extension its own requires (room uses follow Ticketing's event), with the parent's states checked
// at install and on an upgrade of either extension. Proved on fixtures: every way the parent moves
// (a person, the host, an import, a timed move), the Trash, a follower made under the move (the
// batch fails whole), a parent move refused whole when a child's claim is refused, the limit across
// every following object, and what one follower costs the batch. Every clock is injected.
import { env } from "cloudflare:workers";
import type { CrmDb } from "@composable-os/db";
import { validateManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ActingUser,
  checkManifest,
  coreRegistry,
  createInvoker,
  createRecord,
  createRegistry,
  defineOperation,
  invoke,
  requireExtensionObject,
  runTimedMovesDue,
  updateRecordAsHost,
} from "../src/index.ts";
import { FOLLOWERS_MAX } from "../src/records/follows.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";

const option = (values: string[]) => values.map((value) => ({ value, label: value }));

/** The parent's extension: events (a pool), ticket types drawing on them, tickets, crew shifts. */
const events = (id: string) =>
  manifest(id, {
    objects: {
      role: {
        label: "Crew role",
        plural: "Crew roles",
        titleField: "name",
        fields: { name: { type: "text", label: "Name", required: true } },
      },
      event: {
        label: "Event",
        plural: "Events",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          places: { type: "number", label: "Places" },
          endsAt: { type: "datetime", label: "Ends at" },
          state: {
            type: "select",
            label: "State",
            options: option(["draft", "on_sale", "ended", "cancelled"]),
          },
        },
        states: {
          field: "state",
          initial: "draft",
          moves: [
            { from: "draft", to: "on_sale", by: ["staff", "host"] },
            { from: ["draft", "on_sale"], to: "cancelled", by: ["staff", "host"], final: true },
            { from: "on_sale", to: "ended", by: ["host"], final: true },
          ],
          after: [{ from: "on_sale", to: "ended", at: "endsAt" }],
        },
        capacity: { places: "places" },
      },
      tickettype: {
        label: "Ticket type",
        plural: "Ticket types",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          places: { type: "number", label: "Places" },
          event: { type: "relation", label: "Event", to: `${id}.event` },
        },
        capacity: { places: "places", pool: "event" },
      },
      ticket: {
        label: "Ticket",
        plural: "Tickets",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          tickettype: { type: "relation", label: "Ticket type", to: `${id}.tickettype` },
          state: { type: "select", label: "State", options: option(["valid", "void"]) },
        },
        states: {
          field: "state",
          initial: "valid",
          moves: [{ from: "valid", to: "void", by: ["staff", "host"], final: true }],
        },
        claims: { on: "tickettype", confirmed: ["valid"] },
      },
      crewshift: {
        label: "Crew shift",
        plural: "Crew shifts",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          event: { type: "relation", label: "Event", to: `${id}.event` },
          role: { type: "relation", label: "Role", to: `${id}.role` },
          staff: { type: "user", label: "Staff" },
          startsAt: { type: "datetime", label: "Starts at" },
          endsAt: { type: "datetime", label: "Ends at" },
          state: {
            type: "select",
            label: "State",
            options: option(["open", "done", "cancelled"]),
          },
        },
        states: {
          field: "state",
          initial: "open",
          moves: [
            { from: "open", to: "done", by: ["staff", "host"] },
            { from: "open", to: "cancelled", by: ["staff", "host"] },
          ],
          // A non-drawing child of a pool (ADR 0841).
          follows: {
            relation: "event",
            when: { cancelled: "cancelled", ended: "done" },
            from: ["open"],
          },
        },
        staffed: {
          who: { field: "staff" },
          starts: "startsAt",
          ends: "endsAt",
          kind: "role",
          live: ["open", "done"],
        },
      },
    },
  });

/** The child's extension, requiring the parent's: room uses and set-up shifts on its events. */
const hires = (id: string, parent: string) =>
  manifest(id, {
    requires: [parent],
    objects: {
      kind: {
        label: "Kind",
        plural: "Kinds",
        titleField: "name",
        fields: { name: { type: "text", label: "Name", required: true } },
      },
      use: {
        label: "Room use",
        plural: "Room uses",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          event: { type: "relation", label: "Event", to: `${parent}.event` },
          state: {
            type: "select",
            label: "State",
            options: option(["requested", "booked", "released"]),
          },
        },
        states: {
          field: "state",
          initial: "requested",
          moves: [
            { from: "requested", to: "booked", by: ["staff"] },
            { from: ["requested", "booked"], to: "released", by: ["staff", "host"], final: true },
          ],
          follows: {
            relation: "event",
            when: { cancelled: "released", ended: "released" },
            from: ["requested", "booked"],
          },
        },
      },
      setup: {
        label: "Set-up",
        plural: "Set-ups",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          event: { type: "relation", label: "Event", to: `${parent}.event` },
          kind: { type: "relation", label: "Kind", to: `${id}.kind` },
          staff: { type: "user", label: "Staff" },
          startsAt: { type: "datetime", label: "Starts at" },
          endsAt: { type: "datetime", label: "Ends at" },
          state: { type: "select", label: "State", options: option(["requested", "booked"]) },
        },
        states: {
          field: "state",
          initial: "requested",
          moves: [{ from: "requested", to: "booked", by: ["staff", "host"] }],
          // Into a state that claims the person's time: refused whole when it is taken.
          follows: { relation: "event", when: { on_sale: "booked" }, from: ["requested"] },
        },
        staffed: {
          who: { field: "staff" },
          starts: "startsAt",
          ends: "endsAt",
          kind: "kind",
          live: ["booked"],
        },
      },
    },
  });

const P = extId("evp");
const Q = extId("hrq");
const EVENT = `${P}.event`;
const ROLE = `${P}.role`;
const TYPE = `${P}.tickettype`;
const TICKET = `${P}.ticket`;
const CREW = `${P}.crewshift`;
const USE = `${Q}.use`;
const SETUP = `${Q}.setup`;
const KIND = `${Q}.kind`;

const NOW = "2026-12-01T00:00:00.000Z";
const at = (day: number, hour: number) =>
  `2026-12-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
let admin: ActingUser;
let roleId: string;
let kindId: string;
const as = (now = NOW, options: { db?: CrmDb } = {}) =>
  context(admin, { clock: () => new Date(now), ...options });

// The parent moved by the host, and a follower made under a parent's move in one batch: queued
// writes are not seen by the handler's own reads, so the cascade reads its followers without it,
// exactly as it would if the follower committed between the cascade's read and its commit.
const hostMove = defineOperation({
  name: "fixture.cwHostMove",
  description: "Test fixture: moves an event as the host.",
  input: z.object({ id: z.string(), state: z.string() }),
  output: z.object({ ok: z.boolean() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    await updateRecordAsHost(ctx, EVENT, input.id, { state: input.state });
    return { ok: true };
  },
});
const createThenCancel = defineOperation({
  name: "fixture.cwCreateThenCancel",
  description: "Test fixture: a follower made, then its parent cancelled, planned together.",
  input: z.object({
    object: z.string(),
    values: z.record(z.string(), z.unknown()),
    id: z.string(),
  }),
  output: z.object({ ok: z.boolean() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    await createRecord(ctx, requireExtensionObject(input.object), input.values, { by: "staff" });
    await updateRecordAsHost(ctx, EVENT, input.id, { state: "cancelled" });
    return { ok: true };
  },
});
const fixtures = createInvoker(
  createRegistry([...coreRegistry.list(), hostMove, createThenCancel]),
);

async function refused(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).not.toBeNull();
  return error as { code: string; details: Record<string, unknown>; message: string };
}

const create = async (object: string, values: Record<string, unknown>, now = NOW) =>
  ((await invoke("record.create", { object, values }, as(now))) as { id: string }).id;
const update = (object: string, id: string, values: Record<string, unknown>) =>
  invoke("record.update", { object, id, values }, as());

async function stateOf(object: string, id: string): Promise<string> {
  const out = (await invoke("record.get", { object, id }, as())) as {
    values: Record<string, unknown>;
  };
  return String(out.values.state);
}

async function timeClaims(object: string, ids: string[]): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT record_id FROM core_staff_time WHERE object_type = ? AND record_id IN (${ids.map(() => "?").join(", ")})`,
  )
    .bind(object, ...ids)
    .all();
  return results.length;
}

async function takenOn(id: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT held + taken AS n FROM core_capacity WHERE object_type = ? AND record_id = ?",
  )
    .bind(EVENT, id)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** An event on sale (or in `state`) with a ticket sold from its pool. */
async function event(state = "on_sale", endsAt = at(20, 22)) {
  const id = await create(EVENT, { name: unique("Event"), places: 50, endsAt });
  const type = await create(TYPE, { name: "Standard", places: 20, event: id });
  await create(TICKET, { name: "Ticket", tickettype: type });
  if (state !== "draft") await update(EVENT, id, { state });
  expect(await takenOn(id)).toBe(1);
  return id;
}

async function crew(eventId: string, day = 20) {
  const user = await createUser("member");
  const id = await create(CREW, {
    name: unique("Door"),
    event: eventId,
    role: roleId,
    staff: user.id,
    startsAt: at(day, 17),
    endsAt: at(day, 22),
  });
  return { id, user };
}

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(events(P));
  await reconcile(hires(Q, P));
  roleId = await create(ROLE, { name: "Door" });
  kindId = await create(KIND, { name: "Set-up" });
}, 60_000);

describe("the contract (ADR 0841)", () => {
  it("lets a child that draws no places follow a pool, and a child in a requiring extension follow its parent", () => {
    expect(validateManifest(events("okevp")).issues).toEqual([]);
    expect(
      validateManifest(hires("okhrq", "okevp"), { knownObjects: [`okevp.event`] }).issues,
    ).toEqual([]);
  });

  it("still refuses a child that draws places from the pool", () => {
    const issuesOf = (edit: (objects: Record<string, Record<string, unknown>>) => void) => {
      const m = events("poolevp");
      edit(m.objects as unknown as Record<string, Record<string, unknown>>);
      return validateManifest(m).issues.map((i) => `${i.path}: ${i.message}`);
    };
    const pooled = expect.arrayContaining([
      expect.stringMatching(/follows\.relation: .*pool.*draws places/),
    ]);
    // A member of the pool (a ticket type following its event).
    expect(
      issuesOf((objects) => {
        const tt = objects.tickettype as Record<string, unknown>;
        tt.fields = {
          ...(tt.fields as object),
          state: { type: "select", label: "State", options: option(["open", "closed"]) },
        };
        tt.states = {
          field: "state",
          initial: "open",
          moves: [{ from: "open", to: "closed", by: ["host"] }],
          follows: { relation: "event", when: { cancelled: "closed" }, from: ["open"] },
        };
      }),
    ).toEqual(pooled);
    // A claimant of a member (a ticket following the event through its ticket type).
    expect(
      issuesOf((objects) => {
        const t = objects.ticket as Record<string, unknown>;
        t.fields = {
          ...(t.fields as object),
          event: { type: "relation", label: "Event", to: "poolevp.event" },
        };
        t.states = {
          ...(t.states as object),
          follows: { relation: "event", when: { cancelled: "void" }, from: ["valid"] },
        };
      }),
    ).toEqual(pooled);
    // A claimant of the pool itself.
    expect(
      issuesOf((objects) => {
        const t = objects.ticket as Record<string, unknown>;
        t.fields = {
          ...(t.fields as object),
          event: { type: "relation", label: "Event", to: "poolevp.event" },
        };
        t.claims = { on: "event", confirmed: ["valid"] };
        t.states = {
          ...(t.states as object),
          follows: { relation: "event", when: { cancelled: "void" }, from: ["valid"] },
        };
      }),
    ).toEqual(pooled);
  });

  it("refuses a parent in an extension this one does not require", () => {
    const m = hires("norq", "okevp");
    (m as { requires?: string[] }).requires = [];
    const issues = validateManifest(m, { knownObjects: ["okevp.event"] }).issues;
    expect(issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(["objects.use.states.follows.relation"]),
    );
  });

  it("checks the parent's states at install, and an upgrade of the parent keeps what is followed", async () => {
    // A follower naming a state the installed parent does not have.
    const child = hires(extId("hrx"), P);
    const use = child.objects.use as { states: { follows: { when: Record<string, string> } } };
    use.states.follows.when = { cancelled: "released", postponed: "released" };
    const installChild = await checkManifest(db.query, child.id, child, NOW, { installed: [P] });
    expect(installChild.issues).toEqual([
      expect.objectContaining({
        path: "objects.use.states.follows.when",
        message: `"postponed" is not a state of ${EVENT}`,
      }),
    ]);
    // An upgrade of the parent that drops a state an installed follower follows.
    const upgraded = events(P);
    const ev = upgraded.objects.event as {
      fields: Record<string, { options?: { value: string }[] }>;
      states: { moves: { to: string }[]; after?: unknown };
    };
    ev.fields.state = {
      ...ev.fields.state,
      options: option(["draft", "on_sale", "cancelled"]),
    } as never;
    ev.states.moves = ev.states.moves.filter((move) => move.to !== "ended");
    delete ev.states.after;
    const crewStates = (upgraded.objects.crewshift as { states: { follows: unknown } }).states;
    crewStates.follows = { relation: "event", when: { cancelled: "cancelled" }, from: ["open"] };
    const parent = await checkManifest(db.query, P, upgraded, NOW);
    expect(parent.issues).toEqual([
      expect.objectContaining({
        path: "objects.event.states",
        message: expect.stringContaining(`${USE} follows ${EVENT} into "ended"`),
      }),
    ]);
    // Unchanged, both pass.
    expect((await checkManifest(db.query, P, events(P), NOW)).issues).toEqual([]);
    expect((await checkManifest(db.query, Q, hires(Q, P), NOW, { installed: [P] })).issues).toEqual(
      [],
    );
  });
});

describe("a pooled event cancelled moves its crew shifts and its room uses (criterion 16)", () => {
  it("in one batch, with tickets sold from the pool, freeing the crew's time", async () => {
    const id = await event();
    const a = await crew(id);
    const b = await crew(id);
    const requested = await create(USE, { name: "Studio A", event: id });
    const booked = await create(USE, { name: "Studio B", event: id });
    await update(USE, booked, { state: "booked" });
    expect(await timeClaims(CREW, [a.id, b.id])).toBe(2);

    await update(EVENT, id, { state: "cancelled" });
    expect(await stateOf(EVENT, id)).toBe("cancelled");
    expect(await stateOf(CREW, a.id)).toBe("cancelled");
    expect(await stateOf(CREW, b.id)).toBe("cancelled");
    expect(await stateOf(USE, requested)).toBe("released");
    expect(await stateOf(USE, booked)).toBe("released");
    expect(await timeClaims(CREW, [a.id, b.id])).toBe(0);
    // The tickets are Ticketing's own to refund: the cascade did not touch the pool's counter.
    expect(await takenOn(id)).toBe(1);
  });

  it("by the host, an import, and a timed move", async () => {
    // The host.
    const hosted = await event();
    const h = await crew(hosted);
    await fixtures.invoke("fixture.cwHostMove", { id: hosted, state: "cancelled" }, as());
    expect(await stateOf(CREW, h.id)).toBe("cancelled");

    // An import that changes the event's state.
    const key = unique("evt");
    const imported = (await invoke(
      "record.import",
      { object: EVENT, records: [{ key, values: { name: "Imported", places: 10 } }] },
      as(),
    )) as { results: { id: string }[] };
    const importedId = imported.results[0]?.id as string;
    const u = await create(USE, { name: "Hall", event: importedId });
    await invoke(
      "record.import",
      {
        object: EVENT,
        records: [{ key, values: { name: "Imported", places: 10, state: "cancelled" } }],
      },
      as(),
    );
    expect(await stateOf(EVENT, importedId)).toBe("cancelled");
    expect(await stateOf(USE, u)).toBe("released");

    // A timed move: an event on sale ends after its end, and its crew are done, its rooms freed.
    const ends = at(3, 22);
    const timed = await event("on_sale", ends);
    const t = await crew(timed, 3);
    const r = await create(USE, { name: "Yard", event: timed });
    await runTimedMovesDue(db, { clock: () => new Date(Date.parse(ends) + 60_000) });
    expect(await stateOf(EVENT, timed)).toBe("ended");
    expect(await stateOf(CREW, t.id)).toBe("done");
    expect(await stateOf(USE, r)).toBe("released");
    // Done is still live: the crew's worked time stays theirs, for pay.
    expect(await timeClaims(CREW, [t.id])).toBe(1);
  });

  it("leaves a follower in the Trash where it is, and it does not stop the move", async () => {
    const id = await event();
    const kept = await crew(id);
    const trashed = await crew(id);
    await invoke("record.delete", { object: CREW, id: trashed.id }, as());
    await update(EVENT, id, { state: "cancelled" });
    expect(await stateOf(CREW, kept.id)).toBe("cancelled");
    // Restored, it is as it was put in the Trash: the move never read it.
    await invoke("record.restore", { object: CREW, id: trashed.id }, as());
    expect(await stateOf(CREW, trashed.id)).toBe("open");
  });
});

describe("a follower made under its parent's move (ADR 0841)", () => {
  it("fails the move whole, for a child of the same extension and of another", async () => {
    for (const [object, values] of [
      [CREW, { name: "Late door", role: roleId, startsAt: at(20, 17), endsAt: at(20, 22) }],
      [USE, { name: "Late room" }],
    ] as const) {
      const id = await event();
      const before = await crew(id);
      const values2 =
        object === CREW ? { ...values, staff: (await createUser("member")).id } : values;
      const out = await refused(
        fixtures.invoke(
          "fixture.cwCreateThenCancel",
          { object, values: { ...values2, event: id }, id },
          as(),
        ),
      );
      expect(out.code).toBe("conflict");
      expect(out.details.rule).toBe("recurring_stale");
      // Nothing of it: the event is on sale, its crew still on.
      expect(await stateOf(EVENT, id)).toBe("on_sale");
      expect(await stateOf(CREW, before.id)).toBe("open");
      // Asked again, the move reads every follower and takes them along.
      await update(EVENT, id, { state: "cancelled" });
      expect(await stateOf(CREW, before.id)).toBe("cancelled");
    }
  });
});

describe("a parent move refused whole when a child's claim is refused", () => {
  it("an event put on sale whose set-up's person is on another shift then moves nothing", async () => {
    const id = await event("draft");
    const user = await createUser("member");
    // The person is already on a crew shift of another event at that time.
    const other = await event();
    await create(CREW, {
      name: "Bar",
      event: other,
      role: roleId,
      staff: user.id,
      startsAt: at(20, 16),
      endsAt: at(20, 20),
    });
    const free = await create(SETUP, {
      name: "Chairs",
      event: id,
      kind: kindId,
      staff: (await createUser("member")).id,
      startsAt: at(20, 15),
      endsAt: at(20, 17),
    });
    const clash = await create(SETUP, {
      name: "Stage",
      event: id,
      kind: kindId,
      staff: user.id,
      startsAt: at(20, 15),
      endsAt: at(20, 17),
    });
    const out = await refused(update(EVENT, id, { state: "on_sale" }));
    expect(out).toMatchObject({ code: "conflict", details: { rule: "double_booked" } });
    expect(await stateOf(EVENT, id)).toBe("draft");
    expect(await stateOf(SETUP, free)).toBe("requested");
    expect(await stateOf(SETUP, clash)).toBe("requested");
    expect(await timeClaims(SETUP, [free, clash])).toBe(0);
  });
});

describe("the limit and the batch", () => {
  const batches: number[] = [];
  const counting: CrmDb = {
    query: db.query,
    async batch(statements) {
      batches.push(statements.length);
      return db.batch(statements);
    },
  };

  async function cancelCost(crewCount: number, useCount: number) {
    const id = await event();
    for (let i = 0; i < crewCount; i++) await crew(id);
    for (let i = 0; i < useCount; i++) await create(USE, { name: `Room ${i}`, event: id });
    batches.length = 0;
    await invoke(
      "record.update",
      { object: EVENT, id, values: { state: "cancelled" } },
      as(NOW, { db: counting }),
    );
    return Math.max(...batches);
  }

  it("costs the batch a bounded number of statements a follower, under D1's 1,000 at the limit", async () => {
    const none = await cancelCost(0, 0);
    const crewOnly = await cancelCost(4, 0);
    const usesOnly = await cancelCost(0, 4);
    const perCrew = (crewOnly - none) / 4;
    const perUse = (usesOnly - none) / 4;
    // Measured: a crew shift's move (its row, its history, its search document, its freed time)
    // and a room use's; plus one guard each following object. FOLLOWERS_MAX of the dearer one
    // fits in one invocation with room for the parent's own statements.
    const per = Math.max(perCrew, perUse);
    expect(per).toBeLessThanOrEqual(8);
    expect(none + per * FOLLOWERS_MAX).toBeLessThan(1000);
  });

  it("counts every following object towards one limit", async () => {
    const id = await event();
    // Seed just over the limit across two objects, straight into the tables (a fixture's speed).
    const half = Math.floor(FOLLOWERS_MAX / 2) + 1;
    for (let i = 0; i < half; i++) await create(USE, { name: `R${i}`, event: id });
    for (let i = 0; i < FOLLOWERS_MAX + 1 - half; i++) await crew(id, 21);
    const out = await refused(update(EVENT, id, { state: "cancelled" }));
    expect(out.details.rule).toBe("follows_too_many");
    expect(await stateOf(EVENT, id)).toBe("on_sale");
  }, 120_000);
});
