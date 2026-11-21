// Programs (stage 41): one bank of exercises, programs built from it, published as versions,
// assigned to a person or to a class type as dated sessions, and a log of every set done
// against its target. Any product can turn it on (`packs` in its product.ts); a product that
// does not list it has none of this.
//
// Everything that is a rule is the host's, declared here as behaviours (ADR 0404):
//   - a program's layout is one document checked against LAYOUT_SCHEMA on every write
//     (`document`, ADR 0445), and its sessions' plans against SESSION_PLAN_SCHEMA;
//   - a program has a working copy and published versions (`publishable`, ADR 0446): coaches
//     edit freely, a person with the publish permission publishes, and an assignment pins one;
//   - a person's assignments, sessions and logs are theirs (`customer`), and a class type's are
//     read by every signed-in member (`signedIn`, ADR 0447); the bank and the class types are
//     read by every signed-in member; a member writes a log only against a session they can see;
//   - an assignment and a session move through fixed states (`states`), each move made from a
//     current read (ADR 0437).
// The tools in tools.ts compose the host's operations and add no rules of their own.
import { defineExtension } from "@composable-os/sdk";
import { LAYOUT_SCHEMA, SESSION_PLAN_SCHEMA } from "./layout.ts";
import {
  assign,
  classToday,
  history,
  logAdd,
  logUpdate,
  progress,
  sessionComplete,
  sessionGet,
  today,
} from "./tools.ts";

const kind = {
  type: "select",
  label: "For",
  readOnly: true,
  description: "A person's own, or a class type's (read by every signed-in member).",
  options: [
    { value: "personal", label: "A person" },
    { value: "class", label: "A class type" },
  ],
} as const;

export default defineExtension({
  id: "programs",
  version: "0.1.0",
  contractVersion: 1,
  label: "Programs",
  description:
    "An exercise bank, programs built from it as one layout (weeks, sessions, blocks, items, " +
    "levels, typed sets), published versions, assignments to a person or a class type as dated " +
    "sessions, and a log of every set against its target.",
  permissions: {
    // person.get: the name an assignment is titled with.
    read: ["person"],
    modules: ["ops"],
  },
  objects: {
    exercise: {
      label: "Exercise",
      plural: "Exercises",
      icon: "dumbbell",
      titleField: "name",
      description: "One exercise of the bank every program is built from.",
      navigation: "main",
      navigationOrder: 20,
      fields: {
        name: { type: "text", label: "Name", required: true },
        video: { type: "url", label: "Demo video" },
        cues: { type: "longText", label: "Coaching cues" },
        theme: {
          type: "select",
          label: "Theme",
          editableOptions: true,
          options: [
            { value: "mobility", label: "Mobility" },
            { value: "strength", label: "Strength" },
            { value: "handstands", label: "Handstands" },
            { value: "skill", label: "Skill" },
            { value: "conditioning", label: "Conditioning" },
          ],
        },
        level: {
          type: "select",
          label: "Level",
          options: [
            { value: "beginner", label: "Beginner" },
            { value: "intermediate", label: "Intermediate" },
            { value: "advanced", label: "Advanced" },
          ],
        },
        equipment: {
          type: "multiSelect",
          label: "Equipment",
          editableOptions: true,
          options: [
            { value: "none", label: "None" },
            { value: "rings", label: "Rings" },
            { value: "bar", label: "Bar" },
            { value: "parallettes", label: "Parallettes" },
            { value: "kettlebell", label: "Kettlebell" },
            { value: "dumbbell", label: "Dumbbell" },
            { value: "barbell", label: "Barbell" },
            { value: "band", label: "Band" },
            { value: "box", label: "Box" },
          ],
        },
        bodyAreas: {
          type: "multiSelect",
          label: "Body areas",
          editableOptions: true,
          options: [
            { value: "shoulders", label: "Shoulders" },
            { value: "wrists", label: "Wrists" },
            { value: "spine", label: "Spine" },
            { value: "hips", label: "Hips" },
            { value: "legs", label: "Legs" },
            { value: "core", label: "Core" },
            { value: "upper", label: "Upper body" },
          ],
        },
        measure: {
          type: "select",
          label: "Measured by",
          required: true,
          default: "reps",
          description: "What one set of it records.",
          options: [
            { value: "weight_reps", label: "Weight and reps" },
            { value: "reps", label: "Reps" },
            { value: "time", label: "Time" },
            { value: "hold", label: "Hold" },
          ],
        },
        easier: {
          type: "relation",
          label: "Easier versions",
          to: "programs.exercise",
          many: true,
        },
        harder: {
          type: "relation",
          label: "Harder versions",
          to: "programs.exercise",
          many: true,
        },
      },
      // Every signed-in member reads the bank a program of theirs is built from.
      signedIn: {
        read: [
          "name",
          "video",
          "cues",
          "theme",
          "level",
          "equipment",
          "bodyAreas",
          "measure",
          "easier",
          "harder",
        ],
      },
      indexes: [["theme"], ["measure"]],
    },
    program: {
      label: "Program",
      plural: "Programs",
      icon: "clipboard-list",
      titleField: "title",
      description:
        "A plan of weeks of sessions, built from the bank: a class program, a client's own, or " +
        "the sessions of an online course. Coaches edit the working copy; people are given a " +
        "published version.",
      navigation: "main",
      navigationOrder: 21,
      fields: {
        title: { type: "text", label: "Title", required: true },
        kind: {
          type: "select",
          label: "Kind",
          required: true,
          default: "client",
          options: [
            { value: "class", label: "Class" },
            { value: "client", label: "Client" },
            { value: "course", label: "Course" },
          ],
        },
        theme: { type: "text", label: "Theme" },
        guidance: {
          type: "longText",
          label: "Guidance for coaches",
          description: "For whoever runs it. Never shown to members.",
        },
        layout: {
          type: "document",
          label: "Layout",
          required: true,
          description:
            "Weeks of sessions of blocks of items, each item bank exercises with typed sets, " +
            "or up to five levels; notes for coaches unless marked as shown to members.",
          schema: LAYOUT_SCHEMA,
          maxBytes: 524_288,
          paths: { weekCount: { label: "Weeks", path: "weeks", count: true } },
        },
      },
      publishable: { content: ["title", "kind", "theme", "guidance", "layout"] },
      indexes: [["kind"]],
    },
    classtype: {
      label: "Class type",
      plural: "Class types",
      icon: "users",
      titleField: "name",
      description: "A kind of class (Mobility, Handstands): what a class program is assigned to.",
      navigation: "settings",
      fields: {
        name: { type: "text", label: "Name", required: true },
        order: { type: "number", label: "Order" },
      },
      signedIn: { read: ["name", "order"] },
    },
    assignment: {
      label: "Assignment",
      plural: "Assignments",
      icon: "calendar-range",
      titleField: "title",
      description:
        "A published version of a program given to a person or to a class type from a start " +
        "date: its dated sessions are made from that version and keep it.",
      navigation: "main",
      navigationOrder: 22,
      fields: {
        title: { type: "text", label: "Title", required: true },
        program: { type: "relation", label: "Program", to: "programs.program", required: true },
        programVersion: {
          type: "number",
          label: "Version",
          readOnly: true,
          description: "The program's published version this follows.",
        },
        kind,
        person: { type: "relation", label: "Person", to: "person" },
        classType: { type: "relation", label: "Class type", to: "programs.classtype" },
        startDate: { type: "date", label: "Starts", required: true },
        endDate: { type: "date", label: "Ends" },
        sessionCount: { type: "number", label: "Sessions", readOnly: true },
        state: {
          type: "select",
          label: "State",
          track: "timeline",
          options: [
            { value: "generating", label: "Making sessions" },
            { value: "active", label: "Active" },
            { value: "ended", label: "Ended" },
            { value: "cancelled", label: "Cancelled" },
          ],
        },
        assignedBy: { type: "user", label: "Assigned by" },
        assignedByName: { type: "text", label: "Assigned by (name)" },
      },
      requireOneOf: [["person", "classType"]],
      states: {
        field: "state",
        initial: "generating",
        moves: [
          { from: "generating", to: "active", by: ["staff"] },
          { from: "active", to: "ended", by: ["staff"], final: true },
          { from: ["generating", "active"], to: "cancelled", by: ["staff"], final: true },
        ],
      },
      customer: {
        field: "person",
        read: ["title", "programVersion", "kind", "classType", "startDate", "endDate", "state"],
        write: [],
      },
      signedIn: {
        read: ["title", "programVersion", "kind", "classType", "startDate", "endDate", "state"],
        when: { field: "kind", in: ["class"] },
      },
      timelineLinks: ["person"],
      indexes: [["person", "state"], ["classType", "state"], ["program"]],
    },
    session: {
      label: "Session",
      plural: "Sessions",
      icon: "calendar-check",
      titleField: "name",
      description:
        "One dated session of an assignment: its plan as the assigned version had it, and " +
        "whether it was done.",
      navigation: "none",
      fields: {
        name: { type: "text", label: "Name", required: true },
        assignment: {
          type: "relation",
          label: "Assignment",
          to: "programs.assignment",
          required: true,
        },
        program: { type: "relation", label: "Program", to: "programs.program" },
        programVersion: { type: "number", label: "Version", readOnly: true },
        kind,
        person: { type: "relation", label: "Person", to: "person" },
        classType: { type: "relation", label: "Class type", to: "programs.classtype" },
        date: { type: "date", label: "Date", required: true },
        week: { type: "number", label: "Week", readOnly: true },
        day: { type: "number", label: "Day of the week", readOnly: true },
        position: {
          type: "number",
          label: "Place in its week",
          readOnly: true,
          description: "The session's index in its week of the layout, from 0.",
        },
        key: {
          type: "text",
          label: "Key",
          readOnly: true,
          description: "Assignment, week and place: one session per place.",
        },
        focus: { type: "text", label: "Focus" },
        plan: {
          type: "document",
          label: "Plan",
          readOnly: true,
          description: "The session of the layout, as the assigned version had it.",
          schema: SESSION_PLAN_SCHEMA,
          maxBytes: 65_536,
        },
        state: {
          type: "select",
          label: "State",
          options: [
            { value: "planned", label: "Planned" },
            { value: "done", label: "Done" },
            { value: "skipped", label: "Skipped" },
          ],
        },
        completedAt: { type: "datetime", label: "Marked at" },
        completedBy: { type: "user", label: "Marked by" },
        completedByName: { type: "text", label: "Marked by (name)" },
      },
      states: {
        field: "state",
        initial: "planned",
        moves: [
          { from: "planned", to: "done", by: ["staff", "customer"] },
          { from: "planned", to: "skipped", by: ["staff", "customer"] },
          { from: ["done", "skipped"], to: "planned", by: ["staff", "customer"] },
        ],
      },
      customer: {
        field: "person",
        read: [
          "name",
          "assignment",
          "programVersion",
          "kind",
          "classType",
          "date",
          "week",
          "day",
          "position",
          "focus",
          "plan",
          "state",
          "completedAt",
        ],
        write: [],
      },
      // A class type's sessions are read by every signed-in member; marking one done is not theirs.
      signedIn: {
        read: [
          "name",
          "assignment",
          "programVersion",
          "kind",
          "classType",
          "date",
          "week",
          "day",
          "position",
          "focus",
          "plan",
        ],
        when: { field: "kind", in: ["class"] },
      },
      indexes: [["person", "date"], ["classType", "date"], ["assignment", "week"], ["key"]],
    },
    log: {
      label: "Logged set",
      plural: "Logged sets",
      icon: "list-checks",
      titleField: "label",
      description:
        "One set someone did: the exercise, the target and what was done, how hard it felt, " +
        "the level taken, and who recorded it. The table training data comes from.",
      navigation: "main",
      navigationOrder: 23,
      fields: {
        label: { type: "text", label: "Set", required: true },
        person: { type: "relation", label: "Person", to: "person", required: true },
        session: { type: "relation", label: "Session", to: "programs.session", required: true },
        assignment: { type: "relation", label: "Assignment", to: "programs.assignment" },
        exercise: { type: "relation", label: "Exercise", to: "programs.exercise", required: true },
        item: { type: "text", label: "Item", description: "The item's label: A1." },
        setNumber: { type: "number", label: "Set number" },
        level: { type: "number", label: "Level taken" },
        date: { type: "date", label: "Date", required: true },
        targetReps: { type: "number", label: "Target reps" },
        targetSeconds: { type: "number", label: "Target seconds" },
        targetLoad: { type: "number", label: "Target load (kg)" },
        actualReps: { type: "number", label: "Reps" },
        actualSeconds: { type: "number", label: "Seconds" },
        actualLoad: { type: "number", label: "Load (kg)" },
        rpe: { type: "number", label: "Effort (RPE)", description: "1 to 10, in halves." },
        note: { type: "text", label: "Note" },
        recordedAs: {
          type: "select",
          label: "Recorded by",
          options: [
            { value: "self", label: "Themselves" },
            { value: "staff", label: "A coach" },
          ],
        },
        recordedBy: { type: "user", label: "Recorded by (coach)" },
        recordedByName: { type: "text", label: "Recorded by (name)" },
      },
      customer: {
        field: "person",
        read: [
          "label",
          "session",
          "assignment",
          "exercise",
          "item",
          "setNumber",
          "level",
          "date",
          "targetReps",
          "targetSeconds",
          "targetLoad",
          "actualReps",
          "actualSeconds",
          "actualLoad",
          "rpe",
          "note",
          "recordedAs",
          "recordedByName",
        ],
        write: ["actualReps", "actualSeconds", "actualLoad", "rpe", "note"],
      },
      timelineLinks: ["person"],
      indexes: [
        ["person", "exercise", "date"],
        ["session"],
        ["exercise", "date"],
        ["person", "date"],
      ],
    },
  },
  tools: {
    assign,
    today,
    sessionGet,
    classToday,
    logAdd,
    logUpdate,
    sessionComplete,
    history,
    progress,
  },
});
