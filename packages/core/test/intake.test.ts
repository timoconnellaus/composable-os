// Stage 29 step 2 (ADRs 0720 to 0722 and 0725): the public-write door. A pack's tool sends answers
// to one of its published forms through `intake.submit`; the host checks the form, the spam check,
// the caps and the answers, and keeps one submission with the submitter's Person, as its own
// change, in one batch. Real D1, real bindings; Cloudflare's Turnstile is a stand-in fetch.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import {
  ANSWERS_SCHEMA,
  QUESTIONS_MAX_BYTES,
  QUESTIONS_SCHEMA,
  type Questions,
  validateManifest,
} from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type CustomerPrincipal,
  checkManifest,
  intakeRuntime,
  invoke,
  type OutsideInvocationContext,
  type PublicPrincipal,
} from "../src/index.ts";
import { erasedAddressHash } from "../src/records/erase-subject.ts";
import { call, outside } from "./customer-fixtures.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";

const EXT = extId("frm");
const FORM = `${EXT}.form`;
const SUBMISSION = `${EXT}.submission`;
const ENQUIRY = `${EXT}.enquiry`;
const PUBLIC: PublicPrincipal = { kind: "public" };
const SECRET = "test-turnstile-secret";

let admin: ActingUser;
let member: CustomerPrincipal;
let memberEmail: string;

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
    { kind: "phone", key: "phone", label: "Phone", map: { to: "person", field: "phone" } },
    { kind: "text", key: "message", label: "Message", long: true },
    { kind: "rating", key: "keen", label: "How keen?", scale: "stars" },
    { kind: "consent", key: "news", words: "Keep me updated by email", purpose: "marketing" },
  ],
});

const survey = (): Questions => ({
  items: [
    { kind: "rating", key: "score", label: "How was it?", scale: "ten", required: true },
    { kind: "text", key: "why", label: "Why?", long: true },
  ],
});

const formObject = {
  label: "Form",
  plural: "Forms",
  titleField: "title",
  fields: {
    title: { type: "text", label: "Title", required: true },
    questions: {
      type: "document",
      label: "Questions",
      schema: QUESTIONS_SCHEMA as unknown as Record<string, unknown>,
      maxBytes: QUESTIONS_MAX_BYTES,
    },
    thanks: { type: "text", label: "Thank-you words" },
    status: {
      type: "select",
      label: "Status",
      options: [
        { value: "draft", label: "Draft" },
        { value: "open", label: "Open" },
        { value: "closed", label: "Closed" },
      ],
    },
    answeredBy: {
      type: "select",
      label: "Who may answer",
      options: [
        { value: "public", label: "Anyone" },
        { value: "customers", label: "Signed-in customers" },
        { value: "links", label: "By personal link" },
        { value: "staff", label: "Staff" },
      ],
    },
    anonymous: { type: "boolean", label: "Anonymous" },
    destination: { type: "text", label: "Also make" },
    opensAt: { type: "datetime", label: "Open from" },
    closesAt: { type: "datetime", label: "Open until" },
    dailyCap: { type: "number", label: "Per day at most" },
    notify: { type: "user", label: "Who is told" },
  },
  states: {
    field: "status",
    initial: "draft",
    moves: [
      { from: "draft", to: "open", by: ["staff"] },
      { from: "open", to: "closed", by: ["staff"] },
      { from: "closed", to: "open", by: ["staff"] },
    ],
  },
  publishable: { content: ["title", "questions", "thanks"] },
  intake: {
    role: "form",
    questions: "questions",
    answeredBy: "answeredBy",
    openIn: ["open"],
    anonymous: "anonymous",
    destination: "destination",
    opensAt: "opensAt",
    closesAt: "closesAt",
    dailyCap: "dailyCap",
    notify: "notify",
  },
};

const submissionObject = {
  label: "Submission",
  plural: "Submissions",
  titleField: "note",
  fields: {
    note: { type: "text", label: "Note" },
    form: { type: "relation", label: "Form", to: FORM },
    version: { type: "number", label: "Version" },
    answers: {
      type: "document",
      label: "Answers",
      schema: ANSWERS_SCHEMA as unknown as Record<string, unknown>,
      maxBytes: 20_480,
    },
    person: { type: "relation", label: "Person", to: "person" },
    certainty: {
      type: "select",
      label: "Certainty",
      options: ["account", "link", "staff", "address"].map((value) => ({ value, label: value })),
    },
    via: {
      type: "select",
      label: "Via",
      options: ["site", "app", "page", "link", "staff"].map((value) => ({ value, label: value })),
    },
    rating: { type: "number", label: "Rating" },
    status: {
      type: "select",
      label: "Status",
      options: ["new", "inHand", "done", "spam"].map((value) => ({ value, label: value })),
    },
  },
  states: {
    field: "status",
    initial: "new",
    moves: [
      { from: "new", to: "spam", by: ["staff", "host"] },
      { from: "new", to: "inHand", by: ["staff"] },
      { from: "inHand", to: "done", by: ["staff"] },
    ],
  },
  intake: {
    role: "submission",
    form: "form",
    version: "version",
    answers: "answers",
    person: "person",
    certainty: "certainty",
    spam: "spam",
    via: "via",
    rating: "rating",
  },
};

const enquiryObject = {
  label: "Enquiry",
  plural: "Enquiries",
  titleField: "subject",
  owner: "owner",
  fields: {
    subject: { type: "text", label: "Subject" },
    person: { type: "relation", label: "Person", to: "person" },
    source: {
      type: "select",
      label: "Source",
      options: [
        { value: "website", label: "Website" },
        { value: "phone", label: "Phone" },
      ],
    },
    owner: { type: "user", label: "Owner" },
  },
  intake: { role: "destination", person: "person", fields: ["subject"], source: "source" },
};

const m = () =>
  manifest(EXT, {
    objects: {
      form: formObject,
      submission: submissionObject,
      enquiry: enquiryObject,
    } as never,
  });

/** Cloudflare's answer, stood in: "good" passes, "down" cannot be checked, anything else fails. */
const turnstile = intakeRuntime(SECRET, async (_url, init) => {
  const body = init?.body as FormData;
  if (body.get("secret") !== SECRET) return Response.json({ success: false });
  const token = body.get("response");
  if (token === "down") return new Response("unavailable", { status: 503 });
  return Response.json({ success: token === "good" });
});

let clockMs = Date.now() + 60_000;
const later = (ms: number) => {
  clockMs += ms;
  return new Date(clockMs);
};

function asCaller(
  principal: CustomerPrincipal | PublicPrincipal,
  at: Date,
  overrides: Partial<OutsideInvocationContext> = {},
): OutsideInvocationContext {
  return outside(principal, {
    tool: { extension: EXT, tool: "submit" },
    intake: turnstile,
    clock: () => at,
    ...overrides,
  });
}

/** Staff through the pack's own tool: the run acts as the extension's account. */
let extAccount: ActingUser;
const asStaffTool = () =>
  context(extAccount, {
    actor: "extension",
    extension: {
      id: EXT,
      permissions: { operations: ["intake.open", "intake.submit"], objects: {} } as never,
      tool: { name: "enter", humanOnly: false, permission: null },
    },
  });

async function makeForm(
  values: Record<string, unknown> = {},
  options: { publish?: boolean; open?: boolean } = {},
): Promise<string> {
  const form = await invoke(
    "record.create",
    {
      object: FORM,
      values: { title: unique("Enquiry"), questions: questions(), answeredBy: "public", ...values },
    },
    context(admin),
  );
  if (options.open !== false) {
    await invoke(
      "record.update",
      { object: FORM, id: form.id, values: { status: "open" } },
      context(admin),
    );
  }
  if (options.publish !== false) {
    await invoke("record.publish", { object: FORM, id: form.id }, context(admin));
  }
  return form.id;
}

/** Opens the form as `principal`, then sends `answers` five seconds later. */
async function send(
  principal: CustomerPrincipal | PublicPrincipal,
  form: string,
  answers: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const opened = await call(
    "intake.open",
    { object: FORM, id: form },
    asCaller(principal, later(1000)),
  );
  const shown = opened.ok ? (opened.value as { shown: string | null }).shown : null;
  return call(
    "intake.submit",
    {
      object: FORM,
      id: form,
      answers,
      ...(principal.kind === "public" ? { turnstileToken: "good" } : {}),
      ...(shown ? { shown } : {}),
      ...extra,
    },
    asCaller(principal, later(5000)),
  );
}

async function submissionsOf(form: string) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM x_${EXT}_submission WHERE form = ? ORDER BY created_at`,
  )
    .bind(form)
    .all<Record<string, unknown>>();
  return results;
}

async function personByEmail(email: string) {
  return env.DB.prepare(
    "SELECT p.* FROM core_person p JOIN core_person_emails e ON e.person_id = p.id WHERE e.email = ? AND p.deleted_at IS NULL",
  )
    .bind(email.toLowerCase())
    .first<Record<string, unknown>>();
}

async function phonesOf(personId: string) {
  const { results } = await env.DB.prepare(
    "SELECT number FROM core_person_phones WHERE person_id = ?",
  )
    .bind(personId)
    .all<{ number: string }>();
  return results.map((r) => r.number);
}

async function adminNotices(key: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM core_notifications WHERE user_id = ? AND dedupe_key LIKE ?",
  )
    .bind(admin.id, `${key}%`)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(m());
  // The pack as a shipped one, with its tool open to the public and customers.
  const shipped = {
    ...m(),
    tools: {
      submit: {
        description: "Send answers to a form",
        risk: "write",
        audiences: ["customer", "public"],
      },
    },
    permissions: { operations: ["intake.open", "intake.submit"], objects: {}, modules: [] },
  };
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', ?, ?, ?, ?)",
  )
    .bind(EXT, JSON.stringify(shipped), admin.id, now, now)
    .run();
  extAccount = await createUser("member");
  await env.DB.prepare("UPDATE core_user SET kind = 'extension' WHERE id = ?")
    .bind(extAccount.id)
    .run();
  memberEmail = `${unique("member")}@example.com`;
  const person = await invoke(
    "person.create",
    {
      givenName: "Mel",
      familyName: "Member",
      emails: [{ email: memberEmail }],
      phones: [{ number: "+61 400 111 222" }],
    },
    context(admin),
  );
  member = { kind: "customer", customerId: `cus_${unique("m")}`, personId: person.id };
});

describe("the intake declaration", () => {
  it("is accepted on a form, a submission and a destination", () => {
    expect(validateManifest(m()).issues).toEqual([]);
  });

  it("refuses a submission readable outside the org and a form with the wrong schema", () => {
    const bad = manifest(EXT, {
      objects: {
        form: {
          ...formObject,
          fields: { ...formObject.fields, questions: { type: "longText", label: "Questions" } },
        },
        submission: {
          ...submissionObject,
          customer: { field: "person", read: ["note"], write: [] },
        },
        enquiry: enquiryObject,
      } as never,
    });
    const messages = validateManifest(bad).issues.map((i) => `${i.path}: ${i.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("objects.form.intake.questions"),
        expect.stringContaining("A submission is read by staff only"),
      ]),
    );
  });

  it("is a reviewed change: a runtime extension cannot declare it", async () => {
    const result = await checkManifest(db.query, EXT, m(), new Date().toISOString(), {
      source: "runtime",
    });
    expect(result.issues.map((i) => i.path)).toEqual(
      expect.arrayContaining([
        "objects.form.intake",
        "objects.submission.intake",
        "objects.enquiry.intake",
      ]),
    );
  });
});

describe("a form's questions are checked on every write", () => {
  it("refuses a question mapped to the Person on an anonymous form", async () => {
    const error = await invoke(
      "record.create",
      { object: FORM, values: { title: "Survey", questions: questions(), anonymous: true } },
      context(admin),
    ).catch((e) => e);
    expect(error).toMatchObject({ code: "invalid_input", details: { rule: "questions" } });
    expect(error.message).toContain("items.0.map");
  });

  it("refuses a destination that is not installed, and one on an anonymous form", async () => {
    const missing = await invoke(
      "record.create",
      { object: FORM, values: { title: "X", questions: survey(), destination: "nope.thing" } },
      context(admin),
    ).catch((e) => e);
    expect(missing).toMatchObject({ details: { rule: "intake_destination" } });
    const anonymous = await invoke(
      "record.create",
      {
        object: FORM,
        values: { title: "X", questions: survey(), destination: ENQUIRY, anonymous: true },
      },
      context(admin),
    ).catch((e) => e);
    expect(anonymous).toMatchObject({ details: { rule: "intake_destination" } });
  });

  it("refuses a map to a field the destination does not list", async () => {
    const mapped = questions();
    mapped.items.push({
      kind: "text",
      key: "about",
      label: "About",
      map: { to: "destination", field: "owner" },
    });
    const error = await invoke(
      "record.create",
      { object: FORM, values: { title: "X", questions: mapped, destination: ENQUIRY } },
      context(admin),
    ).catch((e) => e);
    expect(error.message).toContain('does not list "owner"');
  });
});

describe("only the door creates a record for the public (criterion 1)", () => {
  it("refuses record.create and my.create from the public, directly and from a tool", async () => {
    const form = await makeForm();
    const values = { form, answers: { answers: [] } };
    for (const name of ["record.create", "my.create"]) {
      const direct = await call(name, { object: SUBMISSION, values }, outside(PUBLIC));
      expect(direct.ok).toBe(false);
      const fromTool = await call(
        name,
        { object: SUBMISSION, values },
        asCaller(PUBLIC, later(10)),
      );
      expect(fromTool.ok).toBe(false);
    }
    expect(await submissionsOf(form)).toHaveLength(0);
  });

  it("refuses intake.submit called directly, not from a tool", async () => {
    const form = await makeForm();
    const direct = await call(
      "intake.submit",
      { object: FORM, id: form, answers: { email: "a@example.com" } },
      outside(PUBLIC, { intake: turnstile }),
    );
    expect(direct).toMatchObject({ ok: false, error: { code: "unknown_operation" } });
    const staff = await invoke(
      "intake.submit",
      { object: FORM, id: form, answers: { email: "a@example.com" } },
      context(admin),
    ).catch((e) => e);
    expect(staff).toMatchObject({ code: "unknown_operation" });
  });
});

describe("a visitor's enquiry (criterion 2)", () => {
  it("makes one submission and one new Person in one batch, and staff are told", async () => {
    const form = await makeForm({ notify: admin.id });
    const email = `${unique("Visitor")}@Example.com`;
    const before = await adminNotices("");
    const sent = await send(PUBLIC, form, {
      name: "Vi Visitor",
      email,
      phone: "+61 400 999 000",
      message: "Do you run classes for kids? See www.example.com",
      keen: 4,
      news: true,
    });
    expect(sent).toEqual({ ok: true, value: { received: true } });
    const rows = await submissionsOf(form);
    expect(rows).toHaveLength(1);
    const person = await personByEmail(email);
    expect(person).toMatchObject({ display_name: "Vi Visitor" });
    expect(await phonesOf(person?.id as string)).toEqual(["+61 400 999 000"]);
    expect(rows[0]).toMatchObject({
      person: person?.id,
      certainty: "address",
      version: 1,
      rating: 4,
      status: "new",
      created_by: "public",
    });
    // The marketing tick is kept with the answers of the version answered (criterion 16).
    expect(JSON.parse(rows[0]?.answers as string).answers).toContainEqual({
      kind: "consent",
      key: "news",
      value: true,
    });
    // Staff are told (here the form's chosen person, the admin).
    expect(await adminNotices("")).toBeGreaterThanOrEqual(before);
    const notice = await env.DB.prepare(
      "SELECT title, body FROM core_notifications WHERE user_id = ? AND link LIKE ? ",
    )
      .bind(admin.id, `%${rows[0]?.id as string}%`)
      .first<{ title: string; body: string }>();
    expect(notice?.title).toContain("New answers to");
    expect(notice?.body).toBe("From an unconfirmed address.");
  });

  it("keeps no answer in the audit row, only the question keys", async () => {
    const form = await makeForm();
    const secret = unique("SecretWords");
    await send(PUBLIC, form, { email: `${unique("a")}@example.com`, message: secret });
    const { results } = await env.DB.prepare(
      "SELECT input, result, user_id FROM core_audit WHERE operation = 'intake.submit' ORDER BY at DESC LIMIT 3",
    ).all<{ input: string; result: string; user_id: string | null }>();
    expect(JSON.stringify(results)).not.toContain(secret);
    expect(JSON.stringify(results)).not.toContain("good");
    expect(JSON.parse(results[0]?.result as string)).toMatchObject({
      keys: ["email", "message"],
    });
  });
});

describe("an address already on file (criteria 3 and 4)", () => {
  it("links that Person and changes nothing already on their record", async () => {
    const form = await makeForm();
    const sent = await send(PUBLIC, form, {
      name: "Someone Else",
      email: memberEmail.toUpperCase(),
      phone: "+61 499 000 000",
    });
    expect(sent.ok).toBe(true);
    const [row] = await submissionsOf(form);
    expect(row).toMatchObject({ person: member.personId, certainty: "address" });
    const person = await personByEmail(memberEmail);
    expect(person).toMatchObject({ given_name: "Mel", family_name: "Member" });
    expect(await phonesOf(member.personId)).toEqual(["+61 400 111 222"]);
  });

  it("fills only empty fields of a Person who had none", async () => {
    const email = `${unique("bare")}@example.com`;
    const bare = await invoke("person.create", { emails: [{ email }] }, context(admin));
    const form = await makeForm();
    await send(PUBLIC, form, { name: "Bea Bare", email, phone: "+61 488 000 111" });
    const person = await personByEmail(email);
    expect(person).toMatchObject({ id: bare.id, display_name: "Bea Bare" });
    expect(await phonesOf(bare.id)).toEqual(["+61 488 000 111"]);
  });

  it("refuses an invalid or erased address with order.start's words", async () => {
    const form = await makeForm();
    const erased = `${unique("gone")}@example.com`;
    await env.DB.prepare(
      "INSERT INTO core_erased_address (hash, object_type, erased_at, erased_by) VALUES (?, 'person', ?, NULL)",
    )
      .bind(await erasedAddressHash(erased), new Date().toISOString())
      .run();
    const gone = await send(PUBLIC, form, { email: erased });
    expect(gone).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: "That email address cannot be used" },
    });
    expect(await submissionsOf(form)).toHaveLength(0);
  });
});

describe("which forms take answers (criteria 5 and 7)", () => {
  it("finds no draft, closed, unpublished or out-of-dates form for the public", async () => {
    const draft = await makeForm({}, { open: false });
    const unpublished = await makeForm({}, { publish: false });
    const closed = await makeForm();
    await invoke(
      "record.update",
      { object: FORM, id: closed, values: { status: "closed" } },
      context(admin),
    );
    const future = await makeForm({ opensAt: new Date(clockMs + 86_400_000 * 30).toISOString() });
    const past = await makeForm({ closesAt: new Date(clockMs - 86_400_000).toISOString() });
    const customers = await makeForm({ answeredBy: "customers" });
    const links = await makeForm({ answeredBy: "links" });
    for (const form of [draft, unpublished, closed, future, past, customers, links]) {
      const opened = await call(
        "intake.open",
        { object: FORM, id: form },
        asCaller(PUBLIC, later(1)),
      );
      expect(opened, form).toMatchObject({ ok: false, error: { code: "not_found" } });
      const sent = await send(PUBLIC, form, { email: `${unique("x")}@example.com` });
      expect(sent, form).toMatchObject({ ok: false, error: { code: "not_found" } });
    }
    // A customers' form takes a signed-in customer's answers; a links form needs a live link.
    expect((await send(member, customers, { email: memberEmail })).ok).toBe(true);
    expect((await send(member, links, { email: memberEmail })).ok).toBe(false);
  });

  it("points new submissions at the new version, old ones keep theirs", async () => {
    const form = await makeForm();
    await send(PUBLIC, form, { email: `${unique("v1")}@example.com` });
    const edited = survey();
    edited.items.push({ kind: "email", key: "email", label: "Email" });
    await invoke(
      "record.update",
      { object: FORM, id: form, values: { questions: edited } },
      context(admin),
    );
    // Not yet published: still the first version's questions.
    expect((await send(PUBLIC, form, { score: 7 })).ok).toBe(false);
    await invoke("record.publish", { object: FORM, id: form }, context(admin));
    expect((await send(PUBLIC, form, { score: 7 })).ok).toBe(true);
    const rows = await submissionsOf(form);
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
  });
});

describe("answers that break the version (criterion 6)", () => {
  it("are refused naming the question's key, with no value in the error or the audit row", async () => {
    const form = await makeForm();
    const value = `${unique("TooLong")}${"x".repeat(250)}`;
    const links = "see https://a.example https://b.example https://c.example https://d.example";
    const sent = await send(PUBLIC, form, { name: value, keen: "five", message: links });
    expect(sent.ok).toBe(false);
    const error = (
      sent as unknown as { error: { details: { issues: { key: string; fault: string }[] } } }
    ).error;
    expect(error.details.issues.map((i) => [i.key, i.fault])).toEqual([
      ["name", "length"],
      ["email", "required"],
      ["message", "links"],
      ["keen", "type"],
    ]);
    expect(JSON.stringify(error)).not.toContain(value);
    expect(JSON.stringify(error)).not.toContain("a.example");
    const audit = await env.DB.prepare(
      "SELECT input, error FROM core_audit WHERE operation = 'intake.submit' AND outcome = 'error' ORDER BY at DESC LIMIT 1",
    ).first<{ input: string; error: string }>();
    expect(JSON.stringify(audit)).not.toContain(value);
    expect(JSON.stringify(audit)).not.toContain("a.example");
    expect(await submissionsOf(form)).toHaveLength(0);
  });
});

describe("Turnstile (criterion 8)", () => {
  it("refuses a public submission with no token or a bad one; a customer needs none", async () => {
    const form = await makeForm();
    const email = `${unique("t")}@example.com`;
    const opened = await call(
      "intake.open",
      { object: FORM, id: form },
      asCaller(PUBLIC, later(1)),
    );
    const { shown } = (opened as { value: { shown: string } }).value;
    const at = later(5000);
    for (const token of [undefined, "bad"]) {
      const sent = await call(
        "intake.submit",
        { object: FORM, id: form, answers: { email }, shown, turnstileToken: token },
        asCaller(PUBLIC, at),
      );
      expect(sent).toMatchObject({ ok: false, error: { details: { rule: "turnstile" } } });
    }
    const down = await call(
      "intake.submit",
      { object: FORM, id: form, answers: { email }, shown, turnstileToken: "down" },
      asCaller(PUBLIC, at),
    );
    expect(down).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(await submissionsOf(form)).toHaveLength(0);
    const signedIn = await call(
      "intake.submit",
      { object: FORM, id: form, answers: { email: memberEmail } },
      asCaller(member, later(10)),
    );
    expect(signedIn).toEqual({ ok: true, value: { received: true } });
    expect((await submissionsOf(form))[0]).toMatchObject({
      person: member.personId,
      certainty: "account",
    });
  });

  it("with no secret, refuses every public submission and tells admins once", async () => {
    const form = await makeForm();
    const before = await adminNotices("intake.turnstile_unset");
    for (let i = 0; i < 2; i++) {
      const sent = await call(
        "intake.submit",
        {
          object: FORM,
          id: form,
          answers: { email: `${unique("n")}@example.com` },
          turnstileToken: "good",
        },
        asCaller(PUBLIC, later(10), { intake: intakeRuntime(undefined) }),
      );
      expect(sent).toMatchObject({ ok: false, error: { details: { rule: "intake_unavailable" } } });
    }
    expect(await adminNotices("intake.turnstile_unset")).toBe(before + 1);
    expect(await submissionsOf(form)).toHaveLength(0);
  });
});

describe("the honeypot, the fill time and the caps (criterion 9)", () => {
  it("answers a filled honeypot, a missing or forged shown time, or a fast one with success, storing nothing", async () => {
    const form = await makeForm();
    const email = `${unique("bot")}@example.com`;
    expect(await send(PUBLIC, form, { email }, { honeypot: "http://spam.example" })).toEqual({
      ok: true,
      value: { received: true },
    });
    const opened = await call(
      "intake.open",
      { object: FORM, id: form },
      asCaller(PUBLIC, later(1)),
    );
    const { shown } = (opened as { value: { shown: string } }).value;
    const fast = await call(
      "intake.submit",
      { object: FORM, id: form, answers: { email }, shown, turnstileToken: "good" },
      asCaller(PUBLIC, later(1000)),
    );
    expect(fast).toEqual({ ok: true, value: { received: true } });
    const forged = `${shown.slice(0, -4)}AAAA`;
    for (const token of [undefined, forged]) {
      const sent = await call(
        "intake.submit",
        { object: FORM, id: form, answers: { email }, shown: token, turnstileToken: "good" },
        asCaller(PUBLIC, later(5000)),
      );
      expect(sent).toEqual({ ok: true, value: { received: true } });
    }
    // Another form's shown time is not this form's.
    const other = await makeForm();
    const elsewhere = await call(
      "intake.open",
      { object: FORM, id: other },
      asCaller(PUBLIC, later(1)),
    );
    const borrowed = (elsewhere as { value: { shown: string } }).value.shown;
    expect(
      await call(
        "intake.submit",
        { object: FORM, id: form, answers: { email }, shown: borrowed, turnstileToken: "good" },
        asCaller(PUBLIC, later(5000)),
      ),
    ).toEqual({ ok: true, value: { received: true } });
    expect(await submissionsOf(form)).toHaveLength(0);
    expect(await personByEmail(email)).toBeNull();
  });

  it("over the form's daily cap: try later, and one notice to admins", async () => {
    const form = await makeForm({ dailyCap: 2 });
    for (let i = 0; i < 2; i++) {
      expect((await send(PUBLIC, form, { email: `${unique("c")}@example.com` })).ok).toBe(true);
    }
    const before = await adminNotices(`intake.daily_cap:${form}`);
    for (let i = 0; i < 2; i++) {
      const over = await send(PUBLIC, form, { email: `${unique("c")}@example.com` });
      expect(over).toMatchObject({
        ok: false,
        error: { code: "rate_limited", details: { rule: "intake_cap" } },
      });
    }
    expect(await adminNotices(`intake.daily_cap:${form}`)).toBe(before + 1);
    expect(await submissionsOf(form)).toHaveLength(2);
  });

  it("a sixth to one form in a day from one mailbox is kept as spam, answered as success", async () => {
    const form = await makeForm();
    const local = unique("box");
    for (let i = 0; i < 5; i++) {
      expect((await send(PUBLIC, form, { email: `${local}+${i}@example.com` })).ok).toBe(true);
    }
    const sixth = await send(PUBLIC, form, { email: `${local}+again@example.com` });
    expect(sixth).toEqual({ ok: true, value: { received: true } });
    const rows = await submissionsOf(form);
    expect(rows.map((r) => r.status)).toEqual(["new", "new", "new", "new", "new", "spam"]);
    // Spam makes no Person.
    expect(rows[5]?.person).toBeNull();
    expect(await personByEmail(`${local}+again@example.com`)).toBeNull();
  });
});

describe("what is stored (criterion 10)", () => {
  it("no table written holds a client address, user agent or fingerprint", async () => {
    const tables = (
      await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
      ).all<{ name: string }>()
    ).results.map((r) => r.name);
    const counts = async () => {
      const out = new Map<string, number>();
      for (const t of tables) {
        const row = await env.DB.prepare(`SELECT count(*) AS n FROM "${t}"`).first<{ n: number }>();
        out.set(t, Number(row?.n ?? 0));
      }
      return out;
    };
    const form = await makeForm();
    const before = await counts();
    expect((await send(PUBLIC, form, { email: `${unique("w")}@example.com` })).ok).toBe(true);
    const after = await counts();
    const written = tables.filter((t) => after.get(t) !== before.get(t));
    expect(written).toEqual(expect.arrayContaining([`x_${EXT}_submission`, "core_person"]));
    for (const table of written) {
      const columns = (
        await env.DB.prepare("SELECT name FROM pragma_table_info(?)").bind(table).all<{
          name: string;
        }>()
      ).results.map((c) => c.name);
      for (const column of columns) {
        expect(column, `${table}.${column}`).not.toMatch(
          /(^|_)ip($|_)|ip_address|remote_addr|user_agent|useragent|fingerprint|device/i,
        );
      }
    }
  });
});

describe("an anonymous form (criterion 11)", () => {
  it("keeps no Person, no account and no session, from the public or a signed-in member", async () => {
    const form = await makeForm({ anonymous: true, questions: survey() });
    expect((await send(PUBLIC, form, { score: 3 })).ok).toBe(true);
    const sent = await call(
      "intake.submit",
      { object: FORM, id: form, answers: { score: 9, why: "Great coach" } },
      asCaller(member, later(10), { origin: { surface: "client", sessionId: "ses_anon" } }),
    );
    expect(sent).toEqual({ ok: true, value: { received: true } });
    const rows = await submissionsOf(form);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ person: null, certainty: null, created_by: "public" });
    }
    const id = rows[1]?.id as string;
    const audit = await env.DB.prepare(
      "SELECT a.user_id, a.actor, a.origin FROM core_audit a JOIN core_audit_changes c ON c.audit_id = a.id WHERE c.record_id = ?",
    )
      .bind(id)
      .first<{ user_id: string | null; actor: string; origin: string }>();
    expect(audit).toMatchObject({ user_id: null, actor: "customer" });
    expect(audit?.origin).not.toContain("ses_anon");
    const marks = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_value_mark WHERE record_id = ? AND by_id IS NOT NULL",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(Number(marks?.n)).toBe(0);
    expect(
      JSON.stringify(
        await env.DB.prepare("SELECT * FROM core_audit WHERE user_id = ?")
          .bind(member.customerId)
          .all(),
      ),
    ).not.toContain(id);
  });
});

describe("a destination (criterion 12)", () => {
  it("makes the destination record with the Person and source website, owner by assignment", async () => {
    const mapped = questions();
    mapped.items.push({
      kind: "text",
      key: "about",
      label: "About",
      map: { to: "destination", field: "subject" },
    });
    const form = await makeForm({ questions: mapped, destination: ENQUIRY });
    const email = `${unique("lead")}@example.com`;
    expect((await send(PUBLIC, form, { email, about: "Kids' classes" })).ok).toBe(true);
    const person = await personByEmail(email);
    const enquiry = await env.DB.prepare(`SELECT * FROM x_${EXT}_enquiry WHERE person = ?`)
      .bind(person?.id)
      .first<Record<string, unknown>>();
    expect(enquiry).toMatchObject({ subject: "Kids' classes", source: "website" });
  });
});

describe("staff entering answers through their tool", () => {
  it("is certainty staff, any published form, and never ticks a marketing line", async () => {
    const form = await makeForm({ answeredBy: "staff" });
    const email = `${unique("phone")}@example.com`;
    const ticked = await invoke(
      "intake.submit",
      { object: FORM, id: form, answers: { email, news: true } },
      asStaffTool(),
    ).catch((e) => e);
    expect(ticked).toMatchObject({ code: "invalid_input" });
    expect(JSON.stringify(ticked.details)).toContain('"key":"news"');
    const entered = await invoke(
      "intake.submit",
      { object: FORM, id: form, answers: { email, message: "Called about a trial" } },
      asStaffTool(),
    );
    expect(entered).toEqual({ received: true });
    expect((await submissionsOf(form))[0]).toMatchObject({ certainty: "staff", via: "staff" });
  });

  it("is refused for another pack's form", async () => {
    const form = await makeForm();
    const other = context(extAccount, {
      actor: "extension",
      extension: {
        id: "otherpack",
        permissions: { operations: ["intake.submit"], objects: {} } as never,
        tool: { name: "enter", humanOnly: false, permission: null },
      },
    });
    const error = await invoke(
      "intake.submit",
      { object: FORM, id: form, answers: { email: "x@example.com" } },
      other,
    ).catch((e) => e);
    expect(error).toMatchObject({ code: "unknown_operation" });
  });
});

describe("what one submission costs (D1: 1,000 statements a call, 100 bound values a statement)", () => {
  it("is a few dozen statements, each with few bound values, however many came before", async () => {
    const mapped = questions();
    mapped.items.push({
      kind: "text",
      key: "about",
      label: "About",
      map: { to: "destination", field: "subject" },
    });
    const form = await makeForm({ questions: mapped, destination: ENQUIRY });
    // A busy form: 150 earlier submissions today (written directly, as a long day leaves them).
    const answers = JSON.stringify({
      answers: [{ kind: "email", key: "email", value: "earlier@example.com" }],
    });
    const at = new Date(clockMs).toISOString();
    const earlier = Array.from({ length: 150 }, (_, i) =>
      env.DB.prepare(
        `INSERT INTO x_${EXT}_submission (id, created_at, updated_at, created_by, form, version, answers, status) VALUES (?, ?, ?, 'public', ?, 1, ?, 'new')`,
      ).bind(`rec_cost${i}_${unique("c")}`, at, at, form, answers),
    );
    await env.DB.batch(earlier);

    let statements = 0;
    let batched = 0;
    let maxBound = 0;
    const metered = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (query: string) => {
            const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(stmt, {
                get(st, p) {
                  if (p === "bind") {
                    return (...args: unknown[]) => {
                      maxBound = Math.max(maxBound, args.length);
                      return wrap(st.bind(...args));
                    };
                  }
                  if (p === "all" || p === "run" || p === "first" || p === "raw") {
                    return (...args: unknown[]) => {
                      statements += 1;
                      return (st[p] as (...a: unknown[]) => Promise<unknown>)(...args);
                    };
                  }
                  const value = Reflect.get(st, p);
                  return typeof value === "function" ? value.bind(st) : value;
                },
              });
            return wrap(target.prepare(query));
          };
        }
        if (prop === "batch") {
          return (list: D1PreparedStatement[]) => {
            statements += list.length;
            batched = Math.max(batched, list.length);
            return target.batch(list);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const meteredDb = createCrmDb(metered);
    const opened = await call(
      "intake.open",
      { object: FORM, id: form },
      asCaller(PUBLIC, later(1000), { db: meteredDb }),
    );
    const { shown } = (opened as { value: { shown: string } }).value;
    const sent = await call(
      "intake.submit",
      {
        object: FORM,
        id: form,
        answers: {
          name: "Cost Counted",
          email: `${unique("cost")}@example.com`,
          phone: "+61 400 000 321",
          about: "Counting",
        },
        shown,
        turnstileToken: "good",
      },
      asCaller(PUBLIC, later(5000), { db: meteredDb }),
    );
    expect(sent).toEqual({ ok: true, value: { received: true } });
    // A new Person, the submission, a destination and a notice, in one batch.
    expect(batched).toBeLessThan(40);
    expect(statements).toBeLessThan(100);
    expect(maxBound).toBeLessThan(100);
  });
});

describe("several People with the address (criterion 3)", () => {
  it("links none and tells admins", async () => {
    const email = `${unique("shared")}@example.com`;
    await invoke("person.create", { givenName: "First", emails: [{ email }] }, context(admin));
    const second = await invoke(
      "person.create",
      { givenName: "Second", emails: [{ email: `${unique("other")}@example.com` }] },
      context(admin),
    );
    // A second live Person with one address cannot be made through the operations; an old
    // import could have left one.
    await env.DB.prepare("DROP INDEX IF EXISTS core_person_emails_live_email_uq").run();
    await env.DB.prepare("UPDATE core_person_emails SET email = ? WHERE person_id = ?")
      .bind(email, second.id)
      .run();
    const form = await makeForm();
    const before = await adminNotices("intake.several_people");
    expect((await send(PUBLIC, form, { email })).ok).toBe(true);
    const [row] = await submissionsOf(form);
    expect(row).toMatchObject({ person: null, certainty: "address" });
    expect(await adminNotices("intake.several_people")).toBe(before + 1);
  });
});
