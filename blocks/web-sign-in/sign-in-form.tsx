// Sign-in with a code by email, for the web app, built on the web base layer. The host sends the
// code and makes the session; this form only posts to the web app's own /auth routes (the
// template's src/host.ts serves them) and says what happened.
import { type FormEvent, useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Input } from "../ui-input/input.tsx";
import { Label } from "../ui-label/label.tsx";

async function post(path: string, body: unknown): Promise<boolean> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.ok;
}

export function SignInForm({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!sent) {
        if (await post("/auth/code", { email })) setSent(true);
        else setError("We could not send a code. Try again in a moment.");
      } else if (await post("/auth/sign-in", { email, code })) onSignedIn();
      else setError("That code did not work. Check it, or ask for a new one.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid max-w-sm gap-4">
      <div className="grid gap-2">
        <Label htmlFor="sign-in-email">Email</Label>
        <Input
          id="sign-in-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          disabled={sent}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      {sent ? (
        <div className="grid gap-2">
          <Label htmlFor="sign-in-code">The code we emailed you</Label>
          <Input
            id="sign-in-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
      ) : null}
      <Button type="submit" disabled={busy}>
        {sent ? "Sign in" : "Email me a code"}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
