import type { ComponentProps } from "react";
import { Text as NativeText, StyleSheet } from "react-native";
import { theme } from "./theme.ts";

/**
 * Text in the theme's colour. React Native draws a bare <Text> black, unreadable on a dark theme,
 * so blocks write their text with this one: `muted` for what is said quietly (loading, a detail),
 * `danger` for what went wrong. A style given still wins.
 */
export function Text({
  tone,
  style,
  ...props
}: ComponentProps<typeof NativeText> & { tone?: "muted" | "danger" | undefined }) {
  const toned = tone === "muted" ? styles.muted : tone === "danger" ? styles.danger : null;
  return <NativeText style={[styles.text, toned, style]} {...props} />;
}

const styles = StyleSheet.create({
  text: { color: theme.color.text },
  muted: { color: theme.color.muted },
  danger: { color: theme.color.danger },
});
