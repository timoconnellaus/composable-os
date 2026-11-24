// The subscriptions part of My account (stage 48), for the mobile app, read only: the
// subscriptions the signed-in customer pays, each with its state in words (trial until, next
// charge on, ending on, a payment to confirm), and "Manage on the website", which opens the
// business's website account page in the browser (`onManage`). Cancelling, keeping it going,
// changing plan and the card are the website's (ADR 0490, ADR 0714): this block calls no billing
// operation and shows no price (`noPurchase`). A pack's section passes `only` for its plans.
import {
  type AccountHooks,
  type AccountSubscription,
  isLive,
  MANAGE_ON_WEBSITE_WORDS,
  subscriptionStatus,
} from "@composable-os/client";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { theme } from "../native-base/theme.ts";

export function MySubscriptions({
  account,
  onManage,
  only,
  empty = "You have no subscription.",
}: {
  account: Pick<AccountHooks, "useSubscriptions">;
  /** Opens the business's website account page in the browser. */
  onManage: () => void;
  /** Which of their subscriptions this section shows (a pack's plans). Default: every one. */
  only?: (sub: AccountSubscription) => boolean;
  empty?: string;
}) {
  const subscriptions = account.useSubscriptions();
  if (subscriptions.isPending) return <ActivityIndicator />;
  if (subscriptions.error || !subscriptions.data) {
    return (
      <Text style={styles.body} accessibilityRole="alert">
        We could not load your subscriptions.
      </Text>
    );
  }
  const live = subscriptions.data.items.filter((sub) => isLive(sub) && (!only || only(sub)));
  return (
    <View style={styles.part}>
      <List empty={empty}>
        {live.map((sub) => (
          <Row key={sub.id} title={sub.planTitle} detail={subscriptionStatus(sub)} />
        ))}
      </List>
      {live.length ? <Button quiet label={MANAGE_ON_WEBSITE_WORDS} onPress={onManage} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  part: { gap: theme.space.md },
  body: { fontSize: theme.font.body, color: theme.color.text },
});
