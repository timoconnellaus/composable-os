// Sign-in with a code by email, for the mobile app. The host sends the code and makes the session;
// this screen only asks for the address and the code and calls what it is given. When a call
// fails (sign-in not switched on, too many tries, offline) it says so in plain words.
import { signInErrorWords } from "@composable-os/client";
import { useState } from "react";
import { Button } from "../native-base/button.tsx";
import { Field } from "../native-base/field.tsx";
import { Screen } from "../native-base/screen.tsx";
import { Text } from "../native-base/text.tsx";

/** What the screen needs from the app's session (the template's src/host.ts has both). */
export interface SignInActions {
  requestCode(email: string): Promise<boolean>;
  signIn(email: string, code: string): Promise<boolean>;
}

export function SignInScreen({
  actions,
  onSignedIn,
}: {
  actions: SignInActions;
  onSignedIn: () => void;
}) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const step = sent ? "sign-in" : "code";
    try {
      if (!sent) {
        if (await actions.requestCode(email)) setSent(true);
        else setError(signInErrorWords(null, step));
      } else if (await actions.signIn(email, code)) onSignedIn();
      else setError("That code did not work. Check it, or ask for a new one.");
    } catch (failure) {
      // Sign-in not switched on, too many tries, offline: say so; the button stays to try again.
      setError(signInErrorWords(failure, step));
    } finally {
      setBusy(false);
    }
  }

  function startAgain() {
    setSent(false);
    setCode("");
    setError(null);
  }

  return (
    <Screen title="Sign in">
      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        editable={!sent}
      />
      {sent ? (
        <Field
          label="The code we emailed you"
          value={code}
          onChangeText={setCode}
          keyboardType="number-pad"
          autoComplete="one-time-code"
          error={error}
        />
      ) : error ? (
        <Text tone="danger" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <Button label={sent ? "Sign in" : "Email me a code"} busy={busy} onPress={submit} />
      {sent ? (
        <Button label="Use another email, or get a new code" quiet onPress={startAgain} />
      ) : null}
    </Screen>
  );
}
