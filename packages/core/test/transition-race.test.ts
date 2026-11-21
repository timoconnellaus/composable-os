// A move is made from a current read or not at all (stage 27, ADR 0437). Two writes judged from
// the same position race to move one record: the database lets one through and fails the other's
// batch, which is answered as a conflict (`moved_meanwhile`) with nothing applied. This is what
// makes checking a ticket in safe for two scanners at once (packs/ticketing), and it holds for
// every lifecycle, `states` and `stages`, for every actor. (With the close made unconditional
// again, as before ADR 0437, the first test fails: several writes win. ADR 0437 records the run.)
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invokeByName } from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, unique } from "./helpers.ts";

const ext = extId("race");
const PASS = `${ext}.pass`;
const JOB = `${ext}.job`;

let admin: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(
    manifest(ext, {
      objects: {
        pass: {
          label: "Pass",
          plural: "Passes",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            state: {
              type: "select",
              label: "State",
              options: [
                { value: "valid", label: "Valid" },
                { value: "used", label: "Used" },
              ],
            },
            note: { type: "text", label: "Note" },
          },
          states: {
            field: "state",
            initial: "valid",
            moves: [
              { from: "valid", to: "used", by: ["staff"] },
              { from: "used", to: "valid", by: ["staff"] },
            ],
          },
        },
        step: {
          label: "Step",
          plural: "Steps",
          titleField: "name",
          navigation: "settings",
          fields: {
            name: { type: "text", label: "Name", required: true },
            type: {
              type: "select",
              label: "Type",
              options: [
                { value: "open", label: "Open" },
                { value: "won", label: "Won" },
                { value: "lost", label: "Lost" },
              ],
            },
            position: { type: "number", label: "Position" },
          },
        },
        job: {
          label: "Job",
          plural: "Jobs",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            step: { type: "relation", label: "Step", to: `${ext}.step` },
          },
          stages: {
            field: "step",
            stage: { type: "type", order: "position" },
          },
        },
      },
    } as never),
  );
});

const create = async (object: string, values: Record<string, unknown>) =>
  ((await invokeByName("record.create", { object, values }, context(admin))) as { id: string }).id;

const update = (
  object: string,
  id: string,
  values: Record<string, unknown>,
  from?: string,
) =>
  invokeByName("record.update", { object, id, values, from }, context(admin)).then(
    () => ({ ok: true as const }),
    (error: { code?: string; details?: { reason?: string } }) => ({
      ok: false as const,
      code: error.code,
      reason: error.details?.reason,
    }),
  );

async function openRows(object: string, id: string) {
  const { results } = await env.DB.prepare(
    "SELECT position_id FROM core_transition_history WHERE object_type = ? AND record_id = ? AND left_at IS NULL",
  )
    .bind(object, id)
    .all<{ position_id: string }>();
  return results.map((r) => r.position_id);
}

describe("a move is made from a current read (ADR 0437)", () => {
  it("states: of many writes moving one record from the same state, exactly one wins", async () => {
    const id = await create(PASS, { name: unique("Pass") });
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        update(PASS, id, { state: "used", note: `scan ${i}` }, "valid"),
      ),
    );
    const won = outcomes.filter((o) => o.ok);
    expect(won).toHaveLength(1);
    for (const lost of outcomes.filter((o) => !o.ok)) {
      expect(lost.code).toBe("conflict");
      // Refused on its own read (the record had already left `valid`), or by the database (it
      // left between that read and the batch).
      expect(["not_in_position", "moved_meanwhile"]).toContain(lost.reason);
    }
    // One move in the history, and the record holds the winner's values only.
    const { results } = await env.DB.prepare(
      "SELECT position_id FROM core_transition_history WHERE object_type = ? AND record_id = ? ORDER BY entered_at, id",
    )
      .bind(PASS, id)
      .all<{ position_id: string }>();
    expect(results.map((r) => r.position_id)).toEqual(["valid", "used"]);
    expect(await openRows(PASS, id)).toEqual(["used"]);
  });

  it("without `from`, a write that finds the record already moved is an edit, not a move", async () => {
    const id = await create(PASS, { name: unique("Pass") });
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, (_, i) => update(PASS, id, { state: "used", note: `scan ${i}` })),
    );
    // Whatever the interleaving, the record moved once: later writes saw it used and only
    // edited the note. This is why a check-in passes `from`.
    expect(outcomes.some((o) => o.ok)).toBe(true);
    const { results } = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_transition_history WHERE object_type = ? AND record_id = ?",
    )
      .bind(PASS, id)
      .all<{ n: number }>();
    expect(results[0]?.n).toBe(2);
  });

  it("`from` must name the state the write moves out of", async () => {
    const id = await create(PASS, { name: unique("Pass") });
    expect(await update(PASS, id, { note: "x" }, "valid")).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(await update(PASS, id, { state: "used" }, "used")).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    // A record that is not in `from` is a conflict, whatever the write asks for.
    expect(await update(PASS, id, { state: "valid" }, "used")).toEqual({
      ok: false,
      code: "conflict",
      reason: "not_in_position",
    });
  });

  it("a write that does not move the record is not held up by one that did", async () => {
    const id = await create(PASS, { name: unique("Pass") });
    const [move, edit] = await Promise.all([
      update(PASS, id, { state: "used" }),
      update(PASS, id, { note: "just a note" }),
    ]);
    expect(move.ok && edit.ok).toBe(true);
  });

  it("moving on from a current read works however the history got where it is", async () => {
    const id = await create(PASS, { name: unique("Pass") });
    expect((await update(PASS, id, { state: "used" })).ok).toBe(true);
    expect((await update(PASS, id, { state: "valid" })).ok).toBe(true);
    expect((await update(PASS, id, { state: "used" })).ok).toBe(true);
    expect(await openRows(PASS, id)).toEqual(["used"]);
    // A current row left behind by an older path (a position changed outside the engine) is
    // closed by the next move, because the guard reads the record, not the history.
    await env.DB.prepare(
      "UPDATE core_transition_history SET position_id = 'valid' WHERE object_type = ? AND record_id = ? AND left_at IS NULL",
    )
      .bind(PASS, id)
      .run();
    expect((await update(PASS, id, { state: "valid" })).ok).toBe(true);
    expect(await openRows(PASS, id)).toEqual(["valid"]);
  });

  it("stages: two moves of one record to different stages, one wins", async () => {
    const open = await create(`${ext}.step`, { name: "Open", type: "open", position: 1 });
    const won = await create(`${ext}.step`, { name: "Won", type: "won", position: 2 });
    const lost = await create(`${ext}.step`, { name: "Lost", type: "lost", position: 3 });
    const job = await create(JOB, { name: unique("Job"), step: open });
    const outcomes = await Promise.all([
      update(JOB, job, { step: won }, open),
      update(JOB, job, { step: lost }, open),
      update(JOB, job, { step: won }, open),
    ]);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect((await openRows(JOB, job)).length).toBe(1);
  });
});
