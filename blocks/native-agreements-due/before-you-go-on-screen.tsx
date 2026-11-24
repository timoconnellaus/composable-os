// "Before you go on" (stage 44 step 5), for the mobile app: after sign-in, when the host says
// something is due (me.agreements.due), each due document in turn, the member's own first, then
// each child's; "Not now" goes on to the app. A convenience only: the host refuses a booking while
// anything it needs is due, whatever this screen did.
import {
  type AgreementsHooks,
  copyWords,
  dueReasonWords,
  dueSteps,
  forgetAfter,
} from "@composable-os/client";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ActivityIndicator, SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";
import { Agree } from "../native-agree/agree-screen.tsx";
import { Button } from "../native-base/button.tsx";
import { theme } from "../native-base/theme.ts";

export function BeforeYouGoOnScreen({
  agreements,
  onDone,
}: {
  agreements: Pick<AgreementsHooks, "useDue" | "useAccept">;
  /** Go on into the app: nothing was due, everything is agreed, or "Not now". */
  onDone: () => void;
}) {
  const due = agreements.useDue();
  const accept = agreements.useAccept();
  const [said, setSaid] = useState<string | null>(null);
  const [passed, setPassed] = useState<string[]>([]);
  // A signature is being drawn: the screen holds still under the finger.
  const [drawing, setDrawing] = useState(false);
  const agreedAny = useRef(false);
  const steps = due.data
    ? dueSteps(due.data.people).filter(
        (s) => !passed.includes(`${s.person.personId}:${s.item.documentId}`),
      )
    : null;
  const nothingAtAll = !!due.data && dueSteps(due.data.people).length === 0 && !agreedAny.current;
  useEffect(() => {
    if (nothingAtAll) onDone();
  }, [nothingAtAll, onDone]);

  let content: ReactNode;
  if (due.isPending || nothingAtAll) content = <ActivityIndicator color={theme.color.muted} />;
  else if (due.error || !steps) {
    content = (
      <>
        <Text style={styles.body} accessibilityRole="alert">
          We could not check what is left to agree to. You can carry on for now.
        </Text>
        <Button label="Carry on" onPress={onDone} />
      </>
    );
  } else if (!steps[0]) {
    content = (
      <>
        <Text style={styles.title} accessibilityRole="header">
          You are all set
        </Text>
        {said ? <Text style={styles.body}>{said}</Text> : null}
        <Button label="Carry on" onPress={onDone} />
      </>
    );
  } else {
    const { person, item } = steps[0];
    const key = `${person.personId}:${item.documentId}`;
    content = (
      <>
        <Text style={styles.title} accessibilityRole="header">
          Before you go on
        </Text>
        <Text style={styles.body}>
          {steps.length === 1
            ? "There is one thing to read and agree to."
            : `There are ${steps.length} things to read and agree to. You can do them now, or later before you book.`}
        </Text>
        {said ? <Text style={styles.body}>{said}</Text> : null}
        {person.canAgree ? (
          <Agree
            key={`${key}:${item.version.id}`}
            version={item.version}
            forName={person.self ? null : person.name}
            reason={item.reason}
            secondary={{ label: "Not now", onPress: onDone }}
            onDrawing={setDrawing}
            onAgree={async (input) => {
              const accepted = await forgetAfter(accept, {
                ...input,
                ...(person.self ? {} : { forPersonId: person.personId }),
              });
              agreedAny.current = true;
              setSaid(copyWords(accepted));
              await due.refetch?.();
            }}
          />
        ) : (
          <View style={styles.wrap}>
            <Text style={[styles.body, styles.bold]}>{item.title}</Text>
            <Text style={styles.body}>{dueReasonWords("guardian")}</Text>
            <Text style={styles.body}>
              A parent or guardian linked to you agrees to it from their own account, or the
              business records a paper form they signed.
            </Text>
            <Button label="Next" onPress={() => setPassed([...passed, key])} />
            <Button quiet label="Not now" onPress={onDone} />
          </View>
        )}
      </>
    );
  }
  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content} scrollEnabled={!drawing}>
        <View style={styles.wrap}>{content}</View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.background },
  content: { padding: theme.space.md },
  wrap: { gap: theme.space.md },
  title: { fontSize: theme.font.title, fontWeight: "600", color: theme.color.text },
  body: { fontSize: theme.font.body, color: theme.color.text },
  bold: { fontWeight: "600" },
});
