// A member's course subscription in the studio's app (stage 32a), read only: its state, the next
// charge date or when it ends, and that it gives every course. Starting, cancelling, resuming and
// the card are on the web only (`noPurchase`: the block lint refuses a subscription operation or a
// price here). What the subscription gives is the host's; this only says what the host reports.
import type { CoursesHooks } from "@composable-os/pack-courses/client";
import { isLive, subscriptionStatus } from "@composable-os/pack-courses/client";
import { Text } from "react-native";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { Screen } from "../native-base/screen.tsx";

export function SubscriptionScreen({
  courses,
}: {
  courses: Pick<CoursesHooks, "useMySubscriptions">;
}) {
  const { data, isPending, error } = courses.useMySubscriptions();
  const live = data?.items.filter(isLive) ?? [];
  return (
    <Screen title="My subscription">
      {isPending ? <Text accessibilityRole="progressbar">Loading your subscription…</Text> : null}
      {error ? <Text accessibilityRole="alert">We could not load your subscription.</Text> : null}
      {data ? (
        <List empty="You have no course subscription.">
          {live.map((sub) => (
            <Row
              key={sub.id}
              title={`${sub.planTitle}: every course`}
              detail={subscriptionStatus(sub)}
            />
          ))}
        </List>
      ) : null}
      {live.length ? <Text>Manage your subscription on the studio's website.</Text> : null}
    </Screen>
  );
}
