// The desk tablet's page (stage 44 step 6, decision 22, ADR 0649), at tablet width, on the desk
// origin only (the Worker answers /desk as not found anywhere else). The tablet is a device an
// admin enrolled; it holds no sign-in. A person on the staff starts a session for one member and
// is given a code; typed here, it shows what that member (and each child they sign for) has due,
// one document at a time in the Agree block's web skin, then "All done: please hand the device
// back", which shows nothing more.
//
// It decides nothing: whether this browser is an enrolled device, whose session it is, what is
// due, every limit (3 minutes idle, 20 in all) and every refusal are the host's. The page's own
// timers only clear the screen sooner. Nothing typed, drawn or answered is kept beyond the Agree
// form's own memory: no URL, storage or log. No navigation, history or list.
// The Agree block, as the base layer ships it (blocks/web-agree): the same form, signature pad and
// checks a member sees on the website.

import type { AgreeInput, AgreementVersion, DueReason } from "@composable-os/client";
import { NetworkError } from "@composable-os/client";
import { Button } from "@composable-os/ui/components/button";
import { Input } from "@composable-os/ui/components/input";
import { Label } from "@composable-os/ui/components/label";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { deskCall, deskRule } from "#/lib/desk-api";
import { Agree } from "../../../../blocks/web-agree/agree.tsx";

export const Route = createFileRoute("/desk")({
  ssr: false,
  head: () => ({ meta: [{ title: "Desk" }, { name: "robots", content: "noindex" }] }),
  component: DeskPage,
});

interface Greeting {
  business: string;
  signer: string;
  children: string[];
}

interface DeskItem {
  forPersonId: string | null;
  forName: string;
  documentId: string;
  title: string;
  reason: DueReason;
  version: AgreementVersion;
}

type Screen =
  | { kind: "loading" }
  | { kind: "not_enrolled" }
  | { kind: "other_use"; name: string }
  | { kind: "code"; name: string; notice: string | null }
  | { kind: "signing"; greeting: Greeting; items: DeskItem[]; copyTo: string | null }
  | { kind: "done"; business: string };

/** The page clears itself this long after the last touch (the host's limit is 3 minutes). */
const PAGE_IDLE_MS = 2.5 * 60_000;
/** A heartbeat at most this often while the person touches or scrolls. */
const HEARTBEAT_MS = 30_000;
/** "All done" stays this long, then the tablet is ready for the next person. */
const DONE_MS = 15_000;

const ENDED = "This session has ended. Please hand the device back to the desk.";
const OFFLINE = "We could not reach the business just now. Check the connection and try again.";

function DeskPage() {
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const deviceName = useRef("");

  const toCode = useCallback((notice: string | null = null) => {
    setScreen({ kind: "code", name: deviceName.current, notice });
  }, []);

  useEffect(() => {
    deskCall<{ enrolled: boolean; name: string | null; use: string | null }>("desk.status")
      .then((status) => {
        if (!status.enrolled) return setScreen({ kind: "not_enrolled" });
        deviceName.current = status.name ?? "";
        if (status.use !== "signing")
          return setScreen({ kind: "other_use", name: deviceName.current });
        toCode();
      })
      .catch(() => setScreen({ kind: "not_enrolled" }));
  }, [toCode]);

  const ended = useCallback(
    (error: unknown) => {
      if (deskRule(error) === "device_not_enrolled") return setScreen({ kind: "not_enrolled" });
      toCode(error instanceof NetworkError ? OFFLINE : ENDED);
    },
    [toCode],
  );

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-3xl flex-col gap-6 p-6 sm:p-10">
      {screen.kind === "loading" && <p className="text-muted-foreground">Getting ready…</p>}
      {screen.kind === "not_enrolled" && (
        <section className="grid gap-3" aria-labelledby="desk-heading">
          <h1 id="desk-heading" className="text-2xl font-semibold">
            This device is not enrolled
          </h1>
          <p className="text-muted-foreground">
            An admin enrols the business's tablet in Settings, Devices, and types the code they are
            given on this device's enrol page.
          </p>
          <a className="text-primary underline" href="/enrol">
            Enrol this device
          </a>
        </section>
      )}
      {screen.kind === "other_use" && (
        <section className="grid gap-3">
          <h1 className="text-2xl font-semibold">{screen.name}</h1>
          <p className="text-muted-foreground">
            This device is enrolled for something other than signing at the desk.
          </p>
        </section>
      )}
      {screen.kind === "code" && (
        <EnterCode
          name={screen.name}
          notice={screen.notice}
          onClaimed={async (greeting) => {
            try {
              const docs = await deskCall<{ items: DeskItem[]; copyTo: string | null } & Greeting>(
                "desk.documents",
              );
              if (!docs.items.length) {
                await deskCall("desk.finish").catch(() => {});
                return setScreen({ kind: "done", business: greeting.business });
              }
              setScreen({ kind: "signing", greeting, items: docs.items, copyTo: docs.copyTo });
            } catch (error) {
              ended(error);
            }
          }}
        />
      )}
      {screen.kind === "signing" && (
        <Signing
          greeting={screen.greeting}
          items={screen.items}
          copyTo={screen.copyTo}
          onEnded={ended}
          onDone={() => setScreen({ kind: "done", business: screen.greeting.business })}
        />
      )}
      {screen.kind === "done" && <Done business={screen.business} onNext={() => toCode()} />}
    </main>
  );
}

function EnterCode({
  name,
  notice,
  onClaimed,
}: {
  name: string;
  notice: string | null;
  onClaimed: (greeting: Greeting) => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const greeting = await deskCall<Greeting>("desk.claim", { code });
      setCode("");
      await onClaimed(greeting);
    } catch (e) {
      const rule = deskRule(e);
      setError(
        e instanceof NetworkError
          ? OFFLINE
          : rule === "desk_locked"
            ? "Too many wrong codes on this device. Wait five minutes, then ask the desk for a new code."
            : rule === "desk_wrong_device"
              ? "That code was started for another device. Ask the desk to start again on this one."
              : "That code is not right, or it has run out. Ask the desk for a new one.",
      );
      setCode("");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="grid max-w-md gap-4" aria-labelledby="code-heading">
      <h1 id="code-heading" className="text-2xl font-semibold">
        Enter code
      </h1>
      <p className="text-muted-foreground">
        The desk gives you a code to sign your documents on this device{name ? ` (${name})` : ""}.
      </p>
      {notice && (
        <p role="status" className="rounded-md border p-3 text-sm">
          {notice}
        </p>
      )}
      <div className="grid gap-2">
        <Label htmlFor="desk-code">Code</Label>
        <Input
          id="desk-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          inputMode="text"
          maxLength={20}
          className="h-14 text-2xl tracking-widest uppercase"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "desk-code-error" : undefined}
        />
        {error && (
          <p id="desk-code-error" role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <Button type="submit" size="lg" disabled={busy || code.trim().length < 4}>
        {busy ? "Checking…" : "Continue"}
      </Button>
    </form>
  );
}

function Signing({
  greeting,
  items,
  copyTo,
  onEnded,
  onDone,
}: {
  greeting: Greeting;
  items: DeskItem[];
  copyTo: string | null;
  onEnded: (error: unknown) => void;
  onDone: () => void;
}) {
  const [index, setIndex] = useState(0);
  const lastBeat = useRef(Date.now());
  const lastTouch = useRef(Date.now());
  const item = items[index];

  // Reading counts as activity: a heartbeat while the person touches or scrolls (the host bounds
  // it), and the page clears itself after a while untouched.
  useEffect(() => {
    const touched = () => {
      lastTouch.current = Date.now();
      if (Date.now() - lastBeat.current < HEARTBEAT_MS) return;
      lastBeat.current = Date.now();
      deskCall("desk.heartbeat").catch(onEnded);
    };
    const events = ["pointerdown", "keydown", "scroll", "wheel", "touchmove"] as const;
    for (const name of events) window.addEventListener(name, touched, { passive: true });
    const timer = window.setInterval(() => {
      if (Date.now() - lastTouch.current > PAGE_IDLE_MS) {
        deskCall("desk.finish").catch(() => {});
        onEnded(new Error("idle"));
      }
    }, 5_000);
    return () => {
      for (const name of events) window.removeEventListener(name, touched);
      window.clearInterval(timer);
    };
  }, [onEnded]);

  async function agree(input: AgreeInput) {
    if (!item) return;
    try {
      await deskCall("desk.accept", {
        ...input,
        ...(item.forPersonId ? { forPersonId: item.forPersonId } : {}),
      });
    } catch (error) {
      const rule = deskRule(error);
      if (rule === "desk_session_ended" || rule === "device_not_enrolled") return onEnded(error);
      throw error;
    }
    if (index + 1 < items.length) {
      setIndex(index + 1);
      window.scrollTo({ top: 0 });
      return;
    }
    await deskCall("desk.finish").catch(() => {});
    onDone();
  }

  if (!item) return null;
  const forChild = item.forPersonId !== null;
  return (
    <section className="grid gap-6" aria-labelledby="signing-heading">
      <header className="grid gap-1">
        <p className="text-sm text-muted-foreground">{greeting.business}</p>
        <h1 id="signing-heading" className="text-2xl font-semibold">
          Documents for {greeting.signer}
          {greeting.children.length ? ` and ${greeting.children.join(", ")}` : ""}
        </h1>
        <p className="text-sm text-muted-foreground">
          {index + 1} of {items.length}
          {copyTo ? ` · a copy goes to ${copyTo}` : ""}
        </p>
      </header>
      <Agree
        key={`${item.version.id}:${item.forPersonId ?? "self"}`}
        version={item.version}
        forName={forChild ? item.forName : null}
        reason={item.reason}
        submitLabel={index + 1 < items.length ? "Agree and continue" : "Agree"}
        onAgree={agree}
      />
    </section>
  );
}

function Done({ business, onNext }: { business: string; onNext: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onNext, DONE_MS);
    return () => window.clearTimeout(timer);
  }, [onNext]);
  return (
    <section className="grid gap-3" aria-live="polite">
      <p className="text-sm text-muted-foreground">{business}</p>
      <h1 className="text-2xl font-semibold">All done: please hand the device back</h1>
    </section>
  );
}
