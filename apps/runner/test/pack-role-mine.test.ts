// Stage 39 step 3 (ADR 0755): a pack role's "mine" reach holds inside a tool run the account
// started, and in the runs of the tools that run calls. Real D1, the real workspace and the real
// sandbox: a member's call carrying a crew account's limit (as the pipeline gives a tool the role
// allows) reaches through the tool only the jobs the account has a place on, finds no other,
// changes no field deciding the reach and runs no operation the limit cannot check.
import { env } from "cloudflare:workers";
import { type ActingUser, invokeByName, type MineLimit } from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { call, context, createAdmin, install, source, unique } from "./helpers.ts";

const id = unique("mine");
const relay = unique("relay");
const JOB = `${id}.job`;
const PLACE = `${id}.place`;
let admin: ActingUser;
let crew: ActingUser;
let reached: string;
let theirs: string;
let place: string;

const tool = (name: string, input: string, body: string) => `${name}: defineTool({
      description: "Test fixture: a crew tool over jobs.",
      input: z.object({ ${input} }),
      output: z.unknown(),
      handler: async (input, ctx) => { ${body} },
    }),`;

const limit = (): MineLimit => ({
  userId: crew.id,
  reach: { [JOB]: { through: PLACE, who: "staff", path: ["job"] } },
});
const carrying = () => context(admin, { roleMine: limit() });

async function outcome(run: Promise<unknown>) {
  try {
    return { ok: true as const, value: await run };
  } catch (error) {
    const e = error as {
      code?: string;
      message?: string;
      details?: { code?: string; rule?: string };
    };
    return {
      ok: false as const,
      code: e.details?.code ?? e.code,
      rule: e.details?.rule,
      message: e.message,
    };
  }
}

beforeAll(async () => {
  admin = await createAdmin();
  crew = { ...(await createAdmin()), role: "member" };
  await install(
    admin,
    id,
    source(
      id,
      `permissions: { modules: ["ops"] },
  objects: {
    job: { label: "Job", plural: "Jobs", titleField: "name", fields: { name: { type: "text", label: "Name", required: true } } },
    place: {
      label: "Crew place", plural: "Crew places", titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        job: { type: "relation", label: "Job", to: "${JOB}" },
        staff: { type: "user", label: "Staff" },
      },
    },
  },
  tools: {
    ${tool("peek", "id: z.string()", `return ctx.ops.call("record.get", { object: "${JOB}", id: input.id });`)}
    ${tool("all", "", `return ctx.ops.call("record.list", { object: "${JOB}" });`)}
    ${tool("rename", "id: z.string()", `return ctx.ops.call("record.update", { object: "${JOB}", id: input.id, values: { name: "renamed" } });`)}
    ${tool("repoint", "id: z.string(), job: z.string()", `return ctx.ops.call("record.update", { object: "${PLACE}", id: input.id, values: { job: input.job } });`)}
    ${tool("count", "", `return ctx.ops.call("record.count", { object: "${JOB}" });`)}
  },`,
    ),
  );
  // A second pack whose tool calls the first's. A runtime extension may not call another's tool:
  // make it what a shipped one would be, its stored manifest edited in place (as
  // customer-tool.test.ts does).
  await install(
    admin,
    relay,
    source(
      relay,
      `permissions: { modules: ["ops"] },
  objects: {},
  tools: {
    ${tool("relay", "id: z.string()", `return ctx.ops.call("x.${id}.peek", { id: input.id });`)}
  },`,
    ),
  );
  const row = await env.DB.prepare("SELECT manifest FROM core_extensions WHERE id = ?")
    .bind(relay)
    .first<{ manifest: string }>();
  const stored = JSON.parse(row?.manifest ?? "{}");
  stored.permissions.operations = [`x.${id}.peek`];
  await env.DB.prepare("UPDATE core_extensions SET source = 'shipped', manifest = ? WHERE id = ?")
    .bind(JSON.stringify(stored), relay)
    .run();
  const create = async (object: string, values: Record<string, unknown>) =>
    (await call<{ id: string }>(admin, "record.create", { object, values })).id;
  reached = await create(JOB, { name: unique("reached") });
  theirs = await create(JOB, { name: unique("theirs") });
  place = await create(PLACE, { name: unique("place"), job: reached, staff: crew.id });
}, 120_000);

describe("a tool run carrying the mine reach", () => {
  it("lists and opens only the jobs the account has a place on", async () => {
    const all = await outcome(invokeByName(`x.${id}.all`, {}, carrying()));
    expect(all, JSON.stringify(all)).toMatchObject({ ok: true });
    const items = (all as { value: { items: { id: string }[] } }).value.items.map((r) => r.id);
    expect(items).toEqual([reached]);
    expect(await outcome(invokeByName(`x.${id}.peek`, { id: reached }, carrying()))).toMatchObject({
      ok: true,
    });
    expect(await outcome(invokeByName(`x.${id}.peek`, { id: theirs }, carrying()))).toMatchObject({
      ok: false,
      code: "not_found",
    });
    // Without the limit the same tool reaches both: staff are not limited.
    expect(
      await outcome(invokeByName(`x.${id}.peek`, { id: theirs }, context(admin))),
    ).toMatchObject({ ok: true });
  });

  it("follows the run into another pack's tool it calls", async () => {
    expect(
      await outcome(invokeByName(`x.${relay}.relay`, { id: reached }, carrying())),
    ).toMatchObject({ ok: true });
    // The called tool's not-found comes back inside the calling tool's error.
    const refused = await outcome(invokeByName(`x.${relay}.relay`, { id: theirs }, carrying()));
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).toContain(`No ${JOB} with id ${theirs}`);
    // Without the limit the same nested call reaches it.
    expect(
      await outcome(invokeByName(`x.${relay}.relay`, { id: theirs }, context(admin))),
    ).toMatchObject({ ok: true });
  });

  it("changes only what it reaches, never what decides the reach, and nothing it cannot check", async () => {
    expect(
      await outcome(invokeByName(`x.${id}.rename`, { id: reached }, carrying())),
    ).toMatchObject({ ok: true });
    expect(await outcome(invokeByName(`x.${id}.rename`, { id: theirs }, carrying()))).toMatchObject(
      { ok: false, code: "not_found" },
    );
    expect(
      await outcome(invokeByName(`x.${id}.repoint`, { id: place, job: theirs }, carrying())),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(await outcome(invokeByName(`x.${id}.count`, {}, carrying()))).toMatchObject({
      ok: false,
      code: "forbidden",
    });
  });
});
