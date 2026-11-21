import type { ReactNode } from "react";
import { SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "./theme.ts";

/** A screen: a title and its content, scrolling, inside the safe area. */
export function Screen({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        {title ? <Text style={styles.title}>{title}</Text> : null}
        <View style={styles.body}>{children}</View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.background },
  content: { padding: theme.space.md },
  title: {
    fontSize: theme.font.title,
    fontWeight: "600",
    color: theme.color.text,
    marginBottom: theme.space.md,
  },
  body: { gap: theme.space.md },
});
