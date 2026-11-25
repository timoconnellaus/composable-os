// Delete my account (stage 48), for the mobile app: the same two steps as the web's
// (`web-account-delete`), in the app (ADR 0714: deleting is not money, so it works here). First
// the host says what deleting will do and the block shows all of it; then, deliberately, they
// type DELETE and confirm, and the host does exactly what it showed (the preview's `expect`). A
// preview that changed meanwhile is shown again. Nothing is deleted by the block's own logic:
// without a preview there is nothing to confirm (`deleteConfirmInput`). The amounts shown are the
// subscriptions that end, as the host gave them; nothing here takes a payment.
//
// When the host says `sign_in_again`, the block signs the customer in again in place and asks
// for the preview again.
//
// Once the host has deleted the account (and ended every session), the block calls `endSession`
// at once (the app's `session.signOut`: it forgets the tokens in the secure store), and the hooks
// forget the app's query cache when made with its `useQueryClient`. What the app must still do,
// in `onDeleted`: go back to its sign-in screen (the device is already signed out).
import {
  type AccountHooks,
  type AccountSignIn,
  accountErrorWords,
  confirmDelete,
  DELETE_WORD,
  type DeletePreview,
  deleteConfirmInput,
  deletedWords,
  deletePreviewWords,
  isDeletePreview,
  isPreviewChanged,
  sensitive,
} from "@composable-os/client";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SignInAgain } from "../native-account-email/email.tsx";
import { Button } from "../native-base/button.tsx";
import { Field } from "../native-base/field.tsx";
import { theme } from "../native-base/theme.ts";

type Hooks = Pick<AccountHooks, "useMe" | "useDeleteAccount">;

type Step =
  | { kind: "idle" }
  | { kind: "sign_in_again" }
  | { kind: "preview"; preview: DeletePreview; changed: boolean }
  | { kind: "done"; words: string };

export function DeleteAccount({
  account,
  signIn,
  endSession,
  onDeleted,
}: {
  account: Hooks;
  /** Signs the customer in again in place, when the host asks for a fresh sign-in. */
  signIn: AccountSignIn;
  /**
   * Ends this device's session and forgets its stored tokens (the mobile app's
   * `session.signOut`): called as soon as the host has deleted the account.
   */
  endSession: () => Promise<unknown>;
  /** The account is deleted and this device's tokens forgotten: back to sign-in. */
  onDeleted: () => void;
}) {
  const me = account.useMe();
  const remove = account.useDeleteAccount();
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function preview(changed = false) {
    setProblem(null);
    setBusy(true);
    const outcome = await sensitive(() => remove.mutateAsync({}));
    setBusy(false);
    if (outcome.kind === "sign_in_again") setStep({ kind: "sign_in_again" });
    else if (outcome.kind === "failed") setProblem(accountErrorWords(outcome.error));
    else if (isDeletePreview(outcome.value)) {
      setTyped("");
      setStep({ kind: "preview", preview: outcome.value, changed });
    }
  }

  async function confirm(shown: DeletePreview) {
    setProblem(null);
    const input = deleteConfirmInput(shown, typed);
    if (!input) {
      setProblem(`Type ${DELETE_WORD} to confirm`);
      return;
    }
    setBusy(true);
    // The host ended every session; this device forgets its own tokens at once (`endSession`),
    // so a relaunch before "Leave" is pressed finds no session.
    const outcome = await confirmDelete(() => remove.mutateAsync(input), endSession);
    setBusy(false);
    if (outcome.kind === "sign_in_again") setStep({ kind: "sign_in_again" });
    else if (outcome.kind === "failed") {
      if (isPreviewChanged(outcome.error)) void preview(true);
      else setProblem(accountErrorWords(outcome.error));
    } else if (!isDeletePreview(outcome.value)) {
      setStep({ kind: "done", words: deletedWords(outcome.value) });
    }
  }

  const said = problem ? (
    <Text style={styles.problem} accessibilityRole="alert">
      {problem}
    </Text>
  ) : null;

  // Deleted: said first, as the account's own reads now find nobody.
  if (step.kind === "done") {
    return (
      <View style={styles.part}>
        <Text style={styles.body}>{step.words}</Text>
        <Button label="Leave" onPress={onDeleted} />
      </View>
    );
  }

  if (!me.data) return null;
  const email = me.data.signInEmail;

  if (step.kind === "sign_in_again") {
    return (
      <SignInAgain
        email={email}
        signIn={signIn}
        onCancel={() => setStep({ kind: "idle" })}
        onSignedIn={() => void preview()}
      />
    );
  }

  if (step.kind === "idle") {
    return (
      <View style={styles.part}>
        <Text style={styles.body}>
          Deleting your account signs you out everywhere and asks the business to erase your
          personal data. First we show you exactly what it will do; nothing happens until you
          confirm.
        </Text>
        <Button
          quiet
          label="See what deleting my account does"
          busy={busy}
          onPress={() => void preview()}
        />
        {said}
      </View>
    );
  }

  const shown = step.preview;
  const words = deletePreviewWords(shown);
  return (
    <View style={styles.part}>
      {step.changed ? (
        <Text style={styles.problem}>
          Something changed since you looked: read it again before you confirm.
        </Text>
      ) : null}
      <Text style={styles.heading}>What deleting your account does</Text>
      {words.ends.length ? (
        words.ends.map((line) => (
          <Text key={line} style={styles.body}>
            {`• ${line}`}
          </Text>
        ))
      ) : (
        <Text style={styles.body}>You pay no subscription: nothing is ended.</Text>
      )}
      {words.cancelled.map((line) => (
        <Text key={line} style={styles.body}>
          {`• ${line}`}
        </Text>
      ))}
      {words.left.length ? (
        <Text style={styles.body}>
          These stay for the business to decide when it erases your data:
        </Text>
      ) : null}
      {words.left.map((line) => (
        <Text key={line} style={styles.body}>
          {`• ${line}`}
        </Text>
      ))}
      <Text style={styles.body}>{words.erase}</Text>
      <Field
        label={`To confirm, type ${DELETE_WORD}`}
        value={typed}
        autoCapitalize="characters"
        autoCorrect={false}
        onChangeText={setTyped}
      />
      <Button
        label="Delete my account"
        busy={busy}
        disabled={!deleteConfirmInput(shown, typed)}
        onPress={() => void confirm(shown)}
      />
      <Button
        quiet
        label="Keep my account"
        onPress={() => {
          setTyped("");
          setProblem(null);
          setStep({ kind: "idle" });
        }}
      />
      {said}
    </View>
  );
}

const styles = StyleSheet.create({
  part: { gap: theme.space.md },
  heading: { fontSize: theme.font.body, fontWeight: "600", color: theme.color.text },
  body: { fontSize: theme.font.body, color: theme.color.text },
  problem: { fontSize: theme.font.body, color: theme.color.danger },
});
