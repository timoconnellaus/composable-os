// The Forms pack's headless entry (stage 29 step 4; ADR 0418): functions and hooks over the typed
// client, no markup. A client app imports it as `@composable-os/pack-forms/client` and hands it its
// generated client; the forms blocks (web and native) and the host's form page render what it
// returns. Web and native share this logic, not their screens.
//
// As every pack's entry: the operations are typed from the pack's own tool schemas, it takes the
// client and the app's `useQuery`, `useMutation` and `useState` as arguments (no React or TanStack
// import), and it holds no rules. Whether a form takes answers from this caller, who may answer,
// once only, the spam checks, the caps and the answers' shape are the host's (`x.forms.submit`,
// the intake door, ADR 0720). Before sending, the answers are checked with the same
// `checkAnswers` the host runs, so a person sees what to fix beside the question at once; the
// host checks them again and its answer is the one shown.
//
// What a person types is kept in the screen's own state while they fill the form, and nowhere
// else: never in a URL, browser storage or a log, and the send is forgotten by the app's cache
// once it is over (`forgetAfter`).
import {
  type ClientHolding,
  forgetAfter,
  type PackClient,
  packHooks,
  type UseMutation,
  type UseQuery,
} from "@composable-os/client";
import type { z } from "@composable-os/sdk";
import {
  type AnswerIssue,
  checkAnswers,
  isQuestionShown,
  type QuestionItem,
  type Questions,
} from "@composable-os/sdk/questions";
import type { form, linkedForm, submit, submitLinked } from "../tools.ts";

type Io<T extends { input: z.ZodType; output: z.ZodType }> = {
  input: z.input<T["input"]>;
  output: z.output<T["output"]>;
};

/** The operations this entry calls, as the generated client types them. */
export type FormsOperations = {
  "x.forms.form": { kind: "query" } & Io<typeof form>;
  "x.forms.linkedForm": { kind: "query" } & Io<typeof linkedForm>;
  "x.forms.submit": { kind: "mutation" } & Io<typeof submit>;
  "x.forms.submitLinked": { kind: "mutation" } & Io<typeof submitLinked>;
};

type Name = keyof FormsOperations & string;
type In<N extends Name> = FormsOperations[N]["input"];
type Out<N extends Name> = FormsOperations[N]["output"];

/** A form as the host opened it for the caller: its version, questions, thanks and checks. */
export type OpenedForm = Out<"x.forms.form">;
export type SubmitInput = In<"x.forms.submit">;

/** What a client says about each operation at run time (a generated client's specs). */
export const FORMS_OPERATIONS = {
  "x.forms.form": { kind: "query", invalidates: [] },
  "x.forms.linkedForm": { kind: "query", invalidates: [] },
  "x.forms.submit": { kind: "mutation", invalidates: [] },
  "x.forms.submitLinked": { kind: "mutation", invalidates: ["me.attention"] },
} as const;

/** The client of every operation this entry calls. */
export type FormsClient = PackClient<FormsOperations>;

export type { QuestionItem, Questions } from "@composable-os/sdk/questions";

// --- The form's questions ------------------------------------------------------------------------

/** The questions of a form the host opened, typed: the host checked them when it was published. */
export function formQuestions(opened: Pick<OpenedForm, "questions">): Questions {
  return { items: opened.questions.items as unknown as QuestionItem[] };
}

/** A question a person answers (not a heading or a paragraph). */
export type AskedItem = Exclude<QuestionItem, { kind: "heading" | "paragraph" }>;

/** Whether an item asks something. */
export function isAsked(item: QuestionItem): item is AskedItem {
  return item.kind !== "heading" && item.kind !== "paragraph";
}

/**
 * What a screen holds for each question while a person fills the form, by key: text, email,
 * phone, number and date as the text typed; a single choice as the option; a choice of several as
 * the options; a rating as its number; yes/no as true, false or null (not answered); a tick box as
 * true or false.
 */
export type DraftValue = string | string[] | number | boolean | null;
export type Draft = Readonly<Record<string, DraftValue>>;

/** The ratings a rating question offers: 1 to 5 stars, or 0 to 10. */
export function ratingValues(item: { scale: "stars" | "ten" }): number[] {
  return item.scale === "stars" ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
}

/** The words beside a rating's number, for a screen reader and a button's label. */
export function ratingLabel(item: { scale: "stars" | "ten" }, value: number): string {
  if (item.scale === "stars") return value === 1 ? "1 star" : `${value} stars`;
  return `${value} out of 10`;
}

/** The value one draft entry sends, or undefined when it is no answer. */
function answerOf(item: AskedItem, value: DraftValue | undefined): unknown {
  switch (item.kind) {
    case "text":
    case "email":
    case "phone":
    case "date": {
      if (typeof value !== "string") return undefined;
      // Typed text is trimmed at its ends; a long text keeps its lines, written as \n.
      const text = (item.kind === "text" && item.long ? value.replace(/\r\n?/g, "\n") : value)
        .trim()
        .normalize("NFC");
      return text === "" ? undefined : text;
    }
    case "number": {
      const text =
        typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
      const trimmed = text.trim().replace(",", ".");
      if (trimmed === "") return undefined;
      const n = Number(trimmed);
      // Not a number: sent as typed, so the check names it.
      return Number.isFinite(n) ? n : trimmed;
    }
    case "rating":
      return typeof value === "number" ? value : undefined;
    case "choice":
      if (item.multiple) return Array.isArray(value) && value.length ? [...value] : undefined;
      return typeof value === "string" && value !== "" ? value : undefined;
    case "yesNo":
      return typeof value === "boolean" ? value : undefined;
    case "consent":
      // A tick box left unticked is sent as false.
      return value === true;
  }
}

/**
 * The answers to send, from what the screen holds: trimmed and converted as `checkAnswers` takes
 * them, unanswered questions left out, and nothing for a question that is not shown.
 */
export function answersFrom(questions: Questions, draft: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of questions.items) {
    if (!isAsked(item)) continue;
    const value = answerOf(item, Object.hasOwn(draft, item.key) ? draft[item.key] : undefined);
    if (value !== undefined) out[item.key] = value;
  }
  // A question shown only if an earlier one has a value takes no answer while it is hidden.
  for (const item of questions.items) {
    if (Object.hasOwn(out, item.key) && !isQuestionShown(item, questions, out))
      delete out[item.key];
  }
  return out;
}

/** The items to draw now: those with no "show only if", or whose condition holds. */
export function shownItems(questions: Questions, draft: Draft): QuestionItem[] {
  const answers = answersFrom(questions, draft);
  return questions.items.filter((item) => isQuestionShown(item, questions, answers));
}

/** The name a form field has on a page drawn as HTML (the host's form page): `a.<key>`. */
export const fieldName = (key: string) => `a.${key}`;

/** The hidden field a person leaves empty (the honeypot): a bot fills every field. */
export const HONEYPOT_FIELD = "website";

/**
 * What a page drawn as HTML posted, as a draft: `values(name)` gives every value posted under a
 * field's name (a choice of several, several). The reverse of the page's fields.
 */
export function draftFromFields(questions: Questions, values: (name: string) => string[]): Draft {
  const draft: Record<string, DraftValue> = {};
  for (const item of questions.items) {
    if (!isAsked(item)) continue;
    const given = values(fieldName(item.key));
    const first = given[0] ?? "";
    switch (item.kind) {
      case "choice":
        draft[item.key] = item.multiple ? given.filter((v) => v !== "") : first;
        break;
      case "rating":
        draft[item.key] = /^\d{1,2}$/.test(first) ? Number(first) : null;
        break;
      case "yesNo":
        draft[item.key] = first === "yes" ? true : first === "no" ? false : null;
        break;
      case "consent":
        draft[item.key] = first !== "";
        break;
      default:
        draft[item.key] = first;
    }
  }
  return draft;
}

// --- What is wrong, in a person's words ----------------------------------------------------------

/** Faults by question key, in a person's words, and anything about the form as a whole. */
export interface AnswerErrors {
  byKey: Readonly<Record<string, string>>;
  general: string | null;
}

/** The words to show beside a question for one fault the check found (never its value). */
export function issueWords(issue: AnswerIssue, item: QuestionItem | undefined): string {
  // The host's own faults go beyond the check's (a tick only the person may give: "consent").
  switch (issue.fault as AnswerIssue["fault"] | "consent") {
    case "required":
      if (item?.kind === "consent") return "Tick this box to send the form";
      if (item?.kind === "choice" || item?.kind === "rating" || item?.kind === "yesNo")
        return "Choose an answer";
      return "Answer this question";
    case "type":
      switch (item?.kind) {
        case "email":
          return "Enter an email address, like name@example.com";
        case "phone":
          return "Enter a phone number";
        case "date":
          return "Enter a date, as year-month-day (2026-03-02)";
        case "rating":
          return "Choose a rating";
        case "choice":
          return "Choose from the options";
        case "number":
          if (issue.message === "Expected a whole number") return "Enter a whole number";
          if (issue.message === "Expected a number") return "Enter a number";
          return `Enter a number: ${issue.message.toLowerCase()}`;
        case "text":
          return issue.message === "One line only" ? "Write this on one line" : "Use plain text";
        default:
          return "Check this answer";
      }
    case "length":
      return issue.message;
    case "links":
      return issue.message;
    case "hidden":
      return "This question is not asked now: clear it";
    case "consent":
      return "Only the person themselves may tick this";
    default:
      return "Check this answer";
  }
}

/** The faults of a check, by key and in a person's words. */
export function errorsOf(questions: Questions, issues: readonly AnswerIssue[]): AnswerErrors {
  const byKey: Record<string, string> = {};
  let general: string | null = null;
  for (const issue of issues) {
    const item = issue.key ? questions.items.find((q) => q.key === issue.key) : undefined;
    if (issue.key && item) {
      byKey[issue.key] ??= issueWords(issue, item);
    } else {
      general ??=
        issue.fault === "size"
          ? "The answers are too long to send: shorten them"
          : "Some answers could not be sent: load the form again";
    }
  }
  return { byKey, general };
}

/**
 * The answers to send, or what to fix first: the same check the host makes (the host makes it
 * again and its answer is the one that counts).
 */
export function checkDraft(
  questions: Questions,
  draft: Draft,
): { ok: true; answers: Record<string, unknown> } | ({ ok: false } & AnswerErrors) {
  const answers = answersFrom(questions, draft);
  const checked = checkAnswers(questions, answers);
  if (checked.ok) return { ok: true, answers };
  return { ok: false, ...errorsOf(questions, checked.issues) };
}

/**
 * What the host said when it did not take the answers, for the screen to show:
 * - `answers`: some answers need another look (by key);
 * - `reload`: the form changed, or was open a long time: load it again;
 * - `check`: the spam check (Turnstile) did not run or did not pass: try again;
 * - `later`: too many answers just now, or the check could not be made: try again later;
 * - `gone`: the form is not open to this caller now, or a personal link cannot be used;
 * - `closed`: the form takes no answers from people who are not signed in here;
 * - `offline`: the host could not be reached (what was typed is still on the screen);
 * - `other`: anything else.
 */
export type Refusal =
  | ({ kind: "answers"; message: string } & AnswerErrors)
  | {
      kind: "reload" | "check" | "later" | "gone" | "closed" | "offline" | "other";
      message: string;
    };

const rec = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;

/** The host's answer as a Refusal. */
export function refusalOf(error: unknown, questions?: Questions): Refusal {
  const e = rec(error);
  if (e?.name === "NetworkError") {
    return {
      kind: "offline",
      message:
        "We could not reach the business just now. Check your connection and try again: what you entered is still here.",
    };
  }
  // A tool's refusal comes back inside the surface's: its code and details are the door's.
  const details = rec(e?.details);
  const inner = rec(details?.details) ?? details;
  const code = typeof details?.code === "string" ? details.code : String(e?.code ?? "");
  const rule = typeof inner?.rule === "string" ? inner.rule : null;
  const said = typeof e?.message === "string" && e.message ? e.message : null;
  if (rule === "answers" && Array.isArray(inner?.issues) && questions) {
    const errors = errorsOf(questions, inner.issues as AnswerIssue[]);
    return { kind: "answers", message: "Some answers need another look", ...errors };
  }
  if (rule === "intake_reload") {
    return { kind: "reload", message: said ?? "This form has changed: load it again and send" };
  }
  if (rule === "turnstile") {
    return { kind: "check", message: said ?? "The spam check did not pass: try again" };
  }
  if (rule === "intake_unavailable") {
    return {
      kind: "closed",
      message: said ?? "This form is not taking answers here just now",
    };
  }
  if (rule === "personal_link") {
    return {
      kind: "gone",
      message: said ?? "This link cannot be used: it may have been used already or have expired",
    };
  }
  if (code === "rate_limited" || rule === "intake_cap" || rule === "turnstile_unavailable") {
    return { kind: "later", message: said ?? "Too many answers just now: try again later" };
  }
  if (code === "not_found") {
    return { kind: "gone", message: "This form is not open just now" };
  }
  return { kind: "other", message: "We could not send your answers. Try again in a moment." };
}

// --- A personal link in a web page ---------------------------------------------------------------

/** The query parameter a personal link's token travels in (the SDK's PERSONAL_LINK_PARAM). */
export const LINK_PARAM = "t";

/**
 * A personal link's token, read from the page's address once and taken out of it at once
 * (`history.replaceState`), so it is not left in the address bar, the history or a bookmark, nor
 * sent on as a referrer. The caller keeps it in memory only, for the send. Null with none.
 */
export function takeLinkToken(page: {
  location: { href: string };
  history: { replaceState(data: unknown, unused: string, url?: string): void };
}): string | null {
  const url = new URL(page.location.href);
  const token = url.searchParams.get(LINK_PARAM);
  if (token === null) return null;
  url.searchParams.delete(LINK_PARAM);
  page.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  return token || null;
}

// --- Hooks ---------------------------------------------------------------------------------------

/** The app's `useState`. */
export type UseState = <T>(initial: T) => [T, (next: T | ((previous: T) => T)) => void];

export type { UseMutation, UseQuery } from "@composable-os/client";

/** Where a form is filled in (the submission's `via`): the business's website or its app. */
export type Via = "site" | "app" | "page";

/** What a filler is doing. */
export type FillStatus = "filling" | "sending" | "sent";

/** The extra a send carries: a visitor's Turnstile token and the honeypot field's value. */
export interface SendChecks {
  turnstileToken?: string | null;
  honeypot?: string;
}

/**
 * The operations each hook calls (ADR 0453). A customer's or the public's client gets `useForm`
 * and `useAnswer`; a signed-in customer's also `useLinkedForm` and `useAnswerLinked`, for a form
 * from Needs your attention.
 */
export const FORMS_HOOKS_CALL = {
  useForm: ["x.forms.form"],
  useLinkedForm: ["x.forms.linkedForm"],
  useAnswer: ["x.forms.submit"],
  useAnswerLinked: ["x.forms.submitLinked"],
} as const;

type React = { useQuery: UseQuery; useMutation: UseMutation; useState: UseState };

/**
 * Hooks for a React or React Native app:
 * `const forms = createFormsHooks({ useQuery, useMutation, useState }, api)`. `api` is the
 * customer's generated client (signed in, or the public).
 */
export function createFormsHooks<C extends ClientHolding>(react: React, client: C) {
  return packHooks(client, FORMS_HOOKS_CALL, (api: FormsClient) => allFormsHooks(react, api));
}

/** One form's state while it is filled: the draft, what is shown, the faults and the send. */
function useFiller(
  react: React,
  form: OpenedForm | undefined,
  send: (answers: Record<string, unknown>, checks: SendChecks) => Promise<unknown>,
) {
  const { useState } = react;
  const [draft, setDraft] = useState<Draft>({});
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [problem, setProblem] = useState<Refusal | null>(null);
  const [status, setStatus] = useState<FillStatus>("filling");
  const questions = form ? formQuestions(form) : { items: [] };
  return {
    draft,
    /** The items to draw now, in order (headings and paragraphs among them). */
    items: shownItems(questions, draft),
    /** What to fix, by question key. */
    errors,
    /** What the host (or the connection) said, for the form as a whole. */
    problem,
    status,
    /** The words to show once sent: the form's own thank-you, or a plain one. */
    thanks: form?.thanks ?? "Thank you. Your answers were sent.",
    set(key: string, value: DraftValue) {
      setDraft((previous) => ({ ...previous, [key]: value }));
      // A fault goes once the person changes that answer.
      setErrors((previous) => {
        if (!Object.hasOwn(previous, key)) return previous;
        const { [key]: _gone, ...rest } = previous;
        return rest;
      });
    },
    /**
     * Checks the answers as the host will, then sends them. True when the host took them. A
     * refusal stays on the screen (`problem`, `errors`), with the answers as typed.
     */
    async send(checks: SendChecks = {}): Promise<boolean> {
      if (!form || status === "sending") return false;
      setProblem(null);
      const checked = checkDraft(questions, draft);
      if (!checked.ok) {
        setErrors(checked.byKey);
        setProblem(
          checked.general
            ? { kind: "answers", message: checked.general, byKey: checked.byKey, general: null }
            : null,
        );
        return false;
      }
      setErrors({});
      setStatus("sending");
      try {
        await send(checked.answers, checks);
        setStatus("sent");
        // Sent: nothing the person typed is kept on the screen any more.
        setDraft({});
        return true;
      } catch (error) {
        const refusal = refusalOf(error, questions);
        if (refusal.kind === "answers") setErrors(refusal.byKey);
        setProblem(refusal);
        setStatus("filling");
        return false;
      }
    },
  };
}

function allFormsHooks(react: React, api: FormsClient) {
  const { useQuery, useMutation } = react;
  return {
    /**
     * A form as the caller may answer it now: by its address (`slug`), or by a personal link's
     * token (`link`, which opening uses nothing of). Not found when it is not open to them.
     */
    useForm(which: { slug: string } | { link: string } | null) {
      const options = which
        ? api.query("x.forms.form", which)
        : { queryKey: ["x.forms.form", null], queryFn: async () => undefined as never };
      return useQuery<OpenedForm>({ ...options, enabled: which !== null, gcTime: 0 });
    },
    /** The form a signed-in member's own personal link is for (Needs your attention's `linkId`). */
    useLinkedForm(linkId: string | null) {
      const options = linkId
        ? api.query("x.forms.linkedForm", { linkId })
        : { queryKey: ["x.forms.linkedForm", null], queryFn: async () => undefined as never };
      return useQuery<OpenedForm>({ ...options, enabled: linkId !== null, gcTime: 0 });
    },
    /**
     * Filling in a form `useForm` opened, and sending it: on the business's website (`site`) or
     * its app (`app`), or by a personal link's token (`link`).
     */
    useAnswer(form: OpenedForm | undefined, way: { via: Via; link?: string | null }) {
      const submitting = useMutation({ ...api.mutation("x.forms.submit"), gcTime: 0 });
      return useFiller(react, form, (answers, checks) => {
        if (!form) throw new Error("No form to send");
        const input: SubmitInput = {
          id: form.id,
          version: form.version,
          answers,
          ...(way.link ? { link: way.link } : { via: way.via }),
          ...(!way.link && form.shown ? { shown: form.shown } : {}),
          ...(checks.turnstileToken ? { turnstileToken: checks.turnstileToken } : {}),
          ...(checks.honeypot ? { honeypot: checks.honeypot } : {}),
        };
        return forgetAfter(submitting, input);
      });
    },
    /** Filling in and sending the form of a signed-in member's own personal link, by its id. */
    useAnswerLinked(form: OpenedForm | undefined, linkId: string | null) {
      const submitting = useMutation({ ...api.mutation("x.forms.submitLinked"), gcTime: 0 });
      return useFiller(react, form, (answers, checks) => {
        if (!form || !linkId) throw new Error("No form to send");
        return forgetAfter(submitting, {
          linkId,
          id: form.id,
          version: form.version,
          answers,
          ...(checks.honeypot ? { honeypot: checks.honeypot } : {}),
        });
      });
    },
  };
}

/** Every hook of this entry. A block takes the ones it calls: `Pick<FormsHooks, "useForm">`. */
export type FormsHooks = ReturnType<typeof allFormsHooks>;

/** What a filler hook returns (`useAnswer`, `useAnswerLinked`). */
export type Filler = ReturnType<FormsHooks["useAnswer"]>;
