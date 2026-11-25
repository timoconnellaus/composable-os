// Stage 29 step 4 end to end: the ways a person fills in a form (criterion 22), in a real browser
// against the real host, with Forms on and the local Turnstile test keys (scripts/dev-setup.mjs):
//
// - a visitor fills in a public form on its own page (`/f/<slug>`, for a link or a QR code), with
//   no account and no JavaScript needed; Turnstile's script is Cloudflare's test widget, stood in
//   for in the browser, and the runner checks its token with the test secret;
// - a visitor fills in the same kind of form on the business's website: the forms-form block, as
//   a client app mounts it (here on the development page, /blocks);
// - a member answers a personal link from an email (`/form?t=…`): the token leaves the address
//   bar, nothing is loaded from anywhere else, it is answered once.
//
// Staff handling the inbox is step 8's journey.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { unique } from "./helpers.ts";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const FORM = "forms.form";
const SUBMISSION = "forms.submission";

async function staffOp<T>(page: Page, name: string, input: unknown): Promise<T> {
  const response = await page.request.post(`/api/v1/op/${name}`, {
    data: input,
    headers: { "idempotency-key": crypto.randomUUID() },
  });
  const body = (await response.json()) as { data?: T; error?: unknown };
  expect(response.status(), `${name}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
  return body.data as T;
}

const enquiry = {
  items: [
    { kind: "heading", key: "you", text: "About you" },
    {
      kind: "text",
      key: "name",
      label: "Your name",
      required: true,
      map: { to: "person", field: "name" },
    },
    {
      kind: "email",
      key: "email",
      label: "Email",
      required: true,
      map: { to: "person", field: "email" },
    },
    { kind: "choice", key: "time", label: "Best time to train", options: ["Morning", "Evening"] },
    { kind: "rating", key: "keen", label: "How keen are you?", scale: "stars" },
    { kind: "yesNo", key: "before", label: "Have you trained before?" },
    {
      kind: "text",
      key: "where",
      label: "Where did you train?",
      showIf: { question: "before", is: "yes" },
    },
    { kind: "consent", key: "news", words: "Keep me updated by email", purpose: "marketing" },
  ],
};

/** A published, open form, as staff build and publish it. */
async function publishedForm(page: Page, values: Record<string, unknown>) {
  const { id } = await staffOp<{ id: string }>(page, "record.create", {
    object: FORM,
    values: { title: unique("Ask about a trial "), receipt: false, ...values },
  });
  await staffOp(page, "record.update", { object: FORM, id, values: { status: "open" } });
  await staffOp(page, "record.publish", { object: FORM, id });
  const got = await staffOp<{ title: string; values: { slug: string; title: string } }>(
    page,
    "record.get",
    { object: FORM, id },
  );
  return { id, slug: got.values.slug, title: got.values.title };
}

async function submissions(page: Page, form: string) {
  const list = await staffOp<{ items: { values: Record<string, unknown> }[] }>(
    page,
    "record.list",
    { object: SUBMISSION, filter: { field: "form", op: "eq", value: form } },
  );
  return list.items;
}

/** A browser with nobody signed in. */
async function visitor(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  return context.newPage();
}

/** The host's check of when the form was shown: a form is not sent in under 3 seconds. */
async function afterFillTime(since: number) {
  await expect.poll(() => Date.now() - since, { timeout: 10_000 }).toBeGreaterThan(3_200);
}

test("a visitor fills in a public form on its own page", async ({ page, browser, baseURL }) => {
  const form = await publishedForm(page, { answeredBy: "public", questions: enquiry });
  const guest = await visitor(browser, baseURL);
  // Cloudflare's test widget, stood in for: it puts its token in the form, as the real one does.
  await guest.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `document.querySelectorAll(".cf-turnstile").forEach(function (w) {
        var i = document.createElement("input"); i.type = "hidden";
        i.name = "cf-turnstile-response"; i.value = "XXXX.DUMMY.TOKEN.XXXX"; w.appendChild(i);
      });`,
    }),
  );
  const opened = await guest.goto(`/f/${form.slug}`);
  const shownAt = Date.now();
  expect(opened?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  await expect(guest.getByRole("heading", { name: form.title })).toBeVisible();
  const email = `${unique("visitor")}@visitors.test`.toLowerCase();
  await guest.getByLabel("Your name").fill("Robin Visitor");
  await guest.getByRole("textbox", { name: /^Email/ }).fill(email);
  await guest.getByRole("radio", { name: "Evening" }).check();
  await guest.getByRole("radio", { name: "4 stars" }).check();
  // Shown only once "Yes" is chosen.
  await expect(guest.getByLabel("Where did you train?")).toBeHidden();
  await guest.getByRole("radio", { name: "Yes" }).check();
  await guest.getByLabel("Where did you train?").fill("A gym in town");
  await guest.getByLabel("Keep me updated by email").check();
  await afterFillTime(shownAt);
  await guest.getByRole("button", { name: "Send" }).click();
  await expect(guest.getByRole("status")).toContainText("Thank you");

  const [kept, ...more] = await submissions(page, form.id);
  expect(more).toEqual([]);
  expect(kept?.values).toMatchObject({ via: "page", certainty: "address", rating: 4 });
  await guest.context().close();
});

test("a visitor fills in a form on the business's website (the form block)", async ({
  page,
  browser,
  baseURL,
}) => {
  const form = await publishedForm(page, { answeredBy: "public", questions: enquiry });
  const guest = await visitor(browser, baseURL);
  const props = JSON.stringify({ slug: form.slug, Turnstile: "test" });
  await guest.goto(
    `/blocks?block=forms-form&component=FormBlock&props=${encodeURIComponent(props)}`,
  );
  await expect(guest.getByRole("heading", { name: form.title })).toBeVisible();
  const shownAt = Date.now();
  // Sent with nothing answered: what to fix is listed and tied to each question, nothing sent.
  await guest.getByRole("button", { name: "Send" }).click();
  const problems = guest.getByRole("alert");
  await expect(problems).toContainText("Some answers need another look");
  await expect(
    problems.getByRole("link", { name: /Your name: Answer this question/ }),
  ).toBeVisible();
  await expect(guest.getByLabel("Your name")).toHaveAttribute("aria-invalid", "true");
  await expect(guest.getByLabel("Your name")).toHaveAccessibleDescription("Answer this question");

  const email = `${unique("site")}@visitors.test`.toLowerCase();
  await guest.getByLabel("Your name").fill("Sam Site");
  await guest.getByRole("textbox", { name: /^Email/ }).fill(email);
  await guest.getByRole("radio", { name: "Morning" }).check();
  await guest.getByRole("radio", { name: "No" }).check();
  await expect(guest.getByLabel("Where did you train?")).toHaveCount(0);
  await afterFillTime(shownAt);
  await guest.getByRole("button", { name: "Send" }).click();
  await expect(guest.getByRole("status")).toBeVisible();

  const [kept, ...more] = await submissions(page, form.id);
  expect(more).toEqual([]);
  expect(kept?.values).toMatchObject({ via: "site", certainty: "address" });
  await guest.context().close();
});

/** A statement on the local D1 database the dev server uses (as scripts/dev-setup.mjs does). */
function localSql(sql: string) {
  execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "DB", "--local", "--command", sql], {
    cwd: APP,
    stdio: "pipe",
    env: { ...process.env, CI: "true" },
  });
}

/**
 * A personal link for `personId` to `formId`, and its token, as routine mail makes one when the
 * email that carries it goes (ADR 0723; Bookings' feedback after a class is its first sender).
 */
function personalLink(personId: string, formId: string) {
  const token = randomBytes(32).toString("base64url");
  const id = `ilk_${randomBytes(13).toString("hex").toUpperCase().slice(0, 26)}`;
  const now = new Date();
  const later = new Date(now.getTime() + 7 * 86_400_000);
  localSql(
    `INSERT INTO core_intake_link (id, person_id, form_object, form_id, record_object, record_id, made_for, expires_at, created_at) VALUES ('${id}', '${personId}', '${FORM}', '${formId}', 'person', '${personId}', 'e2e:${id}', '${later.toISOString()}', '${now.toISOString()}');` +
      `INSERT INTO core_intake_link_token (token_hash, link_id, sent_to, created_at) VALUES ('${createHash("sha256").update(token).digest("hex")}', '${id}', '${personId}', '${now.toISOString()}');`,
  );
  return token;
}

test("a member answers a personal link from their email", async ({ page, browser, baseURL }) => {
  const form = await publishedForm(page, {
    answeredBy: "links",
    kind: "feedback",
    questions: {
      items: [
        {
          kind: "rating",
          key: "score",
          label: "How was the class?",
          scale: "stars",
          required: true,
        },
        { kind: "text", key: "why", label: "Anything to tell us?", long: true },
      ],
    },
  });
  const person = await staffOp<{ id: string }>(page, "person.create", {
    givenName: "Morgan",
    emails: [{ email: `${unique("member")}@members.test`.toLowerCase() }],
  });
  const token = personalLink(person.id, form.id);

  const member = await visitor(browser, baseURL);
  // Every request the page makes: none may go anywhere but this site.
  const elsewhere: string[] = [];
  const origin = new URL(baseURL ?? "").origin;
  member.on("request", (request) => {
    if (!request.url().startsWith(origin) && !request.url().startsWith("data:"))
      elsewhere.push(request.url());
  });
  const opened = await member.goto(`/form?t=${token}`);
  expect(opened?.headers()["referrer-policy"]).toBe("no-referrer");
  await expect(member.getByRole("heading", { name: form.title })).toBeVisible();
  // The token is out of the address bar (and the history) once the page has loaded.
  await expect(member).toHaveURL(`${origin}/form`);
  await member.getByRole("radio", { name: "5 stars" }).check();
  await member.getByLabel("Anything to tell us?").fill("Great class");
  await member.getByRole("button", { name: "Send" }).click();
  await expect(member.getByRole("status")).toBeVisible();
  expect(elsewhere).toEqual([]);

  const [kept, ...more] = await submissions(page, form.id);
  expect(more).toEqual([]);
  expect(kept?.values).toMatchObject({
    person: person.id,
    certainty: "link",
    via: "link",
    rating: 5,
  });

  // Used: the link from the email again is one plain answer.
  await member.goto(`/form?t=${token}`);
  await expect(member.getByRole("heading", { name: "This link cannot be used" })).toBeVisible();
  await member.context().close();
});
