// Paying for one class on a gym's site (stage 31a step 8, a drop-in): the week's classes for a
// visitor, each with "Pay for this class". The host holds a place while they pay, prices it, and
// books them when the payment provider confirms it; an unpaid order lets the place go after a few
// minutes. Whether a class can be paid for, its price, the places left and the rules are the
// host's: this shows its answers and sends the buyer to the provider's page. Web only: a native
// block never buys (the block lint).
import type { BookingsHooks, TimetableClass } from "@composable-os/pack-bookings/client";
import {
  classTime,
  formatAmount,
  placesLabel,
  refusalMessage,
} from "@composable-os/pack-bookings/client";
import { type FormEvent, useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Input } from "../ui-input/input.tsx";
import { Label } from "../ui-label/label.tsx";

type Hooks = Pick<BookingsHooks, "useTimetable" | "useBuy">;

/** What the buyer is shown before they leave for the provider's page. */
export interface StartedDropIn {
  orderId: string;
  bookingId: string;
  token: string | null;
}

/**
 * `signedIn`: the buyer is a signed-in member (no email asked). `returnUrl`: where the provider
 * sends them back, on one of the deployment's allowed sites; coming back books nothing, the
 * verified payment does. `onStarted` is called before they leave (keep a guest's token).
 */
export function DropIn({
  bookings,
  signedIn,
  returnUrl,
  onStarted,
  from,
  to,
}: {
  bookings: Hooks;
  signedIn: boolean;
  returnUrl: string;
  onStarted?: (started: StartedDropIn) => void;
  from?: string;
  to?: string;
}) {
  const timetable = bookings.useTimetable({ ...(from ? { from } : {}), ...(to ? { to } : {}) });
  const [chosen, setChosen] = useState<TimetableClass | null>(null);
  if (timetable.isPending) return <p aria-busy="true">Loading the timetable…</p>;
  if (timetable.error || !timetable.data) {
    return <p role="alert">We could not load the timetable. Try again soon.</p>;
  }
  if (chosen) {
    return (
      <PayForm
        klass={chosen}
        bookings={bookings}
        signedIn={signedIn}
        returnUrl={returnUrl}
        onStarted={onStarted}
        onBack={() => setChosen(null)}
      />
    );
  }
  return (
    <section className="grid gap-4" aria-label="Pay for a class">
      {timetable.data.classes.length === 0 ? <p>No classes in these days.</p> : null}
      <ul className="grid gap-2">
        {timetable.data.classes.map((klass) => (
          <li
            key={klass.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
          >
            <div className="grid gap-1">
              <strong>{klass.title ?? "Class"}</strong>
              <span>{classTime(klass)}</span>
              <span className="text-muted-foreground text-sm">
                {[klass.coach?.name, klass.room?.name, placesLabel(klass.places)]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            <Button variant="outline" onClick={() => setChosen(klass)}>
              Pay for {klass.title ?? "this class"}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PayForm({
  klass,
  bookings,
  signedIn,
  returnUrl,
  onStarted,
  onBack,
}: {
  klass: TimetableClass;
  bookings: Pick<BookingsHooks, "useBuy">;
  signedIn: boolean;
  returnUrl: string;
  onStarted: ((started: StartedDropIn) => void) | undefined;
  onBack: () => void;
}) {
  const buy = bookings.useBuy();
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const name = klass.title ?? "Class";
  const busy = buy.start.isPending || buy.checkout.isPending;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    const held = await buy.start.mutateAsync({
      classId: klass.id,
      ...(signedIn ? {} : { email }),
    });
    if (held.result === "refused") {
      setMessage(refusalMessage(held, klass.timeZone));
      return;
    }
    onStarted?.({ orderId: held.orderId, bookingId: held.bookingId, token: held.token });
    setMessage(`Your place is held. ${formatAmount(held.total, held.currency)} to pay.`);
    const page = await buy.checkout.mutateAsync({
      id: held.orderId,
      ...(held.token ? { token: held.token } : {}),
      returnUrl,
    });
    window.location.assign(page.url);
  }

  return (
    <form onSubmit={submit} className="grid gap-4" aria-label={`Pay for ${name}`}>
      <div className="grid gap-1">
        <strong>{name}</strong>
        <span>{classTime(klass)}</span>
      </div>
      {signedIn ? null : (
        <div className="grid gap-1">
          <Label htmlFor="drop-in-email">Your email</Label>
          <Input
            id="drop-in-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
      )}
      {message ? <p role="status">{message}</p> : null}
      {buy.start.error || buy.checkout.error ? (
        <p role="alert">We could not start the payment. Try again soon.</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Opening the payment page…" : "Pay"}
        </Button>
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
      </div>
    </form>
  );
}
