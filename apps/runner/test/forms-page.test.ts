// Stage 29 step 4 (ADR 0728): the form page (packs/forms/client/page.ts) against the real host: its typed
// client calls the HTTP surface (core's createHttpSurface over the real invoker), the Forms tools
// run in the sandbox, and the door is the real one, with real D1.
//
// What it shows (criterion 19, and the personal link's page rules of the security review of PR
// #458): a form's own page draws the published form and sends a signed-in member's answers with
// an idempotency key, once however often the browser posts them; a visitor on a public form is told
// what the host said (no Turnstile secret on this runner: not taking answers); a personal link's
// page is sent with no referrer and loads no script from anywhere else, opening it (three GETs)
// uses nothing, its send uses it once, and a second send is the one refusal.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type CustomerPrincipal,
  coreInvoker,
  createHttpSurface,
  type ExtensionHost,
  ensureLink,
  type InvocationContext,
  linkToken,
  type OutsideInvocationContext,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { formPage, formPageClient } from "../../../packs/forms/client/page.ts";
import { integrationRuntime } from "../src/integrations/runtime.ts";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, db, host, newCustomer, run, unique } from "./helpers.ts";
import { packFiles } from "./pack-files.ts";

const integrations = integrationRuntime(env);
const FORM = "forms.form";
const SUBMISSION = "forms.submission";
const files = { forms: packFiles("forms") };
const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [
    ...(await host.shipped()).filter((s) => s.id !== "forms"),
    { id: "forms", version: "0.1.0" },
  ],
  commitShipped: (id) =>
    id === "forms"
      ? host.commit({
          id,
          files: files.forms,
          message: "Shipped forms",
          author: { name: "Composable OS", email: "release@composableos.dev" },
        })
      : host.commitShipped(id),
};

let admin: ActingUser;
let member: CustomerPrincipal & { email: string };
const staff = (): InvocationContext => ({
  actor: "human",
  user: admin,
  origin: { surface: "ui" },
  db,
  integrations,
  extensionHost: shippedHost,
});
const outside = (principal: CustomerPrincipal | { kind: "public" }): OutsideInvocationContext => ({
  principal,
  db,
  integrations,
  extensionHost: shippedHost,
});

// The host's surface. The test's stand-in for a verified session: a `who=member` cookie is the
// member, anything else the public (cos-app decides it from the signed customer cookie).
const surface = createHttpSurface({
  invoker: coreInvoker,
  context: async (request) =>
    /\bwho=member\b/.test(request.headers.get("cookie") ?? "")
      ? outside(member)
      : outside({ kind: "public" }),
});

/** Serves one request to the page as cos-app does: its client over the surface, the cookie only. */
function serve(request: Request): Promise<Response> {
  const cookie = request.headers.get("cookie");
  return formPage(request, {
    client: formPageClient({
      fetch: async (url, init) =>
        (await surface.handle(new Request(url, init))) ??
        new Response("Not found", { status: 404 }),
      headers: () => (cookie ? { cookie } : {}),
    }),
    turnstileSiteKey: "1x00000000000000000000AA",
  });
}

const SITE = "https://gym.example";
const get = (path: string, cookie?: string) =>
  serve(new Request(`${SITE}${path}`, cookie ? { headers: { cookie } } : {}));
const post = (path: string, fields: [string, string][], cookie?: string) =>
  serve(
    new Request(`${SITE}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: SITE,
        ...(cookie ? { cookie } : {}),
      },
      body: new URLSearchParams(fields).toString(),
    }),
  );

function hidden(html: string): [string, string][] {
  return [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [
    m[1] as string,
    (m[2] as string).replaceAll("&amp;", "&"),
  ]);
}

const questions = {
  items: [
    { kind: "rating", key: "score", label: "How was it?", scale: "stars", required: true },
    { kind: "text", key: "why", label: "Anything to tell us?", long: true },
  ],
};

async function makeForm(values: Record<string, unknown>) {
  const id = (
    await run<{ id: string }>(
      "record.create",
      { object: FORM, values: { title: unique("Form"), questions, receipt: false, ...values } },
      staff(),
    )
  ).id;
  await run("record.update", { object: FORM, id, values: { status: "open" } }, staff());
  await run("record.publish", { object: FORM, id }, staff());
  const got = await run<{ values: Record<string, unknown> }>(
    "record.get",
    { object: FORM, id },
    staff(),
  );
  return { id, slug: String(got.values.slug) };
}

async function submissionsOf(form: string) {
  const page = await run<{ items: { id: string; values: Record<string, unknown> }[] }>(
    "record.list",
    { object: SUBMISSION, filter: { field: "form", op: "eq", value: form }, limit: 50 },
    staff(),
  );
  return page.items;
}

beforeAll(async () => {
  admin = await createAdmin();
  await setPreset("autonomous");
  await run("extension.install", { id: "forms", shipped: true }, staff());
  await refreshSchemaRegistry(db.query);
  const made = await newCustomer(staff(), "pagemember");
  member = { ...made.principal, email: made.email };
}, 120_000);

describe("a form's own page (criterion 19)", { timeout: 60_000 }, () => {
  it("draws the form and sends a member's answers once, however often the browser posts them", async () => {
    const form = await makeForm({ answeredBy: "customers" });
    // Not open to the public: the same not found as any form that is not open.
    const visitor = await get(`/f/${form.slug}`);
    expect(visitor.status).toBe(404);
    expect(await visitor.text()).toContain("This form is not open");

    const opened = await get(`/f/${form.slug}`, "who=member");
    expect(opened.status).toBe(200);
    expect(opened.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await opened.text();
    expect(html).toContain("How was it?");
    const fields: [string, string][] = [...hidden(html), ["a.score", "4"], ["a.why", "Good class"]];
    const first = await post(`/f/${form.slug}`, fields, "who=member");
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('role="status"');
    // The browser posts the same page again (a reload, a second press): the same key, one answer.
    const again = await post(`/f/${form.slug}`, fields, "who=member");
    expect(again.status).toBe(200);
    const kept = await submissionsOf(form.id);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.values).toMatchObject({
      person: member.personId,
      certainty: "account",
      via: "page",
      rating: 4,
    });
  });

  it("tells a visitor what the host said: with no Turnstile secret, a public form takes no answers", async () => {
    const form = await makeForm({ answeredBy: "public" });
    const opened = await get(`/f/${form.slug}`);
    expect(opened.status).toBe(200);
    const html = await opened.text();
    // A public form's page draws Turnstile's widget, the one script from elsewhere it may load.
    expect(html).toContain('class="cf-turnstile"');
    const sent = await post(`/f/${form.slug}`, [
      ...hidden(html),
      ["a.score", "5"],
      ["cf-turnstile-response", "XXXX.DUMMY.TOKEN.XXXX"],
    ]);
    expect(sent.status).toBe(400);
    expect(await sent.text()).toContain("Your answers were not sent");
    expect(await submissionsOf(form.id)).toEqual([]);
  });
});

describe("a personal link's page (the security review of PR #458)", { timeout: 60_000 }, () => {
  it("sends no referrer, loads nothing from elsewhere, opening it uses nothing, and the send uses it once", async () => {
    const form = await makeForm({ answeredBy: "links", kind: "feedback" });
    const now = new Date().toISOString();
    const made = await ensureLink(db.query, {
      personId: member.personId,
      formObject: FORM,
      formId: form.id,
      recordObject: "person",
      recordId: member.personId,
      madeFor: `test:${unique("page")}`,
      days: 7,
      now,
    });
    if (!("id" in made)) throw new Error("no link");
    const token = await linkToken(db.query, made.id, member.personId, now);
    const used = async () =>
      (
        await env.DB.prepare("SELECT used_at FROM core_intake_link WHERE id = ?")
          .bind(made.id)
          .first<{ used_at: string | null }>()
      )?.used_at ?? null;

    // Opened three times (the person, a mail scanner, a reload): the page each time, nothing used.
    let page = "";
    for (let i = 0; i < 3; i++) {
      const opened = await get(`/form?t=${token}`);
      expect(opened.status).toBe(200);
      expect(opened.headers.get("referrer-policy")).toBe("no-referrer");
      expect(opened.headers.get("content-security-policy") ?? "").not.toMatch(/https?:/);
      page = await opened.text();
      expect(page).not.toMatch(/<script[^>]*\ssrc=/);
      expect(page).not.toContain("challenges.cloudflare.com");
      expect(page).toContain("history.replaceState");
    }
    expect(await used()).toBeNull();
    expect(await submissionsOf(form.id)).toEqual([]);

    // The send uses it, as the link's Person, with no sign-in and no spam check.
    const sent = await post("/form", [...hidden(page), ["a.score", "3"]]);
    expect(sent.status).toBe(200);
    expect(sent.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await used()).not.toBeNull();
    const [answer, ...more] = await submissionsOf(form.id);
    expect(more).toEqual([]);
    expect(answer?.values).toMatchObject({
      person: member.personId,
      certainty: "link",
      via: "link",
    });

    // A second send by the same link (a new page's key), and opening it again: one plain answer.
    const second = await post("/form", [
      ...hidden(page).map(([k, v]): [string, string] => [
        k,
        k === "_key" ? crypto.randomUUID() : v,
      ]),
      ["a.score", "1"],
    ]);
    expect(second.status).toBe(404);
    expect(await second.text()).toContain("This link cannot be used");
    expect((await get(`/form?t=${token}`)).status).toBe(404);
    expect(await submissionsOf(form.id)).toHaveLength(1);
  });
});
