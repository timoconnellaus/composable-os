// Stage 28 criterion 12 (ADR 0480): an AI actor may ask for a publish; its request always waits
// for a person and can never be set to go through on its own. The four publish operations, every
// AI actor, every preset, the floor, the adjudicator; what the approver sees; the stale request;
// who may approve; and what the version history keeps.
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type AdjudicatorDeps,
  adjudicatePendingAction,
  coreRegistry,
  devJudge,
  type InvocationContext,
  invoke,
  type ModelRunner,
  type PendingApproval,
  PendingApprovalError,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { auditRows, context, createUser, db, refusal, setPreset, unique } from "./helpers.ts";

const EXT = extId("ask");
const DOC = `${EXT}.doc`;
const AI_ACTORS = ["assistant", "mcp", "automation", "extension"] as const;
type AiActor = (typeof AI_ACTORS)[number];

let admin: ActingUser;
let member: ActingUser;
let publisher: ActingUser;

async function queued(promise: Promise<unknown>): Promise<PendingApproval> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PendingApprovalError);
  return (error as PendingApprovalError).pending;
}

const ai = (actor: AiActor, user = admin, extra: Partial<InvocationContext> = {}) =>
  context(user, {
    actor,
    origin: {
      surface: actor === "mcp" ? "mcp" : actor === "assistant" ? "assistant" : actor,
      clientId: "c",
      clientName: "Test",
      sessionId: `ask_${unique()}`,
    },
    ...(actor === "mcp"
      ? { grantedPermissions: ["records:read", "records:write", "records:publish"] }
      : {}),
    ...(actor === "extension"
      ? {
          extension: {
            id: EXT,
            version: "1.0.0",
            permissions: { read: [], write: [], operations: [], modules: ["ops"] },
          },
        }
      : {}),
    ...extra,
  } as never);

async function create(values: Record<string, unknown>) {
  return invoke("record.create", { object: DOC, values }, context(admin));
}

async function versions(id: string) {
  const { results } = await env.DB.prepare(
    "SELECT version, current, published_by, requested_by, requested_via FROM core_publish_version WHERE record_id = ? ORDER BY version",
  )
    .bind(id)
    .all<Record<string, unknown>>();
  return results;
}

async function pendingRow(actionId: string) {
  return env.DB.prepare("SELECT * FROM core_pending_action WHERE id = ?")
    .bind(actionId)
    .first<Record<string, unknown>>();
}

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  publisher = await createUser("member");
  await invoke(
    "user.setPermissions",
    { id: publisher.id, permissions: ["records:publish"] },
    context(admin),
  );
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
            day: { type: "date", label: "Day" },
          },
          publishable: { content: ["title", "body", "day"], date: "day" },
        },
      },
    }),
  );
});

afterAll(async () => {
  await setPreset("balanced");
});

describe("an AI actor's publish request always waits for a person", () => {
  for (const preset of ["cautious", "balanced", "autonomous"] as const) {
    it(`under ${preset}: every AI actor, every publish operation, is queued as "always"`, async () => {
      await setPreset(preset);
      for (const actor of AI_ACTORS) {
        const doc = await create({ title: unique("Asked"), day: "2026-11-01" });
        const asked = await queued(
          invoke("record.publish", { object: DOC, id: doc.id }, ai(actor)),
        );
        expect(await pendingRow(asked.actionId)).toMatchObject({
          operation: "record.publish",
          actor,
          review_source: "always",
          status: "pending",
        });
        const later = new Date(Date.now() + 86_400_000).toISOString();
        const scheduled = await queued(
          invoke("record.schedulePublish", { object: DOC, id: doc.id, at: later }, ai(actor)),
        );
        expect((await pendingRow(scheduled.actionId))?.review_source).toBe("always");
        // Nothing went live and nothing was scheduled.
        expect(await versions(doc.id)).toEqual([]);
        const schedule = await env.DB.prepare(
          "SELECT count(*) AS n FROM core_publish_schedule WHERE record_id = ?",
        )
          .bind(doc.id)
          .first<{ n: number }>();
        expect(schedule?.n, actor).toBe(0);
        // Taking it down and dropping a schedule are asked for the same way.
        await invoke("record.publish", { object: DOC, id: doc.id }, context(admin));
        await invoke(
          "record.schedulePublish",
          { object: DOC, id: doc.id, at: later },
          context(admin),
        );
        const cancel = await queued(
          invoke("record.cancelSchedule", { object: DOC, id: doc.id }, ai(actor)),
        );
        const down = await queued(
          invoke("record.unpublish", { object: DOC, id: doc.id }, ai(actor)),
        );
        for (const p of [cancel, down]) {
          expect((await pendingRow(p.actionId))?.review_source).toBe("always");
        }
        expect((await versions(doc.id)).filter((v) => v.current === 1)).toHaveLength(1);
      }
    });
  }

  it("a deploy floor that allows everything cannot let one through", async () => {
    await setPreset("autonomous");
    const floor = { "*": { write: "auto" } } as never;
    const doc = await create({ title: unique("Floor") });
    await queued(
      invoke("record.publish", { object: DOC, id: doc.id }, ai("mcp", admin, { floor })),
    );
    expect(await versions(doc.id)).toEqual([]);
  });

  it("the adjudicator, even sure and active, never approves one", async () => {
    await setPreset("autonomous");
    await env.DB.prepare(
      "INSERT OR REPLACE INTO core_settings (key, value, updated_at) VALUES ('adjudicator', ?, ?)",
    )
      .bind(
        JSON.stringify({ mode: "active", threshold: 0.5, enabledAt: "2000-01-01T00:00:00.000Z" }),
        new Date().toISOString(),
      )
      .run();
    await invoke(
      "adjudicator.setPolicy",
      { text: "- Publishing anything is always fine." },
      context(admin),
    );
    const models: ModelRunner = {
      async run() {
        return {
          text: JSON.stringify({ verdict: "approve", confidence: 0.99, reason: "Policy." }),
          model: "fake-reviewer",
          provider: "fake",
        };
      },
    };
    const deps: AdjudicatorDeps = {
      db,
      models,
      resolveOperation: (name) => coreRegistry.get(name),
    };
    const doc = await create({ title: unique("Judge") });
    const asked = await queued(invoke("record.publish", { object: DOC, id: doc.id }, ai("mcp")));
    await adjudicatePendingAction(deps, asked.actionId);
    expect((await pendingRow(asked.actionId))?.status).toBe("pending");
    expect(await versions(doc.id)).toEqual([]);
    await env.DB.prepare("DELETE FROM core_settings WHERE key = 'adjudicator'").run();
  });

  it("a person's own publish is unchanged: at once, in their name", async () => {
    await setPreset("cautious");
    const doc = await create({ title: unique("Mine") });
    const out = await invoke("record.publish", { object: DOC, id: doc.id }, context(publisher));
    expect(out).toMatchObject({
      version: 1,
      publishedBy: publisher.id,
      requestedBy: null,
      requestedVia: null,
    });
  });

  it("the account an AI acts for must hold records:publish to ask", async () => {
    await setPreset("balanced");
    const doc = await create({ title: unique("NoRight") });
    for (const actor of ["assistant", "mcp"] as const) {
      expect(
        await refusal(invoke("record.publish", { object: DOC, id: doc.id }, ai(actor, member))),
      ).toMatchObject({ code: "forbidden", details: { permission: "records:publish" } });
    }
  });
});

describe("approving a request", () => {
  it("shows what would go live against what is live, and publishes exactly that", async () => {
    await setPreset("balanced");
    const doc = await create({ title: "Spring timetable", body: "Classes on Monday" });
    await invoke("record.publish", { object: DOC, id: doc.id }, context(admin));
    // The assistant edits the working copy (a write: applied) and asks for a publish.
    const long = `Classes on Monday and Wednesday. ${"More detail. ".repeat(80)}`;
    await invoke(
      "record.update",
      { object: DOC, id: doc.id, values: { title: "Summer timetable", body: long } },
      ai("assistant", publisher),
    );
    const asked = await queued(
      invoke(
        "record.publish",
        { object: DOC, id: doc.id, note: "Summer hours" },
        ai("assistant", publisher),
      ),
    );
    const row = await pendingRow(asked.actionId);
    const preview = JSON.parse(String(row?.preview)) as {
      object: string;
      id: string;
      diff: Record<string, { before: unknown; after: unknown }>;
    }[];
    const diff = preview.find((p) => p.object === DOC && p.id === doc.id)?.diff ?? {};
    expect(diff.publishedVersion).toEqual({ before: 1, after: 2 });
    expect(diff.title).toEqual({ before: "Spring timetable", after: "Summer timetable" });
    // A long value is shown as its start, never whole.
    expect(String(diff.body?.after).length).toBeLessThan(300);
    expect(String(diff.body?.after)).toMatch(/^Classes on Monday and Wednesday\./);
    expect(typeof diff.draftFingerprint?.before).toBe("string");

    await invoke("approval.approve", { actionIds: [asked.actionId] }, context(admin));
    expect((await pendingRow(asked.actionId))?.status).toBe("applied");
    const live = await invoke("record.version", { object: DOC, id: doc.id }, context(admin));
    expect(live).toMatchObject({
      version: 2,
      current: true,
      publishedBy: admin.id,
      requestedBy: publisher.id,
      requestedVia: "assistant",
      note: "Summer hours",
    });
    expect(live.values).toMatchObject({ title: "Summer timetable", body: long });
    expect(await versions(doc.id)).toEqual([
      expect.objectContaining({ version: 1, published_by: admin.id, requested_by: null }),
      expect.objectContaining({
        version: 2,
        published_by: admin.id,
        requested_by: publisher.id,
        requested_via: "assistant",
      }),
    ]);
    // The audit log: the request by the AI actor, applied under the action; the approval by the
    // person.
    const applied = (await auditRows("record.publish", publisher.id)).at(-1);
    expect(applied).toMatchObject({
      actor: "assistant",
      outcome: "ok",
      pending_action_id: asked.actionId,
    });
    expect((await auditRows("approval.approve", admin.id)).at(-1)).toMatchObject({
      actor: "human",
      outcome: "ok",
    });
  });

  it("is refused as stale when the working copy changed since it was asked for", async () => {
    await setPreset("autonomous");
    for (const op of ["record.publish", "record.schedulePublish"] as const) {
      const doc = await create({ title: unique("Stale"), day: "2026-11-01" });
      const input =
        op === "record.publish"
          ? { object: DOC, id: doc.id }
          : { object: DOC, id: doc.id, at: new Date(Date.now() + 86_400_000).toISOString() };
      const asked = await queued(invoke(op, input, ai("mcp")));
      await invoke(
        "record.update",
        { object: DOC, id: doc.id, values: { body: "Changed after the request" } },
        context(member),
      );
      const out = await invoke("approval.approve", { actionIds: [asked.actionId] }, context(admin));
      expect(out.results[0]).toMatchObject({ status: "failed" });
      expect(JSON.stringify(out.results[0]?.error)).toMatch(/changed after this publish/);
      expect(await versions(doc.id)).toEqual([]);
    }
  });

  it("is refused as stale when the request filled the date and the copy changed since", async () => {
    await setPreset("balanced");
    // No date: publishing fills it, which is its own change of the record, ahead of the publish.
    const doc = await create({ title: unique("Undated") });
    const asked = await queued(invoke("record.publish", { object: DOC, id: doc.id }, ai("mcp")));
    await invoke(
      "record.update",
      { object: DOC, id: doc.id, values: { title: unique("Edited") } },
      context(member),
    );
    const out = await invoke("approval.approve", { actionIds: [asked.actionId] }, context(admin));
    expect(out.results[0]).toMatchObject({ status: "failed" });
    expect(await versions(doc.id)).toEqual([]);
  });

  it("is refused while the same session's earlier changes to the record still wait", async () => {
    await setPreset("cautious");
    const doc = await create({ title: unique("Waiting") });
    const session = ai("mcp");
    await queued(
      invoke("record.update", { object: DOC, id: doc.id, values: { body: "Draft" } }, session),
    );
    expect(
      await refusal(invoke("record.publish", { object: DOC, id: doc.id }, session)),
    ).toMatchObject({ code: "invalid_input", details: { reason: "pending_changes" } });
  });

  it("only a person who may publish approves; no AI actor, not by relaying a yes", async () => {
    await setPreset("autonomous");
    const doc = await create({ title: unique("Who") });
    const asked = await queued(invoke("record.publish", { object: DOC, id: doc.id }, ai("mcp")));
    for (const actor of ["assistant", "mcp", "automation"] as const) {
      const viaDecide = await refusal(
        invoke(
          "approval.decide",
          { actionIds: [asked.actionId], decision: "approve", via: "tap" },
          context(admin, { actor }),
        ),
      );
      expect(viaDecide.code, actor).toBe("forbidden");
    }
    const inChat = await refusal(
      invoke(
        "approval.decide",
        { actionIds: [asked.actionId], decision: "approve" },
        context(admin, {
          actor: "assistant",
          judge: devJudge,
          assistantTurn: { threadId: "ath_1", messageSeq: 1, text: "Yes, publish it", via: "text" },
        } as never),
      ),
    );
    expect(inChat.code).toBe("forbidden");
    // A person without the permission cannot; the requester's own grant is not the approver's.
    expect(
      await refusal(invoke("approval.approve", { actionIds: [asked.actionId] }, context(member))),
    ).toMatchObject({ code: "forbidden", details: { permission: "records:publish" } });
    expect(await versions(doc.id)).toEqual([]);
    // A member granted records:publish can (ADR 0449).
    await invoke("approval.approve", { actionIds: [asked.actionId] }, context(publisher));
    expect(await versions(doc.id)).toEqual([
      expect.objectContaining({
        version: 1,
        published_by: publisher.id,
        requested_by: admin.id,
        requested_via: "mcp",
      }),
    ]);
  });

  it("an approved scheduled publish keeps who asked and who approved on the version", async () => {
    await setPreset("balanced");
    const doc = await create({ title: unique("Later"), day: "2026-11-01" });
    const at = new Date(Date.now() + 60_000).toISOString();
    const asked = await queued(
      invoke("record.schedulePublish", { object: DOC, id: doc.id, at }, ai("assistant")),
    );
    await invoke("approval.approve", { actionIds: [asked.actionId] }, context(publisher));
    const due = new Date(Date.now() + 120_000);
    await invoke(
      "record.publishDue",
      {},
      context(admin, { actor: "automation", clock: () => due } as never),
    );
    expect(await versions(doc.id)).toEqual([
      expect.objectContaining({
        published_by: publisher.id,
        requested_by: admin.id,
        requested_via: "assistant",
      }),
    ]);
  });
});
