// Enrolling the business's tablet (stage 51 step 1, ADR 0780), on the desk origin only: an admin
// enrolled a device in Settings, Devices and was given a code; typed here, this browser becomes
// that device. The host sets its credential in a cookie this page never sees (HttpOnly).
import { NetworkError } from "@composable-os/client";
import { Button } from "@composable-os/ui/components/button";
import { Input } from "@composable-os/ui/components/input";
import { Label } from "@composable-os/ui/components/label";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { deskCall, deskRule } from "#/lib/desk-api";

export const Route = createFileRoute("/enrol")({
  ssr: false,
  head: () => ({ meta: [{ title: "Enrol this device" }, { name: "robots", content: "noindex" }] }),
  component: EnrolPage,
});

function EnrolPage() {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [enrolled, setEnrolled] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const device = await deskCall<{ name: string; use: string }>("device.claim", { code });
      setEnrolled(device.name);
    } catch (e) {
      setError(
        e instanceof NetworkError
          ? "We could not reach the business just now. Check the connection and try again."
          : deskRule(e) === "device_enrolled"
            ? (e as Error).message
            : "That code is not right, or it has run out. Ask an admin for a new one.",
      );
    } finally {
      setBusy(false);
      setCode("");
    }
  }

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-md flex-col gap-6 p-6 sm:p-10">
      {enrolled ? (
        <section className="grid gap-3" aria-live="polite">
          <h1 className="text-2xl font-semibold">This device is enrolled as {enrolled}</h1>
          <p className="text-muted-foreground">Every admin has been told.</p>
          <a className="text-primary underline" href="/desk">
            Go to the desk
          </a>
        </section>
      ) : (
        <form onSubmit={submit} className="grid gap-4" aria-labelledby="enrol-heading">
          <h1 id="enrol-heading" className="text-2xl font-semibold">
            Enrol this device
          </h1>
          <p className="text-muted-foreground">
            Type the enrolment code an admin was given in Settings, Devices. It works once, for 10
            minutes.
          </p>
          <div className="grid gap-2">
            <Label htmlFor="enrol-code">Enrolment code</Label>
            <Input
              id="enrol-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={20}
              className="h-14 text-2xl tracking-widest uppercase"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "enrol-code-error" : undefined}
            />
            {error && (
              <p id="enrol-code-error" role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <Button type="submit" size="lg" disabled={busy || code.trim().length < 4}>
            {busy ? "Checking…" : "Enrol"}
          </Button>
        </form>
      )}
    </main>
  );
}
