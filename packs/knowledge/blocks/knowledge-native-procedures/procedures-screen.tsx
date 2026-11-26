// Procedures in the app, for staff (stage 38 step 6, ADR 0708): the same as the web's, over the
// native base. Every published procedure, by section, with search; the reader shows one in the
// wording last published ("Version 4, published 3 March 2026"), never the draft, with "I have
// read and understood this" at its end when it is the reader's to confirm. For a staff role
// client (ADR 0451): a coach's, a cleaner's, the door's too.
//
// The host decides everything (ADRs 0701, 0702): what is published and its version, who must
// read it, and whether a confirmation counts. The button confirms the version on screen, never
// the one the list names; a refusal (a newer version, already confirmed) is shown, never taken
// as done. Rich text is the Content pack's native renderer (`content-native-rich-text`). Each
// procedure's section is the name the host gives with it (`names.section`, ADR 0708). A pack-role
// account is not served a procedure's pictures (the host's media rule): a picture it cannot have
// says so in its place.

import type { RichText as RichTextValue } from "@composable-os/pack-content/client";
import type {
  KnowledgeHooks,
  KnowledgeRefusal,
  Published,
  SearchHit,
} from "@composable-os/pack-knowledge/client";
import {
  bySection,
  confirmLabel,
  dayWords,
  knowledgeRefusal,
  myStanding,
  sectionOf,
  segmentsText,
  titleOf,
  versionLine,
} from "@composable-os/pack-knowledge/client";
import { type ComponentRef, useEffect, useRef, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { RichTextView } from "../content-native-rich-text/rich-text-view.tsx";
import { Button } from "../native-base/button.tsx";
import { Field } from "../native-base/field.tsx";
import { Text } from "../native-base/text.tsx";
import { theme } from "../native-base/theme.ts";

export type NativeReaderHooks = Pick<KnowledgeHooks, "useProcedure" | "useToRead" | "useConfirm">;
export type NativeProceduresHooks = NativeReaderHooks &
  Pick<KnowledgeHooks, "useProcedures" | "useSearchProcedures">;

type MediaUrl = (id: string, width: number) => string;

/** A value that follows `value` once it has stopped changing for `ms`. */
function useSettled<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** A picture in the procedure, or a line in its place when the host does not serve it. */
function Picture({
  media,
  alt,
  mediaUrl,
  width,
  served,
}: {
  media: string;
  alt: string;
  mediaUrl: MediaUrl;
  width: number;
  /** False when the host said it will not serve this reader its pictures: none is asked for. */
  served: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (failed || !served) {
    return (
      <View testID="rt-block-image" style={styles.missing}>
        <Text tone="muted">This picture cannot be shown here{alt ? `: ${alt}` : ""}.</Text>
      </View>
    );
  }
  return (
    <View testID="rt-block-image">
      <Image
        source={{ uri: mediaUrl(media, width) }}
        accessibilityLabel={alt}
        style={styles.picture}
        resizeMode="cover"
        onError={() => setFailed(true)}
      />
    </View>
  );
}

function ConfirmPanel({
  knowledge,
  procedure,
  title,
  onReload,
  locale,
}: {
  knowledge: Pick<NativeReaderHooks, "useToRead" | "useConfirm">;
  procedure: Published & { version: number };
  title: string;
  onReload: () => void;
  locale?: string;
}) {
  const mine = knowledge.useToRead();
  const confirm = knowledge.useConfirm();
  const [done, setDone] = useState<{ version: number; confirmedAt: string } | null>(null);
  const [refusal, setRefusal] = useState<KnowledgeRefusal | null>(null);
  const shown = `${procedure.id}:${procedure.version}`;
  const [said, setSaid] = useState(shown);
  if (said !== shown) {
    setSaid(shown);
    setDone(null);
    setRefusal(null);
  }

  async function onConfirm() {
    setRefusal(null);
    try {
      // The version on screen: the one this person was shown.
      const out = await confirm.mutateAsync({ id: procedure.id, version: procedure.version });
      setDone({ version: out.version, confirmedAt: out.confirmedAt });
    } catch (error) {
      setRefusal(knowledgeRefusal(error));
    }
    await mine.refetch?.();
  }

  if (done) {
    return (
      <View style={styles.panel} testID="confirmed">
        <Text accessibilityRole="text">
          Confirmed: you have read and understood version {done.version}, on{" "}
          {dayWords(done.confirmedAt, locale)}.
        </Text>
      </View>
    );
  }
  if (mine.isPending) return <Text tone="muted">Checking whether this is yours to confirm…</Text>;
  if (mine.error) {
    return (
      <Text tone="danger" accessibilityRole="alert">
        {knowledgeRefusal(mine.error).message}
      </Text>
    );
  }
  const standing = myStanding(mine.data, procedure.id, procedure.version);
  return (
    <View style={styles.panel} testID={`standing-${standing.kind}`}>
      {standing.kind === "to_read" ? (
        <>
          <Text>
            You are asked to confirm that you have read and understood this procedure (to read since{" "}
            {dayWords(standing.since, locale)}).
          </Text>
          <Button
            label={confirmLabel(title, procedure.version)}
            busy={confirm.isPending}
            onPress={onConfirm}
          />
        </>
      ) : null}
      {standing.kind === "newer" ? (
        <>
          <Text>
            Version {standing.version} has been published since you opened this one. Read it before
            you confirm.
          </Text>
          <Button label={`Read version ${standing.version}`} quiet onPress={onReload} />
        </>
      ) : null}
      {standing.kind === "confirmed" ? (
        <Text>
          You confirmed this procedure on {dayWords(standing.confirmedAt, locale)}: it counts for
          version {standing.version}.
        </Text>
      ) : null}
      {standing.kind === "not_asked" ? (
        <Text tone="muted">You are not asked to confirm this procedure.</Text>
      ) : null}
      {refusal ? (
        <View style={styles.gap}>
          <Text tone="danger" accessibilityRole="alert">
            {refusal.message}
          </Text>
          {refusal.kind === "not_current" ? (
            <Button label="Read the new version" quiet onPress={onReload} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * One procedure as published, with Confirm at its end when it is the reader's to confirm. `anchor`
 * opens it at a section (a search result's).
 */
export function ProcedureScreen({
  knowledge,
  id,
  anchor,
  onBack,
  openUrl,
  mediaUrl,
  width = 750,
  locale,
}: {
  knowledge: NativeReaderHooks;
  id: string;
  anchor?: string;
  onBack?: () => void;
  /** Opens an address: a link's, a button's, a video's (React Native's `Linking.openURL`). */
  openUrl: (url: string) => void;
  /** Absolute: the host's `/api/v1/media/<id>?w=<width>` (`hostMediaUrl(hostUrl)`). */
  mediaUrl: MediaUrl;
  /** The screen's width in device pixels, for the pictures. */
  width?: number;
  locale?: string;
}) {
  const answer = knowledge.useProcedure({ id });
  const scroll = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const bodyY = useRef(0);
  const data = answer.data;
  if (answer.isPending) return <Text tone="muted">Loading the procedure…</Text>;
  if (answer.error || !data || data.version === undefined) {
    const refusal = knowledgeRefusal(answer.error);
    return (
      <View style={styles.page}>
        {onBack ? <Button label="All procedures" quiet onPress={onBack} /> : null}
        <Text tone="danger" accessibilityRole="alert">
          {refusal.kind === "not_found" || !answer.error
            ? "This procedure is not published, or it has been unpublished."
            : refusal.message}
        </Text>
      </View>
    );
  }
  const title = titleOf(data);
  const section = sectionOf(data);
  const summary = typeof data.values.summary === "string" ? data.values.summary : null;
  const version = data.version;
  return (
    <ScrollView ref={scroll} contentContainerStyle={styles.page} testID={`procedure-${data.id}`}>
      {onBack ? <Button label="All procedures" quiet onPress={onBack} /> : null}
      <View style={styles.header}>
        {section ? <Text tone="muted">{section}</Text> : null}
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
        <Text tone="muted">{versionLine(version, data.publishedAt, locale)}</Text>
        {summary ? <Text>{summary}</Text> : null}
      </View>
      <View
        onLayout={(e: { nativeEvent: { layout: { y: number } } }) => {
          bodyY.current = e.nativeEvent.layout.y;
        }}
      >
        <RichTextView
          value={data.values.body as RichTextValue | null}
          openUrl={openUrl}
          mediaUrl={mediaUrl}
          width={width}
          components={{
            image: ({ block }) => (
              <Picture
                media={block.media}
                alt={block.alt}
                mediaUrl={mediaUrl}
                width={width}
                served={data.pictures !== false}
              />
            ),
          }}
          onAnchorLayout={(at, y) => {
            if (at === anchor) scroll.current?.scrollTo({ y: bodyY.current + y, animated: false });
          }}
        />
      </View>
      <ConfirmPanel
        knowledge={knowledge}
        procedure={{ ...data, version }}
        title={title}
        locale={locale ?? "en-AU"}
        onReload={() => void answer.refetch?.()}
      />
    </ScrollView>
  );
}

function Hit({ hit, onOpen }: { hit: SearchHit; onOpen: (hit: SearchHit) => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={() => onOpen(hit)} style={styles.row}>
      <Text style={styles.rowTitle}>{hit.title ?? "Untitled"}</Text>
      {hit.section.heading ? (
        <Text tone="muted">{segmentsText(hit.section.headingHighlight)}</Text>
      ) : null}
      {hit.snippet ? <Text>{segmentsText(hit.snippet)}</Text> : null}
    </Pressable>
  );
}

function SearchResults({
  knowledge,
  q,
  onOpen,
}: {
  knowledge: Pick<NativeProceduresHooks, "useSearchProcedures">;
  q: string;
  onOpen: (hit: SearchHit) => void;
}) {
  const found = knowledge.useSearchProcedures(q);
  if (found.isPending) return <Text tone="muted">Searching…</Text>;
  if (found.error) {
    return (
      <Text tone="danger" accessibilityRole="alert">
        {knowledgeRefusal(found.error).message}
      </Text>
    );
  }
  if (!found.data?.items.length) return <Text>No published procedure matches "{q}".</Text>;
  return (
    <View style={styles.list}>
      {found.data.items.map((hit) => (
        <Hit key={`${hit.id}:${hit.section.anchor ?? ""}`} hit={hit} onOpen={onOpen} />
      ))}
    </View>
  );
}

function ProcedureList({
  knowledge,
  onOpen,
  locale,
}: {
  knowledge: Pick<NativeProceduresHooks, "useProcedures" | "useToRead">;
  onOpen: (id: string) => void;
  locale?: string;
}) {
  const list = knowledge.useProcedures({ sort: { field: "title", direction: "asc" }, limit: 100 });
  const mine = knowledge.useToRead();
  if (list.isPending) return <Text tone="muted">Loading the procedures…</Text>;
  if (list.error) {
    return (
      <Text tone="danger" accessibilityRole="alert">
        {knowledgeRefusal(list.error).message}
      </Text>
    );
  }
  const items = list.data?.items ?? [];
  if (!items.length) return <Text>No procedure has been published yet.</Text>;
  const groups = bySection(items);
  const due = new Set((mine.data?.toRead ?? []).map((r) => r.id));
  return (
    <View style={styles.gapLg}>
      {groups.map((group) => (
        <View key={group.name ?? "none"} style={styles.gap}>
          {group.name ? (
            <Text style={styles.groupTitle} accessibilityRole="header">
              {group.name}
            </Text>
          ) : null}
          <View style={styles.list}>
            {group.items.map((p) => (
              <Pressable
                key={p.id}
                accessibilityRole="button"
                accessibilityLabel={`Open ${titleOf(p)}${due.has(p.id) ? ", to read" : ""}`}
                onPress={() => onOpen(p.id)}
                style={styles.row}
              >
                <Text style={styles.rowTitle}>
                  {titleOf(p)}
                  {due.has(p.id) ? " · To read" : ""}
                </Text>
                {p.version !== undefined ? (
                  <Text tone="muted">{versionLine(p.version, p.publishedAt, locale)}</Text>
                ) : null}
              </Pressable>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

/** Every published procedure, by section, with search; one opens in the reader. */
export function ProceduresScreen({
  knowledge,
  openUrl,
  mediaUrl,
  width,
  locale,
}: {
  knowledge: NativeProceduresHooks;
  openUrl: (url: string) => void;
  mediaUrl: MediaUrl;
  width?: number;
  locale?: string;
}) {
  const [open, setOpen] = useState<{ id: string; anchor?: string } | null>(null);
  const [q, setQ] = useState("");
  const settled = useSettled(q.trim());
  if (open) {
    return (
      <ProcedureScreen
        knowledge={knowledge}
        id={open.id}
        onBack={() => setOpen(null)}
        openUrl={openUrl}
        mediaUrl={mediaUrl}
        {...(open.anchor ? { anchor: open.anchor } : {})}
        {...(width ? { width } : {})}
        {...(locale ? { locale } : {})}
      />
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Text style={styles.title} accessibilityRole="header">
        Procedures
      </Text>
      <Field
        label="Search procedures"
        value={q}
        onChangeText={setQ}
        placeholder="Words in a procedure"
        autoCorrect={false}
        maxLength={200}
      />
      {settled ? (
        <SearchResults
          knowledge={knowledge}
          q={settled}
          onOpen={(hit) =>
            setOpen({ id: hit.id, ...(hit.section.anchor ? { anchor: hit.section.anchor } : {}) })
          }
        />
      ) : (
        <ProcedureList
          knowledge={knowledge}
          onOpen={(id) => setOpen({ id })}
          {...(locale ? { locale } : {})}
        />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: theme.space.md, gap: theme.space.md },
  header: { gap: theme.space.xs },
  title: { fontSize: theme.font.title, fontWeight: "700", color: theme.color.text },
  groupTitle: { fontSize: theme.font.body, fontWeight: "700", color: theme.color.text },
  panel: {
    gap: theme.space.sm,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius,
    padding: theme.space.md,
  },
  gap: { gap: theme.space.sm },
  gapLg: { gap: theme.space.lg },
  list: { borderRadius: theme.radius, backgroundColor: theme.color.surface, overflow: "hidden" },
  row: {
    paddingVertical: theme.space.sm + 4,
    paddingHorizontal: theme.space.md,
    gap: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.border,
  },
  rowTitle: { fontSize: theme.font.body, fontWeight: "600", color: theme.color.text },
  picture: { width: "100%", aspectRatio: 16 / 9, borderRadius: theme.radius },
  missing: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.color.border,
    borderRadius: theme.radius,
    padding: theme.space.md,
  },
});
