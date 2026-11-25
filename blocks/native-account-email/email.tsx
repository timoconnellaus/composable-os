// Changing the sign-in address (stage 48), for the mobile app: the same flow as the web's
// (`web-account-email`), in the app (ADR 0714: it is not money, so it works here). The signed-in
// customer asks with the new address, the host emails a code to it, they enter it, and from then
// on they sign in with the new address. Everything is the host's (me.email.change,
// me.email.confirm, ADR 0712): the code goes only to the new address, the old one is told by the
// host, the request answers the same whatever the address, and only once the code is entered does
// the host say an address is already in use.
//
// When the host says `sign_in_again` (a sign-in more than 15 minutes ago), the block signs the
// customer in again in place (`SignInAgain`, through the app's session: `signIn`), keeps what they
// typed, and carries on. Nothing they typed is logged or stored on the device.
import {
  type AccountHooks,
  type AccountSignIn,
  codeInput,
  emailChangeErrorWords,
  emailChangeProblem,
  SIGN_IN_AGAIN_WORDS,
  sensitive,
} from "@composable-os/client";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { Field } from "../native-base/field.tsx";
import { theme } from "../native-base/theme.ts";

type Hooks = Pick<AccountHooks, "useMe" | "useChangeEmail" | "useConfirmEmail">;
type Waiting = { newEmail: string; expiresAt: string };

type Step =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "sign_in_again"; resume: "ask" }
  | { kind: "sign_in_again"; resume: "confirm"; waiting: Waiting }
  | ({ kind: "code" } & Waiting)
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

  async function enter(waiting: Waiting) {
    setProblem(null);
    const outcome = await sensitive(() => confirm.mutateAsync({ code: codeInput(code) }));
    if (outcome.kind === "sign_in_again") {
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

  const said = problem ? (
    <Text style={styles.problem} accessibilityRole="alert">
      {problem}
    </Text>
  ) : null;

  if (step.kind === "sign_in_again") {
    return (
      <SignInAgain
        email={current}
        signIn={signIn}
        onCancel={() => setStep({ kind: "idle" })}
        onSignedIn={() => {
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
      <Text style={styles.body}>
        {`Done. You now sign in with ${step.signInEmail}. Your other sign-ins were signed out, and your old address was told.`}
      </Text>
    );
  }

  if (step.kind === "code") {
    return (
      <View style={styles.part}>
        <Text style={styles.body}>
          {`We emailed a code to ${step.newEmail}. Enter it here within 15 minutes. Until you do, you still sign in with ${current}.`}
        </Text>
        <Field
          label="The code we emailed to the new address"
          value={code}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          onChangeText={setCode}
        />
        <Button
          label="Change my sign-in address"
          busy={confirm.isPending}
          disabled={!code.trim()}
          onPress={() => void enter(step)}
        />
        <Button
          quiet
          label="Use another address"
          onPress={() => {
            setProblem(null);
            setStep({ kind: "asking" });
          }}
        />
        {said}
      </View>
    );
  }

  if (step.kind === "idle") {
    return (
      <Button quiet label="Change sign-in address" onPress={() => setStep({ kind: "asking" })} />
    );
  }

  return (
    <View style={styles.part}>
      <Field
        label="New sign-in address"
        value={email}
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        error={problem}
        onChangeText={setEmail}
      />
      <Text style={styles.muted}>
        We email a code to it. Your address changes only once you enter the code.
      </Text>
      <Button label="Email me a code" busy={change.isPending} onPress={() => void ask()} />
      <Button
        quiet
        label="Keep my address"
        onPress={() => {
          setProblem(null);
          setEmail("");
          setStep({ kind: "idle" });
        }}
      />
    </View>
  );
}

/**
 * Signing in again in place, when the host asks for a recent sign-in (`sign_in_again`): a code to
 * the address the customer signs in with now, entered here, through the app's session. Then
 * `onSignedIn`, and the block carries on with what they were doing.
 */
export function SignInAgain({
  email,
  signIn,
  onSignedIn,
  onCancel,
}: {
  email: string;
  signIn: AccountSignIn;
  onSignedIn: () => void;
  onCancel: () => void;
}) {
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit() {
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
    <View style={styles.part}>
      <Text style={styles.body}>{SIGN_IN_AGAIN_WORDS}</Text>
      {sent ? (
        <Field
          label={`The code we emailed to ${email}`}
          value={code}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          onChangeText={setCode}
        />
      ) : null}
      <Button
        label={sent ? "Sign in and carry on" : "Email me a code"}
        busy={busy}
        disabled={sent && !code.trim()}
        onPress={() => void submit()}
      />
      <Button quiet label="Not now" onPress={onCancel} />
      {problem ? (
        <Text style={styles.problem} accessibilityRole="alert">
          {problem}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  part: { gap: theme.space.md },
  body: { fontSize: theme.font.body, color: theme.color.text },
  muted: { fontSize: theme.font.small, color: theme.color.muted },
  problem: { fontSize: theme.font.body, color: theme.color.danger },
});
