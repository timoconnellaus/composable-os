// The review of PR #502: a hold is never re-pointed while its record is guarded (ADR 0863), by
// the declaring extension's own code either; and `location.relocate` moves a whole chain of
// records that agree with one another (room, its classes, their bookings), refused clearly past
// its bound, with the target location held open at commit (ADR 0911).
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  getObject,
  invoke,
  MAIN_LOCATION_ID,
  objectTableOf,
  toOperationError,
} from "../src/index.ts";
import {
  locationOpenGuard,
  RELOCATE_MAX_DEPTH,
  relocationChain,
} from "../src/operations/location.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { auditChanges, context, createUser, unique } from "./helpers.ts";

let admin: ActingUser;
beforeAll(async () => {
  admin = await createUser("admin");
});

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a refusal");
}

describe("a hold (states.holds)", () => {
  const id = extId("hold");
  const NOTE = `${id}.note`;
  const THING = `${id}.thing`;
  const own = () =>
    context(admin, {
      actor: "extension",
      extension: { id, permissions: { read: [], write: [], operations: [], modules: ["ops"] } },
    });

  beforeAll(async () => {
    await reconcile(
      manifest(id, {
        objects: {
          thing: {
            label: "Thing",
            plural: "Things",
            titleField: "name",
            fields: { name: { type: "text", label: "Name", required: true } },
          },
          note: {
            label: "Note",
            plural: "Notes",
            titleField: "text",
            fields: {
              text: { type: "text", label: "Text" },
              thing: { type: "relation", label: "Thing", to: THING, readOnly: true },
              state: {
                type: "select",
                label: "State",
                options: [
                  { value: "open", label: "Open" },
                  { value: "closed", label: "Closed" },
                ],
              },
            },
            states: {
              field: "state",
              initial: "open",
              holds: "thing",
              moves: [{ from: "open", to: "closed", by: ["host"], final: true }],
            },
          },
        },
      }),
    );
  });

  it("is not re-pointed while the note is open, by the extension's own code either", async () => {
    const a = (await invoke(
      "record.create",
      { object: THING, values: { name: "A" } },
      context(admin),
    )) as { id: string };
    const b = (await invoke(
      "record.create",
      { object: THING, values: { name: "B" } },
      context(admin),
    )) as { id: string };
    const note = (await invoke(
      "record.create",
      { object: NOTE, values: { text: "Broken", thing: a.id } },
      own(),
    )) as { id: string };
    const moved = await refusal(
      invoke("record.update", { object: NOTE, id: note.id, values: { thing: b.id } }, own()),
    );
    expect(moved).toMatchObject({ code: "invalid_input", details: { rule: "field_locked" } });
    // Its words are its own code's to change; only the hold is fixed.
    await invoke(
      "record.update",
      { object: NOTE, id: note.id, values: { text: "Very broken" } },
      own(),
    );
    // What it holds stays out of the Trash: only the host leaves "open", so no record write.
    const trashed = await refusal(
      invoke("record.delete", { object: THING, id: a.id }, context(admin)),
    );
    expect(trashed).toMatchObject({ code: "forbidden", details: { reason: "held" } });
    // The admin may read the note: the refusal names it.
    expect(trashed.details?.record).toBe(note.id);
    await invoke("record.delete", { object: THING, id: b.id }, context(admin));
  });
});

describe("location.relocate along a chain", () => {
  const id = extId("chain");
  const ROOM = `${id}.room`;
  const KLASS = `${id}.klass`;
  const BOOKING = `${id}.booking`;
  const where = { type: "relation", label: "Location", to: "location", required: true } as const;
  let harbour: string;

  beforeAll(async () => {
    await reconcile(
      manifest(id, {
        objects: {
          room: {
            label: "Room",
            plural: "Rooms",
            titleField: "name",
            fields: { name: { type: "text", label: "Name", required: true }, location: where },
            located: { field: "location" },
          },
          klass: {
            label: "Class",
            plural: "Classes",
            titleField: "name",
            fields: {
              name: { type: "text", label: "Name" },
              room: { type: "relation", label: "Room", to: ROOM },
              location: where,
            },
            located: { field: "location" },
            agree: [{ a: "location", b: "room.location" }],
          },
          booking: {
            label: "Booking",
            plural: "Bookings",
            titleField: "name",
            fields: {
              name: { type: "text", label: "Name" },
              klass: { type: "relation", label: "Class", to: KLASS },
              location: where,
            },
            located: { field: "location" },
            agree: [{ a: "location", b: "klass.location" }],
          },
        },
      }),
    );
    harbour = (
      (await invoke(
        "location.create",
        { name: unique("Harbour "), timezone: "Europe/London" },
        context(admin),
      )) as { id: string }
    ).id;
  });

  it("follows the room to its classes and their bookings, every level", () => {
    const chain = relocationChain(getObject(ROOM) as NonNullable<ReturnType<typeof getObject>>);
    expect(chain.map((c) => [c.user.name, c.depth])).toEqual([
      [KLASS, 1],
      [BOOKING, 2],
    ]);
    expect(RELOCATE_MAX_DEPTH).toBe(3);
  });

  it("moves the room, its classes and their bookings in one change, and names them", async () => {
    const ctx = context(admin);
    const make = async (object: string, values: Record<string, unknown>) =>
      ((await invoke("record.create", { object, values }, ctx)) as { id: string }).id;
    const room = await make(ROOM, { name: "Studio", location: MAIN_LOCATION_ID });
    const klass = await make(KLASS, { name: "Yoga", room, location: MAIN_LOCATION_ID });
    const booking = await make(BOOKING, { name: "Ann", klass, location: MAIN_LOCATION_ID });
    const result = await invoke(
      "location.relocate",
      { object: ROOM, id: room, location: harbour },
      ctx,
    );
    expect(result).toMatchObject({
      moved: [
        { object: KLASS, count: 1 },
        { object: BOOKING, count: 1 },
      ],
    });
    const at = async (object: string, rid: string, field: string) => {
      const column = getObject(object)?.fields.find((f) => f.name === field)?.column as string;
      return (
        await env.DB.prepare(`SELECT ${column} AS v FROM ${objectTableOf(object)} WHERE id = ?`)
          .bind(rid)
          .first<{ v: string }>()
      )?.v;
    };
    expect(await at(ROOM, room, "location")).toBe(harbour);
    expect(await at(KLASS, klass, "location")).toBe(harbour);
    expect(await at(KLASS, klass, "room")).toBe(room);
    expect(await at(BOOKING, booking, "location")).toBe(harbour);
    expect(await at(BOOKING, booking, "klass")).toBe(klass);
    // One history entry, on the room, naming what moved with it.
    const change = (await auditChanges(room)).at(-1);
    expect(change?.operation).toBe("location.relocate");
    expect(JSON.stringify(change?.diff)).toContain(booking);
  });

  it("a location closed meanwhile fails the batch as a conflict", async () => {
    const closed = (
      (await invoke(
        "location.create",
        { name: unique("Old "), timezone: "Europe/London" },
        context(admin),
      )) as { id: string }
    ).id;
    await invoke("location.close", { id: closed }, context(admin));
    const guard = locationOpenGuard(closed);
    const error = await env.DB.prepare(guard.sql)
      .bind(...guard.parameters)
      .run()
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(toOperationError(error)).toMatchObject({
      code: "conflict",
      details: { reason: "closed_meanwhile" },
    });
    // An open one passes.
    const open = locationOpenGuard(harbour);
    await env.DB.prepare(open.sql)
      .bind(...open.parameters)
      .run();
  });
});
