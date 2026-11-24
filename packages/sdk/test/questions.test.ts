// Stage 29, step 1: the question schema and answer checking. A form's questions are one fixed
// document schema; `checkQuestions` adds what the schema cannot say, and `checkAnswers` checks what
// a person sent against one version, naming the question's key and never the value.
import { describe, expect, it } from "vitest";
import {
  ANSWERS_SCHEMA,
  checkAnswers,
  checkDocumentSchema,
  checkQuestions,
  countLinks,
  isQuestionShown,
  QUESTION_KINDS,
  QUESTIONS_SCHEMA,
  type Questions,
  redactDocument,
  validateDocument,
} from "../src/index.ts";

/** An enquiry with one item of every kind. */
const enquiry = (): Questions => ({
  items: [
    { kind: "heading", key: "intro", text: "Ask about a trial" },
    {
      kind: "paragraph",
      key: "note",
      content: [{ type: "text", text: "We answer within a day." }],
    },
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
    { kind: "phone", key: "phone", label: "Phone", map: { to: "person", field: "phone" } },
    { kind: "number", key: "age", label: "Age", min: 5, max: 99, integer: true },
    { kind: "choice", key: "interest", label: "Interested in", options: ["Adults", "Kids"] },
    {
      kind: "choice",
      key: "days",
      label: "Days",
      options: ["Mon", "Wed", "Sat"],
      multiple: true,
    },
    {
      kind: "text",
      key: "childName",
      label: "Child's first name",
      showIf: { question: "interest", is: "Kids" },
      required: true,
    },
    { kind: "date", key: "start", label: "When could you start?" },
    { kind: "rating", key: "keen", label: "How keen?", scale: "stars" },
    { kind: "yesNo", key: "before", label: "Trained before?" },
    {
      kind: "text",
      key: "more",
      label: "Anything else",
      long: true,
      showIf: { question: "before", is: "yes" },
    },
    { kind: "consent", key: "news", words: "Keep me updated by email", purpose: "marketing" },
    {
      kind: "consent",
      key: "contact",
      words: "You may call me back",
      purpose: "contact",
      required: true,
    },
  ],
});

const good = () => ({
  name: "Sam",
  email: "sam@example.com",
  phone: "+61 400 000 000",
  age: 30,
  interest: "Adults",
  days: ["Mon", "Sat"],
  start: "2026-12-01",
  keen: 4,
  before: true,
  more: "Two years of judo.\nSome boxing.",
  news: true,
  contact: true,
});

const faults = (result: ReturnType<typeof checkAnswers>) =>
  result.ok ? [] : result.issues.map((i) => `${i.key}: ${i.fault}`);

const paths = (result: ReturnType<typeof checkQuestions>) =>
  result.ok ? [] : result.issues.map((i) => i.path.join("."));

describe("the question schema", () => {
  it("is a document schema the contract accepts, and the stored answers' too", () => {
    expect(checkDocumentSchema(QUESTIONS_SCHEMA)).toEqual([]);
    expect(checkDocumentSchema(ANSWERS_SCHEMA)).toEqual([]);
  });

  it("names every kind, and no health, signature, payment or file kind", () => {
    expect([...QUESTION_KINDS].sort()).toEqual(
      [
        "choice",
        "consent",
        "date",
        "email",
        "heading",
        "number",
        "paragraph",
        "phone",
        "rating",
        "text",
        "yesNo",
      ].sort(),
    );
    const result = checkQuestions({
      items: [{ kind: "health", key: "injury", label: "Injuries" }],
    });
    expect(paths(result)).toEqual(["items.0.kind"]);
  });

  it("accepts a form with every kind", () => {
    const result = checkQuestions(enquiry());
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it("refuses more than 60 items, a repeated key and a key that is not camelCase", () => {
    const many = {
      items: Array.from({ length: 61 }, (_, i) => ({ kind: "yesNo", key: `q${i}`, label: "?" })),
    };
    expect(paths(checkQuestions(many))).toEqual(["items"]);
    const twice = enquiry();
    twice.items.push({ kind: "yesNo", key: "email", label: "Again" });
    expect(paths(checkQuestions(twice))).toEqual(["items.15.key"]);
    const upper = { items: [{ kind: "yesNo", key: "Before", label: "?" }] };
    expect(paths(checkQuestions(upper))).toEqual(["items.0.key"]);
  });

  it("refuses markup in a label and a paragraph's unsafe link", () => {
    const value = enquiry();
    value.items[2] = { kind: "text", key: "name", label: "<b>Name</b>" };
    value.items[1] = {
      kind: "paragraph",
      key: "note",
      content: [{ type: "text", text: "Click", href: "javascript:alert(1)" }],
    };
    expect(paths(checkQuestions(value))).toEqual(["items.1.content.0.href", "items.2.label"]);
  });

  it("refuses more than 50 options, an option twice, a short text over 500 and min above max", () => {
    const value: Questions = {
      items: [
        {
          kind: "choice",
          key: "a",
          label: "A",
          options: Array.from({ length: 51 }, (_, i) => `o${i}`),
        },
      ],
    };
    expect(paths(checkQuestions(value))).toEqual(["items.0.options"]);
    const rest: Questions = {
      items: [
        { kind: "choice", key: "a", label: "A", options: ["x", "x"] },
        { kind: "text", key: "b", label: "B", max: 600 },
        { kind: "text", key: "c", label: "C", max: 5000, long: true },
        { kind: "number", key: "d", label: "D", min: 5, max: 1 },
      ],
    };
    expect(paths(checkQuestions(rest))).toEqual(["items.0.options", "items.1.max", "items.3.min"]);
  });

  it("shows an item only if one earlier choice or yes/no has a value, one level deep", () => {
    const value = (showIf: { question: string; is: string }): Questions => ({
      items: [
        { kind: "choice", key: "pick", label: "Pick", options: ["a", "b"] },
        { kind: "yesNo", key: "ok", label: "OK?", showIf: { question: "pick", is: "a" } },
        { kind: "text", key: "name", label: "Name" },
        { kind: "text", key: "why", label: "Why", showIf },
        { kind: "yesNo", key: "later", label: "Later" },
      ],
    });
    expect(checkQuestions(value({ question: "pick", is: "b" })).ok).toBe(true);
    for (const bad of [
      { question: "pick", is: "c" }, // no such option
      { question: "ok", is: "yes" }, // itself shown only if
      { question: "name", is: "Sam" }, // not a choice or yes/no
      { question: "later", is: "yes" }, // not earlier
      { question: "why", is: "yes" }, // itself
    ]) {
      expect(paths(checkQuestions(value(bad)))).toEqual(["items.3.showIf"]);
    }
  });

  it("maps a question to the Person or a listed destination field, each once", () => {
    const value = (map: unknown, kind = "text"): unknown => ({
      items: [
        { kind: "text", key: "first", label: "Name", map: { to: "person", field: "name" } },
        { kind, key: "second", label: "Second", map },
      ],
    });
    const dest = { destinationFields: ["notes", "kind"] };
    expect(checkQuestions(value({ to: "destination", field: "notes" }), dest).ok).toBe(true);
    expect(checkQuestions(value({ to: "person", field: "email" }, "email")).ok).toBe(true);
    // The Person's name is filled once; an email from an email question only.
    expect(paths(checkQuestions(value({ to: "person", field: "name" })))).toEqual(["items.1.map"]);
    expect(paths(checkQuestions(value({ to: "person", field: "email" })))).toEqual(["items.1.map"]);
    // A destination field the intake does not list, or a form with no destination.
    expect(paths(checkQuestions(value({ to: "destination", field: "owner" }), dest))).toEqual([
      "items.1.map",
    ]);
    expect(paths(checkQuestions(value({ to: "destination", field: "notes" })))).toEqual([
      "items.1.map",
    ]);
  });

  it("maps nothing on an anonymous form", () => {
    const result = checkQuestions(enquiry(), { anonymous: true, destinationFields: ["notes"] });
    expect(paths(result)).toEqual(["items.2.map", "items.3.map", "items.4.map"]);
  });

  it("never requires a marketing consent line", () => {
    const value: Questions = {
      items: [
        {
          kind: "consent",
          key: "news",
          words: "Keep me updated",
          purpose: "marketing",
          required: true,
        },
      ],
    };
    expect(paths(checkQuestions(value))).toEqual(["items.0.required"]);
  });
});

describe("checking answers", () => {
  it("stores the answers in the questions' order, leaving out what was not answered", () => {
    const result = checkAnswers(enquiry(), { ...good(), phone: "", age: null });
    expect(result.ok ? result.answers : result.issues).toEqual({
      answers: [
        { kind: "text", key: "name", value: "Sam" },
        { kind: "email", key: "email", value: "sam@example.com" },
        { kind: "choice", key: "interest", values: ["Adults"] },
        { kind: "choice", key: "days", values: ["Mon", "Sat"] },
        { kind: "date", key: "start", value: "2026-12-01" },
        { kind: "rating", key: "keen", value: 4 },
        { kind: "yesNo", key: "before", value: true },
        { kind: "text", key: "more", value: "Two years of judo.\nSome boxing." },
        { kind: "consent", key: "news", value: true },
        { kind: "consent", key: "contact", value: true },
      ],
    });
    if (result.ok) expect(validateDocument(ANSWERS_SCHEMA, result.answers).ok).toBe(true);
  });

  it("refuses a missing required answer, a wrong type and too long a text, by key only", () => {
    const secret = "my-private-value-1234";
    const result = checkAnswers(enquiry(), {
      ...good(),
      name: undefined,
      email: secret,
      phone: `${secret}x`,
      age: 4.5,
      interest: secret,
      days: ["Mon", "Mon"],
      start: "2026-02-30",
    });
    expect(faults(result)).toEqual([
      "name: required",
      "email: type",
      "phone: type",
      "age: type",
      "interest: type",
      "days: type",
      "start: type",
    ]);
    // `before` is not a yes/no, so `more` is not shown and takes no answer.
    const shown = checkAnswers(enquiry(), { ...good(), keen: 6, before: "yes" });
    expect(faults(shown)).toEqual(["keen: type", "before: type", "more: hidden"]);
    const long = checkAnswers(enquiry(), { ...good(), more: "x".repeat(5001) });
    expect(faults(long)).toEqual(["more: length"]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("refuses a short text over its length or on several lines, and control characters", () => {
    expect(faults(checkAnswers(enquiry(), { ...good(), name: "x".repeat(201) }))).toEqual([
      "name: length",
    ]);
    expect(faults(checkAnswers(enquiry(), { ...good(), name: "Sam\nSmith" }))).toEqual([
      "name: type",
    ]);
    expect(faults(checkAnswers(enquiry(), { ...good(), more: "a\u0000b" }))).toEqual([
      "more: type",
    ]);
  });

  it("refuses more than 3 links in any text", () => {
    const text = "see https://a.example http://b.example www.c.example ftp://d.example";
    expect(countLinks(text)).toBe(4);
    expect(faults(checkAnswers(enquiry(), { ...good(), more: text }))).toEqual(["more: links"]);
    expect(checkAnswers(enquiry(), { ...good(), more: "https://a.example www.b.example" }).ok).toBe(
      true,
    );
  });

  it("takes no answer for a question that was not shown, and requires one only when shown", () => {
    const questions = enquiry();
    const child = questions.items.find((q) => q.key === "childName");
    if (!child) throw new Error("no child question");
    expect(isQuestionShown(child, questions, { interest: "Adults" })).toBe(false);
    expect(isQuestionShown(child, questions, { interest: "Kids" })).toBe(true);
    expect(faults(checkAnswers(questions, { ...good(), childName: "Alex" }))).toEqual([
      "childName: hidden",
    ]);
    expect(faults(checkAnswers(questions, { ...good(), interest: "Kids" }))).toEqual([
      "childName: required",
    ]);
    expect(checkAnswers(questions, { ...good(), interest: "Kids", childName: "Alex" }).ok).toBe(
      true,
    );
    // A choice of several shows its item when the value is among those chosen.
    const several: Questions = {
      items: [
        { kind: "choice", key: "days", label: "Days", options: ["Mon", "Sat"], multiple: true },
        {
          kind: "text",
          key: "why",
          label: "Why Saturday",
          showIf: { question: "days", is: "Sat" },
        },
      ],
    };
    const why = several.items[1];
    if (!why) throw new Error("no why");
    expect(isQuestionShown(why, several, { days: ["Mon", "Sat"] })).toBe(true);
    expect(isQuestionShown(why, several, { days: ["Mon"] })).toBe(false);
  });

  it("refuses an answer to no question, to a heading, and answers that are not an object", () => {
    const result = checkAnswers(enquiry(), { ...good(), intro: "x", made: "up" });
    expect(result.ok ? [] : result.issues).toEqual([
      { key: null, fault: "unknown", message: "An answer names no question of this form" },
      { key: null, fault: "unknown", message: "An answer names no question of this form" },
    ]);
    expect(faults(checkAnswers(enquiry(), ["Sam"]))).toEqual(["null: shape"]);
    expect(faults(checkAnswers(enquiry(), null))).toEqual(["null: shape"]);
  });

  it("requires a required consent to be ticked, and keeps an unticked one as false", () => {
    expect(faults(checkAnswers(enquiry(), { ...good(), contact: false }))).toEqual([
      "contact: required",
    ]);
    const result = checkAnswers(enquiry(), { ...good(), news: false });
    expect(result.ok && result.answers.answers.find((a) => a.key === "news")).toEqual({
      kind: "consent",
      key: "news",
      value: false,
    });
    expect(faults(checkAnswers(enquiry(), { ...good(), news: "on" }))).toEqual(["news: type"]);
  });

  it("refuses answers over 20 KB together", () => {
    const questions: Questions = {
      items: Array.from({ length: 5 }, (_, i) => ({
        kind: "text" as const,
        key: `t${i}`,
        label: "Long",
        long: true,
      })),
    };
    const input = Object.fromEntries(questions.items.map((q) => [q.key, "y".repeat(4500)]));
    expect(faults(checkAnswers(questions, input))).toEqual(["null: size"]);
  });

  it("checks a rating on its scale", () => {
    const questions: Questions = {
      items: [
        { kind: "rating", key: "stars", label: "Stars", scale: "stars" },
        { kind: "rating", key: "ten", label: "Ten", scale: "ten" },
      ],
    };
    expect(checkAnswers(questions, { stars: 1, ten: 0 }).ok).toBe(true);
    expect(faults(checkAnswers(questions, { stars: 0, ten: 11 }))).toEqual([
      "stars: type",
      "ten: type",
    ]);
  });

  it("keeps the stored answers from customers and the public", () => {
    const result = checkAnswers(enquiry(), good());
    expect(result.ok).toBe(true);
    if (result.ok) expect(redactDocument(ANSWERS_SCHEMA, result.answers)).toBeNull();
  });
});
