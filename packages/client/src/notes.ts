// Notes for a staff screen (stage 56 step 2, ADR 0833): the headless entry the note composer
// shares, web and native and the admin's own timeline. Functions and hooks over a staff client, no
// markup: the blocks draw the kinds, the template's sections and the levels, and use what is here.
//
// It holds no rules. Which kinds there are, the levels a note of each may have, which sections are
// required and who reads a note at each level are the host's (`note.kinds.list`, and
// `activity.log`, which checks everything again in full): a block offers what the host listed and
// shows the host's refusal. `missingFromDraft` only says what is empty before a call.
//
// What a person writes in a note may be health information: nothing here logs, stores or sends it
// anywhere but the one call that writes the note. It lives in the screen's memory until then, and
// the mutation is forgotten after it (`forgetAfter`).
import { type ClientHolding, type PackClient, packHooks } from "./hooks.ts";

// --- What the host answers ------------------------------------------------------------------------

/** Who may read a note: every staff account, the client's coaches, or the people named one by one. */
export type NoteLevel = "staff" | "coaches" | "sensitive";

export interface NoteKindSection {
  key: string;
  label: string;
  hint: string | null;
  required: boolean;
}

/** A kind of note as the composer uses it (`note.kinds.list`). */
export interface NoteKind {
  id: string;
  key: string | null;
  name: string;
  defaultLevel: NoteLevel;
  lowestLevel: NoteLevel;
  /** The levels a note of it may have, lowest first: the host's list, offered as it is. */
  levels: NoteLevel[];
  sections: NoteKindSection[];
  active: boolean;
}

/** A record the note is about or on: a Person, a class, a session, a deal. */
export interface NoteAbout {
  object: string;
  id: string;
}

/** What writing a note sends (`activity.log`). */
export type WriteNoteInput = {
  type: "note";
  kindId: string;
  level: NoteLevel;
  links: NoteAbout[];
  sections?: { key: string; text: string }[];
  body?: string;
};

/** The operations this entry calls, as the generated client types them. */
export type NotesOperations = {
  "note.kinds.list": {
    kind: "query";
    input: { includeRetired?: boolean };
    output: { items: NoteKind[] };
  };
  "activity.log": {
    kind: "mutation";
    input: WriteNoteInput;
    output: { id: string };
  };
};

export type NotesClient = PackClient<NotesOperations>;

// --- Words ---------------------------------------------------------------------------------------

const LEVEL_WORDS: Record<NoteLevel, { label: string; hint: string }> = {
  staff: { label: "Staff", hint: "Everyone on the staff can read it." },
  coaches: {
    label: "Client's coaches",
    hint: "Read by you, the staff who look after this person, and managers.",
  },
  sensitive: {
    label: "Sensitive",
    hint: "Read by you and the people the business named one by one. Every opening is recorded.",
  },
};

/** A level's name and a line saying who reads a note at it. */
export function levelWords(level: NoteLevel): { label: string; hint: string } {
  return LEVEL_WORDS[level];
}

// --- A draft -------------------------------------------------------------------------------------

/** A note being written: kept in the screen's memory only, until the one call that writes it. */
export interface NoteDraft {
  kindId: string;
  level: NoteLevel;
  /** Each template section's text, by its key. */
  sections: Record<string, string>;
  /** The note's text, for a kind with no template. */
  body: string;
}

/** A new draft of a kind: at the kind's own level, empty. */
export function blankDraft(kind: NoteKind): NoteDraft {
  return { kindId: kind.id, level: kind.defaultLevel, sections: {}, body: "" };
}

/**
 * The draft moved to another kind: the text of sections the two templates share is kept, and the
 * level is the new kind's own (a person lowers it themselves, as far as the host lets them).
 */
export function draftForKind(draft: NoteDraft, kind: NoteKind): NoteDraft {
  const sections: Record<string, string> = {};
  for (const section of kind.sections) {
    const text = draft.sections[section.key];
    if (text) sections[section.key] = text;
  }
  const body =
    kind.sections.length === 0 && !draft.body
      ? Object.values(draft.sections).filter(Boolean).join("\n\n")
      : draft.body;
  return { kindId: kind.id, level: kind.defaultLevel, sections, body };
}

/** The labels of what is still empty: a required section, or the text of a kind with no template. */
export function missingFromDraft(kind: NoteKind, draft: NoteDraft): string[] {
  if (kind.sections.length === 0) return draft.body.trim() ? [] : ["The note"];
  const missing = kind.sections
    .filter((s) => s.required && !draft.sections[s.key]?.trim())
    .map((s) => s.label);
  if (missing.length) return missing;
  return kind.sections.some((s) => draft.sections[s.key]?.trim()) ? [] : ["The note"];
}

/** What writing the draft sends: the sections of a template, or the body of a kind with none. */
export function noteInput(kind: NoteKind, draft: NoteDraft, about: NoteAbout[]): WriteNoteInput {
  const base = { type: "note" as const, kindId: kind.id, level: draft.level, links: about };
  if (kind.sections.length === 0) return { ...base, body: draft.body };
  return {
    ...base,
    sections: kind.sections
      .map((s) => ({ key: s.key, text: draft.sections[s.key]?.trim() ?? "" }))
      .filter((s) => s.text),
  };
}

/**
 * The words for the host's refusal of a note, or its own message. The host's message already says
 * what to fix (a required section, a level below the kind's lowest).
 */
export function noteRefusalWords(error: unknown): string {
  const message =
    error !== null && typeof error === "object" && "message" in error
      ? String((error as { message: unknown }).message)
      : "";
  return message || "The note could not be saved. Try again.";
}

// --- Hooks ---------------------------------------------------------------------------------------

/** The app's `useQuery`, as far as these hooks use it. */
export type NotesUseQuery = <T>(options: {
  queryKey: readonly unknown[];
  queryFn: () => Promise<T>;
  enabled?: boolean;
}) => { data: T | undefined; isPending: boolean; error: unknown };

/** The app's `useMutation`, as far as these hooks use it. */
export type NotesUseMutation = <I, O>(options: {
  mutationKey: readonly unknown[];
  mutationFn: (input: I) => Promise<O>;
  gcTime?: number;
}) => {
  mutateAsync(input: I): Promise<O>;
  isPending: boolean;
  error: unknown;
  reset?: () => void;
};

/** The operations each hook calls (ADR 0453). */
export const NOTES_HOOKS_CALL = {
  useNoteKinds: ["note.kinds.list"],
  useWriteNote: ["activity.log"],
} as const;

/**
 * Hooks for a React or React Native staff screen:
 * `const notes = createNotesHooks({ useQuery, useMutation }, api)`, with the staff client. The
 * hooks it cannot back are not there.
 */
export function createNotesHooks<C extends ClientHolding>(
  react: { useQuery: NotesUseQuery; useMutation: NotesUseMutation },
  client: C,
) {
  return packHooks(client, NOTES_HOOKS_CALL, (api: NotesClient) => allNotesHooks(react, api));
}

function allNotesHooks(
  react: { useQuery: NotesUseQuery; useMutation: NotesUseMutation },
  api: NotesClient,
) {
  const { useQuery, useMutation } = react;
  return {
    /** The kinds the composer offers, in the business's order. */
    useNoteKinds() {
      return useQuery(api.query("note.kinds.list", {}));
    },
    /** Write a note. What was sent is not kept once the call is over (use `forgetAfter`). */
    useWriteNote() {
      return useMutation({ ...api.mutation("activity.log"), gcTime: 0 });
    },
  };
}

/** Every hook of this entry. A block takes the ones it calls: `Pick<NotesHooks, "useNoteKinds">`. */
export type NotesHooks = ReturnType<typeof allNotesHooks>;
