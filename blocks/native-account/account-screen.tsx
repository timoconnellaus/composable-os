// My account (stage 48), for the mobile app's Account tab: the signed-in customer's own area, a
// list of sections, each opening on its own screen. The base sections come with it: Orders,
// Agreements, Family, Payment method (only for someone who pays a subscription), Your details,
// Contact preferences (stage 30) and Sign-in and devices. The packs' sections are passed in `sections`, each the pack's own screen,
// and take their place by `order` (a pack's come first).
//
// Money in the app is the website's (ADR 0490, ADR 0714): the app shows orders and subscriptions,
// and the card, cancelling and changing plan open the business's website account page in the
// browser (`websiteUrl`). No block here calls a billing operation.
//
// Which sections this customer has, in what order, and whether Payment method shows is the host's
// answer (me.portal, ADR 0710). `cos add native-account` copies the packs' section blocks and
// writes `../account-sections.gen.ts`, which names them; the tab passes them through
// `usePackSections(ACCOUNT_SECTIONS, react, api)`, so it names no pack. A pack's screen is given
// `onManage`, which opens the website account page. "Needs your attention" sits at the top
// (me.attention, ADR 0711), each item opening the section that deals with it. Changing the sign-in
// address (under Your details) and Delete my account work in the app; when the host asks for a
// recent sign-in, they sign the customer in again in place through `signIn` (ADR 0712). Once the
// account is deleted, the shell's `endSession` (the app's `session.signOut`) forgets this device's
// tokens at once; the app's `onDeleted` then goes back to sign-in. Money owed on an order opens
// the website, as the card does. A base section the host lists that this copy draws nothing for
// (added to the platform later) is left out (`portalSections`' `base`).
import {
  type AccountHooks,
  type AccountSection,
  type AccountSectionEntry,
  type AccountSignIn,
  type AgreementsHooks,
  portalSections,
} from "@composable-os/client";
import { type ComponentType, createElement, type ReactNode, useMemo, useState } from "react";
import { Linking, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { NeedsAttention } from "../native-account-attention/attention.tsx";
import { ContactPreferences } from "../native-account-contact/contact.tsx";
import { DeleteAccount } from "../native-account-delete/delete.tsx";
import { YourDetails } from "../native-account-details/details.tsx";
import { SignInAndDevices } from "../native-account-devices/devices.tsx";
import { YourFamily } from "../native-account-family/family.tsx";
import { YourOrders } from "../native-account-orders/orders.tsx";
import { PaymentMethod } from "../native-account-payment/payment.tsx";
import { Button } from "../native-base/button.tsx";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { Screen } from "../native-base/screen.tsx";
import { theme } from "../native-base/theme.ts";
import { MyAgreementsScreen } from "../native-my-agreements/my-agreements-screen.tsx";

/** What the shell gives a pack's screen: "Manage on the website" opens the website account page. */
export interface ShellProps {
  onManage: () => void;
}

/** A pack's section: its key, label and order, and the screen it opens (the pack's block). */
export interface PackSection extends AccountSection {
  render: (shell: ShellProps) => ReactNode;
}

/** A section `account-sections.gen.ts` lists: a pack's native block's component and its hooks. */
export type NativeSectionEntry = AccountSectionEntry<ComponentType<never>>;

/**
 * The packs' sections, from `account-sections.gen.ts`: each pack's hooks made once with the app's
 * React functions and its generated client, and its screen given them under the pack's id.
 */
export function usePackSections(
  entries: readonly NativeSectionEntry[],
  react: object,
  client: object,
): PackSection[] {
  return useMemo(
    () =>
      entries.map((entry) => {
        // Each pack's factory takes its own React and client types; the app's satisfy them all.
        const make = entry.hooks as (react: object, client: object) => unknown;
        const props = { [entry.pack]: make(react, client) };
        const component = entry.component as ComponentType<typeof props>;
        return {
          key: entry.key,
          label: entry.label,
          order: entry.order,
          render: (shell: ShellProps) => createElement(component, { ...props, ...shell }),
        };
      }),
    [entries, react, client],
  );
}

type Hooks = Pick<
  AccountHooks,
  | "useMe"
  | "useUpdateMe"
  | "useSessions"
  | "useContactChoices"
  | "useSetContactChoices"
  | "useRevokeSession"
  | "useFamily"
  | "useOrders"
  | "useSubscriptions"
  | "usePortal"
  | "useAttention"
  | "useChangeEmail"
  | "useConfirmEmail"
  | "useDeleteAccount"
>;

export function AccountScreen({
  account,
  agreements,
  sections = [],
  websiteUrl,
  signIn,
  endSession,
  onSignOut,
  onDeleted,
  onFillForm,
  openUrl = (url) => void Linking.openURL(url),
  onDownload,
}: {
  account: Hooks;
  agreements: Pick<AgreementsHooks, "useDue" | "useMine" | "useAcceptance" | "useAccept">;
  /** The packs' sections the app has (`usePackSections`); the host says which of them show. */
  sections?: readonly PackSection[];
  /** The business's website account page, where money is managed. */
  websiteUrl: string;
  /** The app's session sign-in by code, for signing in again in place when the host asks. */
  signIn: AccountSignIn;
  /**
   * Ends this device's session and forgets its tokens (`session.signOut`): Delete my account
   * calls it as soon as the host has deleted the account.
   */
  endSession: () => Promise<unknown>;
  /** Signs this device out and goes back to sign-in. */
  onSignOut: () => void;
  /** The account is deleted and this device's tokens forgotten: back to sign-in. */
  onDeleted: () => void;
  /** Opens a form the customer was asked to fill in, by its personal link's id. */
  onFillForm?: (linkId: string) => void;
  /** Opens an address in the browser. Default: React Native's `Linking.openURL`. */
  openUrl?: (url: string) => void;
  /** Opens a signed agreement's PDF (the app fetches it with its session). */
  onDownload?: (acceptanceId: string) => void;
}) {
  const me = account.useMe();
  const portal = account.usePortal();
  const [open, setOpen] = useState<string | null>(null);
  const packs = new Map(sections.map((s) => [s.key, s]));
  const manage = () => openUrl(websiteUrl);

  // Each base section's content; the shell gives it a screen. Agreements is a screen of its own.
  const base: Record<string, () => ReactNode> = {
    orders: () => <YourOrders account={account} openUrl={openUrl} onManage={manage} />,
    family: () => <YourFamily account={account} />,
    payment: () => <PaymentMethod onManage={manage} />,
    details: () => <YourDetails account={account} signIn={signIn} />,
    contact: () => <ContactPreferences account={account} />,
    devices: () => <SignInAndDevices account={account} onSignOut={onSignOut} />,
    delete: () => (
      <DeleteAccount
        account={account}
        signIn={signIn}
        endSession={endSession}
        onDeleted={onDeleted}
      />
    ),
  };
  // Only the base sections drawn here (Agreements has its own screen): one a newer host lists
  // that this copy has no part for is left out, never shown empty.
  const shown = portalSections(portal.data, sections, [...Object.keys(base), "agreements"]);

  const section = shown.find((s) => s.key === open);
  if (section) {
    const content = base[section.key];
    return (
      <View style={styles.fill}>
        <SafeAreaView>
          <View style={styles.back}>
            <Button quiet label="Back to My account" onPress={() => setOpen(null)} />
          </View>
        </SafeAreaView>
        {content ? (
          <Screen title={section.label}>{content()}</Screen>
        ) : section.key === "agreements" ? (
          <MyAgreementsScreen agreements={agreements} onDownload={onDownload} />
        ) : (
          packs.get(section.key)?.render({ onManage: manage })
        )}
      </View>
    );
  }

  return (
    <Screen title="My account">
      {me.data ? <Text style={styles.muted}>{me.data.displayName}</Text> : null}
      <NeedsAttention
        account={account}
        sections={shown}
        onSection={setOpen}
        onManage={manage}
        onFillForm={onFillForm}
      />
      <List>
        {shown.map((s) => (
          <Row key={s.key} title={s.label} onPress={() => setOpen(s.key)} />
        ))}
      </List>
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: theme.color.background },
  back: { paddingHorizontal: theme.space.md, paddingTop: theme.space.sm },
  muted: { fontSize: theme.font.body, color: theme.color.muted },
});
