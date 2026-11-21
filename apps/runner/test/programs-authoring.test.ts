// Stage 41, step 6 in the real host (criterion 8): the assistant's draft uses only bank exercises
// and is never published without a person (its publish request waits for one, ADR 0480); pasted
// shorthand becomes structured targets, with the lines it could not read listed. This runner has no AI configured, so the draft reads the brief
// without a model: the model role is asked for and its refusal is the fallback (what never runs
// here is a real model reading a brief).
import { env } from "cloudflare:workers";
import type { ActingUser } from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { SHORTHAND, SHORTHAND_BANK } from "../../../packs/programs/test/shorthand.ts";
import { createAdmin, unique } from "./helpers.ts";
import {
  create,
  EXERCISE,
  installPrograms,
  PROGRAM,
  refusal,
  run,
  staff,
} from "./programs-fixture.ts";

let admin: ActingUser;
const bank: Record<string, string> = {};

beforeAll(async () => {
  admin = await createAdmin();
  await installPrograms(admin);
  for (const e of SHORTHAND_BANK) bank[e.name] = await create(admin, EXERCISE, { ...e });
}, 120_000);

const refsOf = (layout: unknown) => [
  ...new Set(JSON.stringify(layout).match(/rec_[A-Za-z0-9]{26}/g) ?? []),
];

describe("the assistant's draft (criterion 8)", () => {
  it("is a working copy built only from the bank, never published", async () => {
    const out = await run<{
      programId: string;
      weeks: number;
      sessions: number;
      published: boolean;
    }>(
      "x.programs.draft",
      { brief: "8 weeks of planche and pike work, 2 sessions a week" },
      staff(admin),
    );
    expect(out).toMatchObject({ weeks: 8, sessions: 16, published: false });
    const program = await run<{ values: Record<string, unknown> }>(
      "record.get",
      { object: PROGRAM, id: out.programId },
      staff(admin),
    );
    expect(program.values.publishedVersion).toBeNull();
    const refs = refsOf(program.values.layout);
    expect(refs.length).toBeGreaterThan(0);
    for (const id of refs) expect(Object.values(bank)).toContain(id);
    const versions = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_publish_version WHERE record_id = ?",
    )
      .bind(out.programId)
      .first<{ n: number }>();
    expect(versions?.n).toBe(0);
    // Asked by the assistant: it drafts, and asks for what it drafted to be published. The
    // request waits for a person (criterion 12, ADR 0480), who approves it.
    const assistant = staff(admin, {
      actor: "assistant",
      origin: { surface: "assistant", sessionId: unique("ath") },
    });
    const byAssistant = await run<{ programId: string }>(
      "x.programs.draft",
      { brief: "a month of hollow holds" },
      assistant,
    );
    const asked = await refusal(
      run("record.publish", { object: PROGRAM, id: byAssistant.programId }, assistant),
    );
    expect(asked.code).toBe("pending_approval");
    const actionId = (asked.details as { actionId: string }).actionId;
    const waiting = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_publish_version WHERE record_id = ?",
    )
      .bind(byAssistant.programId)
      .first<{ n: number }>();
    expect(waiting?.n).toBe(0);
    await run("approval.approve", { actionIds: [actionId] }, staff(admin));
    const live = await run<{ version: number; requestedVia: string | null }>(
      "record.version",
      { object: PROGRAM, id: byAssistant.programId },
      staff(admin),
    );
    expect(live).toMatchObject({ version: 1, requestedVia: "assistant", publishedBy: admin.id });
  });
});

describe("the text import (criterion 8)", () => {
  it("turns shorthand into structured targets and lists every line it could not read", async () => {
    const out = await run<{
      programId: string;
      title: string;
      sessions: number;
      items: number;
      published: boolean;
      unread: { line: number; text: string; reason: string }[];
    }>("x.programs.importText", { text: SHORTHAND }, staff(admin));
    expect(out).toMatchObject({ title: "Strength block", sessions: 2, items: 5, published: false });
    expect(out.unread.map((u) => [u.line, u.text])).toEqual([
      [8, "- Wrist circles"],
      [23, "B2: Dragon flag x 5"],
      [29, "A2: Muscle up x lots"],
      [30, "Something nobody wrote a rule for"],
    ]);
    const program = await run<{
      values: { layout: { weeks: { sessions: { blocks: { items: unknown[] }[] }[] }[] } };
    }>("record.get", { object: PROGRAM, id: out.programId }, staff(admin));
    const a2 = program.values.layout.weeks[0]?.sessions[0]?.blocks[0]?.items[1];
    expect(a2).toEqual({
      kind: "all",
      label: "A2",
      exercises: [
        {
          exercise: bank["Ring rows"],
          sets: Array.from({ length: 4 }, () => ({ kind: "reps", reps: 5, tempo: "5050" })),
        },
      ],
      notes: [{ text: "elevate the feet to make it harder" }],
    });
    for (const id of refsOf(program.values.layout)) expect(Object.values(bank)).toContain(id);
  });
});
