// A member's course subscription in the studio's app (stage 32a), read only: its state, the next
// charge date or when it ends, and that it gives every course; and a continuation offer they have
// not taken yet (moving from another platform), in words, to take on the web. Starting,
// cancelling, resuming and the card are on the web only (`noPurchase`: the block lint refuses a
// subscription operation or a price here). What the subscription gives is the host's; this only
// says what the host reports.
import type { CoursesHooks } from "@composable-os/pack-courses/client";
import { day, isLive, PLAN, subscriptionStatus } from "@composable-os/pack-courses/client";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { Screen } from "../native-base/screen.tsx";
import { Text } from "../native-base/text.tsx";

export function SubscriptionScreen({
  courses,
}: {
  courses: Pick<CoursesHooks, "useMySubscriptions" | "useMyOffers">;
}) {
  const { data, isPending, error } = courses.useMySubscriptions();
  const offers = courses.useMyOffers();
  const live = data?.items.filter(isLive) ?? [];
  const offer = offers.data?.offers.find((o) => o.planObject === PLAN);
  return (
    <Screen title="My subscription">
      {isPending ? (
        <Text tone="muted" accessibilityRole="progressbar">
          Loading your subscription…
        </Text>
      ) : null}
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
      {offer && !live.length ? (
        <Text>
          {offer.askUs
            ? `Your subscription with us is paid up to ${day(offer.freeUntil)}. Ask the studio to continue it.`
            : offer.chargedNow
              ? `Your subscription with us was paid up to ${day(offer.freeUntil)}. Continue it on the studio's website.`
              : `Your subscription with us is paid up to ${day(offer.freeUntil)}. Continue it on the studio's website, free until then.`}
        </Text>
      ) : null}
      {live.length ? <Text>Manage your subscription on the studio's website.</Text> : null}
    </Screen>
  );
}
