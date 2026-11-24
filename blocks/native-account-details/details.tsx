// Your details (stage 48), for the mobile app: the signed-in customer's name and phone, to change,
// and the address they sign in with. What is saved is the host's (me.get, me.update): only what
// changed is sent, and the host checks it again. A section's content: the shell gives it a screen.
// Their birthday, day and month only (stage 53: me.birthday.get, me.birthday.set), where the
// client holds them.
import {
  type AccountHooks,
  accountErrorWords,
  type BirthdayForm,
  birthdayForm,
  birthdayInput,
  birthdayProblem,
  type DetailsForm,
  detailsForm,
  detailsInput,
  detailsProblems,
} from "@composable-os/client";
import { useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { Field } from "../native-base/field.tsx";
import { theme } from "../native-base/theme.ts";

type Hooks = Pick<AccountHooks, "useMe" | "useUpdateMe"> &
  Partial<Pick<AccountHooks, "useBirthday" | "useSetBirthday">>;

const FIELDS: { key: keyof DetailsForm; label: string }[] = [
  { key: "displayName", label: "Name" },
  { key: "givenName", label: "First name" },
  { key: "familyName", label: "Last name" },
  { key: "primaryPhone", label: "Phone" },
];

export function YourDetails({ account }: { account: Hooks }) {
  const me = account.useMe();
  const update = account.useUpdateMe();
  const [form, setForm] = useState<DetailsForm | null>(null);
  const [problems, setProblems] = useState<Partial<Record<keyof DetailsForm, string>>>({});
  const [said, setSaid] = useState<string | null>(null);
  if (me.isPending) return <ActivityIndicator color={theme.color.muted} />;
  if (me.error || !me.data) {
    return (
      <Text style={styles.body} accessibilityRole="alert">
        We could not load your details.
      </Text>
    );
  }
  const person = me.data;
  const shown = form ?? detailsForm(person);

  async function save() {
    setSaid(null);
    const found = detailsProblems(shown);
    setProblems(Object.fromEntries(found.map((p) => [p.field, p.message])));
    if (found.length) return;
    const input = detailsInput(person, shown);
    if (!input) {
      setSaid("Nothing to save.");
      return;
    }
    try {
      await update.mutateAsync(input);
      me.refetch?.();
      setForm(null);
      setSaid("Saved.");
    } catch (e) {
      setSaid(accountErrorWords(e));
    }
  }

  return (
    <View style={styles.form}>
      {FIELDS.map((field) => (
        <Field
          key={field.key}
          label={field.label}
          value={shown[field.key]}
          error={problems[field.key] ?? null}
          keyboardType={field.key === "primaryPhone" ? "phone-pad" : "default"}
          onChangeText={(value) => setForm({ ...shown, [field.key]: value })}
        />
      ))}
      <View>
        <Text style={styles.label}>You sign in with</Text>
        <Text style={styles.body}>{person.signInEmail}</Text>
      </View>
      <Button label="Save" busy={update.isPending} onPress={() => void save()} />
      {said ? <Text style={styles.body}>{said}</Text> : null}
      {account.useBirthday && account.useSetBirthday ? (
        <YourBirthday
          account={{ useBirthday: account.useBirthday, useSetBirthday: account.useSetBirthday }}
        />
      ) : null}
    </View>
  );
}

/** Their birthday: a day and a month (numbers), never a year. Leaving both empty removes it. */
function YourBirthday({
  account,
}: {
  account: Pick<AccountHooks, "useBirthday" | "useSetBirthday">;
}) {
  const current = account.useBirthday();
  const set = account.useSetBirthday();
  const [form, setForm] = useState<BirthdayForm | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  if (current.isPending) return <ActivityIndicator color={theme.color.muted} />;
  if (current.error || !current.data) {
    return (
      <Text style={styles.body} accessibilityRole="alert">
        We could not load your birthday.
      </Text>
    );
  }
  const saved = current.data.birthday;
  const shown = form ?? birthdayForm(saved);

  async function save() {
    setSaid(null);
    const typed = { day: shown.day.trim(), month: shown.month.trim() };
    const found =
      /^\d*$/.test(typed.day) && /^\d*$/.test(typed.month)
        ? birthdayProblem(typed)
        : "Use numbers: the day, and the month from 1 to 12";
    setProblem(found);
    if (found) return;
    const input = birthdayInput(saved, typed);
    if (!input) {
      setSaid("Nothing to save.");
      return;
    }
    try {
      await set.mutateAsync(input);
      current.refetch?.();
      setForm(null);
      setSaid("Saved.");
    } catch (e) {
      setSaid(accountErrorWords(e));
    }
  }

  return (
    <View style={styles.form}>
      <Text style={styles.label}>Birthday (optional): day and month only</Text>
      <Field
        label="Day"
        value={shown.day}
        keyboardType="number-pad"
        error={problem}
        onChangeText={(value) => setForm({ ...shown, day: value })}
      />
      <Field
        label="Month (1 to 12)"
        value={shown.month}
        keyboardType="number-pad"
        onChangeText={(value) => setForm({ ...shown, month: value })}
      />
      <Button label="Save birthday" busy={set.isPending} onPress={() => void save()} />
      {said ? <Text style={styles.body}>{said}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: theme.space.md },
  label: { fontSize: theme.font.small, color: theme.color.muted },
  body: { fontSize: theme.font.body, color: theme.color.text },
});
