// The notes entry (stage 56 step 2): the logic the note composer shares, web, native and the
// admin's timeline. A draft starts at its kind's own level, keeps what the templates share when
// the kind changes, says what is empty, and builds exactly the input the host checks. Fixture
// values only.
import { describe, expect, it } from "vitest";
import {
  blankDraft,
  createNotesHooks,
  draftForKind,
  missingFromDraft,
  NOTES_HOOKS_CALL,
  type NoteKind,
  noteInput,
} from "../src/index.ts";

const session: NoteKind = {
  id: "nkd_session",
  key: "session",
  name: "Session note",
  defaultLevel: "coaches",
  lowestLevel: "staff",
  levels: ["staff", "coaches", "sensitive"],
  sections: [
    { key: "worked_on", label: "Worked on", hint: null, required: true },
    { key: "next_time", label: "Next time", hint: null, required: false },
  ],
  active: true,
};
const plain: NoteKind = {
  ...session,
  id: "nkd_note",
  key: "note",
  name: "Note",
  defaultLevel: "staff",
  levels: ["staff", "coaches", "sensitive"],
  sections: [],
};
const about = [{ object: "person", id: "per_1" }];

describe("a note draft", () => {
  it("starts at its kind's level and says what is still empty", () => {
    const draft = blankDraft(session);
    expect(draft.level).toBe("coaches");
    expect(missingFromDraft(session, draft)).toEqual(["Worked on"]);
    draft.sections.next_time = "More";
    expect(missingFromDraft(session, draft)).toEqual(["Worked on"]);
    draft.sections.worked_on = "Squats";
    expect(missingFromDraft(session, draft)).toEqual([]);
    expect(missingFromDraft(plain, blankDraft(plain))).toEqual(["The note"]);
  });

  it("builds the host's input: a template's sections, or a body", () => {
    const draft = { ...blankDraft(session), sections: { worked_on: " Squats ", next_time: "" } };
    expect(noteInput(session, draft, about)).toEqual({
      type: "note",
      kindId: "nkd_session",
      level: "coaches",
      links: about,
      sections: [{ key: "worked_on", text: "Squats" }],
    });
    expect(noteInput(plain, { ...blankDraft(plain), body: "Called" }, about)).toEqual({
      type: "note",
      kindId: "nkd_note",
      level: "staff",
      links: about,
      body: "Called",
    });
  });

  it("moved to another kind keeps its text and takes the kind's level", () => {
    const draft = {
      ...blankDraft(session),
      sections: { worked_on: "Squats" },
      level: "sensitive" as const,
    };
    const moved = draftForKind(draft, plain);
    expect(moved).toMatchObject({ kindId: "nkd_note", level: "staff", body: "Squats" });
    expect(draftForKind(moved, session).sections).toEqual({});
  });
});

describe("the notes hooks", () => {
  it("are only those a client holding their operations can back", () => {
    const react = {
      useQuery: () => ({ data: undefined, isPending: true, error: null }),
      useMutation: () => ({ mutateAsync: async () => ({}), isPending: false, error: null }),
    };
    const query = () => ({ queryKey: [], queryFn: async () => ({}) });
    const mutation = () => ({ mutationKey: [], mutationFn: async () => ({}) });
    const reader = createNotesHooks(react as never, {
      operations: { "note.kinds.list": {} },
      query,
      mutation,
    });
    expect(Object.keys(reader)).toEqual(["useNoteKinds"]);
    expect(Object.keys(NOTES_HOOKS_CALL)).toEqual(["useNoteKinds", "useWriteNote"]);
  });
});
