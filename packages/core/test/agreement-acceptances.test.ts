// Stage 44 step 2 (ADRs 0642 and 0643): acceptances and the one question. An acceptance cannot be
// changed by any statement shape (raw SQL included); `agreementsDue` answers what is due, and its
// guard fails a batch when what is due changed between the read and the commit; a customer agrees
// for themselves and a guardian for a live dependant (never a minor themselves); staff record
// paper and mark a minor, a person only; health answers are read only by a person holding
// agreements:health, every read audited, and reach no bulk path, AI or log. All text here is
// fixture text, not wording anyone should use.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { planAcceptance } from "../src/agreements/accept.ts";
import { agreementsDue, requireNothingDue } from "../src/agreements/due.ts";
import { checkManifest } from "../src/extensions/install.ts";
import {
  type ActingUser,
  type Actor,
  type CustomerPrincipal,
  type InvocationContext,
  invoke,
  invokeByName,
  PendingApprovalError,
} from "../src/index.ts";
import { testRunner } from "./ai-helpers.ts";
import { outside } from "./customer-fixtures.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";

let admin: ActingUser;
let member: ActingUser;
const POINT = `pa${Date.now().toString(36)}`;
const OTHER = `pb${Date.now().toString(36)}`;

const body = (text: string) => ({
  blocks: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  await reconcile(
    manifest(extId("acc"), {
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
          agreements: { point: POINT, label: "Starting a plan" },
        },
        pass: {
          label: "Pass",
          plural: "Passes",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            price: { type: "currency", label: "Price", currency: "AUD" },
          },
          sellable: { price: "price" },
          agreements: { point: OTHER, label: "Buying a pass" },
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

type Kind = "terms" | "waiver" | "health" | "guardian" | "other";

const QUESTIONS = [
  { key: "heart", text: "Fixture question one?", noteOnYes: true },
  { key: "joints", text: "Fixture question two?", noteOnYes: false },
];

/** A published document attached to `points`, returning its id and current version. */
async function liveDocument(
  kind: Kind = "waiver",
  options: {
    points?: string[];
    how?: "typed" | "drawn";
    forWhom?: "everyone" | "dependants";
    askAgainMonths?: number;
  } = {},
) {
  const { id } = await invoke("agreement.create", { title: unique("Doc"), kind }, context(admin));
  const saved = await invoke(
    "agreement.draft.save",
    {
      id,
      body: body("Fixture text: not a real document."),
      tickLabel: "I have read this fixture",
      ...(options.how ? { how: options.how } : {}),
      ...(options.forWhom ? { forWhom: options.forWhom } : {}),
      ...(kind === "health"
        ? { questions: QUESTIONS, askAgainMonths: options.askAgainMonths ?? null }
        : {}),
    },
    context(admin),
  );
  const { version } = await invoke(
    "agreement.publish",
    { documentId: id, draftHash: saved.hash, draftRev: saved.rev, number: 1, change: "small" },
    context(admin),
  );
  await invoke(
    "agreement.attach",
    { documentId: id, points: options.points ?? [POINT] },
    context(admin),
  );
  return { id: id as string, versionId: version.id as string };
}

/** A new version of a live document, as "agree again" or a small change. */
async function republish(documentId: string, change: "small" | "agree_again", text: string) {
  const saved = await invoke(
    "agreement.draft.save",
    { id: documentId, body: body(text) },
    context(admin),
  );
  const doc = await invoke("agreement.get", { id: documentId }, context(admin));
  const { version } = await invoke(
    "agreement.publish",
    {
      documentId,
      draftHash: saved.hash,
      draftRev: saved.rev,
      number: doc.versions.length + 1,
      change,
    },
    context(admin),
  );
  return version.id as string;
}

const person = async (label = "Member") =>
  (await invoke("person.create", { givenName: unique(label) }, context(admin))).id as string;

const customer = (personId: string): CustomerPrincipal => ({
  kind: "customer",
  customerId: `cus_${unique("acc")}`,
  personId,
});

const asCustomer = (personId: string) => outside(customer(personId));

const accept = (
  personId: string,
  input: Record<string, unknown>,
  principal: CustomerPrincipal = customer(personId),
) =>
  invokeByName("me.agreements.accept", { typedName: "Fixture Name", ...input }, outside(principal));

/** A signature with enough ink: a zigzag across the box. */
const SIGNATURE = {
  width: 1000,
  height: 400,
  strokes: [
    [
      [100, 200],
      [200, 100],
      [300, 300],
      [400, 100],
    ],
  ],
};

const AI_ACTORS: { actor: Actor; origin: InvocationContext["origin"] }[] = [
  { actor: "assistant", origin: { surface: "assistant", sessionId: "ath_acceptances" } },
  {
    actor: "mcp",
    origin: { surface: "mcp", clientId: "c", clientName: "T", sessionId: "cap_acceptances" },
  },
  { actor: "automation", origin: { surface: "automation", automationId: "x.y" } },
  { actor: "extension", origin: { surface: "extension", extensionId: "bookings" } },
];

const aiContext = (extra: (typeof AI_ACTORS)[number]) =>
  context(admin, {
    ...extra,
    ...(extra.actor === "mcp" ? { grantedPermissions: ["records:read", "records:write"] } : {}),
  });

const acceptanceRow = (id: string) =>
  env.DB.prepare("SELECT * FROM core_agreement_acceptance WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();

describe("an acceptance cannot be changed", () => {
  it("is refused by the database for every column and every statement shape", async () => {
    const doc = await liveDocument("waiver", { points: [OTHER] });
    const a = await person();
    const b = await person();
    const first = (await accept(a, { versionId: doc.versionId })) as { id: string };
    const second = (await accept(b, { versionId: doc.versionId })) as { id: string };
    const before = await acceptanceRow(first.id);
    for (const statement of [
      "UPDATE core_agreement_acceptance SET typed_name = 'Changed' WHERE id = ?",
      "UPDATE core_agreement_acceptance SET accepted_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
      "UPDATE core_agreement_acceptance SET version_id = version_id || 'x' WHERE id = ?",
      "UPDATE core_agreement_acceptance SET shown_hash = printf('%064d', 1) WHERE id = ?",
      "UPDATE core_agreement_acceptance SET by = 'paper' WHERE id = ?",
      "UPDATE core_agreement_acceptance SET how = 'drawn' WHERE id = ?",
      "UPDATE core_agreement_acceptance SET channel = 'app' WHERE id = ?",
      "UPDATE core_agreement_acceptance SET note = 'x' WHERE id = ?",
      // The Person moves only to a merged Person's survivor, or to null with erased_at.
      `UPDATE core_agreement_acceptance SET person_id = '${b}' WHERE id = ?`,
      "UPDATE core_agreement_acceptance SET person_id = NULL WHERE id = ?",
      "UPDATE core_agreement_acceptance SET erased_at = '2030-01-01' WHERE id = ?",
      // Identity is only ever cleared, never set.
      `UPDATE core_agreement_acceptance SET agent_person_id = '${b}' WHERE id = ?`,
      "UPDATE core_agreement_acceptance SET account_id = 'cus_other' WHERE id = ?",
      "UPDATE core_agreement_acceptance SET email = 'someone@example.test' WHERE id = ?",
      // A key change, plain and as an UPDATE OR REPLACE onto another acceptance's id (which would
      // otherwise delete that one without firing its delete trigger).
      "UPDATE core_agreement_acceptance SET id = 'aga_moved' WHERE id = ?",
      `UPDATE OR REPLACE core_agreement_acceptance SET id = '${second.id}' WHERE id = ?`,
      "DELETE FROM core_agreement_acceptance WHERE id = ?",
    ]) {
      await expect(env.DB.prepare(statement).bind(first.id).run(), statement).rejects.toThrow(
        /core_agreement_acceptance_immutable/,
      );
    }
    // An insert over an existing id, as INSERT OR REPLACE, INSERT OR IGNORE and an upsert.
    const columns =
      "id, document_id, version_id, shown_hash, person_id, by, how, typed_name, channel, accepted_at";
    const values = `SELECT id, document_id, version_id, shown_hash, person_id, by, how, 'Forged', channel, accepted_at FROM core_agreement_acceptance WHERE id = ?`;
    for (const statement of [
      `INSERT OR REPLACE INTO core_agreement_acceptance (${columns}) ${values}`,
      `INSERT OR IGNORE INTO core_agreement_acceptance (${columns}) ${values}`,
      `INSERT INTO core_agreement_acceptance (${columns}) ${values} ON CONFLICT (id) DO UPDATE SET typed_name = 'Forged'`,
      `INSERT INTO core_agreement_acceptance (${columns}) ${values} ON CONFLICT DO NOTHING`,
    ]) {
      await expect(env.DB.prepare(statement).bind(first.id).run(), statement).rejects.toThrow(
        /core_agreement_acceptance_immutable/,
      );
    }
    // Through the host's own batch too: the trigger is the same for every writer.
    await expect(
      db.batch([
        db.query
          .updateTable("core_agreement_acceptance")
          .set({ typed_name: "x" })
          .where("id", "=", first.id),
      ]),
    ).rejects.toThrow(/immutable/);
    expect(await acceptanceRow(first.id)).toEqual(before);
    expect(await acceptanceRow(second.id)).not.toBeNull();
  });

  it("refuses an insert that was not shown the version, or of a version no longer open", async () => {
    const doc = await liveDocument("waiver", { points: [OTHER] });
    const a = await person();
    const insert = (version: string, hash: string, by = "self", personId: string | null = a) =>
      env.DB.prepare(
        `INSERT INTO core_agreement_acceptance (id, document_id, version_id, shown_hash, person_id,
           by, how, typed_name, channel, accepted_at) VALUES (?, ?, ?, ?, ?, ?, 'typed', 'N', 'web', 'now')`,
      )
        .bind(`aga_${unique("raw")}`, doc.id, version, hash, personId, by)
        .run();
    // A hash other than the version's.
    await expect(insert(doc.versionId, "0".repeat(64))).rejects.toThrow(/version_not_open/);
    // A version replaced by a newer one is no longer open to agree to.
    const { hash } = (await env.DB.prepare("SELECT hash FROM core_agreement_version WHERE id = ?")
      .bind(doc.versionId)
      .first<{ hash: string }>()) as { hash: string };
    await republish(doc.id, "small", "Fixture text, second wording.");
    await expect(insert(doc.versionId, hash)).rejects.toThrow(/version_not_open/);
    // Nobody's (a Person-less row) is only a guest's.
    const current = await invoke("agreement.get", { id: doc.id }, context(admin));
    const v2 = (await env.DB.prepare("SELECT hash FROM core_agreement_version WHERE id = ?")
      .bind(current.current?.id)
      .first<{ hash: string }>()) as { hash: string };
    await expect(insert(current.current?.id as string, v2.hash, "self", null)).rejects.toThrow(
      /immutable/,
    );
  });

  it("refuses a version whose stored hash does not match its content", async () => {
    const { id } = await invoke(
      "agreement.create",
      { title: unique("Forged"), kind: "waiver" },
      context(admin),
    );
    await invoke(
      "agreement.draft.save",
      { id, body: body("Fixture text."), tickLabel: "I have read this fixture" },
      context(admin),
    );
    // A raw writer can give a row matching the working copy a made-up hash (SQLite cannot hash).
    await env.DB.prepare(
      `INSERT INTO core_agreement_version (id, document_id, number, title, body, tick_label,
         questions, how, who, for_whom, ask_again_months, change, effective_from, published_at,
         published_by, draft_rev, hash)
       SELECT 'agv_forged_${unique()}', id, 1, draft_title, draft_body, draft_tick_label,
         draft_questions, draft_how, draft_who, draft_for, draft_ask_again_months, 'first',
         '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', 'usr_x', draft_rev,
         printf('%064d', 7) FROM core_agreement_document WHERE id = ?`,
    )
      .bind(id)
      .run();
    const forged = (await env.DB.prepare(
      "SELECT id FROM core_agreement_version WHERE document_id = ?",
    )
      .bind(id)
      .first<{ id: string }>()) as { id: string };
    await env.DB.prepare(
      "UPDATE core_agreement_document SET state = 'live', current_version_id = ?, agree_from = 1 WHERE id = ?",
    )
      .bind(forged.id, id)
      .run();
    await env.DB.prepare(
      "INSERT INTO core_agreement_point (document_id, point, attached_at, attached_by) VALUES (?, ?, 'now', 'usr_x')",
    )
      .bind(id, OTHER)
      .run();
    const refused = await refusal(accept(await person(), { versionId: forged.id }));
    expect(refused).toMatchObject({ code: "conflict", details: { rule: "agreement_not_intact" } });
  });

  it("signatures and answers are refused any update, and any delete while their acceptance stands", async () => {
    const drawn = await liveDocument("waiver", { points: [OTHER], how: "drawn" });
    const health = await liveDocument("health", { points: [OTHER] });
    const a = await person();
    const signed = (await accept(a, { versionId: drawn.versionId, signature: SIGNATURE })) as {
      id: string;
    };
    const answered = (await accept(a, {
      versionId: health.versionId,
      answers: [
        { key: "heart", yes: false },
        { key: "joints", yes: false },
      ],
    })) as { id: string };
    for (const [statement, key] of [
      ["UPDATE core_agreement_signature SET strokes = '{}' WHERE acceptance_id = ?", signed.id],
      ["DELETE FROM core_agreement_signature WHERE acceptance_id = ?", signed.id],
      [
        "INSERT OR REPLACE INTO core_agreement_signature (acceptance_id, strokes) VALUES (?, '{}')",
        signed.id,
      ],
      ["UPDATE core_agreement_answer SET any_yes = 1 WHERE acceptance_id = ?", answered.id],
      ["DELETE FROM core_agreement_answer WHERE acceptance_id = ?", answered.id],
      [
        "INSERT OR REPLACE INTO core_agreement_answer (acceptance_id, answers, any_yes) VALUES (?, '[]', 0)",
        answered.id,
      ],
      // Answers on an acceptance of a document that is not a health form.
      [
        "INSERT INTO core_agreement_answer (acceptance_id, answers, any_yes) VALUES (?, '[]', 0)",
        signed.id,
      ],
    ] as const) {
      await expect(env.DB.prepare(statement).bind(key).run(), statement).rejects.toThrow(
        /immutable/,
      );
    }
  });
});

describe("agreementsDue: the one question", () => {
  it("is due until accepted, again after agree again, not after a small change", async () => {
    const point = `pd${unique()}`;
    await reconcile(
      manifest(extId("acd"), {
        objects: {
          plan: {
            label: "Plan",
            plural: "Plans",
            titleField: "name",
            fields: { name: { type: "text", label: "Name" } },
            agreements: { point, label: "Somewhere" },
          },
        },
      }),
    );
    const doc = await liveDocument("terms", { points: [point] });
    const a = await person();
    const ask = () => agreementsDue(db.query, { point, participant: a, payer: a, now: nowIso() });
    expect((await ask()).due).toMatchObject([
      { documentId: doc.id, personId: a, reason: "never", version: { id: doc.versionId } },
    ]);
    await accept(a, { versionId: doc.versionId });
    expect((await ask()).due).toEqual([]);
    await republish(doc.id, "small", "Fixture text, a small change.");
    expect((await ask()).due).toEqual([]);
    const v3 = await republish(doc.id, "agree_again", "Fixture text, agree again.");
    expect((await ask()).due).toMatchObject([{ reason: "agree_again", version: { id: v3 } }]);
    // The Person tab says the same, as does the preview of the next agree again (who it asks).
    const tab = await invoke("agreement.person", { personId: a }, context(admin));
    expect(
      tab.documents.find((d: { documentId: string }) => d.documentId === doc.id),
    ).toMatchObject({ status: "due", reason: "agree_again" });
    await accept(a, { versionId: v3 });
    expect((await ask()).due).toEqual([]);
    const preview = await invoke("agreement.publishPreview", { id: doc.id }, context(admin));
    expect(preview.asksAgain).toBe(1);
    // A Person in the Trash has no current acceptance.
    await invoke("person.delete", { id: a }, context(admin));
    expect((await ask()).due).toHaveLength(1);
    await invoke("person.restore", { id: a }, context(admin));
    expect((await ask()).due).toEqual([]);
  });

  it("asks a health form again after its months, and a dependants document only of a minor", async () => {
    const point = `ph${unique()}`;
    await reconcile(
      manifest(extId("ach"), {
        objects: {
          plan: {
            label: "Plan",
            plural: "Plans",
            titleField: "name",
            fields: { name: { type: "text", label: "Name" } },
            agreements: { point, label: "Somewhere" },
          },
        },
      }),
    );
    const health = await liveDocument("health", { points: [point], askAgainMonths: 12 });
    const consent = await liveDocument("guardian", { points: [point], forWhom: "dependants" });
    const adult = await person();
    const ask = (participant: string, now = nowIso()) =>
      agreementsDue(db.query, { point, participant, payer: participant, now });
    // An adult: the health form only; the guardian consent is for a dependant.
    expect((await ask(adult)).due.map((d) => d.documentId)).toEqual([health.id]);
    await accept(adult, {
      versionId: health.versionId,
      answers: [
        { key: "heart", yes: false },
        { key: "joints", yes: false },
      ],
    });
    expect((await ask(adult)).due).toEqual([]);
    const later = new Date(Date.now() + 400 * 86_400_000).toISOString();
    expect((await ask(adult, later)).due).toMatchObject([
      { documentId: health.id, reason: "ask_again" },
    ]);
    // Marked a minor: the consent too, and their own health acceptance no longer counts.
    await invoke("agreement.setMinor", { personId: adult, minor: true }, context(admin));
    expect((await ask(adult)).due.map((d) => d.documentId).sort()).toEqual(
      [health.id, consent.id].sort(),
    );
    expect((await ask(adult)).due.find((d) => d.documentId === health.id)?.reason).toBe("guardian");
  });

  it("the guard fails a batch when what is due changed between the read and the commit", async () => {
    const own = await newPoint("acg");
    const doc = await liveDocument("waiver", { points: [own] });
    const a = await person();
    // A write that relied on nothing being due: refused while the waiver is due.
    const refused = await refusal(
      requireNothingDue(db.query, { point: own, participant: a, payer: a, now: nowIso() }),
    );
    expect(refused).toMatchObject({
      code: "invalid_input",
      details: { rule: "agreements_due", documents: [{ documentId: doc.id }] },
    });
    await accept(a, { versionId: doc.versionId });
    const guard = await requireNothingDue(db.query, {
      point: own,
      participant: a,
      payer: a,
      now: nowIso(),
    });
    // "Agree again" lands between the read and the commit: the batch fails whole.
    await republish(doc.id, "agree_again", "Fixture text, agree again meanwhile.");
    const marker = `aga_${unique("marker")}`;
    await expect(
      env.DB.batch([
        env.DB.prepare(guard.sql).bind(...guard.parameters),
        env.DB.prepare(
          "INSERT INTO core_agreement_minor (person_id, set_by, set_at) VALUES (?, 'usr_x', 'now')",
        ).bind(marker),
      ]),
    ).rejects.toThrow(/core_agreements_changed/);
    expect(
      await env.DB.prepare("SELECT 1 FROM core_agreement_minor WHERE person_id = ?")
        .bind(marker)
        .first(),
    ).toBeNull();
    // Asked again, it is refused with the new version due.
    expect(
      await refusal(
        requireNothingDue(db.query, { point: own, participant: a, payer: a, now: nowIso() }),
      ),
    ).toMatchObject({ details: { rule: "agreements_due" } });
  });

  it("an acceptance planned before an attach or publish commits fails as a conflict", async () => {
    const doc = await liveDocument("waiver", { points: [OTHER] });
    const a = await person();
    const planned = await planAcceptance(
      db.query,
      { versionId: doc.versionId, personId: a, by: "self", channel: "web", typedName: "N" },
      nowIso(),
    );
    await invoke("agreement.attach", { documentId: doc.id, points: [POINT] }, context(admin));
    await expect(db.batch(planned.statements)).rejects.toThrow(/core_agreements_changed/);
    expect(
      await env.DB.prepare("SELECT 1 FROM core_agreement_acceptance WHERE id = ?")
        .bind(planned.id)
        .first(),
    ).toBeNull();
    // Over the operation the same race is a conflict to look again at; a retry records it.
    const conflict = await (async () => {
      const again = await planAcceptance(
        db.query,
        { versionId: doc.versionId, personId: a, by: "self", channel: "web", typedName: "N" },
        nowIso(),
      );
      await invoke("agreement.detach", { documentId: doc.id, points: [POINT] }, context(admin));
      return refusal(db.batch(again.statements));
    })();
    expect(String(conflict.message)).toMatch(/core_agreements_changed/);
    await accept(a, { versionId: doc.versionId });
  });
});

describe("a signed-in customer agrees", () => {
  it("for themselves, typed or drawn, and reads it back; the capture is checked", async () => {
    const typed = await liveDocument("terms", { points: [OTHER] });
    const drawn = await liveDocument("waiver", { points: [OTHER], how: "drawn" });
    const a = await person();
    const due = (await invokeByName("me.agreements.due", {}, asCustomer(a))) as {
      people: {
        personId: string;
        self: boolean;
        canAgree: boolean;
        due: { documentId: string }[];
      }[];
    };
    expect(due.people[0]).toMatchObject({ personId: a, self: true, canAgree: true });
    expect(due.people[0]?.due.map((d) => d.documentId)).toEqual(
      expect.arrayContaining([typed.id, drawn.id]),
    );
    const done = (await accept(a, { versionId: typed.versionId, typedName: "Ada Fixture" })) as {
      id: string;
    };
    expect(await acceptanceRow(done.id)).toMatchObject({
      by: "self",
      how: "typed",
      channel: "web",
      person_id: a,
      agent_person_id: null,
      typed_name: "Ada Fixture",
    });
    // A drawn document needs strokes; a typed one takes none.
    expect(await refusal(accept(a, { versionId: drawn.versionId }))).toMatchObject({
      details: { rule: "agreement_signature" },
    });
    expect(
      await refusal(accept(a, { versionId: typed.versionId, signature: SIGNATURE })),
    ).toMatchObject({ details: { rule: "agreement_signature" } });
    // Strokes: empty, a dot, too many points, outside the box.
    for (const signature of [
      { width: 1000, height: 400, strokes: [] },
      {
        width: 1000,
        height: 400,
        strokes: [
          [
            [10, 10],
            [10, 10],
          ],
        ],
      },
      {
        width: 1000,
        height: 400,
        strokes: [Array.from({ length: 5001 }, (_, i) => [i % 1000, i % 400])],
      },
      {
        width: 1000,
        height: 400,
        strokes: [
          [
            [0, 0],
            [2000, 0],
          ],
        ],
      },
    ]) {
      const refused = await refusal(accept(a, { versionId: drawn.versionId, signature }));
      expect(refused.code).toBe("invalid_input");
    }
    const signed = (await accept(a, { versionId: drawn.versionId, signature: SIGNATURE })) as {
      id: string;
    };
    const mine = (await invokeByName("me.agreements.get", { id: signed.id }, asCustomer(a))) as {
      signature: unknown;
      how: string;
      counts: boolean;
    };
    expect(mine).toMatchObject({ how: "drawn", counts: true, signature: SIGNATURE });
    // Someone else's is not found.
    expect(
      await refusal(
        invokeByName("me.agreements.get", { id: signed.id }, asCustomer(await person())),
      ),
    ).toMatchObject({ code: "not_found" });
    const list = (await invokeByName("me.agreements.list", {}, asCustomer(a))) as {
      items: { id: string }[];
    };
    expect(list.items.map((i) => i.id)).toEqual(expect.arrayContaining([done.id, signed.id]));
  });

  it("a guardian agrees for a live dependant; a link ended before the commit fails the batch", async () => {
    const doc = await liveDocument("guardian", { points: [OTHER], forWhom: "dependants" });
    const parent = await person("Parent");
    const child = await person("Child");
    const link = await invoke(
      "person.link.add",
      { guardianId: parent, dependantId: child },
      context(admin),
    );
    const due = (await invokeByName("me.agreements.due", {}, asCustomer(parent))) as {
      people: { personId: string; self: boolean; due: { documentId: string }[] }[];
    };
    const forChild = due.people.find((p) => p.personId === child);
    expect(forChild?.due.map((d) => d.documentId)).toContain(doc.id);
    // Not for the parent themselves: a dependants document.
    expect(due.people.find((p) => p.self)?.due.map((d) => d.documentId)).not.toContain(doc.id);
    const done = (await accept(parent, { versionId: doc.versionId, forPersonId: child })) as {
      id: string;
    };
    expect(await acceptanceRow(done.id)).toMatchObject({
      by: "guardian",
      person_id: child,
      agent_person_id: parent,
    });
    // The child's own acceptance is refused: a dependant is a minor (signed in or not).
    expect(await refusal(accept(child, { versionId: doc.versionId }))).toMatchObject({
      code: "forbidden",
      details: { rule: "agreement_minor" },
    });
    // Planned while live, committed after the link ended: the batch fails.
    const planned = await planAcceptance(
      db.query,
      {
        versionId: doc.versionId,
        personId: child,
        by: "guardian",
        agentPersonId: parent,
        channel: "web",
        typedName: "N",
      },
      nowIso(),
    );
    await invoke("person.link.end", { id: link.id }, context(admin));
    // Ending the link moves the agreements counter, so the whole batch fails on its guard; and
    // without that guard, the family link's own guard fails it too.
    await expect(db.batch(planned.statements)).rejects.toThrow(/core_agreements_changed/);
    await expect(db.batch(planned.statements.slice(1))).rejects.toThrow(
      /core_person_link_not_live/,
    );
    // Ended, the parent cannot agree for them at all; another Person never could.
    expect(
      await refusal(accept(parent, { versionId: doc.versionId, forPersonId: child })),
    ).toMatchObject({ code: "not_found" });
    expect(
      await refusal(accept(await person(), { versionId: doc.versionId, forPersonId: child })),
    ).toMatchObject({ code: "not_found" });
    // What the parent agreed stays (ending a link does not undo it).
    expect(await acceptanceRow(done.id)).toMatchObject({ person_id: child });
  });

  it("a marked minor cannot agree for themselves, by any path; marking is a person's with people:link", async () => {
    const doc = await liveDocument("waiver", { points: [OTHER] });
    const teen = await person("Teen");
    for (const extra of AI_ACTORS) {
      const refused = await refusal(
        invoke("agreement.setMinor", { personId: teen, minor: true }, aiContext(extra)),
      );
      expect(refused.code, extra.actor).toBe("forbidden");
      expect(refused).not.toBeInstanceOf(PendingApprovalError);
    }
    expect(
      await refusal(invoke("agreement.setMinor", { personId: teen, minor: true }, context(member))),
    ).toMatchObject({ code: "forbidden", details: { permission: "people:link" } });
    await invoke("agreement.setMinor", { personId: teen, minor: true }, context(admin));
    expect(await refusal(accept(teen, { versionId: doc.versionId }))).toMatchObject({
      details: { rule: "agreement_minor" },
    });
    const self = await invokeByName("me.agreements.due", {}, asCustomer(teen));
    expect(self).toMatchObject({ people: [{ self: true, canAgree: false }] });
    // The database refuses it too, whatever the writer.
    const { hash } = (await env.DB.prepare("SELECT hash FROM core_agreement_version WHERE id = ?")
      .bind(doc.versionId)
      .first<{ hash: string }>()) as { hash: string };
    await expect(
      env.DB.prepare(
        `INSERT INTO core_agreement_acceptance (id, document_id, version_id, shown_hash, person_id,
           by, how, typed_name, channel, accepted_at) VALUES (?, ?, ?, ?, ?, 'self', 'typed', 'N', 'web', 'now')`,
      )
        .bind(`aga_${unique("minor")}`, doc.id, doc.versionId, hash, teen)
        .run(),
    ).rejects.toThrow(/core_agreement_minor_self/);
    // Paper counts for them; cleared, they agree themselves.
    const tab = await invoke("agreement.person", { personId: teen }, context(admin));
    expect(tab.minor).toMatchObject({ marked: true, dependant: false });
    await invoke("agreement.setMinor", { personId: teen, minor: false }, context(admin));
    await accept(teen, { versionId: doc.versionId });
  });
});

describe("staff record a paper form", () => {
  it("names the staff user and the date on the form, is a person's only, and needs agreements:paper", async () => {
    const doc = await liveDocument("waiver", { points: [OTHER] });
    const child = await person("Child");
    const today = nowIso().slice(0, 10);
    const input = {
      personId: child,
      versionId: doc.versionId,
      signedOn: today,
      typedName: "Fixture Child",
      signedBy: "Fixture parent",
    };
    for (const extra of AI_ACTORS) {
      const refused = await refusal(invoke("agreement.recordPaper", input, aiContext(extra)));
      expect(refused.code, extra.actor).toBe("forbidden");
    }
    expect(await refusal(invoke("agreement.recordPaper", input, context(member)))).toMatchObject({
      code: "forbidden",
      details: { permission: "agreements:paper" },
    });
    // A date before the version existed, or in the future, is refused.
    expect(
      await refusal(
        invoke("agreement.recordPaper", { ...input, signedOn: "2001-01-01" }, context(admin)),
      ),
    ).toMatchObject({ details: { rule: "agreement_signed_on" } });
    const done = await invoke("agreement.recordPaper", input, context(admin));
    expect(await acceptanceRow(done.id)).toMatchObject({
      by: "paper",
      how: "paper",
      channel: "paper",
      recorded_by: admin.id,
      signed_on: today,
      signed_by: "Fixture parent",
      account_id: null,
    });
    const tab = await invoke("agreement.person", { personId: child }, context(admin));
    expect(tab.acceptances[0]).toMatchObject({
      by: "paper",
      recordedBy: admin.id,
      recordedByName: admin.name,
      signedOn: today,
    });
    expect(tab.documents.find((d: { documentId: string }) => d.documentId === doc.id)?.status).toBe(
      "current",
    );
    // A member granted it records one.
    await invoke(
      "user.setPermissions",
      { id: member.id, permissions: ["agreements:paper"] },
      context(admin),
    );
    await invoke("agreement.recordPaper", input, context(member));
    // The audit holds who recorded it and for whom, never the name on the form.
    const audit = await env.DB.prepare(
      "SELECT input, result FROM core_audit WHERE operation = 'agreement.recordPaper' AND outcome = 'ok'",
    ).all<{ input: string; result: string }>();
    expect(JSON.stringify(audit.results)).not.toContain("Fixture Child");
    expect(JSON.stringify(audit.results)).not.toContain("Fixture parent");
  });
});

describe("health answers are isolated", () => {
  const SECRET = `FixtureHealthNote${Date.now().toString(36)}`;
  let healthDoc: { id: string; versionId: string };
  let subject: string;
  let acceptanceId: string;

  beforeAll(async () => {
    healthDoc = await liveDocument("health", { points: [OTHER] });
    subject = await person("Health");
    acceptanceId = (
      (await accept(subject, {
        versionId: healthDoc.versionId,
        typedName: `Typed${SECRET}`,
        answers: [
          { key: "heart", yes: true, note: SECRET },
          { key: "joints", yes: false },
        ],
      })) as { id: string }
    ).id;
  });

  it("answers are checked against the questions, with errors that carry no value", async () => {
    const a = await person();
    for (const answers of [
      undefined,
      [{ key: "heart", yes: false }],
      [
        { key: "heart", yes: false, note: SECRET },
        { key: "joints", yes: false },
      ],
      [
        { key: "heart", yes: false },
        { key: "joints", yes: true, note: SECRET },
      ],
      [
        { key: "heart", yes: false },
        { key: "joints", yes: false },
        { key: "other", yes: true },
      ],
      [
        { key: "heart", yes: true, note: "x".repeat(1001) },
        { key: "joints", yes: false },
      ],
    ]) {
      const refused = await refusal(
        accept(a, { versionId: healthDoc.versionId, ...(answers ? { answers } : {}) }),
      );
      expect(refused.code).toBe("invalid_input");
      expect(JSON.stringify(refused)).not.toContain(SECRET);
    }
    // And a waiver takes no answers.
    const waiver = await liveDocument("waiver", { points: [OTHER] });
    expect(
      await refusal(
        accept(a, { versionId: waiver.versionId, answers: [{ key: "heart", yes: true }] }),
      ),
    ).toMatchObject({ details: { rule: "agreement_answers" } });
  });

  it("a person with agreements:health reads them, every read audited with no value", async () => {
    const read = await invoke("agreement.answers.get", { acceptanceId }, context(admin));
    expect(read.answers).toEqual([
      { key: "heart", text: "Fixture question one?", yes: true, note: SECRET },
      { key: "joints", text: "Fixture question two?", yes: false, note: null },
    ]);
    await invoke("agreement.answers.get", { acceptanceId }, context(admin));
    const audit = await env.DB.prepare(
      "SELECT input, result, actor FROM core_audit WHERE operation = 'agreement.answers.get' AND user_id = ? AND outcome = 'ok'",
    )
      .bind(admin.id)
      .all<{ input: string; result: string; actor: string }>();
    expect(audit.results.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(audit.results[0]?.result ?? "{}")).toEqual({
      acceptanceId,
      personId: subject,
    });
    expect(JSON.stringify(audit.results)).not.toContain(SECRET);
    // A member without it is refused; granted, a member reads them.
    expect(
      await refusal(invoke("agreement.answers.get", { acceptanceId }, context(member))),
    ).toMatchObject({ code: "forbidden", details: { permission: "agreements:health" } });
    await invoke(
      "user.setPermissions",
      { id: member.id, permissions: ["agreements:health"] },
      context(admin),
    );
    expect(
      (await invoke("agreement.answers.get", { acceptanceId }, context(member))).answers,
    ).toHaveLength(2);
    await invoke("user.setPermissions", { id: member.id, permissions: [] }, context(admin));
  });

  it("no AI actor reads them, a name typed or a signature, with any grant; nothing is queued", async () => {
    await setPreset("cautious");
    try {
      for (const extra of AI_ACTORS) {
        const ctx = context(admin, {
          ...extra,
          ...(extra.actor === "mcp"
            ? { grantedPermissions: ["records:read", "agreements:health", "agreements:paper"] }
            : {}),
        });
        for (const [name, input] of [
          ["agreement.answers.get", { acceptanceId }],
          ["agreement.acceptance.get", { id: acceptanceId }],
        ] as const) {
          const refused = await refusal(invoke(name, input, ctx));
          expect(refused.code, `${name} by ${extra.actor}`).toBe("forbidden");
          expect(JSON.stringify(refused)).not.toContain(SECRET);
        }
        if (extra.actor !== "extension") {
          // The Person tab an AI may read: titles and dates, no mark, no name typed.
          const tab = await invoke("agreement.person", { personId: subject }, ctx);
          expect(tab.healthNote).toBeNull();
          expect(tab.can).toEqual({
            recordPaper: false,
            setMinor: false,
            readAnswers: false,
            signAtDesk: false,
          });
          expect(JSON.stringify(tab)).not.toContain(SECRET);
          const list = await invoke("agreement.acceptances", { documentId: healthDoc.id }, ctx);
          expect(JSON.stringify(list)).not.toContain(SECRET);
        }
      }
      // Pack code reads the mark only inside a tool a person called.
      expect(
        await refusal(
          invoke(
            "agreement.healthNotes",
            { personIds: [subject] },
            context(admin, {
              actor: "extension",
              origin: { surface: "extension", extensionId: "bookings" },
            }),
          ),
        ),
      ).toMatchObject({ code: "forbidden" });
    } finally {
      await setPreset("balanced");
    }
  });

  it("a person on the staff sees the mark only; a pack-role coach reads nothing of the form", async () => {
    const notes = await invoke(
      "agreement.healthNotes",
      { personIds: [subject, await person()] },
      context(admin),
    );
    expect(notes.notes.map((n: { healthNote: boolean }) => n.healthNote)).toEqual([true, false]);
    const tab = await invoke("agreement.person", { personId: subject }, context(admin));
    expect(tab.healthNote).toBe(true);
    expect(tab.can.readAnswers).toBe(true);
    expect(JSON.stringify(tab)).not.toContain(SECRET);
    // A coach (an account holding a pack role) reaches none of the core reads.
    const coach = await createUser("member");
    await env.DB.prepare("UPDATE core_user SET pack_role = 'bookings.coach' WHERE id = ?")
      .bind(coach.id)
      .run();
    for (const [name, input] of [
      ["agreement.answers.get", { acceptanceId }],
      ["agreement.acceptance.get", { id: acceptanceId }],
      ["agreement.person", { personId: subject }],
    ] as const) {
      expect((await refusal(invoke(name, input, context(coach)))).code, name).toBe("forbidden");
    }
    // The staff told of the yes: a notice that names no one and nothing of the form.
    const notice = await env.DB.prepare(
      "SELECT title, body, link FROM core_notifications WHERE dedupe_key = ?",
    )
      .bind(`agreement-health:${acceptanceId}`)
      .all<{ title: string; body: string }>();
    expect(notice.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(notice.results)).not.toContain(SECRET);
  });

  it("no bulk path reaches them: query.sql, views, search, export, summaries, the audit", async () => {
    for (const table of [
      "core_agreement_acceptance",
      "core_agreement_signature",
      "core_agreement_answer",
      "core_agreement_minor",
    ]) {
      expect(
        await refusal(invoke("query.sql", { sql: `SELECT * FROM ${table}` }, context(admin))),
      ).toMatchObject({ code: "invalid_input" });
    }
    const views = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'view' AND sql LIKE '%core_agreement%'",
    ).all();
    expect(views.results).toEqual([]);
    const found = await invoke("search.global", { query: SECRET }, context(admin));
    expect(JSON.stringify(found)).not.toContain(SECRET);
    const csv = await invoke("export.csv", { object: "person" }, context(admin));
    expect(csv.csv).not.toContain(SECRET);
    // The assistant's person-level summary: nothing of the form goes to the model.
    const { models, binding } = testRunner();
    const summary = await invoke(
      "summary.generate",
      { subject: { kind: "record", object: "person", id: subject } },
      context(admin, { actor: "assistant", origin: { surface: "assistant" }, models }),
    );
    expect(summary.status).toBe("fresh");
    expect(binding.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(binding.calls)).not.toContain(SECRET);
    // No audit row, of any operation, holds the note or the name typed.
    const audit = await env.DB.prepare(
      "SELECT input, result, error FROM core_audit WHERE input LIKE ? OR result LIKE ? OR error LIKE ?",
    )
      .bind(`%${SECRET}%`, `%${SECRET}%`, `%${SECRET}%`)
      .all();
    expect(audit.results).toEqual([]);
    const changes = await env.DB.prepare("SELECT 1 FROM core_audit_changes WHERE diff LIKE ?")
      .bind(`%${SECRET}%`)
      .all();
    expect(changes.results).toEqual([]);
  });
});

describe("erase and merge (what step 2's tables need)", () => {
  it("erase deletes health answers and the minor mark at once, and keeps the acceptance detached", async () => {
    const health = await liveDocument("health", { points: [OTHER] });
    const drawn = await liveDocument("waiver", { points: [OTHER], how: "drawn" });
    const a = await person("Erased");
    const answered = (await accept(a, {
      versionId: health.versionId,
      answers: [
        { key: "heart", yes: true },
        { key: "joints", yes: false },
      ],
    })) as { id: string };
    const signed = (await accept(a, { versionId: drawn.versionId, signature: SIGNATURE })) as {
      id: string;
    };
    await invoke("agreement.setMinor", { personId: a, minor: true }, context(admin));
    await invoke("person.erase", { id: a }, context(admin));
    expect(
      await env.DB.prepare("SELECT 1 FROM core_agreement_answer WHERE acceptance_id = ?")
        .bind(answered.id)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM core_agreement_minor WHERE person_id = ?")
        .bind(a)
        .first(),
    ).toBeNull();
    const kept = await acceptanceRow(signed.id);
    expect(kept).toMatchObject({ person_id: null, agent_person_id: null, account_id: null });
    expect(kept?.erased_at).toBeTruthy();
    // Once erased it is nobody's again, by any writer.
    await expect(
      env.DB.prepare("UPDATE core_agreement_acceptance SET person_id = ? WHERE id = ?")
        .bind(await person(), signed.id)
        .run(),
    ).rejects.toThrow(/immutable/);
  });

  it("merge moves acceptances to the survivor and keeps the minor mark", async () => {
    const doc = await liveDocument("waiver", { points: [OTHER] });
    const survivor = await person("Survivor");
    const merged = await person("Merged");
    const done = (await accept(merged, { versionId: doc.versionId })) as { id: string };
    await invoke("agreement.setMinor", { personId: merged, minor: true }, context(admin));
    await invoke("person.merge", { survivorId: survivor, mergedId: merged }, context(admin));
    expect(await acceptanceRow(done.id)).toMatchObject({
      person_id: survivor,
      typed_name: "Fixture Name",
    });
    const tab = await invoke("agreement.person", { personId: survivor }, context(admin));
    expect(tab.minor.marked).toBe(true);
  });
});

const nowIso = () => new Date().toISOString();

/** A point of its own, on a fixture object installed for it: what is attached there is only ours. */
async function newPoint(tag: string): Promise<string> {
  const point = `p${tag}${unique()}`.toLowerCase().slice(0, 30);
  await reconcile(
    manifest(extId(tag), {
      objects: {
        plan: {
          label: "Plan",
          plural: "Plans",
          titleField: "name",
          fields: { name: { type: "text", label: "Name" } },
          agreements: { point, label: "Somewhere" },
        },
      },
    }),
  );
  return point;
}

/** A pack declaring a health-note list: seats on a slot, each for a Person. */
async function healthListPack(): Promise<string> {
  const ext = extId("hn");
  await reconcile(
    manifest(ext, {
      permissions: { read: [], write: [], operations: ["agreement.listHealthNotes"], modules: [] },
      objects: {
        slot: {
          label: "Slot",
          plural: "Slots",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name" },
            startsAt: { type: "datetime", label: "Starts" },
          },
        },
        seat: {
          label: "Seat",
          plural: "Seats",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name" },
            slot: { type: "relation", label: "Slot", to: `${ext}.slot` },
            person: { type: "relation", label: "Person", to: "person" },
          },
          healthNotes: { list: "slot", person: "person" },
        },
      },
    }),
  );
  return ext;
}

const slotRecord = async (ext: string, startsAt: string) =>
  (
    await invoke(
      "record.create",
      { object: `${ext}.slot`, values: { name: unique("Slot"), startsAt } },
      context(admin),
    )
  ).id as string;

const seat = async (ext: string, slot: string, personId: string) =>
  (
    await invoke(
      "record.create",
      { object: `${ext}.seat`, values: { name: unique("Seat"), slot, person: personId } },
      context(admin),
    )
  ).id as string;

/** Pack code of `id`, inside the run of `tool` (or none). */
const asPack = (id: string, tool: Record<string, unknown> | undefined) =>
  context(admin, {
    actor: "extension",
    origin: { surface: "extension", extensionId: id },
    extension: {
      id,
      permissions: { operations: ["agreement.listHealthNotes"], modules: [] } as never,
      ...(tool ? { tool: tool as never } : {}),
    },
  });

// The security review of PR #274: each of these failed before its fix.
describe("the review of PR #274", () => {
  const yesAnswers = [
    { key: "heart", yes: true, note: "Fixture note" },
    { key: "joints", yes: false },
  ];

  it("1: a health notice names no Person, so an AI reading notifications learns nobody", async () => {
    const health = await liveDocument("health", { points: [OTHER] });
    const subject = await person("Notice");
    const done = (await accept(subject, { versionId: health.versionId, answers: yesAnswers })) as {
      id: string;
    };
    const name = (await invoke("person.get", { id: subject }, context(admin))).displayName;
    for (const extra of AI_ACTORS.slice(0, 2)) {
      const seen = JSON.stringify(
        await invoke("notification.list", { limit: 100 }, context(admin, extra)),
      );
      // Not listed to an AI at all (the second review): its time would match the acceptance.
      expect(seen).not.toContain("health form needs a look");
      expect(seen).not.toContain(subject);
      expect(seen).not.toContain(name);
      expect(seen).not.toContain(done.id);
    }
  });

  it("2: health notes need agreements:health for staff, and pack code gets them only for a list it declares, from a person", async () => {
    const health = await liveDocument("health", { points: [OTHER] });
    const subject = await person("Mark");
    const other = await person("Other");
    await accept(subject, { versionId: health.versionId, answers: yesAnswers });
    await accept(other, { versionId: health.versionId, answers: yesAnswers });
    // Plain staff are refused; a person with the permission reads it, audited.
    expect(
      await refusal(invoke("agreement.healthNotes", { personIds: [subject] }, context(member))),
    ).toMatchObject({ code: "forbidden", details: { permission: "agreements:health" } });
    const read = await invoke("agreement.healthNotes", { personIds: [subject] }, context(admin));
    expect(read.notes).toEqual([{ personId: subject, healthNote: true }]);
    const audit = await env.DB.prepare(
      "SELECT result FROM core_audit WHERE operation = 'agreement.healthNotes' AND user_id = ? AND outcome = 'ok'",
    )
      .bind(admin.id)
      .all<{ result: string }>();
    expect(audit.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit.results)).not.toContain('"healthNote"');
    // A pack that declares its list: seats on a slot, each for a Person.
    const ext = await healthListPack();
    const slot = await slotRecord(ext, new Date().toISOString());
    await seat(ext, slot, subject);
    const tool = { name: "list", humanOnly: false, permission: null, startedBy: admin.id };
    const input = { records: `${ext}.seat`, value: slot };
    expect((await invoke("agreement.listHealthNotes", input, asPack(ext, tool))).notes).toEqual([
      { personId: subject, healthNote: true },
    ]);
    // Every call is audited, with what was asked and not who is marked.
    const rows = await env.DB.prepare(
      "SELECT result FROM core_audit WHERE operation = 'agreement.listHealthNotes' AND outcome = 'ok'",
    ).all<{ result: string }>();
    expect(rows.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows.results)).not.toContain(subject);
    // No person started the tool, or a person approved an AI's call: refused.
    for (const t of [
      { ...tool, startedBy: undefined },
      { ...tool, startedByApproval: true },
      undefined,
    ]) {
      expect((await refusal(invoke("agreement.listHealthNotes", input, asPack(ext, t)))).code).toBe(
        "forbidden",
      );
    }
    // Another pack, or an object that declares no list, is refused; extra keys pick nothing.
    expect(
      (await refusal(invoke("agreement.listHealthNotes", input, asPack("bookings", tool)))).code,
    ).toBe("forbidden");
    expect(
      (
        await refusal(
          invoke(
            "agreement.listHealthNotes",
            { records: `${ext}.slot`, value: slot },
            asPack(ext, tool),
          ),
        )
      ).code,
    ).toBe("forbidden");
    const picked = await invoke(
      "agreement.listHealthNotes",
      { ...input, field: "person", value: slot, person: "person" } as never,
      asPack(ext, tool),
    );
    expect(picked.notes.map((n: { personId: string }) => n.personId)).toEqual([subject]);
    // The value must be a live record of the list's own object: a Person's id, or a slot in the
    // Trash, finds nothing.
    expect(
      (
        await refusal(
          invoke("agreement.listHealthNotes", { ...input, value: other }, asPack(ext, tool)),
        )
      ).code,
    ).toBe("not_found");
    const trashed = await slotRecord(ext, new Date().toISOString());
    await seat(ext, trashed, other);
    await invoke("record.delete", { object: `${ext}.slot`, id: trashed }, context(admin));
    expect(
      (
        await refusal(
          invoke("agreement.listHealthNotes", { ...input, value: trashed }, asPack(ext, tool)),
        )
      ).code,
    ).toBe("not_found");
    // A seat in the Trash is not on the list.
    const seatId = await seat(ext, slot, other);
    await invoke("record.delete", { object: `${ext}.seat`, id: seatId }, context(admin));
    expect(
      (await invoke("agreement.listHealthNotes", input, asPack(ext, tool))).notes.map(
        (n: { personId: string }) => n.personId,
      ),
    ).toEqual([subject]);
    // A runtime extension may not declare the operation.
    const checked = await checkManifest(
      db.query,
      extId("rt"),
      manifest(extId("rt"), {
        permissions: {
          read: [],
          write: [],
          operations: ["agreement.listHealthNotes"],
          modules: [],
        },
      }),
      nowIso(),
      { source: "runtime" },
    );
    expect(JSON.stringify(checked.issues)).toContain("cannot read health notes");
    // The declaration is checked: the list must be a relation to another object.
    const bad = await checkManifest(
      db.query,
      extId("bad"),
      manifest(extId("bad"), {
        objects: {
          seat: {
            label: "Seat",
            plural: "Seats",
            titleField: "name",
            fields: {
              name: { type: "text", label: "Name" },
              person: { type: "relation", label: "Person", to: "person" },
            },
            healthNotes: { list: "name", person: "person" },
          },
        },
      }),
      nowIso(),
    );
    expect(JSON.stringify(bad.issues)).toContain("list must be a relation field");
    // The Person tab shows the mark only to staff who may read answers.
    const tab = await invoke("agreement.person", { personId: subject }, context(member));
    expect(tab.healthNote).toBeNull();
  });

  it("2b: a coach's today-only limit holds on the list's own record", async () => {
    const ext = await healthListPack();
    const health = await liveDocument("health", { points: [OTHER] });
    const subject = await person("Today");
    await accept(subject, { versionId: health.versionId, answers: yesAnswers });
    const today = await slotRecord(ext, new Date().toISOString());
    const lastWeek = await slotRecord(ext, new Date(Date.now() - 6 * 86_400_000).toISOString());
    await seat(ext, today, subject);
    await seat(ext, lastWeek, subject);
    const tool = { name: "list", humanOnly: false, permission: null, startedBy: admin.id };
    const limited = (value: string) =>
      invoke(
        "agreement.listHealthNotes",
        { records: `${ext}.seat`, value },
        {
          ...asPack(ext, tool),
          roleToday: { [`${ext}.slot`]: "startsAt", [`${ext}.seat`]: "slot.startsAt" },
        },
      );
    expect((await limited(today)).notes).toHaveLength(1);
    expect((await refusal(limited(lastWeek))).code).toBe("not_found");
  });

  it("1b, 3: an AI acting for a recipient sees no health notice at all, and no audited health read", async () => {
    const health = await liveDocument("health", { points: [OTHER] });
    const subject = await person("Quiet");
    await accept(subject, { versionId: health.versionId, answers: yesAnswers });
    await invoke("agreement.healthNotes", { personIds: [subject] }, context(admin));
    const asHuman = await invoke("notification.list", { limit: 100 }, context(admin));
    expect(JSON.stringify(asHuman)).toContain("health form needs a look");
    for (const extra of AI_ACTORS.slice(0, 2)) {
      const ctx = context(admin, {
        ...extra,
        ...(extra.actor === "mcp" ? { grantedPermissions: ["records:read", "audit:read"] } : {}),
      });
      const listed = await invoke("notification.list", { limit: 100 }, ctx);
      expect(JSON.stringify(listed)).not.toContain("health form needs a look");
      const unread = await invoke("notification.unreadCount", {}, ctx);
      expect(unread.unread).toBeLessThan(
        (await invoke("notification.unreadCount", {}, context(admin))).unread,
      );
      const audit = await invoke("audit.list", { limit: 200 }, ctx);
      const ops = JSON.stringify(audit);
      expect(ops).not.toContain("agreement.healthNotes");
      expect(ops).not.toContain("agreement.answers.get");
      expect(ops).not.toContain("agreement.healthReviews");
    }
    // A person reads them.
    const audit = await invoke(
      "audit.list",
      { operation: "agreement.healthNotes" },
      context(admin),
    );
    expect(audit.items.length).toBeGreaterThan(0);
  });

  it("2c: a second guardian, or the child, sees that a guardian agreed and nothing they typed or drew", async () => {
    const drawn = await liveDocument("waiver", { points: [OTHER], how: "drawn" });
    const first = await person("First");
    const second = await person("Second");
    const child = await person("Child");
    await invoke("person.link.add", { guardianId: first, dependantId: child }, context(admin));
    await invoke("person.link.add", { guardianId: second, dependantId: child }, context(admin));
    const done = (await accept(
      first,
      {
        versionId: drawn.versionId,
        forPersonId: child,
        signature: SIGNATURE,
        typedName: "Fixture First",
      },
      { kind: "customer", customerId: "cus_first", personId: first },
    )) as { id: string };
    const read = (who: string) =>
      invokeByName("me.agreements.get", { id: done.id }, asCustomer(who)) as Promise<{
        typedName: string | null;
        signature: unknown;
        agentPersonId: string | null;
        by: string;
      }>;
    expect(await read(first)).toMatchObject({
      by: "guardian",
      typedName: "Fixture First",
      signature: SIGNATURE,
      agentPersonId: first,
    });
    for (const other of [second, child]) {
      expect(await read(other)).toMatchObject({
        by: "guardian",
        typedName: null,
        signature: null,
        agentPersonId: null,
      });
    }
    const list = (await invokeByName("me.agreements.list", {}, asCustomer(second))) as {
      items: { id: string; agentPersonId: string | null }[];
    };
    expect(list.items.find((i) => i.id === done.id)?.agentPersonId).toBeNull();
  });

  it("6: a minor mark is never rewritten, and a Person is never inserted over one", async () => {
    const a = await person();
    const b = await person();
    await invoke("agreement.setMinor", { personId: a, minor: true }, context(admin));
    await expect(
      env.DB.prepare("UPDATE core_agreement_minor SET person_id = ? WHERE person_id = ?")
        .bind(b, a)
        .run(),
    ).rejects.toThrow(/core_agreement_minor_fixed/);
    for (const statement of [
      "INSERT OR REPLACE INTO core_person (id, display_name, created_at, updated_at, deleted_at) VALUES (?, 'X', 'now', 'now', 'now')",
      "INSERT OR IGNORE INTO core_person (id, display_name, created_at, updated_at) VALUES (?, 'X', 'now', 'now')",
    ]) {
      await expect(env.DB.prepare(statement).bind(b).run(), statement).rejects.toThrow(
        /core_person_exists/,
      );
    }
    expect(
      (await env.DB.prepare("SELECT deleted_at FROM core_person WHERE id = ?").bind(b).first())
        ?.deleted_at,
    ).toBeNull();
  });

  it("3: becoming a minor, a link starting or ending, the Trash and a merge each fail a guard taken before", async () => {
    const own = await newPoint("acr");
    await liveDocument("guardian", { points: [own], forWhom: "dependants" });
    const guarded = async (change: () => Promise<unknown>, subject: string) => {
      const guard = await requireNothingDue(db.query, {
        point: own,
        participant: subject,
        payer: subject,
        now: nowIso(),
      });
      await change();
      await expect(
        env.DB.batch([env.DB.prepare(guard.sql).bind(...guard.parameters)]),
      ).rejects.toThrow(/core_agreements_changed/);
    };
    const a = await person();
    await guarded(
      () => invoke("agreement.setMinor", { personId: a, minor: true }, context(admin)),
      a,
    );
    const b = await person();
    const parent = await person("Parent");
    let link: { id: string } | null = null;
    const rev = async () =>
      (await env.DB.prepare("SELECT rev FROM core_agreement_rev").first<{ rev: number }>())?.rev;
    const before = await rev();
    link = await invoke("person.link.add", { guardianId: parent, dependantId: b }, context(admin));
    expect(await rev()).toBeGreaterThan(before ?? 0);
    const c = await person();
    const linked = link as { id: string };
    await guarded(() => invoke("person.link.end", { id: linked.id }, context(admin)), c);
    await guarded(() => invoke("person.delete", { id: c }, context(admin)), c);
    await guarded(() => invoke("person.restore", { id: c }, context(admin)), c);
    const d = await person();
    await guarded(() => invoke("person.merge", { survivorId: c, mergedId: d }, context(admin)), c);
  });

  it("4: erasing a guardian clears their name and strokes on the child's acceptance and keeps the record", async () => {
    const drawn = await liveDocument("waiver", { points: [OTHER], how: "drawn" });
    const parent = await person("Parent");
    const child = await person("Child");
    await invoke("person.link.add", { guardianId: parent, dependantId: child }, context(admin));
    const done = (await accept(
      parent,
      { versionId: drawn.versionId, forPersonId: child, signature: SIGNATURE },
      { kind: "customer", customerId: "cus_parent", personId: parent },
    )) as { id: string };
    await invoke("person.erase", { id: parent }, context(admin));
    const row = await acceptanceRow(done.id);
    expect(row).toMatchObject({
      person_id: child,
      by: "guardian",
      agent_person_id: null,
      account_id: null,
      typed_name: null,
      version_id: drawn.versionId,
    });
    expect(row?.erased_at).toBeTruthy();
    expect(
      await env.DB.prepare("SELECT 1 FROM core_agreement_signature WHERE acceptance_id = ?")
        .bind(done.id)
        .first(),
    ).toBeNull();
    // It no longer counts for the child: another guardian, or paper, agrees again.
    const tab = await invoke("agreement.person", { personId: child }, context(admin));
    expect(
      tab.documents.find((x: { documentId: string }) => x.documentId === drawn.id)?.status,
    ).toBe("due");
  });

  it("5: a raw writer cannot detach a live Person's acceptance, forge a guest's, or attach one to anyone", async () => {
    const doc = await liveDocument("waiver", { points: [OTHER] });
    const a = await person();
    const done = (await accept(a, { versionId: doc.versionId })) as { id: string };
    // (a) Detaching while the Person exists is refused, so the row cannot then be deleted.
    await expect(
      env.DB.prepare(
        "UPDATE core_agreement_acceptance SET person_id = NULL, erased_at = 'x' WHERE id = ?",
      )
        .bind(done.id)
        .run(),
    ).rejects.toThrow(/immutable/);
    await expect(
      env.DB.prepare("DELETE FROM core_agreement_acceptance WHERE id = ?").bind(done.id).run(),
    ).rejects.toThrow(/immutable/);
    const { hash } = (await env.DB.prepare("SELECT hash FROM core_agreement_version WHERE id = ?")
      .bind(doc.versionId)
      .first<{ hash: string }>()) as { hash: string };
    const guest = (personId: string | null, orderId: string) =>
      env.DB.prepare(
        `INSERT INTO core_agreement_acceptance (id, document_id, version_id, shown_hash, person_id,
           by, how, typed_name, channel, accepted_at, order_id) VALUES (?, ?, ?, ?, ?, 'guest', 'typed', 'N', 'web', 'now', ?)`,
      )
        .bind(`aga_${unique("guest")}`, doc.id, doc.versionId, hash, personId, orderId)
        .run();
    // (b) A guest's with a Person, or with an order that does not exist.
    await expect(guest(a, "ord_madeup")).rejects.toThrow(/immutable/);
    await expect(guest(null, "ord_madeup")).rejects.toThrow(/immutable/);
    // (c) A guest's on a real order attaches only to that order's Person.
    const orderId = `ord_${unique("raw")}`;
    const owner = await person("Buyer");
    await env.DB.prepare(
      "INSERT INTO core_order (id, person_id, currency, total, placed_as, created_at, updated_at) VALUES (?, NULL, 'AUD', 100, 'public', 'now', 'now')",
    )
      .bind(orderId)
      .run();
    const guestId = `aga_${unique("guest")}`;
    await env.DB.prepare(
      `INSERT INTO core_agreement_acceptance (id, document_id, version_id, shown_hash, person_id,
         by, how, typed_name, channel, accepted_at, order_id) VALUES (?, ?, ?, ?, NULL, 'guest', 'typed', 'N', 'web', 'now', ?)`,
    )
      .bind(guestId, doc.id, doc.versionId, hash, orderId)
      .run();
    const attach = (personId: string) =>
      env.DB.prepare("UPDATE core_agreement_acceptance SET person_id = ? WHERE id = ?")
        .bind(personId, guestId)
        .run();
    await expect(attach(a)).rejects.toThrow(/immutable/);
    await env.DB.prepare("UPDATE core_order SET person_id = ? WHERE id = ?")
      .bind(owner, orderId)
      .run();
    await expect(attach(a)).rejects.toThrow(/immutable/);
    await attach(owner);
  });

  it("6: a merge that moves acceptances is a person's, with agreements:manage", async () => {
    const doc = await liveDocument("waiver", { points: [OTHER] });
    const survivor = await person("Survivor");
    const merged = await person("Merged");
    await accept(merged, { versionId: doc.versionId });
    const input = { survivorId: survivor, mergedId: merged };
    expect(await refusal(invoke("person.merge", input, context(member)))).toMatchObject({
      code: "forbidden",
      details: { permission: "agreements:manage" },
    });
    await setPreset("cautious");
    try {
      const ai = await refusal(invoke("person.merge", input, aiContext(AI_ACTORS[0] as never)));
      expect(ai.code).toBe("forbidden");
      expect(ai).not.toBeInstanceOf(PendingApprovalError);
    } finally {
      await setPreset("balanced");
    }
  });

  it("7a: a Person marked minor cannot agree as a guardian, by the operation or the database", async () => {
    const doc = await liveDocument("guardian", { points: [OTHER], forWhom: "dependants" });
    const teen = await person("Teen");
    const child = await person("Child");
    await invoke("person.link.add", { guardianId: teen, dependantId: child }, context(admin));
    await invoke("agreement.setMinor", { personId: teen, minor: true }, context(admin));
    expect(
      await refusal(accept(teen, { versionId: doc.versionId, forPersonId: child })),
    ).toMatchObject({ details: { rule: "agreement_minor" } });
    const { hash } = (await env.DB.prepare("SELECT hash FROM core_agreement_version WHERE id = ?")
      .bind(doc.versionId)
      .first<{ hash: string }>()) as { hash: string };
    await expect(
      env.DB.prepare(
        `INSERT INTO core_agreement_acceptance (id, document_id, version_id, shown_hash, person_id,
           by, agent_person_id, how, typed_name, channel, accepted_at) VALUES (?, ?, ?, ?, ?, 'guardian', ?, 'typed', 'N', 'web', 'now')`,
      )
        .bind(`aga_${unique("minor")}`, doc.id, doc.versionId, hash, child, teen)
        .run(),
    ).rejects.toThrow(/core_agreement_minor_self/);
  });

  it("7b: a document attached nowhere is refused, and agreeing again to the same version records nothing", async () => {
    const { id } = await invoke(
      "agreement.create",
      { title: unique("Loose"), kind: "waiver" },
      context(admin),
    );
    const saved = await invoke(
      "agreement.draft.save",
      { id, body: body("Fixture text."), tickLabel: "I have read this fixture" },
      context(admin),
    );
    const { version } = await invoke(
      "agreement.publish",
      { documentId: id, draftHash: saved.hash, draftRev: saved.rev, number: 1, change: "small" },
      context(admin),
    );
    const a = await person();
    expect(await refusal(accept(a, { versionId: version.id }))).toMatchObject({
      details: { rule: "agreement_not_asked" },
    });
    const health = await liveDocument("health", { points: [OTHER] });
    const first = (await accept(a, { versionId: health.versionId, answers: yesAnswers })) as {
      id: string;
    };
    const again = (await accept(a, { versionId: health.versionId, answers: yesAnswers })) as {
      id: string;
    };
    expect(again.id).toBe(first.id);
    const rows = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_agreement_acceptance WHERE person_id = ? AND version_id = ?",
    )
      .bind(a, health.versionId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
    const notices = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_notifications WHERE dedupe_key LIKE ?",
    )
      .bind(`agreement-health:${first.id}`)
      .first<{ n: number }>();
    const readers = await env.DB.prepare(
      "SELECT count(DISTINCT user_id) AS n FROM core_notifications WHERE dedupe_key = ?",
    )
      .bind(`agreement-health:${first.id}`)
      .first<{ n: number }>();
    expect(notices?.n).toBe(readers?.n);
  });

  it("7c: a paper form counts for ask-again from the date on the form", async () => {
    const own = await newPoint("acp");
    const health = await liveDocument("health", { points: [own], askAgainMonths: 1 });
    const a = await person();
    // A version published today accepts a form dated from the day before (time zones).
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await invoke(
      "agreement.recordPaper",
      { personId: a, versionId: health.versionId, signedOn: yesterday, typedName: "Fixture" },
      context(admin),
    );
    const due = (when: number) =>
      agreementsDue(db.query, {
        point: own,
        participant: a,
        payer: a,
        now: new Date(Date.now() + when).toISOString(),
      });
    expect((await due(0)).due).toEqual([]);
    // Thirty days after the form's date (less than a month after it was typed in), it is due.
    const days = (n: number) => n * 86_400_000;
    const monthAfterForm = Date.parse(`${yesterday}T00:00:00.000Z`);
    const after = new Date(monthAfterForm);
    after.setUTCMonth(after.getUTCMonth() + 1);
    expect((await due(after.getTime() - Date.now() + days(0) + 60_000)).due).toMatchObject([
      { reason: "ask_again" },
    ]);
  });

  it("7d: a payer document is never due for a child, in the Person tab or the question", async () => {
    const own = await newPoint("acy");
    const { id } = await invoke(
      "agreement.create",
      { title: unique("Payer"), kind: "terms" },
      context(admin),
    );
    const saved = await invoke(
      "agreement.draft.save",
      { id, body: body("Fixture text."), tickLabel: "I have read this fixture", who: "payer" },
      context(admin),
    );
    await invoke(
      "agreement.publish",
      { documentId: id, draftHash: saved.hash, draftRev: saved.rev, number: 1, change: "small" },
      context(admin),
    );
    await invoke("agreement.attach", { documentId: id, points: [own] }, context(admin));
    const parent = await person("Parent");
    const child = await person("Child");
    await invoke("person.link.add", { guardianId: parent, dependantId: child }, context(admin));
    const tab = await invoke("agreement.person", { personId: child }, context(admin));
    expect(tab.documents.map((x: { documentId: string }) => x.documentId)).not.toContain(id);
    const asked = await agreementsDue(db.query, {
      point: own,
      participant: child,
      payer: parent,
      now: nowIso(),
    });
    expect(asked.due).toMatchObject([{ documentId: id, personId: parent }]);
  });

  it("7e: each layer of the guardian's live-link check refuses on its own", async () => {
    const doc = await liveDocument("guardian", { points: [OTHER], forWhom: "dependants" });
    const stranger = await person("Stranger");
    const child = await person("Child");
    await invoke(
      "person.link.add",
      { guardianId: await person(), dependantId: child },
      context(admin),
    );
    // The operation.
    expect(
      await refusal(accept(stranger, { versionId: doc.versionId, forPersonId: child })),
    ).toMatchObject({ code: "not_found" });
    // The plan, called directly.
    expect(
      await refusal(
        planAcceptance(
          db.query,
          {
            versionId: doc.versionId,
            personId: child,
            by: "guardian",
            agentPersonId: stranger,
            channel: "web",
            typedName: "N",
          },
          nowIso(),
        ),
      ),
    ).toMatchObject({ code: "not_found" });
    // The 0851 trigger, with no link at all.
    const { hash } = (await env.DB.prepare("SELECT hash FROM core_agreement_version WHERE id = ?")
      .bind(doc.versionId)
      .first<{ hash: string }>()) as { hash: string };
    await expect(
      env.DB.prepare(
        `INSERT INTO core_agreement_acceptance (id, document_id, version_id, shown_hash, person_id,
           by, agent_person_id, how, typed_name, channel, accepted_at) VALUES (?, ?, ?, ?, ?, 'guardian', ?, 'typed', 'N', 'web', 'now')`,
      )
        .bind(`aga_${unique("nolink")}`, doc.id, doc.versionId, hash, child, stranger)
        .run(),
    ).rejects.toThrow(/core_person_link_not_live/);
  });
});
