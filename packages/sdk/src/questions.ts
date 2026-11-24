// The question schema (stage 29, step 1): what a form asks, as a document field (ADR 0445) with
// one fixed schema the platform owns, as rich text is. A form's questions field is one:
//
//   questions: { type: "document", label: "Questions", schema: QUESTIONS_SCHEMA,
//                maxBytes: QUESTIONS_MAX_BYTES }
//
// The value is `{ items: [...] }`, at most 60 items told apart by `kind`, each with a stable `key`
// (camelCase, unique in the form). The questions: `text` (short, or `long` for several lines, with
// a maximum length), `email`, `phone`, `number` (min, max, whole), `choice` (single or `multiple`,
// up to 50 options), `date`, `rating` (`stars`, 1 to 5, or `ten`, 0 to 10), `yesNo`, and `consent`
// (a tick box: its exact `words`, its `purpose`: contact, marketing or other). The non-questions:
// `heading` and `paragraph` (rich text's inline runs). There is no health kind, no signature and no
// payment: those are Agreements' (stage 44) and orders'. A `file` kind is added with the trades work.
//
// Any item may be shown only if one earlier `choice` or `yesNo` has a value (`showIf`), one level
// deep: the item it names has no `showIf` of its own. A question may `map` to the submitter's Person
// (name from a short text, email from an email, phone from a phone) or to a field of the form's
// destination object; each target is filled from one question at most. A marketing consent line is
// never required (consent is not a condition of being heard).
//
// Two checks. `checkQuestions` is the document check plus what a schema cannot say (keys, earlier
// items, maps, options). `checkAnswers` checks what a person sent against one version's questions
// and gives the answers document a submission stores (`ANSWERS_SCHEMA`), in the questions' order.
// Its faults name the question's key and never the value, so they can go in an error or an audit
// row. It never repairs a value: a client trims and converts before it sends.
import { z } from "zod";
import {
  DOCUMENT_MAX_ISSUES,
  type DocumentIssue,
  type DocumentNode,
  type DocumentObjectNode,
  type DocumentSchema,
  documentBytes,
  validateDocument,
} from "./document.ts";
import { RICH_TEXT_SCHEMA } from "./rich-text.ts";

/** The kinds of item, in the order a builder lists them. */
export const QUESTION_KINDS = [
  "text",
  "email",
  "phone",
  "number",
  "choice",
  "date",
  "rating",
  "yesNo",
  "consent",
  "heading",
  "paragraph",
] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

/** The kinds that ask nothing: no answer is given to them. */
export const QUESTION_DISPLAY_KINDS = ["heading", "paragraph"] as const;

/** What a consent line is for. Only `marketing` lines are "keep me updated". */
export const CONSENT_PURPOSES = ["contact", "marketing", "other"] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

/** The Person's fields a question may fill (only where empty: the host's rule, ADR 0721). */
export const QUESTION_PERSON_FIELDS = ["name", "email", "phone"] as const;
export type QuestionPersonField = (typeof QUESTION_PERSON_FIELDS)[number];

/** Items in a form, at most. */
export const QUESTIONS_MAX_ITEMS = 60;
/** Options of a choice, at most. */
export const QUESTION_MAX_OPTIONS = 50;
/** The most a questions value may be, in bytes of its JSON. */
export const QUESTIONS_MAX_BYTES = 262_144;
/** A short text's longest answer, and its default. */
export const SHORT_TEXT_MAX = 500;
export const SHORT_TEXT_DEFAULT = 200;
/** A long text's longest answer, and its default. */
export const LONG_TEXT_MAX = 5000;
/** Links in any one text answer, at most. */
export const ANSWER_MAX_LINKS = 3;
/** The most a submission's answers may be, in bytes of their JSON. */
export const ANSWERS_MAX_BYTES = 20_480;

const KEY_RE = /^[a-z][a-zA-Z0-9]{0,39}$/;
// Control characters other than tab and newline (and a lone carriage return) are refused.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it finds.
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;
// What counts as a link in an answer: an address with a scheme, or one starting `www.`.
const LINK_RE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/gi;
const PHONE_RE = /^\+?[0-9 ().-]{3,40}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const emailShape = z.email().max(320);

// --- The schema ----------------------------------------------------------------------------------

const KEY_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const keyNode: DocumentNode = {
  type: "text",
  min: 1,
  max: 40,
  chars: KEY_CHARS,
  description: "The item's stable key in the form (camelCase): answers are kept by it",
};
const prose = (max: number, extra: Partial<DocumentNode> = {}): DocumentNode =>
  ({ type: "text", max, noMarkup: true, ...extra }) as DocumentNode;
const optional = (node: DocumentNode): DocumentNode => ({ ...node, optional: true });
const flag = (description: string): DocumentNode => ({
  type: "boolean",
  optional: true,
  description,
});
const object = (fields: Record<string, DocumentNode>): DocumentObjectNode => ({
  type: "object",
  fields,
});

/** What every item has: its key and the one condition that shows it. */
const shown = { key: keyNode, showIf: optional({ type: "use", def: "showIf" }) };
/** What every question has besides: its label, help, whether it is required and where it lands. */
const asked = (mapped: boolean) => ({
  ...shown,
  label: prose(300, { min: 1, description: "The question, as the person reads it" }),
  help: optional(prose(500, { multiline: true, description: "A line under the question" })),
  required: flag("The form is not sent without an answer (when the question is shown)"),
  ...(mapped ? { map: optional({ type: "use", def: "map" }) } : {}),
});

const items: Record<QuestionKind, DocumentObjectNode> = {
  text: object({
    ...asked(true),
    long: flag("Several lines (up to 5,000 characters) rather than one (up to 500)"),
    max: optional({ type: "number", integer: true, min: 1, max: LONG_TEXT_MAX }),
  }),
  email: object(asked(true)),
  phone: object(asked(true)),
  number: object({
    ...asked(true),
    min: optional({ type: "number" }),
    max: optional({ type: "number" }),
    integer: flag("Whole numbers only"),
  }),
  choice: object({
    ...asked(true),
    options: {
      type: "array",
      min: 1,
      max: QUESTION_MAX_OPTIONS,
      of: prose(200, { min: 1 }),
      description: "What the person chooses from; an answer is one of these words",
    },
    multiple: flag("Several options may be chosen"),
  }),
  date: object(asked(true)),
  rating: object({
    ...asked(true),
    scale: {
      type: "choice",
      options: ["stars", "ten"],
      description: "stars: 1 to 5; ten: 0 to 10",
    },
  }),
  yesNo: object(asked(true)),
  consent: object({
    ...shown,
    words: prose(1000, {
      min: 1,
      multiline: true,
      description: "The exact words beside the tick box, kept with every answer to this version",
    }),
    purpose: { type: "choice", options: CONSENT_PURPOSES },
    required: flag("The form is not sent unless it is ticked (never for marketing)"),
  }),
  heading: object({ ...shown, text: prose(200, { min: 1 }) }),
  paragraph: object({ ...shown, content: { type: "use", def: "inlines" } }),
};

/** The one schema of every form's questions. */
export const QUESTIONS_SCHEMA: DocumentSchema = {
  root: object({
    items: {
      type: "array",
      max: QUESTIONS_MAX_ITEMS,
      unique: "key",
      of: { type: "union", tag: "kind", variants: items },
    },
  }),
  defs: {
    // Rich text's inline runs, so a paragraph is drawn as any rich text is.
    inlines: (RICH_TEXT_SCHEMA.defs as Record<string, DocumentNode>).inlines as DocumentNode,
    showIf: object({
      question: { ...keyNode, description: "The key of an earlier choice or yes/no" },
      is: prose(200, { min: 1, description: "One of its options, or yes or no" }),
    }),
    map: {
      type: "union",
      tag: "to",
      variants: {
        person: object({ field: { type: "choice", options: QUESTION_PERSON_FIELDS } }),
        destination: object({
          field: { ...keyNode, description: "A field the destination's intake lists" },
        }),
      },
    },
  },
};

/**
 * What a submission stores: the answers, in the questions' order, each with its key and kind.
 * Private: a customer or the public never reads it, not even their own.
 */
export const ANSWERS_SCHEMA: DocumentSchema = {
  root: {
    type: "object",
    private: true,
    fields: {
      answers: {
        type: "array",
        max: QUESTIONS_MAX_ITEMS,
        unique: "key",
        of: {
          type: "union",
          tag: "kind",
          variants: {
            text: object({
              key: keyNode,
              value: { type: "text", max: LONG_TEXT_MAX, multiline: true },
            }),
            email: object({ key: keyNode, value: { type: "text", max: 320 } }),
            phone: object({
              key: keyNode,
              value: { type: "text", max: 40, chars: "+0123456789 ().-" },
            }),
            number: object({ key: keyNode, value: { type: "number" } }),
            choice: object({
              key: keyNode,
              values: {
                type: "array",
                min: 1,
                max: QUESTION_MAX_OPTIONS,
                of: { type: "text", max: 200 },
              },
            }),
            date: object({
              key: keyNode,
              value: { type: "text", min: 10, max: 10, chars: "0123456789-" },
            }),
            rating: object({
              key: keyNode,
              value: { type: "number", integer: true, min: 0, max: 10 },
            }),
            yesNo: object({ key: keyNode, value: { type: "boolean" } }),
            consent: object({ key: keyNode, value: { type: "boolean" } }),
          },
        },
      },
    },
  },
};

// --- The types -----------------------------------------------------------------------------------

export interface QuestionShowIf {
  question: string;
  is: string;
}
export type QuestionMap =
  | { to: "person"; field: QuestionPersonField }
  | { to: "destination"; field: string };

interface ItemBase {
  key: string;
  showIf?: QuestionShowIf;
}
interface AskedBase extends ItemBase {
  label: string;
  help?: string;
  required?: boolean;
  map?: QuestionMap;
}
export interface TextQuestion extends AskedBase {
  kind: "text";
  long?: boolean;
  max?: number;
}
export interface EmailQuestion extends AskedBase {
  kind: "email";
}
export interface PhoneQuestion extends AskedBase {
  kind: "phone";
}
export interface NumberQuestion extends AskedBase {
  kind: "number";
  min?: number;
  max?: number;
  integer?: boolean;
}
export interface ChoiceQuestion extends AskedBase {
  kind: "choice";
  options: string[];
  multiple?: boolean;
}
export interface DateQuestion extends AskedBase {
  kind: "date";
}
export interface RatingQuestion extends AskedBase {
  kind: "rating";
  scale: "stars" | "ten";
}
export interface YesNoQuestion extends AskedBase {
  kind: "yesNo";
}
export interface ConsentQuestion extends ItemBase {
  kind: "consent";
  words: string;
  purpose: ConsentPurpose;
  required?: boolean;
}
export interface HeadingItem extends ItemBase {
  kind: "heading";
  text: string;
}
export interface ParagraphItem extends ItemBase {
  kind: "paragraph";
  /** Rich text's inline runs (ADR 0440). */
  content: unknown[];
}
export type QuestionItem =
  | TextQuestion
  | EmailQuestion
  | PhoneQuestion
  | NumberQuestion
  | ChoiceQuestion
  | DateQuestion
  | RatingQuestion
  | YesNoQuestion
  | ConsentQuestion
  | HeadingItem
  | ParagraphItem;

/** A form's questions field. */
export interface Questions {
  items: QuestionItem[];
}

export type Answer =
  | { kind: "text" | "email" | "phone" | "date"; key: string; value: string }
  | { kind: "number" | "rating"; key: string; value: number }
  | { kind: "yesNo" | "consent"; key: string; value: boolean }
  | { kind: "choice"; key: string; values: string[] };

/** A submission's answers field. */
export interface Answers {
  answers: Answer[];
}

// --- Checking the questions ----------------------------------------------------------------------

export interface CheckQuestionsOptions {
  /** An anonymous form (ADR 0725): nothing maps to the Person and there is no destination. */
  anonymous?: boolean;
  /** The fields the form's destination object's intake lists; left out, the form has none. */
  destinationFields?: readonly string[];
}

export type QuestionsResult =
  | { ok: true; questions: Questions; bytes: number }
  | { ok: false; issues: DocumentIssue[] };

/** The text answers a person map takes from each kind. */
const PERSON_MAP_KINDS: Record<QuestionPersonField, QuestionKind> = {
  name: "text",
  email: "email",
  phone: "phone",
};

/**
 * Checks a form's questions: the document schema, then what it cannot say. Every fault (up to the
 * document check's limit) with its path from the root (`items.3.showIf.question`).
 */
export function checkQuestions(
  value: unknown,
  options: CheckQuestionsOptions = {},
): QuestionsResult {
  const checked = validateDocument(QUESTIONS_SCHEMA, value, { maxBytes: QUESTIONS_MAX_BYTES });
  if (!checked.ok) return checked;
  const questions = value as Questions;
  const issues: DocumentIssue[] = [];
  const fault = (path: (string | number)[], message: string) => {
    if (issues.length < DOCUMENT_MAX_ISSUES) issues.push({ path, message });
  };
  const before = new Map<string, QuestionItem>();
  const mapped = new Map<string, string>();
  questions.items.forEach((item, i) => {
    const at = ["items", i];
    if (!KEY_RE.test(item.key))
      fault([...at, "key"], "A key is camelCase: a lowercase letter first");
    if (item.showIf) {
      const target = before.get(item.showIf.question);
      const why = target ? showIfFault(target, item.showIf.is) : "names no earlier item";
      if (why) fault([...at, "showIf"], `"Show only if" ${why}`);
    }
    switch (item.kind) {
      case "text":
        if (item.max !== undefined && !item.long && item.max > SHORT_TEXT_MAX) {
          fault([...at, "max"], `A short text takes at most ${SHORT_TEXT_MAX} characters`);
        }
        break;
      case "number":
        if (item.min !== undefined && item.max !== undefined && item.min > item.max) {
          fault([...at, "min"], "min is above max");
        }
        break;
      case "choice":
        if (new Set(item.options).size !== item.options.length) {
          fault([...at, "options"], "Each option is listed once");
        }
        break;
      case "consent":
        if (item.purpose === "marketing" && item.required) {
          fault([...at, "required"], "A marketing consent line is never required");
        }
        break;
    }
    const map = "map" in item ? item.map : undefined;
    if (map) {
      const why = mapFault(item, map, options);
      const target = `${map.to}.${map.field}`;
      if (why) fault([...at, "map"], why);
      else if (mapped.has(target))
        fault([...at, "map"], `${target} is filled by ${mapped.get(target)} already`);
      else mapped.set(target, item.key);
    }
    before.set(item.key, item);
  });
  if (issues.length) return { ok: false, issues };
  return { ok: true, questions, bytes: checked.bytes };
}

function showIfFault(target: QuestionItem, is: string): string | null {
  if (target.showIf) return "names an item that is itself shown only if (one level only)";
  if (target.kind === "yesNo")
    return is === "yes" || is === "no" ? null : "of a yes/no is yes or no";
  if (target.kind === "choice") {
    return target.options.includes(is) ? null : `names no option of ${target.key}`;
  }
  return "names a choice or a yes/no";
}

function mapFault(
  item: QuestionItem,
  map: QuestionMap,
  options: CheckQuestionsOptions,
): string | null {
  if (map.to === "person") {
    if (options.anonymous) return "An anonymous form keeps no Person, so nothing maps to one";
    const kind = PERSON_MAP_KINDS[map.field];
    if (item.kind !== kind || (item.kind === "text" && item.long)) {
      return `The Person's ${map.field} is filled from ${kind === "text" ? "a short text" : `an ${kind}`} question`;
    }
    return null;
  }
  if (options.anonymous) return "An anonymous form has no destination";
  if (!options.destinationFields) return "The form has no destination";
  if (!options.destinationFields.includes(map.field)) {
    return `The destination's intake does not list "${map.field}"`;
  }
  if (item.kind === "choice" && item.multiple)
    return "A choice of several fills no destination field";
  return null;
}

// --- Checking the answers ------------------------------------------------------------------------

/** What is wrong with an answer, for a client to show beside its question. */
export type AnswerFault =
  | "shape" // the answers are not an object of key to value
  | "unknown" // the key is no question of this version
  | "hidden" // the question was not shown, by its "show only if"
  | "required"
  | "type"
  | "length"
  | "links"
  | "size"; // the answers together are too big

/** A fault in the answers: the question's key (null for the whole) and never the value. */
export interface AnswerIssue {
  key: string | null;
  fault: AnswerFault;
  message: string;
}

export type AnswersResult =
  | { ok: true; answers: Answers; bytes: number }
  | { ok: false; issues: AnswerIssue[] };

/** Whether a value counts as no answer: left out, null, empty text or no option chosen. */
function unanswered(value: unknown): boolean {
  return (
    value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)
  );
}

/**
 * Whether an item is shown, given the answers so far: it has no "show only if", or the earlier
 * item it names has that value (a choice of several: among those chosen). The headless entry and
 * `checkAnswers` both read it.
 */
export function isQuestionShown(
  item: QuestionItem,
  questions: Questions,
  input: Readonly<Record<string, unknown>>,
): boolean {
  if (!item.showIf) return true;
  const { question, is } = item.showIf;
  const target = questions.items.find((q) => q.key === question);
  const value = Object.hasOwn(input, question) ? input[question] : undefined;
  if (target?.kind === "yesNo") return value === (is === "yes");
  if (target?.kind === "choice") return Array.isArray(value) ? value.includes(is) : value === is;
  return false;
}

/** Links in a text answer. */
export function countLinks(text: string): number {
  return text.match(LINK_RE)?.length ?? 0;
}

/**
 * Checks what a person sent (`{ [key]: value }`) against one version's questions, already checked
 * by `checkQuestions`: every fault, or the answers document to store. An item that is not shown
 * takes no answer; a question left unanswered is not stored; a consent line left unticked may be
 * sent as false.
 */
export function checkAnswers(questions: Questions, input: unknown): AnswersResult {
  const isRecord = typeof input === "object" && input !== null && !Array.isArray(input);
  if (!isRecord) {
    return {
      ok: false,
      issues: [{ key: null, fault: "shape", message: "Answers are an object of question keys" }],
    };
  }
  const given = input as Record<string, unknown>;
  const issues: AnswerIssue[] = [];
  const fault = (key: string | null, kind: AnswerFault, message: string) => {
    if (issues.length < DOCUMENT_MAX_ISSUES) issues.push({ key, fault: kind, message });
  };
  const byKey = new Map(questions.items.map((item) => [item.key, item]));
  for (const key of Object.keys(given)) {
    const item = byKey.get(key);
    if (!item || item.kind === "heading" || item.kind === "paragraph") {
      fault(null, "unknown", "An answer names no question of this form");
    }
  }
  const answers: Answer[] = [];
  for (const item of questions.items) {
    if (item.kind === "heading" || item.kind === "paragraph") continue;
    const value = Object.hasOwn(given, item.key) ? given[item.key] : undefined;
    if (!isQuestionShown(item, questions, given)) {
      if (!unanswered(value)) fault(item.key, "hidden", "This question was not shown");
      continue;
    }
    if (unanswered(value)) {
      if (item.required) fault(item.key, "required", "An answer is required");
      continue;
    }
    const answer = checkAnswer(item, value, (kind, message) => {
      fault(item.key, kind, message);
      return null;
    });
    if (answer) answers.push(answer);
  }
  if (issues.length) return { ok: false, issues };
  const document: Answers = { answers };
  const bytes = documentBytes(document);
  if (bytes > ANSWERS_MAX_BYTES) {
    return {
      ok: false,
      issues: [
        {
          key: null,
          fault: "size",
          message: `The answers are more than ${ANSWERS_MAX_BYTES} bytes`,
        },
      ],
    };
  }
  // The stored shape is the platform's: a fault here is a fault in this file.
  const stored = validateDocument(ANSWERS_SCHEMA, document, { maxBytes: ANSWERS_MAX_BYTES });
  if (!stored.ok) throw new Error("checkAnswers built answers its own schema refuses");
  return { ok: true, answers: document, bytes };
}

function checkAnswer(
  item: Exclude<QuestionItem, HeadingItem | ParagraphItem>,
  value: unknown,
  fault: (kind: AnswerFault, message: string) => null,
): Answer | null {
  const { key } = item;
  const text = (max: number, multiline: boolean): string | null => {
    if (typeof value !== "string") return fault("type", "Expected text");
    if (value.length > max) return fault("length", `At most ${max} characters`);
    if (CONTROL_RE.test(value)) return fault("type", "Control characters are not allowed");
    if (!multiline && /[\r\n]/.test(value)) return fault("type", "One line only");
    if (countLinks(value) > ANSWER_MAX_LINKS) {
      return fault("links", `At most ${ANSWER_MAX_LINKS} links`);
    }
    return value;
  };
  switch (item.kind) {
    case "text": {
      const max = Math.min(
        item.max ?? (item.long ? LONG_TEXT_MAX : SHORT_TEXT_DEFAULT),
        item.long ? LONG_TEXT_MAX : SHORT_TEXT_MAX,
      );
      const v = text(max, item.long === true);
      return v === null ? null : { kind: "text", key, value: v };
    }
    case "email": {
      if (typeof value !== "string" || !emailShape.safeParse(value).success) {
        return fault("type", "Expected an email address");
      }
      return { kind: "email", key, value };
    }
    case "phone": {
      if (
        typeof value !== "string" ||
        !PHONE_RE.test(value) ||
        (value.match(/[0-9]/g)?.length ?? 0) < 5
      ) {
        return fault("type", "Expected a phone number");
      }
      return { kind: "phone", key, value };
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value))
        return fault("type", "Expected a number");
      if (item.integer && !Number.isInteger(value)) return fault("type", "Expected a whole number");
      if (item.min !== undefined && value < item.min) return fault("type", `At least ${item.min}`);
      if (item.max !== undefined && value > item.max) return fault("type", `At most ${item.max}`);
      return { kind: "number", key, value };
    }
    case "choice": {
      const values = item.multiple ? value : [value];
      if (
        !Array.isArray(values) ||
        values.some((v) => typeof v !== "string" || !item.options.includes(v)) ||
        new Set(values).size !== values.length
      ) {
        return fault(
          "type",
          item.multiple ? "Expected some of the options, each once" : "Expected one of the options",
        );
      }
      return { kind: "choice", key, values: values as string[] };
    }
    case "date": {
      const match = typeof value === "string" ? DATE_RE.exec(value) : null;
      const [y, m, d] = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
      const day = new Date(Date.UTC(y, m - 1, d));
      if (
        !match ||
        day.getUTCFullYear() !== y ||
        day.getUTCMonth() !== m - 1 ||
        day.getUTCDate() !== d
      ) {
        return fault("type", "Expected a date (YYYY-MM-DD)");
      }
      return { kind: "date", key, value: value as string };
    }
    case "rating": {
      const [min, max] = item.scale === "stars" ? [1, 5] : [0, 10];
      if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        return fault("type", `Expected a whole number from ${min} to ${max}`);
      }
      return { kind: "rating", key, value };
    }
    case "yesNo":
    case "consent": {
      if (typeof value !== "boolean") return fault("type", "Expected true or false");
      if (item.kind === "consent" && item.required && !value)
        return fault("required", "This must be ticked");
      return { kind: item.kind, key, value };
    }
  }
}
