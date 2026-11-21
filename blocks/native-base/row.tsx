import { Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "./theme.ts";

/** One row of a list: a title, an optional detail, and an optional press. */
export function Row({
  title,
  detail,
  onPress,
}: {
  title: string;
  detail?: string | null;
  onPress?: () => void;
}) {
  const content = (
    <View style={styles.row}>
      <Text style={styles.title}>{title}</Text>
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
    </View>
  );
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress}>
      {content}
    </Pressable>
  ) : (
    content
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: theme.space.sm + 4, paddingHorizontal: theme.space.md },
  title: { fontSize: theme.font.body, color: theme.color.text },
  detail: { fontSize: theme.font.small, color: theme.color.muted, marginTop: 2 },
});
