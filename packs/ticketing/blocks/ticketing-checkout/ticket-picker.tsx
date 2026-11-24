// Choosing tickets and paying, for a site (stage 27): quantities per ticket type, pay in full or
// by deposit when every chosen type offers one, then the payment provider's page. And paying what
// is still owed on a part-paid order. The host prices the order, holds the places, refuses what
// cannot be bought and decides what may be charged; this asks and shows what it answers.

import { agreementBlockedWords } from "@composable-os/client";
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

/** What the host said when it refused, in the buyer's words. */
function refusal(error: unknown): string | null {
  if (!error) return null;
  // Something must be agreed to first (stage 44): this checkout has no agreement step yet.
  const agreements = agreementBlockedWords(error);
  if (agreements) return agreements;
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
 */
export function TicketPicker({
  ticketing,
  event,
  signedIn,
  returnUrl,
  onStarted,
}: {
  ticketing: Pick<TicketingHooks, "useCheckout" | "useStartOrder" | "useTicketPicker">;
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
  const byDeposit = picker.estimate.deposit !== null;
  const refused = refusal(start.error ?? checkout.error);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const order = await start.mutateAsync({
      lines: picker.lines,
      pay: byDeposit ? pay : "full",
      ...(signedIn ? {} : { email }),
    });
    onStarted(order);
    const page = await checkout.mutateAsync({
      id: order.id,
      ...(order.token ? { token: order.token } : {}),
      returnUrl,
    });
    window.location.assign(page.url);
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
      {refused ? <p role="alert">{refused}</p> : null}
      <Button type="submit" disabled={picker.empty || start.isPending || checkout.isPending}>
        {start.isPending || checkout.isPending ? "Opening the payment page…" : "Pay"}
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
  ticketing: Pick<TicketingHooks, "useCheckout" | "useOrder">;
  order: { id: string; token?: string | null };
  returnUrl: string;
}) {
  const current = ticketing.useOrder(order);
  const checkout = ticketing.useCheckout();
  const [part, setPart] = useState("");
  const data = current.data;
  if (!data) return current.isPending ? <p aria-busy="true">Loading your order…</p> : null;
  if (data.state !== "part_paid") return null;
  const partAmount = minorFromInput(part, data.currency);

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
          onClick={() => open(partAmount)}
          disabled={checkout.isPending || partAmount === null}
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
