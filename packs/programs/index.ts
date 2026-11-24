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
//     current read (ADR 0437);
//   - a session is an assignment's, or one brought in from before by an import (`source`), whose
//     writes start no automation and send no message (the import door, ADR 0470).
// The tools in tools.ts compose the host's operations and add no rules of their own.
import { defineExtension } from "@composable-os/sdk";
import { programsDashboards } from "./dashboards.ts";
import { LAYOUT_SCHEMA, SESSION_PLAN_SCHEMA } from "./layout.ts";
import {
  assign,
  classToday,
  draft,
  history,
  importText,
  logAdd,
  logRemove,
  logUpdate,
  progress,
  sessionComplete,
  sessionGet,
  today,
} from "./tools.ts";

// The pack's public entry: its shorthand reader, for an import that reads a folder of programs
// (`cos programs import`) as `x.programs.importText` reads one.
export {
  type BankExercise,
  type ImportResult as ProgramTextResult,
  type ProgramKind,
  readProgramText,
  type UnreadLine,
} from "./authoring.ts";
export {
  type Item,
  LAYOUT_SCHEMA,
  type Layout,
  type Level,
  type Prescription,
  type SetTarget,
} from "./layout.ts";

/** Where a session or a set came from: left empty for the platform's own, `import` for before. */
const source = {
  type: "select",
  label: "Where it came from",
  description: "Imported: brought in from before the platform; it started nothing when it was.",
  options: [{ value: "import", label: "Imported" }],
} as const;

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
    modules: ["ops", "ai"],
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
        importKey: {
          type: "text",
          label: "Import key",
          readOnly: true,
          description: "The name its text had where it came from: one program per key.",
        },
        importedHash: {
          type: "text",
          label: "Imported content",
          readOnly: true,
          description: "What the text import last wrote, so a re-run never overwrites an edit.",
        },
      },
      publishable: { content: ["title", "kind", "theme", "guidance", "layout"] },
      // `x.programs.importText` with a key: one live program per key, however many run at once.
      unique: [{ fields: ["importKey"] }],
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
        sessionCount: { type: "number", label: "Sessions", readOnly: true, min: 0, step: 1 },
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
        coach: {
          type: "user",
          label: "Coach",
          description:
            "Who looks after this client on it. With the coach role, they see and log this " +
            "person's training while it is active, and no one else's. A person chooses it: " +
            "anyone else's change waits for a person.",
          // Who reaches whose training is access (ADR 0889): a person's to set.
          personApproves: true,
        },
      },
      requireOneOf: [["person", "classType"]],
      // Who looks after whom (ADR 0831): a client's coach while their program is live. What the
      // coach role reaches through it is the host's (`roles.coach.looksAfter`, ADR 0889).
      team: { person: "person", staff: ["coach"], live: ["generating", "active"] },
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
      // A member reads their own (person) or the shared (kind): one index for each side of the OR.
      // The coach's People are read on every call of the coach role: one index for it.
      indexes: [
        ["person", "state"],
        ["kind", "state"],
        ["classType", "state"],
        ["program"],
        ["coach", "state"],
      ],
    },
    session: {
      label: "Session",
      plural: "Sessions",
      icon: "calendar-check",
      titleField: "name",
      description:
        "One dated session of an assignment: its plan as the assigned version had it, and " +
        "whether it was done. Or one done before the platform, brought in by an import.",
      navigation: "none",
      fields: {
        name: { type: "text", label: "Name", required: true },
        assignment: {
          type: "relation",
          label: "Assignment",
          to: "programs.assignment",
          description: "Every session but an imported one is an assignment's.",
        },
        program: { type: "relation", label: "Program", to: "programs.program" },
        programVersion: { type: "number", label: "Version", readOnly: true },
        kind,
        person: { type: "relation", label: "Person", to: "person" },
        classType: { type: "relation", label: "Class type", to: "programs.classtype" },
        programTitle: {
          type: "text",
          label: "Program",
          readOnly: true,
          description:
            "The program's title in the assigned version, so a member reads it with the session.",
        },
        classTypeName: { type: "text", label: "Class type (name)", readOnly: true },
        date: { type: "date", label: "Date", required: true },
        week: { type: "number", label: "Week", readOnly: true, min: 1, max: 52, step: 1 },
        day: { type: "number", label: "Day of the week", readOnly: true, min: 1, max: 7, step: 1 },
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
        source,
        // Done before the platform: only staff move it back (a member reopening it is not theirs).
        imported: {
          type: "formula",
          label: "Imported",
          expression: 'coalesce(source, "") = "import"',
        },
      },
      // An assignment's, or brought in from before (`source: import`).
      requireOneOf: [["assignment", "source"]],
      states: {
        field: "state",
        initial: "planned",
        moves: [
          { from: "planned", to: "done", by: ["staff", "customer"] },
          { from: "planned", to: "skipped", by: ["staff", "customer"] },
          {
            from: ["done", "skipped"],
            to: "planned",
            by: ["staff", "customer"],
            staffOnly: "imported",
          },
        ],
      },
      customer: {
        field: "person",
        read: [
          "name",
          "assignment",
          // Stage 42: which program it is, so a course's session lesson finds the student's own.
          "program",
          "programVersion",
          "kind",
          "classType",
          "programTitle",
          "classTypeName",
          "date",
          "week",
          "day",
          "position",
          "focus",
          "plan",
          "state",
          "completedAt",
          "source",
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
          "programTitle",
          "classTypeName",
          "date",
          "week",
          "day",
          "position",
          "focus",
          "plan",
        ],
        when: { field: "kind", in: ["class"] },
      },
      indexes: [
        ["person", "date"],
        ["kind", "date"],
        ["classType", "date"],
        ["assignment", "week"],
        ["key"],
      ],
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
        exerciseName: {
          type: "text",
          label: "Exercise (name)",
          description:
            "The exercise's name when the set was logged, so a member reads it with the set.",
        },
        item: { type: "text", label: "Item", description: "The item's label: A1." },
        setNumber: { type: "number", label: "Set number", min: 1, max: 30, step: 1 },
        level: { type: "number", label: "Level taken", min: 1, max: 5, step: 1 },
        date: { type: "date", label: "Date", required: true },
        targetReps: { type: "number", label: "Target reps", min: 0, max: 999, step: 1 },
        targetSeconds: { type: "number", label: "Target seconds", min: 0, max: 7200, step: 1 },
        targetLoad: { type: "number", label: "Target load (kg)", min: 0, max: 1000, step: 0.25 },
        actualReps: { type: "number", label: "Reps", min: 0, max: 999, step: 1 },
        actualSeconds: { type: "number", label: "Seconds", min: 0, max: 7200, step: 1 },
        actualLoad: { type: "number", label: "Load (kg)", min: 0, max: 1000, step: 0.25 },
        rpe: {
          type: "number",
          label: "Effort (RPE)",
          description: "1 to 10, in halves.",
          min: 1,
          max: 10,
          step: 0.5,
        },
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
        setKey: {
          type: "text",
          label: "Set key",
          description:
            "Session, item, exercise and set number: one row per set and person, however many " +
            "saves of it arrive.",
        },
        source,
      },
      // One row per set and person (ADR 0448, amended 2026-11-24): a retried save, or two at once,
      // changes the set instead of logging it twice. Rows logged before the key have none and are
      // not counted; `x.programs.logAdd` finds those by their fields.
      unique: [{ fields: ["person", "setKey"] }],
      customer: {
        field: "person",
        read: [
          "label",
          "session",
          "assignment",
          "exercise",
          "exerciseName",
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
          "source",
        ],
        write: ["actualReps", "actualSeconds", "actualLoad", "rpe", "note"],
        // A set ticked by mistake is taken back (`x.programs.logRemove`): to the Trash.
        delete: true,
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
  views: {
    bankByTheme: {
      label: "Bank by theme",
      object: "programs.exercise",
      type: "board",
      groupBy: "theme",
      cardFields: ["measure", "level", "equipment"],
    },
    programsPublished: {
      label: "Published programs",
      object: "programs.program",
      filter: { field: "publishedVersion", op: "is_not_null" },
      sort: { field: "publishedAt", direction: "desc" },
      columns: ["title", "kind", "weekCount", "publishedVersion", "publishedAt"],
    },
    activeAssignments: {
      label: "Active assignments",
      object: "programs.assignment",
      filter: { field: "state", op: "eq", value: "active" },
      sort: { field: "startDate", direction: "desc" },
      columns: ["title", "kind", "person", "classType", "startDate", "endDate", "sessionCount"],
    },
    sessionsThisWeek: {
      label: "Sessions this week",
      object: "programs.session",
      filter: {
        and: [
          { field: "date", op: "gte", value: { $relative: "startOfWeek" } },
          { field: "date", op: "lt", value: { $relative: "startOfNextWeek" } },
        ],
      },
      sort: { field: "date", direction: "asc" },
      columns: ["name", "date", "kind", "person", "classType", "state"],
    },
    sessionsCalendar: {
      label: "Sessions calendar",
      object: "programs.session",
      type: "calendar",
      dateField: "date",
      mode: "week",
      cardFields: ["person", "classType", "state"],
    },
    setsThisWeek: {
      label: "Sets logged this week",
      object: "programs.log",
      filter: {
        and: [
          { field: "date", op: "gte", value: { $relative: "startOfWeek" } },
          { field: "date", op: "lt", value: { $relative: "startOfNextWeek" } },
        ],
      },
      sort: { field: "date", direction: "desc" },
      columns: [
        "person",
        "exercise",
        "label",
        "level",
        "targetReps",
        "actualReps",
        "targetLoad",
        "actualLoad",
        "actualSeconds",
        "rpe",
        "recordedAs",
      ],
    },
  },
  dashboards: programsDashboards,
  // A client's Person page: their sets (the Training tab), their assignments and their sessions.
  recordTabs: {
    personTraining: {
      label: "Training",
      on: "person",
      view: {
        type: "table",
        object: "programs.log",
        relation: "person",
        columns: [
          "date",
          "exercise",
          "label",
          "level",
          "targetReps",
          "actualReps",
          "targetLoad",
          "actualLoad",
          "actualSeconds",
          "rpe",
          "recordedAs",
        ],
        sort: { field: "date", direction: "desc" },
      },
      order: 40,
    },
  },
  recordPanels: {
    personAssignments: {
      label: "Programs",
      on: "person",
      view: {
        type: "table",
        object: "programs.assignment",
        relation: "person",
        columns: ["title", "startDate", "endDate", "state"],
        sort: { field: "startDate", direction: "desc" },
      },
      order: 40,
    },
    personSessions: {
      label: "Sessions",
      on: "person",
      view: {
        type: "table",
        object: "programs.session",
        relation: "person",
        columns: ["name", "date", "state"],
        sort: { field: "date", direction: "desc" },
      },
      order: 41,
    },
  },
  // The coach role (ADR 0889): a coach's own clients, in the app: their sessions and sets, logging
  // and marking for them, their history and progress. Only the People an active assignment names
  // them coach of; nothing else: no class sessions, no programs or the builder, no assigning, no
  // people, no settings.
  roles: {
    coach: {
      label: "Coach",
      description:
        "Sees the clients they coach (an active program naming them their coach): their " +
        "sessions, sets, history and progress, and logs sets and marks sessions for them. " +
        "Nothing else: no other clients, no class sessions, no programs, no assigning, no people.",
      permissions: ["programs:coach"],
      read: ["programs.assignment", "programs.session"],
      looksAfter: {
        "programs.assignment": "person",
        "programs.session": "person",
        "programs.log": "person",
      },
    },
  },
  tools: {
    assign,
    today,
    sessionGet,
    classToday,
    logAdd,
    logRemove,
    logUpdate,
    sessionComplete,
    history,
    progress,
    draft,
    importText,
  },
  // Staff screens in the product's admin (stage 47, ADR 0660), each gated by what it writes or
  // calls: the bank its exercises and the builder its programs (core record writes: any member,
  // never a viewer or a pack role), the builder's import too; the client view, a tab on Person, by
  // logging and completing a client's sessions (`programs:coach`, which the coach role holds too,
  // ADR 0889; the role never opens a Person's page).
  screens: {
    bank: {
      label: "Exercise bank",
      block: "programs-bank",
      export: "ExerciseBank",
      nav: { group: "Programs", order: 10 },
      writes: ["programs.exercise"],
    },
    builder: {
      label: "Program builder",
      block: "programs-builder",
      export: "ProgramWorkspace",
      nav: { group: "Programs", order: 20 },
      opens: ["importText"],
      writes: ["programs.program"],
    },
    client: {
      label: "Programs",
      block: "programs-coach-client",
      export: "CoachClient",
      opens: ["logAdd", "logRemove", "sessionComplete"],
      record: { object: "person", as: "personId" },
    },
  },
  // Its section of My account (stage 48, ADR 0710): a member's progress, shown once they have a
  // program or a logged set.
  portal: {
    training: {
      label: "Training",
      web: { block: "programs-progress", export: "Progress" },
      native: { block: "programs-native-progress", export: "ProgressScreen" },
      order: 50,
      has: ["programs.assignment", "programs.log"],
    },
  },
});
