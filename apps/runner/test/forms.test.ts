// Stage 29 step 3 (ADR 0726): the Forms pack (packs/forms) in the real host, its tools run in the
// sandbox, installed the way a product that lists the pack installs it, with real D1. Ticketing is
// installed beside it for a pack-role account (its door role).
//
// What it shows: a signed-in member finds a form by its address and sends answers, kept as one
// submission linked to their Person; a visitor finds a public form, and with no Turnstile secret
// on this runner their answers are refused and the admins told (criterion 8); staff enter answers
// (certainty staff) and cannot tick "keep me updated" for someone (criterion 16); the inbox moves;
// spam is markSpam's and notSpam's, which the assistant may only ask for (ADR 0552); opening a form
// is a person's; a pack-role account reads no form or submission (criterion 17, record reads).
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type CustomerPrincipal,
  type ExtensionHost,
  getObject,
  type InvocationContext,
  invokeByName,
  type OutsideInvocationContext,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, db, host, unique } from "./helpers.ts";

const packFiles = (sources: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(sources)
      .map(([path, text]) => [path.split("/").pop() as string, text] as const)
      .filter(([name]) => name !== "vitest.config.ts"),
  );
const files: Record<string, Record<string, string>> = {
  forms: packFiles(
    import.meta.glob<string>("../../../packs/forms/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
  ticketing: packFiles(
    import.meta.glob<string>("../../../packs/ticketing/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
};

/** The extension host of a deployment whose product lists Forms and Ticketing. */
const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [
    ...(await host.shipped()),
    { id: "forms", version: "0.1.0" },
    { id: "ticketing", version: "0.1.0" },
  ],
  commitShipped: (id) =>
    files[id]
      ? host.commit({
          id,
          files: files[id],
          message: `Shipped ${id}`,
          author: { name: "Composable OS", email: "release@composableos.dev" },
        })
      : host.commitShipped(id),
};

const FORM = "forms.form";
const SUBMISSION = "forms.submission";

let admin: ActingUser;
let door: ActingUser;
let member: CustomerPrincipal;
let memberEmail: string;

const staff = (user: ActingUser, extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user,
  origin: { surface: "ui" },
  db,
  extensionHost: shippedHost,
  ...extra,
});
const outside = (principal: CustomerPrincipal | { kind: "public" }): OutsideInvocationContext => ({
  principal,
  db,
  extensionHost: shippedHost,
});

function run<T = Record<string, unknown>>(
  name: string,
  input: unknown,
  ctx: InvocationContext | OutsideInvocationContext,
): Promise<T> {
  return invokeByName(name, input, ctx) as Promise<T>;
}

/** What a call was refused with: its code and the host's details (unwrapped from a tool's). */
async function refusal(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    const e = error as { code?: string; details?: Record<string, unknown> };
    const inner = (e.details?.details ?? e.details) as Record<string, unknown> | undefined;
    return { code: e.code, inner: e.details?.code, details: inner };
  }
  throw new Error("expected a refusal");
}

const questions = {
  items: [
    { kind: "text", key: "name", label: "Name", map: { to: "person", field: "name" } },
    {
      kind: "email",
      key: "email",
      label: "Email",
      required: true,
      map: { to: "person", field: "email" },
    },
    { kind: "text", key: "message", label: "What would you like to know?", long: true },
    { kind: "rating", key: "score", label: "How was it?", scale: "stars" },
    { kind: "consent", key: "news", words: "Keep me updated by email", purpose: "marketing" },
  ],
};

/** A published, open form, as a person makes it in the admin. */
async function makeForm(values: Record<string, unknown> = {}) {
  const form = await run<{ id: string; values: Record<string, unknown> }>(
    "record.create",
    { object: FORM, values: { title: unique("Ask about a trial"), questions, ...values } },
    staff(admin),
  );
  await run(
    "record.update",
    { object: FORM, id: form.id, values: { status: "open" } },
    staff(admin),
  );
  await run("record.publish", { object: FORM, id: form.id }, staff(admin));
  const read = await run<{ values: Record<string, unknown> }>(
    "record.get",
    { object: FORM, id: form.id },
    staff(admin),
  );
  return { id: form.id, slug: String(read.values.slug) };
}

async function submissionsOf(form: string) {
  const page = await run<{ items: { id: string; values: Record<string, unknown> }[] }>(
    "record.list",
    { object: SUBMISSION, filter: { field: "form", op: "eq", value: form }, limit: 50 },
    staff(admin),
  );
  return page.items;
}

beforeAll(async () => {
  admin = await createAdmin();
  await run("extension.install", { id: "forms", shipped: true }, staff(admin));
  await run("extension.install", { id: "ticketing", shipped: true }, staff(admin));
  await refreshSchemaRegistry(db.query);
  memberEmail = `${unique("member")}@example.com`.toLowerCase();
  const person = await run<{ id: string }>(
    "person.create",
    { givenName: "Mel", familyName: "Member", emails: [{ email: memberEmail }] },
    staff(admin),
  );
  const customerId = `cus_${unique("m")}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_customer (id, person_id, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(customerId, person.id, memberEmail, now, now)
    .run();
  member = { kind: "customer", customerId, personId: person.id };
  const doorId = `usr_${unique("door")}`;
  await env.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, role) VALUES (?, 'Coach Kim', ?, 1, ?, ?, 'member')",
  )
    .bind(doorId, `${unique("door")}@example.com`, now, now)
    .run();
  door = { id: doorId, email: "", name: "Coach Kim", role: "member" };
  await run("user.setPackRole", { id: door.id, role: "ticketing.door" }, staff(admin));
}, 120_000);

afterAll(() => setPreset("balanced"));

describe("the pack in a product", () => {
  it("is installed as shipped with its form and submission objects", async () => {
    const row = await env.DB.prepare("SELECT source, status FROM core_extensions WHERE id = ?")
      .bind("forms")
      .first();
    expect(row).toEqual({ source: "shipped", status: "active" });
    expect(getObject(FORM)?.intake?.role).toBe("form");
    expect(getObject(SUBMISSION)?.intake?.role).toBe("submission");
  });
});

describe("answering a form", () => {
  it("a signed-in member opens it by its address and sends answers, kept as one submission", async () => {
    const form = await makeForm({ answeredBy: "customers", title: unique("Members' survey") });
    const opened = await run<{
      id: string;
      version: number;
      title: string;
      questions: { items: unknown[] };
      turnstile: boolean;
      shown: string | null;
    }>("x.forms.form", { slug: form.slug }, outside(member));
    expect(opened).toMatchObject({ id: form.id, version: 1, turnstile: false, shown: null });
    expect(opened.questions.items).toHaveLength(questions.items.length);

    const sent = await run(
      "x.forms.submit",
      {
        id: opened.id,
        version: opened.version,
        answers: { email: memberEmail, score: 5, news: true, message: "Loved it" },
        via: "app",
      },
      outside(member),
    );
    expect(sent).toEqual({ received: true });
    const [one, ...more] = await submissionsOf(form.id);
    expect(more).toEqual([]);
    expect(one?.values).toMatchObject({
      person: member.personId,
      certainty: "account",
      via: "app",
      rating: 5,
      marketing: true,
      status: "new",
      version: 1,
    });

    // The member reads none of it, not even their own (no customer declaration).
    expect(
      (await refusal(run("my.list", { object: SUBMISSION }, outside(member)))).code,
    ).toBeDefined();
  });

  it("a visitor finds a public form; with no Turnstile secret its answers are refused, admins told", async () => {
    const form = await makeForm();
    const opened = await run<{ id: string; version: number; turnstile: boolean }>(
      "x.forms.form",
      { slug: form.slug },
      outside({ kind: "public" }),
    );
    expect(opened).toMatchObject({ id: form.id, turnstile: true });
    const refused = await refusal(
      run(
        "x.forms.submit",
        {
          id: opened.id,
          version: opened.version,
          answers: { email: "visitor@example.com" },
          turnstileToken: "any",
        },
        outside({ kind: "public" }),
      ),
    );
    expect(refused.details).toMatchObject({ rule: "intake_unavailable" });
    expect(await submissionsOf(form.id)).toEqual([]);
    const told = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_notifications WHERE user_id = ? AND dedupe_key LIKE 'intake.turnstile_unset:%'",
    )
      .bind(admin.id)
      .first<{ n: number }>();
    expect(Number(told?.n)).toBe(1);
  });

  it("a draft, a members' form and an unknown address are one not-found for the public", async () => {
    const members = await makeForm({ answeredBy: "customers" });
    const draft = await run<{ id: string }>(
      "record.create",
      { object: FORM, values: { title: unique("Draft"), questions } },
      staff(admin),
    );
    const slugOf = async (id: string) =>
      String(
        (
          await run<{ values: Record<string, unknown> }>(
            "record.get",
            { object: FORM, id },
            staff(admin),
          )
        ).values.slug,
      );
    for (const slug of [members.slug, await slugOf(draft.id), "no-such-form"]) {
      const refused = await refusal(run("x.forms.form", { slug }, outside({ kind: "public" })));
      expect(refused.inner ?? refused.code, slug).toBe("not_found");
      expect(JSON.stringify(refused)).not.toContain("rec_");
    }
  });
});

describe("staff and the inbox", () => {
  it("staff enter answers: certainty staff, and only the person ticks 'keep me updated'", async () => {
    const form = await makeForm({ answeredBy: "staff", kind: "staff", title: unique("Incident") });
    const email = `${unique("caller")}@example.com`;
    await run(
      "x.forms.enter",
      { formId: form.id, answers: { email, name: "Cal Caller", message: "Rolled an ankle" } },
      staff(admin),
    );
    const [entered] = await submissionsOf(form.id);
    expect(entered?.values).toMatchObject({ certainty: "staff", via: "staff", marketing: false });

    const ticked = await refusal(
      run("x.forms.enter", { formId: form.id, answers: { email, news: true } }, staff(admin)),
    );
    expect(JSON.stringify(ticked)).toContain("Only the person may tick this");
    // And no staff write makes a submission, or marks one.
    expect(
      (
        await refusal(
          run(
            "record.update",
            { object: SUBMISSION, id: entered?.id, values: { marketing: true } },
            staff(admin),
          ),
        )
      ).details,
    ).toMatchObject({ rule: "intake_host_only" });
    expect(
      (
        await refusal(
          run("record.create", { object: SUBMISSION, values: { form: form.id } }, staff(admin)),
        )
      ).details,
    ).toMatchObject({ rule: "intake_host_only" });
  });

  it("moves a submission through the inbox; spam is markSpam's, which an AI only asks for", async () => {
    const form = await makeForm({ answeredBy: "staff" });
    await run(
      "x.forms.enter",
      { formId: form.id, answers: { email: `${unique("p")}@example.com` } },
      staff(admin),
    );
    const [submission] = await submissionsOf(form.id);
    const id = String(submission?.id);
    expect(await run("x.forms.move", { submissionId: id, to: "inHand" }, staff(admin))).toEqual({
      id,
      status: "inHand",
    });
    // Two people at once: one moves it, the other is told.
    expect(
      (
        await refusal(
          run("x.forms.move", { submissionId: id, to: "done", from: "new" }, staff(admin)),
        )
      ).inner ?? "",
    ).toBe("conflict");
    // No plain write moves it into spam: the move is the host's and markSpam's only.
    expect(
      (
        await refusal(
          run(
            "record.update",
            { object: SUBMISSION, id, values: { status: "spam" } },
            staff(admin),
          ),
        )
      ).code,
    ).toBe("invalid_input");
    await setPreset("autonomous");
    try {
      const asked = await refusal(
        run("x.forms.markSpam", { submissionId: id }, staff(admin, { actor: "assistant" })),
      );
      expect(asked.code).toBe("pending_approval");
    } finally {
      await setPreset("balanced");
    }
    expect(
      (
        await run<{ values: Record<string, unknown> }>(
          "record.get",
          { object: SUBMISSION, id },
          staff(admin),
        )
      ).values.status,
    ).toBe("inHand");
    expect(await run("x.forms.markSpam", { submissionId: id }, staff(admin))).toEqual({
      id,
      status: "spam",
    });
    expect(await run("x.forms.notSpam", { submissionId: id }, staff(admin))).toEqual({
      id,
      status: "new",
    });
  });

  it("the assistant cannot close, delay, throttle or move a published form without a person", async () => {
    const form = await makeForm();
    await setPreset("autonomous");
    try {
      for (const values of [
        { closesAt: "2000-01-01T00:00:00.000Z" },
        { opensAt: "2999-01-01T00:00:00.000Z" },
        { dailyCap: 1 },
        { slug: `${form.slug}-moved` },
      ]) {
        const asked = await refusal(
          run(
            "record.update",
            { object: FORM, id: form.id, values },
            staff(admin, { actor: "assistant" }),
          ),
        );
        expect(asked.code, JSON.stringify(values)).toBe("pending_approval");
      }
    } finally {
      await setPreset("balanced");
    }
    // Nothing changed: the public still answers it at its address.
    expect(
      await run<{ id: string }>("x.forms.form", { slug: form.slug }, outside({ kind: "public" })),
    ).toMatchObject({ id: form.id });
  });

  it("opening a form is a person's: the assistant's write of its status waits", async () => {
    const draft = await run<{ id: string }>(
      "record.create",
      { object: FORM, values: { title: unique("Kids' classes"), questions } },
      staff(admin),
    );
    await setPreset("autonomous");
    try {
      const asked = await refusal(
        run(
          "record.update",
          { object: FORM, id: draft.id, values: { status: "open" } },
          staff(admin, { actor: "assistant" }),
        ),
      );
      expect(asked.code).toBe("pending_approval");
    } finally {
      await setPreset("balanced");
    }
  });
});

describe("who reads it (criterion 17)", () => {
  it("a pack-role account reads no form or submission", async () => {
    const form = await makeForm({ answeredBy: "staff" });
    await run(
      "x.forms.enter",
      { formId: form.id, answers: { email: `${unique("q")}@example.com`, score: 1 } },
      staff(admin),
    );
    for (const object of [FORM, SUBMISSION]) {
      const refused = await refusal(run("record.list", { object }, staff(door)));
      expect(refused.code, object).toBe("forbidden");
    }
    const [submission] = await submissionsOf(form.id);
    expect(
      (await refusal(run("record.get", { object: SUBMISSION, id: submission?.id }, staff(door))))
        .code,
    ).toBe("forbidden");
    expect(
      (
        await refusal(
          run("x.forms.move", { submissionId: submission?.id, to: "done" }, staff(door)),
        )
      ).code,
    ).toBe("forbidden");
  });
});
