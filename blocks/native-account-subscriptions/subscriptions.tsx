// The subscriptions part of My account (stage 48), for the mobile app, read only: the
// subscriptions the signed-in customer pays, each with its state in words (trial until, next
// charge on, ending on, a payment to confirm), and "Manage on the website", which opens the
// business's website account page in the browser (`onManage`). Cancelling, keeping it going,
// changing plan and the card are the website's (ADR 0490, ADR 0714): this block calls no billing
// operation and shows no price (`noPurchase`). One part for every pack's section (Memberships,
// Courses): a section passes its own hooks over `subscription.list` (or the account's with
// `only` for its plans), and `about` for words of its own (a plan change, a cooling off).
import {
  type AccountSubscription,
  isLive,
  MANAGE_ON_WEBSITE_WORDS,
  type SubscriptionsPartHooks,
  subscriptionStatus,
} from "@composable-os/client";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { theme } from "../native-base/theme.ts";

export function MySubscriptions<S extends AccountSubscription>({
  account,
  onManage,
  only,
  about,
  status = subscriptionStatus,
  manageWords = "Manage it on the business's website.",
  empty = "You have no subscription.",
}: {
  account: Pick<SubscriptionsPartHooks<S>, "useSubscriptions">;
  /** Opens the business's website account page in the browser. Left out, the part says so in words. */
  onManage?: () => void;
  /** Which of their subscriptions this section shows (a pack's plans). Default: every one. */
  only?: (sub: S) => boolean;
  /** A pack's own words for one subscription, after its state. */
  about?: (sub: S) => string | null;
  /** A subscription's state in words (a pack's own, which knows its pauses). */
  status?: (sub: S) => string;
  /** Said where there is no website link to press. */
  manageWords?: string;
  /** What to say when there is none; null says nothing. */
  empty?: string | null;
}) {
  const subscriptions = account.useSubscriptions();
  if (subscriptions.isPending) return <ActivityIndicator color={theme.color.muted} />;
  if (subscriptions.error || !subscriptions.data) {
    return (
      <Text style={styles.body} accessibilityRole="alert">
        We could not load your subscriptions.
      </Text>
    );
  }
  const live = subscriptions.data.items.filter((sub) => isLive(sub) && (!only || only(sub)));
  if (!live.length && empty === null) return null;
  return (
    <View style={styles.part}>
      <List empty={empty ?? undefined}>
        {live.map((sub) => {
          const more = about?.(sub);
          return (
            <Row
              key={sub.id}
              title={sub.planTitle}
              detail={more ? `${status(sub)}. ${more}` : status(sub)}
            />
          );
        })}
      </List>
      {live.length ? (
        onManage ? (
          <Button quiet label={MANAGE_ON_WEBSITE_WORDS} onPress={onManage} />
        ) : (
          <Text style={styles.body}>{manageWords}</Text>
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  part: { gap: theme.space.md },
  body: { fontSize: theme.font.body, color: theme.color.text },
});
