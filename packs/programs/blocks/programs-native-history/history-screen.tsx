// A person's past sessions, for the mobile app (stage 41): newest first, each with its date, its
// name and how many of its sets were logged; pressing one shows it set by set, read-only, and a
// logged set can be corrected. For a member (their own) or a coach (`personId`, a client's).
// It holds no rules: whose sessions they are and what a correction may change are the host's
// (`x.programs.logUpdate`: the numbers done, effort and the note).
import {
  correctionOf,
  describeDone,
  describeSet,
  type LoggedSet,
  type PastSessionsHooks,
  type ProgramsHooks,
  pastSessionsHook,
  type Session,
  sessionSets,
} from "@composable-os/pack-programs/client";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { Field } from "../native-base/field.tsx";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { Screen } from "../native-base/screen.tsx";
import { theme } from "../native-base/theme.ts";

type HistoryHooks = PastSessionsHooks & Pick<ProgramsHooks, "useSession" | "useUpdateSet">;

export function HistoryScreen({
  programs,
  personId,
  until,
}: {
  /** A member's hooks (`usePastSessions`), or a coach's (`useClientPastSessions`). */
  programs: HistoryHooks;
  /** A coach's client. A member is always themselves. */
  personId?: string;
  /** The last date listed: the person's local today. Default today, UTC. */
  until?: string;
}) {
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const usePastPage = pastSessionsHook(programs, personId);
  const page = usePastPage({
    ...(until ? { until } : {}),
    ...(cursor ? { cursor } : {}),
  });
  const [open, setOpen] = useState<string | null>(null);
  if (open)
    return (
      <PastSessionScreen
        programs={programs}
        sessionId={open}
        personId={personId}
        onBack={() => {
          setOpen(null);
          page.refetch?.();
        }}
      />
    );
  if (page.isPending)
    return (
      <Screen title="History">
        <Text>Loading…</Text>
      </Screen>
    );
  if (!page.data)
    return (
      <Screen title="History">
        <Text>We could not load past sessions.</Text>
      </Screen>
    );
  const { sessions, nextCursor } = page.data;
  return (
    <Screen title="History">
      <List empty="No past sessions yet.">
        {sessions.map((s) => (
          <Row
            key={s.id}
            title={`${s.date ?? ""} · ${s.name ?? "Session"}`}
            detail={[
              `${s.setsDone} of ${s.setsPlanned} sets`,
              s.programTitle,
              s.state === "skipped" ? "skipped" : null,
            ]
              .filter(Boolean)
              .join(" · ")}
            onPress={() => setOpen(s.id)}
          />
        ))}
      </List>
      <View style={styles.row}>
        {cursor ? (
          <Button quiet label="Newer" onPress={() => setCursors((c) => c.slice(0, -1))} />
        ) : null}
        {nextCursor ? (
          <Button quiet label="Older" onPress={() => setCursors((c) => [...c, nextCursor])} />
        ) : null}
      </View>
    </Screen>
  );
}

function PastSessionScreen({
  programs,
  sessionId,
  personId,
  onBack,
}: {
  programs: Pick<ProgramsHooks, "useSession" | "useUpdateSet">;
  sessionId: string;
  personId: string | undefined;
  onBack: () => void;
}) {
  const detail = programs.useSession({ sessionId, ...(personId ? { personId } : {}) });
  if (!detail.data)
    return (
      <Screen title="Session">
        <Text>{detail.isPending ? "Loading…" : "We could not load this session."}</Text>
        <Button quiet label="Back" onPress={onBack} />
      </Screen>
    );
  const { session, exercises, logged } = detail.data;
  const names = new Map(exercises.map((e) => [e.id, e.name]));
  const sets = sessionSets(session.plan as unknown as Session | null, logged);
  return (
    <Screen title={session.name ?? "Session"}>
      <Button quiet label="Back" onPress={onBack} />
      <Text style={styles.muted}>
        {[session.programTitle, session.date, session.focus].filter(Boolean).join(" · ")}
      </Text>
      {sets.map((s) => (
        <View key={`${s.item}-${s.exercise}-${s.setNumber}`} style={styles.set}>
          <Text style={styles.heading}>
            {s.item} · {s.logged?.exerciseName ?? names.get(s.exercise) ?? "Exercise"}
            {s.level !== null ? ` · level ${s.level}` : ""}
          </Text>
          <Text style={styles.muted}>
            Set {s.setNumber}
            {s.target ? `: ${describeSet(s.target)}` : ""}
          </Text>
          {s.logged ? (
            <NativeLogged
              programs={programs}
              set={s.logged}
              timed={s.target ? s.target.kind !== "reps" : s.logged.actual.seconds !== null}
              onCorrected={() => detail.refetch?.()}
            />
          ) : (
            <Text style={styles.muted}>Not logged</Text>
          )}
        </View>
      ))}
      {!sets.length ? <Text>This session has no sets.</Text> : null}
    </Screen>
  );
}

function NativeLogged({
  programs,
  set,
  timed,
  onCorrected,
}: {
  programs: Pick<ProgramsHooks, "useUpdateSet">;
  set: LoggedSet;
  timed: boolean;
  onCorrected: () => void;
}) {
  const update = programs.useUpdateSet();
  const [editing, setEditing] = useState(false);
  const [count, setCount] = useState("");
  const [load, setLoad] = useState("");
  const [effort, setEffort] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!editing)
    return (
      <View style={styles.row}>
        <Text>
          {describeDone(set)}
          {set.recordedAs === "staff" && set.recordedByName ? ` · by ${set.recordedByName}` : ""}
          {set.note ? ` · ${set.note}` : ""}
        </Text>
        <Button
          quiet
          label="Correct"
          onPress={() => {
            setCount(String((timed ? set.actual.seconds : set.actual.reps) ?? ""));
            setLoad(String(set.actual.load ?? ""));
            setEffort(String(set.rpe ?? ""));
            setNote(set.note ?? "");
            setError(null);
            setEditing(true);
          }}
        />
      </View>
    );
  return (
    <View style={styles.form}>
      <View style={styles.row}>
        <Field
          label={timed ? "Seconds" : "Reps"}
          keyboardType="numeric"
          value={count}
          onChangeText={setCount}
        />
        <Field label="kg" keyboardType="decimal-pad" value={load} onChangeText={setLoad} />
        <Field label="RPE" keyboardType="decimal-pad" value={effort} onChangeText={setEffort} />
      </View>
      <Field label="Note" value={note} onChangeText={setNote} error={error} />
      <View style={styles.row}>
        <Button
          label="Save"
          busy={update.isPending}
          onPress={async () => {
            const correction = correctionOf(set, { count, load, rpe: effort, note }, timed);
            if (!correction) {
              setEditing(false);
              return;
            }
            setError(null);
            try {
              await update.mutateAsync(correction);
              setEditing(false);
              onCorrected();
            } catch (e) {
              setError((e as { message?: string }).message ?? "Not corrected");
            }
          }}
        />
        <Button quiet label="Cancel" onPress={() => setEditing(false)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  muted: { color: theme.color.muted, fontSize: theme.font.small },
  heading: { fontSize: theme.font.body, fontWeight: "600", color: theme.color.text },
  set: {
    gap: theme.space.xs,
    padding: theme.space.sm,
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius,
  },
  form: { gap: theme.space.sm },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.sm },
});
