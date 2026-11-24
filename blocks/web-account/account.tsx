// My account (stage 48), for the web: the signed-in customer's own area, one page of sections.
// The base sections come with it: Orders, Agreements, Family, Payment method (only for someone who
// pays a subscription), Your details, and Sign-in and devices. The packs' sections are passed in
// `sections`, each the pack's own block, and take their place by `order` (a pack's come first).
//
// It decides nothing: what each section shows is the host's answer to the section's own call, and
// whether Payment method shows is what the host lists of the subscriptions the customer pays. A
// later step adds "Needs your attention" at the top (me.attention) and lets the host say which
// pack sections this customer has (me.portal), with `cos add` writing `sections` for the client.
import {
  type AccountHooks,
  type AccountSection,
  type AgreementsHooks,
  accountSections,
  hiddenSections,
} from "@composable-os/client";
import type { ReactNode } from "react";
import { YourDetails } from "../web-account-details/details.tsx";
import { SignInAndDevices } from "../web-account-devices/devices.tsx";
import { YourFamily } from "../web-account-family/family.tsx";
import { YourOrders } from "../web-account-orders/orders.tsx";
import { PaymentMethod } from "../web-account-payment/payment.tsx";
import { MyAgreements } from "../web-my-agreements/my-agreements.tsx";

/** A pack's section: its key, label and order, and what it draws (the pack's block). */
export interface PackSection extends AccountSection {
  render: () => ReactNode;
}

type Hooks = Pick<
  AccountHooks,
  | "useMe"
  | "useUpdateMe"
  | "useSessions"
  | "useRevokeSession"
  | "useFamily"
  | "useOrders"
  | "useSubscriptions"
  | "useBillingPortal"
>;

export function MyAccount({
  account,
  agreements,
  sections = [],
  returnUrl,
  onSignOut,
}: {
  account: Hooks;
  agreements: Pick<AgreementsHooks, "useDue" | "useMine" | "useAcceptance" | "useAccept">;
  /** The packs' sections. */
  sections?: readonly PackSection[];
  /** Where the payment provider's page sends the customer back to: this page. */
  returnUrl: string;
  /** Signs this browser out (the web app's sign-out route) and leaves the page. */
  onSignOut: () => void;
}) {
  const me = account.useMe();
  const subscriptions = account.useSubscriptions();
  const packs = new Map(sections.map((s) => [s.key, s]));
  const shown = accountSections(sections, hiddenSections(subscriptions.data?.items));

  const base: Record<string, () => ReactNode> = {
    orders: () => <YourOrders account={account} />,
    agreements: () => <MyAgreements agreements={agreements} />,
    family: () => <YourFamily account={account} />,
    payment: () => <PaymentMethod account={account} returnUrl={returnUrl} />,
    details: () => <YourDetails account={account} />,
    devices: () => <SignInAndDevices account={account} onSignOut={onSignOut} />,
  };

  return (
    <main className="mx-auto grid max-w-3xl gap-8 p-4" aria-label="My account">
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold">My account</h1>
        {me.data ? <p className="text-muted-foreground">{me.data.displayName}</p> : null}
      </header>
      <nav aria-label="Sections">
        <ul className="flex flex-wrap gap-3 text-sm">
          {shown.map((section) => (
            <li key={section.key}>
              <a className="underline" href={`#account-${section.key}`}>
                {section.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {shown.map((section) => (
        <section
          key={section.key}
          id={`account-${section.key}`}
          className="grid gap-3"
          aria-labelledby={`account-${section.key}-title`}
          data-section={section.key}
        >
          <h2 id={`account-${section.key}-title`} className="text-lg font-semibold">
            {section.label}
          </h2>
          {(base[section.key] ?? packs.get(section.key)?.render)?.()}
        </section>
      ))}
    </main>
  );
}
