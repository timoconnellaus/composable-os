// Forms (stage 29, step 3; ADR 0726): forms a business builds in the admin, with no developer (an
// enquiry, a sign-up, a survey, feedback after a class, a staff report), and the answers people send
// to them, kept as submissions in one inbox. Any product can turn it on (`packs` in its product.ts).
//
// Everything that is a rule is the host's, declared here as behaviours (ADR 0404):
//   - a form is `publishable` (ADR 0446): staff and the assistant edit its working copy, and a
//     person with the publish permission publishes it (ADR 0480). Its questions are a document field
//     in the platform's question schema, checked on every write; who may answer, anonymity and the
//     destination are published with them (ADR 0720);
//   - a form takes answers through the host's one door, `intake` (ADR 0720): a submission is made
//     only by `intake.submit`, which checks the form is open to the caller, the spam checks, the caps
//     and the answers, and links or makes the submitter's Person (ADR 0721);
//   - nobody outside the org reads a form's records or a submission: the public reads a form only
//     through `intake.open`, as the door would take its answers (no public scope, ADR 0726), and a
//     submission declares no customer or public read. Pack-role accounts (a coach, the door) reach
//     none of it: the pack gives no role any reach;
//   - opening and closing a form, and the hourly cap, are a person's (`personApproves`); a
//     submission's move into and out of spam is made only by `markSpam` and `notSpam`, which an AI
//     may ask for and a person approves (ADR 0552).
// The tools in tools.ts compose the host's operations and add no rules of their own.
import {
  ANSWERS_MAX_BYTES,
  ANSWERS_SCHEMA,
  defineExtension,
  QUESTIONS_MAX_BYTES,
  QUESTIONS_SCHEMA,
} from "@composable-os/sdk";
import { formsAutomations } from "./automations.ts";
import { enter, form, markSpam, move, notSpam, submit } from "./tools.ts";

const INBOX_COLUMNS = ["title", "person", "certainty", "rating", "via", "owner", "createdAt"];

export default defineExtension({
  id: "forms",
  version: "0.1.0",
  contractVersion: 1,
  label: "Forms",
  description:
    "Forms the business builds and publishes (enquiries, sign-ups, surveys, feedback, staff " +
    "reports), and every answer in one inbox, linked to the person who sent it.",
  permissions: {
    // intake.open and intake.submit: the host's door for this pack's own forms (ADR 0720), from
    // the `form`, `submit` and `enter` tools. notification.send: the low-rating notice.
    operations: ["intake.open", "intake.submit", "notification.send"],
    modules: ["ops"],
  },
  objects: {
    form: {
      label: "Form",
      plural: "Forms",
      icon: "clipboard-list",
      titleField: "title",
      description:
        "Questions the business asks, published as versions: an enquiry, a sign-up, a survey, " +
        "feedback or a staff report. People answer the version last published.",
      navigation: "main",
      navigationOrder: 40,
      fields: {
        title: { type: "text", label: "Title", required: true },
        slug: {
          type: "slug",
          label: "Address",
          description: "How a link or a QR code names the form. Made from the title.",
        },
        kind: {
          type: "select",
          label: "Kind",
          default: "enquiry",
          options: [
            { value: "enquiry", label: "Enquiry" },
            { value: "signup", label: "Sign-up" },
            { value: "survey", label: "Survey" },
            { value: "feedback", label: "Feedback" },
            { value: "staff", label: "Staff form" },
          ],
          description:
            "What the form is for. A staff form (an incident report) is answered by staff only: " +
            "set who may answer to Staff.",
        },
        questions: {
          type: "document",
          label: "Questions",
          schema: QUESTIONS_SCHEMA,
          maxBytes: QUESTIONS_MAX_BYTES,
          description:
            "What the form asks. No health questions, signatures or waivers: those are " +
            "agreements.",
        },
        thanks: {
          type: "longText",
          label: "Thank-you words",
          description: "Shown once the answers are sent.",
        },
        answeredBy: {
          type: "select",
          label: "Who may answer",
          default: "public",
          options: [
            { value: "public", label: "Anyone" },
            { value: "customers", label: "Signed-in customers" },
            { value: "links", label: "By personal link" },
            { value: "staff", label: "Staff only" },
          ],
          description: "Read from the version published: a change counts once it is published.",
        },
        anonymous: {
          type: "boolean",
          label: "Anonymous",
          description:
            "Keeps no link to whoever answers: no person, no account, no receipt and no record " +
            "made elsewhere. It cannot ask for an email that fills in a person.",
        },
        destination: {
          type: "select",
          label: "Also make",
          options: [{ value: "leads.lead", label: "A lead (Leads)" }],
          description:
            "A record of another pack each answer also makes. Only a pack that is installed can " +
            "be chosen; never on an anonymous form.",
        },
        notify: {
          type: "user",
          label: "Who is told",
          description: "Told of each answer and of a low rating. Left empty, the admins.",
        },
        receipt: {
          type: "boolean",
          label: "Send a receipt",
          default: true,
          description:
            "The sender gets a short email saying the answers arrived, with nothing they typed " +
            "in it. Never on an anonymous form.",
        },
        lowRating: {
          type: "number",
          label: "Tell at a rating of",
          min: 0,
          max: 10,
          step: 1,
          description:
            "A first rating answer at or under this tells the person told (or the admins). " +
            "Left empty, no notice.",
        },
        opensAt: { type: "datetime", label: "Open from" },
        closesAt: { type: "datetime", label: "Open until" },
        dailyCap: {
          type: "number",
          label: "Answers a day, at most",
          min: 1,
          step: 1,
          description: "Left empty, no limit of its own.",
        },
        status: {
          type: "select",
          label: "Status",
          track: "timeline",
          // Opening and closing a form are a person's (an AI may ask): what the public may answer.
          personApproves: true,
          options: [
            { value: "draft", label: "Draft" },
            { value: "open", label: "Open" },
            { value: "closed", label: "Closed" },
          ],
        },
      },
      states: {
        field: "status",
        initial: "draft",
        moves: [
          { from: "draft", to: "open", by: ["staff"] },
          { from: "open", to: "closed", by: ["staff"] },
          { from: "closed", to: "open", by: ["staff"] },
        ],
      },
      publishable: {
        content: ["title", "questions", "thanks", "answeredBy", "anonymous", "destination"],
        slug: "slug",
      },
      intake: {
        role: "form",
        questions: "questions",
        answeredBy: "answeredBy",
        openIn: ["open"],
        anonymous: "anonymous",
        destination: "destination",
        opensAt: "opensAt",
        closesAt: "closesAt",
        dailyCap: "dailyCap",
        notify: "notify",
        hourlyCap: "hourlyCap",
      },
      indexes: [["status"], ["kind"]],
    },
    submission: {
      label: "Submission",
      plural: "Submissions",
      icon: "inbox",
      titleField: "title",
      titleDefault: { from: ["form"] },
      description:
        "One set of answers to one version of a form, made only by the answers someone sends " +
        "(or staff enter). Read by staff only, never by the person who sent it.",
      navigation: "main",
      navigationOrder: 41,
      owner: "owner",
      fields: {
        title: {
          type: "text",
          label: "Title",
          description: "Left empty, the form's title.",
        },
        form: { type: "relation", label: "Form", to: "forms.form", required: true },
        version: {
          type: "number",
          label: "Version",
          description: "The version of the form answered: its questions and words.",
        },
        person: {
          type: "relation",
          label: "Person",
          to: "person",
          description: "Who sent it. None on an anonymous form.",
        },
        certainty: {
          type: "select",
          label: "How sure",
          options: [
            { value: "account", label: "Signed in" },
            { value: "link", label: "Personal link" },
            { value: "staff", label: "Entered by staff" },
            { value: "address", label: "Unconfirmed address", color: "amber" },
          ],
          description:
            "How the host knows whose it is. Unconfirmed address: someone typed this address; " +
            "nothing on the person's record was changed by it.",
        },
        answers: {
          type: "document",
          label: "Answers",
          schema: ANSWERS_SCHEMA,
          maxBytes: ANSWERS_MAX_BYTES,
        },
        rating: {
          type: "number",
          label: "Rating",
          description: "The first rating answered, for lists and dashboards.",
        },
        marketing: {
          type: "boolean",
          label: "Asked to hear from us",
          description:
            "They ticked a “keep me updated” line. The words they saw are the version's.",
        },
        via: {
          type: "select",
          label: "Came in",
          options: [
            { value: "site", label: "Website" },
            { value: "app", label: "App" },
            { value: "page", label: "Form page" },
            { value: "link", label: "Personal link" },
            { value: "staff", label: "Staff" },
          ],
        },
        owner: { type: "user", label: "Owner" },
        notes: { type: "longText", label: "Notes" },
        status: {
          type: "select",
          label: "Status",
          track: "timeline",
          options: [
            { value: "new", label: "New" },
            { value: "inHand", label: "In hand" },
            { value: "done", label: "Done" },
            { value: "spam", label: "Spam", color: "gray" },
          ],
        },
      },
      states: {
        field: "status",
        initial: "new",
        moves: [
          { from: "new", to: "inHand", by: ["staff"] },
          { from: ["new", "inHand"], to: "done", by: ["staff"] },
          { from: "done", to: "inHand", by: ["staff"] },
          // Spam is the host's (the door keeps a flood as spam) and a person's: markSpam and
          // notSpam only, which an AI may ask for and a person approves (ADR 0552).
          { from: ["new", "inHand", "done"], to: "spam", by: ["host"], tools: ["markSpam"] },
          { from: "spam", to: "new", by: ["host"], tools: ["notSpam"] },
        ],
      },
      intake: {
        role: "submission",
        form: "form",
        version: "version",
        answers: "answers",
        person: "person",
        certainty: "certainty",
        spam: "spam",
        via: "via",
        rating: "rating",
        marketing: "marketing",
      },
      // The door's caps count by form and time (ADR 0722); the inbox lists by state and time.
      indexes: [["form", "createdAt"], ["createdAt"], ["status", "createdAt"], ["person"]],
    },
  },
  views: {
    newAnswers: {
      label: "New answers",
      object: "forms.submission",
      filter: { field: "status", op: "eq", value: "new" },
      sort: { field: "createdAt", direction: "desc" },
      columns: INBOX_COLUMNS,
    },
    inHand: {
      label: "In hand",
      object: "forms.submission",
      filter: { field: "status", op: "eq", value: "inHand" },
      sort: { field: "createdAt", direction: "desc" },
      columns: INBOX_COLUMNS,
    },
    spam: {
      label: "Spam",
      object: "forms.submission",
      filter: { field: "status", op: "eq", value: "spam" },
      sort: { field: "createdAt", direction: "desc" },
      columns: ["title", "person", "via", "createdAt"],
    },
    // "Keep me updated" (decision 10): who said yes, when, and to which version's words. Until
    // Notifications keeps a consent register (stage 30), this list is where they are.
    askedToHear: {
      label: "Asked to hear from us",
      object: "forms.submission",
      filter: {
        and: [
          { field: "marketing", op: "eq", value: true },
          { field: "status", op: "neq", value: "spam" },
        ],
      },
      sort: { field: "createdAt", direction: "desc" },
      columns: ["person", "form", "version", "createdAt"],
    },
    openForms: {
      label: "Open forms",
      object: "forms.form",
      filter: { field: "status", op: "eq", value: "open" },
      sort: { field: "title", direction: "asc" },
      columns: ["title", "kind", "answeredBy", "publishState", "closesAt"],
    },
  },
  // A person's answers on their page, and a form's on its own.
  recordTabs: {
    personAnswers: {
      label: "Form answers",
      on: "person",
      view: {
        type: "table",
        object: "forms.submission",
        relation: "person",
        columns: ["title", "status", "certainty", "rating", "createdAt"],
        sort: { field: "createdAt", direction: "desc" },
      },
      order: 60,
    },
    formAnswers: {
      label: "Answers",
      on: "forms.form",
      view: {
        type: "table",
        object: "forms.submission",
        relation: "form",
        columns: INBOX_COLUMNS,
        sort: { field: "createdAt", direction: "desc" },
      },
      order: 10,
    },
  },
  settings: {
    // The door's hourly cap across every form (ADR 0722): an abuse setting, a person's to change.
    hourlyCap: {
      type: "number",
      label: "Answers an hour, at most",
      description:
        "Across every form. Over it, new answers are turned away for the hour and the admins " +
        "are told. Raise it for a busy day.",
      default: 200,
      min: 1,
      max: 10_000,
      personApproves: true,
    },
  },
  automations: formsAutomations,
  tools: { form, submit, enter, move, markSpam, notSpam },
});
