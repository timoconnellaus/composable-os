// Stage 29 step 5 (ADRs 0723 and 0724) on the shipped packs: Forms beside Bookings and
// Memberships in the real host and sandbox, the automations bound to a real email-send connection
// whose Email Service is the fake outbox.
//
// What it shows (criteria 13, 14 and 15): a member ticked as come is emailed, after the set
// minutes, a personal link to the gym's feedback form, at most once a month; a child's goes to
// their guardian and never to the child's own address; the link opens its form without signing
// in (and opening it uses nothing), answers it once as the member, tied to the booking, and is then
// one refusal, the same as an unknown token; two answers racing by one link keep one (proof a); a
// link for one Person and form cannot answer another form, nor as anyone else (proof b); a member
// who stopped follow-ups, or whose address is suppressed, is not asked (proof c); the same link is
// "Needs your attention" in My account and goes once answered; the receipt goes to a signed-in
// member's own address once per answers, never for answers staff entered, and the fourth in a day
// to one mailbox is not sent.
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  addressHash,
  type CustomerPrincipal,
  type EventSink,
  type ExtensionHost,
  ensureLink,
  type InvocationContext,
  type OutsideInvocationContext,
  prepareRoutineMail,
  queueEventSink,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runMomentDateRelative } from "../src/automations/schedule.ts";
import { integrationRuntime } from "../src/integrations/runtime.ts";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, db, host, newCustomer, refusal, run, unique } from "./helpers.ts";
import { packFiles } from "./pack-files.ts";

const integrations = integrationRuntime(env);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ZONE = "Australia/Sydney";
const SITE = "https://gym.example";
const FORM = "forms.form";
const SUBMISSION = "forms.submission";
const BOOKING = "bookings.booking";
const CLASS = "bookings.class";
const PACKS = ["bookings", "memberships", "forms"];

const files = Object.fromEntries(PACKS.map((id) => [id, packFiles(id)]));
const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [
    ...(await host.shipped()).filter((s) => !PACKS.includes(s.id)),
    ...PACKS.map((id) => ({ id, version: "0.1.0" })),
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

let introspector: Awaited<ReturnType<typeof introspectWorkflow>>;
let admin: ActingUser;
const sink: EventSink = queueEventSink(env.AUTOMATION_EVENTS);
const staff = (extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user: admin,
  origin: { surface: "ui" },
  db,
  integrations,
  extensionHost: shippedHost,
  events: sink,
  ...extra,
});
const outside = (principal: CustomerPrincipal | { kind: "public" }): OutsideInvocationContext => ({
  principal,
  db,
  integrations,
  extensionHost: shippedHost,
  events: sink,
});
const PUBLIC = { kind: "public" } as const;
const create = async (object: string, values: Record<string, unknown>) =>
  (await run<{ id: string }>("record.create", { object, values }, staff())).id;
const get = async (object: string, id: string) =>
  (await run<{ values: Record<string, unknown> }>("record.get", { object, id }, staff())).values;

interface Sent {
  to: string[];
  subject: string;
  text?: string;
  headers?: Record<string, string>;
}
async function mailTo(address: string): Promise<Sent[]> {
  const all = (await env.TEST_EMAIL_OUTBOX.list()) as Sent[];
  return all.filter((m) => m.to.includes(address.toLowerCase()));
}
async function mailsOnce(address: string, count: number): Promise<Sent[]> {
  await vi.waitFor(async () => expect(await mailTo(address)).toHaveLength(count), {
    timeout: 30_000,
    interval: 200,
  });
  return mailTo(address);
}

const TERMINAL = ["completed", "failed", "skipped", "cancelled", "expired"];
async function finished(automation: string, recordId: string, count = 1) {
  await vi.waitFor(
    async () => {
      const rows = await env.DB.prepare(
        "SELECT status FROM core_automation_runs WHERE automation_id = ? AND record_id = ? AND test = 0",
      )
        .bind(automation, recordId)
        .all<{ status: string }>();
      expect(rows.results.length).toBeGreaterThanOrEqual(count);
      expect(rows.results.map((r) => r.status).filter((s) => !TERMINAL.includes(s))).toEqual([]);
    },
    { timeout: 30_000, interval: 200 },
  );
}

/** The personal link's token in an email's words (on the business's site). */
function tokenIn(mail: Sent | undefined): string {
  const found = /https:\/\/gym\.example\/form\?t=([A-Za-z0-9_-]{43})/.exec(mail?.text ?? "");
  expect(found, mail?.text).not.toBeNull();
  return (found as RegExpExecArray)[1] as string;
}

const feedbackQuestions = {
  items: [
    { kind: "rating", key: "score", label: "How was the class?", scale: "stars", required: true },
    { kind: "text", key: "why", label: "Anything to tell us?", long: true },
    { kind: "email", key: "email", label: "Email", map: { to: "person", field: "email" } },
  ],
};

/** A published, open form, as a person makes it in the admin. */
async function makeForm(values: Record<string, unknown>) {
  const id = await create(FORM, { title: unique("Form"), questions: feedbackQuestions, ...values });
  await run("record.update", { object: FORM, id, values: { status: "open" } }, staff());
  await run("record.publish", { object: FORM, id }, staff());
  return { id, slug: String((await get(FORM, id)).slug) };
}

async function submissionsOf(form: string) {
  const page = await run<{ items: { id: string; values: Record<string, unknown> }[] }>(
    "record.list",
    { object: SUBMISSION, filter: { field: "form", op: "eq", value: form }, limit: 50 },
    staff(),
  );
  return page.items;
}

async function member(label: string): Promise<CustomerPrincipal & { email: string }> {
  const { principal, email } = await newCustomer(staff(), label);
  return { ...principal, email };
}

async function givePass(personId: string): Promise<void> {
  const type = await create("memberships.passtype", {
    title: unique("Pack "),
    price: 50,
    uses: 10,
    validDays: 60,
    status: "on_sale",
  });
  await run(
    "x.memberships.givePass",
    { personId, passTypeId: type, reason: "Integration test" },
    staff(),
  );
}

let classType: string;
let feedback: { id: string; slug: string };

/** A class starting in half an hour, a booking on it for `personId`, ticked as come by staff. */
async function cameTo(
  who: CustomerPrincipal,
  forPersonId?: string,
): Promise<{ bookingId: string; markedAt: number }> {
  const startsAt = new Date(Date.now() + 30 * MINUTE).toISOString();
  const klass = await create(CLASS, {
    classType,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + HOUR).toISOString(),
    timezone: ZONE,
    places: 10,
  });
  const out = await run<{ result: string; bookingId: string }>(
    "x.bookings.book",
    { classId: klass, ...(forPersonId ? { forPersonId } : {}) },
    outside(who),
  );
  expect(out.result).toBe("booked");
  const ticked = await run<{ result: string }>(
    "x.bookings.markAttended",
    { bookingId: out.bookingId },
    staff(),
  );
  expect(ticked.result).toBe("attended");
  const markedAt = Date.parse(String((await get(BOOKING, out.bookingId)).markedAt));
  return { bookingId: out.bookingId, markedAt };
}

/** The minute scan at the feedback's moment (3 hours after the tick), then its run finished. */
async function feedbackDue(booking: { bookingId: string; markedAt: number }) {
  await runMomentDateRelative(env, new Date(booking.markedAt + 180 * MINUTE));
  await finished("bookings.feedbackAfterClass", booking.bookingId);
}

beforeAll(async () => {
  introspector = await introspectWorkflow(env.AUTOMATION_WORKFLOW);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
  admin = await createAdmin();
  await setPreset("autonomous");
  for (const id of PACKS) await run("extension.install", { id, shipped: true }, staff());
  await refreshSchemaRegistry(db.query);
  await run("settings.update", { timezone: ZONE }, staff()).catch(() => undefined);
  await run("integration.setVendor", { vendor: "email-send", enabled: true }, staff());
  const mail = await run<{ connection: { id: string } }>(
    "connection.create",
    { vendor: "email-send", scope: "org" },
    staff(),
  );
  await run(
    "connection.bindResource",
    { id: mail.connection.id, url: `email-send://sender/${encodeURIComponent("gym@example.com")}` },
    staff(),
  );
  // Routine email turned on by a human admin (ADR 0590, D1), with the gym's own site.
  await run(
    "routineMail.settings.update",
    { packs: { bookings: true, forms: true }, siteOrigin: SITE, senderName: "Gym Co" },
    staff(),
  );
  for (const id of ["bookings.feedbackAfterClass", "forms.receipt"]) {
    await run(
      "automation.bindConnection",
      { id, slot: "mail", connectionId: mail.connection.id },
      staff(),
    );
  }
  classType = await create("bookings.classtype", { name: unique("Strength") });
  feedback = await makeForm({ answeredBy: "links", kind: "feedback", receipt: false });
  await run(
    "extensionSettings.update",
    { extension: "bookings", values: { feedbackForm: feedback.slug } },
    staff(),
  );
}, 180_000);

afterAll(async () => {
  await setPreset("balanced");
  await introspector[Symbol.asyncDispose]();
});

describe("feedback after a class (criteria 13 and 14)", { timeout: 90_000 }, () => {
  it("asks once, by a link that opens the form, answers it once as the member, tied to the booking", async () => {
    const who = await member("came");
    await givePass(who.personId);
    const booking = await cameTo(who);
    // Before the moment: nothing.
    await runMomentDateRelative(env, new Date(booking.markedAt + 170 * MINUTE));
    expect(await mailTo(who.email)).toEqual([]);
    await feedbackDue(booking);
    const [mail, ...more] = await mailsOnce(who.email, 1);
    expect(more).toEqual([]);
    expect(mail?.subject).toMatch(/^How was /);
    // A follow-up: it ends with its one-tap stop, which the gatekeeper sends as the header too.
    expect(mail?.text).toContain("To stop getting these emails:");
    const token = tokenIn(mail);

    // Opening it (a mail scanner, the page) names nothing of the member and uses nothing.
    for (let i = 0; i < 3; i++) {
      const opened = await run<Record<string, unknown>>(
        "x.forms.form",
        { link: token },
        outside(PUBLIC),
      );
      expect(opened).toMatchObject({ id: feedback.id, turnstile: false, shown: null });
      expect(JSON.stringify(opened)).not.toContain(who.email);
      expect(JSON.stringify(opened)).not.toContain(who.personId);
    }

    // Answered with no account, no Turnstile token: the member's, once, tied to the booking. An
    // address typed into the form does not choose whose the answers are.
    const other = await member("other");
    expect(
      await run(
        "x.forms.submit",
        {
          id: feedback.id,
          version: 1,
          answers: { score: 4, why: "Great", email: other.email },
          link: token,
        },
        outside(PUBLIC),
      ),
    ).toEqual({ received: true });
    const [answer, ...others] = await submissionsOf(feedback.id);
    expect(others).toEqual([]);
    expect(answer?.values).toMatchObject({
      person: who.personId,
      certainty: "link",
      via: "link",
      rating: 4,
      about: booking.bookingId,
      aboutObject: BOOKING,
    });

    // A second use, and an unknown token, are one answer.
    const again = await refusal(
      run(
        "x.forms.submit",
        { id: feedback.id, version: 1, answers: { score: 1 }, link: token },
        outside(PUBLIC),
      ),
    );
    const unknown = await refusal(
      run(
        "x.forms.submit",
        { id: feedback.id, version: 1, answers: { score: 1 }, link: "A".repeat(43) },
        outside(PUBLIC),
      ),
    );
    const opened = await refusal(run("x.forms.form", { link: token }, outside(PUBLIC)));
    for (const r of [again, unknown, opened]) {
      expect(r.message).toContain("This link cannot be used");
      expect(JSON.stringify(r)).not.toContain(token);
    }
    expect(again.message).toBe(unknown.message);
    expect(await submissionsOf(feedback.id)).toHaveLength(1);

    // No token in the audit log, nor in a run's record, nor in the sent email's row.
    const audit = await env.DB.prepare(
      `SELECT (SELECT count(*) FROM core_audit WHERE input LIKE ?1 OR result LIKE ?1 OR error LIKE ?1)
         + (SELECT count(*) FROM core_automation_runs WHERE steps LIKE ?1 OR error LIKE ?1)
         + (SELECT count(*) FROM core_routine_mail WHERE body LIKE ?1) AS n`,
    )
      .bind(`%${token}%`)
      .first<{ n: number }>();
    expect(Number(audit?.n)).toBe(0);
  });

  it("asks a member at most once a month, and not again about the same class", async () => {
    const who = await member("monthly");
    await givePass(who.personId);
    const first = await cameTo(who);
    await feedbackDue(first);
    await mailsOnce(who.email, 1);
    // The same moment again (a second tick of the minute): nothing more.
    await runMomentDateRelative(env, new Date(first.markedAt + 181 * MINUTE));
    const second = await cameTo(who);
    await feedbackDue(second);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await mailTo(who.email)).toHaveLength(1);
  });

  it("a child's goes to their guardian, never to the child's own address", async () => {
    const parent = await member("parent");
    const childEmail = `${unique("kid")}@members.test`.toLowerCase();
    const child = await run<{ id: string }>(
      "person.create",
      { givenName: "Robin", emails: [{ email: childEmail }] },
      staff(),
    );
    await run("person.link.add", { guardianId: parent.personId, dependantId: child.id }, staff());
    await givePass(child.id);
    const booking = await cameTo(parent, child.id);
    await feedbackDue(booking);
    const [mail] = await mailsOnce(parent.email, 1);
    expect(mail?.subject).toMatch(/\(Robin\)$/);
    expect(await mailTo(childEmail)).toEqual([]);
    const token = tokenIn(mail);
    // The answers are the child's (the link's Person), sent by the guardian.
    await run(
      "x.forms.submit",
      { id: feedback.id, version: 1, answers: { score: 5 }, link: token },
      outside(PUBLIC),
    );
    const mine = (await submissionsOf(feedback.id)).filter(
      (s) => s.values.about === booking.bookingId,
    );
    expect(mine.map((s) => s.values.person)).toEqual([child.id]);
  });
});

describe("the link is used once (criterion 13, proof a)", { timeout: 90_000 }, () => {
  it("two answers at once by one link: the database keeps exactly one", async () => {
    const who = await member("racing");
    await givePass(who.personId);
    const booking = await cameTo(who);
    await feedbackDue(booking);
    const token = tokenIn((await mailsOnce(who.email, 1))[0]);
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        run(
          "x.forms.submit",
          { id: feedback.id, version: 1, answers: { score: 1 + i }, link: token },
          outside(PUBLIC),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") expect(String(r.reason?.message)).toContain("cannot be used");
    }
    const kept = (await submissionsOf(feedback.id)).filter(
      (s) => s.values.about === booking.bookingId,
    );
    expect(kept).toHaveLength(1);
  });
});

describe("a link answers only its own form, as its own Person (proof b)", {
  timeout: 90_000,
}, () => {
  it("cannot answer another form, nor be used by a signed-in stranger by its id", async () => {
    const who = await member("bound");
    await givePass(who.personId);
    const booking = await cameTo(who);
    await feedbackDue(booking);
    const token = tokenIn((await mailsOnce(who.email, 1))[0]);
    const elsewhere = await makeForm({ answeredBy: "public", title: unique("Enquiry") });
    const wrongForm = await refusal(
      run(
        "x.forms.submit",
        { id: elsewhere.id, version: 1, answers: { score: 3 }, link: token },
        outside(PUBLIC),
      ),
    );
    expect(wrongForm.message).toContain("This link cannot be used");
    expect(await submissionsOf(elsewhere.id)).toEqual([]);

    // The link's id is the signed-in member's alone (their Needs your attention item).
    const { items } = await run<{ items: { kind: string; link: string | null }[] }>(
      "me.attention",
      {},
      outside(who),
    );
    const item = items.find((i) => i.kind === "form_to_fill");
    expect(item?.link).toBeTruthy();
    const stranger = await member("stranger");
    const byId = { linkId: item?.link, id: feedback.id, version: 1, answers: { score: 2 } };
    const refused = await refusal(run("x.forms.submitLinked", byId, outside(stranger)));
    expect(refused.message).toContain("This link cannot be used");
    // The public has no way to name a link by its id at all (not in its contract).
    expect((await refusal(run("x.forms.submitLinked", byId, outside(PUBLIC)))).code).toBeDefined();
    expect((await refusal(run("x.forms.submit", byId, outside(PUBLIC)))).code).toBeDefined();
    // And the link still works for its own member: the attention item answers it, then goes.
    await run(
      "x.forms.submitLinked",
      { linkId: item?.link, id: feedback.id, version: 1, answers: { score: 5 } },
      outside(who),
    );
    const kept = (await submissionsOf(feedback.id)).filter(
      (s) => s.values.about === booking.bookingId,
    );
    expect(kept.map((s) => [s.values.person, s.values.certainty])).toEqual([
      [who.personId, "link"],
    ]);
    const after = await run<{ items: { kind: string }[] }>("me.attention", {}, outside(who));
    expect(after.items.filter((i) => i.kind === "form_to_fill")).toEqual([]);
    // The email's token is used up too: one link, answered either way.
    expect(
      (
        await refusal(
          run(
            "x.forms.submit",
            { id: feedback.id, version: 1, answers: { score: 1 }, link: token },
            outside(PUBLIC),
          ),
        )
      ).message,
    ).toContain("This link cannot be used");
  });
});

describe("nobody who stopped is asked (proof c)", { timeout: 90_000 }, () => {
  it("a member who stopped follow-ups by email, or whose address is suppressed, gets nothing", async () => {
    const stopped = await member("stopped");
    await givePass(stopped.personId);
    await run(
      "me.contact.setChoices",
      { choices: [{ scope: "follow_up", channel: "email", value: "off" }] },
      outside(stopped),
    );
    const suppressed = await member("suppressed");
    await givePass(suppressed.personId);
    await env.DB.prepare(
      "INSERT INTO core_contact_suppression (channel, value_hash, how, at) VALUES ('email', ?, 'provider_unsubscribed', ?)",
    )
      .bind(await addressHash(db.query, suppressed.email), new Date().toISOString())
      .run();
    for (const who of [stopped, suppressed]) {
      const booking = await cameTo(who);
      await feedbackDue(booking);
      const rows = await env.DB.prepare(
        "SELECT status FROM core_routine_mail WHERE kind = 'bookings.feedback' AND record_id = ?",
      )
        .bind(booking.bookingId)
        .all<{ status: string }>();
      expect(rows.results.map((r) => r.status)).toEqual(["stopped"]);
      // No link was made for them: nothing waits in the app either.
      const links = await env.DB.prepare(
        "SELECT count(*) AS n FROM core_intake_link WHERE record_id = ?",
      )
        .bind(booking.bookingId)
        .first<{ n: number }>();
      expect(Number(links?.n)).toBe(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await mailTo(stopped.email)).toEqual([]);
    expect(await mailTo(suppressed.email)).toEqual([]);
  });
});

describe("the receipt (criterion 15)", { timeout: 90_000 }, () => {
  it("goes to a signed-in member's own address with fixed words; the fourth in a day is not sent", async () => {
    const survey = await makeForm({ answeredBy: "customers", title: unique("Members' survey") });
    const who = await member("receipt");
    const typed = "Do not repeat this back";
    for (let i = 0; i < 4; i++) {
      await run(
        "x.forms.submit",
        { id: survey.id, version: 1, answers: { score: 3, why: typed }, via: "app" },
        outside(who),
      );
    }
    const submissions = await submissionsOf(survey.id);
    expect(submissions).toHaveLength(4);
    for (const s of submissions) await finished("forms.receipt", s.id);
    const mails = await mailsOnce(who.email, 3);
    for (const mail of mails) {
      // The business's name, from Settings → Routine email; the form's title; nothing typed.
      expect(mail.subject).toBe("Gym Co: we got your answers");
      expect(mail.text).toContain("Gym Co got your answers to");
      expect(mail.text).not.toContain(typed);
      expect(mail.text).not.toContain("Given-");
    }
    const statuses = await env.DB.prepare(
      "SELECT status FROM core_routine_mail WHERE kind = 'forms.receipt' AND recipient = ? ORDER BY created_at",
    )
      .bind(who.email)
      .all<{ status: string }>();
    expect(statuses.results.map((r) => r.status).filter((s) => s === "over_limit")).toHaveLength(1);
  });

  it("has a daily cap of its own: past it a receipt is not sent, and other routine email is not held", async () => {
    await run("routineMail.settings.update", { receiptDailyCap: 1 }, staff());
    try {
      const survey = await makeForm({ answeredBy: "customers", title: unique("Capped survey") });
      const who = await member("receiptcap");
      await run(
        "x.forms.submit",
        { id: survey.id, version: 1, answers: { score: 3 }, via: "app" },
        outside(who),
      );
      const [submission] = await submissionsOf(survey.id);
      await finished("forms.receipt", String(submission?.id));
      const row = await env.DB.prepare(
        "SELECT status, error, body FROM core_routine_mail WHERE kind = 'forms.receipt' AND record_id = ?",
      )
        .bind(submission?.id)
        .first();
      expect(row).toMatchObject({ status: "over_limit", body: null });
      expect(String(row?.error)).toMatch(/receipts went out today/);
      // Receipts do not count toward the routine email cap: a member's feedback still goes.
      const other = await member("notheld");
      await givePass(other.personId);
      const booking = await cameTo(other);
      await feedbackDue(booking);
      await mailsOnce(other.email, 1);
    } finally {
      await run("routineMail.settings.update", { receiptDailyCap: 200 }, staff());
    }
  });

  it("none for answers staff entered, nor for a form whose receipt is off", async () => {
    const desk = await makeForm({ answeredBy: "staff", title: unique("Phone enquiry") });
    const email = `${unique("caller")}@members.test`.toLowerCase();
    await run("x.forms.enter", { formId: desk.id, answers: { score: 3, email } }, staff());
    const quiet = await makeForm({
      answeredBy: "customers",
      title: unique("No receipt"),
      receipt: false,
    });
    const who = await member("quiet");
    await run("x.forms.submit", { id: quiet.id, version: 1, answers: { score: 3 } }, outside(who));
    for (const s of [...(await submissionsOf(desk.id)), ...(await submissionsOf(quiet.id))]) {
      await finished("forms.receipt", s.id);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await mailTo(email)).toEqual([]);
    expect(await mailTo(who.email)).toEqual([]);
  });
});

describe("erase and merge (what a link table needs now)", { timeout: 90_000 }, () => {
  it("erase deletes a Person's links; merge moves a live one to the survivor", async () => {
    const who = await member("erased");
    await givePass(who.personId);
    const booking = await cameTo(who);
    await feedbackDue(booking);
    const token = tokenIn((await mailsOnce(who.email, 1))[0]);
    await run("person.erase", { id: who.personId }, staff());
    const left = await env.DB.prepare(
      "SELECT (SELECT count(*) FROM core_intake_link WHERE person_id = ?) AS links, (SELECT count(*) FROM core_intake_link_token t WHERE NOT EXISTS (SELECT 1 FROM core_intake_link l WHERE l.id = t.link_id)) AS orphans",
    )
      .bind(who.personId)
      .first<{ links: number; orphans: number }>();
    expect(left).toEqual({ links: 0, orphans: 0 });
    const refused = await refusal(
      run(
        "x.forms.submit",
        { id: feedback.id, version: 1, answers: { score: 1 }, link: token },
        outside(PUBLIC),
      ),
    );
    expect(refused.message).toContain("This link cannot be used");

    const dup = await member("dup");
    await givePass(dup.personId);
    // The survivor has no account of their own (two accounts are not merged).
    const kept = {
      personId: (await run<{ id: string }>("person.create", { givenName: "Kept" }, staff())).id,
    };
    const theirs = await cameTo(dup);
    await feedbackDue(theirs);
    const dupToken = tokenIn((await mailsOnce(dup.email, 1))[0]);
    await run("person.merge", { survivorId: kept.personId, mergedId: dup.personId }, staff());
    await run(
      "x.forms.submit",
      { id: feedback.id, version: 1, answers: { score: 4 }, link: dupToken },
      outside(PUBLIC),
    );
    const answered = (await submissionsOf(feedback.id)).filter(
      (s) => s.values.about === theirs.bookingId,
    );
    expect(answered.map((s) => s.values.person)).toEqual([kept.personId]);
  });
});

// The review of PR #458, M1: a token is made only when its email goes on its own, and is never
// written to a row, an approval or a pending action's input.
describe("a personal link never waits for a person (the review's M1)", { timeout: 90_000 }, () => {
  /** Whatever the host kept that could hold a link: pending actions, the log, the audit. */
  async function nothingKeptHoldsALink() {
    const kept = await env.DB.batch([
      env.DB.prepare("SELECT * FROM core_pending_action"),
      env.DB.prepare("SELECT * FROM core_routine_mail"),
      env.DB.prepare("SELECT input, result, error FROM core_audit"),
    ]);
    const text = JSON.stringify(kept.map((r) => r.results));
    expect(text).not.toContain("/form?t=");
  }
  const linksAbout = async (bookingId: string) =>
    Number(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM core_intake_link WHERE record_id = ?")
          .bind(bookingId)
          .first<{ n: number }>()
      )?.n,
    );
  const rowsAbout = async (bookingId: string) =>
    (
      await env.DB.prepare(
        "SELECT status, error, body, form_link FROM core_routine_mail WHERE kind = 'bookings.feedback' AND record_id = ?",
      )
        .bind(bookingId)
        .all<{
          status: string;
          error: string | null;
          body: string | null;
          form_link: string | null;
        }>()
    ).results;

  it("with Bookings' routine email off: not sent for approval, failed with why, no link made", async () => {
    await run("routineMail.settings.update", { packs: { bookings: false } }, staff());
    try {
      const who = await member("routineoff");
      await givePass(who.personId);
      const booking = await cameTo(who);
      await feedbackDue(booking);
      const [row, ...more] = await rowsAbout(booking.bookingId);
      expect(more).toEqual([]);
      expect(row).toMatchObject({ status: "failed", body: null, form_link: null });
      expect(row?.error).toMatch(/turn routine email on/);
      expect(await linksAbout(booking.bookingId)).toBe(0);
      expect(await mailTo(who.email)).toEqual([]);
      // Nothing waits in the app either: an unsent link is no form_to_fill.
      const { items } = await run<{ items: { kind: string }[] }>("me.attention", {}, outside(who));
      expect(items.filter((i) => i.kind === "form_to_fill")).toEqual([]);
      await nothingKeptHoldsALink();
    } finally {
      await run("routineMail.settings.update", { packs: { bookings: true } }, staff());
    }
  });

  it("over a cap at the claim: failed, no link, nothing put to a person", async () => {
    await run("routineMail.settings.update", { orgDailyCap: 1 }, staff());
    try {
      const who = await member("capped");
      await givePass(who.personId);
      const booking = await cameTo(who);
      await feedbackDue(booking);
      const [row] = await rowsAbout(booking.bookingId);
      expect(row).toMatchObject({ status: "failed", body: null });
      expect(row?.error).toMatch(/would wait for a person/);
      expect(await linksAbout(booking.bookingId)).toBe(0);
      await nothingKeptHoldsALink();
    } finally {
      await run("routineMail.settings.update", { orgDailyCap: 2_000 }, staff());
    }
  });

  it("with no email connection: kept failed with no words", async () => {
    const who = await member("noconn");
    await givePass(who.personId);
    const booking = await cameTo(who);
    // A run of the feedback automation for the booking, prepared with no connection bound.
    const runId = unique("arn_");
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO core_automation_runs (id, automation_id, extension_id, trigger, record_object, record_id, status, test, started_at, updated_at) VALUES (?, 'bookings.feedbackAfterClass', 'bookings', '{\"type\":\"dateRelative\"}', ?, ?, 'running', 0, ?, ?)",
    )
      .bind(runId, BOOKING, booking.bookingId, now, now)
      .run();
    await prepareRoutineMail(db.query, {
      extensionId: "bookings",
      automationId: "bookings.feedbackAfterClass",
      runId,
      connectionId: "",
      send: { kind: "feedback", record: booking.bookingId, message: "ask" },
    });
    const [row] = await rowsAbout(booking.bookingId);
    expect(row).toMatchObject({ status: "failed", body: null, form_link: null });
    expect(await linksAbout(booking.bookingId)).toBe(0);
  });

  it("a feedback form must be one answered by personal link", async () => {
    const open = await makeForm({ answeredBy: "public", title: unique("Open feedback") });
    await run(
      "extensionSettings.update",
      { extension: "bookings", values: { feedbackForm: open.slug } },
      staff(),
    );
    try {
      const who = await member("publicform");
      await givePass(who.personId);
      const booking = await cameTo(who);
      await feedbackDue(booking);
      const [row] = await rowsAbout(booking.bookingId);
      expect(row).toMatchObject({ status: "failed", body: null });
      expect(row?.error).toMatch(/not one answered by personal link/);
      expect(await linksAbout(booking.bookingId)).toBe(0);
    } finally {
      await run(
        "extensionSettings.update",
        { extension: "bookings", values: { feedbackForm: feedback.slug } },
        staff(),
      );
    }
  });
});

// The review of PR #458, M2: a link answer's receipt goes to whoever the link's email went to.
describe("the receipt of a child's link (the review's M2)", { timeout: 90_000 }, () => {
  it("goes to the guardian, by token or signed in by its id; never to the child's own address", async () => {
    await run(
      "record.update",
      { object: FORM, id: feedback.id, values: { receipt: true } },
      staff(),
    );
    try {
      const parent = await member("m2parent");
      const childEmail = `${unique("m2kid")}@members.test`.toLowerCase();
      const child = await run<{ id: string }>(
        "person.create",
        { givenName: "Sam", emails: [{ email: childEmail }] },
        staff(),
      );
      await run("person.link.add", { guardianId: parent.personId, dependantId: child.id }, staff());
      await givePass(child.id);
      // By the token in the guardian's email.
      const first = await cameTo(parent, child.id);
      await feedbackDue(first);
      const token = tokenIn((await mailsOnce(parent.email, 1))[0]);
      await run(
        "x.forms.submit",
        { id: feedback.id, version: 1, answers: { score: 4 }, link: token },
        outside(PUBLIC),
      );
      const byToken = (await submissionsOf(feedback.id)).find(
        (s) => s.values.about === first.bookingId,
      );
      await finished("forms.receipt", String(byToken?.id));
      const receipts = await mailsOnce(parent.email, 2);
      expect(receipts[1]?.subject).toBe("Gym Co: we got your answers");
      // Signed in, by the item's id: a link a later class's email would carry.
      const second = await cameTo(parent, child.id);
      const made = await ensureLink(db.query, {
        personId: child.id,
        formObject: FORM,
        formId: feedback.id,
        recordObject: BOOKING,
        recordId: second.bookingId,
        madeFor: unique("bookings.feedback:by-hand"),
        days: 7,
        now: new Date().toISOString(),
      });
      expect("live" in made).toBe(true);
      const { items } = await run<{ items: { kind: string; link: string | null }[] }>(
        "me.attention",
        {},
        outside(parent),
      );
      const item = items.find(
        (i) => i.kind === "form_to_fill" && i.link === ("id" in made ? made.id : ""),
      );
      expect(item).toBeDefined();
      await run(
        "x.forms.submitLinked",
        { linkId: item?.link, id: feedback.id, version: 1, answers: { score: 5 } },
        outside(parent),
      );
      const byId = (await submissionsOf(feedback.id)).find(
        (s) => s.values.about === second.bookingId,
      );
      await finished("forms.receipt", String(byId?.id));
      await mailsOnce(parent.email, 3);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await mailTo(childEmail)).toEqual([]);
    } finally {
      await run(
        "record.update",
        { object: FORM, id: feedback.id, values: { receipt: false } },
        staff(),
      );
    }
  });
});
