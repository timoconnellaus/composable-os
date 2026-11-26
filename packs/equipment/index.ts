// Equipment (stage 59, step 3; ADR 0862): the register of what a business owns and must look
// after (a gym's treadmills, racks and sauna; a tradesperson's tools, test gear and vans), and the
// faults staff report on it. Any product can turn it on (`packs` in its product.ts); it needs no
// other pack.
//
// Everything that is a rule is the host's, declared here as behaviours (ADR 0404):
//   - an item's tag (the code on its sticker) is `unique` among items in or out of service (ADR
//     0502), folded (ADR 0864: case and outer spaces never count, the host keeps it trimmed and
//     upper case): the database refuses a second, however it is written (a form, the assistant,
//     an import). A retired item gives its tag up, for the replacement wearing the old sticker;
//   - a record in a state only tools leave stays out of the Trash but for those tools' hands
//     (ADR 0863): an out-of-service item, or an open fault, is not made to vanish by a member; an
//     open fault holds its item (`holds`), so an item with open faults is a manager's to Trash;
//   - the tag is given when the item is added (by the form or the admin's import) and then
//     changed only by a manager's `correctTag` (`lockedIn` every state, ADR 0865), and a fault's
//     item is the report's (`readOnly`): no retag or re-point frees a sticker or moves a safety
//     risk;
//   - why an item is out, and a fault's severity and words once reported, are written by the
//     pack's tools only (`readOnly`), so a safety risk is never quietly lowered; a manager
//     corrects them with `correctOutReason` and `correctFault`;
//   - an item is in service, out of service or retired (`states`, ADR 0425). Out of service is a
//     move only the tools `takeOut` and `reportFault` make (ADR 0513), for anyone holding
//     `equipment:report`, and an AI's call waits for a person (`personApproves`, ADR 0552). Back
//     in service is a move only `putBack` makes: a person's own act (`humanOnly`), and only with
//     `equipment:manage` (decision 4). Retiring is `retire`'s, a manager's (ADR 0625);
//   - a fault is reported, acknowledged, then fixed, not a fault or a duplicate; every move after
//     the report is `triage`'s, a manager's, and every close says why.
// The tools in tools.ts compose the host's operations and add no rule of their own.
//
// Service plans and maintenance (step 4), the member's report and what members read (step 5),
// automations, the dashboard and views (step 6), and the blocks (step 7) come later.
import { defineExtension } from "@composable-os/sdk";
import {
  correctFault,
  correctOutReason,
  correctTag,
  FAULT,
  ITEM,
  item,
  MANAGE,
  putBack,
  REPORT,
  register,
  reportFault,
  reportFaultOnly,
  retire,
  takeOut,
  triage,
} from "./tools.ts";

/** The categories a register starts with (decision 1: to be checked with the business). */
const CATEGORIES = [
  { value: "cardio", label: "Cardio" },
  { value: "strength", label: "Strength" },
  { value: "free_weights", label: "Free weights" },
  { value: "studio", label: "Studio" },
  { value: "wet_area", label: "Wet area" },
  { value: "tool", label: "Tool" },
  { value: "test_gear", label: "Test gear" },
  { value: "vehicle", label: "Vehicle" },
  { value: "other", label: "Other" },
];

/** The fault moves `triage` makes: from either open state, each with why. */
const OPEN_FAULT = ["reported", "acknowledged"];

export default defineExtension({
  id: "equipment",
  version: "0.1.0",
  contractVersion: 1,
  label: "Equipment",
  description:
    "A register of what the business owns and looks after, with tags, suppliers, costs and " +
    "warranties; faults reported by staff; items taken out of service by any staff member and " +
    "put back by a manager.",
  permissions: {
    // query.sql: the register's one read, items with their supplier and open faults over the
    // rec_* views. organisation: the supplier's name on an item.
    read: ["organisation"],
    operations: ["query.sql"],
    modules: ["ops"],
  },
  // Reporting (and taking out of service) is every staff member's, and a coach's or a cleaner's
  // when an admin grants it (ADR 0600). Managing is restricted (ADR 0625): admins hold it, and
  // whoever an admin grants it to.
  grantable: [REPORT, MANAGE],
  restricted: [MANAGE],
  grantableLabels: {
    [REPORT]:
      "Equipment: see the register, report a fault and take an item out of service. For a " +
      "coach, a cleaner or anyone with another role who works on the floor.",
    [MANAGE]:
      "Equipment: put items back in service, retire them, acknowledge and close faults, and " +
      "correct a fault's report, why an item is out of service or an item's tag",
  },
  objects: {
    item: {
      label: "Item",
      plural: "Equipment",
      icon: "wrench",
      titleField: "name",
      owner: "keeper",
      description:
        "One thing the business owns and looks after: a machine, a rack, a tool, a van. In " +
        "service, out of service (why, since when) or retired. Its tag is the code on its " +
        "sticker, unique in the register.",
      navigation: "main",
      navigationOrder: 70,
      fields: {
        name: { type: "text", label: "Name", required: true },
        category: {
          type: "select",
          label: "Category",
          editableOptions: true,
          options: CATEGORIES,
        },
        place: {
          type: "text",
          label: "Place",
          description: "Where it is: a room, an area of the floor, a van.",
        },
        tag: {
          type: "text",
          label: "Tag",
          description:
            "The code on its sticker. No two items in the register share one; an import matches " +
            "on it. Given when the item is added; after that only a manager changes it " +
            "(correctTag).",
          // The sticker stays with its machine (ADR 0865, the review of PR #502): once the item
          // exists, in any state, only the pack's correctTag (a manager's) changes it. So no
          // retag, before or after a take-out or under an open fault, frees it for a new item.
          lockedIn: ["in_service", "out_of_service", "retired"],
        },
        make: { type: "text", label: "Make" },
        model: { type: "text", label: "Model" },
        serial: { type: "text", label: "Serial number" },
        boughtOn: { type: "date", label: "Bought on" },
        cost: {
          type: "currency",
          label: "Cost",
          min: 0,
          description: "What it cost to buy, in the base currency. Seen by every staff member.",
        },
        supplier: {
          type: "relation",
          label: "Supplier",
          to: "organisation",
          description: "Who supplied it, and who services it under warranty.",
        },
        warrantyUntil: { type: "date", label: "Warranty until" },
        warrantyNotes: { type: "longText", label: "Warranty notes" },
        photo: { type: "image", label: "Photo" },
        keeper: {
          type: "user",
          label: "Keeper",
          description: "Who looks after it. Empty: the managers.",
        },
        issuedTo: {
          type: "user",
          label: "Who has it",
          description: "Who has it now (a tool or a van out with someone).",
        },
        renewalDue: {
          type: "date",
          label: "Renewal due",
          description: "A date it must be renewed by (a van's registration).",
        },
        listForMembers: {
          type: "select",
          label: "Listed for members",
          default: "not_listed",
          options: [
            { value: "listed", label: "Listed" },
            { value: "not_listed", label: "Not listed" },
          ],
          description:
            "Whether members may see it in the out-of-order list. Not listed until someone " +
            "chooses; retiring an item unlists it.",
        },
        state: {
          type: "select",
          label: "State",
          default: "in_service",
          track: "timeline",
          options: [
            { value: "in_service", label: "In service", color: "green" },
            { value: "out_of_service", label: "Out of service", color: "red" },
            { value: "retired", label: "Retired", color: "gray" },
          ],
        },
        outSince: {
          type: "datetime",
          label: "Out of service since",
          readOnly: true,
          description:
            "When it was taken out of service. Set when it is taken out, cleared when put back.",
        },
        outReason: {
          type: "text",
          label: "Why out of service",
          readOnly: true,
          description:
            "Why it must not be used. Given when it is taken out; written only by the tools " +
            "(a manager corrects it with correctOutReason), cleared when it is put back.",
        },
        notes: { type: "longText", label: "Notes" },
        retiredFlag: {
          type: "formula",
          label: "Retired",
          description: "True once retired: no fault is reported on it any more.",
          expression: 'coalesce(state, "in_service") == "retired"',
        },
      },
      indexes: [["state", "category"], ["category"], ["keeper"], ["warrantyUntil"]],
      // The code on its sticker names one item in or out of service (ADR 0502): the database
      // refuses the second, whoever writes it, an import included. Folded (ADR 0864): `tm-03 `
      // is `TM-03`. A retired item gives its tag up to its replacement; one without a tag is
      // not compared.
      unique: [{ fields: ["tag"], states: ["in_service", "out_of_service"], fold: true }],
      states: {
        field: "state",
        initial: "in_service",
        moves: [
          // Any staff member with equipment:report, through the two tools only (decision 4);
          // an AI's call waits for a person (personApproves, ADR 0552). Never a record write.
          {
            from: "in_service",
            to: "out_of_service",
            by: ["host"],
            tools: ["takeOut", "reportFault"],
            requires: ["outReason"],
          },
          // Back in service: a person with equipment:manage, never an AI (humanOnly).
          { from: "out_of_service", to: "in_service", by: ["host"], tools: ["putBack"] },
          // Retired: a manager's, with why, and unlisted for members in the same write.
          {
            from: ["in_service", "out_of_service"],
            to: "retired",
            by: ["host"],
            tools: ["retire"],
            requires: ["notes"],
            final: true,
          },
        ],
      },
    },
    fault: {
      label: "Fault",
      plural: "Faults",
      icon: "triangle-alert",
      titleField: "title",
      titleDefault: { from: ["item"], suffix: "fault" },
      description:
        "A report that something is wrong with an item: what is wrong and how bad. Reported by " +
        "staff, then acknowledged and closed as fixed, not a fault or a duplicate by a manager.",
      navigation: "main",
      navigationOrder: 71,
      fields: {
        title: { type: "text", label: "Title" },
        // The item the report is about: set by the report tools, never re-pointed (a safety risk
        // does not move to another machine).
        item: {
          type: "relation",
          label: "Item",
          to: "equipment.item",
          readOnly: true,
        },
        // What is wrong and how bad are the report's, written by the report tools only (a
        // manager corrects them with correctFault): a safety risk is never quietly lowered.
        description: {
          type: "longText",
          label: "What is wrong",
          readOnly: true,
          description: "What is wrong with it. Do not describe an injury here.",
        },
        severity: {
          type: "select",
          label: "How bad",
          default: "not_working",
          readOnly: true,
          options: [
            { value: "safety_risk", label: "Safety risk", color: "red" },
            { value: "not_working", label: "Not working", color: "orange" },
            { value: "worn", label: "Worn or cosmetic", color: "gray" },
          ],
        },
        photo: { type: "image", label: "Photo" },
        reportedBy: {
          type: "user",
          label: "Reported by",
          readOnly: true,
          description: "The staff member who reported it, set by the report.",
        },
        reportedByName: { type: "text", label: "Reported by (name)", readOnly: true },
        reportKey: {
          type: "text",
          label: "Report key",
          readOnly: true,
          description:
            "Set by the report: the same report again, or a retry, finds this fault while it is open.",
        },
        state: {
          type: "select",
          label: "State",
          default: "reported",
          track: "timeline",
          options: [
            { value: "reported", label: "Reported", color: "orange" },
            { value: "acknowledged", label: "Acknowledged", color: "blue" },
            { value: "fixed", label: "Fixed", color: "green" },
            { value: "not_a_fault", label: "Not a fault", color: "gray" },
            { value: "duplicate", label: "Duplicate", color: "gray" },
          ],
        },
        closedWhy: {
          type: "text",
          label: "Closed because",
          description: "Why it was closed: what fixed it, or why it is not a fault.",
        },
      },
      indexes: [
        ["item", "state"],
        ["state", "severity"],
      ],
      // One open fault per report (a retry of a call stopped part way makes no second).
      unique: [{ fields: ["reportKey"], states: OPEN_FAULT }],
      states: {
        field: "state",
        initial: "reported",
        // Nobody reports a fault on a retired item, staff and tools included.
        // Every report names its item (read-only, so `required` is the create rule's).
        create: { closed: "item.retiredFlag", requires: ["item"] },
        // While open, a fault keeps its item out of the Trash but for whoever may triage it (ADR
        // 0863, amended): the safety risk never leaves the register with the item.
        holds: "item",
        // Triage is a manager's (equipment:manage), through `triage` only: a record write cannot
        // close a fault, and an AI's triage waits for a person.
        moves: [
          { from: "reported", to: "acknowledged", by: ["host"], tools: ["triage"] },
          {
            from: OPEN_FAULT,
            to: "fixed",
            by: ["host"],
            tools: ["triage"],
            requires: ["closedWhy"],
            final: true,
          },
          {
            from: OPEN_FAULT,
            to: "not_a_fault",
            by: ["host"],
            tools: ["triage"],
            requires: ["closedWhy"],
            final: true,
          },
          {
            from: OPEN_FAULT,
            to: "duplicate",
            by: ["host"],
            tools: ["triage"],
            requires: ["closedWhy"],
            final: true,
          },
        ],
      },
    },
  },
  recordTabs: {
    itemFaults: {
      label: "Faults",
      on: ITEM,
      view: {
        type: "table",
        object: FAULT,
        relation: "item",
        columns: ["title", "severity", "state", "reportedByName", "createdAt"],
        sort: { field: "createdAt", direction: "desc" },
      },
      order: 10,
    },
  },
  tools: {
    register,
    item,
    reportFault,
    reportFaultOnly,
    takeOut,
    putBack,
    retire,
    triage,
    correctFault,
    correctOutReason,
    correctTag,
  },
});
