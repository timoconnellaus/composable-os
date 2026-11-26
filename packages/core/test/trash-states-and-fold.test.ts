// Stage 59 (ADRs 0863 and 0864, the second review of PR #491): the pure parts of two platform
// rules, beside the runner's real-path proof in apps/runner/test/equipment.test.ts.
//   - Which states are guarded (only tools or the host leave them), and the tools that leave each:
//     what decides who may put a record in the Trash.
//   - Folded uniqueness: the text the host keeps, and a filter's value folded to match it.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ObjectDefinition } from "../src/fields/types.ts";
import { compileFilter, invoke, personObject } from "../src/index.ts";
import { guardedStates, guardedStateTools } from "../src/records/trash-states.ts";
import { foldUniqueValues } from "../src/records/unique.ts";
import { extId, manifest, plan, reconcile } from "./extension-helpers.ts";
import { context, createUser, db } from "./helpers.ts";

const machine = {
  states: {
    field: "state",
    initial: "in_service",
    moves: [
      {
        from: "in_service",
        to: "out_of_service",
        by: ["host"],
        tools: ["takeOut", "reportFault"],
      },
      { from: "out_of_service", to: "in_service", by: ["host"], tools: ["putBack"] },
      {
        from: ["in_service", "out_of_service"],
        to: "retired",
        by: ["host"],
        tools: ["retire"],
        final: true,
      },
      { from: "draft", to: "in_service", by: ["staff", "host"] },
      { from: "held", to: "in_service", by: ["host"] },
    ],
  },
  fields: [],
} as unknown as ObjectDefinition;

describe("guarded states (ADR 0863)", () => {
  it("a state only tools leave is guarded, with every tool that leaves it", () => {
    expect(guardedStateTools(machine, "in_service")).toEqual(["takeOut", "reportFault", "retire"]);
    expect(guardedStateTools(machine, "out_of_service")).toEqual(["putBack", "retire"]);
  });

  it("a state only the host leaves is guarded with no tool: no record write Trashes it", () => {
    expect(guardedStateTools(machine, "held")).toEqual([]);
  });

  it("a final state, one staff may leave, one nothing leaves and no state are not guarded", () => {
    expect(guardedStateTools(machine, "retired")).toBeNull();
    expect(guardedStateTools(machine, "draft")).toBeNull();
    expect(guardedStateTools(machine, "nowhere")).toBeNull();
    expect(guardedStateTools(machine, null)).toBeNull();
    expect(guardedStateTools({ states: undefined }, "in_service")).toBeNull();
  });

  it("lists every guarded state of an object", () => {
    expect(guardedStates(machine).sort()).toEqual(["held", "in_service", "out_of_service"]);
  });
});

describe("folded uniqueness (ADR 0864)", () => {
  const thing = {
    unique: [{ fields: ["tag"], fold: true }, { fields: ["name"] }],
  } as unknown as ObjectDefinition;

  it("keeps a folded field trimmed and upper case, without invisible characters", () => {
    expect(foldUniqueValues(thing, { tag: "  tm-03​ ", name: " Bike " })).toEqual({
      tag: "TM-03",
      name: " Bike ",
    });
    expect(foldUniqueValues(thing, { tag: "​ " })).toEqual({ tag: null });
    const same = { tag: "TM-03" };
    expect(foldUniqueValues(thing, same)).toBe(same);
  });

  it("folds a filter's value on a folded field, and leaves others as given", () => {
    const people = { ...personObject, unique: [{ fields: ["givenName"], fold: true }] };
    const run = (filter: Parameters<typeof compileFilter>[1]) =>
      db.query.selectFrom("rec_person").select("id").where(compileFilter(people, filter)).compile()
        .parameters;
    expect(run({ field: "givenName", op: "eq", value: " tm-03​ " })).toEqual(["TM-03"]);
    expect(run({ field: "givenName", op: "in", value: ["a ", " b"] })).toEqual(["A", "B"]);
    expect(run({ field: "familyName", op: "eq", value: " x " })).toEqual([" x "]);
    expect(run({ field: "givenName", op: "contains", value: " x " })).not.toContain("X");
  });
});

describe("a rule gaining fold (ADR 0864)", () => {
  it("is refused while live records would clash once folded, naming them", async () => {
    const id = extId("fold");
    const withRule = (fold: boolean) =>
      manifest(id, {
        objects: {
          thing: {
            label: "Thing",
            plural: "Things",
            titleField: "tag",
            fields: { tag: { type: "text", label: "Tag" } },
            unique: [{ fields: ["tag"], ...(fold ? { fold: true } : {}) }],
          },
        },
      });
    await reconcile(withRule(false));
    const admin = context(await createUser("admin"));
    const a = await invoke(
      "record.create",
      { object: `${id}.thing`, values: { tag: "tm-03" } },
      admin,
    );
    const b = await invoke(
      "record.create",
      { object: `${id}.thing`, values: { tag: "TM-03 " } },
      admin,
    );
    const issues = (await plan(withRule(true))).issues;
    const issue = issues.find((i) => i.code === "unique_conflict");
    expect(issue?.message).toContain((a as { id: string }).id);
    expect(issue?.message).toContain((b as { id: string }).id);
    // A value SQLite cannot fold as the host does (a zero-width space) refuses it, counted.
    const odd = await invoke(
      "record.create",
      { object: `${id}.thing`, values: { tag: "tm-05\u200b" } },
      admin,
    );
    await invoke(
      "record.update",
      { object: `${id}.thing`, id: (b as { id: string }).id, values: { tag: "tm-04 " } },
      admin,
    );
    const refused = (await plan(withRule(true))).issues;
    expect(refused.map((i) => i.code)).toEqual(["unique_fold_rows"]);
    expect(refused[0]?.message).toContain("1 record");
    expect(refused[0]?.message).toContain((odd as { id: string }).id);
    // Written folded first, the change is made and the rows already there are folded in place.
    await invoke(
      "record.update",
      { object: `${id}.thing`, id: (odd as { id: string }).id, values: { tag: "TM-05" } },
      admin,
    );
    expect((await plan(withRule(true))).issues).toEqual([]);
    await reconcile(withRule(true));
    const table = (
      await env.DB.prepare("SELECT table_name FROM core_extension_objects WHERE name = ?")
        .bind(`${id}.thing`)
        .first<{ table_name: string }>()
    )?.table_name;
    const tags = await env.DB.prepare(`SELECT * FROM ${table} ORDER BY id`).all<
      Record<string, unknown>
    >();
    const values = tags.results
      .map((r) => Object.entries(r).find(([k]) => k.includes("tag"))?.[1])
      .sort();
    expect(values).toEqual(["TM-03", "TM-04", "TM-05"]);
    // The old row and a new one the same once folded are one value now.
    const twice = await invoke(
      "record.create",
      { object: `${id}.thing`, values: { tag: "TM-03" } },
      admin,
    ).catch((e: { code?: string }) => e.code);
    expect(twice).toBe("conflict");
  });
});
