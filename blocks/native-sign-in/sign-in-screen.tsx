// Sign-in with a code by email, for the mobile app. The host sends the code and makes the session;
// this screen only asks for the address and the code and calls what it is given.
import { useState } from "react";
import { Text } from "react-native";
import { Button } from "../native-base/button.tsx";
import { Field } from "../native-base/field.tsx";
import { Screen } from "../native-base/screen.tsx";

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
    try {
      if (!sent) {
        if (await actions.requestCode(email)) setSent(true);
        else setError("We could not send a code. Try again in a moment.");
      } else if (await actions.signIn(email, code)) onSignedIn();
      else setError("That code did not work. Check it, or ask for a new one.");
    } finally {
      setBusy(false);
    }
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
        <Text accessibilityRole="alert">{error}</Text>
      ) : null}
      <Button label={sent ? "Sign in" : "Email me a code"} busy={busy} onPress={submit} />
    </Screen>
  );
}
