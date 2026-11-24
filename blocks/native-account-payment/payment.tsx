// Payment method (stage 48), for the mobile app: the card is kept by the payment provider and
// changed on the website (ADR 0490, ADR 0714), so this says so and opens the business's website
// account page in the browser (`onManage`). It calls no operation. The shell shows it only to
// someone who pays a subscription.
import { MANAGE_ON_WEBSITE_WORDS } from "@composable-os/client";
import { StyleSheet, Text, View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { theme } from "../native-base/theme.ts";

export function PaymentMethod({ onManage }: { onManage: () => void }) {
  return (
    <View style={styles.part}>
      <Text style={styles.body}>
        Your card is kept by the payment provider. Change it, or see your past invoices, on the
        website.
      </Text>
      <Button label={MANAGE_ON_WEBSITE_WORDS} onPress={onManage} />
    </View>
  );
}

const styles = StyleSheet.create({
  part: { gap: theme.space.md },
  body: { fontSize: theme.font.body, color: theme.color.text },
});
