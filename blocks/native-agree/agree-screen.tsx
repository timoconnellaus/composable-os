// Agree to one document (stage 44 step 5), for the mobile app: the version the host gave, its
// words, a health form's questions, the tick label and its box, the typed name and, for a document
// agreed to by drawing, the signature pad. "Agree" hands what the person gave to `onAgree`, which
// calls the host (me.agreements.accept). The same logic as the web block (@composable-os/client),
// drawn with React Native.
//
// It decides nothing: the version, whether it is due, who may agree and whether what was given is
// acceptable are the host's. What a person types, draws and answers stays in this component's
// memory and is cleared once `onAgree` succeeds.
import {
  type AgreeForm,
  type AgreeInput,
  type AgreementBlock,
  type AgreementListItem,
  type AgreementRun,
  type AgreementVersion,
  type AgreeProblem,
  agreeErrorWords,
  agreeInput,
  agreeProblems,
  type DueReason,
  documentBlocks,
  dueReasonWords,
  emptyAgreeForm,
  NOTE_MAX,
  runText,
  StrokeRecorder,
  TYPED_NAME_MAX,
} from "@composable-os/client";
import { type ReactNode, useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { Field } from "../native-base/field.tsx";
import { theme } from "../native-base/theme.ts";
import { SignaturePad } from "./signature-pad.tsx";

/** Render it with `key={version.id}`: a new version is a new form, with nothing carried over. */
export function Agree({
  version,
  forName,
  reason,
  submitLabel = "Agree",
  onAgree,
  secondary,
  onDrawing,
}: {
  version: AgreementVersion;
  forName?: string | null;
  reason?: DueReason | null;
  submitLabel?: string;
  onAgree: (input: AgreeInput) => Promise<void> | void;
  secondary?: { label: string; onPress: () => void };
  /** Told while a signature is being drawn, so the screen can stop scrolling meanwhile. */
  onDrawing?: (drawing: boolean) => void;
}) {
  const [form, setForm] = useState<AgreeForm>(() => emptyAgreeForm(version));
  const recorder = useRef(new StrokeRecorder());
  const [problems, setProblems] = useState<AgreeProblem[]>([]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problemOf = (field: string) =>
    tried ? (problems.find((p) => p.field === field)?.message ?? null) : null;
  const check = (next: AgreeForm) => {
    if (tried) setProblems(agreeProblems(version, next, recorder.current.signature()));
  };
  const update = (next: AgreeForm) => {
    setForm(next);
    check(next);
  };

  async function submit() {
    setError(null);
    setTried(true);
    const signature = recorder.current.signature();
    const found = agreeProblems(version, form, signature);
    setProblems(found);
    if (found.length) return;
    setBusy(true);
    try {
      await onAgree(agreeInput(version, form, signature));
      setForm(emptyAgreeForm(version));
      recorder.current.clear();
      setTried(false);
      setProblems([]);
    } catch (e) {
      setError(agreeErrorWords(e));
    } finally {
      setBusy(false);
    }
  }

  const because = reason ? dueReasonWords(reason) : null;
  return (
    <View style={styles.form}>
      <View>
        <Text style={styles.title} accessibilityRole="header">
          {version.title}
        </Text>
        <Text style={styles.muted}>
          {`Version ${version.number}${forName ? ` · for ${forName}` : ""}`}
        </Text>
        {because ? <Text style={styles.body}>{because}</Text> : null}
      </View>
      <AgreementText version={version} />
      {(version.questions ?? []).map((q) => {
        const answer = form.answers[q.key] ?? { yes: null, note: "" };
        const set = (next: Partial<typeof answer>) =>
          update({ ...form, answers: { ...form.answers, [q.key]: { ...answer, ...next } } });
        const problem = problemOf(`answer:${q.key}`);
        return (
          <View key={q.key} style={styles.question} accessibilityRole="radiogroup">
            <Text style={styles.body}>{q.text}</Text>
            <View style={styles.row}>
              {([true, false] as const).map((yes) => (
                <Pressable
                  key={String(yes)}
                  accessibilityRole="radio"
                  accessibilityLabel={`${q.text}: ${yes ? "Yes" : "No"}`}
                  accessibilityState={{ checked: answer.yes === yes }}
                  onPress={() => set({ yes })}
                  style={[styles.choice, answer.yes === yes ? styles.chosen : null]}
                >
                  <Text style={answer.yes === yes ? styles.chosenText : styles.body}>
                    {yes ? "Yes" : "No"}
                  </Text>
                </Pressable>
              ))}
            </View>
            {problem ? <Text style={styles.error}>{problem}</Text> : null}
            {answer.yes && q.noteOnYes ? (
              <Field
                label="Tell us more (optional)"
                value={answer.note}
                multiline
                maxLength={NOTE_MAX}
                onChangeText={(note) => set({ note })}
                error={problemOf(`note:${q.key}`)}
              />
            ) : null}
          </View>
        );
      })}
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: form.ticked }}
        accessibilityLabel={version.tickLabel}
        onPress={() => update({ ...form, ticked: !form.ticked })}
        style={styles.tick}
      >
        <View style={[styles.box, form.ticked ? styles.boxTicked : null]}>
          {form.ticked ? <Text style={styles.chosenText}>✓</Text> : null}
        </View>
        <Text style={[styles.body, styles.tickLabel]}>{version.tickLabel}</Text>
      </Pressable>
      {problemOf("ticked") ? <Text style={styles.error}>{problemOf("ticked")}</Text> : null}
      <Field
        label={forName ? "Your name (as their parent or guardian)" : "Your full name"}
        value={form.typedName}
        autoComplete="name"
        maxLength={TYPED_NAME_MAX}
        onChangeText={(typedName) => update({ ...form, typedName })}
        error={problemOf("typedName")}
      />
      {version.how === "drawn" ? (
        <SignaturePad
          recorder={recorder.current}
          problem={problemOf("signature")}
          onChange={() => check(form)}
          onDrawing={onDrawing}
        />
      ) : null}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <Button label={busy ? "Saving…" : submitLabel} busy={busy} onPress={submit} />
      {secondary ? <Button quiet label={secondary.label} onPress={secondary.onPress} /> : null}
    </View>
  );
}

/** A version's words, block by block as Text. A link shows its address in full. */
export function AgreementText({ version }: { version: Pick<AgreementVersion, "body"> }) {
  return (
    <View style={styles.document}>
      {documentBlocks(version.body).map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a version's blocks never change.
        <Block key={i} block={block} />
      ))}
    </View>
  );
}

function Runs({ content }: { content: readonly AgreementRun[] | undefined }): ReactNode {
  return (content ?? []).map((run, i) => {
    const style = [
      run.bold ? styles.bold : null,
      run.italic ? styles.italic : null,
      run.code ? styles.code : null,
    ];
    if (run.href) {
      const href = run.href;
      return (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional.
          key={i}
          style={[style, styles.link]}
          accessibilityRole="link"
          onPress={() => Linking.openURL(href)}
        >
          {href}
        </Text>
      );
    }
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional.
      <Text key={i} style={style}>
        {runText(run)}
      </Text>
    );
  });
}

function List({
  style,
  items,
  depth = 0,
}: {
  style: "bullet" | "ordered";
  items: AgreementListItem[];
  depth?: number;
}) {
  return (
    <View style={{ paddingLeft: theme.space.md * (depth ? 1 : 0.5) }}>
      {items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: list items are positional.
        <View key={i}>
          <Text style={styles.body}>
            {style === "ordered" ? `${i + 1}. ` : "• "}
            <Runs content={item.content} />
          </Text>
          {item.list ? (
            <List style={item.list.style} items={item.list.items} depth={depth + 1} />
          ) : null}
        </View>
      ))}
    </View>
  );
}

function Block({ block }: { block: AgreementBlock }) {
  switch (block.type) {
    case "paragraph":
      return (
        <Text style={styles.body}>
          <Runs content={block.content} />
        </Text>
      );
    case "heading":
      return (
        <Text style={[styles.body, styles.bold]} accessibilityRole="header">
          <Runs content={block.content} />
        </Text>
      );
    case "list":
      return <List style={block.style} items={block.items} />;
    case "quote":
      return (
        <View style={styles.quote}>
          <Text style={[styles.body, styles.italic]}>
            <Runs content={block.content} />
          </Text>
          {block.attribution ? <Text style={styles.muted}>{block.attribution}</Text> : null}
        </View>
      );
    case "callout":
      return (
        <View style={styles.callout}>
          <Text style={styles.body}>
            <Runs content={block.content} />
          </Text>
        </View>
      );
    case "divider":
      return <View style={styles.divider} />;
  }
}

const styles = StyleSheet.create({
  form: { gap: theme.space.md },
  title: { fontSize: theme.font.title, fontWeight: "600", color: theme.color.text },
  muted: { fontSize: theme.font.small, color: theme.color.muted },
  body: { fontSize: theme.font.body, color: theme.color.text, lineHeight: 22 },
  document: {
    gap: theme.space.sm,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius,
    padding: theme.space.md,
  },
  bold: { fontWeight: "600" },
  italic: { fontStyle: "italic" },
  code: { fontFamily: "Courier" },
  link: { textDecorationLine: "underline" },
  quote: { borderLeftWidth: 3, borderLeftColor: theme.color.border, paddingLeft: theme.space.sm },
  callout: { backgroundColor: theme.color.surface, padding: theme.space.sm, borderRadius: 6 },
  divider: { height: 1, backgroundColor: theme.color.border },
  question: { gap: theme.space.xs },
  row: { flexDirection: "row", gap: theme.space.sm },
  choice: {
    minHeight: 44,
    minWidth: 72,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius,
    alignItems: "center",
    justifyContent: "center",
  },
  chosen: { backgroundColor: theme.color.primary, borderColor: theme.color.primary },
  chosenText: { color: theme.color.onPrimary, fontSize: theme.font.body, fontWeight: "600" },
  tick: { flexDirection: "row", gap: theme.space.sm, alignItems: "flex-start", minHeight: 44 },
  box: {
    width: 28,
    height: 28,
    borderWidth: 1,
    borderColor: theme.color.text,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  boxTicked: { backgroundColor: theme.color.primary },
  tickLabel: { flex: 1 },
  error: { fontSize: theme.font.small, color: theme.color.danger },
});
