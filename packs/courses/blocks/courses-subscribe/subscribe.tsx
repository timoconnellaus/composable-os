// Subscribing to every course on a studio's site (stage 32a): the course plans with the host's
// price per month and trial days, and a button that opens the payment provider's page. The price
// is the host's (`usePlans`); whether the trial is given, and the page, are the host's
// (`useSubscribe`, `subscription.start`): one trial per person, signed in. A signed-in member
// moving from another platform sees their continuation offer in place of the trial ("continue,
// free until <date>", `useMyOffers`); taking it is the host's too (`offerId`): only its own person
// can. Web only.
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
import { useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui-card/card.tsx";
import { Input } from "../ui-input/input.tsx";
import { Label } from "../ui-label/label.tsx";

export function Subscribe({
  courses,
  returnUrl,
  signedIn,
  signInUrl,
  onSignInForTrial,
}: {
  courses: Pick<CoursesHooks, "usePlans" | "useSubscribe" | "useMyOffers">;
  /** Where the provider's page sends the subscriber back to (one of the host's listed origins). */
  returnUrl: string;
  /** A signed-in customer subscribes as themselves; a guest gives their email. */
  signedIn: boolean;
  /** Where a guest signs in: only a signed-in customer gets the free trial, or their offer. */
  signInUrl?: string;
  /** Instead of `signInUrl`: what the app does to sign a guest in for the trial. */
  onSignInForTrial?: () => void;
}) {
  const { data, isPending, error } = courses.usePlans();
  const subscribe = courses.useSubscribe();
  // Only a signed-in customer has offers; a guest's call would be refused, so it is not made.
  const offers = courses.useMyOffers({ enabled: signedIn });
  const [email, setEmail] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  // The host gave no trial on a plan that has one: say why before the provider's page asks for
  // the first payment, so nobody is charged by surprise.
  const [noTrial, setNoTrial] = useState<StartedSubscription | null>(null);
  if (isPending || (signedIn && offers.isPending)) {
    return <p aria-busy="true">Loading the plans…</p>;
  }
  if (error || !data) return <p role="alert">We could not load the plans.</p>;
  if (!data.plans.length) return <p>No plans are offered yet.</p>;
  // Only offers on the course plan object matter here (another pack's plans are its own).
  const mine: readonly ContinuationOffer[] = ((signedIn && offers.data?.offers) || []).filter(
    (o) => o.planObject === PLAN,
  );
  const continuing = mine.length > 0;
  const askUs = mine.filter((o) => o.askUs);

  async function onSubscribe(planId: string, offer?: ContinuationOffer) {
    setProblem(null);
    setNoTrial(null);
    try {
      const started: StartedSubscription = await subscribe.mutateAsync({
        plan: { object: PLAN, id: planId },
        returnUrl,
        ...(signedIn ? {} : { email }),
        ...(offer ? { offerId: offer.id } : {}),
      });
      // Never sent to a page that charges today without a word: the host's reason, or, for a
      // member with free time owed on another plan, that this one is paid from today.
      if (!offer && (started.noTrial || (continuing && !started.freeUntil))) {
        setNoTrial({ ...started, noTrial: started.noTrial ?? "continuation" });
      } else window.location.assign(started.url);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "We could not start your subscription");
    }
  }

  if (noTrial?.noTrial) {
    return (
      <section
        className="grid max-w-sm gap-3"
        aria-label="Subscribe"
        data-no-trial={noTrial.noTrial}
      >
        <p role="status">{noTrialWords(noTrial.noTrial)}</p>
        {noTrial.noTrial === "sign_in" && (onSignInForTrial || signInUrl) ? (
          // Where a later sign-in setting (confirming a new visitor's address with a code, owner
          // decision 2026-11-22) takes a guest who wants the trial.
          <Button
            onClick={() =>
              onSignInForTrial ? onSignInForTrial() : window.location.assign(signInUrl ?? "")
            }
          >
            Sign in for the free trial
          </Button>
        ) : null}
        <Button variant="outline" onClick={() => window.location.assign(noTrial.url)}>
          Continue and pay from today
        </Button>
      </section>
    );
  }

  return (
    <section className="grid gap-4" aria-label="Subscribe">
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
                  void onSubscribe(plan.id, offer);
                }}
              >
                {signedIn ? null : (
                  <>
                    {trial ? (
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
                    : signedIn && trial
                      ? `Start your ${trial}-day free trial`
                      : "Subscribe"}
                </Button>
                {offer && !offer.chargedNow ? (
                  <p className="text-sm">
                    {`Your card is taken now and first charged on ${day(offer.freeUntil)}, unless you cancel.`}
                  </p>
                ) : null}
                {signedIn && trial ? (
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
