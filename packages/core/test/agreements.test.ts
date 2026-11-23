// Stage 44 step 1 (ADRs 0610 and 0611): agreement documents, their working copy and versions.
// A published version is never changed or deleted, by an operation or by raw SQL; publishing,
// attaching, detaching and retiring are a person's act with agreements:manage (every AI actor is
// refused, not queued); the assistant may write the working copy, through the gate; every change
// to what is due bumps the counter step 2's guard reads; nothing reaches query.sql or the views.
// The document text here is fixture text, not wording anyone should use.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type Actor,
  type InvocationContext,
  invoke,
  PendingApprovalError,
  runAgreementsDue,
} from "../src/index.ts";
import { check, extId, manifest, reconcile } from "./extension-helpers.ts";
import { auditRows, context, createUser, db, setPreset, unique } from "./helpers.ts";

let admin: ActingUser;
let member: ActingUser;
const POINT = `pt${Date.now().toString(36)}`;

const body = (text: string) => ({
  blocks: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  // A fixture pack declaring one agreement point on a sellable object, and one on a booking.
  await reconcile(
    manifest(extId("agr"), {
      objects: {
        plan: {
          label: "Plan",
          plural: "Plans",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            price: { type: "currency", label: "Price", currency: "AUD" },
          },
          sellable: { price: "price" },
          agreements: { point: POINT, label: "Starting a plan", suggests: ["terms", "waiver"] },
        },
      },
    }),
  );
}, 60_000);

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a refusal");
}

const rev = async () =>
  (await env.DB.prepare("SELECT rev FROM core_agreement_rev WHERE id = 1").first<{ rev: number }>())
    ?.rev ?? -1;

const pendingCount = async () =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM core_pending_action").first<{ n: number }>())
    ?.n ?? 0;

/** A draft document with a publishable working copy. */
async function draftDocument(
  kind: "terms" | "waiver" | "health" | "guardian" | "other" = "waiver",
  by = admin,
) {
  const { id } = await invoke("agreement.create", { title: unique("Waiver"), kind }, context(by));
  const saved = await invoke(
    "agreement.draft.save",
    {
      id,
      body: body("Fixture text: not a real waiver."),
      tickLabel: "I have read this fixture",
      ...(kind === "health"
        ? { questions: [{ key: "heart", text: "Fixture question?", noteOnYes: true }] }
        : {}),
    },
    context(by),
  );
  return { id: id as string, hash: saved.hash as string };
}

const publish = (
  documentId: string,
  draftHash: string,
  extra: Record<string, unknown> = {},
  ctx: InvocationContext = context(admin),
) => invoke("agreement.publish", { documentId, draftHash, change: "small", ...extra }, ctx);

const AI_ACTORS: {
  actor: Actor;
  origin: InvocationContext["origin"];
  grantedPermissions?: never;
}[] = [
  { actor: "assistant", origin: { surface: "assistant", sessionId: "ath_agreements" } },
  {
    actor: "mcp",
    origin: { surface: "mcp", clientId: "c", clientName: "T", sessionId: "cap_agreements" },
  },
  { actor: "automation", origin: { surface: "automation", automationId: "x.y" } },
  { actor: "extension", origin: { surface: "extension", extensionId: "bookings" } },
];

describe("a published version is never changed or deleted", () => {
  it("is refused by the database for any update or delete, raw SQL included", async () => {
    const { id, hash } = await draftDocument();
    const { version } = await publish(id, hash);
    expect(version).toMatchObject({ number: 1, change: "first", publishedBy: admin.id });
    for (const statement of [
      "UPDATE core_agreement_version SET title = 'changed' WHERE id = ?",
      "UPDATE core_agreement_version SET body = '{}' WHERE id = ?",
      "UPDATE core_agreement_version SET hash = hash WHERE id = ?",
      "DELETE FROM core_agreement_version WHERE id = ?",
    ]) {
      await expect(env.DB.prepare(statement).bind(version.id).run()).rejects.toThrow(
        /core_agreement_version_immutable/,
      );
    }
    // Nor through a batch the host writes (the trigger is the same for every writer).
    await expect(
      db.batch([
        db.query
          .updateTable("core_agreement_version")
          .set({ title: "x" })
          .where("id", "=", version.id),
      ]),
    ).rejects.toThrow(/immutable/);
    // The document itself cannot be deleted either.
    await expect(
      env.DB.prepare("DELETE FROM core_agreement_document WHERE id = ?").bind(id).run(),
    ).rejects.toThrow(/immutable/);
    // A version cannot be inserted out of order, nor from a working copy that moved on.
    await expect(
      env.DB.prepare(
        `INSERT INTO core_agreement_version (id, document_id, number, title, body, tick_label, how,
           who, for_whom, change, effective_from, published_at, published_by, draft_rev, hash)
         SELECT 'agv_x', id, 3, 't', '{}', 'l', 'typed', 'participant', 'everyone', 'small',
           'now', 'now', 'usr', draft_rev, printf('%064d', 0) FROM core_agreement_document WHERE id = ?`,
      )
        .bind(id)
        .run(),
    ).rejects.toThrow(/core_agreement_draft_changed/);
    await expect(
      env.DB.prepare(
        `INSERT INTO core_agreement_version (id, document_id, number, title, body, tick_label, how,
           who, for_whom, change, effective_from, published_at, published_by, draft_rev, hash)
         SELECT 'agv_y', id, 2, 't', '{}', 'l', 'typed', 'participant', 'everyone', 'small',
           'now', 'now', 'usr', draft_rev + 1, printf('%064d', 0) FROM core_agreement_document WHERE id = ?`,
      )
        .bind(id)
        .run(),
    ).rejects.toThrow(/core_agreement_draft_changed/);
    // agree_from never goes back; the counter never goes back or away.
    await expect(
      env.DB.prepare("UPDATE core_agreement_document SET agree_from = 0 WHERE id = ?")
        .bind(id)
        .run(),
    ).rejects.toThrow(/agree_from_back/);
    await expect(env.DB.prepare("UPDATE core_agreement_rev SET rev = 0").run()).rejects.toThrow(
      /rev_back/,
    );
    await expect(env.DB.prepare("DELETE FROM core_agreement_rev").run()).rejects.toThrow(
      /rev_back/,
    );
    // And the version reads back exactly as published.
    const read = await invoke("agreement.version.get", { id: version.id }, context(member));
    expect(read).toEqual(version);
  });

  it("no operation changes one: a new save and publish make a new version beside it", async () => {
    const { id, hash } = await draftDocument();
    const first = (await publish(id, hash)).version;
    const saved = await invoke(
      "agreement.draft.save",
      { id, body: body("Fixture text, second wording.") },
      context(admin),
    );
    const second = (await publish(id, saved.hash, { change: "agree_again" })).version;
    expect(second).toMatchObject({ number: 2, change: "agree_again" });
    expect(await invoke("agreement.version.get", { id: first.id }, context(admin))).toEqual(first);
    const doc = await invoke("agreement.get", { id }, context(admin));
    expect(doc).toMatchObject({ state: "live", current: { id: second.id }, agreeFrom: 2 });
    expect(doc.versions.map((v: { number: number }) => v.number)).toEqual([2, 1]);
  });
});

describe("publishing is a person's", () => {
  it("every AI actor is refused publish, attach, detach and retire, and nothing is queued", async () => {
    await setPreset("cautious");
    try {
      const { id, hash } = await draftDocument();
      const before = await rev();
      const queued = await pendingCount();
      for (const extra of AI_ACTORS) {
        const ctx = context(admin, {
          ...extra,
          ...(extra.actor === "mcp"
            ? { grantedPermissions: ["records:read", "agreements:manage"] }
            : {}),
        });
        for (const [name, input] of [
          ["agreement.publish", { documentId: id, draftHash: hash, change: "small" }],
          ["agreement.attach", { documentId: id, points: [POINT] }],
          ["agreement.detach", { documentId: id, points: [POINT] }],
          ["agreement.retire", { documentId: id }],
        ] as const) {
          const refused = await refusal(invoke(name, input as never, ctx));
          expect(refused.code, `${name} by ${extra.actor}`).toBe("forbidden");
          expect(refused).not.toBeInstanceOf(PendingApprovalError);
        }
      }
      expect(await pendingCount()).toBe(queued);
      expect(await rev()).toBe(before);
      const doc = await invoke("agreement.get", { id }, context(admin));
      expect(doc).toMatchObject({ state: "draft", current: null, versions: [] });
      // Code Mode calls as the connected user's own actor (mcp): the same refusal, whatever the
      // token's scope.
      const code = await refusal(
        invoke(
          "agreement.publish",
          { documentId: id, draftHash: hash, change: "small" },
          context(admin, {
            actor: "mcp",
            origin: { surface: "mcp", clientId: "c", clientName: "Code", sessionId: "cap_code" },
            grantedPermissions: ["records:read", "records:write", "agreements:manage"],
          }),
        ),
      );
      expect(code.code).toBe("forbidden");
    } finally {
      await setPreset("balanced");
    }
  });

  it("a person without agreements:manage is refused; granted, a member publishes", async () => {
    const { id, hash } = await draftDocument();
    expect(await refusal(publish(id, hash, {}, context(member)))).toMatchObject({
      code: "forbidden",
      details: { permission: "agreements:manage" },
    });
    expect(
      await refusal(invoke("agreement.create", { title: "x", kind: "terms" }, context(member))),
    ).toMatchObject({ code: "forbidden" });
    await invoke(
      "user.setPermissions",
      { id: member.id, permissions: ["agreements:manage"] },
      context(admin),
    );
    try {
      const { version } = await publish(id, hash, {}, context(member));
      expect(version.publishedBy).toBe(member.id);
    } finally {
      await invoke("user.setPermissions", { id: member.id, permissions: [] }, context(admin));
    }
    // A customer or the public cannot reach any of it: staff audience only.
    const { audiencesOf } = await import("../src/audiences.ts");
    const { coreOperations } = await import("../src/index.ts");
    for (const op of coreOperations.filter((o) => o.name.startsWith("agreement."))) {
      expect(audiencesOf(op), op.name).toEqual(["staff"]);
    }
  });

  it("the assistant writes the working copy through the gate; its dry run changes nothing", async () => {
    const { id } = await draftDocument();
    const assistant = context(admin, {
      actor: "assistant",
      origin: { surface: "assistant", sessionId: unique("ath") },
    });
    const made = await invoke(
      "agreement.create",
      { title: unique("Draft"), kind: "terms" },
      assistant,
    );
    expect(made.id).toMatch(/^agd_/);
    const saved = await invoke(
      "agreement.draft.save",
      { id, tickLabel: "Fixture label by the assistant" },
      assistant,
    );
    expect(saved.tickLabel).toBe("Fixture label by the assistant");
    // Under a cautious policy the same write waits for a person, and its simulation writes nothing.
    await setPreset("cautious");
    try {
      const before = await invoke("agreement.get", { id }, context(admin));
      const error = await refusal(
        invoke("agreement.draft.save", { id, tickLabel: "Queued fixture label" }, assistant),
      );
      expect(error).toBeInstanceOf(PendingApprovalError);
      const after = await invoke("agreement.get", { id }, context(admin));
      expect(after.draft).toEqual(before.draft);
      const actionId = (error as unknown as PendingApprovalError).pending.actionId;
      await invoke("approval.approve", { actionIds: [actionId] }, context(admin));
      const approved = await invoke("agreement.get", { id }, context(admin));
      expect(approved.draft.tickLabel).toBe("Queued fixture label");
      expect(approved.versions).toEqual([]);
    } finally {
      await setPreset("balanced");
    }
  });

  it("publishes only the working copy the person reviewed", async () => {
    const { id, hash } = await draftDocument();
    // The assistant changes the copy after the person looked at it.
    await invoke(
      "agreement.draft.save",
      { id, tickLabel: "Changed meanwhile" },
      context(admin, { actor: "assistant", origin: { surface: "assistant", sessionId: "ath_x" } }),
    );
    expect(await refusal(publish(id, hash))).toMatchObject({
      code: "conflict",
      details: { rule: "agreement_draft_changed" },
    });
    const preview = await invoke("agreement.publishPreview", { id }, context(admin));
    expect(preview).toMatchObject({ number: 1, first: true, problems: [] });
    expect((await publish(id, preview.draftHash)).version.tickLabel).toBe("Changed meanwhile");
  });

  it("refuses an incomplete copy, questions on a non-health form, and a retired document", async () => {
    const { id } = await invoke(
      "agreement.create",
      { title: unique("Bare"), kind: "terms" },
      context(admin),
    );
    const preview = await invoke("agreement.publishPreview", { id }, context(admin));
    expect(preview.problems.length).toBe(2);
    expect(await refusal(publish(id, preview.draftHash))).toMatchObject({ code: "invalid_input" });
    expect(
      await refusal(
        invoke(
          "agreement.draft.save",
          { id, questions: [{ key: "q", text: "Fixture?" }] },
          context(admin),
        ),
      ),
    ).toMatchObject({ code: "invalid_input" });
    // A body with an embed cannot be a signed document; a body must be the rich text schema.
    expect(
      await refusal(
        invoke(
          "agreement.draft.save",
          { id, body: { blocks: [{ type: "divider" }, { type: "nonsense" }] } },
          context(admin),
        ),
      ),
    ).toMatchObject({ code: "invalid_input" });
    const health = await draftDocument("health");
    const published = await publish(health.id, health.hash);
    expect(published.version.questions).toEqual([
      { key: "heart", text: "Fixture question?", noteOnYes: true },
    ]);
    await invoke("agreement.retire", { documentId: health.id }, context(admin));
    expect(
      await refusal(
        invoke("agreement.draft.save", { id: health.id, tickLabel: "x" }, context(admin)),
      ),
    ).toMatchObject({ code: "conflict" });
    const again = await invoke("agreement.publishPreview", { id: health.id }, context(admin));
    expect(await refusal(publish(health.id, again.draftHash))).toMatchObject({ code: "conflict" });
    // Even host code cannot change a retired document.
    await expect(
      env.DB.prepare("UPDATE core_agreement_document SET state = 'live' WHERE id = ?")
        .bind(health.id)
        .run(),
    ).rejects.toThrow(/core_agreement_retired/);
  });
});

describe("effective dates, attaching and the counter", () => {
  it("schedules a version; the cron makes it current at its time and bumps the counter", async () => {
    const { id, hash } = await draftDocument();
    const r0 = await rev();
    const first = (await publish(id, hash)).version;
    expect(await rev()).toBe(r0 + 1);
    const later = new Date(Date.now() + 3_600_000).toISOString();
    expect(
      await refusal(
        publish(id, (await invoke("agreement.publishPreview", { id }, context(admin))).draftHash, {
          effectiveFrom: new Date(Date.now() - 3_600_000).toISOString(),
        }),
      ),
    ).toMatchObject({ code: "invalid_input", details: { rule: "agreement_effective_past" } });
    const saved = await invoke(
      "agreement.draft.save",
      { id, body: body("Fixture v2") },
      context(admin),
    );
    const second = (await publish(id, saved.hash, { change: "agree_again", effectiveFrom: later }))
      .version;
    expect(await rev()).toBe(r0 + 2);
    let doc = await invoke("agreement.get", { id }, context(admin));
    expect(doc).toMatchObject({
      current: { id: first.id },
      scheduled: { id: second.id },
      agreeFrom: 1,
    });
    // A newer version cannot take effect before the scheduled one.
    const v3 = await invoke(
      "agreement.draft.save",
      { id, body: body("Fixture v3") },
      context(admin),
    );
    expect(await refusal(publish(id, v3.hash))).toMatchObject({
      details: { rule: "agreement_effective_order" },
    });
    // Before its time the cron changes nothing; at its time it makes it current, once.
    expect((await runAgreementsDue(db)).documents).toBeGreaterThanOrEqual(0);
    doc = await invoke("agreement.get", { id }, context(admin));
    expect(doc.current?.id).toBe(first.id);
    const r1 = await rev();
    const at = new Date(Date.now() + 2 * 3_600_000);
    expect((await runAgreementsDue(db, { clock: () => at })).documents).toBeGreaterThanOrEqual(1);
    expect(await rev()).toBe(r1 + 1);
    doc = await invoke("agreement.get", { id }, context(admin, { clock: () => at }));
    expect(doc).toMatchObject({ current: { id: second.id }, scheduled: null, agreeFrom: 2 });
    expect((await runAgreementsDue(db, { clock: () => at })).documents).toBe(0);
    expect(await rev()).toBe(r1 + 1);
    // Only the host's own cron may call it.
    expect(await refusal(invoke("agreement.takeEffect", {}, context(admin)))).toMatchObject({
      code: "forbidden",
    });
    expect(
      await refusal(
        invoke(
          "agreement.takeEffect",
          {},
          context(admin, {
            actor: "automation",
            origin: { surface: "automation", automationId: "x.y" },
          }),
        ),
      ),
    ).toMatchObject({ code: "forbidden" });
  });

  it("attaches a live document to a declared point only; detach and retire bump the counter", async () => {
    const points = await invoke("agreement.points", {}, context(member));
    expect(points.items.find((p: { point: string }) => p.point === POINT)).toMatchObject({
      label: "Starting a plan",
      suggests: ["terms", "waiver"],
    });
    const { id, hash } = await draftDocument();
    expect(
      await refusal(
        invoke("agreement.attach", { documentId: id, points: [POINT] }, context(admin)),
      ),
    ).toMatchObject({ code: "conflict", details: { rule: "agreement_not_live" } });
    // The database refuses it too.
    await expect(
      env.DB.prepare(
        "INSERT INTO core_agreement_point (document_id, point, attached_at, attached_by) VALUES (?, ?, 'now', 'usr')",
      )
        .bind(id, POINT)
        .run(),
    ).rejects.toThrow(/core_agreement_not_live/);
    await publish(id, hash);
    expect(
      await refusal(
        invoke("agreement.attach", { documentId: id, points: ["nowhere"] }, context(admin)),
      ),
    ).toMatchObject({ code: "invalid_input", details: { rule: "agreement_point" } });
    const r0 = await rev();
    const attached = await invoke(
      "agreement.attach",
      { documentId: id, points: [POINT] },
      context(admin),
    );
    expect(attached.points).toEqual([POINT]);
    expect(await rev()).toBe(r0 + 1);
    expect(
      await refusal(
        invoke("agreement.attach", { documentId: id, points: [POINT] }, context(admin)),
      ),
    ).toMatchObject({ code: "conflict" });
    const detached = await invoke(
      "agreement.detach",
      { documentId: id, points: [POINT] },
      context(admin),
    );
    expect(detached.points).toEqual([]);
    expect(await rev()).toBe(r0 + 2);
    await invoke("agreement.attach", { documentId: id, points: [POINT] }, context(admin));
    const retired = await invoke("agreement.retire", { documentId: id }, context(admin));
    expect(retired).toMatchObject({ state: "retired", points: [] });
    expect(await rev()).toBe(r0 + 4);
    const listed = await invoke("agreement.list", {}, context(admin));
    expect(listed.items.some((d: { id: string }) => d.id === id)).toBe(false);
    const all = await invoke("agreement.list", { retired: true }, context(admin));
    expect(all.items.find((d: { id: string }) => d.id === id)).toMatchObject({ state: "retired" });
  });

  it("each act is audited, a person's own", async () => {
    const { id, hash } = await draftDocument();
    await publish(id, hash);
    const rows = await auditRows("agreement.publish", admin.id);
    const row = rows.at(-1) as Record<string, unknown>;
    expect(row).toMatchObject({ actor: "human", outcome: "ok" });
    expect(JSON.parse(String(row.result))).toMatchObject({
      documentId: id,
      number: 1,
      change: "first",
    });
  });
});

describe("what reaches bulk paths", () => {
  it("query.sql, and so dashboards, cannot read any agreement table, and no view names one", async () => {
    for (const table of [
      "core_agreement_document",
      "core_agreement_version",
      "core_agreement_point",
      "core_agreement_rev",
    ]) {
      expect(
        await refusal(invoke("query.sql", { sql: `SELECT * FROM ${table}` }, context(admin))),
      ).toMatchObject({ code: "invalid_input" });
    }
    const views = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'view' AND sql LIKE '%core_agreement%'",
    ).all();
    expect(views.results).toEqual([]);
    const { id } = await draftDocument();
    const found = await invoke("search.global", { query: "Fixture text" }, context(admin));
    expect(JSON.stringify(found)).not.toContain(id);
  });
});

describe("the agreements declaration (inert in step 1)", () => {
  it("checks a point's name, its states and its person", async () => {
    const bad = manifest(extId("agb"), {
      objects: {
        thing: {
          label: "Thing",
          plural: "Things",
          titleField: "name",
          fields: { name: { type: "text", label: "Name" } },
          agreements: { point: "Not A Word", label: "Somewhere", enter: ["booked"] },
        },
      },
    });
    const result = await check(bad);
    const paths = JSON.stringify(result);
    expect(paths).toContain("objects.thing.agreements.point");
    expect(paths).toContain("objects.thing.agreements.enter");
    expect(paths).toContain("objects.thing.agreements.person");
  });
});
