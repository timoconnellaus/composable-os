// Personal links (stage 29 step 5, ADR 0723), at the database: migration 1010's triggers keep a
// link used once (two batches racing for it: exactly one commits), before it expires, naming what
// it was made for for good, its expiry only sooner and its Person only the one it was merged into;
// a token is the SHA-256 of 32 random bytes; a token's lookup answers null for anything wrong;
// erase deletes links and tokens with their Person.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  ensureLink,
  invokeByName,
  LINK_TOKEN,
  linkedSince,
  linkToken,
  liveLinkById,
  liveLinkByToken,
  personalLinkUrl,
  useLinkStatement,
} from "../src/index.ts";
import { context, createUser, db, unique } from "./helpers.ts";

let admin: ActingUser;
const DAY = 86_400_000;

beforeAll(async () => {
  admin = await createUser("admin");
});

async function person(): Promise<string> {
  const made = (await invokeByName(
    "person.create",
    { givenName: unique("Linked") },
    context(admin),
  )) as { id: string };
  return made.id;
}

async function link(personId: string, now = new Date().toISOString()) {
  const made = await ensureLink(db.query, {
    personId,
    formObject: "forms.form",
    formId: unique("rec_form"),
    recordObject: "bookings.booking",
    recordId: unique("rec_booking"),
    madeFor: unique("bookings.feedback:run"),
    days: 7,
    now,
  });
  expect(made?.live).toBe(true);
  return made as { id: string; expiresAt: string };
}

/** Runs `statement` in a batch of its own, as an answer's batch is. */
function batch(...sql: { sql: string; parameters: readonly unknown[] }[]) {
  return env.DB.batch(sql.map((s) => env.DB.prepare(s.sql).bind(...s.parameters)));
}
const use = (id: string, submission: string, now = new Date().toISOString()) =>
  useLinkStatement(db.query, id, submission, now).compile();

describe("used once, by the database (proof a)", () => {
  it("of two batches racing to use one link, exactly one commits", async () => {
    const { id } = await link(await person());
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        batch(use(id, `rec_sub${i}`), {
          sql: "SELECT 1",
          parameters: [],
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") expect(String(r.reason)).toMatch(/core_intake_link_used/);
    }
    const row = await env.DB.prepare("SELECT used_at, submission_id FROM core_intake_link WHERE id = ?")
      .bind(id)
      .first<{ used_at: string; submission_id: string }>();
    expect(row?.used_at).toBeTruthy();
  });

  it("a use after the link expired fails the batch", async () => {
    const madeAt = new Date(Date.now() - 8 * DAY).toISOString();
    const { id } = await link(await person(), madeAt);
    await expect(batch(use(id, "rec_late"))).rejects.toThrow(/core_intake_link_used/);
    expect(await liveLinkById(db.query, id, new Date().toISOString())).toBeNull();
  });
});

describe("what a link names never changes", () => {
  it("refuses a change of form, record or maker, a later expiry, and a Person not merged into", async () => {
    const { id } = await link(await person());
    const other = await person();
    for (const set of [
      "form_id = 'rec_other'",
      "record_id = 'rec_other'",
      "made_for = 'someone else'",
      "expires_at = '2999-01-01T00:00:00.000Z'",
      `person_id = '${other}'`,
    ]) {
      await expect(
        env.DB.prepare(`UPDATE core_intake_link SET ${set} WHERE id = ?`).bind(id).run(),
        set,
      ).rejects.toThrow(/core_intake_link_fixed/);
    }
    // Its expiry may come sooner: a revoke.
    await env.DB.prepare("UPDATE core_intake_link SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() + 1000).toISOString(), id)
      .run();
    // A link is never made used, nor replaced.
    await expect(
      env.DB.prepare(
        "INSERT INTO core_intake_link (id, person_id, form_object, form_id, made_for, expires_at, used_at, submission_id, created_at) VALUES (?, ?, 'forms.form', 'rec_f', 'x', '2999-01-01', '2026-01-01', 'rec_s', '2026-01-01')",
      )
        .bind(unique("ilk_"), other)
        .run(),
    ).rejects.toThrow(/core_intake_link_fixed/);
  });
});

describe("tokens", () => {
  it("are 32 random bytes, kept only as their hash, read back as the link; anything else is null", async () => {
    const who = await person();
    const { id } = await link(who);
    const now = new Date().toISOString();
    const token = await linkToken(db.query, id, now);
    expect(token).toMatch(LINK_TOKEN);
    const stored = await env.DB.prepare(
      "SELECT token_hash FROM core_intake_link_token WHERE link_id = ?",
    )
      .bind(id)
      .first<{ token_hash: string }>();
    expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.token_hash).not.toContain(token);
    expect((await liveLinkByToken(db.query, token, now))?.personId).toBe(who);
    for (const wrong of ["", "x", "A".repeat(43), `${token}x`, token.slice(1)]) {
      expect(await liveLinkByToken(db.query, wrong, now), wrong).toBeNull();
    }
    expect(personalLinkUrl("https://gym.example", token)).toBe(
      `https://gym.example/form?t=${token}`,
    );
    // Used: the token answers null, as an unknown one does.
    await batch(use(id, "rec_done"));
    expect(await liveLinkByToken(db.query, token, now)).toBeNull();
  });

  it("a second send about the same record makes no link; a retried step finds its own", async () => {
    const who = await person();
    const want = {
      personId: who,
      formObject: "forms.form",
      formId: "rec_f1",
      recordObject: "bookings.booking",
      recordId: unique("rec_b"),
      madeFor: "bookings.feedback:run1",
      days: 7,
      now: new Date().toISOString(),
    };
    const first = await ensureLink(db.query, want);
    expect(await ensureLink(db.query, want)).toEqual(first);
    expect(await ensureLink(db.query, { ...want, madeFor: "bookings.feedback:run2" })).toBeNull();
    // The cool-down sees it for any other record, not for this one.
    const since = new Date(Date.now() - DAY).toISOString();
    expect(await linkedSince(db.query, { ...want, recordId: "rec_other" }, since)).toBe(true);
    expect(await linkedSince(db.query, want, since)).toBe(false);
  });
});

describe("erase", () => {
  it("deletes a Person's links and their tokens", async () => {
    const who = await person();
    const { id } = await link(who);
    await linkToken(db.query, id, new Date().toISOString());
    await invokeByName("person.erase", { id: who }, context(admin));
    const left = await env.DB.prepare(
      "SELECT (SELECT count(*) FROM core_intake_link WHERE id = ?1) + (SELECT count(*) FROM core_intake_link_token WHERE link_id = ?1) AS n",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(Number(left?.n)).toBe(0);
  });
});
