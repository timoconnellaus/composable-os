// Delete my account (stage 48), for the web. Two steps, both the host's (me.deleteAccount, ADR
// 0713): first the host says what deleting will do, and the block shows all of it (each
// subscription they pay and how it ends, nothing refunded; their unpaid orders cancelled; what
// stays for the business to decide; by when their data is erased); then, deliberately, they type
// DELETE and confirm, and the host does exactly what it showed (the preview's `expect`). A preview
// that changed meanwhile is the host's conflict: the block asks for it again and shows the new one.
// Nothing is deleted by the block's own logic: without a preview there is nothing to confirm
// (`deleteConfirmInput`).
//
// The host keeps it to a sign-in within the last 15 minutes, the preview too. When it says
// `sign_in_again`, the block signs the customer in again in place (`SignInAgain`) and carries on.
import {
  type AccountHooks,
  type AccountSignIn,
  accountErrorWords,
  DELETE_WORD,
  type DeletePreview,
  deleteConfirmInput,
  deletedWords,
  deletePreviewWords,
  isDeletePreview,
  isPreviewChanged,
  sensitive,
} from "@composable-os/client";
import { type FormEvent, useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Input } from "../ui-input/input.tsx";
import { Label } from "../ui-label/label.tsx";
import { SignInAgain } from "../web-account-email/email.tsx";

type Hooks = Pick<AccountHooks, "useMe" | "useDeleteAccount">;

type Step =
  | { kind: "idle" }
  | { kind: "sign_in_again"; resume: "preview" | "confirm" }
  | { kind: "preview"; preview: DeletePreview; changed: boolean }
  | { kind: "done"; words: string };

export function DeleteAccount({
  account,
  signIn,
  onDeleted,
}: {
  account: Hooks;
  /** Signs the customer in again in place, when the host asks for a fresh sign-in. */
  signIn: AccountSignIn;
  /** The account is deleted and signed out: the app leaves the page (to its home page). */
  onDeleted: () => void;
}) {
  const me = account.useMe();
  const remove = account.useDeleteAccount();
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!me.data) return null;
  const email = me.data.signInEmail;

  async function preview(changed = false) {
    setProblem(null);
    setBusy(true);
    const outcome = await sensitive(() => remove.mutateAsync({}));
    setBusy(false);
    if (outcome.kind === "sign_in_again") setStep({ kind: "sign_in_again", resume: "preview" });
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
    const outcome = await sensitive(() => remove.mutateAsync(input));
    setBusy(false);
    if (outcome.kind === "sign_in_again") {
      setStep({ kind: "sign_in_again", resume: "confirm" });
      return;
    }
    if (outcome.kind === "failed") {
      // What deleting does changed since it was shown: show it again, never confirm it unseen.
      if (isPreviewChanged(outcome.error)) void preview(true);
      else setProblem(accountErrorWords(outcome.error));
      return;
    }
    if (isDeletePreview(outcome.value)) return;
    setStep({ kind: "done", words: deletedWords(outcome.value) });
  }

  if (step.kind === "sign_in_again") {
    return (
      <SignInAgain
        email={email}
        signIn={signIn}
        onCancel={() => setStep({ kind: "idle" })}
        // Back to the preview: asked again (after a sign-in, what it shows is asked afresh).
        onSignedIn={() => void preview()}
      />
    );
  }

  if (step.kind === "done") {
    return (
      <div className="grid gap-3">
        <p role="status">{step.words}</p>
        <div>
          <Button type="button" onClick={onDeleted}>
            Leave
          </Button>
        </div>
      </div>
    );
  }

  if (step.kind === "idle") {
    return (
      <div className="grid gap-3">
        <p className="text-sm">
          Deleting your account signs you out everywhere and asks the business to erase your
          personal data. First we show you exactly what it will do; nothing happens until you
          confirm.
        </p>
        <div>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void preview()}>
            See what deleting my account does
          </Button>
        </div>
        {problem ? <p role="alert">{problem}</p> : null}
      </div>
    );
  }

  const shown = step.preview;
  const words = deletePreviewWords(shown);
  return (
    <form
      className="grid gap-4"
      aria-label="Delete my account"
      noValidate
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void confirm(shown);
      }}
    >
      {step.changed ? (
        <p role="alert">Something changed since you looked: read it again before you confirm.</p>
      ) : null}
      <section className="grid gap-2" aria-label="What deleting your account does">
        <h3 className="font-medium">What deleting your account does</h3>
        {words.ends.length ? (
          <ul className="grid list-disc gap-1 pl-5 text-sm" aria-label="Subscriptions that end">
            {words.ends.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm">You pay no subscription: nothing is ended.</p>
        )}
        {words.cancelled.length ? (
          <ul className="grid list-disc gap-1 pl-5 text-sm" aria-label="Orders that are cancelled">
            {words.cancelled.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        {words.left.length ? (
          <>
            <p className="text-sm">
              These stay for the business to decide when it erases your data:
            </p>
            <ul className="grid list-disc gap-1 pl-5 text-sm" aria-label="Left for the business">
              {words.left.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        ) : null}
        <p className="text-sm">{words.erase}</p>
      </section>
      <div className="grid gap-1">
        <Label htmlFor="account-delete-word">{`To confirm, type ${DELETE_WORD}`}</Label>
        <Input
          id="account-delete-word"
          autoComplete="off"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant="destructive"
          disabled={busy || !deleteConfirmInput(shown, typed)}
        >
          Delete my account
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setTyped("");
            setProblem(null);
            setStep({ kind: "idle" });
          }}
        >
          Keep my account
        </Button>
      </div>
      {problem ? <p role="alert">{problem}</p> : null}
    </form>
  );
}
