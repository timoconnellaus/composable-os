// Dummy data the agreement previews share: one member of a studio and their daughter, with a waiver, a health questionnaire and the membership terms.
import type { AgreementsOperations, AgreementVersion } from "@composable-os/client";
import { at, dayAfter } from "../../src/fake.ts";

type Out<K extends keyof AgreementsOperations> = AgreementsOperations[K]["output"];
type Summary = Out<"me.agreements.list">["items"][number];

const text = (t: string, marks: { bold?: boolean } = {}) => ({
  type: "text" as const,
  text: t,
  ...marks,
});
const p = (...content: ReturnType<typeof text>[]) => ({ type: "paragraph", content });
const h = (t: string) => ({ type: "heading", level: 1, content: [text(t)] });
const bullets = (...items: string[]) => ({
  type: "list",
  style: "bullet",
  items: items.map((t) => ({ content: [text(t)] })),
});

export const waiver: AgreementVersion = {
  id: "ver_waiver_2",
  documentId: "doc_waiver",
  number: 2,
  kind: "waiver",
  title: "Liability waiver",
  body: {
    blocks: [
      p(text("Training at the studio is physical and carries a risk of injury.")),
      h("What you agree to"),
      bullets(
        "You take part at your own risk, and stop if you feel unwell.",
        "You tell the coach about any injury before class.",
        "You use the equipment only as shown.",
      ),
      p(
        text("Nothing in this waiver limits the studio's responsibility for its own "),
        text("negligence", { bold: true }),
        text(", or any right you have under consumer law."),
      ),
    ],
  },
  tickLabel: "I have read the liability waiver and agree to it.",
  questions: null,
  how: "drawn",
  effectiveFrom: at("00:00", "2026-01-05"),
  hash: "sha256:7f1c…",
};

export const healthForm: AgreementVersion = {
  id: "ver_health_1",
  documentId: "doc_health",
  number: 1,
  kind: "health",
  title: "Health questionnaire",
  body: {
    blocks: [
      p(
        text(
          "Your answers help the coaches keep you safe. Only you and the staff allowed to read health forms see them.",
        ),
      ),
    ],
  },
  tickLabel: "My answers are true to the best of my knowledge.",
  questions: [
    { key: "heart", text: "Has a doctor ever said you have a heart condition?", noteOnYes: true },
    { key: "injury", text: "Do you have an injury that is still healing?", noteOnYes: true },
    {
      key: "pregnant",
      text: "Are you pregnant, or have you given birth in the last six months?",
      noteOnYes: false,
    },
  ],
  how: "typed",
  effectiveFrom: at("00:00", "2025-09-01"),
  hash: "sha256:a42e…",
};

export const terms: AgreementVersion = {
  id: "ver_terms_3",
  documentId: "doc_terms",
  number: 3,
  kind: "terms",
  title: "Membership terms",
  body: {
    blocks: [
      p(
        text(
          "These terms cover your membership: what it includes, how you pay and how you cancel.",
        ),
      ),
      h("What changed"),
      bullets(
        "A class cancelled less than 4 hours before it starts now counts as attended.",
        "You can pause your membership for up to 8 weeks a year.",
      ),
    ],
  },
  tickLabel: "I agree to the membership terms.",
  questions: null,
  how: "typed",
  effectiveFrom: at("00:00", dayAfter(-7)),
  hash: "sha256:19bd…",
};

export const photoConsent: AgreementVersion = {
  ...terms,
  id: "ver_photo_1",
  documentId: "doc_photo",
  number: 1,
  kind: "consent",
  title: "Photo consent",
  body: { blocks: [p(text("Photos taken in class may appear on the studio's pages."))] },
  tickLabel: "I agree to photos being taken in class.",
};

const ME = "p_me";
const CHILD = "p_mia";

/** "Before you go on": the questionnaire is asked again, then the new terms. */
export const dueForMe: Out<"me.agreements.due"> = {
  people: [
    {
      personId: ME,
      name: "Jordan Lee",
      self: true,
      canAgree: true,
      due: [
        {
          documentId: healthForm.documentId,
          kind: healthForm.kind,
          title: healthForm.title,
          reason: "ask_again",
          version: healthForm,
        },
        {
          documentId: terms.documentId,
          kind: terms.kind,
          title: terms.title,
          reason: "agree_again",
          version: terms,
        },
      ],
    },
  ],
};

/** My agreements: the new terms to agree to again, and the daughter's waiver for a guardian. */
export const dueForFamily: Out<"me.agreements.due"> = {
  people: [
    {
      personId: ME,
      name: "Jordan Lee",
      self: true,
      canAgree: true,
      due: [
        {
          documentId: terms.documentId,
          kind: terms.kind,
          title: terms.title,
          reason: "agree_again",
          version: terms,
        },
      ],
    },
    {
      personId: CHILD,
      name: "Mia Lee",
      self: false,
      canAgree: true,
      due: [
        {
          documentId: waiver.documentId,
          kind: waiver.kind,
          title: waiver.title,
          reason: "never",
          version: waiver,
        },
      ],
    },
  ],
};

function accepted(
  a: Partial<Summary> & Pick<Summary, "id" | "title" | "documentId" | "acceptedAt">,
): Summary {
  return {
    kind: "waiver",
    versionId: `ver_${a.id}`,
    versionNumber: 1,
    personId: ME,
    by: "self",
    how: "typed",
    channel: "web",
    agentPersonId: null,
    recordedBy: null,
    signedOn: null,
    counts: true,
    ...a,
  };
}

export const mine: Out<"me.agreements.list"> = {
  items: [
    accepted({
      id: "acc_1",
      documentId: waiver.documentId,
      title: waiver.title,
      versionNumber: 2,
      how: "drawn",
      channel: "app",
      acceptedAt: at("18:42", "2026-01-12"),
    }),
    accepted({
      id: "acc_2",
      documentId: healthForm.documentId,
      title: healthForm.title,
      acceptedAt: at("18:40", "2026-01-12"),
    }),
    accepted({
      id: "acc_3",
      documentId: terms.documentId,
      title: terms.title,
      versionNumber: 2,
      acceptedAt: at("09:15", "2025-11-03"),
    }),
    accepted({
      id: "acc_6",
      documentId: terms.documentId,
      title: terms.title,
      acceptedAt: at("19:20", "2025-03-10"),
      counts: false,
    }),
    accepted({
      id: "acc_4",
      documentId: photoConsent.documentId,
      title: photoConsent.title,
      personId: CHILD,
      by: "guardian",
      agentPersonId: ME,
      acceptedAt: at("17:05", "2026-02-02"),
    }),
    accepted({
      id: "acc_5",
      documentId: "doc_kids",
      title: "Kids' class rules",
      personId: CHILD,
      by: "paper",
      how: "paper",
      channel: "paper",
      recordedBy: "Sam Rivera",
      signedOn: "2026-01-28",
      acceptedAt: at("10:00", "2026-01-28"),
    }),
  ],
};
