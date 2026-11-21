// The agent- and host-facing types of the payments gatekeeper, served by getTypeScriptTypes().
// Self-contained: no imports.

/** The payment provider a payment account uses. */
export type PaymentsProviderName = "stripe" | "fake";

/** What `createCheckout()` takes. */
export interface PaymentsCheckoutInput {
  /** The host's order id (e.g. `ord_…`): 1 to 64 characters of `[A-Za-z0-9_-]`. */
  orderId: string;
  /** A positive safe integer, in the currency's minor unit (cents for AUD). */
  amount: number;
  /** ISO 4217, three letters. Reported in upper case. */
  currency: string;
  /** 1 to 200 characters, shown on the provider's page. */
  description: string;
  /**
   * Where the provider's page sends the customer back, paid or not: an absolute https URL, or
   * http://localhost or http://127.0.0.1 on any port. At most 2000 characters.
   */
  returnUrl: string;
  /** Prefills the customer's email on the provider's page. */
  customerEmail?: string;
  /** 1 to 200 characters. The same key opens no second checkout. */
  idempotencyKey: string;
}

/** An open checkout on the provider's hosted page. */
export interface PaymentsCheckout {
  provider: PaymentsProviderName;
  /** The provider's checkout reference (a Stripe Checkout Session id). */
  ref: string;
  /** The provider's hosted page to send the customer to. */
  url: string;
  /** When the checkout stops accepting payment, ISO 8601, if the provider says. */
  expiresAt: string | null;
}

/** One checkout as the provider reports it. */
export interface PaymentsPayment {
  provider: PaymentsProviderName;
  ref: string;
  status: "open" | "paid" | "expired";
  orderId: string | null;
  /** Minor units. */
  amount: number;
  /** ISO 4217, upper case. */
  currency: string;
  /** The provider's payment reference (a Stripe PaymentIntent id) once paid, else null. */
  paymentRef: string | null;
}

/** What `refund()` takes. */
export interface PaymentsRefundInput {
  orderId: string;
  /** The provider's payment reference the refund goes back to (a Stripe PaymentIntent id). */
  paymentRef: string;
  /** A positive safe integer, minor units. */
  amount: number;
  currency: string;
  /** 1 to 500 characters: staff's words, shown to the approver. */
  reason: string;
  /** The host's id for this refund (1 to 64 characters), sent as metadata and idempotency key. */
  refundId: string;
}

/** A submitted refund: `pending` until the host applies it. */
export interface PaymentsRefundReceipt {
  status: "pending" | "sent";
  /** The action id in the approval queue. */
  id: number;
}

/** A verified event from the provider. Currencies are upper case, times ISO 8601. */
export type PaymentsEvent =
  | {
      kind: "payment";
      provider: PaymentsProviderName;
      /** The provider's event id; a redelivery repeats it. */
      eventId: string;
      orderId: string;
      checkoutRef: string;
      /** What the provider says was paid, minor units. */
      amount: number;
      currency: string;
      paymentRef: string | null;
      occurredAt: string;
    }
  | {
      kind: "refund";
      provider: PaymentsProviderName;
      eventId: string;
      orderId: string | null;
      /** The host's refund id, when the refund carried one. */
      refundId: string | null;
      refundRef: string;
      paymentRef: string | null;
      amount: number;
      currency: string;
      occurredAt: string;
    };

/** The hook a session subscribes. */
export interface PaymentsEventHook {
  receiveEvent(event: PaymentsEvent): Promise<void>;
}

/** The session a payment account grants. */
export interface PaymentsSession {
  provider(): Promise<PaymentsProviderName>;
  /** Opens the provider's hosted payment page. Records an observation first. No approval: it moves no money. */
  createCheckout(input: PaymentsCheckoutInput): Promise<PaymentsCheckout>;
  /** Reads one checkout. Records an observation first. */
  getPayment(ref: string): Promise<PaymentsPayment>;
  /** Submits a refund as an outbound action `payments.refund` (never auto-approvable). Nothing is sent until the host applies it. */
  refund(input: PaymentsRefundInput): Promise<PaymentsRefundReceipt>;
  /** Asks the host to bind a hook that receives every verified payment and refund event. */
  subscribe(hook: PaymentsEventHook): Promise<void>;
}
