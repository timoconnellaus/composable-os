// Who is calling is resolved on every staff request (resolveActingUser): one row of core_user's
// primary key, however many accounts there are, not a read of the whole table
// (docs/cloudflare-costs.md). A user known only by email (a Cloudflare Access user whose id is
// not a row) is still found, case-insensitively, as before.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { newId, resolveActingUser } from "../src/index.ts";
import { meterRowsRead } from "./rows-read-meter.ts";

const meter = meterRowsRead(env.DB);
const db = createCrmDb(meter.db);
const target = { id: newId("user"), email: "cost-target@example.com" };

describe("resolveActingUser's cost", () => {
  beforeAll(async () => {
    const now = new Date().toISOString();
    const insert = env.DB.prepare(
      "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, role) VALUES (?, 'Staff', ?, 1, ?, ?, 'member')",
    );
    const rows = [
      target,
      ...Array.from({ length: 300 }, (_, i) => ({
        id: newId("user"),
        email: `cost-staff-${i}@example.com`,
      })),
    ];
    await env.DB.batch(rows.map((u) => insert.bind(u.id, u.email, now, now)));
  });

  it("reads one row for a user found by id", async () => {
    meter.reset();
    const user = await resolveActingUser(db, {
      userId: target.id,
      email: target.email,
      name: "Staff",
    });
    expect(user.id).toBe(target.id);
    expect(meter.rows).toBeLessThanOrEqual(2);
  });

  it("still finds a user by email, whatever its case, when the id is not a row", async () => {
    const user = await resolveActingUser(db, {
      userId: "access-subject-1",
      email: "Cost-Target@Example.com",
      name: "Staff",
    });
    expect(user.id).toBe(target.id);
  });
});
