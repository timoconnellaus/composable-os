// A member's memberships and passes on the gym's site (stage 32b), and their section of My account
// (stage 48): what each allows, when it stops or expires, and what is left this week, this month
// or in all, from the host's count (`x.memberships.mine`, `allowance.get`); a child's the gym
// linked to them too (decision 8: a parent sees a child's memberships and passes), each under the
// child's name; and their membership subscriptions, through My account's one subscriptions part
// (`web-account-subscriptions`): cancel at the period's end, keep it going, confirm a payment
// that waits on them, and here a change of plan (the host decides: an upgrade now, its prorated
// charge on the card, or a downgrade from the next period). The card is My account's Payment
// method section, once for every subscription: this block has no card button.
// While the host says a new member may cool off (stage 44 step 7, ADR 0647), "Cancel for a full
// refund" sits beside the ordinary cancel, with the last day of the period; the window is never
// worked out here. A membership ended that way stays shown, with where its refund is.
// Every action is the host's operation, on their own subscription only. Web only: the app shows
// the same and does nothing to it.
import type {
  CoolingOffStatus,
  Holding,
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
import { MySubscriptions } from "../web-account-subscriptions/subscriptions.tsx";

type Hooks = Pick<
  MembershipsHooks,
  | "useMine"
  | "useMySubscriptions"
  | "useCancelSubscription"
  | "useResumeSubscription"
  | "usePlans"
  | "useChangePlan"
  | "useCoolingOff"
  | "useCoolOff"
> &
  Partial<Pick<MembershipsHooks, "useFamily">>;

export function MyMemberships({
  memberships,
}: {
  memberships: Hooks;
  /** Kept for a page that still passes it: the card is My account's Payment method section. */
  returnUrl?: string;
}) {
  const mine = memberships.useMine();
  const subs = memberships.useMySubscriptions();
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
  // One ended in its cooling-off period stays shown, with where its refund is.
  const cooledOff = all.filter(
    (sub) => !isLive(sub) && statusOf(sub.id)?.coolOff?.state === "ended",
  );
  const busy = change.isPending || coolOff.isPending;

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

  /** The membership's own lines: a cooling off, a plan change waiting, the change of plan chooser. */
  const about = (sub: MembershipSubscription) => {
    const status = statusOf(sub.id);
    const cooling =
      coolingOffWords(status) ?? coolOffProgressWords(status) ?? coolingOffClosedWords(status);
    return (
      <>
        {cooling ? <p data-testid="cooling-off">{cooling}</p> : null}
        {changeWords(sub) ? <p data-testid="subscription-change">{changeWords(sub)}</p> : null}
        {sub.change?.actionUrl && sub.change.state === "requested" ? (
          <div>
            <Button onClick={() => window.location.assign(sub.change?.actionUrl ?? "")}>
              Confirm the new plan's payment
            </Button>
          </div>
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
              A dearer plan starts now and the rest of this month is charged to your card; a cheaper
              one starts when this month ends.
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
      </>
    );
  };

  /** The membership's own buttons: cooling off and the change of plan. */
  const buttons = (sub: MembershipSubscription) => {
    const status = statusOf(sub.id);
    return (
      <>
        {status?.offered ? (
          <Button variant="outline" disabled={busy} onClick={() => void onCoolOff(sub, status)}>
            Cancel for a full refund
          </Button>
        ) : status?.coolOff?.askAgain ? (
          <Button variant="outline" disabled={busy} onClick={() => void onCoolOff(sub, status)}>
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
      </>
    );
  };

  return (
    <section className="grid gap-4" aria-label="My memberships">
      {mine.data.holdings.length ? null : <p>You have no membership or pass yet.</p>}
      <Holdings holdings={mine.data.holdings} />
      <MySubscriptions
        account={{
          useSubscriptions: memberships.useMySubscriptions,
          useCancelSubscription: memberships.useCancelSubscription,
          useResumeSubscription: memberships.useResumeSubscription,
        }}
        label="Your membership's billing"
        empty={null}
        status={subscriptionStatus}
        about={about}
        change={buttons}
        // While a cooling off is under way, it ends the membership: no ordinary cancel beside it.
        cancellable={(sub) => !statusOf(sub.id)?.coolOff?.open}
        words={{
          cancel: "Cancel membership",
          resume: "Keep my membership",
          confirmCancel: "Cancel? Your membership runs until the period ends.",
          description: () => "Your membership's billing",
        }}
      />
      {cooledOff.map((sub) => (
        <Card key={sub.id} data-kind="cooled-off">
          <CardHeader>
            <CardTitle>{sub.planTitle}</CardTitle>
            <CardDescription>Your membership's billing</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <p data-testid="subscription-status">{`Ended${sub.endedAt ? ` on ${day(sub.endedAt)}` : ""}`}</p>
            <p data-testid="cooling-off">{coolOffProgressWords(statusOf(sub.id))}</p>
          </CardContent>
        </Card>
      ))}
      {memberships.useFamily ? (
        <Children
          memberships={{ useFamily: memberships.useFamily, useMine: memberships.useMine }}
        />
      ) : null}
      {said ? <p role="status">{said}</p> : null}
      {problem ? <p role="alert">{problem}</p> : null}
    </section>
  );
}

function Holdings({ holdings }: { holdings: readonly Holding[] }) {
  return holdings.map((h) => (
    <Card key={h.id} data-kind={h.kind}>
      <CardHeader>
        <CardTitle>{h.title}</CardTitle>
        <CardDescription>{allowsWords(h)}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-1">
        <p data-testid="holding-left">{leftWords(h)}</p>
        {h.until ? (
          <p className="text-sm">{`${h.kind === "pass" ? "Expires" : "Until"} ${day(h.until)}`}</p>
        ) : null}
      </CardContent>
    </Card>
  ));
}

/** Each child the gym linked to the member, with their memberships and passes, under their name. */
function Children({
  memberships,
}: {
  memberships: Pick<MembershipsHooks, "useFamily" | "useMine">;
}) {
  const family = memberships.useFamily();
  const children = family.data?.dependants ?? [];
  return children.map((child) => (
    <Child key={child.personId} child={child} memberships={memberships} />
  ));
}

function Child({
  child,
  memberships,
}: {
  child: { personId: string; name: string };
  memberships: Pick<MembershipsHooks, "useMine">;
}) {
  const theirs = memberships.useMine(child.personId);
  // A child with nothing here, or whose records the host does not show a guardian, shows nothing.
  if (!theirs.data?.holdings.length) return null;
  return (
    <section
      className="grid gap-3"
      aria-label={`${child.name}'s memberships and passes`}
      data-person={child.personId}
    >
      <h3 className="font-medium">{`${child.name}'s memberships and passes`}</h3>
      <Holdings holdings={theirs.data.holdings} />
    </section>
  );
}
