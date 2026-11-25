// My account (stage 48), for the mobile app's Account tab: the signed-in customer's own area, a
// list of sections, each opening on its own screen. The base sections come with it: Orders,
// Agreements, Family, Payment method (only for someone who pays a subscription), Your details, and
// Sign-in and devices. The packs' sections are passed in `sections`, each the pack's own screen,
// and take their place by `order` (a pack's come first).
//
// Money in the app is the website's (ADR 0490, ADR 0714): the app shows orders and subscriptions,
// and the card, cancelling and changing plan open the business's website account page in the
// browser (`websiteUrl`). No block here calls a billing operation.
//
// Which sections this customer has, in what order, and whether Payment method shows is the host's
// answer (me.portal, ADR 0710). `cos add native-account` copies the packs' section blocks and
// writes `../account-sections.gen.ts`, which names them; the tab passes them through
// `usePackSections(ACCOUNT_SECTIONS, react, api)`, so it names no pack. A later step adds "Needs
// your attention" at the top (me.attention).
import {
  type AccountHooks,
  type AccountSection,
  type AccountSectionEntry,
  type AgreementsHooks,
  portalSections,
} from "@composable-os/client";
import { type ComponentType, createElement, type ReactNode, useMemo, useState } from "react";
import { Linking, SafeAreaView, StyleSheet, Text, View } from "react-native";
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

/** A pack's section: its key, label and order, and the screen it opens (the pack's block). */
export interface PackSection extends AccountSection {
  render: () => ReactNode;
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
          render: () => createElement(component, props),
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
  | "useRevokeSession"
  | "useFamily"
  | "useOrders"
  | "useSubscriptions"
  | "usePortal"
>;

export function AccountScreen({
  account,
  agreements,
  sections = [],
  websiteUrl,
  onSignOut,
  openUrl = (url) => void Linking.openURL(url),
  onDownload,
}: {
  account: Hooks;
  agreements: Pick<AgreementsHooks, "useDue" | "useMine" | "useAcceptance" | "useAccept">;
  /** The packs' sections the app has (`usePackSections`); the host says which of them show. */
  sections?: readonly PackSection[];
  /** The business's website account page, where money is managed. */
  websiteUrl: string;
  /** Signs this device out and goes back to sign-in. */
  onSignOut: () => void;
  /** Opens an address in the browser. Default: React Native's `Linking.openURL`. */
  openUrl?: (url: string) => void;
  /** Opens a signed agreement's PDF (the app fetches it with its session). */
  onDownload?: (acceptanceId: string) => void;
}) {
  const me = account.useMe();
  const portal = account.usePortal();
  const [open, setOpen] = useState<string | null>(null);
  const shown = portalSections(portal.data, sections);
  const packs = new Map(sections.map((s) => [s.key, s]));
  const manage = () => openUrl(websiteUrl);

  // Each base section's content; the shell gives it a screen. Agreements is a screen of its own.
  const base: Record<string, () => ReactNode> = {
    orders: () => <YourOrders account={account} openUrl={openUrl} />,
    family: () => <YourFamily account={account} />,
    payment: () => <PaymentMethod onManage={manage} />,
    details: () => <YourDetails account={account} />,
    devices: () => <SignInAndDevices account={account} onSignOut={onSignOut} />,
  };

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
          packs.get(section.key)?.render()
        )}
      </View>
    );
  }

  return (
    <Screen title="My account">
      {me.data ? <Text style={styles.muted}>{me.data.displayName}</Text> : null}
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
