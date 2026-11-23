// Migration 0770 (issue #258, ADR 0600): grants stored on an account holding a pack role counted
// for nothing before ADR 0600, which makes them count. The migration clears them (and those on
// pending invites with a fixed role), leaves every other account's grants alone, and writes one
// audit row saying how many, with each account's change recorded on it. Its own file: it starts
// from an empty database and stops before 0770 to put such accounts in.
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { applyMigrations, migrationNumber } from "../src/index.ts";

const NOW = "2026-11-20T00:00:00.000Z";

it("clears the grants a fixed role's account held inert, audits it, and leaves the rest", async () => {
  const before = env.TEST_MIGRATIONS.filter((m) => (migrationNumber(m.name) ?? 0) < 770);
  expect(env.TEST_MIGRATIONS.some((m) => migrationNumber(m.name) === 770)).toBe(true);
  await applyMigrations(env.DB, before);

  const user = (id: string, role: string, packRole: string | null, grants: string | null) =>
    env.DB.prepare(
      "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, role, pack_role, granted_permissions) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)",
    ).bind(id, id, `${id}@example.com`, NOW, NOW, role, packRole, grants);
  const invite = (id: string, packRole: string | null, grants: string | null) =>
    env.DB.prepare(
      "INSERT INTO core_user_invite (id, email, role, pack_role, granted_permissions, invited_by, created_at, updated_at, expires_at) VALUES (?, ?, 'viewer', ?, ?, 'usr_admin', ?, ?, '2026-12-01T00:00:00.000Z')",
    ).bind(id, `${id}@example.com`, packRole, grants, NOW, NOW);
  await env.DB.batch([
    // A viewer once granted giving passes, later made a coach: the grant was inert.
    user("usr_coach", "viewer", "bookings.coach", '["memberships:passes"]'),
    user("usr_door", "viewer", "ticketing.door", '["records:publish","bookings:desk"]'),
    // Unchanged: no pack role, or a pack role with nothing stored.
    user("usr_member", "member", null, '["records:publish"]'),
    user("usr_plain", "viewer", "bookings.coach", null),
    invite("inv_coach", "bookings.coach", '["memberships:passes"]'),
    invite("inv_member", null, '["orders:refund"]'),
  ]);

  await applyMigrations(env.DB, env.TEST_MIGRATIONS);

  const grants = await env.DB.prepare(
    "SELECT id, granted_permissions FROM core_user ORDER BY id",
  ).all<{ id: string; granted_permissions: string | null }>();
  expect(grants.results).toEqual([
    { id: "usr_coach", granted_permissions: null },
    { id: "usr_door", granted_permissions: null },
    { id: "usr_member", granted_permissions: '["records:publish"]' },
    { id: "usr_plain", granted_permissions: null },
  ]);
  const invites = await env.DB.prepare(
    "SELECT id, granted_permissions FROM core_user_invite ORDER BY id",
  ).all<{ id: string; granted_permissions: string | null }>();
  expect(invites.results).toEqual([
    { id: "inv_coach", granted_permissions: null },
    { id: "inv_member", granted_permissions: '["orders:refund"]' },
  ]);

  const audit = await env.DB.prepare(
    "SELECT operation, outcome, result FROM core_audit WHERE id = 'aud_migration0770'",
  ).first<{ operation: string; outcome: string; result: string }>();
  expect(audit).toMatchObject({ operation: "migration.clearFixedRoleGrants", outcome: "ok" });
  expect(JSON.parse(audit?.result ?? "{}")).toMatchObject({ accounts: 2, invites: 1 });
  const changes = await env.DB.prepare(
    "SELECT record_id, diff FROM core_audit_changes WHERE audit_id = 'aud_migration0770' ORDER BY record_id",
  ).all<{ record_id: string; diff: string }>();
  expect(changes.results.map((c) => [c.record_id, JSON.parse(c.diff)])).toEqual([
    ["usr_coach", { permissions: { before: ["memberships:passes"], after: [] } }],
    ["usr_door", { permissions: { before: ["records:publish", "bookings:desk"], after: [] } }],
  ]);
});
