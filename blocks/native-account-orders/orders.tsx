// Orders (stage 48), for the mobile app: the signed-in customer's orders, newest first, each with
// its state, its lines, tax, deposit, what was paid, what is still to pay and by when, and what was
// refunded. Every figure is the host's, shown in the order's currency (my.list on `order` and
// `orderLine`: their own orders only, never a child's). It shows money and pays nothing: paying a
// balance is on the website (ADR 0714). A paid order's receipt is the payment provider's email
// until the host has a receipt document (stage 35).
import {
  type AccountHooks,
  type AccountOrder,
  accountDay,
  formatMinor,
  ORDERS_PAGE,
  orderMoney,
  orderStateWords,
  RECEIPT_EMAILED_WORDS,
  showsReceiptNote,
} from "@composable-os/client";
import { useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { theme } from "../native-base/theme.ts";

type Hooks = Pick<AccountHooks, "useOrders">;

export function YourOrders({
  account,
  openUrl,
}: {
  account: Hooks;
  /** Opens a receipt's address, once the host has one (React Native's `Linking.openURL`). */
  openUrl?: (url: string) => void;
}) {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  return (
    <View style={styles.part}>
      {cursors.map((cursor, i) => (
        <OrdersPage
          key={cursor ?? "first"}
          account={account}
          cursor={cursor}
          first={i === 0}
          last={i === cursors.length - 1}
          onMore={(next) => setCursors([...cursors, next])}
          openUrl={openUrl}
        />
      ))}
    </View>
  );
}

function OrdersPage({
  account,
  cursor,
  first,
  last,
  onMore,
  openUrl,
}: {
  account: Hooks;
  cursor: string | undefined;
  first: boolean;
  last: boolean;
  onMore: (cursor: string) => void;
  openUrl?: (url: string) => void;
}) {
  const page = account.useOrders(cursor);
  if (page.isPending) return <ActivityIndicator color={theme.color.muted} />;
  if (page.error || !page.data) {
    return (
      <Text style={styles.body} accessibilityRole="alert">
        We could not load your orders.
      </Text>
    );
  }
  const { orders, nextCursor } = page.data;
  if (first && !orders.length) return <Text style={styles.muted}>You have no orders yet.</Text>;
  return (
    <>
      {orders.map((order) => (
        <OrderCard key={order.id} order={order} openUrl={openUrl} />
      ))}
      {last && nextCursor ? (
        <Button
          quiet
          label={`Show ${ORDERS_PAGE} older orders`}
          onPress={() => onMore(nextCursor)}
        />
      ) : null}
    </>
  );
}

function OrderCard({ order, openUrl }: { order: AccountOrder; openUrl?: (url: string) => void }) {
  const receipt = order.receiptUrl;
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>{accountDay(order.createdAt)}</Text>
      <Text style={styles.body}>{orderStateWords(order)}</Text>
      {order.lines.map((line) => (
        <View key={line.id} style={styles.line}>
          <Text style={styles.body}>
            {line.quantity > 1 ? `${line.title} (${line.quantity})` : line.title}
          </Text>
          <Text style={styles.body}>{formatMinor(line.total, order.currency)}</Text>
        </View>
      ))}
      {orderMoney(order).map((row) => (
        <View key={row.key} style={styles.line}>
          <Text style={styles.muted}>{row.label}</Text>
          <Text style={styles.body}>{row.value}</Text>
        </View>
      ))}
      {receipt && openUrl ? (
        <Button quiet label="Open receipt" onPress={() => openUrl(receipt)} />
      ) : showsReceiptNote(order) ? (
        <Text style={styles.muted}>{RECEIPT_EMAILED_WORDS}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  part: { gap: theme.space.md },
  card: {
    gap: theme.space.xs,
    padding: theme.space.md,
    borderRadius: theme.radius,
    backgroundColor: theme.color.surface,
  },
  line: { flexDirection: "row", justifyContent: "space-between", gap: theme.space.sm },
  heading: { fontSize: theme.font.body, fontWeight: "600", color: theme.color.text },
  body: { fontSize: theme.font.body, color: theme.color.text },
  muted: { fontSize: theme.font.small, color: theme.color.muted },
});
