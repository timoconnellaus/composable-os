// `cos subscriptions offers import` (stage 32a, build step 4, ADRs 0491 and 0492) against the real
// host: the CLI's own engine (packages/create-composable-os/src/offers-import) over cos-app's real
// HTTP surface, with a person's staff device session, as the command runs it. Courses is
// reconciled into the host from its own manifest, and its plan is the offers' plan.
//
// A list imports after a dry run that writes nothing; a re-run changes nothing; an address no one
// has is reported with its line and nobody is created; a customer reads their own offer and no one
// else's; a customer, the public and an MCP token cannot import; no AI actor can import or withdraw.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  applyPlan,
  type CustomerPrincipal,
  type InvocationContext,
  invoke,
  issueDeviceSession,
  type OutsideInvocationContext,
  planReconcile,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { toManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ImportHost,
  sessionHost,
} from "../../../packages/create-composable-os/src/import-door/host.ts";
import {
  offersReportLines,
  readOffersFile,
  resolvePlan,
  runOffersImport,
} from "../../../packages/create-composable-os/src/offers-import/engine.ts";
import courses from "../../../packs/courses/index.ts";
import { handleApi } from "../src/server/http/api.ts";
import { boundTestEnv } from "./bound-env.ts";
import { ORIGIN, signUp, unique } from "./mcp-helpers.ts";

const hostEnv = boundTestEnv(env);
const db = createCrmDb(env.DB);
const fetcher = (async (input: string, init?: RequestInit) =>
  (await handleApi(new Request(input, init), hostEnv)) ??
  new Response("Not found", { status: 404 })) as unknown as typeof fetch;

let admin: ActingUser;
let accessToken: string;
const asStaff = (): ImportHost =>
  sessionHost(ORIGIN, async () => ({ authorization: `Bearer ${accessToken}` }), fetcher);
const staff = (extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user: admin,
  origin: { surface: "ui" },
  db,
  ...extra,
});
const as = (principal: CustomerPrincipal): OutsideInvocationContext => ({ principal, db });

const tag = unique("off")
  .toLowerCase()
  .replace(/[^a-z0-9]/g, "");
const email = (who: string) => `${who}-${tag}@moving.test`;
const people: Record<string, CustomerPrincipal> = {};
const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const csv = () =>
  [
    "email,paid_up_to,reference",
    `${email("ana")},${day(20)},old-1`,
    `${email("ben")},${day(30)},old-2`,
    `${email("eve")},${day(20)},old-3`,
  ].join("\n");

async function offers() {
  const { results } = await env.DB.prepare(
    "SELECT email, person_id, free_until FROM core_subscription_offer WHERE email LIKE ? ORDER BY email",
  )
    .bind(`%-${tag}@moving.test`)
    .all<{ email: string; person_id: string; free_until: string }>();
  return results;
}

beforeAll(async () => {
  const user = await signUp(hostEnv as never, "admin");
  admin = { id: user.id, email: user.email, name: "Admin", role: "admin" };
  const plan = await planReconcile(db.query, toManifest(courses), {
    now: new Date().toISOString(),
  });
  await applyPlan((statements) => db.batch(statements), plan);
  await refreshSchemaRegistry(db.query);
  accessToken = (
    await issueDeviceSession(
      db,
      { audience: "staff", subjectId: admin.id },
      "Offers import test",
      new Date(),
    )
  ).accessToken;
  await invoke(
    "record.create",
    { object: "courses.plan", values: { title: `Every course ${tag}`, price: 29, trialDays: 7 } },
    staff(),
  );
  // The people come first, through the people import (here: as staff would have them). eve is
  // not on the host: her row is reported, and nobody is made for her.
  for (const who of ["ana", "ben"]) {
    const person = await invoke(
      "person.create",
      { givenName: who, emails: [{ email: email(who) }] },
      staff(),
    );
    const customerId = `cus_${who}${tag}`;
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO core_customer (id, person_id, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    )
      .bind(customerId, person.id, email(who), now, now)
      .run();
    people[who] = { kind: "customer", customerId, personId: person.id };
  }
});

describe("cos subscriptions offers import, against the real host", () => {
  it("imports after a dry run, reports an address no one has with its line, and a re-run changes nothing", async () => {
    const host = asStaff();
    const plan = await resolvePlan(host, "courses.plan");
    const file = readOffersFile(csv(), "offers.csv");
    expect(file.problems).toEqual([]);

    const dry = await runOffersImport(file, host, { plan, dryRun: true, invite: false });
    expect(dry.rows.map((r) => r.outcome)).toEqual(["created", "created", "unmatched"]);
    expect(await offers()).toEqual([]);

    const done = await runOffersImport(file, host, { plan, dryRun: false, invite: false });
    expect(done.problems.map((p) => [p.line, p.email, p.outcome])).toEqual([
      [4, email("eve"), "unmatched"],
    ]);
    expect(offersReportLines(done, "offers.csv")).toContain(
      `  offers.csv:4 ${email("eve")}: unmatched: no person has this address: import the people first`,
    );
    const rows = await offers();
    expect(rows.map((r) => [r.email, r.person_id])).toEqual([
      [email("ana"), people.ana?.personId],
      [email("ben"), people.ben?.personId],
    ]);
    // Nobody was created for eve.
    const eve = await env.DB.prepare("SELECT count(*) AS n FROM core_person_emails WHERE email = ?")
      .bind(email("eve"))
      .first<{ n: number }>();
    expect(Number(eve?.n)).toBe(0);
    // Done as the person who signed in, a human.
    const audit = await env.DB.prepare(
      "SELECT actor, user_id FROM core_audit WHERE operation = 'subscription.offer.import' ORDER BY at DESC LIMIT 1",
    ).first<{ actor: string; user_id: string }>();
    expect(audit).toEqual({ actor: "human", user_id: admin.id });

    const again = await runOffersImport(file, host, { plan, dryRun: false, invite: false });
    expect(again.rows.map((r) => r.outcome)).toEqual(["unchanged", "unchanged", "unmatched"]);
    expect(await offers()).toEqual(rows);
  });

  it("gives each customer their own offer and no one else's", async () => {
    const ana = await invoke("subscription.offer.mine", {}, as(people.ana as CustomerPrincipal));
    expect(ana.offers.map((o) => o.freeUntil)).toEqual([`${day(20)}T00:00:00.000Z`]);
    const ben = await invoke("subscription.offer.mine", {}, as(people.ben as CustomerPrincipal));
    expect(ben.offers.map((o) => o.freeUntil)).toEqual([`${day(30)}T00:00:00.000Z`]);
  });

  it("is a person's door: no customer, no public caller, no MCP token, no AI actor", async () => {
    const plan = await resolvePlan(asStaff(), "courses.plan");
    const input = {
      plan: { object: plan.object, id: plan.id },
      rows: [{ email: email("ana"), freeUntil: day(40) }],
    };
    for (const actor of ["assistant", "mcp", "automation"] as const) {
      await expect(
        invoke("subscription.offer.import", input, staff({ actor } as never)),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        invoke(
          "subscription.offer.withdraw",
          { id: "sof_x", reason: "x" },
          staff({ actor } as never),
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    await expect(
      invoke("subscription.offer.import", input, as(people.ana as CustomerPrincipal) as never),
    ).rejects.toBeTruthy();
    // On the HTTP surface: no credential, or a made-up token, is refused.
    for (const authorization of [undefined, "Bearer cos_at_made-up"]) {
      const response = await fetcher(`${ORIGIN}/api/v1/op/subscription.offer.import`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify(input),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    // Nothing moved: ana's date is the imported one.
    expect((await offers()).find((o) => o.email === email("ana"))?.free_until).toBe(
      `${day(20)}T00:00:00.000Z`,
    );
  });
});
