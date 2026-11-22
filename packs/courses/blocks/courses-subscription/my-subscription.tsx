// A member's own course subscription on the studio's site (stage 32a): its state in words, the
// next charge or when it ends, and what they can do: cancel at the period's end, keep it going,
// confirm a payment that waits on them, or open the payment provider's portal for their card and
// past invoices. Every action is the host's operation (`subscription.*`), on the member's own
// subscription only; the host refuses what does not apply, and the record changes once the
// provider confirms. Web only: the app shows the subscription and does nothing to it.
import type { CourseSubscription, CoursesHooks } from "@composable-os/pack-courses/client";
import { formatMinor, isLive, subscriptionStatus } from "@composable-os/pack-courses/client";
import { useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui-card/card.tsx";

export function MySubscription({
  courses,
  returnUrl,
}: {
  courses: Pick<
    CoursesHooks,
    "useMySubscriptions" | "useCancelSubscription" | "useResumeSubscription" | "useBillingPortal"
  >;
  /** Where the provider's portal's back link goes (one of the host's listed origins). */
  returnUrl: string;
}) {
  const { data, isPending, error } = courses.useMySubscriptions();
  const cancel = courses.useCancelSubscription();
  const resume = courses.useResumeSubscription();
  const portal = courses.useBillingPortal();
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (isPending) return <p aria-busy="true">Loading your subscription…</p>;
  if (error || !data) return <p role="alert">We could not load your subscription.</p>;
  const live = data.items.filter(isLive);
  if (!live.length) return <p>You have no course subscription.</p>;

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
      // The provider's portal opens in its own page: it cannot be put in a frame.
      const opened = await portal.mutateAsync({ returnUrl });
      window.location.assign(opened.url);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "We could not open your billing");
    }
  }

  const ending = (sub: CourseSubscription) => sub.cancelAtPeriodEnd || sub.cancelAt !== null;
  const busy = cancel.isPending || resume.isPending || portal.isPending;
  return (
    <section className="grid gap-4" aria-label="My subscription">
      {live.map((sub) => (
        <Card key={sub.id}>
          <CardHeader>
            <CardTitle>{sub.planTitle}</CardTitle>
            <CardDescription>
              {`${formatMinor(sub.amount, sub.currency)} a ${sub.interval} · every course`}
            </CardDescription>
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
                  Keep my subscription
                </Button>
              ) : ending(sub) ? null : (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm("Cancel? You keep every course until the period ends.")) {
                      return;
                    }
                    void act(
                      () => cancel.mutateAsync({ id: sub.id, reason: "Cancelled by the member" }),
                      "Asked to cancel. It ends when the period does; it shows here once the payment provider confirms.",
                    );
                  }}
                >
                  Cancel subscription
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
