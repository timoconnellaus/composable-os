// A member's day, for the mobile app (stage 41): their own sessions on a date; pressing one opens
// it (the app's navigation, `onOpen`). Which sessions are theirs is the host's (`useToday`). Sets
// logged in a session and not saved yet (no connection in the gym) are said here too, and sent
// again when the app comes back or goes to the background (`useUnsavedSets`).
import type { PlannedSession, ProgramsHooks } from "@composable-os/pack-programs/client";
import { useEffect } from "react";
import { AppState, StyleSheet, View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { Screen } from "../native-base/screen.tsx";
import { Text } from "../native-base/text.tsx";
import { theme } from "../native-base/theme.ts";

export function TodayScreen({
  programs,
  date,
  onOpen,
}: {
  programs: Pick<ProgramsHooks, "useToday" | "useUnsavedSets">;
  /** The member's local date (YYYY-MM-DD). */
  date?: string;
  onOpen: (session: PlannedSession) => void;
}) {
  const today = programs.useToday(date ? { date } : {});
  const unsaved = programs.useUnsavedSets();
  const { flush } = unsaved;
  useEffect(() => {
    const sub = AppState.addEventListener("change", () => void flush());
    return () => sub.remove();
  }, [flush]);
  return (
    <Screen title="Today">
      {unsaved.count ? (
        <View style={styles.warning} accessibilityLiveRegion="polite">
          <Text>
            {unsaved.count === 1 ? "1 set is" : `${unsaved.count} sets are`} not saved yet.{" "}
            {unsaved.failure ?? "Sending…"}
          </Text>
          <Button quiet label="Try now" onPress={() => void flush()} />
        </View>
      ) : null}
      {today.isPending ? (
        <Text tone="muted" accessibilityRole="progressbar">
          Loading…
        </Text>
      ) : null}
      {today.error ? (
        <Text tone="danger" accessibilityRole="alert">
          We could not load today's sessions. Check the connection and try again.
        </Text>
      ) : null}
      {today.data ? (
        <List empty="Nothing planned today.">
          {today.data.sessions.map((s) => (
            <Row
              key={s.id}
              title={s.name ?? "Session"}
              detail={[s.programTitle, s.state === "done" ? "Done" : null]
                .filter(Boolean)
                .join(" · ")}
              onPress={() => onOpen(s)}
            />
          ))}
        </List>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  warning: {
    gap: theme.space.sm,
    padding: theme.space.sm,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.color.danger,
  },
});
