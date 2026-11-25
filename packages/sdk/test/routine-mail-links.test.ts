// The form-link slot and the receipt (stage 29 step 5, ADRs 0723 and 0724): what the contract
// accepts of a kind that carries a personal link, and of a receipt. Only the routine mail's own
// issues are read here (the fixture's intake declaration is not complete).
import { describe, expect, it } from "vitest";
import { validateManifest } from "../src/index.ts";

function gym(routineMail: object) {
  return {
    id: "gym",
    version: "1.0.0",
    contractVersion: 1,
    permissions: { modules: ["ops", "routine-mail"] },
    settings: {
      feedbackForm: { type: "text", label: "Feedback form", personApproves: true },
      anyone: { type: "text", label: "A setting anyone may change" },
    },
    objects: {
      class: {
        label: "Class",
        plural: "Classes",
        titleField: "title",
        fields: { title: { type: "text", label: "Title" } },
      },
      booking: {
        label: "Booking",
        plural: "Bookings",
        titleField: "title",
        fields: {
          title: { type: "text", label: "Title" },
          class: { type: "relation", label: "Class", to: "gym.class" },
          person: { type: "relation", label: "Person", to: "person" },
        },
        customer: { field: "person", read: ["class"], write: [] },
      },
      form: {
        label: "Form",
        plural: "Forms",
        titleField: "title",
        fields: { title: { type: "text", label: "Title" } },
      },
      submission: {
        label: "Submission",
        plural: "Submissions",
        titleField: "note",
        fields: {
          note: { type: "text", label: "Note" },
          form: { type: "relation", label: "Form", to: "gym.form" },
          email: { type: "text", label: "Email typed" },
        },
        intake: {
          role: "submission",
          form: "form",
          version: "note",
          answers: "note",
          person: "note",
          certainty: "note",
          spam: "spam",
        },
      },
    },
    routineMail,
  };
}

function issues(routineMail: object): string[] {
  const checked = validateManifest(gym(routineMail));
  // The fixture parses: only the contract's checks of it may fail.
  if (!checked.manifest) throw new Error(JSON.stringify(checked.issues));
  return checked.issues
    .filter((i) => i.path.startsWith("routineMail"))
    .map((i) => `${i.path}: ${i.message}`);
}

const feedback = (over: object = {}) => ({
  label: "Feedback",
  description: "After a class.",
  about: "booking",
  purpose: "follow_up",
  slots: {
    class: { field: "class.title" },
    form: { formLink: { object: "forms.form", setting: "feedbackForm", days: 7, once: 30 } },
  },
  messages: {
    ask: {
      subject: "How was {class}?",
      text: "How was {class}? Tell us:\n{form}",
      guardian: { subject: "How was {class}? ({member})", text: "How was it for {member}?\n{form}" },
    },
  },
  ...over,
});

const receipt = (over: object = {}) => ({
  label: "Receipts",
  description: "When answers arrive.",
  about: "submission",
  receipt: true,
  slots: { form: { field: "form.title" } },
  messages: { received: { subject: "We got your answers: {form}", text: "Thank you." } },
  ...over,
});

describe("the form-link slot (ADR 0723)", () => {
  it("accepts a link to a form a person chose, in an email's words", () => {
    expect(issues({ feedback: feedback() })).toEqual([]);
  });

  it("refuses a setting anyone may change, or one that is not a text setting", () => {
    const anyone = issues({
      feedback: feedback({
        slots: { form: { formLink: { object: "forms.form", setting: "anyone" } } },
      }),
    });
    expect(anyone.join("\n")).toMatch(/personApproves/);
    const none = issues({
      feedback: feedback({
        slots: { form: { formLink: { object: "forms.form", setting: "missing" } } },
      }),
    });
    expect(none.join("\n")).toMatch(/not a text setting/);
  });

  it("goes by email only: never a text, a push, a subject or an optional part", () => {
    const texted = issues({
      feedback: feedback({
        channels: ["email", "text"],
        messages: {
          ask: { subject: "How was it?", text: "Tell us: {form}", textMessage: "Tell us: {form}" },
        },
      }),
    });
    expect(texted.join("\n")).toMatch(/by email only/);
    const subject = issues({
      feedback: feedback({ messages: { ask: { subject: "Tell us {form}", text: "{form}" } } }),
    });
    expect(subject.join("\n")).toMatch(/not in a subject/);
    const optional = issues({
      feedback: feedback({ messages: { ask: { subject: "How was it?", text: "[Tell us: {form}]" } } }),
    });
    expect(optional.join("\n")).toMatch(/not in an optional part/);
  });

  it("is for the record's own Person: not about an object with no customer, nor an order", () => {
    const found = issues({ feedback: feedback({ about: "class" }) });
    expect(found.join("\n")).toMatch(/record's own Person/);
  });

  it("allows one per kind, and no value of it from the pack", () => {
    const two = issues({
      feedback: feedback({
        slots: {
          a: { formLink: { object: "forms.form", setting: "feedbackForm" } },
          b: { formLink: { object: "forms.form", setting: "feedbackForm" } },
        },
        messages: { ask: { subject: "How was it?", text: "{a}\n{b}" } },
      }),
    });
    expect(two.join("\n")).toMatch(/At most one form-link slot/);
    // Days: at most 30 (the declaration's own shape refuses more).
    const long = validateManifest(
      gym({
        feedback: feedback({
          slots: { form: { formLink: { object: "forms.form", setting: "feedbackForm", days: 90 } } },
        }),
      }),
    );
    expect(long.issues.map((i) => i.path)).toContain("routineMail.feedback.slots.form.formLink.days");
  });
});

describe("a receipt (ADR 0724)", () => {
  it("accepts one about a submission showing only its form's fields", () => {
    expect(issues({ receipt: receipt() })).toEqual([]);
  });

  it("shows nothing the sender typed, has no guardian's words, and goes by email only", () => {
    const typed = issues({
      receipt: receipt({
        slots: { form: { field: "form.title" }, mine: { field: "email" } },
        messages: { received: { subject: "Got it: {form}", text: "You wrote {mine}" } },
      }),
    });
    expect(typed.join("\n")).toMatch(/only the form's own fields/);
    const guardian = issues({
      receipt: receipt({
        messages: {
          received: {
            subject: "Got it: {form}",
            text: "Thanks.",
            guardian: { subject: "Got it ({member})", text: "Thanks." },
          },
        },
      }),
    });
    expect(guardian.join("\n")).toMatch(/whoever sent it/);
    const followUp = issues({ receipt: receipt({ purpose: "follow_up" }) });
    expect(followUp.join("\n")).toMatch(/purpose account/);
  });

  it("is about an intake submission", () => {
    const found = issues({ receipt: receipt({ about: "booking", slots: {} }) });
    expect(found.join("\n")).toMatch(/intake submissions/);
  });
});
