// My account (stage 48), for the web: the signed-in customer's own area, one page of sections.
// The base sections come with it: Orders, Agreements, Family, Payment method (only for someone who
// pays a subscription), Your details, and Sign-in and devices. The packs' sections are passed in
// `sections`, each the pack's own block, and take their place by `order` (a pack's come first).
//
// It decides nothing: which sections this customer has, in what order, and whether Payment method
// shows is the host's answer (me.portal, ADR 0710); what each section shows is the host's answer to
// the section's own call. `cos add web-account` copies the packs' section blocks and writes
// `../account-sections.gen.ts`, which names them; the page passes them through `usePackSections`:
//
//   import { ACCOUNT_SECTIONS } from "../blocks/account-sections.gen.ts";
//   const react = { useQuery, useMutation, useState, useEffect }; // at module level: made once
//   const sections = usePackSections(ACCOUNT_SECTIONS, react, api, returnUrl);
//   <MyAccount account={account} agreements={agreements} sections={sections} … />
//
// so the page names no pack. A later step adds "Needs your attention" at the top (me.attention).
import {
  type AccountHooks,
  type AccountSection,
  type AccountSectionEntry,
  type AgreementsHooks,
  portalSections,
} from "@composable-os/client";
import { type ComponentType, createElement, type ReactNode, useMemo } from "react";
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

/** A section `account-sections.gen.ts` lists: a pack's web block's component and its hooks. */
export type WebSectionEntry = AccountSectionEntry<ComponentType<never>>;

/**
 * The packs' sections, from `account-sections.gen.ts`: each pack's hooks made once with the app's
 * React functions and its generated client, and its block given them under the pack's id, with
 * the page's `returnUrl`.
 */
export function usePackSections(
  entries: readonly WebSectionEntry[],
  react: object,
  client: object,
  returnUrl: string,
): PackSection[] {
  return useMemo(
    () =>
      entries.map((entry) => {
        // Each pack's factory takes its own React and client types; the app's satisfy them all.
        const make = entry.hooks as (react: object, client: object) => unknown;
        const props = { [entry.pack]: make(react, client), returnUrl };
        const component = entry.component as ComponentType<typeof props>;
        return {
          key: entry.key,
          label: entry.label,
          order: entry.order,
          render: () => createElement(component, props),
        };
      }),
    [entries, react, client, returnUrl],
  );
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
  | "usePortal"
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
  /** The packs' sections the app has (`usePackSections`); the host says which of them show. */
  sections?: readonly PackSection[];
  /** Where the payment provider's page sends the customer back to: this page. */
  returnUrl: string;
  /** Signs this browser out (the web app's sign-out route) and leaves the page. */
  onSignOut: () => void;
}) {
  const me = account.useMe();
  const portal = account.usePortal();
  const packs = new Map(sections.map((s) => [s.key, s]));
  const shown = portalSections(portal.data, sections);

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
              <a className="underline" href={`#${anchor(section.key)}`}>
                {section.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {shown.map((section) => (
        <section
          key={section.key}
          id={anchor(section.key)}
          className="grid gap-3"
          aria-labelledby={`${anchor(section.key)}-title`}
          data-section={section.key}
        >
          <h2 id={`${anchor(section.key)}-title`} className="text-lg font-semibold">
            {section.label}
          </h2>
          {(base[section.key] ?? packs.get(section.key)?.render)?.()}
        </section>
      ))}
    </main>
  );
}

/** A section's anchor on the page: `account-orders`, `account-memberships-memberships`. */
const anchor = (key: string) => `account-${key.replace(/\./g, "-")}`;
