// Stage 60, acceptance criterion 6's host half (ADR 0872): a change to how the system is set up
// (an extension, a schema change) is never approved from the company's app on a phone. The HTTP
// surface marks a staff device session's call (`origin.staffDevice`, from the session, never the
// request), and approval.approve refuses a setup action under it, for an admin too. Any other
// action approves from the phone as before, and the same setup action approves from a browser.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { type ActingUser, invokeByName, newId } from "../src/index.ts";
import { context, createUser } from "./helpers.ts";

let admin: ActingUser;

/** One change set with one pending action, queued from an AI client for `admin`. */
async function queued(operation: string, risk: string, input: unknown): Promise<string> {
  const set = newId("changeSet");
  const id = newId("pendingAction");
  const now = new Date();
  const expires = new Date(now.getTime() + 86_400_000).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO core_change_set (id, user_id, actor, origin, created_at, updated_at) VALUES (?, ?, 'mcp', '{}', ?, ?)",
    ).bind(set, admin.id, now.toISOString(), now.toISOString()),
    env.DB.prepare(
      `INSERT INTO core_pending_action (id, change_set_id, operation, risk, input, reason, actor,
        user_id, origin, preview, simulated, status, created_at, expires_at, review_source)
       VALUES (?, ?, ?, ?, ?, 'Fixture', 'mcp', ?, '{"surface":"mcp"}', '[]', '{}', 'pending', ?, ?, 'policy')`,
    ).bind(id, set, operation, risk, JSON.stringify(input), admin.id, now.toISOString(), expires),
  ]);
  return id;
}

const fromPhone = () => context(admin, { origin: { surface: "client", staffDevice: true } });

async function status(id: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT status FROM core_pending_action WHERE id = ?")
    .bind(id)
    .first<{ status: string }>();
  return row?.status;
}

beforeEach(async () => {
  admin = await createUser("admin");
});

describe("approving from the company's app (ADR 0872)", () => {
  it("refuses an extension or schema action, for an admin, and leaves it waiting", async () => {
    for (const risk of ["extension", "schema"]) {
      const id = await queued("extension.disable", risk, { id: "fixture" });
      await expect(
        invokeByName("approval.approve", { actionIds: [id] }, fromPhone()),
      ).rejects.toMatchObject({ code: "forbidden", details: { reason: "review_on_computer" } });
      expect(await status(id)).toBe("pending");
      // Rejecting it from the phone is fine: nothing is set up by a rejection.
      await invokeByName("approval.reject", { actionIds: [id] }, fromPhone());
      expect(await status(id)).toBe("rejected");
    }
  });

  it("approves any other action from the phone, and the setup action from a browser", async () => {
    const write = await queued("person.create", "write", { displayName: "Fixture person" });
    await invokeByName("approval.approve", { actionIds: [write] }, fromPhone());
    expect(await status(write)).toBe("applied");
    const setup = await queued("extension.disable", "extension", { id: "fixture" });
    // In the browser the rule does not apply: the action runs (and fails here, as no extension
    // named fixture is installed), so the refusal is the phone's alone.
    await invokeByName("approval.approve", { actionIds: [setup] }, context(admin)).catch(
      () => null,
    );
    expect(await status(setup)).not.toBe("pending");
  });
});
