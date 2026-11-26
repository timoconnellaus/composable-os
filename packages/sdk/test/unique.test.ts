// Declared uniqueness that folds case and outer spaces (stage 59, ADR 0864): what the contract
// checks of `fold`, and the text the host keeps. The host's side (folding on every write, the
// refusal, the restore's words) is shown in apps/runner/test/equipment.test.ts.
import { describe, expect, it } from "vitest";
import { foldUniqueText, validateManifest } from "../src/index.ts";

function pack(rule: Record<string, unknown>) {
  return {
    id: "reg",
    version: "1.0.0",
    contractVersion: 1,
    objects: {
      thing: {
        label: "Thing",
        plural: "Things",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          tag: { type: "text", label: "Tag" },
          bought: { type: "date", label: "Bought" },
        },
        unique: [rule],
      },
    },
  };
}

const issues = (m: unknown) => validateManifest(m).issues.filter((i) => i.path.includes("unique"));

describe("a uniqueness rule that folds case and spaces", () => {
  it("is accepted over text fields", () => {
    expect(issues(pack({ fields: ["tag"], fold: true }))).toEqual([]);
    expect(issues(pack({ fields: ["tag", "name"], fold: true }))).toEqual([]);
  });

  it("is refused over a field that is not text", () => {
    expect(issues(pack({ fields: ["tag", "bought"], fold: true })).map((i) => i.path)).toEqual([
      "objects.thing.unique.0.fold",
    ]);
    expect(issues(pack({ fields: ["tag", "bought"] }))).toEqual([]);
  });

  it("keeps the text trimmed and in upper case", () => {
    expect(foldUniqueText("  tm-03 ")).toBe("TM-03");
    expect(foldUniqueText("Tm-03")).toBe(foldUniqueText("TM-03 "));
    expect(foldUniqueText("ｔｍ-03")).toBe("TM-03");
    expect(foldUniqueText("   ")).toBe("");
  });
});
