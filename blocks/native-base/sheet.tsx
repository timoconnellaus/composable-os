import type { ReactNode } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "./theme.ts";

/** A sheet from the bottom of the screen, closed by its button or a tap outside it. */
export function Sheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable accessibilityLabel="Close" style={styles.scrim} onPress={onClose} />
      <View style={styles.sheet}>
        {title ? <Text style={styles.title}>{title}</Text> : null}
        {children}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.3)" },
  sheet: {
    backgroundColor: theme.color.background,
    padding: theme.space.lg,
    borderTopLeftRadius: theme.radius * 2,
    borderTopRightRadius: theme.radius * 2,
    gap: theme.space.md,
  },
  title: { fontSize: theme.font.body + 2, fontWeight: "600", color: theme.color.text },
});
