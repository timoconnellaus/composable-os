// Changing the sign-in address (stage 48), for the web: the signed-in customer asks with the new
// address, the host emails a code to it, they enter the code here, and from then on they sign in
// with the new address. Everything is the host's (me.email.change, me.email.confirm, ADR 0712):
// the code goes only to the new address, the old one is told by the host, the answer to the
// request is the same whatever the address, and only once the code is entered does the host say
// an address is already in use at the business. This block says no more than the host's answers.
//
// The host keeps it to a sign-in within the last 15 minutes. When it says `sign_in_again`, the
// block signs the customer in again in place (`SignInAgain`, a code to the address they sign in
// with now, through the app's own sign-in: `signIn`), keeps the new address they typed, and asks
// again. Nothing they typed is logged, put in the address bar or kept in the browser.
import {
  type AccountHooks,
  type AccountSignIn,
  codeInput,
  emailChangeErrorWords,
  emailChangeProblem,
  SIGN_IN_AGAIN_WORDS,
  sensitive,
} from "@composable-os/client";
import { type FormEvent, useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Input } from "../ui-input/input.tsx";
import { Label } from "../ui-label/label.tsx";

type Hooks = Pick<AccountHooks, "useMe" | "useChangeEmail" | "useConfirmEmail">;

type Step =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "sign_in_again"; resume: "ask" }
  | { kind: "sign_in_again"; resume: "confirm"; waiting: { newEmail: string; expiresAt: string } }
  | { kind: "code"; newEmail: string; expiresAt: string }
  | { kind: "done"; signInEmail: string };

export function ChangeSignInAddress({
  account,
  signIn,
}: {
  account: Hooks;
  /** Signs the customer in again in place, when the host asks for a fresh sign-in. */
  signIn: AccountSignIn;
}) {
  const me = account.useMe();
  const change = account.useChangeEmail();
  const confirm = account.useConfirmEmail();
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  if (!me.data) return null;
  const current = me.data.signInEmail;

  async function ask() {
    setProblem(null);
    const found = emailChangeProblem(email, current);
    if (found) {
      setProblem(found);
      return;
    }
    const outcome = await sensitive(() => change.mutateAsync({ email: email.trim() }));
    if (outcome.kind === "sign_in_again") setStep({ kind: "sign_in_again", resume: "ask" });
    else if (outcome.kind === "failed") setProblem(emailChangeErrorWords(outcome.error));
    else {
      setCode("");
      setStep({ kind: "code", ...outcome.value });
    }
  }

  async function enter(waiting: { newEmail: string; expiresAt: string }) {
    setProblem(null);
    const outcome = await sensitive(() => confirm.mutateAsync({ code: codeInput(code) }));
    if (outcome.kind === "sign_in_again") {
      // The code keeps working meanwhile (ADR 0712): it is entered again after the sign-in.
      setStep({ kind: "sign_in_again", resume: "confirm", waiting });
      return;
    }
    if (outcome.kind === "failed") {
      setProblem(emailChangeErrorWords(outcome.error));
      return;
    }
    setEmail("");
    setCode("");
    setStep({ kind: "done", signInEmail: outcome.value.signInEmail });
    me.refetch?.();
  }

  if (step.kind === "sign_in_again") {
    return (
      <SignInAgain
        email={current}
        signIn={signIn}
        onCancel={() => setStep({ kind: "idle" })}
        onSignedIn={() => {
          // Back to what they were doing: the request asked again, or the code still to enter.
          if (step.resume === "ask") {
            setStep({ kind: "asking" });
            void ask();
          } else {
            setStep({ kind: "code", ...step.waiting });
            void enter(step.waiting);
          }
        }}
      />
    );
  }

  if (step.kind === "done") {
    return (
      <p role="status" data-testid="sign-in-email-changed">
        {`Done. You now sign in with ${step.signInEmail}. Your other sign-ins were signed out, and your old address was told.`}
      </p>
    );
  }

  if (step.kind === "code") {
    return (
      <form
        className="grid gap-3"
        aria-label="Enter the code"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void enter(step);
        }}
      >
        <p className="text-sm">
          {`We emailed a code to ${step.newEmail}. Enter it here within 15 minutes. Until you do, you still sign in with ${current}.`}
        </p>
        <div className="grid gap-1">
          <Label htmlFor="account-email-code">The code we emailed to the new address</Label>
          <Input
            id="account-email-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={confirm.isPending || !code.trim()}>
            Change my sign-in address
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setProblem(null);
              setStep({ kind: "asking" });
            }}
          >
            Use another address
          </Button>
        </div>
        {problem ? <p role="alert">{problem}</p> : null}
      </form>
    );
  }

  if (step.kind === "idle") {
    return (
      <div>
        <Button type="button" variant="outline" onClick={() => setStep({ kind: "asking" })}>
          Change sign-in address
        </Button>
      </div>
    );
  }

  return (
    <form
      className="grid gap-3"
      aria-label="Change sign-in address"
      noValidate
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void ask();
      }}
    >
      <div className="grid gap-1">
        <Label htmlFor="account-new-email">New sign-in address</Label>
        <Input
          id="account-new-email"
          type="email"
          autoComplete="email"
          value={email}
          aria-invalid={problem ? true : undefined}
          onChange={(e) => setEmail(e.target.value)}
        />
        <span className="text-muted-foreground text-sm">
          We email a code to it. Your address changes only once you enter the code.
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={change.isPending}>
          Email me a code
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setProblem(null);
            setEmail("");
            setStep({ kind: "idle" });
          }}
        >
          Keep my address
        </Button>
      </div>
      {problem ? <p role="alert">{problem}</p> : null}
    </form>
  );
}

/**
 * Signing in again in place, when the host asks for a recent sign-in (`sign_in_again`): a code to
 * the address the customer signs in with now, entered here, through the app's own sign-in. Then
 * `onSignedIn`, and the block carries on with what they were doing.
 */
export function SignInAgain({
  email,
  signIn,
  onSignedIn,
  onCancel,
}: {
  /** The customer's own sign-in address (`me.get`). */
  email: string;
  signIn: AccountSignIn;
  onSignedIn: () => void;
  onCancel: () => void;
}) {
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setBusy(true);
    try {
      if (!sent) {
        if (await signIn.requestCode(email)) setSent(true);
        else setProblem("We could not send a code just now. Try again in a moment.");
      } else if (await signIn.confirm(email, codeInput(code))) {
        onSignedIn();
      } else {
        setProblem("That code did not work. Check it, or ask for a new one.");
      }
    } catch {
      setProblem("We could not sign you in just now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="grid gap-3" aria-label="Sign in again" noValidate onSubmit={submit}>
      <p className="text-sm" data-testid="sign-in-again">
        {SIGN_IN_AGAIN_WORDS}
      </p>
      {sent ? (
        <div className="grid gap-1">
          <Label htmlFor="account-sign-in-again-code">{`The code we emailed to ${email}`}</Label>
          <Input
            id="account-sign-in-again-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy || (sent && !code.trim())}>
          {sent ? "Sign in and carry on" : "Email me a code"}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Not now
        </Button>
      </div>
      {problem ? <p role="alert">{problem}</p> : null}
    </form>
  );
}
