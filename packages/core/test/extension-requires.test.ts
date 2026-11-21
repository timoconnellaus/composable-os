// Stage 42 (ADR 0478): an extension that requires another is refused while that one is not
// installed and on, and a runtime extension (written in the app) may not call another extension's
// tool, whose code runs with that extension's own permissions.
import { describe, expect, it } from "vitest";
import { checkManifest } from "../src/extensions/install.ts";
import { manifest } from "./extension-helpers.ts";
import { db } from "./helpers.ts";

const thing = {
  label: "Thing",
  plural: "Things",
  titleField: "name",
  fields: { name: { type: "text", label: "Name", required: true } },
};

describe("requires (ADR 0478)", () => {
  it("names a required extension that is not installed, first; counts one the check installed", async () => {
    const m = manifest("needy", { requires: ["absentpack"], objects: { thing } } as never);
    const missing = await checkManifest(db.query, "needy", m, new Date().toISOString());
    expect(missing.issues[0]).toMatchObject({
      path: "requires.0",
      message: "This extension requires the absentpack extension, which is not installed and on here",
    });
    const present = await checkManifest(db.query, "needy", m, new Date().toISOString(), {
      installed: ["absentpack"],
    });
    expect(present.issues.map((i) => i.path)).not.toContain("requires.0");
  });
});

describe("a runtime extension calling another extension's tool (ADR 0478)", () => {
  it("is refused at its check; a shipped one may declare it", async () => {
    const m = manifest("caller", {
      permissions: { read: [], write: [], operations: ["x.programs.assign"], modules: ["ops"] },
      objects: { thing },
    } as never);
    const runtime = await checkManifest(db.query, "caller", m, new Date().toISOString(), {
      source: "runtime",
    });
    expect(runtime.issues).toContainEqual(
      expect.objectContaining({
        path: "permissions.operations.0",
        code: "outside_audience",
      }),
    );
    const shipped = await checkManifest(db.query, "caller", m, new Date().toISOString(), {
      source: "shipped",
    });
    expect(shipped.issues.map((i) => i.path)).not.toContain("permissions.operations.0");
  });
});
