// Stage 44 step 1 (ADRs 0640 and 0641): agreement documents, their working copy and versions.
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

/** The working copy's rev now (a publish names the rev it reviewed, as well as the hash). */
const draftRev = async (id: string) =>
  (await invoke("agreement.get", { id }, context(admin))).draft.rev as number;

/** The number a publish makes now (a publish names the number its preview showed). */
const nextNumber = async (id: string) =>
  (await invoke("agreement.get", { id }, context(admin))).versions.length + 1;

const publish = async (
  documentId: string,
  draftHash: string,
  extra: Record<string, unknown> = {},
  ctx: InvocationContext = context(admin),
) =>
  invoke(
    "agreement.publish",
    {
      documentId,
      draftHash,
      draftRev: await draftRev(documentId),
      number: await nextNumber(documentId),
      change: "small",
      ...extra,
    },
    ctx,
  );

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
          [
            "agreement.publish",
            { documentId: id, draftHash: hash, draftRev: 1, number: 1, change: "small" },
          ],
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
          { documentId: id, draftHash: hash, draftRev: 1, number: 1, change: "small" },
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
    // A customer or the public cannot reach any of it: staff audience only. The one exception is
    // the words of what a visitor is asked (stage 44 step 5), a read of published text.
    const { audiencesOf } = await import("../src/audiences.ts");
    const { coreOperations } = await import("../src/index.ts");
    for (const op of coreOperations.filter((o) => o.name.startsWith("agreement."))) {
      expect(audiencesOf(op), op.name).toEqual(
        op.name === "agreement.guestVersions" ? ["customer", "public"] : ["staff"],
      );
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

// The security review of PR #266: each of these failed before its fix.
const AI = () =>
  context(admin, {
    actor: "assistant",
    origin: { surface: "assistant", sessionId: unique("ath") },
  });

describe("the publish pins every term, not only the words (review A1)", () => {
  it("an AI change to who, for whom, how or ask-again after the preview is refused", async () => {
    const health = await draftDocument("health");
    const preview = await invoke("agreement.publishPreview", { id: health.id }, context(admin));
    expect(preview.snapshot).toMatchObject({
      kind: "health",
      who: "participant",
      forWhom: "everyone",
    });
    for (const change of [
      { forWhom: "dependants" },
      { who: "payer" },
      { how: "drawn" },
      { askAgainMonths: 120 },
    ]) {
      const before = await invoke("agreement.publishPreview", { id: health.id }, context(admin));
      await invoke("agreement.draft.save", { id: health.id, ...change } as never, AI());
      const refused = await refusal(
        invoke(
          "agreement.publish",
          {
            documentId: health.id,
            draftHash: before.draftHash,
            draftRev: before.draftRev,
            number: before.number,
            change: "small",
          },
          context(admin),
        ),
      );
      expect(refused, JSON.stringify(change)).toMatchObject({
        code: "conflict",
        details: { rule: "agreement_draft_changed" },
      });
    }
    expect((await invoke("agreement.get", { id: health.id }, context(admin))).versions).toEqual([]);
  });

  it("a second version's preview lists every changed field, and a flipped term is refused", async () => {
    const { id, hash } = await draftDocument();
    await publish(id, hash);
    await invoke("agreement.draft.save", { id, body: body("Fixture v2 text") }, context(admin));
    const preview = await invoke("agreement.publishPreview", { id }, context(admin));
    expect(preview.changed).toEqual(["body"]);
    await invoke("agreement.draft.save", { id, forWhom: "dependants" }, AI());
    expect(
      await refusal(
        invoke(
          "agreement.publish",
          {
            documentId: id,
            draftHash: preview.draftHash,
            draftRev: preview.draftRev,
            number: preview.number,
            change: "small",
          },
          context(admin),
        ),
      ),
    ).toMatchObject({ code: "conflict" });
    const again = await invoke("agreement.publishPreview", { id }, context(admin));
    expect(again.changed).toEqual(["body", "forWhom"]);
    // The same hash with a moved rev is refused too (a save that changed nothing).
    await invoke("agreement.draft.save", { id }, AI());
    expect(
      await refusal(
        invoke(
          "agreement.publish",
          {
            documentId: id,
            draftHash: again.draftHash,
            draftRev: again.draftRev,
            number: again.number,
            change: "small",
          },
          context(admin),
        ),
      ),
    ).toMatchObject({ code: "conflict" });
  });

  it("saves are compare-and-set on the rev: two saves of one rev never both apply", async () => {
    const { id } = await draftDocument();
    const rev0 = await draftRev(id);
    await invoke(
      "agreement.draft.save",
      { id, draftRev: rev0, tickLabel: "First" },
      context(admin),
    );
    expect(
      await refusal(
        invoke("agreement.draft.save", { id, draftRev: rev0, tickLabel: "Second" }, AI()),
      ),
    ).toMatchObject({ code: "conflict", details: { rule: "agreement_draft_changed" } });
    // In the database: a save planned from an old rev (the same new value) is refused.
    await expect(
      env.DB.prepare("UPDATE core_agreement_document SET draft_rev = ? WHERE id = ?")
        .bind(rev0 + 1, id)
        .run(),
    ).rejects.toThrow(/core_agreement_draft_changed/);
    const doc = await invoke("agreement.get", { id }, context(admin));
    expect(doc.draft).toMatchObject({ tickLabel: "First", rev: rev0 + 1, updatedVia: "human" });
    await invoke("agreement.draft.save", { id, tickLabel: "By the AI" }, AI());
    expect((await invoke("agreement.get", { id }, context(admin))).draft.updatedVia).toBe(
      "assistant",
    );
  });
});

describe("raw SQL cannot forge or rewind (review A2)", () => {
  it("INSERT OR REPLACE cannot replace a version, a document or the counter", async () => {
    const { id, hash } = await draftDocument();
    const { version } = await publish(id, hash);
    await expect(
      env.DB.prepare(
        `INSERT OR REPLACE INTO core_agreement_version (id, document_id, number, title, body,
           tick_label, how, who, for_whom, change, effective_from, published_at, published_by,
           draft_rev, hash)
         SELECT id, document_id, number, 'forged', body, tick_label, how, who, for_whom, change,
           effective_from, published_at, published_by, draft_rev, hash
         FROM core_agreement_version WHERE id = ?`,
      )
        .bind(version.id)
        .run(),
    ).rejects.toThrow(/immutable/);
    await expect(
      env.DB.prepare("INSERT OR REPLACE INTO core_agreement_rev (id, rev) VALUES (1, 0)").run(),
    ).rejects.toThrow(/rev_back/);
    await invoke("agreement.retire", { documentId: id }, context(admin));
    await expect(
      env.DB.prepare(
        `INSERT OR REPLACE INTO core_agreement_document (id, kind, state, draft_title,
           draft_updated_at, draft_updated_by, created_at, created_by, agree_from)
         VALUES (?, 'waiver', 'live', 'revived', 'now', 'usr', 'now', 'usr', 0)`,
      )
        .bind(id)
        .run(),
    ).rejects.toThrow(/immutable/);
    expect(await invoke("agreement.version.get", { id: version.id }, context(admin))).toMatchObject(
      { title: version.title, intact: true },
    );
    expect((await invoke("agreement.get", { id }, context(admin))).state).toBe("retired");
  });

  it("refuses a forged version, a rewound current version, a state back, a kind change", async () => {
    const { id, hash } = await draftDocument();
    const first = (await publish(id, hash)).version;
    const saved = await invoke(
      "agreement.draft.save",
      { id, body: body("Fixture v2") },
      context(admin),
    );
    const second = (await publish(id, saved.hash)).version;
    // A forged next version: the right rev and number, made-up content.
    await expect(
      env.DB.prepare(
        `INSERT INTO core_agreement_version (id, document_id, number, title, body, tick_label, how,
           who, for_whom, change, effective_from, published_at, published_by, draft_rev, hash)
         SELECT 'agv_forged', id, 3, 'Made up', '{"blocks":[]}', draft_tick_label, draft_how,
           draft_who, draft_for, 'small', 'now', 'now', 'usr', draft_rev, printf('%064d', 0)
         FROM core_agreement_document WHERE id = ?`,
      )
        .bind(id)
        .run(),
    ).rejects.toThrow(/core_agreement_draft_changed/);
    for (const statement of [
      "UPDATE core_agreement_document SET current_version_id = NULL WHERE id = ?",
      `UPDATE core_agreement_document SET current_version_id = '${first.id}' WHERE id = ?`,
    ]) {
      await expect(env.DB.prepare(statement).bind(id).run()).rejects.toThrow(/agree_from_back/);
    }
    await expect(
      env.DB.prepare("UPDATE core_agreement_document SET state = 'draft' WHERE id = ?")
        .bind(id)
        .run(),
    ).rejects.toThrow(/document_fixed/);
    await expect(
      env.DB.prepare("UPDATE core_agreement_document SET kind = 'terms' WHERE id = ?")
        .bind(id)
        .run(),
    ).rejects.toThrow(/document_fixed/);
    // A new document cannot be inserted already live or with something in effect.
    await expect(
      env.DB.prepare(
        `INSERT INTO core_agreement_document (id, kind, state, draft_title, draft_updated_at,
           draft_updated_by, created_at, created_by) VALUES ('agd_forged', 'waiver', 'live', 't',
           'now', 'usr', 'now', 'usr')`,
      ).run(),
    ).rejects.toThrow(/document_new/);
    expect((await invoke("agreement.get", { id }, context(admin))).current?.id).toBe(second.id);
  });

  it("a version whose content matches but whose hash was forged reads as not intact", async () => {
    const { id } = await draftDocument();
    // Content copied from the working copy, so the trigger lets it in; SQLite cannot hash.
    await env.DB.prepare(
      `INSERT INTO core_agreement_version (id, document_id, number, title, body, tick_label,
         questions, how, who, for_whom, ask_again_months, change, effective_from, published_at,
         published_by, draft_rev, hash)
       SELECT 'agv_badhash', id, 1, draft_title, draft_body, draft_tick_label, draft_questions,
         draft_how, draft_who, draft_for, draft_ask_again_months, 'first', 'now', 'now', 'usr',
         draft_rev, printf('%064d', 0) FROM core_agreement_document WHERE id = ?`,
    )
      .bind(id)
      .run();
    expect(
      await invoke("agreement.version.get", { id: "agv_badhash" }, context(admin)),
    ).toMatchObject({ intact: false });
    const real = await draftDocument();
    const { version } = await publish(real.id, real.hash);
    expect(version.intact).toBe(true);
    expect((await invoke("agreement.version.get", { id: version.id }, context(admin))).intact).toBe(
      true,
    );
  });
});

describe("content the hash cannot pin is refused (review A4, A5)", () => {
  const save = (id: string, input: Record<string, unknown>) =>
    refusal(invoke("agreement.draft.save", { id, ...input }, context(admin)));

  it("no pictures; a link's text is its own address", async () => {
    const { id } = await draftDocument();
    expect(
      await save(id, {
        body: { blocks: [{ type: "image", media: "med_01ABCDEFGHJKMNPQRSTVWXYZ00", alt: "x" }] },
      }),
    ).toMatchObject({ code: "invalid_input" });
    expect(
      await save(id, {
        body: {
          blocks: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "our policy", href: "https://example.test/p" }],
            },
          ],
        },
      }),
    ).toMatchObject({ code: "invalid_input" });
    const ok = await invoke(
      "agreement.draft.save",
      {
        id,
        body: {
          blocks: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Fixture, see " },
                { type: "text", text: "https://example.test/p", href: "https://example.test/p" },
              ],
            },
          ],
        },
      },
      context(admin),
    );
    expect(ok.rev).toBeGreaterThan(0);
  });

  it("no text made only of zero-width characters; no bidirectional controls", async () => {
    const { id } = await draftDocument();
    expect(await save(id, { title: "\u200b\u200c\u2060" })).toMatchObject({
      code: "invalid_input",
    });
    expect(await save(id, { tickLabel: "I agree \u202e" })).toMatchObject({
      code: "invalid_input",
    });
    expect(await save(id, { title: "Waiver \u2066x\u2069" })).toMatchObject({
      code: "invalid_input",
    });
    expect(await save(id, { body: body("Fixture \u202d text") })).toMatchObject({
      code: "invalid_input",
    });
    const health = await draftDocument("health");
    expect(
      await save(health.id, { questions: [{ key: "q", text: "Fixture\u202e?" }] }),
    ).toMatchObject({
      code: "invalid_input",
    });
    // A body of zero-width characters only is not text: it cannot be published.
    await invoke("agreement.draft.save", { id, body: body("\u200b\u200b") }, context(admin));
    const preview = await invoke("agreement.publishPreview", { id }, context(admin));
    expect(preview.problems).toContain("The body has no text");
  });

  it("retiring cancels a scheduled version visibly; a document not yet in force is not attached", async () => {
    const { id, hash } = await draftDocument();
    const later = new Date(Date.now() + 3_600_000).toISOString();
    await publish(id, hash, { effectiveFrom: later });
    expect(
      await refusal(
        invoke("agreement.attach", { documentId: id, points: [POINT] }, context(admin)),
      ),
    ).toMatchObject({ code: "conflict", details: { rule: "agreement_not_in_force" } });
    const retired = await invoke("agreement.retire", { documentId: id }, context(admin));
    expect(retired.scheduled).toBeNull();
    const doc = await invoke("agreement.get", { id }, context(admin));
    expect(doc.scheduled).toBeNull();
    expect(doc.versions[0]?.status).toBe("never_in_force");
    // And the cron never makes it current.
    await runAgreementsDue(db, { clock: () => new Date(Date.now() + 2 * 3_600_000) });
    expect((await invoke("agreement.get", { id }, context(admin))).current).toBeNull();
  });
});

// Round two of the review of PR #266: each of these failed before its fix.
describe("a reviewed snapshot publishes once, as the version it showed (review B1)", () => {
  it("the same hash, rev and number cannot publish twice; a version landing in between is refused", async () => {
    const { id } = await draftDocument();
    const preview = await invoke("agreement.publishPreview", { id }, context(admin));
    const input = {
      documentId: id,
      draftHash: preview.draftHash,
      draftRev: preview.draftRev,
      number: preview.number,
      change: "agree_again" as const,
    };
    await invoke("agreement.publish", input, context(admin));
    expect(await refusal(invoke("agreement.publish", input, context(admin)))).toMatchObject({
      code: "conflict",
    });
    // The rev moved in the publish's batch: the same rev with a new number is refused too.
    expect(
      await refusal(invoke("agreement.publish", { ...input, number: 2 }, context(admin))),
    ).toMatchObject({ code: "conflict" });
    expect((await invoke("agreement.get", { id }, context(admin))).versions.length).toBe(1);
  });

  it("a preview of 'version 1' is refused once version 1 exists", async () => {
    const { id } = await draftDocument();
    const shown = await invoke("agreement.publishPreview", { id }, context(admin));
    expect(shown).toMatchObject({ number: 1, first: true });
    // Someone else publishes, then changes the copy so a publish would otherwise make version 2.
    await publish(id, shown.draftHash);
    const saved = await invoke(
      "agreement.draft.save",
      { id, body: body("Fixture v2") },
      context(admin),
    );
    expect(
      await refusal(
        invoke(
          "agreement.publish",
          {
            documentId: id,
            draftHash: saved.hash,
            draftRev: saved.rev,
            number: shown.number,
            change: "small",
          },
          context(admin),
        ),
      ),
    ).toMatchObject({ code: "conflict", details: { rule: "agreement_draft_changed" } });
  });

  it("a publish with nothing changed since the newest version is refused", async () => {
    const { id, hash } = await draftDocument();
    await publish(id, hash);
    const saved = await invoke("agreement.draft.save", { id }, context(admin));
    expect(await refusal(publish(id, saved.hash, { change: "agree_again" }))).toMatchObject({
      code: "conflict",
      details: { rule: "agreement_unchanged" },
    });
  });
});

describe("each term is pinned on its own (review: tests the rev check masked)", () => {
  const TERMS: [column: string, value: string | number, field: string][] = [
    ["draft_how", "drawn", "how"],
    ["draft_who", "payer", "who"],
    ["draft_for", "dependants", "forWhom"],
    ["draft_ask_again_months", 120, "askAgainMonths"],
  ];

  it("the hash covers each term: a raw change with the rev bumped is refused against the old hash", async () => {
    for (const [column, value, field] of TERMS) {
      const { id } = await draftDocument("health");
      const preview = await invoke("agreement.publishPreview", { id }, context(admin));
      await env.DB.prepare(
        `UPDATE core_agreement_document SET ${column} = ?, draft_rev = draft_rev + 1 WHERE id = ?`,
      )
        .bind(value, id)
        .run();
      const refused = await refusal(
        invoke(
          "agreement.publish",
          {
            documentId: id,
            draftHash: preview.draftHash,
            draftRev: preview.draftRev + 1,
            number: 1,
            change: "small",
          },
          context(admin),
        ),
      );
      expect(refused, field).toMatchObject({ code: "conflict" });
      const after = await invoke("agreement.publishPreview", { id }, context(admin));
      expect(after.draftHash, field).not.toBe(preview.draftHash);
    }
  });

  it("the insert trigger compares each term: a forged row differing in one is refused", async () => {
    const forged: [column: string, expression: string][] = [
      ["title", "'Other title'"],
      ["body", `'{"blocks":[]}'`],
      ["tick_label", "'Other label'"],
      ["questions", "NULL"],
      ["how", "'drawn'"],
      ["who", "'payer'"],
      ["for_whom", "'dependants'"],
      ["ask_again_months", "120"],
    ];
    for (const [column, expression] of forged) {
      const { id } = await draftDocument("health");
      const columns: Record<string, string> = {
        title: "draft_title",
        body: "draft_body",
        tick_label: "draft_tick_label",
        questions: "draft_questions",
        how: "draft_how",
        who: "draft_who",
        for_whom: "draft_for",
        ask_again_months: "draft_ask_again_months",
      };
      const select = Object.entries(columns)
        .map(([c, d]) => (c === column ? expression : d))
        .join(", ");
      await expect(
        env.DB.prepare(
          `INSERT INTO core_agreement_version (id, document_id, number, title, body, tick_label,
             questions, how, who, for_whom, ask_again_months, change, effective_from, published_at,
             published_by, draft_rev, hash)
           SELECT 'agv_f_${column}', id, 1, ${select}, 'first', 'now', 'now', 'usr', draft_rev,
             printf('%064d', 0) FROM core_agreement_document WHERE id = ?`,
        )
          .bind(id)
          .run(),
        column,
      ).rejects.toThrow(/core_agreement_draft_changed/);
    }
  });
});

describe("raw SQL gaps (review B2)", () => {
  it("a document's id never changes, a point is never rewritten, a draft change always moves the rev", async () => {
    const live = await draftDocument();
    await publish(live.id, live.hash);
    const draft = await draftDocument();
    await expect(
      env.DB.prepare("UPDATE OR REPLACE core_agreement_document SET id = ? WHERE id = ?")
        .bind(live.id, draft.id)
        .run(),
    ).rejects.toThrow(/document_fixed/);
    await expect(
      env.DB.prepare("UPDATE core_agreement_document SET id = 'agd_moved' WHERE id = ?")
        .bind(draft.id)
        .run(),
    ).rejects.toThrow(/document_fixed/);
    await invoke("agreement.attach", { documentId: live.id, points: [POINT] }, context(admin));
    await expect(
      env.DB.prepare("UPDATE core_agreement_point SET document_id = ? WHERE document_id = ?")
        .bind(draft.id, live.id)
        .run(),
    ).rejects.toThrow(/core_agreement_not_live/);
    await expect(
      env.DB.prepare("UPDATE core_agreement_document SET draft_title = 'Raw' WHERE id = ?")
        .bind(draft.id)
        .run(),
    ).rejects.toThrow(/core_agreement_draft_changed/);
    // With the rev moved, the change is allowed (and the editor sees a new rev).
    await env.DB.prepare(
      "UPDATE core_agreement_document SET draft_title = 'Raw', draft_rev = draft_rev + 1 WHERE id = ?",
    )
      .bind(draft.id)
      .run();
    expect((await invoke("agreement.get", { id: draft.id }, context(admin))).draft.title).toBe(
      "Raw",
    );
  });
});

describe("invisible characters (review B3)", () => {
  const save = (id: string, input: Record<string, unknown>) =>
    invoke("agreement.draft.save", { id, ...input }, context(admin));

  it("refuses tag characters outside a flag and C1 controls; fillers are not text", async () => {
    const { id } = await draftDocument();
    for (const title of [
      "Waiver\u{e0041}\u{e0042}",
      "Waiver\u0085",
      "\u3164\u3164",
      "\u2800",
      "\u115f\u1160\uffa0",
      "\u00ad\u034f\u180e\ufe0f",
    ]) {
      expect(await refusal(save(id, { title })), JSON.stringify(title)).toMatchObject({
        code: "invalid_input",
      });
    }
    expect(await refusal(save(id, { body: body("Fixture\u{e0020}text") }))).toMatchObject({
      code: "invalid_input",
    });
    // Allowed: a subdivision flag, a joiner in an emoji, a soft hyphen, a direction mark in text.
    const flag = "\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}";
    const ok = await save(id, {
      title: `Waiver ${flag} \u{1f469}\u200d\u{1f4bb} co\u00adop \u200f`,
    });
    expect(ok.title).toContain(flag);
    await save(id, { body: body("\u3164\u2800\u200b") });
    expect((await invoke("agreement.publishPreview", { id }, context(admin))).problems).toContain(
      "The body has no text",
    );
  });
});

describe("core permission namespaces are reserved (review B5)", () => {
  it("an extension cannot take the id of a core permission's namespace", async () => {
    const { CORE_PERMISSION_NAMESPACES } = await import("../src/principals.ts");
    expect(CORE_PERMISSION_NAMESPACES).toContain("agreements");
    for (const id of CORE_PERMISSION_NAMESPACES) {
      const result = await check(manifest(id, { grantable: [`${id}:manage`] } as never));
      expect(JSON.stringify(result.issues), id).toContain('"path":"id"');
    }
  });

  it("an account holding a pack role is refused an agreements:manage grant", async () => {
    const coach = await createUser("viewer");
    await env.DB.prepare("UPDATE core_user SET pack_role = 'bookings.coach' WHERE id = ?")
      .bind(coach.id)
      .run();
    expect(
      await refusal(
        invoke(
          "user.setPermissions",
          { id: coach.id, permissions: ["agreements:manage"] },
          context(admin),
        ),
      ),
    ).toMatchObject({ code: "invalid_input" });
  });
});
