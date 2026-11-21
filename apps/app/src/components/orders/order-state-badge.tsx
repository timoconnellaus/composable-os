// An order's state as a badge: the label for people, the raw state in `data-state` for tests.
import { Badge } from "@composable-os/ui/components/badge";
import { ORDER_STATE_LABELS, ORDER_STATE_VARIANTS, type OrderStateName } from "#/lib/money";

export function OrderStateBadge({ state, testId }: { state: OrderStateName; testId?: string }) {
  return (
    <Badge variant={ORDER_STATE_VARIANTS[state]} data-state={state} data-testid={testId}>
      {ORDER_STATE_LABELS[state]}
    </Badge>
  );
}
