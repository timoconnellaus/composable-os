// The subscriptions part of My account (stage 48), for the web: the subscriptions the signed-in
// customer pays, each with its state in words, the price per period and the next charge or when it
// ends, and what they can do: cancel at the period's end, keep a cancelled one going, confirm a
// payment that waits for them. One part for every pack's section (Memberships, Courses): a section
// passes `only` for its plans and, where its pack offers it, `change` for a change of plan. The
// card is the Payment method section's (web-account-payment), once for every subscription.
//
// Every action is the host's operation on the customer's own subscription (subscription.*): the
// host refuses what does not apply, and the subscription changes once the provider confirms.
// Web only: the app shows a subscription and opens the website for the rest (ADR 0714).
import {
  type AccountHooks,
  type AccountSubscription,
  accountErrorWords,
  canCancel,
  canResume,
  isLive,
  subscriptionPrice,
  subscriptionStatus,
} from "@composable-os/client";
import { type ReactNode, useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui-card/card.tsx";

type Hooks = Pick<
  AccountHooks,
  "useSubscriptions" | "useCancelSubscription" | "useResumeSubscription"
>;

export function MySubscriptions({
  account,
  only,
  change,
  empty = "You have no subscription.",
}: {
  account: Hooks;
  /** Which of their subscriptions this section shows (a pack's plans). Default: every one. */
  only?: (sub: AccountSubscription) => boolean;
  /** A pack's change of plan for one subscription, where it offers one. */
  change?: (sub: AccountSubscription) => ReactNode;
  /** What to say when there is none. */
  empty?: string;
}) {
  const subscriptions = account.useSubscriptions();
  const cancel = account.useCancelSubscription();
  const resume = account.useResumeSubscription();
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (subscriptions.isPending) return <p aria-busy="true">Loading your subscriptions…</p>;
  if (subscriptions.error || !subscriptions.data) {
    return <p role="alert">We could not load your subscriptions.</p>;
  }
  const live = subscriptions.data.items.filter((sub) => isLive(sub) && (!only || only(sub)));
  if (!live.length) return <p className="text-muted-foreground text-sm">{empty}</p>;

  async function act(run: () => Promise<unknown>, done: string) {
    setProblem(null);
    setSaid(null);
    try {
      await run();
      setSaid(done);
      subscriptions.refetch?.();
    } catch (e) {
      setProblem(accountErrorWords(e));
    }
  }

  const busy = cancel.isPending || resume.isPending;
  return (
    <section className="grid gap-3" aria-label="Your subscriptions">
      {live.map((sub) => (
        <Card key={sub.id} data-subscription={sub.id} data-state={sub.state}>
          <CardHeader>
            <CardTitle>{sub.planTitle}</CardTitle>
            <CardDescription>{subscriptionPrice(sub)}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <p data-testid="subscription-status">{subscriptionStatus(sub)}</p>
            <div className="flex flex-wrap gap-2">
              {sub.actionUrl ? (
                <Button onClick={() => window.location.assign(sub.actionUrl ?? "")}>
                  Confirm your payment
                </Button>
              ) : null}
              {canResume(sub) ? (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () => resume.mutateAsync({ id: sub.id }),
                      "Asked to keep it going. It shows here once the payment provider confirms.",
                    )
                  }
                >
                  Keep it going
                </Button>
              ) : null}
              {canCancel(sub) ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm("Cancel? It stays yours until the period ends.")) return;
                    void act(
                      () => cancel.mutateAsync({ id: sub.id, reason: "Cancelled by the member" }),
                      "Asked to cancel. It ends when the period does; it shows here once the payment provider confirms.",
                    );
                  }}
                >
                  Cancel
                </Button>
              ) : null}
              {change ? change(sub) : null}
            </div>
          </CardContent>
        </Card>
      ))}
      {said ? <p role="status">{said}</p> : null}
      {problem ? <p role="alert">{problem}</p> : null}
    </section>
  );
}
