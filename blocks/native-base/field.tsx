import { StyleSheet, Text, TextInput, type TextInputProps, View } from "react-native";
import { theme } from "./theme.ts";

/** A labelled text field, with an error under it when there is one. */
export function Field({
  label,
  error,
  ...input
}: TextInputProps & { label: string; error?: string | null }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={theme.color.muted}
        style={[styles.input, error ? styles.invalid : null]}
        {...input}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: theme.space.xs },
  label: { fontSize: theme.font.small, color: theme.color.muted },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius,
    paddingHorizontal: theme.space.sm + 4,
    fontSize: theme.font.body,
    color: theme.color.text,
  },
  invalid: { borderColor: theme.color.danger },
  error: { fontSize: theme.font.small, color: theme.color.danger },
});
