// The note composer (stage 56 step 2), for the web: a staff screen writes a note about a Person
// (and, beside them, a class, a session, a job): it picks a kind, fills the kind's template (or
// writes the note, for a kind with none) and picks who reads it from the levels the host lists
// for that kind. Bookings' class list (stage 56 step 4) opens it with the Session note kind.
//
// Everything it offers is the host's (note.kinds.list), and the host checks the note again in
// full when it is written (activity.log): a level below the kind's lowest, a required section left
// empty, a note kept tighter than staff about anything but one Person are refused there, and the
// refusal is shown here. What a person writes stays in this block's memory until that one call.
import {
  blankDraft,
  draftForKind,
  forgetAfter,
  levelWords,
  missingFromDraft,
  type NoteAbout,
  type NoteDraft,
  type NoteKind,
  type NoteLevel,
  type NotesHooks,
  noteInput,
  noteRefusalWords,
} from "@composable-os/client";
import { type FormEvent, useId, useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Label } from "../ui-label/label.tsx";
import { cn } from "../ui-utils/utils.ts";

type Hooks = Pick<NotesHooks, "useNoteKinds" | "useWriteNote">;

const FIELD =
  "border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px]";

export function NoteComposer({
  notes,
  about,
  kindKey,
  onWritten,
  className,
}: {
  notes: Hooks;
  /** What the note is about: one Person for a note kept tighter than staff, and what it was on. */
  about: NoteAbout[];
  /** The kind it starts on, by its key (`session` for a class list). Default: the first listed. */
  kindKey?: string;
  /** Told the new note's id once the host has written it. */
  onWritten?: (id: string) => void;
  className?: string;
}) {
  const kinds = notes.useNoteKinds();
  if (kinds.isPending) return <p aria-busy="true">Loading…</p>;
  if (kinds.error || !kinds.data?.items.length) {
    return <p role="alert">The kinds of note could not be loaded. Try again soon.</p>;
  }
  const items = kinds.data.items;
  const first = items.find((k) => k.key === kindKey) ?? items[0];
  if (!first) return null;
  return (
    <Composer
      kinds={items}
      first={first}
      notes={notes}
      about={about}
      onWritten={onWritten}
      className={className}
    />
  );
}

function Composer({
  kinds,
  first,
  notes,
  about,
  onWritten,
  className,
}: {
  kinds: NoteKind[];
  first: NoteKind;
  notes: Hooks;
  about: NoteAbout[];
  onWritten: ((id: string) => void) | undefined;
  className: string | undefined;
}) {
  const id = useId();
  const write = notes.useWriteNote();
  const [draft, setDraft] = useState<NoteDraft>(() => blankDraft(first));
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const kind = kinds.find((k) => k.id === draft.kindId) ?? first;
  const missing = missingFromDraft(kind, draft);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaid(null);
    try {
      const written = await forgetAfter(write, noteInput(kind, draft, about));
      setDraft(blankDraft(kind));
      setSaid("Note saved.");
      onWritten?.(written.id);
    } catch (refused) {
      setError(noteRefusalWords(refused));
    }
  }

  return (
    <form className={cn("grid gap-4", className)} onSubmit={submit} aria-label="Write a note">
      <div className="grid gap-2">
        <Label htmlFor={`${id}-kind`}>Kind</Label>
        <select
          id={`${id}-kind`}
          className={FIELD}
          value={kind.id}
          onChange={(e) => {
            const next = kinds.find((k) => k.id === e.target.value);
            if (next) setDraft(draftForKind(draft, next));
          }}
        >
          {kinds.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
            </option>
          ))}
        </select>
      </div>

      {kind.sections.length ? (
        kind.sections.map((section) => (
          <div key={section.key} className="grid gap-2">
            <Label htmlFor={`${id}-${section.key}`}>
              {section.label}
              {section.required ? <span aria-hidden="true">*</span> : null}
            </Label>
            {section.hint ? (
              <p id={`${id}-${section.key}-hint`} className="text-muted-foreground text-sm">
                {section.hint}
              </p>
            ) : null}
            <textarea
              id={`${id}-${section.key}`}
              className={cn(FIELD, "min-h-20")}
              required={section.required}
              aria-describedby={section.hint ? `${id}-${section.key}-hint` : undefined}
              value={draft.sections[section.key] ?? ""}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  sections: { ...draft.sections, [section.key]: e.target.value },
                })
              }
            />
          </div>
        ))
      ) : (
        <div className="grid gap-2">
          <Label htmlFor={`${id}-body`}>Note</Label>
          <textarea
            id={`${id}-body`}
            className={cn(FIELD, "min-h-28")}
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          />
        </div>
      )}

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Who can read it</legend>
        {kind.levels.map((level: NoteLevel) => (
          <label key={level} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={`${id}-level`}
              value={level}
              checked={draft.level === level}
              onChange={() => setDraft({ ...draft, level })}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">{levelWords(level).label}</span>
              <span className="text-muted-foreground block">{levelWords(level).hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      {said ? <p role="status">{said}</p> : null}
      <div>
        <Button type="submit" disabled={missing.length > 0 || write.isPending}>
          {write.isPending ? "Saving…" : "Save note"}
        </Button>
      </div>
    </form>
  );
}
