// Which AI calls are roster changes, for who may approve them (issue #285, ADR 0626): a restore
// from the Trash of a shift or series with someone on it, and a published version copied back into
// a record whose content carries who works it. On a fixture of a staffed object that is also
// publishable (no shipped pack has one), and one that is not.
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invoke } from "../src/index.ts";
import { rosterChangeCall, touchesRoster } from "../src/staffing/approvals.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db } from "./helpers.ts";

const ext = extId("rsap");
const SHIFT = `${ext}.shift`;
const NOTE = `${ext}.note`;

const fixture = manifest(ext, {
  objects: {
    kind: {
      label: "Kind",
      plural: "Kinds",
      titleField: "name",
      fields: { name: { type: "text", label: "Name", required: true } },
    },
    shift: {
      label: "Shift",
      plural: "Shifts",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        kind: { type: "relation", label: "Kind", to: `${ext}.kind` },
        staff: { type: "user", label: "Staff" },
        startsAt: { type: "datetime", label: "Starts at" },
        endsAt: { type: "datetime", label: "Ends at" },
        state: {
          type: "select",
          label: "State",
          options: [
            { value: "scheduled", label: "Scheduled" },
            { value: "cancelled", label: "Cancelled" },
          ],
        },
      },
      states: {
        field: "state",
        initial: "scheduled",
        moves: [{ from: "scheduled", to: "cancelled", by: ["staff"] }],
      },
      staffed: {
        who: { field: "staff" },
        starts: "startsAt",
        ends: "endsAt",
        kind: "kind",
        live: ["scheduled"],
      },
      publishable: { content: ["name", "staff"] },
    },
    note: {
      label: "Note",
      plural: "Notes",
      titleField: "name",
      fields: { name: { type: "text", label: "Name" } },
      publishable: { content: ["name"] },
    },
  },
});

const NOW = "2026-05-31T00:00:00.000Z";
let admin: ActingUser;
const as = () => context(admin, { clock: () => new Date(NOW) });
const shift = async (staff: string | null) =>
  (
    await invoke(
      "record.create",
      {
        object: SHIFT,
        values: {
          name: "Open",
          startsAt: "2026-06-02T09:00:00.000Z",
          endsAt: "2026-06-02T10:00:00.000Z",
          ...(staff ? { staff } : {}),
        },
      },
      as(),
    )
  ).id as string;

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(fixture, NOW);
}, 60_000);

describe("an AI's restore is a roster change when it brings back who works a shift (issue #285)", () => {
  it("record.restore of a shift in the Trash with its person; not one with nobody on it", async () => {
    const worker = await createUser("member");
    const named = await shift(worker.id);
    const empty = await shift(null);
    for (const id of [named, empty]) {
      await invoke("record.delete", { object: SHIFT, id }, as());
    }
    expect(
      await rosterChangeCall(db.query, "record.restore", { object: SHIFT, id: named }, NOW),
    ).toBe(true);
    expect(
      await rosterChangeCall(db.query, "record.restore", { object: SHIFT, id: empty }, NOW),
    ).toBe(false);
    expect(
      await rosterChangeCall(db.query, "record.restore", { object: SHIFT, id: "nope" }, NOW),
    ).toBe(false);
  });

  it("record.restoreVersion of an object whose content carries who works it; not another's", () => {
    expect(touchesRoster("record.restoreVersion", { object: SHIFT, id: "x", version: 1 })).toBe(
      true,
    );
    expect(touchesRoster("record.restoreVersion", { object: NOTE, id: "x", version: 1 })).toBe(
      false,
    );
  });
});

describe("an AI's update is a roster change when it moves a shift that has started (ADR 0627)", () => {
  it("only when a time changes: not when it sends the end the shift already has", async () => {
    const id = await shift(null);
    const during = "2026-06-02T09:30:00.000Z";
    const update = (values: Record<string, unknown>) =>
      rosterChangeCall(db.query, "record.update", { object: SHIFT, id, values }, during);
    expect(await update({ name: "Renamed", endsAt: "2026-06-02T10:00:00.000Z" })).toBe(false);
    expect(await update({ endsAt: "2026-06-02T11:00:00.000Z" })).toBe(true);
    expect(await update({ startsAt: "2026-06-02T09:15:00.000Z" })).toBe(true);
  });
});
