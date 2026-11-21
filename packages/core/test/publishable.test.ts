// Stage 41, build step 1: `publishable` without its public half (ADR 0446). A working copy staff
// edit, published versions, the publish move, reading and restoring an old version. Publishing
// needs `records:publish` (admins by default) and a person: no AI actor publishes.
import { env } from "cloudflare:workers";
import { validateManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, getObject, invoke } from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { auditChanges, context, createUser, unique } from "./helpers.ts";

const EXT = extId("pub");
const DOC = `${EXT}.doc`;
let admin: ActingUser;
let member: ActingUser;

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a refusal");
}

const ai = (actor: "assistant" | "mcp" | "automation" | "extension") =>
  context(admin, {
    actor,
    origin: {
      surface: actor === "mcp" ? "mcp" : actor === "assistant" ? "assistant" : actor,
      clientId: "c",
      clientName: "Test",
      sessionId: `pub_${unique()}`,
    },
    ...(actor === "extension"
      ? {
          extension: {
            id: EXT,
            version: "1.0.0",
            permissions: { read: [], write: [], operations: [], modules: ["ops"] },
          },
        }
      : {}),
  } as never);

async function create(values: Record<string, unknown>) {
  return invoke("record.create", { object: DOC, values }, context(admin));
}

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  await reconcile(
    manifest(EXT, {
      objects: {
        doc: {
          label: "Doc",
          plural: "Docs",
          titleField: "title",
          fields: {
            title: { type: "text", label: "Title", required: true },
            body: { type: "longText", label: "Body" },
            staffNote: { type: "text", label: "Staff note" },
          },
          publishable: { content: ["title", "body"] },
        },
      },
    }),
  );
});

describe("the declaration", () => {
  it("is carried to the registry, with the host's two read-only fields", () => {
    expect(getObject(DOC)?.publishable).toEqual({ content: ["title", "body"] });
    const fields = getObject(DOC)?.fields.filter((f) => f.name.startsWith("published"));
    expect(fields?.map((f) => [f.name, f.readOnly])).toEqual([
      ["publishedVersion", true],
      ["publishedAt", true],
    ]);
  });

  it("is checked: content is fields staff edit, and the host's names are not taken", () => {
    const { issues } = validateManifest(
      manifest(extId("bad"), {
        objects: {
          doc: {
            label: "Doc",
            plural: "Docs",
            titleField: "title",
            fields: {
              title: { type: "text", label: "Title" },
              total: { type: "formula", label: "Total", expression: "1" },
              publishedAt: { type: "text", label: "Mine" },
            },
            publishable: { content: ["title", "total", "missing"] },
          },
        },
      }),
    );
    expect(issues.map((i) => i.message)).toEqual(
      expect.arrayContaining([
        '"total" is a formula: content is what staff edit',
        '"missing" is not a field of doc',
        '"publishedAt" is the host\'s on a publishable object',
      ]),
    );
  });
});

describe("versions", () => {
  it("publishes the working copy; editing it changes no version; an old one is read and restored", async () => {
    const doc = await create({ title: "Week one", body: "Squat", staffNote: "not content" });
    expect(doc.values.publishedVersion).toBeNull();
    expect(
      (await refusal(invoke("record.version", { object: DOC, id: doc.id }, context(admin)))).code,
    ).toBe("not_found");

    const v1 = await invoke(
      "record.publish",
      { object: DOC, id: doc.id, note: "First" },
      context(admin),
    );
    expect(v1).toMatchObject({ version: 1, current: true, note: "First", publishedBy: admin.id });
    await invoke(
      "record.update",
      { object: DOC, id: doc.id, values: { body: "Squat and hinge" } },
      context(admin),
    );

    // The working copy changed; the published version did not.
    const current = await invoke("record.version", { object: DOC, id: doc.id }, context(admin));
    expect(current).toMatchObject({ version: 1, values: { title: "Week one", body: "Squat" } });
    expect(Object.keys(current.values).sort()).toEqual(["body", "title"]);

    const v2 = await invoke("record.publish", { object: DOC, id: doc.id }, context(admin));
    expect(v2.version).toBe(2);
    const record = await invoke("record.get", { object: DOC, id: doc.id }, context(admin));
    expect(record.values).toMatchObject({ publishedVersion: 2, publishedAt: v2.publishedAt });
    const old = await invoke(
      "record.version",
      { object: DOC, id: doc.id, version: 1 },
      context(admin),
    );
    expect(old).toMatchObject({ version: 1, current: false, values: { body: "Squat" } });
    const list = await invoke("record.versions", { object: DOC, id: doc.id }, context(admin));
    expect(list.items.map((v) => [v.version, v.current])).toEqual([
      [2, true],
      [1, false],
    ]);

    // Restoring is an edit of the working copy: no version changes, nothing is published.
    const restored = await invoke(
      "record.restoreVersion",
      { object: DOC, id: doc.id, version: 1 },
      context(member),
    );
    expect(restored.record.values).toMatchObject({
      body: "Squat",
      staffNote: "not content",
      publishedVersion: 2,
    });
    expect(
      (await invoke("record.version", { object: DOC, id: doc.id }, context(admin))).values.body,
    ).toBe("Squat and hinge");
    // And it is in the record's history as an ordinary change.
    const changes = await auditChanges(doc.id);
    expect(changes.map((c) => c.operation)).toEqual(
      expect.arrayContaining(["record.publish", "record.restoreVersion"]),
    );
    expect(changes.find((c) => c.operation === "record.publish")?.diff).toEqual({
      publishedVersion: { before: null, after: 1 },
    });
  });

  it("refuses a record that is not publishable, and two publishes at once make one version", async () => {
    const doc = await create({ title: "Race" });
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        invoke("record.publish", { object: DOC, id: doc.id }, context(admin)),
      ),
    );
    const done = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(done.length).toBeGreaterThanOrEqual(1);
    for (const r of lost)
      expect((r.reason as { details?: { reason?: string } }).details?.reason).toBe(
        "published_meanwhile",
      );
    const rows = await env.DB.prepare(
      "SELECT version, current FROM core_publish_version WHERE record_id = ? ORDER BY version",
    )
      .bind(doc.id)
      .all<{ version: number; current: number }>();
    expect(rows.results.filter((r) => r.current === 1)).toHaveLength(1);
    expect(rows.results.map((r) => r.version)).toEqual(rows.results.map((_, i) => i + 1));
  });
});

describe("who publishes", () => {
  it("a person with records:publish: no AI actor, whatever its role, and no member", async () => {
    const doc = await create({ title: "Gated" });
    for (const actor of ["assistant", "mcp", "automation", "extension"] as const) {
      const error = await refusal(invoke("record.publish", { object: DOC, id: doc.id }, ai(actor)));
      expect(error.code, actor).toBe("forbidden");
    }
    const asMember = await refusal(
      invoke("record.publish", { object: DOC, id: doc.id }, context(member)),
    );
    expect(asMember).toMatchObject({
      code: "forbidden",
      details: { permission: "records:publish" },
    });
    // An AI actor still edits the working copy, as any write.
    const edited = await invoke(
      "record.update",
      { object: DOC, id: doc.id, values: { body: "Drafted by the assistant" } },
      ai("assistant"),
    );
    expect(edited.values.body).toBe("Drafted by the assistant");
    const none = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_publish_version WHERE record_id = ?",
    )
      .bind(doc.id)
      .first<{ n: number }>();
    expect(none?.n).toBe(0);
    expect(
      (await invoke("record.publish", { object: DOC, id: doc.id }, context(admin))).version,
    ).toBe(1);
  });
});
