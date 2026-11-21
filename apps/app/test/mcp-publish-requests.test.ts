// Stage 28 criterion 12 over /mcp (ADR 0480): an MCP client drafts a post and asks to publish it;
// under the default policy and the most permissive one the request waits for a person; a person
// approves it in the app and the post goes live; a request whose post changed since is refused;
// the client can never approve its own request.
import { env } from "cloudflare:workers";
import { applyPlan, planReconcile, refreshSchemaRegistry } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { manifestSchema } from "@composable-os/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runOperation } from "../src/server/operations.ts";
import {
  appFor,
  call,
  connect,
  mcpClient,
  setPreset,
  signUp,
  type TestUser,
  testEnv,
  unique,
} from "./mcp-helpers.ts";

const mcpEnv = testEnv();
const fetchApp = appFor(mcpEnv);
const db = createCrmDb(env.DB);
const EXT = `ask${Date.now().toString(36)}`;
const POST = `${EXT}.post`;
let admin: TestUser;

const principal = (u: TestUser) => ({ userId: u.id, email: u.email, name: u.email, roles: [] });

async function asHuman(user: TestUser, name: string, input: unknown) {
  const result = await runOperation(mcpEnv, principal(user), { name, input });
  if (!result.ok) throw new Error(`${name}: ${result.error.message}`);
  return result.data as Record<string, unknown>;
}

const body = (text: string) => ({
  blocks: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

beforeAll(async () => {
  admin = await signUp(mcpEnv, "admin");
  const plan = await planReconcile(
    db.query,
    manifestSchema.parse({
      id: EXT,
      version: "1.0.0",
      contractVersion: 1,
      objects: {
        post: {
          label: "Post",
          plural: "Posts",
          titleField: "title",
          fields: {
            title: { type: "text", label: "Title", required: true },
            slug: { type: "slug", label: "Slug" },
            body: { type: "richText", label: "Body" },
          },
          publishable: { content: ["title", "body"], slug: "slug" },
          public: { read: ["title", "slug", "body"] },
        },
      },
    }),
    { now: new Date().toISOString() },
  );
  await applyPlan((statements) => db.batch(statements), plan);
  await refreshSchemaRegistry(db.query);
}, 60_000);

afterAll(async () => {
  await setPreset("balanced");
});

async function draftAndAsk(client: Awaited<ReturnType<typeof mcpClient>>) {
  const created = await call(client, "call_operation", {
    name: "record.create",
    input: {
      object: POST,
      values: { title: unique("Open day"), slug: unique("open-day"), body: body("Come along") },
    },
    reason: "Drafting the open day post",
  });
  expect(created.isError).toBe(false);
  const id = created.data.id as string;
  const updated = await call(client, "call_operation", {
    name: "record.update",
    input: { object: POST, id, values: { body: body("Come along on Saturday") } },
    reason: "The day is Saturday",
  });
  expect(updated.isError).toBe(false);
  const asked = await call(client, "call_operation", {
    name: "record.publish",
    input: { object: POST, id, note: "Open day" },
    reason: "The post is ready",
  });
  return { id, asked };
}

describe("an MCP client asks for a publish; a person approves (criterion 12)", () => {
  for (const preset of ["balanced", "autonomous"] as const) {
    it(`under ${preset}: queued, approved by a person, live`, async () => {
      await setPreset(preset);
      const tokens = await connect(fetchApp, admin);
      const client = await mcpClient(fetchApp, tokens.access_token);
      const { id, asked } = await draftAndAsk(client);
      expect(asked.isError).toBe(false);
      expect(asked.data).toMatchObject({ status: "pending_approval", operation: "record.publish" });
      const actionId = asked.data.actionId as string;
      // Not live while it waits.
      const before = await env.DB.prepare(
        "SELECT count(*) AS n FROM core_publish_version WHERE record_id = ?",
      )
        .bind(id)
        .first<{ n: number }>();
      expect(before?.n).toBe(0);
      // The client cannot approve it, by either approval operation.
      for (const [name, input] of [
        ["approval.approve", { actionIds: [actionId] }],
        ["approval.decide", { actionIds: [actionId], decision: "approve" }],
      ] as const) {
        const tried = await call(client, "call_operation", { name, input, reason: "Ship it" });
        expect(tried.isError, name).toBe(true);
      }
      // The person approves it in the app.
      await asHuman(admin, "approval.approve", { actionIds: [actionId] });
      const version = await asHuman(admin, "record.version", { object: POST, id });
      expect(version).toMatchObject({
        version: 1,
        current: true,
        publishedBy: admin.id,
        requestedBy: admin.id,
        requestedVia: "mcp",
        values: { body: body("Come along on Saturday") },
      });
    });
  }

  it("a request whose post changed since it was asked for is refused", async () => {
    await setPreset("balanced");
    const tokens = await connect(fetchApp, admin);
    const client = await mcpClient(fetchApp, tokens.access_token);
    const { id, asked } = await draftAndAsk(client);
    const actionId = asked.data.actionId as string;
    await asHuman(admin, "record.update", {
      object: POST,
      id,
      values: { body: body("Cancelled") },
    });
    const out = (await asHuman(admin, "approval.approve", { actionIds: [actionId] })) as {
      results: { status: string; statusReason: string | null }[];
    };
    expect(out.results[0]?.status).toBe("failed");
    expect(out.results[0]?.statusReason).toMatch(/changed after this publish was asked for/);
    const versions = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_publish_version WHERE record_id = ?",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(versions?.n).toBe(0);
  });
});
