// Stage 29 step 3: the Forms pack against @composable-os/sdk/testing's in-memory host. Its
// manifest passes the contract checks with the intake behaviour on both objects; the tools only
// pass what they are given to the host's door (intake.open, intake.submit) and to the
// submission's states; the low-rating notice tells the form's person, else the admins.
// apps/runner/test/forms.test.ts runs the same pack through the real host and its door.
import { QUESTIONS_SCHEMA } from "@composable-os/sdk";
import { createTestHost } from "@composable-os/sdk/testing";
import { describe, expect, it } from "vitest";
import extension from "../index.ts";

const FORM = "forms.form";
const SUBMISSION = "forms.submission";

const opened = {
  id: "frm_1",
  version: 2,
  content: {
    title: "Ask about a trial",
    questions: { items: [{ kind: "email", key: "email", label: "Email" }] },
    thanks: "Thanks, we will be in touch.",
  },
  anonymous: false,
  turnstile: true,
  shown: "v1.token",
};

type Rows = Record<string, ({ id: string } & Record<string, unknown>)[]>;

function hostWith(records: Rows = {}) {
  const calls: { operation: string; input: Record<string, unknown> }[] = [];
  const host = createTestHost(extension, {
    records,
    operations: {
      "intake.open": (input) => {
        calls.push({ operation: "intake.open", input });
        return opened;
      },
      "intake.submit": (input) => {
        calls.push({ operation: "intake.submit", input });
        return { received: true };
      },
    },
  });
  return { host, calls };
}

describe("the Forms pack (test host)", () => {
  it("passes the contract checks, a form and its submissions on the intake door", () => {
    const { host } = hostWith();
    expect(host.issues).toEqual([]);
    const { form, submission } = host.manifest.objects;
    expect(form?.intake).toMatchObject({ role: "form", openIn: ["open"], hourlyCap: "hourlyCap" });
    expect(form?.publishable).toMatchObject({ slug: "slug" });
    expect(JSON.stringify(form?.fields.questions?.schema)).toBe(JSON.stringify(QUESTIONS_SCHEMA));
    expect(submission?.intake).toMatchObject({ role: "submission", spam: "spam" });
    // Nobody outside reads either: no customer, public or signed-in declaration.
    for (const object of [form, submission]) {
      expect(object?.public).toBeUndefined();
      expect(object?.customer).toBeUndefined();
      expect(object?.signedIn).toBeUndefined();
    }
    // Opening and closing a form, its dates, its cap, its address and the hourly cap are a
    // person's.
    for (const field of ["status", "opensAt", "closesAt", "dailyCap", "slug"]) {
      expect(form?.fields[field]?.personApproves, field).toBe(true);
    }
    // No destination can be chosen until a pack's record takes a form's answers (step 6).
    expect(form?.fields.destination?.options).toBeUndefined();
    expect(host.manifest.settings.hourlyCap).toMatchObject({ default: 200, personApproves: true });
    // The pack gives no role any reach: a coach or the door reads none of it.
    expect(host.manifest.roles).toEqual({});
    // Spam is the host's and markSpam's and notSpam's only.
    const moves = submission?.states?.moves ?? [];
    for (const move of moves.filter((m) => m.to === "spam" || m.from === "spam")) {
      expect(move.by).toEqual(["host"]);
    }
    expect(host.manifest.tools.markSpam).toMatchObject({ personApproves: true });
    expect(host.manifest.tools.notSpam).toMatchObject({ personApproves: true });
  });

  it("opens only the answering tools to the public and customers", () => {
    const { host } = hostWith();
    const open = Object.entries(host.manifest.tools)
      .filter(([, tool]) => (tool.audiences ?? ["staff"]).some((a) => a !== "staff"))
      .map(([name]) => name)
      .sort();
    expect(open).toEqual(["form", "submit"]);
    for (const name of ["enter", "move", "markSpam", "notSpam"]) {
      expect(host.manifest.tools[name]?.permission, name).toBe("forms:answer");
    }
  });

  it("form: asks the door for the form by its address and gives what a client draws", async () => {
    const { host, calls } = hostWith();
    const out = await host.runTool(
      "form",
      { slug: "ask-about-a-trial" },
      {
        caller: { kind: "public" },
      },
    );
    expect(calls).toEqual([
      { operation: "intake.open", input: { object: FORM, slug: "ask-about-a-trial" } },
    ]);
    expect(out).toEqual({
      id: "frm_1",
      version: 2,
      title: "Ask about a trial",
      questions: opened.content.questions,
      thanks: "Thanks, we will be in touch.",
      anonymous: false,
      turnstile: true,
      shown: "v1.token",
    });
  });

  it("submit: passes the answers and the spam checks' tokens to the door, nothing more", async () => {
    const { host, calls } = hostWith();
    const out = await host.runTool(
      "submit",
      {
        id: "frm_1",
        version: 2,
        answers: { email: "visitor@example.test" },
        via: "site",
        turnstileToken: "tok",
        shown: "v1.token",
        honeypot: "",
      },
      { caller: { kind: "public" } },
    );
    expect(out).toEqual({ received: true });
    expect(calls).toEqual([
      {
        operation: "intake.submit",
        input: {
          object: FORM,
          id: "frm_1",
          version: 2,
          answers: { email: "visitor@example.test" },
          via: "site",
          turnstileToken: "tok",
          shown: "v1.token",
          honeypot: "",
        },
      },
    ]);
    // A tool cannot say it came by a personal link or from staff: those are the host's.
    await expect(
      host.runTool("submit", { id: "frm_1", version: 2, answers: {}, via: "staff" }),
    ).rejects.toThrow();
  });

  it("enter: staff answers go to the door with no way in or token: the host says staff", async () => {
    const { host, calls } = hostWith();
    await host.runTool("enter", { formId: "frm_1", answers: { email: "caller@example.test" } });
    expect(calls).toEqual([
      {
        operation: "intake.submit",
        input: { object: FORM, id: "frm_1", answers: { email: "caller@example.test" } },
      },
    ]);
  });

  it("move, markSpam and notSpam: the submission's states", async () => {
    const { host } = hostWith({
      [SUBMISSION]: [{ id: "sub_1", form: "frm_1", status: "new" }],
    });
    expect(await host.runTool("move", { submissionId: "sub_1", to: "inHand" })).toEqual({
      id: "sub_1",
      status: "inHand",
    });
    expect(await host.runTool("markSpam", { submissionId: "sub_1" })).toEqual({
      id: "sub_1",
      status: "spam",
    });
    // Twice is once.
    expect(await host.runTool("markSpam", { submissionId: "sub_1" })).toEqual({
      id: "sub_1",
      status: "spam",
    });
    expect(await host.runTool("notSpam", { submissionId: "sub_1" })).toEqual({
      id: "sub_1",
      status: "new",
    });
  });
});

describe("the low-rating notice", () => {
  const form = (values: Record<string, unknown>) => ({
    id: "frm_1",
    title: "After class",
    ...values,
  });
  const submission = (values: Record<string, unknown>) => ({
    id: "sub_1",
    title: "After class",
    form: "frm_1",
    status: "new",
    ...values,
  });
  const run = (records: Rows) => {
    const { host } = hostWith(records);
    return host
      .runAutomation("lowRating", {
        record: { object: SUBMISSION, id: "sub_1" },
        change: { action: "created", diff: {} },
      })
      .then((result) => ({ host, result }));
  };

  it("tells the answers' owner of a rating at or under the form's level", async () => {
    const { host, result } = await run({
      [FORM]: [form({ lowRating: 2, notify: "usr_other" })],
      [SUBMISSION]: [submission({ rating: 2, owner: "usr_manager" })],
    });
    expect(result.matched).toBe(true);
    expect(result.undeclared).toEqual([]);
    expect(result.error).toBeNull();
    expect(result.notifications).toHaveLength(1);
    expect(JSON.stringify(result.notifications[0])).toContain("owner");
    // The declared recipients are the ones it may tell.
    const declared = host.manifest.automations.lowRating?.steps[0];
    expect(JSON.stringify(declared)).toContain('"field":"owner"');
    expect(JSON.stringify(declared)).toContain('"admins"');
    expect(JSON.stringify(result.notifications[0])).toContain("A low rating: After class");
  });

  it("tells the admins when the answers have no owner, and nobody above the level", async () => {
    const low = await run({
      [FORM]: [form({ lowRating: 6 })],
      [SUBMISSION]: [submission({ rating: 3 })],
    });
    expect(JSON.stringify(low.result.notifications[0])).toContain("admin");
    const fine = await run({
      [FORM]: [form({ lowRating: 2 })],
      [SUBMISSION]: [submission({ rating: 4 })],
    });
    expect(fine.result.notifications).toEqual([]);
    const noLevel = await run({
      [FORM]: [form({})],
      [SUBMISSION]: [submission({ rating: 0 })],
    });
    expect(noLevel.result.notifications).toEqual([]);
  });

  it("does not run for answers with no rating, or kept as spam", async () => {
    const none = await run({ [FORM]: [form({ lowRating: 2 })], [SUBMISSION]: [submission({})] });
    expect(none.result.matched).toBe(false);
    const spam = await run({
      [FORM]: [form({ lowRating: 2 })],
      [SUBMISSION]: [submission({ rating: 1, status: "spam" })],
    });
    expect(spam.result.matched).toBe(false);
  });
});
