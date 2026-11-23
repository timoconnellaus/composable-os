// Routine mail after the review of PR #267 (ADR 0590): what a person's approval is (never the
// adjudicator's, F1), who an order's email may go to (D2), the daily caps counted where a row is
// claimed so concurrent runs cannot race past them, per mailbox with plus-tags folded and for the
// organisation (D4), the log's retention and a Person's erase (D5).
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  aiWritten,
  claimRoutineMail,
  invokeByName,
  newId,
  purgeRoutineMail,
  routineOrderRecipient,
} from "../src/index.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";

let admin: ActingUser;
const EXT = `rmx${Date.now().toString(36)}`;
const CONNECTION = "con_ROUTINEREVIEW";

beforeAll(async () => {
  admin = await createUser("admin");
  await setPreset("balanced");
  const now = new Date().toISOString();
  // A shipped extension declaring one kind, its routine email turned on.
  const manifest = {
    id: EXT,
    label: "Mailer",
    routineMail: {
      note: {
        label: "Notes",
        description: "A note.",
        about: "visit",
        slots: {},
        messages: { note: { subject: "Note", text: "A note." } },
      },
    },
  };
  await env.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, role, kind) VALUES (?, 'Mailer', ?, 0, ?, ?, 'member', 'extension')",
  )
    .bind(`extension:${EXT}`, `${EXT}@extensions.crm.invalid`, now, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at)
     VALUES (?, 'shipped', 'active', '1.0.0', 'c1', ?, ?, ?, ?)`,
  )
    .bind(EXT, JSON.stringify(manifest), `extension:${EXT}`, now, now)
    .run();
  await invokeByName(
    "routineMail.settings.update",
    { packs: { [EXT]: true }, orgDailyCap: 2_000 },
    context(admin),
  );
});

/** A routine row ready to claim, for `recipient`. */
async function ready(recipient: string, key: string, extra: { claimed?: string } = {}) {
  const id = newId("routineMail");
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO core_routine_mail (id, kind, message, extension_id, record_object, record_id,
       recipient, recipient_key, recipient_rule, automation_id, run_id, trigger_type,
       idempotency_key, routine, status, connection_id, subject, body, claimed_at, created_at, updated_at)
     VALUES (?, ?, 'note', ?, ?, 'rec_1', ?, ?, 'person', ?, 'arn_1', 'record', ?, 1, ?, ?, 'Note',
       'A note.', ?, ?, ?)`,
  )
    .bind(
      id,
      `${EXT}.note`,
      EXT,
      `${EXT}.visit`,
      recipient,
      key,
      `${EXT}.a`,
      `${id}:${unique("k")}`,
      extra.claimed ? "sent" : "ready",
      CONNECTION,
      extra.claimed ?? null,
      now,
      now,
    )
    .run();
  return id;
}

const routineOf = async (id: string) =>
  (await env.DB.prepare("SELECT routine, held_reason FROM core_routine_mail WHERE id = ?")
    .bind(id)
    .first<{ routine: number; held_reason: string | null }>()) as {
    routine: number;
    held_reason: string | null;
  };

describe("the daily caps, counted when a row is claimed (D4)", () => {
  it("concurrent claims for one mailbox, plus-tags and case folded, cannot race past 20", async () => {
    const key = `${unique("ann")}@members.test`.toLowerCase();
    const now = new Date().toISOString();
    for (let i = 0; i < 19; i++) {
      await ready(key.replace("@", `+t${i}@`).toUpperCase(), key, { claimed: now });
    }
    const racing = [await ready(key, key), await ready(key, key), await ready(key, key)];
    await Promise.all(racing.map((id) => claimRoutineMail(db.query, id, CONNECTION)));
    const after = await Promise.all(racing.map(routineOf));
    expect(after.filter((r) => r.routine === 1)).toHaveLength(1);
    expect(after.filter((r) => r.routine === 0).map((r) => r.held_reason)).toEqual([
      expect.stringMatching(/has had 20 routine emails today/),
      expect.stringMatching(/has had 20 routine emails today/),
    ]);
  });

  it("over the organisation's daily limit, the rest are held and the admins told once", async () => {
    await invokeByName("routineMail.settings.update", { orgDailyCap: 1 }, context(admin));
    try {
      const first = await ready(`${unique("a")}@x.test`, unique("ka"));
      const second = await ready(`${unique("b")}@x.test`, unique("kb"));
      await claimRoutineMail(db.query, first, CONNECTION);
      await claimRoutineMail(db.query, second, CONNECTION);
      expect((await routineOf(second)).held_reason).toMatch(/the organisation has sent/);
      const told = await env.DB.prepare(
        "SELECT count(*) AS n FROM core_notifications WHERE dedupe_key LIKE 'routine-mail.org-cap:%'",
      ).first<{ n: number }>();
      expect(told?.n).toBeGreaterThan(0);
    } finally {
      await invokeByName("routineMail.settings.update", { orgDailyCap: 2_000 }, context(admin));
    }
  });

  it("a kind turned off after the row was prepared: the claim settles it off (F2)", async () => {
    const id = await ready(`${unique("c")}@x.test`, unique("kc"));
    await invokeByName(
      "routineMail.settings.update",
      { kinds: { [`${EXT}.note`]: false } },
      context(admin),
    );
    try {
      expect(await claimRoutineMail(db.query, id, CONNECTION)).toBe("off");
      const row = await env.DB.prepare("SELECT status, body FROM core_routine_mail WHERE id = ?")
        .bind(id)
        .first();
      expect(row).toEqual({ status: "off", body: null });
    } finally {
      await invokeByName(
        "routineMail.settings.update",
        { kinds: { [`${EXT}.note`]: true } },
        context(admin),
      );
    }
  });
});

describe("an order's address (D2)", () => {
  it("a paid order's own address; an unpaid one a visitor typed is held; a customer's free order goes to their verified address", async () => {
    expect(await routineOrderRecipient(db.query, { email: "paid@x.test", paid: 500 })).toEqual({
      address: "paid@x.test",
    });
    expect(
      await routineOrderRecipient(db.query, { email: "typed@x.test", paid: 0, placedAs: "public" }),
    ).toEqual({ address: "typed@x.test", held: expect.stringMatching(/nothing was paid/) });
    const person = await invokeByName(
      "person.create",
      { givenName: "Free", emails: [{ email: "free-typed@x.test" }] },
      context(admin),
    );
    const personId = (person as { id: string }).id;
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO core_customer (id, person_id, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    )
      .bind(`cus_${unique("f")}`, personId, "verified@x.test", now, now)
      .run();
    expect(
      await routineOrderRecipient(db.query, {
        email: "free-typed@x.test",
        paid: 0,
        placedAs: "customer",
        personId,
      }),
    ).toEqual({ address: "verified@x.test" });
  });
});

describe("a person's approval is a human's, never the adjudicator's (F1)", () => {
  it("an MCP change a person approved is cleared; the same approved by the adjudicator is not", async () => {
    const person = (await invokeByName(
      "person.create",
      { givenName: unique("Approved") },
      context(admin),
    )) as { id: string };
    const asked = await invokeByName(
      "person.delete",
      { id: person.id },
      context(admin, { actor: "mcp", origin: { surface: "mcp", sessionId: unique("cap") } }),
    ).catch((e: { details?: { actionId?: string } }) => e);
    const actionId = (asked as { details?: { actionId?: string } }).details?.actionId as string;
    expect(actionId).toBeTruthy();
    const approve = (confirm?: string) =>
      invokeByName(
        "approval.approve",
        { actionIds: [actionId], ...(confirm ? { confirm } : {}) },
        context(admin),
      );
    await approve().catch(async (error: { details?: { confirmLabel?: string } }) => {
      const label = error.details?.confirmLabel;
      if (!label) throw error;
      return approve(label);
    });
    expect(await aiWritten(db.query, "person", person.id, "all", null)).toEqual([]);
    await env.DB.prepare("UPDATE core_pending_action SET decided_by = 'adjudicator' WHERE id = ?")
      .bind(actionId)
      .run();
    expect(await aiWritten(db.query, "person", person.id, "all", null)).toEqual([
      expect.stringMatching(/was changed by an AI/),
    ]);
  });
});

describe("the log's retention (D5)", () => {
  it("rows older than the retention setting are deleted; newer ones stay", async () => {
    const old = await ready(`${unique("old")}@x.test`, unique("ko"));
    const fresh = await ready(`${unique("new")}@x.test`, unique("kn"));
    await env.DB.prepare(
      "UPDATE core_routine_mail SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    )
      .bind(old)
      .run();
    await purgeRoutineMail(db.query, new Date().toISOString());
    const left = await env.DB.prepare("SELECT id FROM core_routine_mail WHERE id IN (?, ?)")
      .bind(old, fresh)
      .all<{ id: string }>();
    expect(left.results.map((r) => r.id)).toEqual([fresh]);
  });

  it("a Person's erase deletes the rows about them, those sent to a guardian included", async () => {
    const child = (await invokeByName(
      "person.create",
      { givenName: unique("Child") },
      context(admin),
    )) as {
      id: string;
    };
    const id = await ready(`${unique("parent")}@x.test`, unique("kp"));
    await env.DB.prepare(
      "UPDATE core_routine_mail SET about_person_id = ?, recipient_rule = 'guardian' WHERE id = ?",
    )
      .bind(child.id, id)
      .run();
    await invokeByName("person.erase", { id: child.id }, context(admin));
    const row = await env.DB.prepare("SELECT id FROM core_routine_mail WHERE id = ?")
      .bind(id)
      .first();
    expect(row).toBeNull();
  });
});
