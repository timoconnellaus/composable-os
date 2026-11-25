// A holder's conditions read a fixed word (`value`), and an empty holder field may allow nothing
// (`empty: "none"`); a spender copies a related record's own id (`<relation>.id`). Stage 49 step 5,
// ADR 0764: a class pass never pays for an appointment, and a pass names the services it covers.
import { describe, expect, it } from "vitest";
import { validateManifest } from "../src/index.ts";

type Condition = Record<string, unknown>;

function gym(when: Condition[], copy: Record<string, string> = { serviceId: "service.id" }) {
  return {
    id: "gym",
    version: "1.0.0",
    contractVersion: 1,
    permissions: {},
    objects: {
      service: {
        label: "Service",
        plural: "Services",
        titleField: "name",
        fields: { name: { type: "text", label: "Name", required: true } },
      },
      session: {
        label: "Session",
        plural: "Sessions",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          person: { type: "relation", label: "Person", to: "person" },
          service: { type: "relation", label: "Service", to: "gym.service" },
          serviceId: { type: "text", label: "Service id", readOnly: true },
          holder: { type: "text", label: "Paid by" },
          state: {
            type: "select",
            label: "State",
            options: ["booked", "cancelled"].map((value) => ({ value, label: value })),
          },
        },
        states: {
          field: "state",
          initial: "booked",
          moves: [{ from: "booked", to: "cancelled", by: ["staff"], final: true }],
        },
        allowance: {
          spends: {
            person: "person",
            holder: "holder",
            spendIn: ["booked"],
            returnIn: ["cancelled"],
            copy,
          },
        },
      },
      pass: {
        label: "Pass",
        plural: "Passes",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          person: { type: "relation", label: "Person", to: "person", readOnly: true },
          uses: { type: "number", label: "Uses", readOnly: true },
          covers: {
            type: "multiSelect",
            label: "Covers",
            readOnly: true,
            options: [{ value: "sessions", label: "Sessions" }],
          },
          services: {
            type: "relation",
            label: "Services",
            to: "gym.service",
            many: true,
            readOnly: true,
          },
        },
        allowance: {
          holds: {
            person: "person",
            uses: "uses",
            per: "total",
            spendsOn: { object: "session", when },
          },
        },
      },
    },
  };
}

const issues = (when: Condition[], copy?: Record<string, string>) =>
  validateManifest(gym(when, copy))
    .issues.filter((i) => i.path.includes("allowance"))
    .map((i) => i.message);

describe("allowance conditions (ADR 0764)", () => {
  it("accepts a fixed word, an empty that allows nothing, and a copied related id", () => {
    expect(
      issues([
        { value: "sessions", in: "covers", empty: "none" },
        { field: "serviceId", in: "services" },
      ]),
    ).toEqual([]);
  });

  it("refuses a condition reading both or neither, a fixed word or empty without in", () => {
    expect(issues([{ field: "serviceId", value: "sessions", in: "covers" }])).toContain(
      "A condition reads exactly one of field and value",
    );
    expect(issues([{ in: "covers" }])).toContain(
      "A condition reads exactly one of field and value",
    );
    expect(issues([{ value: "sessions", atLeast: 1 }])).toContain(
      "A fixed value is compared with in",
    );
    expect(issues([{ field: "serviceId", atLeast: 1, empty: "none" }])).toContain(
      "empty says what an empty in allows: it needs in",
    );
  });

  it("still refuses a condition on a field no host fills", () => {
    expect(issues([{ field: "name", in: "services" }])).toContain(
      '"name" must be a field session\'s host fills (its copy or local), so no caller sets what pays for it',
    );
  });

  it("refuses a copy of a field the related object does not have", () => {
    expect(issues([], { serviceId: "service.code" })).toContain('"code" is not a field of service');
  });
});
