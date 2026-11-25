import { createNotesHooks, NOTES_HOOKS_CALL, type NotesOperations } from "@composable-os/client";
import { NoteComposerScreen } from "../../../blocks/native-note-composer/note-composer-screen.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { about, noteKinds } from "./data/notes.ts";

const notes = createNotesHooks(
  react,
  fakeClient<NotesOperations>(NOTES_HOOKS_CALL, { "note.kinds.list": noteKinds }),
);

export default function Preview() {
  return <NoteComposerScreen notes={notes} about={about} kindKey="session" />;
}

/** The coach has written the session up. */
export const fill = [
  ["What we worked on", "Front squat to a box, then sled pushes. Kept the bar path tight."],
  ["How it went", "Strong today: moved up 5 kg on every set, no knee pain."],
  ["Next time", "Try the box one notch lower and add a pause at the bottom."],
] as const;
