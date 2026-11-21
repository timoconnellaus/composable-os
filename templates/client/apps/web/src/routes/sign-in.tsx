// Sign-in with a code by email, on this app's own hostname. The host sends the code and makes the
// session; this page only posts to this app's /auth routes (src/host.ts).
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";

export const Route = createFileRoute("/sign-in")({ component: SignIn });

async function post(path: string, body: unknown): Promise<boolean> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.ok;
}

function SignIn() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!sent) {
      if (await post("/auth/code", { email })) setSent(true);
      else setError("We could not send a code. Try again in a moment.");
      return;
    }
    if (await post("/auth/sign-in", { email, code })) window.location.assign("/account");
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
