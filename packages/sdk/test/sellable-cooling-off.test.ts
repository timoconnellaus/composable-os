// `sellable.recurring.coolingOff` (stage 44 step 7, decision 11, ADR 0647): the plan's pack names a
// number setting of its own that holds the cooling-off days. It must be a person's to change, off
// until one sets it, and bounded.
import { describe, expect, it } from "vitest";
import { MAX_COOLING_OFF_DAYS, validateManifest } from "../src/index.ts";

function gym(setting: Record<string, unknown> | undefined, name = "coolingOffDays") {
  return {
    id: "gym",
    version: "1.0.0",
    contractVersion: 1,
    permissions: {},
    ...(setting ? { settings: { coolingOffDays: setting } } : {}),
    objects: {
      plan: {
        label: "Plan",
        plural: "Plans",
        titleField: "title",
        fields: {
          title: { type: "text", label: "Title", required: true },
          price: { type: "currency", label: "Price", currency: "AUD" },
        },
        sellable: {
          price: "price",
          recurring: { interval: "month", coolingOff: { setting: name } },
        },
      },
    },
  };
}

const good = {
  type: "number",
  label: "Cooling-off period (days)",
  default: 0,
  min: 0,
  max: 30,
  personApproves: true,
};

const issues = (setting: Record<string, unknown> | undefined, name?: string) =>
  validateManifest(gym(setting, name)).issues.map((i) => `${i.path}: ${i.message}`);

describe("sellable.recurring.coolingOff", () => {
  it("accepts a bounded number setting a person approves, off by default", () => {
    expect(issues(good)).toEqual([]);
    const { default: _none, ...noDefault } = good;
    expect(issues(noDefault)).toEqual([]);
  });

  it("refuses a setting that is missing, not a number, an AI's to change, unbounded or on by default", () => {
    const at = "objects.plan.sellable.recurring.coolingOff.setting";
    expect(issues(undefined)).toEqual([`${at}: "coolingOffDays" must be a number setting of gym`]);
    expect(issues({ ...good, type: "text", default: "0" })).toEqual([
      `${at}: "coolingOffDays" must be a number setting of gym`,
    ]);
    expect(issues({ ...good, personApproves: false })).toEqual([
      `${at}: "coolingOffDays" must be a setting a person approves (personApproves): the cooling-off days are never an AI's to change`,
    ]);
    const bounds = `${at}: "coolingOffDays" must be bounded from 0 to at most ${MAX_COOLING_OFF_DAYS} days, and off (0 or no default) until a person sets it`;
    expect(issues({ ...good, max: MAX_COOLING_OFF_DAYS + 1 })).toEqual([bounds]);
    const { max: _max, ...noMax } = good;
    expect(issues(noMax)).toEqual([bounds]);
    expect(issues({ ...good, min: -1 })).toEqual([bounds]);
    expect(issues({ ...good, default: 14 })).toEqual([bounds]);
  });
});
