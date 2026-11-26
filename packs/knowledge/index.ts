// Knowledge (stage 38 step 5, ADR 0706): how the business does things, written down once, and the
// answers to its customers' common questions. Any product can turn it on (`packs` in its
// product.ts). The platform ships no procedures and no help pages: they are the business's, added
// in the admin, by the assistant or by an MCP client, with a person publishing each.
//
// Everything that is a rule is the host's, declared here as behaviours (ADR 0404):
//   - both objects are `publishable` (ADRs 0446, 0441): staff and the assistant edit a working
//     copy; a person with the publish permission publishes it (an AI asks, ADR 0480);
//   - a procedure is for staff only: it declares no `public` and no `signedIn`, so nothing an edit
//     can change makes it public. `staffRead` (ADR 0701) opens its published version, never the
//     draft, to every staff account, pack roles included (a coach, a cleaner, the door), through
//     `content.staffGet`, `content.staffList` and `content.search`;
//   - a procedure is `acknowledge`d (ADR 0702): its "must read" (everyone, or staff roles, pack
//     roles and granted pack permissions) is asked to confirm each version that asks again, with
//     one tap; the host keeps the confirmation, and who must read, the owner and the review period are a
//     person's to change, once published only an admin's or a holder of knowledge:manage
//     (`managed`, ADR 0706). The notices are this pack's words, sent by the host;
//   - a help page is public in its published wording only (ADR 0442): `content.get`,
//     `content.list` and `content.search` serve the version last published, never a draft.
// The tools in tools.ts compose the host's operations and add no rule of their own. The screens
// (step 6, ADR 0708) are this pack's blocks (blocks/) over its headless entry (client/): the help
// centre for a business's website and app, and for staff the procedures, the reader with its
// confirm, To read and Read status; they show what the host answers and decide nothing.
import { defineExtension, MUST_READ_SCHEMA } from "@composable-os/sdk";
import { knowledgeAutomations } from "./automations.ts";
import {
  confirm,
  draftHelpPage,
  draftProcedure,
  helpTopics,
  MANAGE,
  readStatus,
  toRead,
  WRITE,
} from "./tools.ts";

const HELP_ICONS = [
  { value: "calendar", label: "Calendar" },
  { value: "credit-card", label: "Payments" },
  { value: "user-round", label: "Account" },
  { value: "smartphone", label: "App" },
  { value: "map-pin", label: "Getting here" },
  { value: "baby", label: "Children" },
  { value: "shield-check", label: "Safety" },
  { value: "wrench", label: "Care and repairs" },
  { value: "circle-help", label: "Other" },
];

export default defineExtension({
  id: "knowledge",
  version: "0.1.0",
  contractVersion: 1,
  label: "Knowledge",
  description:
    "Staff procedures read in their published wording and confirmed as read and understood, " +
    "with a review reminder, and help pages for customers on the business's website.",
  permissions: {
    // ack.*: a person's own list and confirmation, and who has read what for those who manage
    // (ADR 0702, from this pack's person-only tools). public.list: the help topics.
    // notification.send: the review reminder.
    operations: [
      "ack.mine",
      "ack.confirm",
      "ack.status",
      "ack.overview",
      "public.list",
      "notification.send",
    ],
    modules: ["ops"],
  },
  // Read status is for admins and those they allow (decision 13); writing procedures and help
  // pages is every member's, and a coach's or a cleaner's when an admin grants it (ADR 0600).
  grantable: [MANAGE, WRITE],
  restricted: [MANAGE],
  grantableLabels: {
    [MANAGE]:
      "See who has read and confirmed each procedure, and change who must read one once published",
    [WRITE]: "Write procedures and help pages (a person allowed to publish publishes them)",
  },
  objects: {
    procedure: {
      label: "Procedure",
      plural: "Procedures",
      icon: "list-checks",
      titleField: "title",
      owner: "owner",
      description:
        "How the business does something, for staff: read by every staff account in the wording " +
        "last published, never the draft, and confirmed as read and understood by those who " +
        "must read it.",
      navigation: "main",
      navigationOrder: 60,
      fields: {
        title: { type: "text", label: "Title", required: true },
        slug: {
          type: "slug",
          label: "Address",
          description: "How a link names the procedure. Made from the title.",
        },
        summary: {
          type: "text",
          label: "Summary",
          description: "One or two sentences for lists and search results.",
        },
        body: {
          type: "richText",
          label: "Body",
          description:
            "The procedure. Each heading is a section that search and the assistant link to. " +
            "Name a role, not a person ('the duty manager', not 'Sam').",
        },
        section: { type: "relation", label: "Section", to: "knowledge.section" },
        owner: {
          type: "user",
          label: "Kept right by",
          description:
            "Who keeps it right: told when it is time to review it, and each week who has not " +
            "confirmed it.",
        },
        mustRead: {
          type: "document",
          label: "Must read",
          schema: MUST_READ_SCHEMA,
          description:
            "Who is asked to confirm it: everyone, or some staff roles, pack roles (a coach, a " +
            "cleaner) and granted permissions (the front desk). Every staff account may read it " +
            "either way. Changing it counts at once.",
        },
        reviewEvery: {
          type: "number",
          label: "Review every (months)",
          default: 12,
          min: 0,
          max: 120,
          step: 1,
          description: "How often its owner is asked to check it is still right. 0: never.",
        },
        nextReview: {
          type: "formula",
          label: "Next review",
          description: "Its last publish plus the review period. Empty when it is never reviewed.",
          expression:
            'if(coalesce(reviewEvery, 12) > 0, dateAdd(publishedAt, coalesce(reviewEvery, 12), "month"), null)',
        },
      },
      indexes: [["section"], ["owner"]],
      publishable: {
        content: ["title", "summary", "body", "section"],
        slug: "slug",
        staffRead: true,
        // The section's id, name and order with each procedure (ADR 0708): a coach reads no section.
        staffNames: [{ field: "section", order: "order" }],
        acknowledge: {
          who: "mustRead",
          manage: MANAGE,
          managed: ["reviewEvery", "owner"],
          owner: "owner",
          notices: {
            asked: {
              title: "Please read: {record}",
              body:
                "A procedure you must read has been published or changed. Read it and confirm " +
                "you have read and understood it.",
            },
            reminder: {
              title: "Still to read: {record}",
              body: "Read this procedure and confirm you have read and understood it.",
              afterDays: 7,
            },
            outstanding: { title: "Not yet confirmed: {record}" },
            welcome: {
              title: "Procedures to read",
              body: "Welcome. Read these procedures and confirm each one:",
            },
          },
        },
      },
    },
    section: {
      label: "Section",
      plural: "Sections",
      icon: "shapes",
      titleField: "name",
      navigation: "settings",
      description:
        "A group of procedures (opening and closing, safety, the front desk). Staff only.",
      fields: {
        name: { type: "text", label: "Name", required: true },
        order: { type: "number", label: "Order", step: 1 },
      },
      indexes: [["order"]],
    },
    helppage: {
      label: "Help page",
      plural: "Help pages",
      icon: "newspaper",
      titleField: "title",
      description:
        "An answer to a customer's question, on the business's website for anyone. The public " +
        "reads the version last published.",
      navigation: "main",
      navigationOrder: 61,
      fields: {
        title: { type: "text", label: "Title", required: true },
        slug: {
          type: "slug",
          label: "Address",
          description: "Where the page is read: /help/<address>. Made from the title.",
        },
        summary: {
          type: "text",
          label: "Summary",
          description: "One or two sentences for lists, search results and link previews.",
        },
        body: { type: "richText", label: "Body" },
        topic: { type: "relation", label: "Topic", to: "knowledge.helptopic" },
        order: { type: "number", label: "Order in its topic", step: 1 },
        related: {
          type: "relation",
          label: "Related pages",
          to: "knowledge.helppage",
          many: true,
        },
        seoTitle: { type: "text", label: "Search title" },
        seoDescription: { type: "text", label: "Search description" },
        noindex: {
          type: "boolean",
          label: "Hide from search engines",
          description: "Asks search engines not to list the page.",
        },
      },
      indexes: [["topic", "order"]],
      publishable: {
        content: [
          "title",
          "summary",
          "body",
          "topic",
          "order",
          "related",
          "seoTitle",
          "seoDescription",
          "noindex",
        ],
        slug: "slug",
      },
      public: {
        read: [
          "title",
          "slug",
          "summary",
          "body",
          "topic",
          "order",
          "related",
          "seoTitle",
          "seoDescription",
          "noindex",
          "publishedAt",
        ],
      },
    },
    helptopic: {
      label: "Help topic",
      plural: "Help topics",
      icon: "tags",
      titleField: "name",
      navigation: "settings",
      description: "A group of help pages, as the help centre's menu shows them.",
      fields: {
        name: { type: "text", label: "Name", required: true },
        slug: { type: "slug", label: "Address" },
        order: { type: "number", label: "Order", step: 1 },
        icon: { type: "select", label: "Icon", options: HELP_ICONS },
      },
      indexes: [["order"]],
      // Every live topic is public: a help centre's menu.
      public: { read: ["name", "slug", "order", "icon"] },
    },
  },
  views: {
    procedureDrafts: {
      label: "Procedure drafts",
      object: "knowledge.procedure",
      filter: { field: "publishState", op: "eq", value: "draft" },
      sort: { field: "updatedAt", direction: "desc" },
      columns: ["title", "section", "owner", "updatedAt"],
    },
    procedures: {
      label: "Published procedures",
      object: "knowledge.procedure",
      filter: { field: "publishState", op: "eq", value: "published" },
      sort: { field: "title", direction: "asc" },
      columns: ["title", "section", "owner", "publishedVersion", "publishedAt", "nextReview"],
    },
    reviewDue: {
      label: "Procedures by next review",
      object: "knowledge.procedure",
      filter: {
        and: [
          { field: "publishState", op: "eq", value: "published" },
          { field: "nextReview", op: "is_not_null" },
        ],
      },
      sort: { field: "nextReview", direction: "asc" },
      columns: ["title", "owner", "nextReview", "publishedAt"],
    },
    helpDrafts: {
      label: "Help page drafts",
      object: "knowledge.helppage",
      filter: { field: "publishState", op: "eq", value: "draft" },
      sort: { field: "updatedAt", direction: "desc" },
      columns: ["title", "topic", "updatedAt"],
    },
    helpPages: {
      label: "Published help pages",
      object: "knowledge.helppage",
      filter: { field: "publishState", op: "eq", value: "published" },
      sort: { field: "title", direction: "asc" },
      columns: ["title", "topic", "publishedVersion", "publishedAt"],
    },
  },
  recordTabs: {
    sectionProcedures: {
      label: "Procedures",
      on: "knowledge.section",
      view: {
        type: "table",
        object: "knowledge.procedure",
        relation: "section",
        columns: ["title", "publishState", "owner", "nextReview"],
        sort: { field: "title", direction: "asc" },
      },
      order: 10,
    },
    topicPages: {
      label: "Help pages",
      on: "knowledge.helptopic",
      view: {
        type: "table",
        object: "knowledge.helppage",
        relation: "topic",
        columns: ["title", "publishState", "order"],
        sort: { field: "order", direction: "asc" },
      },
      order: 10,
    },
  },
  tools: { toRead, confirm, readStatus, helpTopics, draftProcedure, draftHelpPage },
  automations: knowledgeAutomations,
  // Staff screens in the product's admin (stage 47, ADR 0660; step 6, ADR 0708), each gated by the
  // tools that decide who may open it. Procedures, the reader and To read are every staff
  // account's, pack roles included (`toRead` and `confirm` are `anyStaff`), so a coach's or a
  // cleaner's small shell lists them; Read status is `readStatus`'s: admins and those granted
  // knowledge:manage, a person only. The reader is a record screen: a tab on a procedure's record
  // page showing its published wording, and what a notice's link opens for an account that cannot
  // open the record page (a pack role).
  screens: {
    procedures: {
      label: "Procedures",
      block: "knowledge-procedures",
      export: "Procedures",
      nav: { group: "Knowledge", order: 10 },
      opens: ["toRead", "confirm"],
    },
    toRead: {
      label: "To read",
      block: "knowledge-to-read",
      export: "ToRead",
      nav: { group: "Knowledge", order: 20 },
      opens: ["toRead", "confirm"],
    },
    reader: {
      label: "As published",
      block: "knowledge-procedures",
      export: "ProcedureScreen",
      opens: ["toRead", "confirm"],
      record: { object: "knowledge.procedure", as: "procedureId" },
    },
    readStatus: {
      label: "Read status",
      block: "knowledge-read-status",
      export: "ReadStatus",
      nav: { group: "Knowledge", order: 30 },
      opens: ["readStatus"],
    },
  },
});
