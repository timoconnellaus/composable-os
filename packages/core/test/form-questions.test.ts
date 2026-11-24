// Stage 29, step 1: the SDK's question schema as the host stores it. A form's questions and a
// submission's answers are document fields (ADR 0445) with the platform's fixed schemas: the host
// checks them on every write, refuses a fault with its path, and gives a customer none of the
// answers even where a declaration would let them read the field.
import {
  ANSWERS_SCHEMA,
  checkAnswers,
  checkQuestions,
  QUESTIONS_MAX_BYTES,
  QUESTIONS_SCHEMA,
  type Questions,
  validateManifest,
} from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type CustomerPrincipal,
  invoke,
  listObjects,
  setExtensionObjects,
} from "../src/index.ts";
import { call, outside } from "./customer-fixtures.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, unique } from "./helpers.ts";

const EXT = extId("frm");
const FORM = `${EXT}.form`;
const SUBMISSION = `${EXT}.submission`;
let admin: ActingUser;
let customer: CustomerPrincipal;

const questions = (): Questions => ({
  items: [
    { kind: "heading", key: "intro", text: "Ask about a trial" },
    {
      kind: "email",
      key: "email",
      label: "Email",
      required: true,
      map: { to: "person", field: "email" },
    },
    { kind: "choice", key: "interest", label: "Interested in", options: ["Adults", "Kids"] },
    {
      kind: "text",
      key: "child",
      label: "Child's name",
      showIf: { question: "interest", is: "Kids" },
    },
    { kind: "rating", key: "keen", label: "How keen?", scale: "ten" },
    { kind: "consent", key: "news", words: "Keep me updated by email", purpose: "marketing" },
  ],
});

const m = () =>
  manifest(EXT, {
    objects: {
      form: {
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
        },
      },
      submission: {
        label: "Submission",
        plural: "Submissions",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          person: { type: "relation", label: "Person", to: "person" },
          answers: {
            type: "document",
            label: "Answers",
            schema: ANSWERS_SCHEMA as unknown as Record<string, unknown>,
            maxBytes: 20_480,
          },
        },
      },
    },
  });

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error("expected a refusal");
}

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(m());
  const person = await invoke(
    "person.create",
    { givenName: "Form", familyName: unique("Filler") },
    context(admin),
  );
  customer = { kind: "customer", customerId: `cus_${unique("frm")}`, personId: person.id };
  // Even a declaration that opened the answers to their Person would give them nothing.
  setExtensionObjects(
    new Map(
      listObjects().map((o) => [
        o.name,
        o.name === SUBMISSION
          ? { ...o, customer: { field: "person", read: ["name", "answers"], write: [] } }
          : o,
      ]),
    ),
  );
});

describe("the question schema in the host", () => {
  it("is a document field the contract accepts", () => {
    expect(validateManifest(m()).issues).toEqual([]);
  });

  it("stores a form's questions and refuses a broken one with the path of the fault", async () => {
    expect(checkQuestions(questions()).ok).toBe(true);
    const form = await invoke(
      "record.create",
      { object: FORM, values: { title: "Trial", questions: questions() } },
      context(admin),
    );
    expect(form.values.questions).toEqual(questions());
    const broken = questions();
    broken.items.push({ kind: "text", key: "email", label: "<script>x</script>" });
    const error = await refusal(
      invoke(
        "record.update",
        { object: FORM, id: form.id, values: { questions: broken } },
        context(admin),
      ),
    );
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain(`${FORM}.questions`);
    expect(error.message).toContain("questions.items.6.");
  });

  it("stores checked answers, which a customer never reads", async () => {
    const result = checkAnswers(questions(), {
      email: "fill@example.com",
      interest: "Kids",
      child: "Alex",
      keen: 9,
      news: true,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const submission = await invoke(
      "record.create",
      {
        object: SUBMISSION,
        values: { name: "Trial", person: customer.personId, answers: result.answers },
      },
      context(admin),
    );
    const staff = await invoke(
      "record.get",
      { object: SUBMISSION, id: submission.id },
      context(admin),
    );
    expect(staff.values.answers).toEqual(result.answers);
    const read = await call("my.get", { object: SUBMISSION, id: submission.id }, outside(customer));
    expect(read.ok, JSON.stringify(read)).toBe(true);
    expect(JSON.stringify(read)).not.toContain("fill@example.com");
    expect(JSON.stringify(read)).not.toContain("Alex");
  });

  it("refuses answers that are not in the stored shape", async () => {
    const error = await refusal(
      invoke(
        "record.create",
        {
          object: SUBMISSION,
          values: {
            name: "Bad",
            answers: { answers: [{ kind: "rating", key: "keen", value: 11 }] },
          },
        },
        context(admin),
      ),
    );
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("answers.answers.0.value: At most 10");
  });
});
