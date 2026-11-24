// Choosing tickets and paying, for a site (stage 27): quantities per ticket type, pay in full or
// by deposit when every chosen type offers one, then the payment provider's page. And paying what
// is still owed on a part-paid order. The host prices the order, holds the places, refuses what
// cannot be bought and decides what may be charged; this asks and shows what it answers.
//
// What must be agreed to first (stage 44: a waiver on the event) is the host's answer too: when
// "Pay" is refused with it, the documents are shown inline (the web-agree block's step) and "Pay"
// is tried again (issue #292). A visitor's agreements travel in the buying call, held in memory
// until then; a member's are recorded as they agree. A minor is told a parent or guardian buys it.
import {
  type AgreeInput,
  type AgreementsHooks,
  agreementRefusal,
  forgetAfter,
  purchaseErrorWords,
  type RefusedDocument,
  withAgreements,
} from "@composable-os/client";
import type {
  EventOnSale,
  StartedOrder,
  TicketingHooks,
} from "@composable-os/pack-ticketing/client";
import {
  availabilityLabel,
  eventCurrency,
  formatMoney,
  formatPrice,
  minorFromInput,
} from "@composable-os/pack-ticketing/client";
import { type FormEvent, useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Input } from "../ui-input/input.tsx";
import { Label } from "../ui-label/label.tsx";
import { useForgetOnLeave } from "../web-agree/agree.tsx";
import { GuestAgreementStep, MemberAgreementStep } from "../web-agree/agreement-step.tsx";

/** The agreements hooks the inline step uses: a member's (due, accept) and a visitor's (words). */
export type TicketAgreements = Pick<AgreementsHooks, "useDue" | "useAccept" | "useGuestVersions">;

/** What the host said when it refused, in the buyer's words. */
function refusal(error: unknown): string | null {
  if (!error) return null;
  // Agreements and the connection (stage 44): what changed, a minor, offline.
  const words = purchaseErrorWords(error) ?? agreementRefusal(error)?.message;
  if (words) return words;
  const rule = (error as { details?: { details?: { rule?: string }; rule?: string } }).details;
  switch (rule?.details?.rule ?? rule?.rule) {
    case "capacity":
      return "There are not enough places left for that many. Choose fewer.";
    case "sale_window":
      return "These tickets are not on sale right now.";
    case "max_per_order":
      return "That is more than one order may hold. Choose fewer.";
    default:
      return "We could not start your order. Try again in a moment.";
  }
}

/**
 * The picker and checkout. `signedIn`: the buyer is a signed-in customer (no email asked).
 * `returnUrl`: the confirmation page, on one of the deployment's allowed sites; it gets the order
 * (and a guest's token) from `onStarted`, which is called before the buyer leaves.
 * `agreements`: for what must be agreed to first, shown inline; without it, the refusal is only
 * named.
 */
export function TicketPicker({
  ticketing,
  agreements,
  event,
  signedIn,
  returnUrl,
  onStarted,
}: {
  ticketing: Pick<TicketingHooks, "useCheckout" | "useOrder" | "useStartOrder" | "useTicketPicker">;
  agreements?: TicketAgreements;
  event: EventOnSale;
  signedIn: boolean;
  returnUrl: string;
  onStarted: (order: StartedOrder) => void;
}) {
  const picker = ticketing.useTicketPicker(event);
  // The currency is the host's, given with the prices; the picker states none of its own.
  const currency = eventCurrency(event);
  const start = ticketing.useStartOrder();
  const checkout = ticketing.useCheckout();
  const [email, setEmail] = useState("");
  const [pay, setPay] = useState<"full" | "deposit">("full");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // What the host said must be agreed to first.
  const [due, setDue] = useState<RefusedDocument[] | null>(null);
  // A visitor's agreements: this component's state only, kept if the order does not start
  // (nothing typed twice), forgotten once it starts and when they leave the page.
  const [agreed, setAgreed] = useState<AgreeInput[] | null>(null);
  // A member's "a copy is on its way".
  const [said, setSaid] = useState<string | null>(null);
  useForgetOnLeave(() => setAgreed(null));
  const byDeposit = picker.estimate.deposit !== null;

  async function buy(given: AgreeInput[] | null = agreed) {
    setProblem(null);
    setBusy(true);
    try {
      const outcome = await withAgreements((previous) =>
        forgetAfter(start, {
          lines: picker.lines,
          pay: byDeposit ? pay : "full",
          ...(signedIn ? {} : { email }),
          ...(!signedIn && given && previous?.kind !== "read_again" ? { agreements: given } : {}),
        }),
      );
      if (outcome.kind !== "done") setAgreed(null);
      if (outcome.kind === "due") {
        if (agreements) setDue(outcome.documents);
        else {
          setProblem(
            `Something must be agreed to first: ${outcome.documents.map((d) => d.title).join(", ")}.`,
          );
        }
        return;
      }
      if (outcome.kind === "minor_payer") {
        setProblem(outcome.message);
        return;
      }
      const order = outcome.value;
      // Recorded with the order: nothing of it is kept here any more.
      setAgreed(null);
      onStarted(order);
      const page = await checkout.mutateAsync({
        id: order.id,
        ...(order.token ? { token: order.token } : {}),
        returnUrl,
      });
      window.location.assign(page.url);
    } catch (error) {
      if (agreementRefusal(error)) setAgreed(null);
      setProblem(refusal(error));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void buy();
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
          void buy(null);
        }}
      />
    ) : (
      <GuestAgreementStep
        agreements={agreements}
        documents={due}
        continueLabel="Agree and pay"
        onCancel={back}
        onAgreed={(given) => {
          setDue(null);
          setAgreed(given);
          void buy(given);
        }}
      />
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      {event.ticketTypes.map((type) => (
        <div key={type.id} className="grid gap-1">
          <Label htmlFor={`qty-${type.id}`}>
            {type.name} · {formatPrice(type.price, currency)}
            {type.deposit !== null ? ` (deposit ${formatPrice(type.deposit, currency)})` : ""}
          </Label>
          <Input
            id={`qty-${type.id}`}
            type="number"
            inputMode="numeric"
            min={0}
            max={picker.max(type)}
            disabled={picker.max(type) === 0}
            value={picker.quantities[type.id] ?? 0}
            onChange={(e) => picker.set(type.id, Number(e.target.value))}
          />
          {availabilityLabel(type.availability) ? (
            <span className="text-sm text-muted-foreground">
              {availabilityLabel(type.availability)}
            </span>
          ) : null}
        </div>
      ))}
      {byDeposit ? (
        <fieldset className="grid gap-2">
          <legend>How would you like to pay?</legend>
          <label>
            <input
              type="radio"
              name="pay"
              checked={pay === "full"}
              onChange={() => setPay("full")}
            />{" "}
            In full: {formatMoney(picker.estimate.full, currency)}
          </label>
          <label>
            <input
              type="radio"
              name="pay"
              checked={pay === "deposit"}
              onChange={() => setPay("deposit")}
            />{" "}
            A deposit now: {formatMoney(picker.estimate.deposit ?? 0, currency)}, the rest by the
            date on your ticket type
          </label>
        </fieldset>
      ) : (
        <p>{picker.empty ? "Choose your tickets." : formatMoney(picker.estimate.full, currency)}</p>
      )}
      {signedIn ? null : (
        <div className="grid gap-1">
          <Label htmlFor="buyer-email">Email (your tickets are sent here)</Label>
          <Input
            id="buyer-email"
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
        <p className="text-sm">
          What you agreed to is kept for this order: press Pay to try again.
        </p>
      ) : null}
      {problem ? <p role="alert">{problem}</p> : null}
      <Button type="submit" disabled={picker.empty || busy}>
        {busy ? "Opening the payment page…" : "Pay"}
      </Button>
    </form>
  );
}

/**
 * Paying what is still owed on a part-paid order, in one go or a part of it. The host decides
 * what may be charged (a part at least its minimum, never more than the balance).
 */
export function BalancePayment({
  ticketing,
  order,
  returnUrl,
}: {
  ticketing: Pick<TicketingHooks, "useCheckout" | "useOrder" | "useStartOrder" | "useTicketPicker">;
  order: { id: string; token?: string | null };
  returnUrl: string;
}) {
  const current = ticketing.useOrder(order);
  const checkout = ticketing.useCheckout();
  const [part, setPart] = useState("");
  const data = current.data;
  if (!data) return current.isPending ? <p aria-busy="true">Loading your order…</p> : null;
  if (data.state !== "part_paid") return null;

  async function open(amount: number | null) {
    const page = await checkout.mutateAsync({
      id: order.id,
      ...(order.token ? { token: order.token } : {}),
      returnUrl,
      ...(amount === null ? {} : { amount }),
    });
    window.location.assign(page.url);
  }

  return (
    <div className="grid gap-3">
      <p>
        Still to pay: {formatMoney(data.balance, data.currency)}
        {data.balanceDueAt ? `, by ${new Date(data.balanceDueAt).toLocaleDateString()}` : ""}.
      </p>
      <Button onClick={() => open(data.balance)} disabled={checkout.isPending}>
        Pay it all
      </Button>
      <div className="grid gap-1">
        <Label htmlFor="part">Or pay part of it</Label>
        <Input
          id="part"
          inputMode="decimal"
          value={part}
          onChange={(e) => setPart(e.target.value)}
        />
        <Button
          onClick={() => open(minorFromInput(part, data.currency))}
          disabled={checkout.isPending || minorFromInput(part, data.currency) === null}
        >
          Pay this amount
        </Button>
      </div>
      {checkout.error ? (
        <p role="alert">
          That amount cannot be paid. It must be at least the minimum, and no more than you owe.
        </p>
      ) : null}
    </div>
  );
}
