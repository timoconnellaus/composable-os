// Migration 1050 (stage 36, ADR 0740) rebuilds core_activity to add the type `chat` and the
// conversation link. Dropping the table would delete its links by cascade and could queue every
// stored body for deletion, so the rebuild keeps the links aside and fires no trigger. Its own
// file: it starts from an empty database and stops before 1050 to put activities in.
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { applyMigrations, migrationNumber } from "../src/index.ts";

const NOW = "2026-11-24T00:00:00.000Z";

it("keeps every activity, link and search row, and queues no body for deletion", async () => {
  const before = env.TEST_MIGRATIONS.filter((m) => (migrationNumber(m.name) ?? 0) < 1050);
  expect(env.TEST_MIGRATIONS.some((m) => migrationNumber(m.name) === 1050)).toBe(true);
  await applyMigrations(env.DB, before);

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO core_person (id, display_name, created_at, updated_at) VALUES ('per_a', 'Ada', ?, ?)",
    ).bind(NOW, NOW),
    env.DB.prepare(
      "INSERT INTO core_activity (id, type, subject, body, occurred_at, created_at, updated_at, external_key, body_ref, disclosure) VALUES ('act_mail', 'email', 'Renewal', 'Synced words', ?, ?, ?, 'email:<m1@example.com>', 'email-bodies/m1', 'full')",
    ).bind(NOW, NOW, NOW),
    env.DB.prepare(
      "INSERT INTO core_activity (id, type, body, occurred_at, created_at, updated_at, private_to) VALUES ('act_private', 'note', 'Private words', ?, ?, ?, 'usr_x')",
    ).bind(NOW, NOW, NOW),
    env.DB.prepare(
      "INSERT INTO core_activity_links (activity_id, object_type, record_id) VALUES ('act_mail', 'person', 'per_a'), ('act_private', 'person', 'per_a')",
    ),
  ]);

  await applyMigrations(env.DB, env.TEST_MIGRATIONS);

  const activities = await env.DB.prepare(
    "SELECT id, type, external_key, body_ref, private_to, conversation_id FROM core_activity ORDER BY id",
  ).all();
  expect(activities.results).toEqual([
    {
      id: "act_mail",
      type: "email",
      external_key: "email:<m1@example.com>",
      body_ref: "email-bodies/m1",
      private_to: null,
      conversation_id: null,
    },
    {
      id: "act_private",
      type: "note",
      external_key: null,
      body_ref: null,
      private_to: "usr_x",
      conversation_id: null,
    },
  ]);
  const links = await env.DB.prepare(
    "SELECT activity_id FROM core_activity_links ORDER BY activity_id",
  ).all();
  expect(links.results).toEqual([{ activity_id: "act_mail" }, { activity_id: "act_private" }]);
  expect(
    (await env.DB.prepare("SELECT count(*) AS n FROM core_blob_deletion").first<{ n: number }>())
      ?.n,
  ).toBe(0);
  const search = await env.DB.prepare(
    "SELECT d.record_id FROM core_search s JOIN core_search_docs d ON d.id = s.rowid WHERE core_search MATCH 'synced'",
  ).all();
  expect(search.results).toEqual([{ record_id: "act_mail" }]);
  // The views read the rebuilt table, and still leave a private activity out.
  expect((await env.DB.prepare("SELECT id FROM rec_activity").all()).results).toEqual([
    { id: "act_mail" },
  ]);
  expect((await env.DB.prepare("SELECT activity_id FROM rec_activity_link").all()).results).toEqual(
    [{ activity_id: "act_mail" }],
  );

  // A chat message in a conversation is accepted; a conversation's activities cascade from
  // their links as before, and deleting one queues its body.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO core_conversation (id, person_id, channel, opened_at, created_at, updated_at) VALUES ('cnv_1', 'per_a', 'chat', ?, ?, ?)",
    ).bind(NOW, NOW, NOW),
    env.DB.prepare(
      "INSERT INTO core_activity (id, type, body, occurred_at, created_at, updated_at, conversation_id) VALUES ('act_chat', 'chat', 'Hi', ?, ?, ?, 'cnv_1')",
    ).bind(NOW, NOW, NOW),
  ]);
  await env.DB.prepare("DELETE FROM core_activity WHERE id = 'act_mail'").run();
  expect((await env.DB.prepare("SELECT key FROM core_blob_deletion").all()).results).toEqual([
    { key: "email-bodies/m1" },
  ]);
  expect(
    (await env.DB.prepare("SELECT activity_id FROM core_activity_links").all()).results,
  ).toEqual([{ activity_id: "act_private" }]);
});
