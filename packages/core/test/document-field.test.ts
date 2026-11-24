// Stage 41, build step 1: the structured document field (ADR 0445). A field whose value is one
// JSON document checked against the schema its object declares: a fault refused with its path,
// for every actor, in the CSV import and in the approval queue's dry run; a size limit; refs that
// must name live records; declared paths as columns of the rec_* view that lists filter, sort
// and query.sql read; and private parts left out of what a customer reads.
import { env } from "cloudflare:workers";
import {
  checkDocumentSchema,
  type DocumentSchema,
  redactDocument,
  validateDocument,
  validateManifest,
} from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type CustomerPrincipal,
  getObject,
  invoke,
  listObjects,
  PendingApprovalError,
  setExtensionObjects,
} from "../src/index.ts";
import { call, outside } from "./customer-fixtures.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, refusal, setPreset, unique } from "./helpers.ts";

/** A small layout: weeks of sessions of items, each naming an exercise, with notes. */
const LAYOUT: DocumentSchema = {
  defs: {
    note: {
      type: "object",
      fields: {
        text: { type: "text", max: 200, multiline: true },
        members: { type: "boolean", optional: true },
      },
      private: { unless: "members" },
    },
  },
  root: {
    type: "object",
    fields: {
      title: { type: "text", max: 80 },
      level: { type: "choice", options: ["easy", "hard"], optional: true },
      weeks: {
        type: "array",
        max: 4,
        min: 1,
        of: {
          type: "object",
          fields: {
            sessions: {
              type: "array",
              max: 3,
              of: {
                type: "object",
                fields: {
                  label: { type: "text", max: 4, chars: "ABCDEFGH" },
                  exercise: { type: "ref", to: "PLACEHOLDER" },
                  reps: { type: "number", min: 1, max: 100, integer: true },
                  rpe: { type: "number", min: 1, max: 10, step: 0.5, optional: true },
                  notes: {
                    type: "array",
                    max: 5,
                    of: { type: "use", def: "note" },
                    optional: true,
                  },
                },
              },
              unique: "label",
            },
          },
        },
      },
    },
  },
};

const EXT = extId("doc");
const PLAN = `${EXT}.plan`;
const MOVE = `${EXT}.move`;
let admin: ActingUser;
let move: string;
let customer: CustomerPrincipal;

const schema = (): DocumentSchema => {
  const copy = structuredClone(LAYOUT);
  const weeks = copy.root.fields.weeks as unknown as {
    of: { fields: { sessions: { of: { fields: Record<string, unknown> } } } };
  };
  weeks.of.fields.sessions.of.fields.exercise = { type: "ref", to: MOVE };
  return copy;
};

const good = () => ({
  title: "Hands",
  level: "easy",
  weeks: [
    {
      sessions: [
        {
          label: "A",
          exercise: move,
          reps: 5,
          rpe: 7.5,
          notes: [{ text: "Coach only" }, { text: "Shown to members", members: true }],
        },
        { label: "B", exercise: move, reps: 8 },
      ],
    },
  ],
});

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(
    manifest(EXT, {
      objects: {
        move: {
          label: "Move",
          plural: "Moves",
          titleField: "name",
          fields: { name: { type: "text", label: "Name", required: true } },
        },
        plan: {
          label: "Plan",
          plural: "Plans",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            owner: { type: "relation", label: "Owner", to: "person" },
            layout: {
              type: "document",
              label: "Layout",
              schema: schema() as unknown as Record<string, unknown>,
              maxBytes: 4096,
              paths: {
                planTitle: { label: "Title", path: "title" },
                planLevel: { label: "Level", path: "level" },
                weekCount: { label: "Weeks", path: "weeks", count: true },
              },
            },
          },
        },
      },
    }),
  );
  move = (await invoke("record.create", { object: MOVE, values: { name: "Pike" } }, context(admin)))
    .id;
  const person = await invoke(
    "person.create",
    { givenName: "Doc", familyName: unique("Reader") },
    context(admin),
  );
  customer = { kind: "customer", customerId: `cus_${unique("doc")}`, personId: person.id };
  // The plan is the customer's, reading its layout: attached as the customer fixtures do.
  setExtensionObjects(
    new Map(
      listObjects().map((o) => [
        o.name,
        o.name === PLAN
          ? { ...o, customer: { field: "owner", read: ["name", "layout"], write: [] } }
          : o,
      ]),
    ),
  );
});

describe("the schema language (ADR 0445)", () => {
  it("names the path of every fault in a value", () => {
    const bad = good() as Record<string, unknown> & { weeks: Record<string, unknown>[] };
    const sessions = (bad.weeks[0] as { sessions: Record<string, unknown>[] }).sessions;
    const session = sessions[0] as Record<string, unknown>;
    session.reps = 0;
    session.rpe = 7.25;
    session.label = "A1";
    session.extra = "x";
    bad.level = "medium";
    const result = validateDocument(schema(), bad);
    expect(result.ok).toBe(false);
    const issues = result.ok ? [] : result.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    expect(issues).toEqual(
      expect.arrayContaining([
        "level: Expected one of easy, hard",
        'weeks.0.sessions.0.extra: Unknown key "extra"',
        'weeks.0.sessions.0.label: "1" is not allowed here (only ABCDEFGH)',
        "weeks.0.sessions.0.reps: At least 1",
        "weeks.0.sessions.0.rpe: In steps of 0.5",
      ]),
    );
  });

  it("refuses a repeated unique key, a missing required key and too many entries", () => {
    const value = good();
    value.weeks[0]?.sessions.push({ label: "A", exercise: move, reps: 1 });
    const twice = validateDocument(schema(), value);
    expect(twice.ok ? [] : twice.issues.map((i) => i.path.join("."))).toContain(
      "weeks.0.sessions.2.label",
    );
    const { title: _title, ...untitled } = good();
    const missing = validateDocument(schema(), untitled);
    expect(missing.ok ? [] : missing.issues[0]).toEqual({ path: ["title"], message: "Required" });
    const long = { ...good(), weeks: Array.from({ length: 5 }, () => ({ sessions: [] })) };
    const many = validateDocument(schema(), long);
    expect(many.ok ? [] : many.issues[0]?.message).toBe("At most 4 entries (this has 5)");
  });

  it("refuses a value over its size before reading it", () => {
    const big = { ...good(), title: "x".repeat(70) };
    const result = validateDocument(schema(), big, { maxBytes: 100 });
    expect(result.ok ? null : result.issues[0]?.message).toMatch(
      /^The document is \d+ bytes; at most 100$/,
    );
  });

  it("removes private parts for outsiders, keeping those marked shown", () => {
    const out = redactDocument(schema(), good()) as ReturnType<typeof good>;
    expect(out.weeks[0]?.sessions[0]?.notes).toEqual([{ text: "Shown to members", members: true }]);
    expect(redactDocument(schema(), { nonsense: true })).toBeNull();
  });

  it("checks a declared schema and a manifest's document field, with paths", () => {
    expect(
      checkDocumentSchema({
        root: { type: "object", fields: { xs: { type: "array", of: { type: "text" } } } },
      }),
    ).toEqual([["root.fields.xs.max", "A list declares its most entries (max)"]]);
    const { issues } = validateManifest(
      manifest(extId("bad"), {
        objects: {
          thing: {
            label: "Thing",
            plural: "Things",
            titleField: "name",
            fields: {
              name: { type: "text", label: "Name" },
              body: {
                type: "document",
                label: "Body",
                schema: {
                  root: { type: "object", fields: { n: { type: "number", min: 5, max: 1 } } },
                },
                paths: {
                  name: { label: "Clash", path: "n" },
                  deep: { label: "Deep", path: "n.x" },
                },
              },
              plain: { type: "text", label: "Plain", schema: { root: {} } },
            },
          },
        },
      }),
    );
    expect(issues.map((i) => `${i.path}: ${i.message}`)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/fields\.body\.schema\.root\.fields\.n\.min: min is above max$/),
        expect.stringMatching(/fields\.body\.paths\.name: "name" is already a field/),
        expect.stringMatching(
          /fields\.plain\.schema: Only document and richText fields take schema$/,
        ),
      ]),
    );
  });
});

describe("in the host (ADR 0445)", () => {
  it("stores a valid layout and refuses a broken one with the path of the fault, for every actor", async () => {
    const created = await invoke(
      "record.create",
      { object: PLAN, values: { name: "Plan A", layout: good() } },
      context(admin),
    );
    expect(created.values.layout).toEqual(good());
    const broken = good();
    (broken.weeks[0]?.sessions[1] as Record<string, unknown>).reps = 1000;
    for (const actor of ["human", "assistant", "mcp", "automation"] as const) {
      const error = await refusal(
        invoke(
          "record.update",
          { object: PLAN, id: created.id, values: { layout: broken } },
          context(admin, {
            actor,
            origin: {
              surface:
                actor === "human"
                  ? "ui"
                  : actor === "mcp"
                    ? "mcp"
                    : actor === "assistant"
                      ? "assistant"
                      : "automation",
              sessionId: `s_${unique()}`,
            },
          }),
        ),
      );
      expect(error.code, actor).toBe("invalid_input");
      expect(error.message, actor).toBe(
        `Invalid value for ${PLAN}.layout: layout.weeks.0.sessions.1.reps: At most 100`,
      );
    }
  });

  it("refuses a document over the field's size and a ref to a record that is not there", async () => {
    const big = { ...good(), title: "t".repeat(80), weeks: [{ sessions: [] }] };
    const heavy = {
      ...big,
      weeks: Array.from({ length: 4 }, () => ({
        sessions: good().weeks[0]?.sessions.map((s) => ({
          ...s,
          notes: [{ text: "n".repeat(200) }, { text: "n".repeat(200) }, { text: "n".repeat(200) }],
        })),
      })),
    };
    const tooBig = await refusal(
      invoke(
        "record.create",
        { object: PLAN, values: { name: "Big", layout: heavy } },
        context(admin),
      ),
    );
    expect(tooBig.message).toMatch(/layout: The document is \d+ bytes; at most 4096$/);
    const ghost = good();
    (ghost.weeks[0]?.sessions[1] as Record<string, unknown>).exercise =
      "rec_01NOSUCHMOVE00000000000000";
    const dangling = await refusal(
      invoke(
        "record.create",
        { object: PLAN, values: { name: "Ghost", layout: ghost } },
        context(admin),
      ),
    );
    expect(dangling.message).toBe(
      `layout.weeks.0.sessions.1.exercise: no live ${MOVE} with id rec_01NOSUCHMOVE00000000000000`,
    );
  });

  it("holds in the CSV import and in the approval queue's dry run", async () => {
    const broken = good();
    broken.level = "medium";
    const csv = `name,layout\nImported,"${JSON.stringify(broken).replaceAll('"', '""')}"\n`;
    const imported = await refusal(
      invoke("import.records.commit", { object: PLAN, csv }, context(admin)),
    );
    expect(imported.code).toBe("invalid_input");
    expect(JSON.stringify(imported)).toContain("layout.level: Expected one of easy, hard");
    const fine = `name,layout\nImported,"${JSON.stringify(good()).replaceAll('"', '""')}"\n`;
    const ok = await invoke("import.records.commit", { object: PLAN, csv: fine }, context(admin));
    expect(ok.created).toHaveLength(1);

    await setPreset("cautious");
    try {
      const mcp = context(admin, {
        actor: "mcp",
        origin: { surface: "mcp", clientId: "c", clientName: "Test", sessionId: `doc_${unique()}` },
      });
      const before = await env.DB.prepare("SELECT count(*) AS n FROM core_pending_action").first<{
        n: number;
      }>();
      const dry = await refusal(
        invoke("record.create", { object: PLAN, values: { name: "Queued", layout: broken } }, mcp),
      );
      expect(dry.message).toBe(
        `Invalid value for ${PLAN}.layout: layout.level: Expected one of easy, hard`,
      );
      const after = await env.DB.prepare("SELECT count(*) AS n FROM core_pending_action").first<{
        n: number;
      }>();
      expect(after?.n).toBe(before?.n);
      // A valid one is queued as any write is.
      const queued = await refusal(
        invoke("record.create", { object: PLAN, values: { name: "Queued", layout: good() } }, mcp),
      );
      expect(queued).toBeInstanceOf(PendingApprovalError);
    } finally {
      await setPreset("balanced");
    }
  });

  it("shows declared paths as columns that lists filter and sort by and query.sql reads", async () => {
    const tag = unique("Paths");
    const two = {
      ...good(),
      title: `${tag} two`,
      level: "hard",
      weeks: [...good().weeks, { sessions: [] }],
    };
    await invoke(
      "record.create",
      { object: PLAN, values: { name: `${tag} 1`, layout: { ...good(), title: `${tag} one` } } },
      context(admin),
    );
    await invoke(
      "record.create",
      { object: PLAN, values: { name: `${tag} 2`, layout: two } },
      context(admin),
    );
    const fields = getObject(PLAN)
      ?.fields.filter((f) => f.options?.documentPath)
      .map((f) => [f.name, f.type, f.readOnly]);
    expect(fields).toEqual([
      ["planTitle", "text", true],
      ["planLevel", "text", true],
      ["weekCount", "number", true],
    ]);
    const hard = await invoke(
      "record.list",
      {
        object: PLAN,
        filter: {
          and: [
            { field: "planLevel", op: "eq", value: "hard" },
            { field: "planTitle", op: "starts_with", value: tag },
          ],
        },
        sort: { field: "weekCount", direction: "desc" },
      },
      context(admin),
    );
    expect(hard.items.map((r) => [r.values.planTitle, r.values.weekCount])).toEqual([
      [`${tag} two`, 2],
    ]);
    const rows = await invoke(
      "query.sql",
      {
        sql: `SELECT plan_title, week_count FROM rec_x_${EXT}_plan WHERE plan_title LIKE ? ORDER BY plan_title`,
        params: [`${tag}%`],
      },
      context(admin),
    );
    expect(rows.rows).toEqual([
      { plan_title: `${tag} one`, week_count: 1 },
      { plan_title: `${tag} two`, week_count: 2 },
    ]);
    // A path is the host's: no one writes it.
    const id = hard.items[0]?.id as string;
    const write = await refusal(
      invoke("record.update", { object: PLAN, id, values: { weekCount: 9 } }, context(admin)),
    );
    expect(write.code).toBe("invalid_input");
    // The document itself is not filtered: its paths are.
    const filtered = await refusal(
      invoke(
        "record.list",
        { object: PLAN, filter: { field: "layout", op: "eq", value: "x" } },
        context(admin),
      ),
    );
    expect(filtered.code).toBe("invalid_input");
  });

  it("gives a customer the layout without the coach's notes, and staff all of it", async () => {
    const mine = await invoke(
      "record.create",
      { object: PLAN, values: { name: "Mine", owner: customer.personId, layout: good() } },
      context(admin),
    );
    const read = await call("my.get", { object: PLAN, id: mine.id }, outside(customer));
    expect(read.ok, JSON.stringify(read)).toBe(true);
    const layout = (read as { value: { values: { layout: ReturnType<typeof good> } } }).value.values
      .layout;
    expect(layout.weeks[0]?.sessions[0]?.notes).toEqual([
      { text: "Shown to members", members: true },
    ]);
    expect(JSON.stringify(read)).not.toContain("Coach only");
    const staff = await invoke("record.get", { object: PLAN, id: mine.id }, context(admin));
    expect(JSON.stringify(staff.values.layout)).toContain("Coach only");
  });
});
