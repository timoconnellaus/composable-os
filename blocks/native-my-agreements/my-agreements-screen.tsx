// My agreements (stage 44 step 5), for the mobile app: what the signed-in member and each child
// linked to them has agreed to (the document, the version, when, how and by whom), what is due
// (with a notice when a document changed), the signed PDF, and a health form's answers to update.
// With `personId`, one child's only. What it shows is the host's: a name typed and a signature
// appear only to whoever agreed, and a child sees no guardian's name or signature.
//
// The PDF needs the app's own way to open a file fetched with the session (`onDownload`): the
// host's route is `agreementPdfPath(id)` on the host's address, with the access token.
import {
  type AcceptanceSummary,
  type AgreementsHooks,
  agreedByWords,
  agreementTime,
  copyWords,
  type DueDocument,
  type DuePerson,
  dueReasonWords,
  forgetAfter,
} from "@composable-os/client";
import { type ReactElement, useState } from "react";
import { ActivityIndicator, SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";
import { Agree, AgreementText } from "../native-agree/agree-screen.tsx";
import { Button } from "../native-base/button.tsx";
import { theme } from "../native-base/theme.ts";

type Hooks = Pick<AgreementsHooks, "useDue" | "useMine" | "useAcceptance" | "useAccept">;

export function MyAgreementsScreen({
  agreements,
  personId,
  onDownload,
}: {
  agreements: Hooks;
  /** One child's agreements only. Default: the member's and each child's. */
  personId?: string;
  /** Opens an acceptance's signed PDF (the app fetches it with its session). */
  onDownload?: (acceptanceId: string) => void;
}) {
  const due = agreements.useDue();
  const mine = agreements.useMine();
  const [said, setSaid] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  let content: ReactElement;
  if (due.isPending || mine.isPending) content = <ActivityIndicator color={theme.color.muted} />;
  else if (due.error || mine.error || !due.data || !mine.data) {
    content = (
      <Text style={styles.body} accessibilityRole="alert">
        We could not load your agreements. Try again soon.
      </Text>
    );
  } else {
    const me = due.data.people.find((p) => p.self)?.personId ?? null;
    const items = mine.data.items;
    content = (
      <>
        {said ? <Text style={styles.body}>{said}</Text> : null}
        {due.data.people
          .filter((p) => !personId || p.personId === personId)
          .map((person) => (
            <PersonSection
              key={person.personId}
              person={person}
              me={me}
              items={items.filter((a) => a.personId === person.personId)}
              agreements={agreements}
              onDownload={onDownload}
              onDrawing={setDrawing}
              onAgreed={(text) => {
                setSaid(text);
                due.refetch?.();
                mine.refetch?.();
              }}
            />
          ))}
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

function PersonSection({
  person,
  me,
  items,
  agreements,
  onDownload,
  onDrawing,
  onAgreed,
}: {
  person: DuePerson;
  me: string | null;
  items: AcceptanceSummary[];
  agreements: Hooks;
  onDownload: ((acceptanceId: string) => void) | undefined;
  onDrawing: (drawing: boolean) => void;
  onAgreed: (said: string) => void;
}) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.title} accessibilityRole="header">
        {person.self ? "Your agreements" : `${person.name}'s agreements`}
      </Text>
      {person.due.length ? (
        person.due.map((item) => (
          <DueItem
            key={item.documentId}
            person={person}
            item={item}
            agreements={agreements}
            onDrawing={onDrawing}
            onAgreed={onAgreed}
          />
        ))
      ) : (
        <Text style={styles.muted}>Nothing to agree to.</Text>
      )}
      {items.map((acceptance) => (
        <AcceptanceItem
          key={acceptance.id}
          acceptance={acceptance}
          me={me}
          agreements={agreements}
          onDownload={onDownload}
        />
      ))}
    </View>
  );
}

function DueItem({
  person,
  item,
  agreements,
  onDrawing,
  onAgreed,
}: {
  person: DuePerson;
  item: DueDocument;
  agreements: Pick<Hooks, "useAccept">;
  onDrawing: (drawing: boolean) => void;
  onAgreed: (said: string) => void;
}) {
  const accept = agreements.useAccept();
  const [open, setOpen] = useState(false);
  const because = dueReasonWords(person.canAgree ? item.reason : "guardian");
  return (
    <View style={styles.card}>
      <Text style={[styles.body, styles.bold]}>{item.title}</Text>
      <Text style={styles.body}>{because ?? "To read and agree to."}</Text>
      {person.canAgree && !open ? (
        <Button
          label={item.reason === "agree_again" ? "Read and agree again" : "Read and agree"}
          onPress={() => setOpen(true)}
        />
      ) : null}
      {open ? (
        <Agree
          key={item.version.id}
          version={item.version}
          forName={person.self ? null : person.name}
          reason={item.reason}
          secondary={{ label: "Close", onPress: () => setOpen(false) }}
          onDrawing={onDrawing}
          onAgree={async (input) => {
            const accepted = await forgetAfter(accept, {
              ...input,
              ...(person.self ? {} : { forPersonId: person.personId }),
            });
            setOpen(false);
            onAgreed(copyWords(accepted));
          }}
        />
      ) : null}
    </View>
  );
}

function AcceptanceItem({
  acceptance,
  me,
  agreements,
  onDownload,
}: {
  acceptance: AcceptanceSummary;
  me: string | null;
  agreements: Pick<Hooks, "useAcceptance">;
  onDownload: ((acceptanceId: string) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.card}>
      <Text style={[styles.body, styles.bold]}>
        {`${acceptance.title}, version ${acceptance.versionNumber}`}
      </Text>
      <Text style={styles.body}>
        {`${agreedByWords(acceptance, me)} · ${agreementTime(acceptance.acceptedAt)}`}
      </Text>
      <Text style={styles.muted}>
        {acceptance.counts ? "In effect" : "Replaced by a later agreement"}
      </Text>
      <Button quiet label={open ? "Hide" : "View"} onPress={() => setOpen(!open)} />
      {onDownload ? (
        <Button quiet label="Download PDF" onPress={() => onDownload(acceptance.id)} />
      ) : null}
      {open ? <AcceptanceView id={acceptance.id} agreements={agreements} /> : null}
    </View>
  );
}

function AcceptanceView({
  id,
  agreements,
}: {
  id: string;
  agreements: Pick<Hooks, "useAcceptance">;
}) {
  const detail = agreements.useAcceptance(id);
  if (detail.isPending) return <ActivityIndicator color={theme.color.muted} />;
  if (detail.error || !detail.data) {
    return <Text style={styles.body}>We could not load this agreement.</Text>;
  }
  const a = detail.data;
  return (
    <View style={styles.wrap}>
      <AgreementText version={a.version} />
      {a.answers
        ? (a.version.questions ?? []).map((q) => {
            const answer = a.answers?.find((x) => x.key === q.key);
            return (
              <Text key={q.key} style={styles.body}>
                {`${q.text} ${answer ? (answer.yes ? "Yes" : "No") : "Not answered"}${answer?.note ? `: ${answer.note}` : ""}`}
              </Text>
            );
          })
        : null}
      {a.typedName ? <Text style={styles.body}>{`Name typed: ${a.typedName}`}</Text> : null}
      {a.signature ? <Text style={styles.muted}>Signed with a drawn signature.</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.background },
  content: { padding: theme.space.md },
  wrap: { gap: theme.space.md },
  card: {
    gap: theme.space.sm,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius,
    padding: theme.space.md,
  },
  title: { fontSize: theme.font.title, fontWeight: "600", color: theme.color.text },
  body: { fontSize: theme.font.body, color: theme.color.text },
  muted: { fontSize: theme.font.small, color: theme.color.muted },
  bold: { fontWeight: "600" },
});
