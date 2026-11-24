// The inline agreement step for the app (stage 44 step 5): shown when the host refused a booking
// with what must be agreed to first. Each document the refusal named, in turn, recorded at once
// (me.agreements.accept) for the member or a child linked to them; then the caller tries again.
// The app never buys, so there is no visitor's step here.
import {
  type AgreementsHooks,
  copyWords,
  dueForRefusal,
  dueReasonWords,
  forgetAfter,
  type RefusedDocument,
} from "@composable-os/client";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Button } from "../native-base/button.tsx";
import { theme } from "../native-base/theme.ts";
import { Agree } from "./agree-screen.tsx";

export function MemberAgreementStep({
  agreements,
  documents,
  continueLabel = "Agree and continue",
  onAgreed,
  onCancel,
  onDrawing,
}: {
  agreements: Pick<AgreementsHooks, "useDue" | "useAccept">;
  documents: RefusedDocument[];
  continueLabel?: string;
  onAgreed: (said: string | null) => void;
  onCancel: () => void;
  onDrawing?: (drawing: boolean) => void;
}) {
  const due = agreements.useDue();
  const accept = agreements.useAccept();
  const [said, setSaid] = useState<string | null>(null);
  const steps = due.data ? dueForRefusal(due.data.people, documents) : null;
  // Agreed to here: once nothing named is due, the caller tries again, once. When nothing was
  // due to begin with, the person says when: never a loop of calls.
  const agreedHere = useRef(false);
  const done = useRef(false);
  useEffect(() => {
    if (steps && steps.length === 0 && agreedHere.current && !done.current) {
      done.current = true;
      onAgreed(said);
    }
  });
  if (due.isPending || (steps && !steps.length && agreedHere.current)) {
    return <ActivityIndicator color={theme.color.muted} />;
  }
  if (steps && !steps.length) {
    return (
      <View style={styles.wrap}>
        <Text style={styles.body}>There is nothing left here for you to agree to.</Text>
        <Button label="Try again" onPress={() => onAgreed(null)} />
        <Button quiet label="Back" onPress={onCancel} />
      </View>
    );
  }
  if (due.error || !steps) {
    return (
      <View style={styles.wrap}>
        <Text style={styles.body} accessibilityRole="alert">
          We could not load what to agree to. Try again soon.
        </Text>
        <Button quiet label="Back" onPress={onCancel} />
      </View>
    );
  }
  const step = steps[0];
  if (!step) return null;
  const { person, item } = step;
  return (
    <View style={styles.wrap}>
      <Text style={styles.body}>
        {steps.length === 1
          ? "One thing to agree to first."
          : `${steps.length} things to agree to first. This is the first.`}
      </Text>
      {said ? <Text style={styles.body}>{said}</Text> : null}
      {person.canAgree ? (
        <Agree
          key={`${person.personId}:${item.version.id}`}
          version={item.version}
          forName={person.self ? null : person.name}
          reason={item.reason}
          submitLabel={steps.length === 1 ? continueLabel : "Agree"}
          secondary={{ label: "Back", onPress: onCancel }}
          onDrawing={onDrawing}
          onAgree={async (input) => {
            const accepted = await forgetAfter(accept, {
              ...input,
              ...(person.self ? {} : { forPersonId: person.personId }),
            });
            agreedHere.current = true;
            setSaid(copyWords(accepted));
            await due.refetch?.();
          }}
        />
      ) : (
        <View style={styles.wrap}>
          <Text style={[styles.body, styles.bold]}>{item.title}</Text>
          <Text style={styles.body} accessibilityRole="alert">
            {dueReasonWords("guardian")}
          </Text>
          <Text style={styles.body}>
            A parent or guardian linked to you agrees to it from their own account, or the business
            records a paper form they signed.
          </Text>
          <Button quiet label="Back" onPress={onCancel} />
        </View>
      )}
    </View>
  );
}

/**
 * The step on a screen of its own (a modal over the list), never inside a scrolling list: the
 * modal's own scroll holds still while a signature is drawn, so a stroke never becomes a scroll.
 */
export function AgreementStepModal(props: Parameters<typeof MemberAgreementStep>[0]) {
  const [drawing, setDrawing] = useState(false);
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onCancel}
    >
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.content} scrollEnabled={!drawing}>
          <MemberAgreementStep
            {...props}
            onDrawing={(now) => {
              setDrawing(now);
              props.onDrawing?.(now);
            }}
          />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.background },
  content: { padding: theme.space.md },
  wrap: { gap: theme.space.md },
  body: { fontSize: theme.font.body, color: theme.color.text },
  bold: { fontWeight: "600" },
});
