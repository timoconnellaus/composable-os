// Sign-in with a code by email. The host sends the code and makes the session; this page asks
// through the ScreenHost (src/screen-host/): in the server build this app's /auth routes and a
// cookie, in the browser build the host's token sign-in. Signed in, the customer goes to "Before
// you go on", which goes straight on to their account when nothing is due.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { useScreenHost } from "../screen-host/index.ts";

export const Route = createFileRoute("/sign-in")({ component: SignIn });

function SignIn() {
  const host = useScreenHost();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!sent) {
      if (await host.requestCode(email)) setSent(true);
      else setError("We could not send a code. Try again in a moment.");
      return;
    }
    if (await host.signIn(email, code)) await navigate({ to: "/before-you-go-on" });
    else setError("That code did not work. Check it, or ask for a new one.");
  }

  return (
    <main>
      <h1>Sign in</h1>
      <form onSubmit={submit} style={{ display: "grid", gap: 12, maxWidth: 320 }}>
        <label>
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={sent}
          />
        </label>
        {sent ? (
          <label>
            The code we emailed you
            <input
              inputMode="numeric"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
        ) : null}
        <button type="submit">{sent ? "Sign in" : "Email me a code"}</button>
        {error ? <p role="alert">{error}</p> : null}
      </form>
    </main>
  );
}
