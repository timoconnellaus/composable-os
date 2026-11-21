// The coach's view of one client, for the staff app (stage 41): their sessions, newest first;
// pressing one opens it to log on their behalf (`onOpen`, to the session screen with `personId`).
// Logging for a client is the host's; the row records the coach.
import type { ProgramsHooks } from "@composable-os/pack-programs/client";
import { Text } from "react-native";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { Screen } from "../native-base/screen.tsx";

export function CoachClientScreen({
  programs,
  personId,
  name,
  onOpen,
}: {
  programs: Pick<ProgramsHooks, "useClientSessions">;
  personId: string;
  name: string;
  onOpen: (sessionId: string) => void;
}) {
  const sessions = programs.useClientSessions(personId);
  return (
    <Screen title={name}>
      {sessions.isPending ? <Text>Loading…</Text> : null}
      {sessions.data ? (
        <List empty="No sessions yet.">
          {sessions.data.items.map((s) => (
            <Row
              key={s.id}
              title={`${String(s.values.date ?? "")} · ${String(s.values.name ?? "")}`}
              detail={String(s.values.state ?? "")}
              onPress={() => onOpen(s.id)}
            />
          ))}
        </List>
      ) : null}
    </Screen>
  );
}
