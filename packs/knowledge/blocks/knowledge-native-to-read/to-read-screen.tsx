// To read in the app (stage 38 step 6, ADR 0708): the same as the web's, over the native base.
// The procedures I must read and have not confirmed, oldest first, with the version to read and
// since when, and what I have confirmed; one opens in the reader (knowledge-native-procedures),
// which has Confirm at its end, and once confirmed it leaves the list. For a staff role client
// (ADR 0451), a coach's and a cleaner's too. What is mine to read is the host's answer.
import type { KnowledgeHooks } from "@composable-os/pack-knowledge/client";
import { dayWords, knowledgeRefusal, versionLine } from "@composable-os/pack-knowledge/client";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import {
  type NativeReaderHooks,
  ProcedureScreen,
} from "../knowledge-native-procedures/procedures-screen.tsx";
import { Text } from "../native-base/text.tsx";
import { theme } from "../native-base/theme.ts";

export type NativeToReadHooks = NativeReaderHooks & Pick<KnowledgeHooks, "useToRead">;

export function ToReadScreen({
  knowledge,
  openUrl,
  mediaUrl,
  width,
  locale,
}: {
  knowledge: NativeToReadHooks;
  openUrl: (url: string) => void;
  /** Absolute: the host's `/api/v1/media/<id>?w=<width>` (`hostMediaUrl(hostUrl)`). */
  mediaUrl: (id: string, width: number) => string;
  width?: number;
  locale?: string;
}) {
  const mine = knowledge.useToRead();
  const [open, setOpen] = useState<string | null>(null);
  if (open) {
    return (
      <ProcedureScreen
        knowledge={knowledge}
        id={open}
        onBack={() => {
          setOpen(null);
          void mine.refetch?.();
        }}
        openUrl={openUrl}
        mediaUrl={mediaUrl}
        {...(width ? { width } : {})}
        {...(locale ? { locale } : {})}
      />
    );
  }
  if (mine.isPending) return <Text tone="muted">Loading what you have to read…</Text>;
  if (mine.error) {
    return (
      <Text tone="danger" accessibilityRole="alert">
        {knowledgeRefusal(mine.error).message}
      </Text>
    );
  }
  const toRead = mine.data?.toRead ?? [];
  const confirmed = mine.data?.confirmed ?? [];
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={styles.title} accessibilityRole="header">
        To read
      </Text>
      {toRead.length ? (
        <View style={styles.list}>
          {toRead.map((p) => (
            <Pressable
              key={p.id}
              accessibilityRole="button"
              accessibilityLabel={`Read ${p.title ?? "the procedure"}`}
              onPress={() => setOpen(p.id)}
              style={styles.row}
            >
              <Text style={styles.rowTitle}>{p.title ?? "Untitled"}</Text>
              <Text tone="muted">
                {versionLine(p.version, p.publishedAt, locale)} · to read since{" "}
                {dayWords(p.since, locale)}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <Text>Nothing to read: you are up to date.</Text>
      )}
      {confirmed.length ? (
        <>
          <Text style={styles.groupTitle} accessibilityRole="header">
            Confirmed
          </Text>
          <View style={styles.list}>
            {confirmed.map((p) => (
              <Pressable
                key={p.id}
                accessibilityRole="button"
                accessibilityLabel={`Open ${p.title ?? "the procedure"}`}
                onPress={() => setOpen(p.id)}
                style={styles.row}
              >
                <Text style={styles.rowTitle}>{p.title ?? "Untitled"}</Text>
                <Text tone="muted">
                  Confirmed on {dayWords(p.confirmedAt, locale)}: counts for version {p.version}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: theme.space.md, gap: theme.space.md },
  title: { fontSize: theme.font.title, fontWeight: "700", color: theme.color.text },
  groupTitle: { fontSize: theme.font.body, fontWeight: "700", color: theme.color.text },
  list: { borderRadius: theme.radius, backgroundColor: theme.color.surface, overflow: "hidden" },
  row: {
    paddingVertical: theme.space.sm + 4,
    paddingHorizontal: theme.space.md,
    gap: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.border,
  },
  rowTitle: { fontSize: theme.font.body, fontWeight: "600", color: theme.color.text },
});
