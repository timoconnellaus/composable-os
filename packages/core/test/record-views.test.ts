// A database's views made again from the host's own definitions (stage 66 step 7, review of #526
// N3): what an import runs, since no view's text is taken from an export.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { rebuildRecordViews } from "../src/extensions/record-views.ts";

const views = async () =>
  (
    await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'view' ORDER BY name",
    ).all<{
      name: string;
      sql: string;
    }>()
  ).results;

describe("rebuildRecordViews", () => {
  it("drops every view, makes the core ones given, then every record view from the extensions' state", async () => {
    const before = await views();
    const person = before.find((v) => v.name === "rec_person");
    expect(person).toBeTruthy();
    // The host's own definitions, as an import takes them from its migrations.
    const coreViews = before;
    // An imported database's own views: a replaced record view, and two of its own.
    await env.DB.batch([
      env.DB.prepare("DROP VIEW rec_person"),
      env.DB.prepare("CREATE VIEW rec_person AS SELECT 'replaced' AS id"),
      env.DB.prepare("CREATE VIEW rec_other AS SELECT * FROM core_settings"),
      env.DB.prepare("CREATE VIEW x_v AS SELECT * FROM core_settings"),
    ]);
    const made = await rebuildRecordViews(env.DB, coreViews);
    const after = await views();
    expect(after.map((v) => v.name)).not.toContain("rec_other");
    expect(after.map((v) => v.name)).not.toContain("x_v");
    expect(after.find((v) => v.name === "rec_person")?.sql).not.toContain("replaced");
    // The same views as the host made in the first place.
    expect(after.map((v) => v.name)).toEqual(before.map((v) => v.name));
    expect(made.views).toBe(before.length);
  });
});
