// A member's memberships and passes on the gym's site (stage 32b): what each allows, when it stops
// or expires, and what is left this week, this month or in all, from the host's count
// (`x.memberships.mine`, `allowance.get`); and their membership subscriptions, with what they can
// do: cancel at the period's end, keep it going, change plan (the host decides: an upgrade now,
// its prorated charge on the card, or a downgrade from the next period), confirm a payment that
// waits on them, or open the payment provider's portal for their card and invoices. Every action is the host's operation, on
// their own subscription only. Web only: the app shows the same and does nothing to it.
// While the host says a new member may cool off (stage 44 step 7, ADR 0647), "Cancel for a full
// refund" sits beside the ordinary cancel, with the last day of the period; the window is never
// worked out here. A membership ended that way stays shown, with where its refund is.
import type {
  CoolingOffStatus,
  MembershipSubscription,
  MembershipsHooks,
} from "@composable-os/pack-memberships/client";
import {
  allowsWords,
  canChangePlan,
  changeRefusalWords,
  changeWords,
  coolingOffClosedWords,
  coolingOffWords,
  coolOffProgressWords,
  coolOffRefusalWords,
  day,
  formatMinor,
  formatPrice,
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
    | "usePlans"
    | "useChangePlan"
    | "useCoolingOff"
    | "useCoolOff"
  >;
  /** Where the provider's portal's back link goes (one of the host's listed origins). */
  returnUrl: string;
}) {
  const mine = memberships.useMine();
  const subs = memberships.useMySubscriptions();
  const cancel = memberships.useCancelSubscription();
  const resume = memberships.useResumeSubscription();
  const portal = memberships.useBillingPortal();
  const plans = memberships.usePlans();
  const change = memberships.useChangePlan();
  const coolOff = memberships.useCoolOff();
  const all = subs.data?.items ?? [];
  // The host's answer for each: offered or not, and a cooling off asked for.
  const cooling = memberships.useCoolingOff(all.map((sub) => sub.id));
  const [choosing, setChoosing] = useState<string | null>(null);
  const [planId, setPlanId] = useState("");
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (mine.isPending) return <p aria-busy="true">Loading your memberships…</p>;
  if (mine.error || !mine.data) return <p role="alert">We could not load your memberships.</p>;
  const statusOf = (id: string): CoolingOffStatus | undefined =>
    cooling.data?.items.find((c) => c.subscriptionId === id);
  // Live ones, and one ended in its cooling-off period (with where its refund is).
  const shown = all.filter((sub) => isLive(sub) || statusOf(sub.id)?.coolOff?.state === "ended");

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
  const busy =
    cancel.isPending ||
    resume.isPending ||
    portal.isPending ||
    change.isPending ||
    coolOff.isPending;

  async function onCoolOff(sub: MembershipSubscription, status: CoolingOffStatus) {
    const refund = formatMinor(status.refund, status.currency);
    if (
      !window.confirm(
        `End your membership now, for a full refund of ${refund}? It stops at once; the business approves the refund.`,
      )
    ) {
      return;
    }
    setProblem(null);
    setSaid(null);
    try {
      const done = await coolOff.mutateAsync({ id: sub.id });
      setSaid(
        done.asked === "unknown"
          ? "We asked the payment provider to end it and did not hear back. It shows here once it answers; the business has been told."
          : `Asked to end it now. A full refund of ${formatMinor(done.refund, done.currency)} is owed once the payment provider confirms; the business approves it.`,
      );
    } catch (e) {
      setProblem(
        coolOffRefusalWords((e as { details?: { rule?: unknown; reason?: unknown } }).details),
      );
    }
  }

  async function onChange(sub: MembershipSubscription) {
    setProblem(null);
    setSaid(null);
    try {
      const asked = await change.mutateAsync({
        id: sub.id,
        planId,
        reason: "Changed by the member",
      });
      setChoosing(null);
      setSaid(
        asked.asked === "unknown"
          ? "We asked the payment provider and did not hear back. Your plan shows here once it answers."
          : asked.kind === "upgrade"
            ? "Asked to change now. The rest of this period is charged to your card; the new plan shows here once the payment provider confirms it."
            : `Your plan changes on ${day(asked.effectiveAt)}, when this period ends. Nothing is refunded; the new price is charged from then.`,
      );
    } catch (e) {
      const details = (e as { details?: { rule?: unknown } }).details;
      setProblem(changeRefusalWords(details));
    }
  }
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
      {shown.map((sub) => {
        const status = statusOf(sub.id);
        if (!isLive(sub)) {
          return (
            <Card key={sub.id} data-kind="cooled-off">
              <CardHeader>
                <CardTitle>{sub.planTitle}</CardTitle>
                <CardDescription>Your membership's billing</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3">
                <p data-testid="subscription-status">{`Ended${sub.endedAt ? ` on ${day(sub.endedAt)}` : ""}`}</p>
                <p data-testid="cooling-off">{coolOffProgressWords(status)}</p>
              </CardContent>
            </Card>
          );
        }
        return (
          <Card key={sub.id}>
            <CardHeader>
              <CardTitle>{sub.planTitle}</CardTitle>
              <CardDescription>Your membership's billing</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <p data-testid="subscription-status">{subscriptionStatus(sub)}</p>
              {coolingOffWords(status) ? (
                <p data-testid="cooling-off">{coolingOffWords(status)}</p>
              ) : coolOffProgressWords(status) ? (
                <p data-testid="cooling-off">{coolOffProgressWords(status)}</p>
              ) : coolingOffClosedWords(status) ? (
                <p data-testid="cooling-off">{coolingOffClosedWords(status)}</p>
              ) : null}
              {changeWords(sub) ? (
                <p data-testid="subscription-change">{changeWords(sub)}</p>
              ) : null}
              {sub.change?.actionUrl && sub.change.state === "requested" ? (
                <Button onClick={() => window.location.assign(sub.change?.actionUrl ?? "")}>
                  Confirm the new plan's payment
                </Button>
              ) : null}
              {choosing === sub.id ? (
                <div className="grid max-w-sm gap-2">
                  <label htmlFor={`change-plan-${sub.id}`}>Move to</label>
                  <select
                    id={`change-plan-${sub.id}`}
                    className="rounded-md border px-2 py-1"
                    value={planId}
                    onChange={(e) => setPlanId(e.target.value)}
                  >
                    <option value="">Choose a plan</option>
                    {(plans.data?.plans ?? [])
                      .filter((p) => p.id !== sub.planId)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {`${p.title ?? ""}: ${formatPrice(p.price, plans.data?.currency)} a month`}
                        </option>
                      ))}
                  </select>
                  <p className="text-sm">
                    A dearer plan starts now and the rest of this month is charged to your card; a
                    cheaper one starts when this month ends.
                  </p>
                  <div className="flex gap-2">
                    <Button disabled={busy || !planId} onClick={() => void onChange(sub)}>
                      Change plan
                    </Button>
                    <Button variant="outline" onClick={() => setChoosing(null)}>
                      Keep this plan
                    </Button>
                  </div>
                </div>
              ) : null}
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
                ) : ending(sub) || status?.coolOff?.open ? null : (
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
                {status?.offered ? (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void onCoolOff(sub, status)}
                  >
                    Cancel for a full refund
                  </Button>
                ) : status?.coolOff?.askAgain ? (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void onCoolOff(sub, status)}
                  >
                    Ask again to end it for a full refund
                  </Button>
                ) : null}
                {canChangePlan(sub) && !status?.coolOff?.open && choosing !== sub.id ? (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setPlanId("");
                      setChoosing(sub.id);
                    }}
                  >
                    Change plan
                  </Button>
                ) : null}
                <Button variant="outline" disabled={busy} onClick={() => void onPortal()}>
                  Card and invoices
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
      {said ? <p role="status">{said}</p> : null}
      {problem ? <p role="alert">{problem}</p> : null}
    </section>
  );
}
