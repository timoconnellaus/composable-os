// The Forms pack's headless entry (stage 29 step 4): its plain functions, and its hooks over a
// stand-in client and stand-in React. apps/runner/test/forms-page.test.ts drives the form page,
// built on the same functions, against the real host.
import { describe, expect, it } from "vitest";
import {
  answersFrom,
  checkDraft,
  createFormsHooks,
  draftFromFields,
  type FormsClient,
  fieldName,
  type OpenedForm,
  type Questions,
  ratingValues,
  refusalOf,
  shownItems,
  takeLinkToken,
  type UseMutation,
  type UseQuery,
  type UseState,
} from "../client/index.ts";

const questions: Questions = {
  items: [
    { kind: "heading", key: "about", text: "About you" },
    {
      kind: "text",
      key: "name",
      label: "Your name",
      required: true,
      map: { to: "person", field: "name" },
    },
    { kind: "email", key: "email", label: "Email", required: true },
    { kind: "phone", key: "phone", label: "Phone" },
    { kind: "number", key: "age", label: "Age", integer: true, min: 5, max: 99 },
    { kind: "date", key: "start", label: "When could you start?" },
    { kind: "choice", key: "time", label: "Best time", options: ["Morning", "Evening"] },
    { kind: "choice", key: "days", label: "Days", options: ["Mon", "Wed", "Fri"], multiple: true },
    { kind: "rating", key: "score", label: "How did you hear of us?", scale: "ten" },
    { kind: "yesNo", key: "before", label: "Trained before?" },
    {
      kind: "text",
      key: "where",
      label: "Where?",
      long: true,
      showIf: { question: "before", is: "yes" },
    },
    { kind: "consent", key: "news", words: "Keep me updated", purpose: "marketing" },
    {
      kind: "consent",
      key: "terms",
      words: "I agree to be contacted",
      purpose: "contact",
      required: true,
    },
    { kind: "paragraph", key: "note", content: [{ type: "text", text: "Thanks!" }] },
  ],
};

const opened = (extra: Partial<OpenedForm> = {}): OpenedForm => ({
  id: "rec_form",
  version: 3,
  title: "Ask about a trial",
  questions: questions as unknown as OpenedForm["questions"],
  thanks: "We will be in touch.",
  anonymous: false,
  turnstile: true,
  shown: "v1.shown",
  ...extra,
});

describe("plain functions", () => {
  it("trims and converts what was typed, leaves out what was not answered, and a hidden question", () => {
    expect(
      answersFrom(questions, {
        name: "  Ada Lovelace ",
        email: "ada@example.com",
        phone: "",
        age: " 36 ",
        time: "Evening",
        days: [],
        score: 7,
        before: false,
        where: "Somewhere",
        news: false,
      }),
    ).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
      age: 36,
      time: "Evening",
      score: 7,
      before: false,
      news: false,
      terms: false,
    });
    // A number that is no number is sent as typed, for the check to name.
    expect(answersFrom(questions, { age: "lots" }).age).toBe("lots");
    // A long text keeps its lines.
    expect(answersFrom(questions, { before: true, where: "a\r\nb " }).where).toBe("a\nb");
  });

  it("shows a question only while the answer it waits on holds", () => {
    const keys = (draft: Record<string, unknown>) =>
      shownItems(questions, draft as never).map((i) => i.key);
    expect(keys({})).not.toContain("where");
    expect(keys({ before: false })).not.toContain("where");
    expect(keys({ before: true })).toContain("where");
  });

  it("reads a page's posted fields back as a draft", () => {
    const posted = new URLSearchParams([
      [fieldName("name"), "Ada"],
      [fieldName("days"), "Mon"],
      [fieldName("days"), "Fri"],
      [fieldName("score"), "9"],
      [fieldName("before"), "yes"],
      [fieldName("terms"), "yes"],
    ]);
    const draft = draftFromFields(questions, (name) => posted.getAll(name));
    expect(draft).toMatchObject({
      name: "Ada",
      days: ["Mon", "Fri"],
      score: 9,
      before: true,
      news: false,
      terms: true,
      time: "",
    });
    expect(draftFromFields(questions, () => ["x"]).score).toBeNull();
  });

  it("checks the answers as the host does, in a person's words by question", () => {
    const checked = checkDraft(questions, { email: "not an address", age: "4", terms: false });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.byKey).toEqual({
      name: "Answer this question",
      email: "Enter an email address, like name@example.com",
      age: "Enter a number: at least 5",
      terms: "Tick this box to send the form",
    });
    const good = checkDraft(questions, { name: "Ada", email: "ada@example.com", terms: true });
    expect(good).toEqual({
      ok: true,
      answers: { name: "Ada", email: "ada@example.com", news: false, terms: true },
    });
  });

  it("offers 1 to 5 stars or 0 to 10", () => {
    expect(ratingValues({ scale: "stars" })).toEqual([1, 2, 3, 4, 5]);
    expect(ratingValues({ scale: "ten" })).toHaveLength(11);
  });

  it("reads the host's refusals, a tool's inside the surface's", () => {
    const tool = (code: string, details: Record<string, unknown>, message = "words") =>
      Object.assign(new Error(message), {
        name: "ApiError",
        code: "tool_failed",
        details: { code, details },
      });
    expect(
      refusalOf(
        tool("invalid_input", {
          rule: "answers",
          issues: [{ key: "email", fault: "type", message: "Expected an email address" }],
        }),
        questions,
      ),
    ).toMatchObject({ kind: "answers", byKey: { email: expect.stringContaining("email") } });
    expect(refusalOf(tool("invalid_input", { rule: "intake_reload" })).kind).toBe("reload");
    expect(refusalOf(tool("invalid_input", { rule: "turnstile" })).kind).toBe("check");
    expect(refusalOf(tool("rate_limited", { rule: "intake_cap" }), questions).kind).toBe("later");
    expect(
      refusalOf(tool("not_found", { rule: "personal_link" }, "This link cannot be used")),
    ).toEqual({ kind: "gone", message: "This link cannot be used" });
    expect(refusalOf(tool("not_found", {})).kind).toBe("gone");
    expect(refusalOf(Object.assign(new Error("x"), { name: "NetworkError" })).kind).toBe("offline");
    expect(refusalOf(new Error("boom")).kind).toBe("other");
  });

  it("takes a personal link's token out of the address once read", () => {
    const replaced: string[] = [];
    const token = takeLinkToken({
      location: { href: "https://gym.example/form?t=abc&x=1#top" },
      history: { replaceState: (_d, _u, url) => replaced.push(String(url)) },
    });
    expect(token).toBe("abc");
    expect(replaced).toEqual(["/form?x=1#top"]);
    expect(
      takeLinkToken({
        location: { href: "https://gym.example/form" },
        history: { replaceState: () => replaced.push("again") },
      }),
    ).toBeNull();
    expect(replaced).toHaveLength(1);
  });
});

// --- The hooks, over stand-ins -------------------------------------------------------------------

/** A stand-in React: state that holds between renders of one "component". */
function harness() {
  const cells: unknown[] = [];
  let at = 0;
  const stateHook: UseState = <T>(initial: T) => {
    const i = at++;
    if (!(i in cells)) cells[i] = initial;
    const set = (next: T | ((previous: T) => T)) => {
      cells[i] = typeof next === "function" ? (next as (p: T) => T)(cells[i] as T) : next;
    };
    return [cells[i] as T, set];
  };
  const calls: { name: string; input: unknown }[] = [];
  let answer: (name: string, input: unknown) => Promise<unknown> = async () => ({ received: true });
  const queries: Record<string, unknown>[] = [];
  const queryHook = ((options: Record<string, unknown>) => {
    queries.push(options);
    return { data: undefined, isPending: true, error: null };
  }) as unknown as UseQuery;
  const mutationHook: UseMutation = (options) => ({
    mutate: () => undefined,
    mutateAsync: (input) => options.mutationFn(input),
    data: undefined,
    isPending: false,
    error: null,
    reset: () => undefined,
  });
  const client = {
    operations: {
      "x.forms.form": {},
      "x.forms.submit": {},
    },
    query: (name: string, input: unknown) => ({
      queryKey: [name, input],
      queryFn: async () => answer(name, input),
    }),
    mutation: (name: string) => ({
      mutationKey: [name],
      mutationFn: (input: unknown) => {
        calls.push({ name, input });
        return answer(name, input);
      },
    }),
  } as unknown as FormsClient & { operations: Record<"x.forms.form" | "x.forms.submit", unknown> };
  const hooks = createFormsHooks(
    { useQuery: queryHook, useMutation: mutationHook, useState: stateHook },
    client,
  );
  return {
    hooks,
    calls,
    queries,
    answers: (fn: typeof answer) => {
      answer = fn;
    },
    render<T>(fn: () => T): T {
      at = 0;
      return fn();
    },
  };
}

describe("hooks", () => {
  it("keeps an opened form as first opened: its shown time never restarts (review of PR #461)", () => {
    const h = harness();
    h.render(() => h.hooks.useForm({ slug: "ask-about-a-trial" }));
    expect(h.queries[0]).toMatchObject({
      queryKey: ["x.forms.form", { slug: "ask-about-a-trial" }],
      gcTime: 0,
      staleTime: Number.POSITIVE_INFINITY,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    });
  });

  it("gives a client only the hooks it can back", () => {
    const { hooks } = harness();
    expect(Object.keys(hooks).sort()).toEqual(["useAnswer", "useForm"]);
  });

  it("sends a visitor's answers with the shown token, the way in, Turnstile and the honeypot", async () => {
    const h = harness();
    const form = opened();
    let filler = h.render(() => h.hooks.useAnswer(form, { via: "site" }));
    filler.set("name", "Ada");
    filler.set("email", "ada@example.com");
    filler.set("terms", true);
    filler = h.render(() => h.hooks.useAnswer(form, { via: "site" }));
    expect(await filler.send({ turnstileToken: "tt", honeypot: "" })).toBe(true);
    expect(h.calls).toEqual([
      {
        name: "x.forms.submit",
        input: {
          id: "rec_form",
          version: 3,
          answers: { name: "Ada", email: "ada@example.com", news: false, terms: true },
          via: "site",
          shown: "v1.shown",
          turnstileToken: "tt",
        },
      },
    ]);
    filler = h.render(() => h.hooks.useAnswer(form, { via: "site" }));
    expect(filler.status).toBe("sent");
    expect(filler.thanks).toBe("We will be in touch.");
    // Sent: what was typed is not kept.
    expect(filler.draft).toEqual({});
  });

  it("by a personal link sends the token and nothing of the spam checks", async () => {
    const h = harness();
    const form = opened({ turnstile: false, shown: null });
    let filler = h.render(() => h.hooks.useAnswer(form, { via: "site", link: "tok" }));
    filler.set("name", "Ada");
    filler.set("email", "ada@example.com");
    filler.set("terms", true);
    filler = h.render(() => h.hooks.useAnswer(form, { via: "site", link: "tok" }));
    await filler.send({});
    expect(h.calls[0]?.input).toEqual({
      id: "rec_form",
      version: 3,
      answers: { name: "Ada", email: "ada@example.com", news: false, terms: true },
      link: "tok",
    });
  });

  it("does not send what the check finds wrong, and shows a host refusal with the answers kept", async () => {
    const h = harness();
    const form = opened();
    let filler = h.render(() => h.hooks.useAnswer(form, { via: "site" }));
    expect(await filler.send({ turnstileToken: "tt" })).toBe(false);
    expect(h.calls).toEqual([]);
    filler = h.render(() => h.hooks.useAnswer(form, { via: "site" }));
    expect(filler.errors).toMatchObject({ name: "Answer this question" });

    filler.set("name", "Ada");
    filler.set("email", "ada@example.com");
    filler.set("terms", true);
    // The host refuses (the spam check did not pass): not sent, the answers still there.
    h.answers(async () => {
      throw Object.assign(new Error("The spam check did not pass: try again"), {
        name: "ApiError",
        code: "tool_failed",
        details: { code: "invalid_input", details: { rule: "turnstile" } },
      });
    });
    filler = h.render(() => h.hooks.useAnswer(form, { via: "site" }));
    expect(await filler.send({ turnstileToken: "bad" })).toBe(false);
    filler = h.render(() => h.hooks.useAnswer(form, { via: "site" }));
    expect(filler.status).toBe("filling");
    expect(filler.problem).toEqual({
      kind: "check",
      message: "The spam check did not pass: try again",
    });
    expect(filler.draft).toMatchObject({ name: "Ada", email: "ada@example.com" });
  });
});
