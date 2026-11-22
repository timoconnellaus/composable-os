// Subscribing to every course on a studio's site (stage 32a): the course plans with the host's
// price per month and trial days, and a button that opens the payment provider's page. The price
// is the host's (`usePlans`); whether the trial is given, and the page, are the host's
// (`useSubscribe`, `subscription.start`): one trial per person, signed in. Web only.
//
// A guest who wants the trial confirms their address with a code here, on the plan, when the app
// passes `signIn` (the same two calls as the web sign-in block), and goes on to the provider's
// page signed in, with the trial (ADR 0459). Whether a new address gets a code is the host's:
// with "anyone starting a subscription" on and a plan on sale, it does.
//
// A signed-in member moving from another platform sees their continuation offer in place of the
// trial ("continue, free until <date>", `useMyOffers`); taking it is the host's too (`offerId`):
// only its own person can (ADR 0491). A guest who confirms a code and turns out to have an offer
// is shown the offer, never sent on to the trial.
import type {
  ContinuationOffer,
  CoursesHooks,
  StartedSubscription,
} from "@composable-os/pack-courses/client";
import {
  day,
  formatPrice,
  noTrialWords,
  offerFor,
  offerWords,
  PLAN,
} from "@composable-os/pack-courses/client";
import { type FormEvent, useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui-card/card.tsx";
import { Input } from "../ui-input/input.tsx";
import { Label } from "../ui-label/label.tsx";

/**
 * Signing a guest in by an emailed code, as the app does it (the web sign-in block's two calls:
 * the template's `/auth/code` and `/auth/sign-in`). `requestCode` says whether the host took the
 * request (it answers every address the same). `confirm` gives the `account` the host's sign-in
 * answer carries: `ready`, or `needs_attention` while staff sort out the person's record (the
 * session is then not yet a customer's); null when the code was refused.
 */
export interface SubscribeSignIn {
  requestCode: (email: string) => Promise<boolean>;
  confirm: (email: string, code: string) => Promise<"ready" | "needs_attention" | null>;
}

export function Subscribe({
  courses,
  returnUrl,
  signedIn,
  signInUrl,
  onSignInForTrial,
  signIn,
}: {
  courses: Pick<CoursesHooks, "usePlans" | "useSubscribe" | "useMyOffers">;
  /** Where the provider's page sends the subscriber back to (one of the host's listed origins). */
  returnUrl: string;
  /** A signed-in customer subscribes as themselves; a guest gives their email. */
  signedIn: boolean;
  /** Where a guest signs in: only a signed-in customer gets the free trial, or their offer. */
  signInUrl?: string;
  /** Instead of `signInUrl`: what the app does to sign a guest in for the trial, for that plan. */
  onSignInForTrial?: (planId: string) => void;
  /**
   * Preferred: a guest confirms their address with a code right here, then goes on to the
   * provider's page signed in, with the trial.
   */
  signIn?: SubscribeSignIn;
}) {
  const { data, isPending, error } = courses.usePlans();
  const subscribe = courses.useSubscribe();
  const [email, setEmail] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  // The host gave no trial on a plan that has one: say why before the provider's page asks for
  // the first payment, so nobody is charged by surprise.
  const [noTrial, setNoTrial] = useState<{ planId: string; started: StartedSubscription } | null>(
    null,
  );
  // Signed in here, by a code (`signIn`): subscribe as the customer from now on.
  const [confirmed, setConfirmed] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  // Confirmed, but the account waits for staff to merge people: subscribe as a guest meanwhile.
  const [waiting, setWaiting] = useState(false);
  const asCustomer = signedIn || confirmed;
  // Only a signed-in customer has offers; a guest's call would be refused, so it is not made.
  const offers = courses.useMyOffers({ enabled: asCustomer });
  if (isPending || (asCustomer && offers.isPending)) {
    return <p aria-busy="true">Loading the plans…</p>;
  }
  if (error || !data) return <p role="alert">We could not load the plans.</p>;
  if (!data.plans.length) return <p>No plans are offered yet.</p>;
  // Only offers on the course plan object matter here (another pack's plans are its own).
  const onPlans = (list: readonly ContinuationOffer[] | undefined) =>
    (list ?? []).filter((o) => o.planObject === PLAN);
  const mine = asCustomer ? onPlans(offers.data?.offers) : [];
  const continuing = mine.length > 0;
  const askUs = mine.filter((o) => o.askUs);

  async function onSubscribe(
    planId: string,
    hasTrial: boolean,
    customer = asCustomer,
    offer?: ContinuationOffer,
    owed = continuing,
  ) {
    setProblem(null);
    setNoTrial(null);
    try {
      const started: StartedSubscription = await subscribe.mutateAsync({
        plan: { object: PLAN, id: planId },
        returnUrl,
        ...(customer ? {} : { email }),
        ...(offer ? { offerId: offer.id } : {}),
      });
      // Never sent to a page that charges today without a word: the host's reason for no trial,
      // or, for a member with free time owed on another plan, that this one is paid from today.
      if (!offer && (owed || (hasTrial && started.noTrial))) {
        setNoTrial({ planId, started: { ...started, noTrial: started.noTrial ?? "continuation" } });
      } else window.location.assign(started.url);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "We could not start your subscription");
    }
  }

  /** The code step on the plan: ask for a code, then confirm it and start signed in. */
  async function onCode(event: FormEvent, planId: string) {
    event.preventDefault();
    if (!signIn) return;
    setBusy(true);
    setProblem(null);
    try {
      if (!codeSent) {
        if (await signIn.requestCode(email)) setCodeSent(true);
        else setProblem("We could not send a code. Try again in a moment.");
      } else {
        const account = await signIn.confirm(email, code);
        if (account === "ready") {
          setConfirmed(true);
          // Signed in now: if they have a continuation offer, they see it in place of the trial
          // (the plans again), never a trial page opened over it.
          const fresh = onPlans((await offers.refetch()).data?.offers);
          if (fresh.length) {
            setNoTrial(null);
            setCodeSent(false);
            setCode("");
            return;
          }
          // Back to the same plan, now as the customer: the host gives the trial or says why not.
          await onSubscribe(planId, true, true, undefined, false);
        } else if (account === "needs_attention") {
          // Signed in, but not yet as a customer: staff are told (the host's merge notice). Back
          // to the plans, where they can subscribe as a guest and pay from today.
          setWaiting(true);
          setCodeSent(false);
          setCode("");
          setNoTrial(null);
        } else {
          setProblem("That code did not work. Check it, or ask for a new one.");
        }
      }
    } finally {
      setBusy(false);
    }
  }

  /** A new code, after a wrong or expired one, without leaving the plan. */
  async function onNewCode() {
    if (!signIn) return;
    setBusy(true);
    setProblem(null);
    setCode("");
    try {
      if (!(await signIn.requestCode(email))) {
        setProblem("We could not send a code. Try again in a moment.");
      }
    } finally {
      setBusy(false);
    }
  }

  if (noTrial?.started.noTrial) {
    const { planId, started } = noTrial;
    const reason = started.noTrial;
    return (
      <section className="grid max-w-sm gap-3" aria-label="Subscribe" data-no-trial={reason}>
        <p role="status">{noTrialWords(reason)}</p>
        {reason === "sign_in" && signIn ? (
          <form className="grid gap-2" onSubmit={(e) => void onCode(e, planId)}>
            {codeSent ? (
              <>
                <p className="text-sm">
                  {`If ${email} can sign in here, we have emailed it a code.`}
                </p>
                <Label htmlFor="subscriber-code">The code we emailed you</Label>
                <Input
                  id="subscriber-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </>
            ) : null}
            <Button type="submit" disabled={busy || subscribe.isPending}>
              {codeSent ? "Confirm and start my free trial" : "Email me a code for the free trial"}
            </Button>
            {codeSent ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void onNewCode()}
              >
                Send me a new code
              </Button>
            ) : null}
            {problem ? <p role="alert">{problem}</p> : null}
          </form>
        ) : reason === "sign_in" && (onSignInForTrial || signInUrl) ? (
          <Button
            onClick={() =>
              onSignInForTrial ? onSignInForTrial(planId) : window.location.assign(signInUrl ?? "")
            }
          >
            Sign in for the free trial
          </Button>
        ) : null}
        <Button variant="outline" onClick={() => window.location.assign(started.url)}>
          Continue and pay from today
        </Button>
      </section>
    );
  }

  return (
    <section className="grid gap-4" aria-label="Subscribe">
      {waiting ? (
        <p role="status">
          Your address is confirmed, but we need to sort out your record before you can have the
          free trial, and we have told the team. You can subscribe now and pay from today.
        </p>
      ) : null}
      {askUs.map((o) => (
        <p key={o.id} role="status" data-testid="continuation-offer">
          {offerWords(o)}
        </p>
      ))}
      {data.plans.map((plan) => {
        const found = offerFor(mine, plan.id);
        const offer = found && !found.askUs ? found : undefined;
        // A continuation replaces the trial (owner decision 7): a member with an open offer on the
        // course plan object is shown no trial on its plans (the host gives none then).
        const trial = !continuing && plan.trialDays && plan.trialDays > 0 ? plan.trialDays : null;
        return (
          <Card key={plan.id} data-offer={offer ? offer.id : undefined}>
            <CardHeader>
              <CardTitle>{plan.title}</CardTitle>
              <CardDescription>
                {`${formatPrice(plan.price, data.currency)} a month · every course`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {plan.description ? <p>{plan.description}</p> : null}
              {offer ? <p data-testid="continuation-offer">{offerWords(offer)}</p> : null}
              <form
                className="grid max-w-sm gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  // While the record waits for staff, no trial can be given: straight to paying.
                  void onSubscribe(plan.id, trial !== null && !waiting, asCustomer, offer);
                }}
              >
                {asCustomer ? null : (
                  <>
                    {trial && !waiting ? (
                      <p>
                        {signInUrl ? (
                          <a href={signInUrl} className="underline">
                            {`Sign in for your ${trial}-day free trial`}
                          </a>
                        ) : (
                          `Sign in for your ${trial}-day free trial`
                        )}
                        , or subscribe now and pay from today.
                      </p>
                    ) : null}
                    <Label htmlFor={`subscriber-email-${plan.id}`}>Your email</Label>
                    <Input
                      id={`subscriber-email-${plan.id}`}
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </>
                )}
                <Button type="submit" disabled={subscribe.isPending}>
                  {offer
                    ? offer.chargedNow
                      ? "Continue my subscription"
                      : `Continue, free until ${day(offer.freeUntil)}`
                    : asCustomer && trial
                      ? `Start your ${trial}-day free trial`
                      : "Subscribe"}
                </Button>
                {offer && !offer.chargedNow ? (
                  <p className="text-sm">
                    {`Your card is taken now and first charged on ${day(offer.freeUntil)}, unless you cancel.`}
                  </p>
                ) : null}
                {asCustomer && trial ? (
                  <p className="text-sm">
                    Your card is taken now and charged when the trial ends, unless you cancel. One
                    free trial per person.
                  </p>
                ) : null}
              </form>
            </CardContent>
          </Card>
        );
      })}
      {problem ? <p role="alert">{problem}</p> : null}
    </section>
  );
}
