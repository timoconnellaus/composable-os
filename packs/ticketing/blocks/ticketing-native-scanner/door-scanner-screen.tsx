// The door scanner, for the staff app (stage 27): the camera reads a code, the host checks it in,
// and the screen says clearly let in or not and why, with a haptic, and counts who was let in on
// this device. Whether a ticket is valid, used or void, and what is owed, is the host's
// (`useCheckIn`); the camera and haptics are the app's (for example `expo-camera` and
// `expo-haptics`), so this block needs neither package.
import type { CheckInResult, TicketingHooks } from "@composable-os/pack-ticketing/client";
import { formatMoney } from "@composable-os/pack-ticketing/client";
import { type ComponentType, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { Screen } from "../native-base/screen.tsx";
import { theme } from "../native-base/theme.ts";

/** A camera view that calls `onCode` with each code it reads, and stops reading while paused. */
export type CodeScanner = ComponentType<{ onCode: (code: string) => void; paused: boolean }>;

/** The device's haptics. */
export interface Haptics {
  success(): void;
  error(): void;
}

export function DoorScannerScreen({
  ticketing,
  Scanner,
  haptics,
  title = "Door",
}: {
  ticketing: TicketingHooks;
  Scanner: CodeScanner;
  haptics?: Haptics;
  title?: string;
}) {
  const checkIn = ticketing.useCheckIn();
  const [result, setResult] = useState<CheckInResult | null>(null);
  const [letIn, setLetIn] = useState(0);
  const [failed, setFailed] = useState(false);

  async function scanned(code: string) {
    if (checkIn.isPending || result) return;
    setFailed(false);
    try {
      const answer = await checkIn.mutateAsync({ code });
      setResult(answer);
      if (answer.accepted) {
        setLetIn((n) => n + 1);
        haptics?.success();
      } else haptics?.error();
    } catch {
      setFailed(true);
      haptics?.error();
    }
  }

  const owing = result?.balanceOwing;
  return (
    <Screen title={title}>
      <Text style={styles.count}>Let in on this device: {letIn}</Text>
      <Scanner onCode={scanned} paused={Boolean(result) || checkIn.isPending} />
      {result ? (
        <View
          accessibilityRole="alert"
          style={[styles.result, result.accepted ? styles.accepted : styles.refused]}
        >
          <Text style={styles.verdict}>{result.accepted ? "Let in" : "Not valid"}</Text>
          <Text style={styles.message}>{result.message}</Text>
          {owing ? (
            <Text style={styles.message}>Owing: {formatMoney(owing.amount, owing.currency)}</Text>
          ) : null}
          <Button label="Scan the next" onPress={() => setResult(null)} />
        </View>
      ) : null}
      {failed ? (
        <Text accessibilityRole="alert" style={styles.message}>
          The check could not be made. Check the connection and scan again.
        </Text>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  count: { fontSize: theme.font.small, color: theme.color.muted, marginBottom: theme.space.sm },
  result: { borderRadius: theme.radius, padding: theme.space.lg, marginTop: theme.space.md },
  accepted: { backgroundColor: "#dcfce7" },
  refused: { backgroundColor: "#fee2e2" },
  verdict: { fontSize: theme.font.title, fontWeight: "700", color: theme.color.text },
  message: { fontSize: theme.font.body, color: theme.color.text, marginVertical: theme.space.sm },
});
