// Sign-in and devices (stage 48), for the web: every place the signed-in customer is signed in
// (browsers and the app on their devices), when each began and was last used, and signing one
// out. Which sessions are theirs is the host's (me.sessions.list, me.sessions.revoke): another
// customer's is never listed. Signing out of this browser is the web app's own route
// (`onSignOut`: the template posts to /auth/sign-out, which ends the session and its cookie).
import {
  type AccountHooks,
  accountErrorWords,
  orderedSessions,
  sessionWords,
} from "@composable-os/client";
import { useState } from "react";
import { Button } from "../ui-button/button.tsx";

type Hooks = Pick<AccountHooks, "useSessions" | "useRevokeSession">;

export function SignInAndDevices({
  account,
  onSignOut,
}: {
  account: Hooks;
  /** Signs this browser out (the web app's sign-out route) and leaves the page. */
  onSignOut: () => void;
}) {
  const sessions = account.useSessions();
  const revoke = account.useRevokeSession();
  const [error, setError] = useState<string | null>(null);
  if (sessions.isPending) return <p aria-busy="true">Loading where you are signed in…</p>;
  if (sessions.error || !sessions.data) {
    return <p role="alert">We could not load where you are signed in.</p>;
  }

  async function signOutOne(id: string) {
    setError(null);
    try {
      await revoke.mutateAsync({ id });
      sessions.refetch?.();
    } catch (e) {
      setError(accountErrorWords(e));
    }
  }

  return (
    <div className="grid gap-3">
      <ul className="grid gap-2" aria-label="Where you are signed in">
        {orderedSessions(sessions.data.items).map((session) => {
          const words = sessionWords(session);
          return (
            <li
              key={session.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
              data-session={session.kind}
            >
              <div className="grid gap-1">
                <strong>{words.title}</strong>
                <span className="text-muted-foreground text-sm">{words.detail}</span>
              </div>
              {session.current ? (
                <Button type="button" variant="outline" onClick={onSignOut}>
                  Sign out
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  disabled={revoke.isPending}
                  onClick={() => void signOutOne(session.id)}
                >
                  Sign it out
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
