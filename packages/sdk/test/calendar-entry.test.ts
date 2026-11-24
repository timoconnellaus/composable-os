// `calendarEntry` (stage 62 step 1, ADR 0891): what the contract checks of a declaration inside one
// pack. The object declares a customer; the states field and each path's first field are in its
// customer's read list; a field one relation or more away is one the customer reads of that
// object (public, signedIn, or one relation away its customerVia from this object); starts and
// ends end at a datetime, title and place at text; at most two relations deep. A path into another
// pack's object is the host's check (core's checkManifest), and that only a shipped pack declares
// one is the host's too.
import { describe, expect, it } from "vitest";
import { defineExtension, toManifest, validateManifest } from "../src/index.ts";

type Obj = Record<string, unknown>;

function pack(booking: Obj = {}, entry: Obj = {}, more: Record<string, Obj> = {}) {
  return {
    id: "cal",
    version: "1.0.0",
    contractVersion: 1,
    objects: {
      kind: {
        label: "Class type",
        plural: "Class types",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          secret: { type: "text", label: "Staff only" },
        },
        public: { read: ["name"] },
      },
      room: {
        label: "Room",
        plural: "Rooms",
        titleField: "name",
        fields: { name: { type: "text", label: "Name", required: true } },
        public: { read: ["name"] },
      },
      klass: {
        label: "Class",
        plural: "Classes",
        titleField: "title",
        fields: {
          title: { type: "text", label: "Title" },
          kind: { type: "relation", label: "Class type", to: "cal.kind" },
          room: { type: "relation", label: "Room", to: "cal.room" },
          startsAt: { type: "datetime", label: "Starts at" },
          endsAt: { type: "datetime", label: "Ends at" },
          notes: { type: "longText", label: "Notes" },
        },
        customerVia: {
          from: "cal.booking",
          field: "klass",
          read: ["title", "kind", "room", "startsAt", "endsAt"],
        },
      },
      booking: {
        label: "Booking",
        plural: "Bookings",
        titleField: "title",
        fields: {
          title: { type: "text", label: "Title" },
          klass: { type: "relation", label: "Class", to: "cal.klass" },
          person: { type: "relation", label: "Person", to: "person" },
          kind: { type: "relation", label: "Class type", to: "cal.kind" },
          when: { type: "datetime", label: "When" },
          state: {
            type: "select",
            label: "State",
            options: [
              { value: "booked", label: "Booked" },
              { value: "cancelled", label: "Cancelled" },
            ],
          },
        },
        states: {
          field: "state",
          initial: "booked",
          moves: [{ from: "booked", to: "cancelled", by: ["staff"] }],
        },
        customer: { field: "person", read: ["person", "klass", "kind", "state"], write: [] },
        calendarEntry: {
          starts: "klass.startsAt",
          ends: "klass.endsAt",
          title: "kind.name",
          place: "klass.room.name",
          live: ["booked"],
          ...entry,
        },
        ...booking,
      },
      ...more,
    },
  };
}

const issues = (m: unknown, knownObjects: string[] = []) =>
  validateManifest(m, { knownObjects }).issues.filter((i) => i.path.includes("calendarEntry"));

describe("calendarEntry in one pack", () => {
  it("passes for a booking whose class, class type and room the customer reads", () => {
    expect(issues(pack())).toEqual([]);
  });

  it("needs a customer", () => {
    expect(issues(pack({ customer: undefined })).map((i) => i.path)).toEqual([
      "objects.booking.calendarEntry",
    ]);
  });

  it("needs its states, which the customer reads", () => {
    expect(issues(pack({}, { live: ["booked", "gone"] })).map((i) => i.message)).toEqual([
      '"gone" is not a state of booking',
    ]);
    const unread = pack({
      customer: { field: "person", read: ["person", "klass", "kind"], write: [] },
    });
    expect(issues(unread).map((i) => i.path)).toEqual(["objects.booking.calendarEntry.live"]);
  });

  it("a first field the customer's read list does not hold fails", () => {
    expect(issues(pack({}, { starts: "when", ends: "klass.endsAt" })).map((i) => i.path)).toEqual([
      "objects.booking.calendarEntry.starts",
    ]);
  });

  it("a field further away that the customer does not read fails", () => {
    // The class's notes are not in its customerVia; the class type's secret is not public.
    const notes = issues(pack({}, { title: "klass.notes" }));
    expect(notes.map((i) => i.path)).toEqual(["objects.booking.calendarEntry.title"]);
    expect(notes[0]?.message).toContain("not a field a customer reads");
    expect(issues(pack({}, { title: "kind.secret" })).map((i) => i.path)).toEqual([
      "objects.booking.calendarEntry.title",
    ]);
    // Two relations away, only what the room makes public counts (no customerVia reaches there).
    expect(issues(pack({}, { place: "klass.kind.name" }))).toEqual([]);
  });

  it("ends at the right kind of field", () => {
    expect(issues(pack({}, { starts: "klass.title" })).map((i) => i.message)).toEqual([
      '"klass.title" must end at a datetime field',
    ]);
    expect(issues(pack({}, { title: "klass.startsAt" })).map((i) => i.message)).toEqual([
      '"klass.startsAt" must end at a text or select field',
    ]);
    expect(issues(pack({}, { title: "klass" })).map((i) => i.path)).toEqual([
      "objects.booking.calendarEntry.title",
    ]);
  });

  it("at most two relations deep, through relations only", () => {
    expect(issues(pack({}, { place: "klass.room.name.x" })).map((i) => i.path)).toEqual([
      "objects.booking.calendarEntry.place",
    ]);
    expect(issues(pack({}, { place: "state.name" })).map((i) => i.message)).toEqual([
      '"state" must be a relation to one record to reach "name"',
    ]);
  });

  it("never through another object with a customer of its own", () => {
    const m = pack(
      {
        fields: {
          ...(pack().objects.booking.fields as Obj),
          pass: { type: "relation", label: "Pass", to: "cal.pass" },
        },
        customer: {
          field: "person",
          read: ["person", "klass", "kind", "state", "pass"],
          write: [],
        },
      },
      { place: "pass.name" },
      {
        pass: {
          label: "Pass",
          plural: "Passes",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name" },
            person: { type: "relation", label: "Person", to: "person" },
          },
          customer: { field: "person", read: ["name"], write: [] },
        },
      },
    );
    expect(issues(m).map((i) => i.message)).toEqual([
      "cal.pass declares a customer of its own: a path cannot pass through it",
    ]);
  });

  it("leaves a path into another pack's object to the host", () => {
    const m = pack({
      fields: {
        ...(pack().objects.booking.fields as Obj),
        kind: { type: "relation", label: "Class type", to: "other.kind" },
      },
    });
    expect(issues(m, ["other.kind"])).toEqual([]);
  });

  it("is written in defineExtension and kept in the manifest", () => {
    const m = pack();
    const ext = defineExtension({
      ...m,
      objects: m.objects as never,
    } as Parameters<typeof defineExtension>[0]);
    expect(toManifest(ext).objects.booking?.calendarEntry).toEqual({
      starts: "klass.startsAt",
      ends: "klass.endsAt",
      title: "kind.name",
      place: "klass.room.name",
      live: ["booked"],
    });
  });
});
