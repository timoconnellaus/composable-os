// Two cases the isolation suite does not reach.
//
// 1. `customerVia` beside `signedIn` on one object (ADR 0439 with ADR 0447): a class every
//    signed-in member reads (its name and level), and the room of a class a member holds a pass
//    for. A member reads the room of their own class only; the public reads nothing.
// 2. A `timezone` field added to an object that already has records (ADR 0460): the reconciler
//    fills it with the deployment's zone, and a record that somehow has none still takes an
//    unrelated edit.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, type CustomerPrincipal, invoke } from "../src/index.ts";
import { call, outside, PUBLIC } from "./customer-fixtures.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, unique } from "./helpers.ts";

let admin: ActingUser;

async function create(object: string, values: Record<string, unknown>) {
  return (await invoke("record.create", { object, values }, context(admin))).id;
}

async function member(label: string): Promise<CustomerPrincipal> {
  const person = await invoke(
    "person.create",
    { givenName: label, familyName: unique("Member") },
    context(admin),
  );
  return { kind: "customer", customerId: `cus_${unique(label)}`, personId: person.id };
}

const items = (outcome: Awaited<ReturnType<typeof call>>) =>
  outcome.ok
    ? (outcome.value as { items: { id: string; values: Record<string, unknown> }[] }).items
    : [];

beforeAll(async () => {
  admin = await createUser("admin");
});

describe("customerVia beside signedIn", () => {
  const EXT = extId("club");
  const KLASS = `${EXT}.klass`;
  const PASS = `${EXT}.pass`;
  let a: CustomerPrincipal;
  let b: CustomerPrincipal;
  let mine: string;
  let other: string;

  beforeAll(async () => {
    await reconcile(
      manifest(EXT, {
        objects: {
          klass: {
            label: "Class",
            plural: "Classes",
            titleField: "name",
            fields: {
              name: { type: "text", label: "Name", required: true },
              level: { type: "text", label: "Level" },
              room: { type: "text", label: "Room" },
              coachNote: { type: "text", label: "Coach's note" },
            },
            // Every signed-in member reads a class's name and level...
            signedIn: { read: ["name", "level"] },
            // ...and a pass holder its room too.
            customerVia: { from: `${EXT}.pass`, field: "klass", read: ["name", "room"] },
          },
          pass: {
            label: "Pass",
            plural: "Passes",
            titleField: "code",
            fields: {
              code: { type: "text", label: "Code", required: true },
              holder: { type: "relation", label: "Holder", to: "person" },
              klass: { type: "relation", label: "Class", to: `${EXT}.klass` },
            },
            customer: { field: "holder", read: ["code", "klass"], write: [] },
          },
        },
      } as never),
    );
    a = await member("A");
    b = await member("B");
    mine = await create(KLASS, {
      name: "Handstands",
      level: "2",
      room: "Room-A-only",
      coachNote: "Secret-note-1",
    });
    other = await create(KLASS, {
      name: "Mobility",
      level: "1",
      room: "Room-nobody",
      coachNote: "Secret-note-2",
    });
    await create(PASS, { code: unique("pass"), holder: a.personId, klass: mine });
  });

  it("a member reads every class's shared fields, and the room of the class they hold a pass for", async () => {
    const seen = items(await call("fixture.myList", { object: KLASS, limit: 50 }, outside(a)));
    const byId = Object.fromEntries(seen.map((item) => [item.id, item.values]));
    expect(byId[mine]).toEqual({ name: "Handstands", level: "2", room: "Room-A-only" });
    // Shared with every member, but not theirs through a pass: no room.
    expect(byId[other]).toEqual({ name: "Mobility", level: "1", room: null });
    const text = JSON.stringify(seen);
    expect(text).not.toContain("Secret-note");
    expect(text).not.toContain("coachNote");
  });

  it("another member reads the shared fields only, and cannot find the room by filtering", async () => {
    const seen = items(await call("fixture.myList", { object: KLASS, limit: 50 }, outside(b)));
    expect(JSON.stringify(seen)).not.toContain("Room-");
    expect(seen.find((item) => item.id === mine)?.values).toEqual({
      name: "Handstands",
      level: "2",
      room: null,
    });
    const probe = await call(
      "fixture.myList",
      { object: KLASS, filter: { field: "room", op: "eq", value: "Room-A-only" } },
      outside(b),
    );
    expect(items(probe)).toEqual([]);
  });

  it("the public reads none of it", async () => {
    const peek = await call("fixture.publicPeek", { object: KLASS }, outside(PUBLIC));
    expect(peek).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});

describe("a time zone added to records that already exist (ADR 0460)", () => {
  it("is filled with the deployment's zone, and a record without one still takes an unrelated edit", async () => {
    const EXT = extId("tz");
    const TRIP = `${EXT}.trip`;
    const fields = {
      name: { type: "text", label: "Name", required: true },
      notes: { type: "text", label: "Notes" },
    };
    await reconcile(
      manifest(EXT, {
        objects: { trip: { label: "Trip", plural: "Trips", titleField: "name", fields } },
      } as never),
    );
    const before = await create(TRIP, { name: "Before zones" });
    const prior = await invoke("settings.get", {}, context(admin));
    await invoke("settings.update", { timezone: "Australia/Sydney" }, context(admin));
    try {
      await reconcile(
        manifest(EXT, {
          version: "1.0.1",
          objects: {
            trip: {
              label: "Trip",
              plural: "Trips",
              titleField: "name",
              fields: {
                ...fields,
                timezone: { type: "timezone", label: "Time zone", required: true },
              },
            },
          },
        } as never),
      );
      // The record that existed is in the deployment's zone, as a new one would be.
      const read = await invoke("record.get", { object: TRIP, id: before }, context(admin));
      expect(read.values.timezone).toBe("Australia/Sydney");
      const fresh = await create(TRIP, { name: "After zones" });
      expect(
        (await invoke("record.get", { object: TRIP, id: fresh }, context(admin))).values.timezone,
      ).toBe("Australia/Sydney");

      // Even a record left with none (written past the record code) takes an edit of another
      // field: a required field is checked when it is set, not on every save.
      const table = (await env.DB.prepare(
        "SELECT table_name, column_name FROM core_extension_fields WHERE extension_id = ? AND local_name = 'timezone'",
      )
        .bind(EXT)
        .first<{ table_name: string; column_name: string }>()) ?? {
        table_name: "",
        column_name: "",
      };
      await env.DB.prepare(
        `UPDATE ${table.table_name} SET "${table.column_name}" = NULL WHERE id = ?`,
      )
        .bind(before)
        .run();
      await invoke(
        "record.update",
        { object: TRIP, id: before, values: { notes: "edited" } },
        context(admin),
      );
      expect(
        (await invoke("record.get", { object: TRIP, id: before }, context(admin))).values.notes,
      ).toBe("edited");
      // Clearing it is refused, and so is a name that is not a zone.
      for (const timezone of [null, "Mars/Olympus"]) {
        await expect(
          invoke(
            "record.update",
            { object: TRIP, id: before, values: { timezone } },
            context(admin),
          ),
        ).rejects.toMatchObject({ code: "invalid_input" });
      }
    } finally {
      await invoke("settings.update", { timezone: prior.timezone }, context(admin));
    }
  });
});
