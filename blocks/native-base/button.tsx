import { ActivityIndicator, Pressable, StyleSheet, Text } from "react-native";
import { theme } from "./theme.ts";

/** A button: primary by default, or quiet; busy while its action runs. */
export function Button({
  label,
  onPress,
  quiet,
  busy,
  disabled,
}: {
  label: string;
  onPress: () => void;
  quiet?: boolean;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled || busy), busy: Boolean(busy) }}
      disabled={disabled || busy}
      onPress={onPress}
      style={[styles.button, quiet ? styles.quiet : styles.primary, disabled ? styles.off : null]}
    >
      {busy ? (
        <ActivityIndicator color={quiet ? theme.color.text : theme.color.onPrimary} />
      ) : (
        <Text style={[styles.label, quiet ? styles.quietLabel : styles.primaryLabel]}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 44,
    borderRadius: theme.radius,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.space.md,
  },
  primary: { backgroundColor: theme.color.primary },
  quiet: { backgroundColor: theme.color.surface },
  off: { opacity: 0.5 },
  label: { fontSize: theme.font.body, fontWeight: "600" },
  primaryLabel: { color: theme.color.onPrimary },
  quietLabel: { color: theme.color.text },
});
