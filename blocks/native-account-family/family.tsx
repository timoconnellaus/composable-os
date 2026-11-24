// Family (stage 48), for the mobile app: who the signed-in customer acts for and who acts for
// them. Staff make and end the links (ADR 0540), so linking a child is a sentence here, not a
// form. Who is linked is the host's answer (me.family).
import type { AccountHooks } from "@composable-os/client";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { theme } from "../native-base/theme.ts";

export function YourFamily({ account }: { account: Pick<AccountHooks, "useFamily"> }) {
  const family = account.useFamily();
  if (family.isPending) return <ActivityIndicator color={theme.color.muted} />;
  if (family.error || !family.data) {
    return (
      <Text style={styles.body} accessibilityRole="alert">
        We could not load your family.
      </Text>
    );
  }
  const { dependants, guardians } = family.data;
  return (
    <View style={styles.part}>
      {dependants.length ? (
        <>
          <Text style={styles.heading}>You act for</Text>
          <List>
            {dependants.map((p) => (
              <Row key={p.personId} title={p.name} />
            ))}
          </List>
        </>
      ) : null}
      {guardians.length ? (
        <>
          <Text style={styles.heading}>A parent or guardian who acts for you</Text>
          <List>
            {guardians.map((p) => (
              <Row key={p.personId} title={p.name} />
            ))}
          </List>
        </>
      ) : null}
      {!dependants.length && !guardians.length ? (
        <Text style={styles.muted}>Nobody is linked to your account.</Text>
      ) : null}
      <Text style={styles.body}>
        To book for a child or agree for them, ask the business to link them to your account.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  part: { gap: theme.space.sm },
  heading: { fontSize: theme.font.body, fontWeight: "600", color: theme.color.text },
  body: { fontSize: theme.font.body, color: theme.color.text },
  muted: { fontSize: theme.font.body, color: theme.color.muted },
});
