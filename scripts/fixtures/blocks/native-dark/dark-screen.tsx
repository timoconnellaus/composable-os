import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { theme } from "../native-base/theme.ts";

export function DarkScreen({ busy }: { busy: boolean }) {
  return (
    <View style={styles.box}>
      <Text>Drawn black on a dark theme</Text>
      <Text style={styles.size}>No colour in its style either</Text>
      <Text style={styles.body}>
        Themed, and <Text style={styles.size}>this one inherits</Text>
      </Text>
      {busy ? <ActivityIndicator /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: "#ffffff" },
  size: { fontSize: 13 },
  body: { color: theme.color.text },
});
