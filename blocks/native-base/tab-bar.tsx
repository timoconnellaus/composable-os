import { Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "./theme.ts";

export interface Tab<K extends string> {
  key: K;
  label: string;
}

/** A bar of tabs along the bottom of the app. */
export function TabBar<K extends string>({
  tabs,
  current,
  onChange,
}: {
  tabs: readonly Tab<K>[];
  current: K;
  onChange: (key: K) => void;
}) {
  return (
    <View accessibilityRole="tablist" style={styles.bar}>
      {tabs.map((tab) => (
        <Pressable
          key={tab.key}
          accessibilityRole="tab"
          accessibilityState={{ selected: tab.key === current }}
          style={styles.tab}
          onPress={() => onChange(tab.key)}
        >
          <Text style={[styles.label, tab.key === current ? styles.current : null]}>
            {tab.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.border,
    backgroundColor: theme.color.background,
  },
  tab: { flex: 1, alignItems: "center", paddingVertical: theme.space.sm + 4 },
  label: { fontSize: theme.font.small, color: theme.color.muted },
  current: { color: theme.color.primary, fontWeight: "600" },
});
