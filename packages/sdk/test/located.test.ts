// `located` and `agree` (stage 64 step 2, ADR 0911): what the contract checks. A located field is
// a required relation to one location; a path is a required relation to another of the pack's
// objects and its relation to one location; an object is located once; each agree side reaches a
// location, and its two sides are two paths.
import { describe, expect, it } from "vitest";
import { validateManifest } from "../src/index.ts";

type Obj = Record<string, unknown>;
const where = { type: "relation", label: "Location", to: "location", required: true };

function pack(room: Obj = {}, klass: Obj = {}, booking: Obj = {}) {
  return {
    id: "loc",
    version: "1.0.0",
    contractVersion: 1,
    objects: {
      room: {
        label: "Room",
        plural: "Rooms",
        titleField: "name",
        fields: { name: { type: "text", label: "Name", required: true }, location: where },
        located: { field: "location" },
        ...room,
      },
      klass: {
        label: "Class",
        plural: "Classes",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          room: { type: "relation", label: "Room", to: "loc.room" },
          location: where,
        },
        located: { field: "location" },
        agree: [{ a: "location", b: "room.location" }],
        ...klass,
      },
      booking: {
        label: "Booking",
        plural: "Bookings",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          klass: { type: "relation", label: "Class", to: "loc.klass", required: true },
        },
        located: { path: "klass.location" },
        ...booking,
      },
    },
  };
}

const paths = (m: unknown) => validateManifest(m).issues.map((i) => i.path);

describe("located", () => {
  it("passes for a field, a path and an agree rule", () => {
    expect(validateManifest(pack()).issues).toEqual([]);
  });

  it("refuses a field that is not a required relation to one location", () => {
    expect(paths(pack({ located: { field: "name" } }))).toContain("objects.room.located.field");
    expect(
      paths(
        pack({
          fields: {
            name: { type: "text", label: "Name" },
            location: { ...where, required: false },
          },
        }),
      ),
    ).toContain("objects.room.located.field");
    expect(
      paths(
        pack({
          fields: { name: { type: "text", label: "Name" }, location: { ...where, many: true } },
        }),
      ),
    ).toContain("objects.room.located.field");
    expect(
      paths(
        pack({
          fields: {
            name: { type: "text", label: "Name" },
            location: { type: "relation", label: "Where", to: "person", required: true },
          },
        }),
      ),
    ).toContain("objects.room.located.field");
  });

  it("refuses a path that does not end at a location, or whose relation is not required", () => {
    expect(paths(pack({}, {}, { located: { path: "klass.name" } }))).toContain(
      "objects.booking.located.path",
    );
    expect(paths(pack({}, {}, { located: { path: "klass" } }))).toContain(
      "objects.booking.located.path",
    );
    expect(paths(pack({}, {}, { located: { path: "klass.room.location" } }))).toContain(
      "objects.booking.located.path",
    );
    const optional = pack(
      {},
      {},
      {
        fields: {
          name: { type: "text", label: "Name" },
          klass: { type: "relation", label: "Class", to: "loc.klass" },
        },
      },
    );
    expect(paths(optional)).toContain("objects.booking.located.path");
  });

  it("refuses two declarations on one object, and none", () => {
    expect(paths(pack({}, { located: { field: "location", path: "room.location" } }))).toContain(
      "objects.klass.located",
    );
    expect(paths(pack({ located: {} }))).toContain("objects.room.located");
  });
});

describe("agree", () => {
  it("refuses a side that does not reach a location", () => {
    expect(paths(pack({}, { agree: [{ a: "location", b: "room.name" }] }))).toContain(
      "objects.klass.agree.0.b",
    );
    expect(paths(pack({}, { agree: [{ a: "name", b: "room.location" }] }))).toContain(
      "objects.klass.agree.0.a",
    );
  });

  it("refuses a rule whose two sides are one path", () => {
    expect(paths(pack({}, { agree: [{ a: "location", b: "location" }] }))).toContain(
      "objects.klass.agree.0",
    );
  });
});
