// `allowance.spends.released` (stage 44 step 7, ADR 0647): the return state the host moves a record
// into when the holder it spent from ends by its payer's cooling off. It must be a return state,
// with a host move into it from each spend state.
import { describe, expect, it } from "vitest";
import { validateManifest } from "../src/index.ts";

function gym(released: string, hostFrom: string[]) {
  return {
    id: "gym",
    version: "1.0.0",
    contractVersion: 1,
    permissions: {},
    objects: {
      visit: {
        label: "Visit",
        plural: "Visits",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          person: { type: "relation", label: "Person", to: "person" },
          holder: { type: "text", label: "Paid by" },
          state: {
            type: "select",
            label: "State",
            options: ["booked", "cancelled", "cancelled_by_us"].map((value) => ({
              value,
              label: value,
            })),
          },
        },
        states: {
          field: "state",
          initial: "booked",
          moves: [
            { from: "booked", to: "cancelled", by: ["staff"], final: true },
            ...(hostFrom.length
              ? [{ from: hostFrom, to: "cancelled_by_us", by: ["host"], final: true }]
              : []),
          ],
        },
        allowance: {
          spends: {
            person: "person",
            holder: "holder",
            spendIn: ["booked"],
            returnIn: ["cancelled", "cancelled_by_us"],
            released,
          },
        },
      },
    },
  };
}

const issues = (released: string, hostFrom: string[]) =>
  validateManifest(gym(released, hostFrom))
    .issues.filter((i) => i.path.endsWith(".released"))
    .map((i) => i.message);

describe("allowance.spends.released", () => {
  it("accepts a return state the host moves into from each spend state", () => {
    expect(issues("cancelled_by_us", ["booked"])).toEqual([]);
  });

  it("refuses a state that is not a return state, or one the host cannot move into", () => {
    expect(issues("booked", ["booked"])).toEqual([
      '"booked" must be one of returnIn: a released record gives its use back',
    ]);
    expect(issues("cancelled", [])).toEqual([
      'A move from "booked" into "cancelled" by the host must be declared: the host releases it',
    ]);
  });
});
