// Who stands behind what a tool run writes (ADR 0590, the fourth review): the rules the runner
// applies to a tool's run and carries into a tool it calls, and the marks they give.
import { describe, expect, it } from "vitest";
import {
  callerMarks,
  givenValues,
  type MarkedChange,
  markStatements,
  toolRunStanding,
} from "../src/routine-mail/marks.ts";
import { db } from "./helpers.ts";

describe("a tool's run (the fourth review, M1 and L1)", () => {
  it("a runtime extension's tool a person clicks writes as an AI; their own input stays theirs", () => {
    const out = toolRunStanding({ actor: "human" }, "runtime", { name: "Ada" });
    expect(out.standing).toBe("ai");
    expect(out.given?.has("Ada")).toBe(true);
    expect(toolRunStanding({ actor: "human" }, "shipped", { name: "Ada" }).standing).toBe("host");
  });

  it("an AI's call writes as an AI with no given values; a person's approval of it gives them", () => {
    expect(toolRunStanding({ actor: "mcp" }, "shipped", { name: "Ada" })).toEqual({
      standing: "ai",
    });
    expect(
      toolRunStanding({ actor: "assistant", approvedBy: "adjudicator" }, "shipped", {}),
    ).toEqual({ standing: "ai" });
    const approved = toolRunStanding({ actor: "mcp", approvedBy: "usr_1" }, "shipped", {
      name: "Ada",
    });
    expect(approved.standing).toBe("host");
    expect(approved.given?.has("Ada")).toBe(true);
  });

  it("a tool called by a run writes no better than that run, with that run's person's values", () => {
    const ai = callerMarks({ actor: "extension", markStanding: "ai", markGiven: new Set(["Ada"]) });
    expect(ai).toEqual({ markStanding: "ai", markGiven: ["Ada"] });
    const inner = toolRunStanding({ actor: "extension", ...ai }, "shipped", { name: "Other" });
    expect(inner.standing).toBe("ai");
    expect(inner.given?.has("Ada")).toBe(true);
    // Its own input (chosen by the calling code) is never a person's.
    expect(inner.given?.has("Other")).toBe(false);
    const host = toolRunStanding(
      { actor: "automation", ...callerMarks({ actor: "automation", markStanding: "host" }) },
      "shipped",
      { name: "Other" },
    );
    expect(host).toEqual({ standing: "host" });
    // A person's or an AI's own call carries nothing: the pipeline decides its standing.
    expect(callerMarks({ actor: "human" })).toEqual({});
  });
});

describe("the marks a run's writes leave", () => {
  const change = (id: string, after: Record<string, unknown>): MarkedChange => ({
    object: "x.item",
    id,
    action: "create",
    after,
  });
  const standings = async (
    changes: MarkedChange[],
    standing: "host" | "ai",
    given?: ReadonlySet<string>,
  ) => {
    const statements = await markStatements(db.query, changes, standing, null, "now", given);
    // A marks statement is a raw query (no compile); a delete is a builder.
    const sql = statements.map((s) =>
      "compile" in s && typeof s.compile === "function" ? s.compile() : s,
    ) as unknown as { parameters: readonly unknown[] }[];
    const rows = sql.flatMap((c) => {
      const json = c.parameters.find((p) => typeof p === "string" && p.startsWith("["));
      return json ? (JSON.parse(json as string) as { f: string; s: string }[]) : [];
    });
    return Object.fromEntries(rows.map((r) => [r.f, r.s]));
  };

  it("an AI's run: only a value equal to the person's own input is theirs", async () => {
    const marks = await standings(
      [change("rec_a", { name: "Ada", note: "Made by the code" })],
      "ai",
      givenValues({ name: "Ada" }),
    );
    expect(marks).toMatchObject({ name: "person", note: "ai", $created: "ai" });
  });

  it("a value a run read back from its storage is the host's at best, never a person's", async () => {
    // The run's person gave nothing that equals it: what the code stored earlier is the code's.
    const marks = await standings(
      [change("rec_b", { name: "Stored earlier" })],
      "host",
      givenValues({ id: "rec_x" }),
    );
    expect(marks.name).toBe("host");
  });
});
