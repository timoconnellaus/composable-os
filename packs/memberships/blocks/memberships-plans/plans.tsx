// Joining a gym on its site (stage 32b): the membership plans on sale with the host's price per
// month, what each allows and its trial, and a button that opens the payment provider's page. The
// price is the host's (`usePlans`); whether the trial is given, and the page, are the host's
// (`useSubscribe`, `subscription.start`): one trial per person per plan object, signed in. The
// membership itself is granted by the host once the provider confirms the subscription. Web only.
//
// A guest who wants the trial confirms their address with a code here, on the plan, when the app
// passes `signIn` (the web sign-in block's two calls), and goes on to the provider's page signed
// in, with the trial (ADR 0459). Whether a new address gets a code is the host's.
import type {
  MembershipsHooks,
  NoTrial,
  StartedSubscription,
} from "@composable-os/pack-memberships/client";
import { allowsWords, formatPrice, PLAN } from "@composable-os/pack-memberships/client";
import { type FormEvent, useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui-card/card.tsx";
import { Input } from "../ui-input/input.tsx";
import { Label } from "../ui-label/label.tsx";

/** Signing a guest in by an emailed code, as the app does it (the web sign-in block's calls). */
export interface PlansSignIn {
  requestCode: (email: string) => Promise<boolean>;
  confirm: (email: string, code: string) => Promise<"ready" | "needs_attention" | null>;
}

/** Why the host gave no trial, in words. Display only. */
function noTrialWords(reason: NoTrial): string {
  switch (reason) {
    case "sign_in":
      return "The free trial is for signed-in members. Sign in for it, or continue and pay from today.";
    case "used":
      return "You have had your free trial, so this membership is paid from today.";
    case "held":
      return "A checkout with your free trial is already open. Finish that one, or continue and pay from today.";
    case "unconfirmed":
      return "We could not check your earlier checkout with the payment provider just now, so no free trial can be given yet. Try again in a few minutes, or continue and pay from today.";
    case "permission":
      return "A free trial cannot be given from here; this one is paid from today.";
    case "continuation":
      return "You have free time with us on a continuing membership: this one is paid from today.";
  }
}

export function Plans({
  memberships,
  returnUrl,
  signedIn,
  signIn,
}: {
  memberships: Pick<MembershipsHooks, "usePlans" | "useSubscribe">;
  /** Where the provider's page sends the member back to (one of the host's listed origins). */
  returnUrl: string;
  /** A signed-in customer subscribes as themselves; a guest gives their email. */
  signedIn: boolean;
  /** A guest confirms their address with a code here for the trial. */
  signIn?: PlansSignIn;
}) {
  const { data, isPending, error } = memberships.usePlans();
  const subscribe = memberships.useSubscribe();
  const [email, setEmail] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [noTrial, setNoTrial] = useState<{ planId: string; started: StartedSubscription } | null>(
    null,
  );
  const [confirmed, setConfirmed] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const asCustomer = signedIn || confirmed;
  if (isPending) return <p aria-busy="true">Loading the memberships…</p>;
  if (error || !data) return <p role="alert">We could not load the memberships.</p>;
  if (!data.plans.length) return <p>No memberships are on sale yet.</p>;

  async function onSubscribe(planId: string, hasTrial: boolean, customer = asCustomer) {
    setProblem(null);
    setNoTrial(null);
    try {
      const started = await subscribe.mutateAsync({
        plan: { object: PLAN, id: planId },
        returnUrl,
        ...(customer ? {} : { email }),
      });
      // Never sent to a page that charges today without a word: the host's reason for no trial.
      if (hasTrial && started.noTrial) setNoTrial({ planId, started });
      else window.location.assign(started.url);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "We could not start your membership");
    }
  }

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
          await onSubscribe(planId, true, true);
        } else if (account === "needs_attention") {
          setProblem(
            "Your address is confirmed, but we need to sort out your record first, and we have told the team. You can join now and pay from today.",
          );
          setCodeSent(false);
          setNoTrial(null);
        } else {
          setProblem("That code did not work. Check it, or ask for a new one.");
        }
      }
    } finally {
      setBusy(false);
    }
  }

  const reason = noTrial?.started.noTrial;
  if (noTrial && reason) {
    const { planId, started } = noTrial;
    return (
      <section className="grid max-w-sm gap-3" aria-label="Memberships" data-no-trial={reason}>
        <p role="status">{noTrialWords(reason)}</p>
        {reason === "sign_in" && signIn ? (
          <form className="grid gap-2" onSubmit={(e) => void onCode(e, planId)}>
            {codeSent ? (
              <>
                <p className="text-sm">{`If ${email} can sign in here, we have emailed it a code.`}</p>
                <Label htmlFor="member-code">The code we emailed you</Label>
                <Input
                  id="member-code"
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
            {problem ? <p role="alert">{problem}</p> : null}
          </form>
        ) : null}
        <Button variant="outline" onClick={() => window.location.assign(started.url)}>
          Continue and pay from today
        </Button>
      </section>
    );
  }

  return (
    <section className="grid gap-4" aria-label="Memberships">
      {data.plans.map((plan) => {
        const trial = plan.trialDays && plan.trialDays > 0 ? plan.trialDays : null;
        return (
          <Card key={plan.id}>
            <CardHeader>
              <CardTitle>{plan.title}</CardTitle>
              <CardDescription>
                {`${formatPrice(plan.price, data.currency)} a month · ${plan.summary ?? allowsWords(plan)}`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {plan.description ? <p>{plan.description}</p> : null}
              <form
                className="grid max-w-sm gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void onSubscribe(plan.id, trial !== null);
                }}
              >
                {asCustomer ? null : (
                  <>
                    {trial ? (
                      <p>{`Sign in for your ${trial}-day free trial, or join now and pay from today.`}</p>
                    ) : null}
                    <Label htmlFor={`member-email-${plan.id}`}>Your email</Label>
                    <Input
                      id={`member-email-${plan.id}`}
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </>
                )}
                <Button type="submit" disabled={subscribe.isPending}>
                  {asCustomer && trial ? `Start your ${trial}-day free trial` : "Join"}
                </Button>
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
