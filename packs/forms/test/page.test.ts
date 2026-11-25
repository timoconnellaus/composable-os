// The form page (stage 29 step 4, ADR 0728) over a stand-in client: what it draws, what it posts,
// and a personal link's page's three rules (no referrer, no script from elsewhere, the token taken
// out of the address bar). apps/runner/test/forms-page.test.ts drives it against the real host:
// there, opening a link uses nothing and its send uses it once.
import { describe, expect, it } from "vitest";
import type { FormsOperations, OpenedForm } from "../client/index.ts";
import {
  type FormPageClient,
  formPage,
  isFormPagePath,
  PAGE_SCRIPT,
  pageScriptSource,
  TURNSTILE_ORIGIN,
} from "../client/page.ts";

const TOKEN = "A".repeat(43);

const form = (extra: Partial<OpenedForm> = {}): OpenedForm => ({
  id: "rec_form",
  version: 2,
  title: "Ask about a trial",
  questions: {
    items: [
      { kind: "text", key: "name", label: "Your name", required: true },
      { kind: "email", key: "email", label: "Email", required: true, help: "We reply here" },
      { kind: "choice", key: "days", label: "Days", options: ["Mon", "Fri"], multiple: true },
      { kind: "rating", key: "score", label: "Score", scale: "stars" },
      { kind: "yesNo", key: "before", label: "Trained before?" },
      { kind: "text", key: "where", label: "Where?", showIf: { question: "before", is: "yes" } },
      { kind: "consent", key: "news", words: "Keep me <updated>", purpose: "marketing" },
    ],
  },
  thanks: "Thanks, we will be in touch.",
  anonymous: false,
  turnstile: true,
  shown: "v1.shown",
  ...extra,
});

type Call = { name: string; input: unknown; key?: string | undefined };

function client(
  opened: OpenedForm | Error,
  submit: (input: unknown) => Promise<unknown> = async () => ({ received: true }),
) {
  const calls: Call[] = [];
  const api: FormPageClient = {
    async call(name, input, options) {
      calls.push({ name, input, key: options?.idempotencyKey });
      if (name === "x.forms.form") {
        if (opened instanceof Error) throw opened;
        return opened as never;
      }
      return (await submit(input)) as FormsOperations["x.forms.submit"]["output"] as never;
    },
  };
  return { api, calls };
}

const get = (path: string, api: FormPageClient, siteKey: string | null = "site-key") =>
  formPage(new Request(`https://gym.example${path}`), { client: api, turnstileSiteKey: siteKey });

const post = (path: string, fields: [string, string][], api: FormPageClient, headers = {}) =>
  formPage(
    new Request(`https://gym.example${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString(),
    }),
    { client: api, turnstileSiteKey: "site-key" },
  );

/** The hidden fields a drawn page posts back. */
function hidden(html: string): [string, string][] {
  return [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [
    m[1] as string,
    (m[2] as string).replaceAll("&amp;", "&"),
  ]);
}

const thirdPartyScripts = (html: string) => [...html.matchAll(/<script[^>]*\ssrc=/g)].length;

describe("the paths", () => {
  it("is /form and /f/<slug>", () => {
    expect(isFormPagePath("/form")).toBe(true);
    expect(isFormPagePath("/f/ask-about-a-trial")).toBe(true);
    expect(isFormPagePath("/f/a/b")).toBe(false);
    expect(isFormPagePath("/forms")).toBe(false);
  });
});

describe("a form's own page", () => {
  it("draws every question with its label, help and hidden fields, and Turnstile's widget", async () => {
    const { api, calls } = client(form());
    const response = await get("/f/ask-about-a-trial", api);
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ name: "x.forms.form", input: { slug: "ask-about-a-trial" } }]);
    const html = await response.text();
    expect(html).toContain('<label for="f-name">Your name <span class="req">(required)</span>');
    expect(html).toContain('aria-describedby="h-email"');
    expect(html).toContain('<p class="help" id="h-email">We reply here</p>');
    expect(html).toContain('type="checkbox" id="f-days-0" name="a.days" value="Mon"');
    expect(html).toContain("1 star");
    expect(html).toContain('data-show-q="before" data-show-is="yes"');
    // The business's words are text, never markup.
    expect(html).toContain("Keep me &lt;updated&gt;");
    expect(html).toContain('name="website" tabindex="-1"');
    expect(Object.fromEntries(hidden(html))).toMatchObject({
      _id: "rec_form",
      _version: "2",
      _shown: "v1.shown",
    });
    expect(html).toContain('<div class="cf-turnstile" data-sitekey="site-key">');
    expect(thirdPartyScripts(html)).toBe(1);
    expect(response.headers.get("content-security-policy")).toContain(
      `script-src ${await pageScriptSource()} ${TURNSTILE_ORIGIN}`,
    );
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("says a form not open the same whatever the reason", async () => {
    const notFound = Object.assign(new Error("Not found"), { code: "not_found" });
    const { api } = client(notFound);
    const response = await get("/f/ask-about-a-trial", api);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("This form is not open");
    expect((await get("/f/Not%20A%20Slug", api)).status).toBe(404);
  });

  it("draws what to fix beside each question, with the answers as typed, and sends nothing", async () => {
    const { api, calls } = client(form());
    const page = await (await get("/f/ask-about-a-trial", api)).text();
    const response = await post(
      "/f/ask-about-a-trial",
      [...hidden(page), ["a.email", "not-an-address"], ["a.before", "no"]],
      api,
    );
    expect(response.status).toBe(422);
    const html = await response.text();
    expect(calls.filter((c) => c.name === "x.forms.submit")).toEqual([]);
    expect(html).toContain('role="alert"');
    expect(html).toContain('<a href="#f-name">Your name: Answer this question</a>');
    expect(html).toMatch(
      /id="f-email" name="a.email" required aria-invalid="true" aria-describedby="h-email e-email"/,
    );
    expect(html).toContain('<p class="error" id="e-email">Enter an email address');
    expect(html).toContain('value="not-an-address"');
    expect(html).toContain('value="no" checked');
  });

  it("sends the answers with the page's key, the shown token, Turnstile's token and the honeypot", async () => {
    const { api, calls } = client(form());
    const page = await (await get("/f/ask-about-a-trial", api)).text();
    const fields = hidden(page);
    const key = Object.fromEntries(fields)._key;
    const response = await post(
      "/f/ask-about-a-trial",
      [
        ...fields,
        ["a.name", " Ada "],
        ["a.email", "ada@example.com"],
        ["a.before", "no"],
        ["a.where", "ignored while hidden"],
        ["cf-turnstile-response", "tt"],
        ["website", ""],
      ],
      api,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Thanks, we will be in touch.");
    expect(calls.at(-1)).toEqual({
      name: "x.forms.submit",
      key,
      input: {
        id: "rec_form",
        version: 2,
        answers: { name: "Ada", email: "ada@example.com", before: false, news: false },
        via: "page",
        shown: "v1.shown",
        turnstileToken: "tt",
      },
    });
  });

  it("shows the host's refusal, with the answers kept, rather than thanks", async () => {
    const { api } = client(form(), async () => {
      throw Object.assign(new Error("The spam check did not pass: try again"), {
        code: "tool_failed",
        details: { code: "invalid_input", details: { rule: "turnstile" } },
      });
    });
    const page = await (await get("/f/ask-about-a-trial", api)).text();
    const response = await post(
      "/f/ask-about-a-trial",
      [...hidden(page), ["a.name", "Ada"], ["a.email", "ada@example.com"]],
      api,
    );
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).not.toContain("Thanks, we will be in touch.");
    expect(html).toContain("The spam check did not pass: try again");
    expect(html).toContain('value="Ada"');
  });

  it("refuses a send from another site", async () => {
    const { api, calls } = client(form());
    const response = await post("/f/ask-about-a-trial", [], api, {
      origin: "https://elsewhere.example",
    });
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
    expect(
      (await post("/f/ask-about-a-trial", [], api, { "sec-fetch-site": "cross-site" })).status,
    ).toBe(403);
  });
});

describe("a personal link's page (the security review of PR #458)", () => {
  const linked = () => form({ turnstile: false, shown: null });

  it("sends no referrer, loads no script from anywhere else and takes the token out of the address", async () => {
    // Even if the host asked for Turnstile, a link's page never loads it.
    const { api, calls } = client(form({ turnstile: true, shown: null }));
    const response = await get(`/form?t=${TOKEN}`, api);
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ name: "x.forms.form", input: { link: TOKEN } }]);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).not.toMatch(/https?:/);
    expect(policy).toContain(`script-src ${await pageScriptSource()};`);
    const html = await response.text();
    expect(thirdPartyScripts(html)).toBe(0);
    expect(html).not.toContain("cf-turnstile");
    expect(html).not.toContain(TURNSTILE_ORIGIN);
    // The script that takes the token out of the address bar, and the form posts to /form alone.
    expect(html).toContain(`<script>${PAGE_SCRIPT}</script>`);
    expect(PAGE_SCRIPT).toContain('url.searchParams.delete("t")');
    expect(PAGE_SCRIPT).toContain("history.replaceState");
    expect(html).toContain('<form method="post" action="/form" data-form>');
    expect(Object.fromEntries(hidden(html))._link).toBe(TOKEN);
    expect(Object.fromEntries(hidden(html))._shown).toBeUndefined();
  });

  it("says a link that cannot be used, or is not complete, plainly", async () => {
    const refused = Object.assign(new Error("This link cannot be used"), {
      code: "tool_failed",
      details: { code: "not_found", details: { rule: "personal_link" } },
    });
    const response = await get(`/form?t=${TOKEN}`, client(refused).api);
    expect(response.status).toBe(404);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).toContain("This link cannot be used");
    const { api, calls } = client(linked());
    expect((await get("/form?t=short", api)).status).toBe(404);
    expect((await get("/form", api)).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("sends the answers by the token from the page's hidden field, with no spam check", async () => {
    const { api, calls } = client(linked());
    const page = await (await get(`/form?t=${TOKEN}`, api)).text();
    const response = await post(
      "/form",
      [...hidden(page), ["a.name", "Ada"], ["a.email", "ada@example.com"]],
      api,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(calls.at(-1)?.input).toEqual({
      id: "rec_form",
      version: 2,
      answers: { name: "Ada", email: "ada@example.com", news: false },
      link: TOKEN,
    });
  });
});
