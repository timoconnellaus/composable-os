// A form to fill in, for the mobile app (stage 29 step 4): the native skin over the same headless
// entry as the web block, with every question kind the question schema has, then its thank-you.
// `FormScreen` opens a form by its address; `LinkedFormScreen` opens a signed-in member's own
// personal link from Needs your attention (`me.attention`, kind form_to_fill, by the link's id):
// the app's prompt to answer the feedback after a class.
//
// It holds no rules: who may answer, once only, the spam checks and the caps are the host's, and
// its answer is the one shown; the answers are checked first with the host's own check, for the
// words beside each question. A member in the app is signed in, so the host asks no spam check of
// them; for a visitor on a public form, the app passes its Turnstile widget (`Turnstile`, in a web
// view), and the host's token of when the form was shown travels with the send. What a person
// types stays in this screen's state and nowhere else.
import {
  type DraftValue,
  type Filler,
  type FormsHooks,
  isAsked,
  type OpenedForm,
  type QuestionItem,
  ratingLabel,
  ratingValues,
  refusalOf,
} from "@composable-os/pack-forms/client";
import { type ComponentType, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { Field } from "../native-base/field.tsx";
import { Screen } from "../native-base/screen.tsx";
import { Text } from "../native-base/text.tsx";
import { theme } from "../native-base/theme.ts";

/** The app's Turnstile widget (in a web view): `onToken` with a token, null when it expires. */
export type NativeTurnstile = ComponentType<{ onToken: (token: string | null) => void }>;

/** Rich text's inline runs as text: bold and italic kept, links drawn as their words. */
function inlineText(content: unknown[]): string {
  return content
    .map((run) => {
      const r = run as { type?: string; text?: string };
      return r.type === "break" ? "\n" : r.type === "text" ? (r.text ?? "") : "";
    })
    .join("");
}

function Choice({
  label,
  checked,
  several,
  invalid,
  onPress,
}: {
  label: string;
  checked: boolean;
  several: boolean;
  invalid: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole={several ? "checkbox" : "radio"}
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.option, checked ? styles.optionOn : null, invalid ? styles.invalid : null]}
    >
      <View style={[styles.mark, several ? null : styles.round, checked ? styles.markOn : null]} />
      <Text style={styles.optionLabel}>{label}</Text>
    </Pressable>
  );
}

/** One question (or a heading or paragraph), drawn by its kind. */
export function NativeQuestion({
  item,
  value,
  error,
  onChange,
}: {
  item: QuestionItem;
  value: DraftValue | undefined;
  error?: string | undefined;
  onChange: (value: DraftValue) => void;
}) {
  if (item.kind === "heading") {
    return (
      <Text accessibilityRole="header" style={styles.heading}>
        {item.text}
      </Text>
    );
  }
  if (item.kind === "paragraph") return <Text>{inlineText(item.content)}</Text>;
  const required = item.required ? " (required)" : "";
  const notes = (
    <>
      {item.kind !== "consent" && item.help ? <Text tone="muted">{item.help}</Text> : null}
      {error &&
      (item.kind === "consent" ||
        item.kind === "choice" ||
        item.kind === "rating" ||
        item.kind === "yesNo") ? (
        <Text tone="danger">{error}</Text>
      ) : null}
    </>
  );
  if (item.kind === "consent") {
    return (
      <View style={styles.question}>
        <Choice
          label={`${item.words}${required}`}
          checked={value === true}
          several
          invalid={Boolean(error)}
          onPress={() => onChange(value !== true)}
        />
        {notes}
      </View>
    );
  }
  if (item.kind === "choice" || item.kind === "rating" || item.kind === "yesNo") {
    const options =
      item.kind === "choice"
        ? item.options.map((o) => ({ value: o as string | number | boolean, label: o }))
        : item.kind === "rating"
          ? ratingValues(item).map((n) => ({ value: n, label: ratingLabel(item, n) }))
          : [
              { value: true, label: "Yes" },
              { value: false, label: "No" },
            ];
    const several = item.kind === "choice" && item.multiple === true;
    const chosen = (v: string | number | boolean) =>
      several ? Array.isArray(value) && value.includes(v as string) : value === v;
    return (
      <View style={styles.question} accessibilityRole={several ? undefined : "radiogroup"}>
        <Text style={styles.label}>
          {item.label}
          {required}
        </Text>
        {notes}
        <View style={item.kind === "choice" ? styles.list : styles.row}>
          {options.map((option) => (
            <Choice
              key={String(option.value)}
              label={option.label}
              checked={chosen(option.value)}
              several={several}
              invalid={Boolean(error)}
              onPress={() => {
                if (!several) return onChange(option.value);
                const now = Array.isArray(value) ? value : [];
                const v = option.value as string;
                onChange(now.includes(v) ? now.filter((x) => x !== v) : [...now, v]);
              }}
            />
          ))}
        </View>
      </View>
    );
  }
  const text = typeof value === "string" ? value : "";
  return (
    <View style={styles.question}>
      <Field
        label={`${item.label}${required}`}
        error={error ?? null}
        value={text}
        onChangeText={(v) => onChange(v)}
        multiline={item.kind === "text" && item.long === true}
        maxLength={item.kind === "text" ? (item.max ?? (item.long ? 5000 : 200)) : undefined}
        keyboardType={
          item.kind === "email"
            ? "email-address"
            : item.kind === "phone"
              ? "phone-pad"
              : item.kind === "number"
                ? "decimal-pad"
                : "default"
        }
        autoCapitalize={item.kind === "email" ? "none" : "sentences"}
        autoComplete={item.kind === "email" ? "email" : item.kind === "phone" ? "tel" : undefined}
        placeholder={item.kind === "date" ? "YYYY-MM-DD" : undefined}
        numberOfLines={item.kind === "text" && item.long ? 6 : 1}
      />
      {item.help ? <Text tone="muted">{item.help}</Text> : null}
    </View>
  );
}

function nameOf(item: QuestionItem): string {
  if (!isAsked(item)) return "";
  return (item.kind === "consent" ? item.words : item.label).slice(0, 80);
}

/** A form being filled: its questions, what to fix, the spam check where asked, and the send. */
export function NativeFormFields({
  form,
  filler,
  Turnstile,
}: {
  form: OpenedForm;
  filler: Filler;
  Turnstile?: NativeTurnstile | undefined;
}) {
  const [token, setToken] = useState<string | null>(null);
  const faults = filler.items.filter((item) => filler.errors[item.key]);
  return (
    <View style={styles.body}>
      {faults.length || filler.problem ? (
        <View accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.summary}>
          <Text style={styles.label}>
            {faults.length ? "Some answers need another look" : "Your answers were not sent"}
          </Text>
          {filler.problem && filler.problem.kind !== "answers" ? (
            <Text tone="danger">{filler.problem.message}</Text>
          ) : null}
          {faults.map((item) => (
            <Text key={item.key} tone="danger">
              {nameOf(item)}: {filler.errors[item.key]}
            </Text>
          ))}
        </View>
      ) : null}
      {filler.items.map((item) => (
        <NativeQuestion
          key={item.key}
          item={item}
          value={filler.draft[item.key]}
          error={filler.errors[item.key]}
          onChange={(v) => filler.set(item.key, v)}
        />
      ))}
      {form.turnstile ? (
        Turnstile ? (
          <Turnstile onToken={setToken} />
        ) : (
          <Text tone="muted">This form cannot be sent from the app just now.</Text>
        )
      ) : null}
      <Button
        label="Send"
        busy={filler.status === "sending"}
        disabled={form.turnstile && !Turnstile}
        onPress={() => {
          void filler.send(form.turnstile ? { turnstileToken: token } : {});
        }}
      />
    </View>
  );
}

function Opened({
  form,
  filler,
  Turnstile,
  onDone,
}: {
  form: OpenedForm;
  filler: Filler;
  Turnstile?: NativeTurnstile | undefined;
  onDone?: (() => void) | undefined;
}) {
  const sent = filler.status === "sent";
  return (
    <Screen title={form.title ?? "Form"}>
      {sent ? (
        <View style={styles.body}>
          <Text accessibilityLiveRegion="polite">{filler.thanks}</Text>
          {onDone ? <Button label="Done" onPress={onDone} /> : null}
        </View>
      ) : (
        <NativeFormFields form={form} filler={filler} Turnstile={Turnstile} />
      )}
    </Screen>
  );
}

function NotOpen({ error, link }: { error: unknown; link: boolean }) {
  if (!error) {
    return (
      <Screen>
        <Text tone="muted">Loading…</Text>
      </Screen>
    );
  }
  const refusal = refusalOf(error);
  return (
    <Screen>
      <Text accessibilityRole="alert">
        {refusal.kind === "offline" || refusal.kind === "other" || refusal.kind === "later"
          ? "This form could not be opened just now. Try again shortly."
          : link
            ? "This link cannot be used: it may have been used already or have expired."
            : "This form is not taking answers just now."}
      </Text>
    </Screen>
  );
}

/** A form by its address, in the app. `Turnstile`: the app's widget, for a visitor's public form. */
export function FormScreen({
  forms,
  slug,
  Turnstile,
  onDone,
}: {
  forms: Pick<FormsHooks, "useForm" | "useAnswer">;
  slug: string;
  Turnstile?: NativeTurnstile;
  onDone?: () => void;
}) {
  const opened = forms.useForm({ slug });
  const filler = forms.useAnswer(opened.data, { via: "app" });
  if (!opened.data) return <NotOpen error={opened.error} link={false} />;
  return <Opened form={opened.data} filler={filler} Turnstile={Turnstile} onDone={onDone} />;
}

/**
 * A signed-in member's own personal link (or a child's they are a guardian of), opened from Needs
 * your attention by the link's id. Answered once; the item goes once sent.
 */
export function LinkedFormScreen({
  forms,
  linkId,
  onDone,
}: {
  forms: Pick<FormsHooks, "useLinkedForm" | "useAnswerLinked">;
  linkId: string;
  onDone?: () => void;
}) {
  const opened = forms.useLinkedForm(linkId);
  const filler = forms.useAnswerLinked(opened.data, linkId);
  if (!opened.data) return <NotOpen error={opened.error} link />;
  return <Opened form={opened.data} filler={filler} onDone={onDone} />;
}

const styles = StyleSheet.create({
  body: { gap: theme.space.md },
  question: { gap: theme.space.xs },
  heading: { fontSize: theme.font.body + 2, fontWeight: "600", color: theme.color.text },
  label: { fontSize: theme.font.body, fontWeight: "600", color: theme.color.text },
  list: { gap: theme.space.xs },
  row: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.xs },
  option: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.sm,
    paddingHorizontal: theme.space.sm + 4,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius,
  },
  optionOn: { borderColor: theme.color.primary, backgroundColor: theme.color.surface },
  invalid: { borderColor: theme.color.danger },
  optionLabel: { fontSize: theme.font.body, color: theme.color.text, flexShrink: 1 },
  mark: {
    width: 20,
    height: 20,
    borderWidth: 2,
    borderColor: theme.color.muted,
    borderRadius: 4,
  },
  round: { borderRadius: 10 },
  markOn: { borderColor: theme.color.primary, backgroundColor: theme.color.primary },
  summary: {
    gap: theme.space.xs,
    padding: theme.space.sm + 4,
    borderWidth: 2,
    borderColor: theme.color.danger,
    borderRadius: theme.radius,
  },
});
