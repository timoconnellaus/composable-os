// A class type's sessions for a day, for the mobile app (stage 41): pick the class, open its
// session to choose the level taken and log (`onOpen`, the app's navigation, to the session
// screen). Which sessions a class has, and what a member reads of them, are the host's.
import type { PlannedSession, ProgramsHooks } from "@composable-os/pack-programs/client";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { Screen } from "../native-base/screen.tsx";

export function ClassTodayScreen({
  programs,
  date,
  onOpen,
}: {
  programs: Pick<ProgramsHooks, "useClassToday" | "useClassTypes">;
  date?: string;
  onOpen: (session: PlannedSession) => void;
}) {
  const types = programs.useClassTypes();
  const [chosen, setChosen] = useState<string | null>(null);
  const id = chosen ?? (types.data?.items[0]?.id as string | undefined) ?? "none";
  const classes = programs.useClassToday({ classTypeId: id, ...(date ? { date } : {}) });
  return (
    <Screen title="Class">
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {(types.data?.items ?? []).map((t) => (
          <Button
            key={t.id}
            quiet={t.id !== id}
            label={String(t.values.name ?? "Class")}
            onPress={() => setChosen(t.id)}
          />
        ))}
      </View>
      {classes.isPending ? <Text>Loading…</Text> : null}
      {classes.data ? (
        <List empty="No class session today.">
          {classes.data.sessions.map((s) => (
            <Row
              key={s.id}
              title={s.name ?? "Session"}
              detail={s.classTypeName}
              onPress={() => onOpen(s)}
            />
          ))}
        </List>
      ) : null}
    </Screen>
  );
}
