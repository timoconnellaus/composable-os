// The note composer (stage 56 step 2), for the staff app: a coach writes a note about a Person
// (and, beside them, the class it was in): picks a kind, fills the kind's template (or writes the
// note, for a kind with none) and picks who reads it from the levels the host lists for that kind.
// The coach's class list (stage 56 step 4) opens it with the Session note kind.
//
// Everything it offers is the host's (note.kinds.list), and the host checks the note again in
// full when it is written (activity.log); its refusal is shown here. What a person writes stays in
// this screen's memory until that one call. Writing a note needs signal: nothing is queued.
import {
  blankDraft,
  draftForKind,
  forgetAfter,
  levelWords,
  missingFromDraft,
  type NoteAbout,
  type NoteDraft,
  type NoteKind,
  type NotesHooks,
  noteInput,
  noteRefusalWords,
} from "@composable-os/client";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { Field } from "../native-base/field.tsx";
import { Text } from "../native-base/text.tsx";
import { theme } from "../native-base/theme.ts";

type Hooks = Pick<NotesHooks, "useNoteKinds" | "useWriteNote">;

export function NoteComposerScreen({
  notes,
  about,
  kindKey,
  onWritten,
}: {
  notes: Hooks;
  /** What the note is about: one Person for a note kept tighter than staff, and what it was on. */
  about: NoteAbout[];
  /** The kind it starts on, by its key (`session` for a class list). Default: the first listed. */
  kindKey?: string;
  /** Told the new note's id once the host has written it. */
  onWritten?: (id: string) => void;
}) {
  const kinds = notes.useNoteKinds();
  if (kinds.isPending) return <ActivityIndicator color={theme.color.muted} />;
  if (kinds.error || !kinds.data?.items.length) {
    return <Text tone="danger">The kinds of note could not be loaded. Try again soon.</Text>;
  }
  const items = kinds.data.items;
  const first = items.find((k) => k.key === kindKey) ?? items[0];
  if (!first) return null;
  return <Composer kinds={items} first={first} notes={notes} about={about} onWritten={onWritten} />;
}

function Composer({
  kinds,
  first,
  notes,
  about,
  onWritten,
}: {
  kinds: NoteKind[];
  first: NoteKind;
  notes: Hooks;
  about: NoteAbout[];
  onWritten: ((id: string) => void) | undefined;
}) {
  const write = notes.useWriteNote();
  const [draft, setDraft] = useState<NoteDraft>(() => blankDraft(first));
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const kind = kinds.find((k) => k.id === draft.kindId) ?? first;
  const missing = missingFromDraft(kind, draft);

  async function submit() {
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
    <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
      <Text style={styles.heading}>Kind</Text>
      <View style={styles.choices}>
        {kinds.map((k) => (
          <Choice
            key={k.id}
            label={k.name}
            chosen={k.id === kind.id}
            onPress={() => setDraft(draftForKind(draft, k))}
          />
        ))}
      </View>

      {kind.sections.length ? (
        kind.sections.map((section) => (
          <View key={section.key} style={styles.section}>
            <Field
              label={section.required ? `${section.label} *` : section.label}
              multiline
              value={draft.sections[section.key] ?? ""}
              placeholder={section.hint ?? undefined}
              onChangeText={(text) =>
                setDraft({ ...draft, sections: { ...draft.sections, [section.key]: text } })
              }
            />
          </View>
        ))
      ) : (
        <Field
          label="Note"
          multiline
          value={draft.body}
          onChangeText={(body) => setDraft({ ...draft, body })}
        />
      )}

      <Text style={styles.heading}>Who can read it</Text>
      {kind.levels.map((level) => (
        <Pressable
          key={level}
          accessibilityRole="radio"
          accessibilityState={{ checked: draft.level === level }}
          onPress={() => setDraft({ ...draft, level })}
          style={[styles.level, draft.level === level ? styles.levelChosen : null]}
        >
          <Text style={styles.levelLabel}>{levelWords(level).label}</Text>
          <Text tone="muted" style={styles.small}>
            {levelWords(level).hint}
          </Text>
        </Pressable>
      ))}

      {error ? <Text tone="danger">{error}</Text> : null}
      {said ? <Text accessibilityLiveRegion="polite">{said}</Text> : null}
      <Button
        label="Save note"
        onPress={() => void submit()}
        busy={write.isPending}
        disabled={missing.length > 0}
      />
    </ScrollView>
  );
}

function Choice({
  label,
  chosen,
  onPress,
}: {
  label: string;
  chosen: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: chosen }}
      onPress={onPress}
      style={[styles.choice, chosen ? styles.choiceChosen : null]}
    >
      <Text style={chosen ? styles.choiceLabelChosen : styles.choiceLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  form: { gap: theme.space.md, padding: theme.space.md },
  heading: { fontSize: theme.font.small, color: theme.color.muted },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm },
  choice: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: theme.space.md,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.background,
  },
  choiceChosen: { backgroundColor: theme.color.primary, borderColor: theme.color.primary },
  choiceLabel: { color: theme.color.text },
  choiceLabelChosen: { color: theme.color.onPrimary },
  section: { gap: theme.space.xs },
  level: {
    gap: theme.space.xs,
    padding: theme.space.sm + 4,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.color.border,
  },
  levelChosen: { borderColor: theme.color.primary, backgroundColor: theme.color.surface },
  levelLabel: { fontSize: theme.font.body, fontWeight: "600", color: theme.color.text },
  small: { fontSize: theme.font.small, color: theme.color.muted },
});
