import { Button } from "@composable-os/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@composable-os/ui/components/card";
import { Input } from "@composable-os/ui/components/input";
import { Label } from "@composable-os/ui/components/label";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { useProductName } from "../components/product-name.ts";
import { authClient } from "../lib/auth-client.ts";
import { FIRST_ADMIN_HEADER, firstAdminTokenOf } from "../lib/first-admin.ts";
import { authPost, OFFLINE_WORDS } from "../lib/staff-auth.ts";
import { getSession, getSignInMethods } from "../server/session.public.ts";

interface SignInSearch {
  redirect?: string;
}

function safeRedirect(target: string | undefined): string {
  // Only same-origin paths: never an open redirect.
  return target?.startsWith("/") && !target.startsWith("//") ? target : "/";
}

export const Route = createFileRoute("/sign-in")({
  validateSearch: (search: Record<string, unknown>): SignInSearch =>
    typeof search.redirect === "string" ? { redirect: search.redirect } : {},
  beforeLoad: async ({ search }) => {
    if ((await getSession()).principal) throw redirect({ href: safeRedirect(search.redirect) });
  },
  loader: () => getSignInMethods(),
  component: SignInPage,
});

/**
 * Sign-in by a code emailed to the address (ADR 0455): how an invited person accepts their
 * invite, and how an account without a password signs in. The answer to "email me a code" is
 * the same whoever the address is.
 */
function CodeSignIn({ callbackURL, hydrated }: { callbackURL: string; hydrated: boolean }) {
  const [email, setEmail] = useState("");
  const [asked, setAsked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const answer = await authPost("/email-otp/send-verification-otp", { email, type: "sign-in" });
    setPending(false);
    if (answer !== "ok") {
      setError(
        answer === "offline"
          ? OFFLINE_WORDS
          : "A code could not be sent just now. Try again in a minute.",
      );
      return;
    }
    setAsked(true);
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const otp = String(new FormData(event.currentTarget).get("code")).trim();
    setPending(true);
    setError(null);
    const answer = await authPost("/sign-in/email-otp", { email, otp });
    setPending(false);
    if (answer !== "ok") {
      setError(
        answer === "offline"
          ? OFFLINE_WORDS
          : "That code is not valid. Check it, or ask for a new one.",
      );
      return;
    }
    window.location.assign(callbackURL);
  }

  if (!asked) {
    return (
      <form className="grid gap-3" onSubmit={ask} aria-label="Sign in with a code">
        <div className="grid gap-1.5">
          <Label htmlFor="code-email">Email</Label>
          <Input
            id="code-email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" variant="outline" disabled={!hydrated || pending}>
          {pending ? "Sending…" : "Email me a code"}
        </Button>
      </form>
    );
  }
  return (
    <form className="grid gap-3" onSubmit={verify} aria-label="Enter your code">
      <p className="text-sm text-muted-foreground">
        If {email} can sign in here, a six-digit code is on its way. It works once, for five
        minutes.
      </p>
      <div className="grid gap-1.5">
        <Label htmlFor="code">Code</Label>
        <Input
          id="code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          required
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={!hydrated || pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
      <Button type="button" variant="ghost" onClick={() => setAsked(false)}>
        Use another address
      </Button>
    </form>
  );
}

function SignInPage() {
  const productName = useProductName();
  const methods = Route.useLoaderData();
  const { redirect: target } = Route.useSearch();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Until React hydrates, a click would submit the form natively; keep it disabled until then.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const callbackURL = safeRedirect(target);
  // One email field on the page at a time: the password form, or the code form (ADR 0455).
  const [withCode, setWithCode] = useState(false);
  const codeOffered = methods.code && !methods.firstAccount;
  // On a host of many clients the first account is made only with the operator's setup link
  // (stage 66 step 9): its token is in the fragment, read once the page runs.
  const [setupToken, setSetupToken] = useState<string | null>(null);
  useEffect(() => setSetupToken(firstAdminTokenOf(window.location.hash)), []);
  const waitingForLink = methods.firstAccount && methods.firstAdminByLink && !setupToken;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const email = String(form.get("email"));
    const password = String(form.get("password"));
    const { error } = methods.firstAccount
      ? await authClient.signUp.email(
          { name: String(form.get("name")), email, password },
          setupToken ? { headers: { [FIRST_ADMIN_HEADER]: setupToken } } : undefined,
        )
      : await authClient.signIn.email({ email, password });
    setPending(false);
    if (error) {
      setError(error.message ?? (methods.firstAccount ? "Sign-up failed" : "Sign-in failed"));
      return;
    }
    // A full navigation so the server sees the new session cookie on the first request.
    window.location.assign(callbackURL);
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            {methods.firstAccount ? "Create the first account" : `Sign in to ${productName}`}
          </CardTitle>
          <CardDescription>
            {waitingForLink
              ? "The first account is made with the setup link you were sent. Open that link to create it."
              : methods.firstAccount
                ? methods.firstAdminByLink
                  ? "Create the first account with the address the setup link was made for. It is the admin."
                  : "This deployment has no users yet. The first account is its admin."
                : methods.kind === "better-auth"
                  ? "Use your email and password."
                  : "This deployment signs you in with Cloudflare Access."}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {methods.email && !withCode && !waitingForLink && (
            <form className="grid gap-3" method="post" onSubmit={onSubmit}>
              {methods.firstAccount && (
                <div className="grid gap-1.5">
                  <Label htmlFor="name">Name</Label>
                  <Input id="name" name="name" autoComplete="name" required />
                </div>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" autoComplete="email" required />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete={methods.firstAccount ? "new-password" : "current-password"}
                  minLength={methods.firstAccount ? 8 : undefined}
                  required
                />
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={!hydrated || pending}>
                {methods.firstAccount
                  ? pending
                    ? "Creating account…"
                    : "Create account"
                  : pending
                    ? "Signing in…"
                    : "Sign in"}
              </Button>
            </form>
          )}
          {codeOffered &&
            (withCode ? (
              <>
                <CodeSignIn callbackURL={callbackURL} hydrated={hydrated} />
                <Button type="button" variant="ghost" onClick={() => setWithCode(false)}>
                  Use a password instead
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="ghost"
                disabled={!hydrated}
                onClick={() => setWithCode(true)}
              >
                Invited, or no password? Use a code from email
              </Button>
            ))}
          {methods.google && !(methods.firstAccount && methods.firstAdminByLink) && (
            <Button
              variant="outline"
              disabled={!hydrated}
              onClick={() => authClient.signIn.social({ provider: "google", callbackURL })}
            >
              Continue with Google
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
