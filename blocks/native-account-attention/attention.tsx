// Needs your attention (stage 48), for the mobile app: the top of the Account tab. What needs the
// signed-in customer, or a child they act for, soonest first, each saying whose it is when it is a
// child's, and opening where it is dealt with: a section of My account (`onSection`), the form
// they were asked to fill in (`onFillForm`, where the app has the form's screen), or, for a
// payment their bank waits on and for the rest of an order to pay, the business's website
// (`onManage`): money in the app opens the website, never the payment provider's page (ADR 0714). What needs attention is the host's
// answer (me.attention, ADR 0711); where an item leads is a lookup among the host's sections.
import {
  type AccountHooks,
  type AccountSection,
  type AttentionTarget,
  attentionTarget,
  attentionWords,
} from "@composable-os/client";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { theme } from "../native-base/theme.ts";

type Hooks = Pick<AccountHooks, "useAttention"> & Partial<Pick<AccountHooks, "useSubscriptions">>;

export function NeedsAttention({
  account,
  sections,
  onSection,
  onManage,
  onFillForm,
}: {
  account: Hooks;
  /** The sections the tab shows, as the host listed them. */
  sections: readonly AccountSection[];
  /** Opens a section of My account. */
  onSection: (key: string) => void;
  /** Opens the business's website account page in the browser. */
  onManage: () => void;
  /** Opens a form the customer was asked to fill in, by its personal link's id. */
  onFillForm?: (linkId: string) => void;
}) {
  const attention = account.useAttention();
  const subscriptions = account.useSubscriptions?.();
  if (attention.isPending) return <ActivityIndicator color={theme.color.muted} />;
  if (attention.error || !attention.data) {
    return (
      <Text style={styles.body} accessibilityRole="alert">
        We could not check what needs your attention.
      </Text>
    );
  }
  const open = (target: AttentionTarget | null) => {
    if (!target) return undefined;
    // Money owed on an order is paid on the website, never in the app (ADR 0714).
    if (target.kind === "section" && target.order) return onManage;
    if (target.kind === "section") return () => onSection(target.key);
    // The provider's page is the website's to open, never the app's.
    if (target.kind === "page") return onManage;
    return onFillForm ? () => onFillForm(target.link) : undefined;
  };
  return (
    <View style={styles.part}>
      <Text style={styles.title}>Needs your attention</Text>
      <List empty="Nothing needs your attention.">
        {attention.data.items.map((item) => {
          const words = attentionWords(item);
          return (
            <Row
              key={item.key}
              title={words.whose ? `${words.whose}: ${words.title}` : words.title}
              detail={words.detail || undefined}
              onPress={open(attentionTarget(item, sections, subscriptions?.data?.items))}
            />
          );
        })}
      </List>
    </View>
  );
}

const styles = StyleSheet.create({
  part: { gap: theme.space.sm },
  title: { fontSize: theme.font.body, fontWeight: "600", color: theme.color.text },
  body: { fontSize: theme.font.body, color: theme.color.text },
});
