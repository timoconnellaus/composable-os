// Stage 61 step 2: accounting sync's records, settings and mapping, and `accounting:manage`.
// The books are an org connection of a gatekeeper the catalogue marks `implements: "accounting"`
// (the fake books here); nothing is sent in this step, so the tests read the settings, the mapping,
// who may change them, and the outbox's own guards in the database.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type Actor,
  type InvocationContext,
  invoke,
  PERMISSIONS,
  ROLE_PERMISSIONS,
} from "../src/index.ts";
import { context, createUser, unique } from "./helpers.ts";

const NOW = "2026-11-24T00:00:00.000Z";
const BOOKS = "books";

let admin: ActingUser;
let member: ActingUser;
let viewer: ActingUser;

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a refusal");
}

const AI_ACTORS: { actor: Actor; origin: InvocationContext["origin"] }[] = [
  { actor: "assistant", origin: { surface: "assistant", sessionId: "ath_accounting" } },
  {
    actor: "mcp",
    origin: { surface: "mcp", clientId: "c", clientName: "T", sessionId: "cap_accounting" },
  },
  { actor: "automation", origin: { surface: "automation", automationId: "x.y" } },
  { actor: "extension", origin: { surface: "extension", extensionId: "bookings" } },
];

const aiContext = (extra: (typeof AI_ACTORS)[number]) =>
  context(admin, {
    ...extra,
    ...(extra.actor === "mcp" ? { grantedPermissions: [...PERMISSIONS] } : {}),
  });

/** An org connection of `vendor` with the fake books bound as `books`. */
async function connection(vendor = "accounting-fake", status = "active") {
  const id = unique("con");
  await env.DB.prepare(
    "INSERT INTO core_integration_connection (id, vendor, scope, owner_user_id, title, status, resources, created_at, updated_at) VALUES (?, ?, 'org', ?, 'Books', ?, ?, ?, ?)",
  )
    .bind(
      id,
      vendor,
      admin.id,
      status,
      JSON.stringify([
        {
          key: BOOKS,
          url: "accounting-fake://books/demo",
          pattern: "accounting-fake://books/:name",
        },
      ]),
      NOW,
      NOW,
    )
    .run();
  return id;
}

const update = (input: Record<string, unknown>, user = admin) =>
  invoke("accounting.settings.update", input as never, context(user));
const get = (user = admin) => invoke("accounting.settings.get", {}, context(user));
const setMap = (input: Record<string, unknown>, user = admin) =>
  invoke("accounting.map.set", input as never, context(user));

async function resetSettings() {
  await env.DB.prepare("DELETE FROM core_accounting_settings").run();
  await env.DB.prepare("DELETE FROM core_accounting_post WHERE state != 'sent'").run();
}

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  viewer = await createUser("viewer");
});

describe("accounting:manage", () => {
  it("is an admin's by default, grantable one by one, and refused to members, viewers and pack roles", async () => {
    expect(ROLE_PERMISSIONS.admin).toContain("accounting:manage");
    expect(ROLE_PERMISSIONS.member).not.toContain("accounting:manage");
    await get(admin);
    for (const user of [member, viewer]) {
      expect(await refusal(get(user))).toMatchObject({
        code: "forbidden",
        details: { permission: "accounting:manage" },
      });
    }
    const grantable = await invoke("user.grantablePermissions", {}, context(admin));
    expect(
      (grantable as { items: { permission: string; forFixedRole: boolean }[] }).items.find(
        (i) => i.permission === "accounting:manage",
      ),
    ).toMatchObject({ forFixedRole: false });
    const granted = await createUser("member");
    await invoke(
      "user.setPermissions",
      { id: granted.id, permissions: ["accounting:manage"] },
      context(admin),
    );
    await get(granted);
    // A grant does not make the settings a member's: those stay a human admin's.
    expect(await refusal(update({ settleDays: 3 }, granted))).toMatchObject({
      code: "forbidden",
      details: { permission: "settings:manage" },
    });
    // Never to a pack role.
    const coach = await createUser("viewer");
    await env.DB.prepare("UPDATE core_user SET pack_role = 'bookings.coach' WHERE id = ?")
      .bind(coach.id)
      .run();
    expect(
      await refusal(
        invoke(
          "user.setPermissions",
          { id: coach.id, permissions: ["accounting:manage"] },
          context(admin),
        ),
      ),
    ).toMatchObject({ code: "invalid_input" });
    expect((await refusal(get(coach))).code).toBe("forbidden");
  });

  it("refuses every write to an AI, an MCP client, an automation and an extension", async () => {
    await resetSettings();
    const con = await connection();
    await update({ books: { connectionId: con, resource: BOOKS } });
    for (const extra of AI_ACTORS) {
      for (const [op, input] of [
        ["accounting.settings.update", { settleDays: 3 }],
        ["accounting.map.set", { kind: "fees", booksRef: "acc_fees", booksName: "Fees" }],
        ["accounting.map.clear", { kind: "fees" }],
      ] as const) {
        const refused = await refusal(invoke(op, input as never, aiContext(extra)));
        expect(refused.code, `${extra.actor} ${op}`).toBe("forbidden");
      }
    }
    const rows = await env.DB.prepare("SELECT * FROM core_accounting_map WHERE connection_id = ?")
      .bind(con)
      .all();
    expect(rows.results).toEqual([]);
    // Reading is open to an assistant acting for someone who holds it.
    await invoke("accounting.settings.get", {}, aiContext(AI_ACTORS[0] as never));
  });
});

describe("settings", () => {
  it("starts off, with fourteen approved days and a two-day settle delay", async () => {
    await resetSettings();
    expect(await get()).toMatchObject({
      books: null,
      startDate: null,
      enabled: false,
      approval: { approvedDays: 0, approveUntil: 14, automatic: false },
      settleDays: 2,
      mapping: [],
    });
  });

  it("takes only an accounting connection, with those books bound on it", async () => {
    await resetSettings();
    const mail = await connection("email-send");
    expect(await refusal(update({ books: { connectionId: mail, resource: BOOKS } }))).toMatchObject(
      { code: "invalid_input", details: { rule: "accounting_not_books" } },
    );
    const con = await connection();
    expect(
      await refusal(update({ books: { connectionId: con, resource: "other" } })),
    ).toMatchObject({ details: { rule: "accounting_not_books" } });
    const done = await update({ books: { connectionId: con, resource: BOOKS } });
    expect(done.books).toMatchObject({ connectionId: con, resource: BOOKS, status: "active" });
    const read = await get();
    expect(read.books).toMatchObject({ connectionId: con, title: "Books" });
    expect(read.choices.map((c) => c.connectionId)).toContain(con);
    expect(read.choices.map((c) => c.connectionId)).not.toContain(mail);
  });

  it("turns on only with the books, an active connection and a start date; the books change only while off", async () => {
    await resetSettings();
    expect(await refusal(update({ enabled: true }))).toMatchObject({
      details: { rule: "accounting_no_books" },
    });
    const expired = await connection("accounting-fake", "expired");
    await update({ books: { connectionId: expired, resource: BOOKS } });
    expect(await refusal(update({ enabled: true }))).toMatchObject({
      details: { rule: "accounting_no_start" },
    });
    expect(await refusal(update({ enabled: true, startDate: "2026-12-01" }))).toMatchObject({
      details: { rule: "accounting_connection_inactive" },
    });
    const con = await connection();
    const on = await update({
      books: { connectionId: con, resource: BOOKS },
      startDate: "2026-12-01",
      enabled: true,
    });
    expect(on).toMatchObject({ enabled: true, startDate: "2026-12-01" });
    const other = await connection();
    expect(
      await refusal(update({ books: { connectionId: other, resource: BOOKS } })),
    ).toMatchObject({ code: "conflict", details: { rule: "accounting_books_while_on" } });
    expect(await refusal(update({ books: null }))).toMatchObject({
      details: { rule: "accounting_books_while_on" },
    });
    // Off and the books changed in one call.
    expect(
      await update({ enabled: false, books: { connectionId: other, resource: BOOKS } }),
    ).toMatchObject({ enabled: false, books: { connectionId: other } });
    // A date that is not one is refused.
    expect((await refusal(update({ startDate: "2026-02-30" }))).code).toBe("invalid_input");
  });

  it("keeps approval at fourteen days or more, and puts it back on", async () => {
    await resetSettings();
    expect((await refusal(update({ approveUntil: 7 }))).code).toBe("invalid_input");
    expect((await refusal(update({ settleDays: 0 }))).code).toBe("invalid_input");
    await update({ approveUntil: 30, settleDays: 3 });
    await env.DB.prepare(
      "UPDATE core_accounting_settings SET approved_days = 30, automatic_told_at = ?",
    )
      .bind(NOW)
      .run();
    expect((await get()).approval).toEqual({
      approvedDays: 30,
      approveUntil: 30,
      automatic: true,
    });
    const again = await update({ restartApproval: true });
    expect(again.approval).toEqual({ approvedDays: 0, approveUntil: 30, automatic: false });
    const row = await env.DB.prepare("SELECT * FROM core_accounting_settings").first();
    expect(row).toMatchObject({ approved_days: 0, automatic_told_at: null, updated_by: admin.id });
  });

  it("fixes the start date once an entry was sent", async () => {
    await resetSettings();
    const con = await connection();
    await update({ books: { connectionId: con, resource: BOOKS }, startDate: "2026-12-01" });
    await update({ startDate: "2026-12-02" });
    const id = unique("acp");
    await env.DB.prepare(
      `INSERT INTO core_accounting_post (id, connection_id, kind, source_kind, source_id, reference,
         carries_date, belongs_date, state, books_ref, sent_at, created_at, updated_at)
       VALUES (?, ?, 'summary', 'day', ?, ?, '2026-12-02', '2026-12-02', 'sent', 'jnl_1', ?, ?, ?)`,
    )
      .bind(id, con, id, `cos:summary:${id}:1`, NOW, NOW, NOW)
      .run();
    expect(await refusal(update({ startDate: "2026-11-01" }))).toMatchObject({
      details: { rule: "accounting_start_fixed" },
    });
    // The same date again is not a change.
    await update({ startDate: "2026-12-02", settleDays: 2 });
  });

  it("audits every change, and holds no token or secret", async () => {
    await resetSettings();
    const con = await connection();
    await update({ books: { connectionId: con, resource: BOOKS }, settleDays: 4 });
    const audit = await env.DB.prepare(
      `SELECT c.diff FROM core_audit_changes c JOIN core_audit a ON a.id = c.audit_id
       WHERE a.operation = 'accounting.settings.update' AND a.user_id = ? ORDER BY c.id DESC`,
    )
      .bind(admin.id)
      .first<{ diff: string }>();
    expect(audit?.diff).toContain(con);
    expect(audit?.diff).toContain("settleDays");
    const row = await env.DB.prepare("SELECT * FROM core_accounting_settings").first();
    expect(Object.keys(row ?? {}).join(",")).not.toMatch(/token|secret|key/i);
  });
});

describe("mapping", () => {
  it("needs the books, takes a key only where its kind has one, and is per connection", async () => {
    await resetSettings();
    expect(
      await refusal(setMap({ kind: "fees", booksRef: "acc_fees", booksName: "Fees" })),
    ).toMatchObject({ details: { rule: "accounting_no_books" } });
    const con = await connection();
    await update({ books: { connectionId: con, resource: BOOKS } });
    expect(
      await refusal(setMap({ kind: "category", booksRef: "acc_1", booksName: "Sales" })),
    ).toMatchObject({ details: { rule: "accounting_map_key" } });
    expect(
      await refusal(
        setMap({ kind: "fees", hostKey: "passes", booksRef: "acc_1", booksName: "Fees" }),
      ),
    ).toMatchObject({ details: { rule: "accounting_map_key" } });

    const passes = await setMap({
      kind: "category",
      hostKey: "passes",
      booksRef: "acc_passes",
      booksName: "Pass sales",
    });
    expect(passes).toMatchObject({
      changed: true,
      row: { kind: "category", hostKey: "passes", target: "account", booksRef: "acc_passes" },
    });
    await setMap({ kind: "tax", hostKey: "gst", booksRef: "tax_10", booksName: "GST 10%" });
    await setMap({ kind: "clearing", booksRef: "acc_clearing", booksName: "Card clearing" });
    expect(
      await setMap({ kind: "clearing", booksRef: "acc_clearing", booksName: "Card clearing" }),
    ).toMatchObject({ changed: false });
    await setMap({ kind: "clearing", hostKey: null, booksRef: "acc_clear2", booksName: "Stripe" });

    const read = await get();
    expect(read.mapping.map((m) => [m.kind, m.hostKey, m.target, m.booksRef])).toEqual([
      ["category", "passes", "account", "acc_passes"],
      ["clearing", null, "account", "acc_clear2"],
      ["tax", "gst", "tax_rate", "tax_10"],
    ]);

    // Cleared, it is gone; clearing it again finds nothing.
    expect(
      await invoke("accounting.map.clear", { kind: "tax", hostKey: "gst" }, context(admin)),
    ).toEqual({ cleared: true });
    expect(
      (
        await refusal(
          invoke("accounting.map.clear", { kind: "tax", hostKey: "gst" }, context(admin)),
        )
      ).code,
    ).toBe("not_found");

    // Other books: the mapping is theirs, and starts empty.
    const other = await connection();
    await update({ books: { connectionId: other, resource: BOOKS } });
    expect((await get()).mapping).toEqual([]);
    await update({ books: { connectionId: con, resource: BOOKS } });
    expect((await get()).mapping).toHaveLength(2);

    // Every change is audited with what it was and what it became.
    const changes = await env.DB.prepare(
      `SELECT c.action, c.record_id, c.diff FROM core_audit_changes c
       JOIN core_audit a ON a.id = c.audit_id
       WHERE a.operation IN ('accounting.map.set', 'accounting.map.clear') AND c.object_type = 'accounting_map'
         AND c.record_id = 'clearing:' ORDER BY c.id`,
    ).all<{ action: string; diff: string }>();
    expect(changes.results.map((c) => c.action)).toEqual(["create", "update"]);
    expect(changes.results[1]?.diff).toContain("acc_clear2");
  });

  it("is a person's with accounting:manage, granted or an admin's", async () => {
    await resetSettings();
    const con = await connection();
    await update({ books: { connectionId: con, resource: BOOKS } });
    const input = { kind: "fees", booksRef: "acc_fees", booksName: "Fees" };
    expect(await refusal(setMap(input, member))).toMatchObject({
      details: { permission: "accounting:manage" },
    });
    const bookkeeper = await createUser("member");
    await invoke(
      "user.setPermissions",
      { id: bookkeeper.id, permissions: ["accounting:manage"] },
      context(admin),
    );
    expect(await setMap(input, bookkeeper)).toMatchObject({ changed: true });
  });
});

describe("the outbox's own guards", () => {
  const post = async (state: string, extra: Record<string, unknown> = {}) => {
    const id = unique("acp");
    const row = {
      id,
      connection_id: "con_guard",
      kind: "summary",
      source_kind: "day",
      source_id: id,
      reference: `cos:summary:${id}:1`,
      carries_date: "2026-12-03",
      belongs_date: "2026-12-03",
      state,
      created_at: NOW,
      updated_at: NOW,
      ...extra,
    };
    const keys = Object.keys(row);
    await env.DB.prepare(
      `INSERT INTO core_accounting_post (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    )
      .bind(...Object.values(row))
      .run();
    return row;
  };

  it("never changes or deletes a sent entry, and never queues a reference twice", async () => {
    const sent = await post("sent", { books_ref: "jnl_9", sent_at: NOW, amount: 1200 });
    for (const change of [
      "amount = 1300",
      "lines = '[{\"a\":1}]'",
      "books_ref = 'jnl_10'",
      "state = 'queued', books_ref = NULL, sent_at = NULL",
      "carries_date = '2026-12-04'",
    ]) {
      await expect(
        env.DB.prepare(`UPDATE core_accounting_post SET ${change} WHERE id = ?`)
          .bind(sent.id)
          .run(),
        change,
      ).rejects.toThrow(/core_accounting_post_fixed/);
    }
    await expect(
      env.DB.prepare("DELETE FROM core_accounting_post WHERE id = ?").bind(sent.id).run(),
    ).rejects.toThrow(/core_accounting_post_fixed/);
    await expect(
      env.DB.prepare(
        `INSERT OR REPLACE INTO core_accounting_post (id, connection_id, kind, source_kind, source_id,
           reference, carries_date, belongs_date, state, created_at, updated_at)
         VALUES (?, 'con_guard', 'summary', 'day', ?, ?, '2026-12-03', '2026-12-03', 'queued', ?, ?)`,
      )
        .bind(unique("acp"), sent.source_id, sent.reference, NOW, NOW)
        .run(),
    ).rejects.toThrow(/core_accounting_post_fixed/);
    // What an erase may clear stays clearable.
    await env.DB.prepare("UPDATE core_accounting_post SET detail = NULL WHERE id = ?")
      .bind(sent.id)
      .run();
    // Sent needs the books' ref; skipped needs who and why.
    await expect(post("sent")).rejects.toThrow(/CHECK constraint failed/);
    await expect(post("skipped")).rejects.toThrow(/CHECK constraint failed/);
    await expect(post("queued", { reference: "jnl:not-ours" })).rejects.toThrow(
      /CHECK constraint failed/,
    );
    // An entry not yet sent may move on, or be dropped.
    const queued = await post("queued");
    await env.DB.prepare(
      "UPDATE core_accounting_post SET state = 'held', error_code = 'unmapped' WHERE id = ?",
    )
      .bind(queued.id)
      .run();
    await env.DB.prepare("DELETE FROM core_accounting_post WHERE id = ?").bind(queued.id).run();
  });

  it("links one way and the other once, counts an event once, and asks one open question per bill-to", async () => {
    const link = (object: string, id: string, ref: string, kind = "contact") =>
      env.DB.prepare(
        "INSERT INTO core_accounting_link (connection_id, object, object_id, books_kind, books_ref, created_at) VALUES ('con_guard', ?, ?, ?, ?, ?)",
      )
        .bind(object, id, kind, ref, NOW)
        .run();
    await link("person", "per_1", "ct_1");
    await expect(link("person", "per_1", "ct_2")).rejects.toThrow(/UNIQUE/);
    await expect(link("organisation", "org_1", "ct_1")).rejects.toThrow(/UNIQUE/);
    await expect(link("invoice", "inv_1", "doc_1", "contact")).rejects.toThrow(/CHECK/);
    await link("invoice", "inv_1", "doc_1", "document");

    const item = (post: string) =>
      env.DB.prepare(
        "INSERT INTO core_accounting_item (source_kind, source_id, post_id, belongs_date, amount, created_at) VALUES ('payment', 'pay_1', ?, '2026-12-03', 500, ?)",
      )
        .bind(post, NOW)
        .run();
    await item("acp_a");
    await expect(item("acp_b")).rejects.toThrow(/UNIQUE/);

    const match = (state = "open") =>
      env.DB.prepare(
        "INSERT INTO core_accounting_match (id, connection_id, reason, object, object_id, state, decided_by, decided_at, created_at) VALUES (?, 'con_guard', 'unsure', 'organisation', 'org_9', ?, ?, ?, ?)",
      )
        .bind(
          unique("acm"),
          state,
          state === "open" ? null : admin.id,
          state === "open" ? null : NOW,
          NOW,
        )
        .run();
    await match();
    await expect(match()).rejects.toThrow(/UNIQUE/);
    await match("created");
  });
});

// Review of PR #361: the guards hold for every form of write, not only the plain ones.
describe("the outbox's guards against every form of write", () => {
  const post = async (state: string, extra: Record<string, unknown> = {}) => {
    const id = unique("acp");
    const row = {
      id,
      connection_id: "con_review",
      kind: "summary",
      source_kind: "day",
      source_id: id,
      reference: `cos:summary:${id}:1`,
      carries_date: "2026-12-03",
      belongs_date: "2026-12-03",
      state,
      created_at: NOW,
      updated_at: NOW,
      ...(state === "sent" ? { books_ref: `jnl_${id}`, sent_at: NOW } : {}),
      ...extra,
    };
    const keys = Object.keys(row);
    await env.DB.prepare(
      `INSERT INTO core_accounting_post (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    )
      .bind(...Object.values(row))
      .run();
    return row;
  };
  const rowOf = (id: string) =>
    env.DB.prepare("SELECT * FROM core_accounting_post WHERE id = ?")
      .bind(id)
      .first<Record<string, unknown>>();

  it("an UPDATE OR REPLACE of another entry never takes a sent one's reference or id", async () => {
    const sent = await post("sent");
    const queued = await post("queued");
    await expect(
      env.DB.prepare("UPDATE OR REPLACE core_accounting_post SET reference = ? WHERE id = ?")
        .bind(sent.reference, queued.id)
        .run(),
    ).rejects.toThrow(/core_accounting_post_fixed/);
    await expect(
      env.DB.prepare("UPDATE OR REPLACE core_accounting_post SET id = ? WHERE id = ?")
        .bind(sent.id, queued.id)
        .run(),
    ).rejects.toThrow(/core_accounting_post_fixed/);
    expect(await rowOf(sent.id)).toMatchObject({ state: "sent", reference: sent.reference });
    // A queued entry's reference and id never change either: an entry is its reference.
    await expect(
      env.DB.prepare("UPDATE core_accounting_post SET reference = 'cos:other:1' WHERE id = ?")
        .bind(queued.id)
        .run(),
    ).rejects.toThrow(/core_accounting_post_fixed/);
  });

  it("an entry that may be in the books leaves its state only for what its outcome allows", async () => {
    const unknown = await post("unknown");
    for (const state of ["held", "skipped", "awaiting_approval", "retrying"]) {
      await expect(
        env.DB.prepare("UPDATE core_accounting_post SET state = ? WHERE id = ?")
          .bind(state, unknown.id)
          .run(),
        state,
      ).rejects.toThrow(/core_accounting_post_fixed/);
    }
    const sending = await post("sending");
    for (const state of ["queued", "awaiting_approval", "skipped"]) {
      await expect(
        env.DB.prepare("UPDATE core_accounting_post SET state = ? WHERE id = ?")
          .bind(state, sending.id)
          .run(),
        state,
      ).rejects.toThrow(/core_accounting_post_fixed/);
    }
    await env.DB.prepare("UPDATE core_accounting_post SET state = 'unknown' WHERE id = ?")
      .bind(sending.id)
      .run();
    // Found by its reference: sent. Not found: queued again (the runner looks it up first).
    await env.DB.prepare(
      "UPDATE core_accounting_post SET state = 'sent', books_ref = 'jnl_found', sent_at = ? WHERE id = ?",
    )
      .bind(NOW, sending.id)
      .run();
    await env.DB.prepare("UPDATE core_accounting_post SET state = 'queued' WHERE id = ?")
      .bind(unknown.id)
      .run();
  });

  it("keeps who approved a sent entry, what it waited on and what it carried", async () => {
    const sent = await post("sent", {
      approved_by: "usr_approver",
      approved_at: NOW,
      detail: '{"name":"A"}',
    });
    for (const change of [
      "approved_by = 'usr_other'",
      "approved_at = '2027-01-01T00:00:00.000Z'",
      "depends_on = 'acp_other'",
      "created_at = '2027-01-01T00:00:00.000Z'",
      "attempts = 9",
      "error_code = 'invalid'",
      'detail = \'{"name":"B"}\'',
    ]) {
      await expect(
        env.DB.prepare(`UPDATE core_accounting_post SET ${change} WHERE id = ?`)
          .bind(sent.id)
          .run(),
        change,
      ).rejects.toThrow(/core_accounting_post_fixed/);
    }
    // Only an erase's clearing of what it carried is allowed.
    await env.DB.prepare(
      "UPDATE core_accounting_post SET detail = NULL, updated_at = ? WHERE id = ?",
    )
      .bind(NOW, sent.id)
      .run();
    expect(await rowOf(sent.id)).toMatchObject({ detail: null, approved_by: "usr_approver" });
  });
});

// Review of PR #361: the start date is fixed once an entry may be in the books, by the database.
describe("the start date once an entry may be in the books", () => {
  it("does not move while an entry to these books is being sent or its outcome is not known", async () => {
    await resetSettings();
    const con = await connection();
    await update({ books: { connectionId: con, resource: BOOKS }, startDate: "2026-12-01" });
    await update({ startDate: "2026-12-02" });
    for (const state of ["unknown", "sending", "sent"]) {
      const id = unique("acp");
      await env.DB.prepare(
        `INSERT INTO core_accounting_post (id, connection_id, kind, source_kind, source_id, reference,
           carries_date, belongs_date, state, books_ref, sent_at, created_at, updated_at)
         VALUES (?, ?, 'summary', 'day', ?, ?, '2026-12-02', '2026-12-02', ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          con,
          id,
          `cos:summary:${id}:1`,
          state,
          state === "sent" ? "jnl_s" : null,
          state === "sent" ? NOW : null,
          NOW,
          NOW,
        )
        .run();
      expect(await refusal(update({ startDate: "2026-06-01" })), state).toMatchObject({
        details: { rule: "accounting_start_fixed" },
      });
      // The database refuses it too, so a write planned before the entry was claimed fails.
      await expect(
        env.DB.prepare("UPDATE core_accounting_settings SET start_date = '2026-06-01'").run(),
        state,
      ).rejects.toThrow(/core_accounting_start_fixed/);
      await expect(
        env.DB.prepare(
          "INSERT OR REPLACE INTO core_accounting_settings (id, connection_id, resource, start_date, updated_by, updated_at) VALUES (1, ?, ?, '2026-06-01', 'x', 'y')",
        )
          .bind(con, BOOKS)
          .run(),
        state,
      ).rejects.toThrow(/core_accounting_start_fixed/);
      if (state !== "sent") {
        // Resolved as not in the books, it is queued again and dropped: the date moves again.
        await env.DB.prepare("UPDATE core_accounting_post SET state = 'unknown' WHERE id = ?")
          .bind(id)
          .run();
        await env.DB.prepare("UPDATE core_accounting_post SET state = 'queued' WHERE id = ?")
          .bind(id)
          .run();
        await env.DB.prepare("DELETE FROM core_accounting_post WHERE id = ?").bind(id).run();
        await update({ startDate: "2026-12-02" });
      }
    }
    expect((await get()).startDate).toBe("2026-12-02");
    // Other books have their own start: nothing is in them yet.
    const other = await connection();
    await update({ books: { connectionId: other, resource: BOOKS } });
    await update({ startDate: "2026-06-01" });
  });
});

// Review of PR #361: a settings change writes only what it changes.
describe("a settings change made while the runner counts a day", () => {
  it("keeps the count the runner made between the read and the write", async () => {
    await resetSettings();
    await update({ approveUntil: 20 });
    // The database as the operation sees it: just before its writes commit, the runner (step 4)
    // counts an approved day.
    let counted = false;
    const racing = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!counted) {
              counted = true;
              await target
                .prepare("UPDATE core_accounting_settings SET approved_days = approved_days + 1")
                .run();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await invoke(
      "accounting.settings.update",
      { settleDays: 5 },
      context(admin, { db: createCrmDb(racing) }),
    );
    expect(counted).toBe(true);
    const row = await env.DB.prepare("SELECT * FROM core_accounting_settings").first();
    expect(row).toMatchObject({ settle_days: 5, approved_days: 1, approve_until: 20 });
  });
});
