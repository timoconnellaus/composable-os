// One ticket with its code, for the mobile app (stage 27): a QR carrying the code alone, large on
// a white card, with the screen at full brightness while it is shown and as it was afterwards.
// The app gives the QR drawing and the brightness control it uses (for example
// `react-native-qrcode-svg` and `expo-brightness`), so this block needs neither package.
import { type ComponentType, useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Screen } from "../native-base/screen.tsx";
import { theme } from "../native-base/theme.ts";

/** Draws a QR code of `value`. */
export type QrCode = ComponentType<{ value: string; size: number }>;

/** The screen's brightness, from 0 to 1. */
export interface Brightness {
  get(): Promise<number>;
  set(level: number): Promise<void>;
}

export function TicketScreen({
  ticket,
  title,
  detail,
  Qr,
  brightness,
}: {
  ticket: { code: string | null; state: string | null };
  title: string;
  detail?: string | null;
  Qr: QrCode;
  brightness?: Brightness;
}) {
  useEffect(() => {
    if (!brightness) return;
    let before: number | null = null;
    let left = false;
    brightness
      .get()
      .then((level) => {
        before = level;
        return left ? undefined : brightness.set(1);
      })
      .catch(() => undefined);
    return () => {
      left = true;
      if (before !== null) brightness.set(before).catch(() => undefined);
    };
  }, [brightness]);

  const usable = ticket.state === "valid" && ticket.code;
  return (
    <Screen title={title}>
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      <View style={styles.card} accessible accessibilityLabel="Ticket code">
        {usable ? (
          <Qr value={ticket.code as string} size={240} />
        ) : (
          <Text style={styles.detail}>
            {ticket.state === "used" ? "This ticket has been used." : "This ticket is not valid."}
          </Text>
        )}
      </View>
      {ticket.code ? (
        <Text selectable style={styles.code}>
          {ticket.code}
        </Text>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.color.codeBackground,
    borderRadius: theme.radius,
    padding: theme.space.lg,
    marginVertical: theme.space.md,
  },
  code: {
    textAlign: "center",
    fontSize: theme.font.small,
    color: theme.color.muted,
    letterSpacing: 1,
  },
  detail: { fontSize: theme.font.body, color: theme.color.muted },
});
