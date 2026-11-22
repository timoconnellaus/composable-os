// A member's memberships and passes on the gym's site (stage 32b): what each allows, when it stops
// or expires, and what is left this week, this month or in all, from the host's count
// (`x.memberships.mine`, `allowance.get`); and their membership subscriptions, with what they can
// do: cancel at the period's end, keep it going, confirm a payment that waits on them, or open the
// payment provider's portal for their card and invoices. Every action is the host's operation, on
// their own subscription only. Web only: the app shows the same and does nothing to it.
import type {
  MembershipSubscription,
  MembershipsHooks,
} from "@composable-os/pack-memberships/client";
import {
  allowsWords,
  day,
  isLive,
  leftWords,
  subscriptionStatus,
} from "@composable-os/pack-memberships/client";
import { useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui-card/card.tsx";

export function MyMemberships({
  memberships,
  returnUrl,
}: {
  memberships: Pick<
    MembershipsHooks,
    | "useMine"
    | "useMySubscriptions"
    | "useCancelSubscription"
    | "useResumeSubscription"
    | "useBillingPortal"
  >;
  /** Where the provider's portal's back link goes (one of the host's listed origins). */
  returnUrl: string;
}) {
  const mine = memberships.useMine();
  const subs = memberships.useMySubscriptions();
  const cancel = memberships.useCancelSubscription();
  const resume = memberships.useResumeSubscription();
  const portal = memberships.useBillingPortal();
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (mine.isPending) return <p aria-busy="true">Loading your memberships…</p>;
  if (mine.error || !mine.data) return <p role="alert">We could not load your memberships.</p>;
  const live = (subs.data?.items ?? []).filter(isLive);

  async function act(run: () => Promise<unknown>, done: string) {
    setProblem(null);
    setSaid(null);
    try {
      await run();
      setSaid(done);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "That did not work");
    }
  }

  async function onPortal() {
    setProblem(null);
    try {
      const opened = await portal.mutateAsync({ returnUrl });
      window.location.assign(opened.url);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "We could not open your billing");
    }
  }

  const ending = (sub: MembershipSubscription) => sub.cancelAtPeriodEnd || sub.cancelAt !== null;
  const busy = cancel.isPending || resume.isPending || portal.isPending;
  return (
    <section className="grid gap-4" aria-label="My memberships">
      {mine.data.holdings.length ? null : <p>You have no membership or pass yet.</p>}
      {mine.data.holdings.map((h) => (
        <Card key={h.id} data-kind={h.kind}>
          <CardHeader>
            <CardTitle>{h.title}</CardTitle>
            <CardDescription>{allowsWords(h)}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-1">
            <p data-testid="holding-left">{leftWords(h)}</p>
            {h.until ? (
              <p className="text-sm">
                {`${h.kind === "pass" ? "Expires" : "Until"} ${day(h.until)}`}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ))}
      {live.map((sub) => (
        <Card key={sub.id}>
          <CardHeader>
            <CardTitle>{sub.planTitle}</CardTitle>
            <CardDescription>Your membership's billing</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <p data-testid="subscription-status">{subscriptionStatus(sub)}</p>
            <div className="flex flex-wrap gap-2">
              {sub.actionUrl ? (
                <Button onClick={() => window.location.assign(sub.actionUrl ?? "")}>
                  Confirm your payment
                </Button>
              ) : null}
              {sub.cancelAtPeriodEnd ? (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () => resume.mutateAsync({ id: sub.id }),
                      "Asked to keep it going. It shows here once the payment provider confirms.",
                    )
                  }
                >
                  Keep my membership
                </Button>
              ) : ending(sub) ? null : (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm("Cancel? Your membership runs until the period ends.")) {
                      return;
                    }
                    void act(
                      () => cancel.mutateAsync({ id: sub.id, reason: "Cancelled by the member" }),
                      "Asked to cancel. It ends when the period does; it shows here once the payment provider confirms.",
                    );
                  }}
                >
                  Cancel membership
                </Button>
              )}
              <Button variant="outline" disabled={busy} onClick={() => void onPortal()}>
                Card and invoices
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
      {said ? <p role="status">{said}</p> : null}
      {problem ? <p role="alert">{problem}</p> : null}
    </section>
  );
}
