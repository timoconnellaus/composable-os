// Stage 54 step 2 (ADR 0811): restricted fields. A pack's text field `restricted: "<pack>:<word>"`
// is kept by the host in core_restricted_value, never in the object's table: in no rec_* view, so
// in no query.sql, dashboard, export, search, summary, timeline or audit row. The record's
// customer writes it and reads their own; staff read it only through record.readRestricted, from
// the pack's own humanOnly tool naming the permission, called by a person, every read audited.
// Erasing or purging the author deletes it; dropping the field drops it.
import { env } from "cloudflare:workers";
import { type ExtensionManifest, validateManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { planDropHidden } from "../src/extensions/reconciler.ts";
import {
  type ActingUser,
  applyPlan,
  getObject,
  invoke,
  refreshSchemaRegistry,
  runTrashPurge,
} from "../src/index.ts";
import { call, outside } from "./customer-fixtures.ts";
import { columns, extId, manifest, plan, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";

const id = extId("rev");
const REVIEW = `${id}.review`;
const PERMISSION = `${id}:feedback`;
const SECRET = unique("Sekritwords");

const objects = (feedback: Record<string, unknown> = {}) => ({
  review: {
    label: "Review",
    plural: "Reviews",
    titleField: "words",
    fields: {
      words: { type: "text", label: "Words" },
      person: { type: "relation", label: "Person", to: "person" },
      feedback: {
        type: "longText",
        label: "Private feedback",
        restricted: PERMISSION,
        ...feedback,
      },
    },
    customer: {
      field: "person",
      read: ["words", "feedback"],
      write: ["words", "feedback"],
    },
  },
});

const schema = { type: "object", properties: { ids: { type: "array" } } };
const tool = (rest: Record<string, unknown> = {}) => ({
  description: "Fixture: reads the private feedback of reviews, for a person only.",
  risk: "read",
  permission: PERMISSION,
  humanOnly: true,
  inputSchema: schema,
  outputSchema: {},
  ...rest,
});

function pack(rest: Partial<Omit<ExtensionManifest, "id">> = {}): ExtensionManifest {
  return manifest(id, {
    grantable: [PERMISSION],
    restricted: [PERMISSION],
    objects: objects() as never,
    tools: { feedback: tool() } as never,
    ...rest,
  });
}

const messages = (m: unknown) =>
  validateManifest(m)
    .issues.map((i) => `${i.path}: ${i.message}`)
    .join("\n");

let admin: ActingUser;
let author: string;
let other: string;
const asCustomer = (personId: string) =>
  outside({ kind: "customer", customerId: `cus_${personId}`, personId });

/** A run of the pack's tool, as the runtime describes it to the operations it calls. */
const asTool = (
  tool: Record<string, unknown> | undefined,
  extension = id,
  user: ActingUser = admin,
) =>
  context(user, {
    actor: "extension",
    origin: { surface: "extension", extensionId: extension },
    extension: {
      id: extension,
      permissions: { operations: [], read: [], write: [], modules: [] } as never,
      ...(tool ? { tool: tool as never } : {}),
    },
  });
const personTool = {
  name: "feedback",
  humanOnly: true,
  permission: PERMISSION,
  startedBy: "user_x",
  calledBy: { account: "user_x", actor: "human" },
};

const stored = async (record: string) =>
  (
    await env.DB.prepare(
      "SELECT value FROM core_restricted_value WHERE object_type = ? AND record_id = ? AND field = 'feedback'",
    )
      .bind(REVIEW, record)
      .first<{ value: string }>()
  )?.value ?? null;

async function review(personId: string, values: Record<string, unknown>): Promise<string> {
  const made = await call(
    "fixture.myCreate",
    { object: REVIEW, values: { words: "Fine", ...values } },
    asCustomer(personId),
  );
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  return (made.value as { id: string }).id;
}

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(pack());
  author = (await invoke("person.create", { givenName: "Avery" }, context(admin))).id;
  other = (await invoke("person.create", { givenName: "Olive" }, context(admin))).id;
});

describe("the contract", () => {
  it("a restricted text field of an object its customer reads and writes passes", () => {
    expect(messages(pack())).toBe("");
  });

  it("refuses what does not hold together", () => {
    const withField = (feedback: Record<string, unknown>) =>
      messages(pack({ objects: objects(feedback) as never }));
    expect(withField({ type: "number" })).toContain(
      "A restricted field is a text or longText field",
    );
    expect(withField({ restricted: `${id}:other` })).toContain(
      "must be one of this extension's restricted permissions",
    );
    expect(withField({ required: true })).toContain("takes no required");
    expect(withField({ track: "timeline" })).toContain("takes no track");
    const bad = (change: (o: ReturnType<typeof objects>) => void) => {
      const o = objects();
      change(o);
      return messages(pack({ objects: o as never }));
    };
    expect(
      bad((o) => {
        o.review.customer.write = ["words"];
      }),
    ).toContain("one the customer reads and writes");
    expect(
      bad((o) => {
        (o.review as Record<string, unknown>).customer = undefined;
      }),
    ).toContain("declares a customer");
    expect(
      bad((o) => {
        o.review.titleField = "feedback";
      }),
    ).toContain('"feedback" is restricted');
    expect(
      bad((o) => {
        (o.review as Record<string, unknown>).indexes = [["feedback"]];
      }),
    ).toContain('"feedback" is restricted');
    // A formula cannot read it: it is in no view.
    expect(
      bad((o) => {
        (o.review.fields as Record<string, unknown>).echo = {
          type: "formula",
          label: "Echo",
          expression: "feedback",
        };
      }),
    ).toMatch(/echo/);
    // Never on another object.
    expect(
      messages(
        pack({
          fields: { person: { note: { type: "text", label: "Note", restricted: PERMISSION } } },
        }),
      ),
    ).toContain("never one added to another object");
    // A tool taking it by name keeps it out of the audit.
    const takes = { type: "object", properties: { feedback: { type: "string" } } };
    expect(
      messages(pack({ tools: { feedback: tool({ inputSchema: takes }) } as never })),
    ).toContain("list it in redact");
    expect(
      messages(
        pack({ tools: { feedback: tool({ inputSchema: takes, redact: ["feedback"] }) } as never }),
      ),
    ).toBe("");
    // At any depth of the input: the audit's redaction is deep.
    const nested = {
      type: "object",
      properties: { review: { type: "object", properties: { feedback: { type: "string" } } } },
    };
    expect(
      messages(pack({ tools: { feedback: tool({ inputSchema: nested }) } as never })),
    ).toContain("list it in redact");
    expect(
      messages(
        pack({ tools: { feedback: tool({ inputSchema: nested, redact: ["feedback"] }) } as never }),
      ),
    ).toBe("");
  });

  it("has no column, no view column and no registry field; its object names it apart", async () => {
    const table = `x_${id}_review`;
    expect(await columns(table)).not.toContain("feedback");
    const view = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'view' AND sql LIKE ?",
    )
      .bind(`%${table}%`)
      .all<{ sql: string }>();
    expect(view.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(view.results)).not.toMatch(/feedback/i);
    const object = getObject(REVIEW);
    expect(object?.fields.map((f) => f.name)).not.toContain("feedback");
    expect(object?.restricted).toEqual([
      {
        name: "feedback",
        label: "Private feedback",
        permission: PERMISSION,
        fieldType: "longText",
      },
    ]);
  });

  it("a field cannot become restricted, or stop being, by changing its declaration", async () => {
    const o = objects();
    (o.review.fields.words as Record<string, unknown>).restricted = PERMISSION;
    o.review.titleField = "person" as never;
    const planned = await plan(pack({ objects: o as never }));
    expect(planned.issues.map((i) => i.code)).toContain("restricted_change");
  });
});

describe("the author writes it and reads their own", () => {
  it("is kept apart from the record, read back by its author only", async () => {
    const mine = await review(author, { feedback: SECRET });
    expect(await stored(mine)).toBe(SECRET);
    const got = await call("fixture.myGet", { object: REVIEW, id: mine }, asCustomer(author));
    expect(got).toMatchObject({ ok: true, value: { values: { words: "Fine", feedback: SECRET } } });
    const page = await call("fixture.myList", { object: REVIEW }, asCustomer(author));
    expect(JSON.stringify(page)).toContain(SECRET);
    // Another customer does not see the record at all.
    const theirs = await call("fixture.myGet", { object: REVIEW, id: mine }, asCustomer(other));
    expect(theirs).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("changing only it leaves the record as it was; an empty value removes it; too long is refused", async () => {
    const mine = await review(author, {});
    expect(await stored(mine)).toBeNull();
    const before = await invoke("record.get", { object: REVIEW, id: mine }, context(admin));
    const changed = await call(
      "fixture.myUpdate",
      { object: REVIEW, id: mine, values: { feedback: "Later words" } },
      asCustomer(author),
    );
    expect(changed).toMatchObject({ ok: true, value: { values: { feedback: "Later words" } } });
    const after = await invoke("record.get", { object: REVIEW, id: mine }, context(admin));
    expect(after.updatedAt).toBe(before.updatedAt);
    await call(
      "fixture.myUpdate",
      { object: REVIEW, id: mine, values: { feedback: "" } },
      asCustomer(author),
    );
    expect(await stored(mine)).toBeNull();
    const long = await call(
      "fixture.myUpdate",
      { object: REVIEW, id: mine, values: { feedback: "x".repeat(4001) } },
      asCustomer(author),
    );
    expect(long).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(JSON.stringify(long)).not.toContain("xxxxxxxxxx");
  });
});

describe("no staff path but the restricted read reaches it", () => {
  it("record reads, writes, lists, query.sql, search, export and the audit hold none of it", async () => {
    const mine = await review(author, { feedback: SECRET });
    const got = await invoke("record.get", { object: REVIEW, id: mine }, context(admin));
    expect(JSON.stringify(got)).not.toContain(SECRET);
    await expect(
      invoke(
        "record.update",
        { object: REVIEW, id: mine, values: { feedback: "Staff words" } },
        context(admin),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      invoke(
        "record.list",
        { object: REVIEW, filter: { field: "feedback", op: "contains", value: "S" } },
        context(admin),
      ),
    ).rejects.toThrow();
    await expect(
      invoke("query.sql", { sql: "SELECT * FROM core_restricted_value" }, context(admin)),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const views = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'view' AND sql LIKE '%core_restricted_value%'",
    ).all();
    expect(views.results).toEqual([]);
    const found = await invoke("search.global", { query: SECRET }, context(admin));
    expect(JSON.stringify(found)).not.toContain(SECRET);
    const csv = await invoke("export.csv", { object: REVIEW }, context(admin));
    expect(csv.csv).not.toContain(SECRET);
    const audit = await env.DB.prepare(
      "SELECT operation FROM core_audit WHERE input LIKE ? OR result LIKE ? OR error LIKE ?",
    )
      .bind(`%${SECRET}%`, `%${SECRET}%`, `%${SECRET}%`)
      .all();
    expect(audit.results).toEqual([]);
    const changes = await env.DB.prepare("SELECT 1 FROM core_audit_changes WHERE diff LIKE ?")
      .bind(`%${SECRET}%`)
      .all();
    expect(changes.results).toEqual([]);
    const timeline = await env.DB.prepare(
      "SELECT 1 FROM core_activity WHERE coalesce(body, '') || payload LIKE ?",
    )
      .bind(`%${SECRET}%`)
      .all();
    expect(timeline.results).toEqual([]);
  });

  it("the pack's humanOnly tool naming the permission reads it, each read audited without values", async () => {
    const mine = await review(author, { feedback: SECRET });
    const empty = await review(other, {});
    const input = { object: REVIEW, field: "feedback", ids: [mine, empty, "rec_missing"] };
    const read = await invoke("record.readRestricted", input, asTool(personTool));
    expect(read.values).toEqual([
      { id: mine, value: SECRET },
      { id: empty, value: null },
    ]);
    const rows = await env.DB.prepare(
      "SELECT result FROM core_audit WHERE operation = 'record.readRestricted' AND outcome = 'ok'",
    ).all<{ result: string }>();
    expect(rows.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows.results)).toContain(mine);
    expect(JSON.stringify(rows.results)).not.toContain(SECRET);
  });

  it("refuses an AI, an approval, another pack, a tool not naming it, and any direct call", async () => {
    const mine = await review(author, { feedback: SECRET });
    const input = { object: REVIEW, field: "feedback", ids: [mine] };
    for (const t of [
      undefined,
      { ...personTool, humanOnly: false },
      { ...personTool, calledBy: { account: "user_x", actor: "assistant" } },
      { ...personTool, calledBy: undefined },
      { ...personTool, startedByApproval: true },
      { ...personTool, permission: `${id}:other` },
      { ...personTool, permission: null },
      // Naming another permission beside it opens the tool to a holder of that one (ADR 0600).
      { ...personTool, permission: [`${id}:other`, PERMISSION] },
    ]) {
      await expect(invoke("record.readRestricted", input, asTool(t))).rejects.toMatchObject({
        code: "forbidden",
      });
    }
    // Another pack, even one allowed to read the object.
    await expect(
      invoke("record.readRestricted", input, asTool(personTool, "otherpack")),
    ).rejects.toMatchObject({ code: "forbidden" });
    // A person, an assistant or MCP calling it directly.
    for (const actor of ["human", "assistant", "mcp"] as const) {
      await expect(
        invoke("record.readRestricted", input, context(admin, { actor })),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    // The audit of the refusals holds no value either.
    const audit = await env.DB.prepare(
      "SELECT 1 FROM core_audit WHERE result LIKE ? OR error LIKE ?",
    )
      .bind(`%${SECRET}%`, `%${SECRET}%`)
      .all();
    expect(audit.results).toEqual([]);
  });

  it("reads at most 50 records, in one JSON parameter however many", async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `rec_none_${i}`);
    const read = await invoke(
      "record.readRestricted",
      { object: REVIEW, field: "feedback", ids },
      asTool(personTool),
    );
    expect(read.values).toEqual([]);
    await expect(
      invoke(
        "record.readRestricted",
        { object: REVIEW, field: "feedback", ids: [...ids, "rec_51"] },
        asTool(personTool),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("erase, purge and drop", () => {
  it("erasing the author deletes their values; another's words naming them lose the terms", async () => {
    const email = `${unique("named")}@example.test`;
    const erased = (
      await invoke("person.create", { givenName: "Erin", emails: [{ email }] }, context(admin))
    ).id;
    const theirs = await review(erased, { feedback: SECRET });
    const about = await review(other, { feedback: `Spoke to ${email} about it` });
    await invoke("person.erase", { id: erased }, context(admin));
    expect(await stored(theirs)).toBeNull();
    const scrubbed = await stored(about);
    expect(scrubbed).not.toContain(email);
    expect(scrubbed).toContain("[erased]");
  });

  it("purging a Person from the Trash deletes the values they wrote", async () => {
    const gone = (await invoke("person.create", { givenName: "Pat" }, context(admin))).id;
    const theirs = await review(gone, { feedback: SECRET });
    await invoke("person.delete", { id: gone }, context(admin));
    await env.DB.prepare(
      "UPDATE core_person SET deleted_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
    )
      .bind(gone)
      .run();
    await runTrashPurge(db);
    expect(await stored(theirs)).toBeNull();
  });

  it("dropping the hidden field drops its values", async () => {
    const mine = await review(author, { feedback: SECRET });
    const o = objects();
    delete (o.review.fields as Record<string, unknown>).feedback;
    o.review.customer = { field: "person", read: ["words"], write: ["words"] };
    await reconcile(pack({ objects: o as never }));
    expect(getObject(REVIEW)?.restricted).toBeUndefined();
    // Hidden: kept, until dropped.
    expect(await stored(mine)).toBe(SECRET);
    const drop = await planDropHidden(db.query, id, {
      now: new Date().toISOString(),
      minAgeDays: 0,
    });
    await applyPlan((statements) => db.batch(statements), drop);
    await refreshSchemaRegistry(db.query);
    expect(await stored(mine)).toBeNull();
  });
});

describe("the review of PR #368", () => {
  const ext = extId("rvw");
  const perm = `${ext}:feedback`;
  const second = (name: string, renamedFrom?: string) =>
    manifest(ext, {
      grantable: [perm],
      restricted: [perm],
      objects: {
        [name]: {
          label: "Review",
          plural: "Reviews",
          titleField: "words",
          ...(renamedFrom ? { renamedFrom } : {}),
          fields: {
            words: { type: "text", label: "Words" },
            person: { type: "relation", label: "Person", to: "person" },
            coach: { type: "relation", label: "Coach", to: "person", required: true },
            feedback: { type: "longText", label: "Private feedback", restricted: perm },
          },
          customer: { field: "person", read: ["words", "feedback"], write: ["words", "feedback"] },
        },
      } as never,
    });
  const value = async (object: string, record: string) =>
    (
      await env.DB.prepare(
        "SELECT value FROM core_restricted_value WHERE object_type = ? AND record_id = ?",
      )
        .bind(object, record)
        .first<{ value: string }>()
    )?.value ?? null;
  const written = async (object: string, personId: string, coach: string) => {
    const made = await invoke(
      "record.create",
      { object, values: { words: "Fine", person: personId, coach } },
      context(admin),
    );
    const changed = await call(
      "fixture.myUpdate",
      { object, id: made.id, values: { feedback: SECRET } },
      asCustomer(personId),
    );
    expect(changed).toMatchObject({ ok: true });
    return made.id as string;
  };

  it("1: an object's rename takes its restricted values with it, and erase still reaches them", async () => {
    await reconcile(second("review"));
    const writer = (await invoke("person.create", { givenName: "Rhea" }, context(admin))).id;
    const coach = (await invoke("person.create", { givenName: "Cole" }, context(admin))).id;
    const record = await written(`${ext}.review`, writer, coach);
    await reconcile(second("rating", "review"));
    expect(await value(`${ext}.review`, record)).toBeNull();
    expect(await value(`${ext}.rating`, record)).toBe(SECRET);
    const got = await call(
      "fixture.myGet",
      { object: `${ext}.rating`, id: record },
      asCustomer(writer),
    );
    expect(got).toMatchObject({ ok: true, value: { values: { feedback: SECRET } } });
    await invoke("person.erase", { id: writer }, context(admin));
    expect(await value(`${ext}.rating`, record)).toBeNull();
  });

  it("2: a record erase deletes through a required relation loses its values, whoever wrote them", async () => {
    const object = `${ext}.rating`;
    const writer = (await invoke("person.create", { givenName: "Wren" }, context(admin))).id;
    const coach = (await invoke("person.create", { givenName: "Cass" }, context(admin))).id;
    const record = await written(object, writer, coach);
    await invoke("person.erase", { id: coach }, context(admin));
    const left = await env.DB.prepare(`SELECT count(*) AS n FROM x_${ext}_rating WHERE id = ?`)
      .bind(record)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
    expect(await value(object, record)).toBeNull();
  });
});
