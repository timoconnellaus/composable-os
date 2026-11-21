// A member's day, for the mobile app (stage 41): their own sessions on a date; pressing one opens
// it (the app's navigation, `onOpen`). Which sessions are theirs is the host's (`useToday`).
import type { PlannedSession, ProgramsHooks } from "@composable-os/pack-programs/client";
import { Text } from "react-native";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { Screen } from "../native-base/screen.tsx";

export function TodayScreen({
  programs,
  date,
  onOpen,
}: {
  programs: ProgramsHooks;
  /** The member's local date (YYYY-MM-DD). */
  date?: string;
  onOpen: (session: PlannedSession) => void;
}) {
  const today = programs.useToday(date ? { date } : {});
  return (
    <Screen title="Today">
      {today.isPending ? <Text>Loading…</Text> : null}
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
