// Stage 29 step 3 (ADR 0726): the Forms pack's own manifest (packs/forms) on the host's door, with
// real D1. A form is found by its address; a ticked "keep me updated" line is marked on the
// submission by the host, and only by it; the deployment's hourly cap is the pack's setting, a
// person's to change; a submission is titled after its form. Cloudflare's Turnstile is a stand-in
// fetch. apps/runner/test/forms.test.ts runs the pack's tools in the sandbox.
import { env } from "cloudflare:workers";
import { type Questions, toManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import forms from "../../../packs/forms/index.ts";
import {
  type ActingUser,
  type CustomerPrincipal,
  intakeRuntime,
  invoke,
  type OutsideInvocationContext,
  type PublicPrincipal,
} from "../src/index.ts";
import { call, outside } from "./customer-fixtures.ts";
import { reconcile } from "./extension-helpers.ts";
import { context, createUser, unique } from "./helpers.ts";

const FORM = "forms.form";
const SUBMISSION = "forms.submission";
const PUBLIC: PublicPrincipal = { kind: "public" };
const SECRET = "test-turnstile-secret";
const pack = toManifest(forms);

let admin: ActingUser;
let member: CustomerPrincipal;

const questions = (): Questions => ({
  items: [
    { kind: "text", key: "name", label: "Name", map: { to: "person", field: "name" } },
    {
      kind: "email",
      key: "email",
      label: "Email",
      required: true,
      map: { to: "person", field: "email" },
    },
    { kind: "rating", key: "keen", label: "How keen?", scale: "stars" },
    { kind: "consent", key: "news", words: "Keep me updated by email", purpose: "marketing" },
  ],
});

const turnstile = intakeRuntime(SECRET, async (_url, init) => {
  const body = init?.body as FormData;
  return Response.json({ success: body.get("secret") === SECRET && body.get("response") === "ok" });
});

let clockMs = Date.now() + 60_000;
const later = (ms: number) => {
  clockMs += ms;
  return new Date(clockMs);
};

const asCaller = (
  principal: CustomerPrincipal | PublicPrincipal,
  at: Date,
): OutsideInvocationContext =>
  outside(principal, {
    tool: { extension: "forms", tool: "submit" },
    intake: turnstile,
    clock: () => at,
  });

async function makeForm(values: Record<string, unknown> = {}) {
  const form = await invoke(
    "record.create",
    {
      object: FORM,
      values: { title: unique("Ask about a trial"), questions: questions(), ...values },
    },
    context(admin),
  );
  await invoke(
    "record.update",
    { object: FORM, id: form.id, values: { status: "open" } },
    context(admin),
  );
  await invoke("record.publish", { object: FORM, id: form.id }, context(admin));
  const row = await env.DB.prepare("SELECT slug FROM x_forms_form WHERE id = ?")
    .bind(form.id)
    .first<{ slug: string }>();
  return { id: form.id as string, slug: row?.slug as string };
}

/** Opens the form by its address as `principal`, then sends `answers` five seconds later. */
async function send(
  principal: CustomerPrincipal | PublicPrincipal,
  slug: string,
  answers: Record<string, unknown>,
) {
  const opened = await call("intake.open", { object: FORM, slug }, asCaller(principal, later(1)));
  if (!opened.ok) return opened;
  const { id, version, shown } = opened.value as { id: string; version: number; shown: string };
  return call(
    "intake.submit",
    {
      object: FORM,
      id,
      version,
      answers,
      via: "site",
      ...(principal.kind === "public" ? { turnstileToken: "ok", shown } : {}),
    },
    asCaller(principal, later(5000)),
  );
}

async function submissionsOf(form: string) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM x_forms_submission WHERE form = ? ORDER BY created_at",
  )
    .bind(form)
    .all<Record<string, unknown>>();
  return results;
}

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(pack);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES ('forms', 'shipped', 'active', ?, 'c1', ?, ?, ?, ?)",
  )
    .bind(pack.version, JSON.stringify(pack), admin.id, now, now)
    .run();
  const person = await invoke(
    "person.create",
    { givenName: "Mel", emails: [{ email: `${unique("member")}@example.com` }] },
    context(admin),
  );
  member = { kind: "customer", customerId: `cus_${unique("m")}`, personId: person.id };
});

describe("a form found by its address", () => {
  it("is opened by slug, and not found once closed, or for customers only, by the public", async () => {
    const { id, slug } = await makeForm();
    const opened = await call("intake.open", { object: FORM, slug }, asCaller(PUBLIC, later(1)));
    expect(opened).toMatchObject({ ok: true, value: { id, version: 1, turnstile: true } });

    const members = await makeForm({ answeredBy: "customers" });
    const refused = await call(
      "intake.open",
      { object: FORM, slug: members.slug },
      asCaller(PUBLIC, later(1)),
    );
    const unknown = await call(
      "intake.open",
      { object: FORM, slug: "no-such-form" },
      asCaller(PUBLIC, later(1)),
    );
    expect(refused).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(unknown).toMatchObject({ ok: false, error: { code: "not_found" } });
    // The same words whatever the reason, the address aside.
    const words = (o: typeof refused) => (o.ok ? null : String(o.error.message));
    expect(words(refused)?.replace(members.slug, "")).toBe(
      words(unknown)?.replace("no-such-form", ""),
    );
    expect(
      await call("intake.open", { object: FORM, slug: members.slug }, asCaller(member, later(1))),
    ).toMatchObject({ ok: true });

    await invoke(
      "record.update",
      { object: FORM, id, values: { status: "closed" } },
      context(admin),
    );
    expect(
      await call("intake.open", { object: FORM, slug }, asCaller(PUBLIC, later(1))),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("is still found by its old address after a person changes it (a printed QR code)", async () => {
    const { id, slug } = await makeForm();
    await invoke(
      "record.update",
      { object: FORM, id, values: { slug: `${slug}-new` } },
      context(admin),
    );
    await invoke("record.publish", { object: FORM, id }, context(admin));
    for (const address of [slug, `${slug}-new`]) {
      expect(
        await call("intake.open", { object: FORM, slug: address }, asCaller(PUBLIC, later(1))),
        address,
      ).toMatchObject({ ok: true, value: { id } });
    }
    // An old address of a form that no longer takes answers is not found, as its address now is.
    await invoke(
      "record.update",
      { object: FORM, id, values: { status: "closed" } },
      context(admin),
    );
    const closed = await call("intake.open", { object: FORM, slug }, asCaller(PUBLIC, later(1)));
    expect(closed).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(JSON.stringify(closed)).not.toContain(id);
  });

  it("is given by id or slug, not both", async () => {
    const { id, slug } = await makeForm();
    const both = await call("intake.open", { object: FORM, id, slug }, asCaller(PUBLIC, later(1)));
    expect(both).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});

describe("a submission to the Forms pack's form", () => {
  it("is titled after its form, keeps the rating and marks a ticked 'keep me updated'", async () => {
    const form = await makeForm({ title: unique("Trial") });
    const email = `${unique("visitor")}@example.com`;
    expect(
      await send(PUBLIC, form.slug, { name: "Vi Visitor", email, keen: 4, news: true }),
    ).toEqual({ ok: true, value: { received: true } });
    expect(await send(member, form.slug, { email: "m@example.com", news: false })).toMatchObject({
      ok: true,
    });
    const [ticked, unticked] = await submissionsOf(form.id);
    const title = await env.DB.prepare("SELECT title FROM x_forms_form WHERE id = ?")
      .bind(form.id)
      .first<{ title: string }>();
    expect(ticked).toMatchObject({
      title: title?.title,
      status: "new",
      certainty: "address",
      via: "site",
      rating: 4,
      marketing: 1,
      version: 1,
    });
    expect(unticked).toMatchObject({ certainty: "account", marketing: 0 });

    // Nobody but the host marks it, staff included.
    const staffWrite = invoke(
      "record.update",
      { object: SUBMISSION, id: String(unticked?.id), values: { marketing: true } },
      context(admin),
    );
    await expect(staffWrite).rejects.toMatchObject({ details: { rule: "intake_host_only" } });
  });

  it("is turned away over the pack's hourly cap, a setting a person approves", async () => {
    expect(pack.settings.hourlyCap).toMatchObject({ default: 200, personApproves: true });
    const form = await makeForm();
    const count = await env.DB.prepare(
      "SELECT count(*) AS n FROM x_forms_submission WHERE deleted_at IS NULL AND created_at > ?",
    )
      .bind(new Date(clockMs - 3_600_000).toISOString())
      .first<{ n: number }>();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO core_extension_settings (extension_id, value, updated_at) VALUES ('forms', ?, ?) ON CONFLICT (extension_id) DO UPDATE SET value = excluded.value",
    )
      .bind(JSON.stringify({ hourlyCap: Number(count?.n ?? 0) + 1 }), now)
      .run();
    const first = await send(PUBLIC, form.slug, { email: `${unique("a")}@example.com` });
    const second = await send(PUBLIC, form.slug, { email: `${unique("b")}@example.com` });
    expect(first).toEqual({ ok: true, value: { received: true } });
    expect(second).toMatchObject({
      ok: false,
      error: { code: "rate_limited", details: { rule: "intake_cap" } },
    });
    await env.DB.prepare("DELETE FROM core_extension_settings WHERE extension_id = 'forms'").run();
    expect(await send(PUBLIC, form.slug, { email: `${unique("c")}@example.com` })).toEqual({
      ok: true,
      value: { received: true },
    });
  });
});
