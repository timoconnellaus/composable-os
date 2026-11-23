// Paying for one class on a gym's site (stage 31a step 8, a drop-in): the week's classes for a
// visitor, each with "Pay for this class". The host holds a place while they pay, prices it, and
// books them when the payment provider confirms it; an unpaid order lets the place go after a few
// minutes. Whether a class can be paid for, its price, the places left and the rules are the
// host's: this shows its answers and sends the buyer to the provider's page. Web only: a native
// block never buys (the block lint).
//
// What must be agreed to first (a waiver, a health form: stage 44) is the host's answer too: when
// "Pay" is refused with it, the documents are shown inline (the web-agree block's step) and "Pay"
// is tried again. A visitor's agreements travel in the buying call and are recorded with the order;
// a member's are recorded as they agree. What a visitor typed, drew and answered is held in memory
// only until that call. A minor whose purchase needs the payer's agreement is told a parent or
// guardian buys it.
import {
  type AgreeInput,
  type AgreementsHooks,
  agreementRefusal,
  forgetAfter,
  purchaseErrorWords,
  type RefusedDocument,
  withAgreements,
} from "@composable-os/client";
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
import { useForgetOnLeave } from "../web-agree/agree.tsx";
import { GuestAgreementStep, MemberAgreementStep } from "../web-agree/agreement-step.tsx";

/** The agreements hooks the inline step uses: a member's (due, accept) and a visitor's (words). */
export type DropInAgreements = Pick<AgreementsHooks, "useDue" | "useAccept" | "useGuestVersions">;

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
 * `agreements`: the agreements hooks, for what must be agreed to first (without them, a refusal
 * only names the documents).
 */
export function DropIn({
  bookings,
  agreements,
  signedIn,
  returnUrl,
  onStarted,
  from,
  to,
}: {
  bookings: Hooks;
  agreements?: DropInAgreements;
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
        agreements={agreements}
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
  agreements,
  signedIn,
  returnUrl,
  onStarted,
  onBack,
}: {
  klass: TimetableClass;
  bookings: Pick<BookingsHooks, "useBuy">;
  agreements: DropInAgreements | undefined;
  signedIn: boolean;
  returnUrl: string;
  onStarted: ((started: StartedDropIn) => void) | undefined;
  onBack: () => void;
}) {
  const buy = bookings.useBuy();
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // A member's "a copy is on its way", kept while the payment starts.
  const [said, setSaid] = useState<string | null>(null);
  // What the host said must be agreed to first, and a minor's "a parent or guardian buys it".
  const [due, setDue] = useState<RefusedDocument[] | null>(null);
  const [minor, setMinor] = useState<string | null>(null);
  // A visitor's agreements for this attempt: in this component's state only (never the app's
  // cache), kept if the payment cannot start so nothing is typed twice, forgotten once it starts,
  // when they go back, and when they leave the page.
  const [agreed, setAgreed] = useState<AgreeInput[] | null>(null);
  const [busy, setBusy] = useState(false);
  useForgetOnLeave(() => setAgreed(null));
  const name = klass.title ?? "Class";

  /** Starts the order (with a visitor's agreements, once given) and opens the payment page. */
  async function pay(given: AgreeInput[] | null = agreed) {
    setMessage(null);
    setProblem(null);
    setBusy(true);
    try {
      const outcome = await withAgreements((previous) =>
        forgetAfter(buy.start, {
          classId: klass.id,
          ...(signedIn ? {} : { email }),
          // A version replaced meanwhile: ask again with none, and the host names what is due now.
          ...(!signedIn && given && previous?.kind !== "read_again" ? { agreements: given } : {}),
        }),
      );
      if (outcome.kind === "due") {
        setAgreed(null);
        if (agreements) setDue(outcome.documents);
        else {
          setProblem(
            `Something must be agreed to first: ${outcome.documents.map((d) => d.title).join(", ")}.`,
          );
        }
        return;
      }
      if (outcome.kind === "minor_payer") {
        setAgreed(null);
        setMinor(outcome.message);
        return;
      }
      const held = outcome.value;
      if (held.result === "refused") {
        setMessage(refusalMessage(held, klass.timeZone));
        return;
      }
      // Recorded with the order: nothing of it is kept here any more.
      setAgreed(null);
      onStarted?.({ orderId: held.orderId, bookingId: held.bookingId, token: held.token });
      setMessage(`Your place is held. ${formatAmount(held.total, held.currency)} to pay.`);
      const page = await forgetAfter(buy.checkout, {
        id: held.orderId,
        ...(held.token ? { token: held.token } : {}),
        returnUrl,
      });
      window.location.assign(page.url);
    } catch (error) {
      const refusal = agreementRefusal(error);
      if (refusal?.kind === "read_again" || refusal?.kind === "changed") setAgreed(null);
      setProblem(purchaseErrorWords(error) ?? "We could not start the payment. Try again soon.");
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    await pay();
  }

  if (minor) {
    return (
      <section className="grid gap-3" aria-label={`Pay for ${name}`}>
        <p role="alert">{minor}</p>
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
      </section>
    );
  }
  if (due && agreements) {
    const back = () => setDue(null);
    return signedIn ? (
      <MemberAgreementStep
        agreements={agreements}
        documents={due}
        continueLabel="Agree and pay"
        onCancel={back}
        onAgreed={(copy) => {
          setDue(null);
          setSaid(copy);
          void pay(null);
        }}
      />
    ) : (
      <GuestAgreementStep
        agreements={agreements}
        documents={due}
        onCancel={back}
        onAgreed={(given) => {
          setDue(null);
          setAgreed(given);
          void pay(given);
        }}
      />
    );
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
      {said ? <p role="status">{said}</p> : null}
      {agreed ? (
        <p className="text-sm" data-agreed={agreed.length}>
          What you agreed to is kept for this payment: press Pay to try again.
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {problem ? <p role="alert">{problem}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Opening the payment page…" : "Pay"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setAgreed(null);
            onBack();
          }}
        >
          Back
        </Button>
      </div>
    </form>
  );
}
