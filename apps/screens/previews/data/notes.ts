// Dummy data the note composer previews share: a studio's kinds of note.
import type { NotesOperations } from "@composable-os/client";

type Out<K extends keyof NotesOperations> = NotesOperations[K]["output"];

export const noteKinds: Out<"note.kinds.list"> = {
  items: [
    {
      id: "nk_general",
      key: "general",
      name: "General",
      defaultLevel: "staff",
      lowestLevel: "staff",
      levels: ["staff", "coaches", "sensitive"],
      sections: [],
      active: true,
    },
    {
      id: "nk_session",
      key: "session",
      name: "Session note",
      defaultLevel: "coaches",
      lowestLevel: "staff",
      levels: ["staff", "coaches", "sensitive"],
      sections: [
        {
          key: "worked_on",
          label: "What we worked on",
          hint: "Lifts, drills, the main set.",
          required: true,
        },
        { key: "how_it_went", label: "How it went", hint: null, required: false },
        {
          key: "next_time",
          label: "Next time",
          hint: "What to start with next session.",
          required: false,
        },
      ],
      active: true,
    },
    {
      id: "nk_injury",
      key: "injury",
      name: "Injury",
      defaultLevel: "sensitive",
      lowestLevel: "coaches",
      levels: ["coaches", "sensitive"],
      sections: [
        { key: "what", label: "What happened", hint: null, required: true },
        { key: "advice", label: "Advice given", hint: null, required: false },
      ],
      active: true,
    },
    {
      id: "nk_billing",
      key: "billing",
      name: "Billing",
      defaultLevel: "staff",
      lowestLevel: "staff",
      levels: ["staff"],
      sections: [],
      active: true,
    },
  ],
};

/** The note is about one Person, on the class they came to. */
export const about = [
  { object: "person", id: "p_1" },
  { object: "x_bookings_class", id: "cls_1" },
];
