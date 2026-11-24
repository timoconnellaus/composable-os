// Stage 60, acceptance criterion 6's host half (ADR 0872): a change to how the system is set up
// (an extension, a schema change) is never made from the company's app on a phone. The HTTP
// surface marks a staff device session's call (`origin.staffDevice`, from the session, never the
// request), and a setup action is refused under it, for an admin too: approved (approval.approve)
// or called directly (the pipeline). Any other action approves from the phone as before, and the
// same setup action applies from a browser.
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ActingUser,
  coreRegistry,
  createInvoker,
  createRegistry,
  defineOperation,
  type PendingApprovalError,
} from "../src/index.ts";
import { context, createUser, setPreset, unique } from "./helpers.ts";

/** A setup change an AI may ask for: it writes a setting, so applying it is visible. */
const setUp = defineOperation({
  name: "ownerTest.setUp",
  description: "Fixture: a schema change. Writes one setting named by key.",
  input: z.object({ key: z.string() }),
  output: z.object({ key: z.string() }),
  permission: "extensions:manage",
  risk: "schema",
  async handler(input, ctx) {
    ctx.write(
      ctx.db.insertInto("core_settings").values({
        key: `owner_test_${input.key}`,
        value: "true",
        updated_at: ctx.now,
        updated_by: ctx.user.id,
      }),
    );
    return { key: input.key };
  },
});

const { invokeByName } = createInvoker(createRegistry([...coreRegistry.list(), setUp]));

let admin: ActingUser;

const fromPhone = () => context(admin, { origin: { surface: "client", staffDevice: true } });
const fromBrowser = () => context(admin);
const asAgent = () =>
  context(admin, { actor: "mcp", origin: { surface: "mcp", sessionId: unique("cap") } });

/** Queues `name` as an AI client asking for it under the cautious policy: its pending action. */
async function queued(name: string, input: unknown): Promise<string> {
  try {
    await invokeByName(name, input, asAgent());
  } catch (error) {
    const pending = (error as PendingApprovalError).pending;
    if (pending?.actionId) return pending.actionId;
    throw error;
  }
  throw new Error(`${name} was not queued`);
}

async function status(id: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT status FROM core_pending_action WHERE id = ?")
    .bind(id)
    .first<{ status: string }>();
  return row?.status;
}

async function wasSetUp(key: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT key FROM core_settings WHERE key = ?")
    .bind(`owner_test_${key}`)
    .first();
  return row !== null;
}

beforeAll(async () => {
  await setPreset("cautious");
});

beforeEach(async () => {
  admin = await createUser("admin");
});

describe("approving from the company's app (ADR 0872)", () => {
  it("refuses a setup action, for an admin, and leaves it waiting; rejecting it is fine", async () => {
    const key = unique("k");
    const id = await queued("ownerTest.setUp", { key });
    await expect(
      invokeByName("approval.approve", { actionIds: [id] }, fromPhone()),
    ).rejects.toMatchObject({ code: "forbidden", details: { reason: "review_on_computer" } });
    expect(await status(id)).toBe("pending");
    expect(await wasSetUp(key)).toBe(false);
    await invokeByName("approval.reject", { actionIds: [id] }, fromPhone());
    expect(await status(id)).toBe("rejected");
  });

  it("approves any other action from the phone, and the setup action from a browser", async () => {
    const write = await queued("person.create", { displayName: "Fixture person" });
    await invokeByName("approval.approve", { actionIds: [write] }, fromPhone());
    expect(await status(write)).toBe("applied");
    const key = unique("k");
    const setup = await queued("ownerTest.setUp", { key });
    await invokeByName("approval.approve", { actionIds: [setup] }, fromBrowser());
    expect(await status(setup)).toBe("applied");
    expect(await wasSetUp(key)).toBe(true);
  });

  it("refuses a setup operation called directly from the phone, audited, and changes nothing", async () => {
    const key = unique("k");
    await expect(invokeByName("ownerTest.setUp", { key }, fromPhone())).rejects.toMatchObject({
      code: "forbidden",
      details: { reason: "review_on_computer" },
    });
    expect(await wasSetUp(key)).toBe(false);
    const audit = await env.DB.prepare(
      "SELECT outcome, origin FROM core_audit WHERE operation = 'ownerTest.setUp' AND user_id = ? ORDER BY at DESC LIMIT 1",
    )
      .bind(admin.id)
      .first<{ outcome: string; origin: string }>();
    expect(audit?.outcome).toBe("forbidden");
    expect(JSON.parse(audit?.origin ?? "{}")).toMatchObject({ staffDevice: true });
    // From a browser the same call is the admin's to make, at once.
    await invokeByName("ownerTest.setUp", { key }, fromBrowser());
    expect(await wasSetUp(key)).toBe(true);
  });
});
