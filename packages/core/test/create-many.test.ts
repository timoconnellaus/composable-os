// Stage 41, build step 1: record.createMany (ADR 0448). Many records of one object in one batch,
// all or none, each written by record.create's own code; and what one record costs the batch,
// which sets the cap (D1 runs at most 1,000 queries in one invocation).
import type { CrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, CREATE_MANY_MAX, invoke } from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db } from "./helpers.ts";

const EXT = extId("many");
const SESSION = `${EXT}.session`;
let admin: ActingUser;
const batches: number[] = [];
const counting: CrmDb = {
  query: db.query,
  async batch(statements) {
    batches.push(statements.length);
    return db.batch(statements);
  },
};

const plan = {
  blocks: [{ label: "A", items: [{ label: "A1", note: "x".repeat(400) }] }],
};

const session = (n: number) => ({
  name: `Session ${n}`,
  date: "2026-12-01",
  week: 1 + Math.floor(n / 3),
  plan,
});

async function batchOf(count: number) {
  batches.length = 0;
  const out = await invoke(
    "record.createMany",
    { object: SESSION, records: Array.from({ length: count }, (_, n) => session(n)) },
    context(admin, { db: counting }),
  );
  expect(out.ids).toHaveLength(count);
  return Math.max(...batches);
}

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(
    manifest(EXT, {
      objects: {
        session: {
          label: "Session",
          plural: "Sessions",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            date: { type: "date", label: "Date" },
            week: { type: "number", label: "Week" },
            state: {
              type: "select",
              label: "State",
              options: [
                { value: "planned", label: "Planned" },
                { value: "done", label: "Done" },
              ],
            },
            plan: {
              type: "document",
              label: "Plan",
              schema: {
                root: {
                  type: "object",
                  fields: {
                    blocks: {
                      type: "array",
                      max: 10,
                      of: {
                        type: "object",
                        fields: {
                          label: { type: "text", max: 4 },
                          items: {
                            type: "array",
                            max: 10,
                            of: {
                              type: "object",
                              fields: {
                                label: { type: "text", max: 6 },
                                note: { type: "text", max: 800 },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          states: {
            field: "state",
            initial: "planned",
            moves: [{ from: "planned", to: "done", by: ["staff"] }],
          },
        },
      },
    }),
  );
});

describe("record.createMany (ADR 0448)", () => {
  it(`creates up to ${CREATE_MANY_MAX} in one batch, at 4 statements a record`, async () => {
    const one = await batchOf(1);
    const most = await batchOf(CREATE_MANY_MAX);
    // The record, its first state's history row, and its search document's delete and insert.
    expect((most - one) / (CREATE_MANY_MAX - 1)).toBe(4);
    // A quarter of D1's 1,000 queries per invocation.
    expect(most).toBeLessThanOrEqual(250);
    const stored = await invoke(
      "record.count",
      { object: SESSION, filter: { field: "state", op: "eq", value: "planned" } },
      context(admin),
    );
    expect(stored.count).toBe(CREATE_MANY_MAX + 1);
  });

  it("is all or none, naming the record that cannot be made, and capped", async () => {
    const before = await invoke("record.count", { object: SESSION }, context(admin));
    const bad = [
      session(1),
      { ...session(2), plan: { blocks: [{ label: "TOOLONG", items: [] }] } },
    ];
    await expect(
      invoke("record.createMany", { object: SESSION, records: bad }, context(admin)),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringMatching(
        /^Record 1: Invalid value for .*plan: plan\.blocks\.0\.label: At most 4 characters/,
      ),
      details: { index: 1 },
    });
    expect((await invoke("record.count", { object: SESSION }, context(admin))).count).toBe(
      before.count,
    );
    await expect(
      invoke(
        "record.createMany",
        {
          object: SESSION,
          records: Array.from({ length: CREATE_MANY_MAX + 1 }, (_, n) => session(n)),
        },
        context(admin),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
