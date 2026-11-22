// A subscription's state as a badge (stage 32a): the label for people, the raw state in
// `data-state` for tests. The state is the host's mirror of the payment provider's.
import type { CoreOutput } from "@composable-os/core";
import { Badge } from "@composable-os/ui/components/badge";

export type SubscriptionStateName = CoreOutput<"subscription.get">["state"];

export const SUBSCRIPTION_STATE_LABELS: Record<SubscriptionStateName, string> = {
  incomplete: "Incomplete",
  expired: "Expired",
  trialing: "Trial",
  active: "Active",
  past_due: "Past due",
  unpaid: "Unpaid",
  paused: "Paused",
  ended: "Ended",
};

const VARIANTS: Record<SubscriptionStateName, "default" | "secondary" | "outline" | "destructive"> =
  {
    incomplete: "outline",
    expired: "outline",
    trialing: "secondary",
    active: "default",
    past_due: "destructive",
    unpaid: "destructive",
    paused: "outline",
    ended: "outline",
  };

export function SubscriptionStateBadge({
  state,
  testId,
}: {
  state: SubscriptionStateName;
  testId?: string;
}) {
  return (
    <Badge variant={VARIANTS[state]} data-state={state} data-testid={testId}>
      {SUBSCRIPTION_STATE_LABELS[state]}
    </Badge>
  );
}
