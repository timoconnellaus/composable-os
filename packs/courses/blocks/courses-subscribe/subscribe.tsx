// Subscribing to every course on a studio's site (stage 32a): the course plans with the host's
// price per month and trial days, and a button that opens the payment provider's page. The price
// is the host's (`usePlans`); whether the trial is given, and the page, are the host's
// (`useSubscribe`, `subscription.start`): one trial per person, signed in. Web only.
import type { CoursesHooks, StartedSubscription } from "@composable-os/pack-courses/client";
import { formatPrice, PLAN } from "@composable-os/pack-courses/client";
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
}: {
  courses: Pick<CoursesHooks, "usePlans" | "useSubscribe">;
  /** Where the provider's page sends the subscriber back to (one of the host's listed origins). */
  returnUrl: string;
  /** A signed-in customer subscribes as themselves; a guest gives their email. */
  signedIn: boolean;
  /** Where a guest signs in: only a signed-in customer gets the free trial. */
  signInUrl?: string;
}) {
  const { data, isPending, error } = courses.usePlans();
  const subscribe = courses.useSubscribe();
  const [email, setEmail] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  if (isPending) return <p aria-busy="true">Loading the plans…</p>;
  if (error || !data) return <p role="alert">We could not load the plans.</p>;
  if (!data.plans.length) return <p>No plans are offered yet.</p>;

  async function onSubscribe(planId: string) {
    setProblem(null);
    try {
      const started: StartedSubscription = await subscribe.mutateAsync({
        plan: { object: PLAN, id: planId },
        returnUrl,
        ...(signedIn ? {} : { email }),
      });
      window.location.assign(started.url);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "We could not start your subscription");
    }
  }

  return (
    <section className="grid gap-4" aria-label="Subscribe">
      {data.plans.map((plan) => {
        const trial = plan.trialDays && plan.trialDays > 0 ? plan.trialDays : null;
        return (
          <Card key={plan.id}>
            <CardHeader>
              <CardTitle>{plan.title}</CardTitle>
              <CardDescription>
                {`${formatPrice(plan.price, data.currency)} a month · every course`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {plan.description ? <p>{plan.description}</p> : null}
              <form
                className="grid max-w-sm gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void onSubscribe(plan.id);
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
                  {signedIn && trial ? `Start your ${trial}-day free trial` : "Subscribe"}
                </Button>
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
