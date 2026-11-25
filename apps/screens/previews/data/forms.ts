// Dummy data for the Forms blocks' pictures: a gym's "ask about a trial" form, with a question of
// most kinds, and its feedback form, as `x.forms.form` answers them.
import type { FormsOperations } from "@composable-os/pack-forms/client";

type Opened = FormsOperations["x.forms.form"]["output"];

export const trialForm: Opened = {
  id: "rec_trial",
  version: 3,
  title: "Ask about a free trial",
  questions: {
    items: [
      {
        kind: "paragraph",
        key: "intro",
        content: [{ type: "text", text: "Tell us a little about you and we will be in touch." }],
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
      { kind: "phone", key: "phone", label: "Phone", help: "Only if you would like a call" },
      {
        kind: "choice",
        key: "classes",
        label: "Which classes interest you?",
        options: ["Strength", "HIIT", "Mobility", "Kids' classes"],
        multiple: true,
      },
      { kind: "date", key: "start", label: "When could you start?" },
      { kind: "yesNo", key: "before", label: "Have you trained at a gym before?" },
      {
        kind: "consent",
        key: "news",
        words: "Keep me updated by email about new classes and events",
        purpose: "marketing",
      },
    ],
  },
  thanks: "Thanks, we will be in touch within a day.",
  anonymous: false,
  turnstile: true,
  shown: "v1.0000000000000.preview",
};

export const feedbackForm: Opened = {
  id: "rec_feedback",
  version: 1,
  title: "How was Morning HIIT?",
  questions: {
    items: [
      {
        kind: "rating",
        key: "score",
        label: "How was the class?",
        scale: "stars",
        required: true,
      },
      {
        kind: "rating",
        key: "recommend",
        label: "How likely are you to recommend us to a friend?",
        scale: "ten",
      },
      { kind: "text", key: "why", label: "Anything to tell the coach?", long: true },
    ],
  },
  thanks: "Thank you: your coach will read it.",
  anonymous: false,
  turnstile: false,
  shown: null,
};
