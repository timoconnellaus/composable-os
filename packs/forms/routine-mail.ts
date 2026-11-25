// The Forms receipt (stage 29 step 5, decision 3; ADR 0724): routine mail the host sends without a
// person's approval once a human admin turns the pack's routine email on (ADR 0590). The host
// decides who it goes to (whoever sent the answers: their own sign-in address, the address their
// personal link went to, or the address they typed), refuses one for answers kept as spam,
// entered by staff or sent anonymously, and sends at most three a day to one mailbox and a daily
// number for the organisation of its own. Its words are fixed and show only the business's name
// (the one a human admin gave in Settings → Routine email) and the form's title, a person's
// write: never anything the sender typed, not even their name.
import type { RoutineMailSpec } from "@composable-os/sdk";

export const formsRoutineMail = {
  receipt: {
    label: "Receipts",
    description:
      "When someone sends answers to a form whose receipt is on, a short email to the address " +
      "they gave (or signed in with) saying the answers arrived, naming the business and the " +
      "form and nothing they typed. At most three a day to one address; never for an anonymous " +
      "form, answers kept as spam, or answers staff entered.",
    about: "submission",
    receipt: true,
    slots: {
      business: { business: true },
      form: { field: "form.title", max: 200 },
    },
    messages: {
      received: {
        subject: "{business}: we got your answers",
        text: [
          "Thank you: {business} got your answers to {form}.",
          "",
          "There is nothing more you need to do. If you did not send them, you can ignore this email.",
        ].join("\n"),
      },
    },
  },
} satisfies Record<string, RoutineMailSpec>;
