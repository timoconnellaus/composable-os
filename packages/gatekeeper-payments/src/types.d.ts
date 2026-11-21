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
  /**
   * Asks the provider to calculate tax inside the amount (Stripe Tax). Left out, the checkout is
   * one line of `amount` with no tax settings, exactly as without tax. Given, the provider's page
   * requires the buyer's billing address, because the buyer's location sets the rate.
   */
  tax?: PaymentsCheckoutTax;
}

/** Tax at checkout: the lines the amount is made of, each with its product tax code. */
export interface PaymentsCheckoutTax {
  /**
   * Prices are tax-inclusive: what the buyer pays is the amount, and the provider works out the
   * tax inside it. The only behaviour offered.
   */
  behavior: "inclusive";
  /** 1 to 50 lines whose amounts sum to the checkout's amount. */
  lines: PaymentsTaxLine[];
}

/** One line of a taxed checkout: a share of the amount, at its own product tax code. */
export interface PaymentsTaxLine {
  /** The host's id for the line (an order line id): 1 to 64 characters of `[A-Za-z0-9_-]`. */
  ref: string;
  /** 1 to 200 characters, shown on the provider's page. */
  name: string;
  /** A positive safe integer, minor units, tax included. */
  amount: number;
  /** The provider's product tax code: `txcd_` and eight digits (Stripe's list). */
  taxCode: string;
  /**
   * Where the service is supplied, for admission to an in-person event: the provider taxes the
   * line where the event is, not where the buyer lives (Stripe: a performance location).
   */
  place?: PaymentsTaxPlace;
}

/** An event's address for tax. */
export interface PaymentsTaxPlace {
  /** ISO 3166-1 alpha-2, upper case. */
  country: string;
  /** A state, province or region, 1 to 100 characters. */
  region?: string;
  /** 1 to 20 characters. */
  postcode?: string;
  /** 1 to 100 characters. */
  city?: string;
  /** The street address, 1 to 200 characters. */
  line1?: string;
}

/** The tax the provider calculated on a payment. Never recalculated by the host. */
export interface PaymentsTaxReport {
  /** The tax inside the payment's amount, minor units. Zero where the org collects none. */
  amount: number;
  /** The country the tax was charged for (ISO 3166-1 alpha-2, upper case), or null. */
  country: string | null;
  /** Each line's tax, by the `ref` the checkout sent. */
  lines: { ref: string; amount: number }[];
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
      /** Present only when the checkout asked for tax: what the provider calculated. */
      tax?: PaymentsTaxReport;
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
      /** The tax this refund gave back, when the provider's refund event says. */
      tax?: { amount: number };
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
