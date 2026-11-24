// Courses (stage 42): video courses a studio sells, one at a time or in fixed bundles, which a
// buyer watches lesson by lesson on the web and in the app. Requires Programs (a lesson can be a
// training session). A product that does not list it has none of this.
//
// Everything that is a rule is the host's, declared here as behaviours (ADR 0404):
//   - a course and a bundle are `publishable` with a public half (ADRs 0446, 0442): staff and the
//     assistant edit the working copy; a person publishes; the public reads the published version;
//   - both are `sellable` (ADR 0435): the host prices an order from the record, and a paid line
//     grants one enrolment in the paid batch; a full refund voids it in the refund's batch;
//   - who holds access to a course is `access` (ADR 0477): an enrolment of theirs that is active
//     and inside its `until`, pointing at the course or at a bundle whose published version lists
//     it. The outline's lesson material is for holders (the `holders` flag in outline.ts), so the
//     host removes it for everyone else, and `media.play` plays a lesson's video only to a holder;
//   - an enrolment and a lesson's progress are their student's (`customer`); progress is written
//     only while the student holds access to its course (`requireAccess`, ADR 0478);
//   - a course plan is `sellable` with `recurring` (stage 32a, ADR 0485): a subscription to it,
//     which the payment provider charges every month, gives every live course through the host's
//     `subscription` access source (ADR 0488), to its holder, while the host's record says it
//     runs. One free trial per person per plan object is the host's rule (ADR 0489).
// The tools in tools.ts compose the host's operations and hold no rule of their own.
import { type AgreementsSpec, defineExtension } from "@composable-os/sdk";
import { coursesAutomations } from "./automations.ts";
import { coursesDashboards } from "./dashboards.ts";
import { OUTLINE_MAX_BYTES, OUTLINE_SCHEMA } from "./outline.ts";
import {
  buy,
  catalogue,
  course,
  draft,
  endEnrolment,
  enrol,
  lesson,
  myCourses,
  plans,
  progress,
  startSession,
  stats,
} from "./tools.ts";

const ACTIVE = { states: ["active"], until: "until" };
// Where agreement may be needed to buy a course, a bundle or a plan (stage 44, ADR 0641): nothing
// is attached by default, so each sells as before until the business attaches a document (its
// terms) to "course". The course page and subscribe blocks show what is due and let the buyer
// agree on the way (issue #292).
const BUYING: AgreementsSpec = {
  point: "course",
  label: "Buying a course",
  suggests: ["terms"],
  inlineStep: true,
};

export default defineExtension({
  id: "courses",
  version: "0.1.0",
  contractVersion: 1,
  label: "Courses",
  description:
    "Video courses sold one at a time or in bundles, watched lesson by lesson, with progress. " +
    "A lesson can be a training session from Programs.",
  // A session lesson is a Programs program, and a text lesson (and a video's notes) is drawn by
  // Content's rich text blocks (`content-rich-text`, `content-native-rich-text`) in the player:
  // the host installs Courses only beside both, and `cos add` brings Content's block with it.
  requires: ["programs", "content"],
  permissions: {
    // person.get: a student's name in the stats. programs.*: a session lesson's program, its
    // assignment and dated sessions, made by x.programs.assign for the student (step 6).
    read: ["person", "programs.program", "programs.assignment", "programs.session"],
    write: ["programs.assignment", "programs.session"],
    // record.* and my.* are not listed: listed, they would reach every object. Courses' own
    // objects need no grant, and Programs' are the read and write lists above.
    operations: [
      "public.list",
      "public.get",
      "access.check",
      "order.start",
      "media.list",
      "order.settings.get",
      "query.sql",
      // A session lesson's program, assigned to its student on their first open (step 6).
      "x.programs.assign",
    ],
    modules: ["ops", "ai"],
  },
  objects: {
    theme: {
      label: "Theme",
      plural: "Themes",
      icon: "shapes",
      titleField: "name",
      description: "What courses are grouped by in the catalogue: handstands, mobility.",
      navigation: "settings",
      fields: {
        name: { type: "text", label: "Name", required: true },
        slug: { type: "slug", label: "Slug" },
        order: { type: "number", label: "Order", min: 0, max: 1000, step: 1 },
        summary: { type: "text", label: "Short description" },
        picture: { type: "image", label: "Picture" },
      },
      // Every live theme is the catalogue's.
      public: { read: ["name", "slug", "order", "summary", "picture"] },
    },
    course: {
      label: "Course",
      plural: "Courses",
      icon: "graduation-cap",
      titleField: "title",
      description: "A course of lessons a studio sells: its outline, price, trailer and cover.",
      navigation: "main",
      navigationOrder: 15,
      fields: {
        title: { type: "text", label: "Title", required: true },
        slug: { type: "slug", label: "Slug" },
        theme: { type: "relation", label: "Theme", to: "courses.theme" },
        level: {
          type: "number",
          label: "Level",
          min: 1,
          max: 3,
          step: 1,
          description: "1 to 3: beginner, intermediate, advanced.",
        },
        summary: { type: "text", label: "Summary" },
        description: { type: "richText", label: "Description" },
        cover: { type: "image", label: "Cover" },
        trailer: { type: "video", label: "Trailer" },
        price: { type: "currency", label: "Price", required: true },
        onSaleFrom: { type: "datetime", label: "On sale from" },
        outline: {
          type: "document",
          label: "Outline",
          schema: OUTLINE_SCHEMA,
          maxBytes: OUTLINE_MAX_BYTES,
        },
      },
      publishable: {
        content: [
          "title",
          "theme",
          "level",
          "summary",
          "description",
          "cover",
          "trailer",
          "outline",
        ],
        slug: "slug",
      },
      public: {
        read: [
          "title",
          "slug",
          "theme",
          "level",
          "summary",
          "description",
          "cover",
          "trailer",
          "price",
          "onSaleFrom",
          "outline",
        ],
      },
      agreements: BUYING,
      sellable: {
        price: "price",
        saleWindow: { from: "onSaleFrom" },
        // On-demand online courses, no place (ADR 0479): taxed only once an admin turns tax on.
        tax: { code: "txcd_20060158" },
        // In the finance reports (ADR 0792): earned when it is bought.
        finance: { category: { key: "courses", label: "Courses" }, earned: "at_sale" },
        grants: {
          object: "enrolment",
          set: { holder: "order.person", course: "item", order: "order", code: "code" },
          void: "void",
        },
      },
      access: {
        sources: [
          { via: "courses.enrolment", field: "course", ...ACTIVE },
          { via: "courses.enrolment", field: "bundle", through: "courses", ...ACTIVE },
          // A running course subscription (stage 32a, ADR 0488): every live course, including
          // ones published later, while the host's subscription record says it gives access.
          { kind: "subscription", options: { plans: "courses.plan", covers: "all" } },
        ],
      },
      indexes: [["theme"]],
    },
    bundle: {
      label: "Bundle",
      plural: "Bundles",
      icon: "package",
      titleField: "title",
      description: "A fixed set of courses sold together at one price.",
      navigation: "main",
      navigationOrder: 16,
      fields: {
        title: { type: "text", label: "Title", required: true },
        slug: { type: "slug", label: "Slug" },
        summary: { type: "text", label: "Summary" },
        description: { type: "richText", label: "Description" },
        cover: { type: "image", label: "Cover" },
        courses: {
          type: "document",
          label: "Courses",
          schema: {
            root: {
              type: "object",
              fields: {
                items: {
                  type: "array",
                  min: 2,
                  max: 10,
                  of: { type: "ref", to: "courses.course" },
                },
              },
            },
          },
        },
        price: { type: "currency", label: "Price", required: true },
      },
      publishable: {
        content: ["title", "summary", "description", "cover", "courses"],
        slug: "slug",
      },
      public: { read: ["title", "slug", "summary", "description", "cover", "courses", "price"] },
      agreements: BUYING,
      sellable: {
        price: "price",
        tax: { code: "txcd_20060158" },
        // In the finance reports (ADR 0792): earned when it is bought.
        finance: { category: { key: "courses", label: "Courses" }, earned: "at_sale" },
        grants: {
          object: "enrolment",
          set: { holder: "order.person", bundle: "item", order: "order", code: "code" },
          void: "void",
        },
      },
    },
    plan: {
      label: "Course plan",
      plural: "Course plans",
      icon: "repeat",
      titleField: "title",
      description:
        "A subscription to every published course, paid every month, with a free trial when it " +
        "has trial days. One trial per person per plan; the payment provider charges each month.",
      navigation: "main",
      navigationOrder: 18,
      fields: {
        title: { type: "text", label: "Title", required: true },
        description: { type: "text", label: "Description" },
        price: { type: "currency", label: "Price per month", required: true },
        trialDays: {
          type: "number",
          label: "Free trial (days)",
          min: 0,
          max: 90,
          step: 1,
          description: "Empty or 0: charged from the start. A person gets one trial on any plan.",
        },
      },
      // Every live plan is offered on the site.
      public: { read: ["title", "description", "price", "trialDays"] },
      agreements: BUYING,
      sellable: {
        price: "price",
        // As its courses (ADR 0479): taxed only once a human admin turns tax on.
        tax: { code: "txcd_20060158" },
        // In the finance reports (ADR 0792): courses, but a paid month is earned over the month.
        finance: { category: { key: "courses", label: "Courses" }, earned: "over_period" },
        // A plan (ADR 0485): subscribed to with subscription.start, never put on an order.
        recurring: { interval: "month", trialDays: "trialDays" },
      },
    },
    enrolment: {
      label: "Enrolment",
      plural: "Enrolments",
      icon: "badge-check",
      titleField: "code",
      description:
        "A student's access to a course or a bundle: bought (granted by a paid order), given by " +
        "staff, or imported. Voided when its order is refunded in full.",
      navigation: "main",
      navigationOrder: 17,
      fields: {
        code: { type: "text", label: "Code", readOnly: true },
        holder: { type: "relation", label: "Student", to: "person" },
        course: { type: "relation", label: "Course", to: "courses.course" },
        bundle: { type: "relation", label: "Bundle", to: "courses.bundle" },
        // Which order granted it, set by the host's grant (ADR 0590, the fourth review).
        order: {
          type: "text",
          label: "Order",
          readOnly: true,
          description: "The order that granted this enrolment, set by the host.",
        },
        source: {
          type: "select",
          label: "Where it came from",
          default: "purchase",
          options: [
            { value: "purchase", label: "Bought" },
            { value: "staff", label: "Given by staff" },
            { value: "import", label: "Imported" },
          ],
        },
        reason: { type: "text", label: "Why it was given or ended" },
        from: { type: "datetime", label: "From" },
        until: {
          type: "datetime",
          label: "Until",
          description: "Empty: for as long as the course is offered.",
        },
        completed: {
          type: "boolean",
          label: "Completed (imported)",
          description: "Marked done on the old platform: the course shows as complete.",
        },
        status: {
          type: "select",
          label: "Status",
          track: "timeline",
          options: [
            { value: "active", label: "Active" },
            { value: "ended", label: "Ended" },
            { value: "void", label: "Void" },
          ],
        },
      },
      states: {
        field: "status",
        initial: "active",
        moves: [
          { from: "active", to: "ended", by: ["staff"] },
          { from: "ended", to: "active", by: ["staff"] },
          // A full refund of its order (the host, ADR 0435); never a customer.
          { from: ["active", "ended"], to: "void", by: ["host"], final: true },
        ],
      },
      customer: {
        field: "holder",
        read: ["course", "bundle", "source", "from", "until", "completed", "status"],
        write: [],
      },
      timelineLinks: ["holder"],
      indexes: [["holder"], ["course"], ["bundle"], ["order"]],
    },
    progress: {
      label: "Progress",
      plural: "Progress",
      icon: "list-checks",
      titleField: "lessonKey",
      description:
        "One student's progress on one lesson: started or done, and where a video was left.",
      navigation: "settings",
      fields: {
        holder: { type: "relation", label: "Student", to: "person", required: true },
        course: { type: "relation", label: "Course", to: "courses.course", required: true },
        lessonKey: { type: "text", label: "Lesson", required: true },
        state: {
          type: "select",
          label: "State",
          options: [
            { value: "started", label: "Started" },
            { value: "done", label: "Done" },
          ],
        },
        startedAt: { type: "datetime", label: "Started" },
        doneAt: { type: "datetime", label: "Done" },
        position: {
          type: "number",
          label: "Position (seconds)",
          min: 0,
          max: 86_400,
          description: "Where the video was left, so the player resumes there.",
        },
        source: {
          type: "select",
          label: "Where it came from",
          default: "self",
          options: [
            { value: "self", label: "The student" },
            { value: "import", label: "Imported" },
          ],
        },
      },
      customer: {
        field: "holder",
        read: ["course", "lessonKey", "state", "startedAt", "doneAt", "position", "source"],
        write: ["course", "lessonKey", "state", "startedAt", "doneAt", "position"],
        // Written only while the student holds access to the course (ADR 0478).
        requireAccess: ["course"],
      },
      indexes: [
        ["holder", "course"],
        ["course", "lessonKey"],
      ],
    },
  },
  views: {
    published: {
      label: "Published courses",
      object: "courses.course",
      filter: { field: "publishState", op: "eq", value: "published" },
      sort: { field: "title", direction: "asc" },
      columns: ["title", "theme", "level", "price", "publishedAt"],
    },
    drafts: {
      label: "Drafts",
      object: "courses.course",
      filter: { field: "publishState", op: "eq", value: "draft" },
      sort: { field: "updatedAt", direction: "desc" },
      columns: ["title", "theme", "level", "updatedAt"],
    },
    enrolmentsThisMonth: {
      label: "Enrolments this month",
      object: "courses.enrolment",
      filter: { field: "createdAt", op: "gte", value: { $relative: "startOfMonth" } },
      sort: { field: "createdAt", direction: "desc" },
      columns: ["holder", "course", "bundle", "source", "status", "createdAt"],
    },
    importedEnrolments: {
      label: "Imported enrolments",
      object: "courses.enrolment",
      filter: { field: "source", op: "eq", value: "import" },
      sort: { field: "createdAt", direction: "desc" },
      columns: ["holder", "course", "bundle", "completed", "until", "createdAt"],
    },
  },
  dashboards: coursesDashboards,
  recordTabs: {
    personCourses: {
      label: "Courses",
      on: "person",
      view: {
        type: "table",
        object: "courses.enrolment",
        relation: "holder",
        columns: ["course", "bundle", "source", "status", "until", "createdAt"],
        sort: { field: "createdAt", direction: "desc" },
      },
      order: 35,
    },
    personProgress: {
      label: "Lessons",
      on: "person",
      view: {
        type: "table",
        object: "courses.progress",
        relation: "holder",
        columns: ["course", "lessonKey", "state", "doneAt", "position"],
        sort: { field: "updatedAt", direction: "desc" },
      },
      order: 36,
    },
  },
  automations: coursesAutomations,
  grantable: ["courses:enrol"],
  tools: {
    catalogue,
    course,
    lesson,
    progress,
    myCourses,
    plans,
    buy,
    enrol,
    endEnrolment,
    stats,
    draft,
    startSession,
  },
  // A staff screen in the product's admin (stage 47, ADR 0660): the course builder, a tab on the
  // course (it builds one course). It saves the course through the host's record writes, so it is
  // gated by writing a course: any member, never a viewer or a pack role.
  screens: {
    builder: {
      label: "Builder",
      block: "courses-builder",
      export: "CourseBuilder",
      writes: ["courses.course"],
      record: { object: "courses.course", as: "courseId" },
    },
  },
});
