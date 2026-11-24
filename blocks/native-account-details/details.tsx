// Your details (stage 48), for the mobile app: the signed-in customer's name and phone, to change,
// and the address they sign in with. What is saved is the host's (me.get, me.update): only what
// changed is sent, and the host checks it again. A section's content: the shell gives it a screen.
import {
  type AccountHooks,
  accountErrorWords,
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

type Hooks = Pick<AccountHooks, "useMe" | "useUpdateMe">;

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
  if (me.isPending) return <ActivityIndicator />;
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
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: theme.space.md },
  label: { fontSize: theme.font.small, color: theme.color.muted },
  body: { fontSize: theme.font.body, color: theme.color.text },
});
