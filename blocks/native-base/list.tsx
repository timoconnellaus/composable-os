import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { theme } from "./theme.ts";

/** A list of rows with a hairline between them, and what to say when it is empty. */
export function List({ children, empty }: { children: ReactNode[]; empty?: string }) {
  if (!children.length) {
    return <Text style={styles.empty}>{empty ?? "Nothing here yet."}</Text>;
  }
  return (
    <View style={styles.list}>
      {children.map((child, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional; their content has the key.
        <View key={i} style={i > 0 ? styles.divided : undefined}>
          {child}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { borderRadius: theme.radius, backgroundColor: theme.color.surface, overflow: "hidden" },
  divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.border },
  empty: { color: theme.color.muted, fontSize: theme.font.body },
});
