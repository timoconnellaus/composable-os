// The help centre in the app (stage 38 step 6, ADR 0708), for members: the same as the web's,
// over the native base. A search box with results as the member types, the help topics with
// their pages, and one page with its related pages. Help pages are public in their published
// wording only (ADR 0442); search is the host's `content.search` over published help pages
// (ADR 0700), never a procedure or a draft. The page's words are drawn by the Content pack's
// native renderer (`content-native-rich-text`).

import type { RichText as RichTextValue } from "@composable-os/pack-content/client";
import type {
  HelpTopic,
  KnowledgeHooks,
  Published,
  SearchHit,
} from "@composable-os/pack-knowledge/client";
import { segmentsText, slugOf, titleOf } from "@composable-os/pack-knowledge/client";
import { type ComponentRef, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { RichTextView } from "../content-native-rich-text/rich-text-view.tsx";
import { Field } from "../native-base/field.tsx";
import { Text } from "../native-base/text.tsx";
import { theme } from "../native-base/theme.ts";

export type NativeHelpHooks = Pick<
  KnowledgeHooks,
  "useHelpTopics" | "useHelpPages" | "useSearchHelp" | "useHelpPage"
>;

/** Where a page is opened: its address, and the section to scroll to (a search result's). */
export type OpenHelpPage = (slug: string, anchor?: string) => void;

/** A value that follows `value` once it has stopped changing for `ms`. */
function useSettled<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

function PageRow({ page, onOpen }: { page: Published; onOpen: OpenHelpPage }) {
  const slug = slugOf(page);
  if (!slug) return null;
  return (
    <Pressable accessibilityRole="button" onPress={() => onOpen(slug)} style={styles.row}>
      <Text style={styles.rowTitle}>{titleOf(page)}</Text>
      {typeof page.values.summary === "string" && page.values.summary ? (
        <Text tone="muted">{page.values.summary}</Text>
      ) : null}
    </Pressable>
  );
}

function TopicPages({
  knowledge,
  topic,
  onOpen,
}: {
  knowledge: Pick<NativeHelpHooks, "useHelpPages">;
  topic: HelpTopic;
  onOpen: OpenHelpPage;
}) {
  const pages = knowledge.useHelpPages({
    filter: { field: "topic", op: "eq", value: topic.id },
    sort: { field: "order", direction: "asc" },
    limit: 100,
  });
  return (
    <View style={styles.gap}>
      <Text style={styles.groupTitle} accessibilityRole="header">
        {topic.name ?? "Untitled topic"}
      </Text>
      {pages.isPending ? <Text tone="muted">Loading…</Text> : null}
      {pages.error ? (
        <Text tone="danger" accessibilityRole="alert">
          We could not load these pages. Try again soon.
        </Text>
      ) : null}
      {pages.data && !pages.data.items.length ? <Text tone="muted">No pages here yet.</Text> : null}
      {pages.data?.items.length ? (
        <View style={styles.list}>
          {pages.data.items.map((page) => (
            <PageRow key={page.id} page={page} onOpen={onOpen} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Results({
  knowledge,
  q,
  onOpen,
}: {
  knowledge: Pick<NativeHelpHooks, "useSearchHelp">;
  q: string;
  onOpen: OpenHelpPage;
}) {
  const found = knowledge.useSearchHelp(q);
  if (found.isPending) return <Text tone="muted">Searching…</Text>;
  if (found.error) {
    return (
      <Text tone="danger" accessibilityRole="alert">
        We could not search just now. Try again in a moment.
      </Text>
    );
  }
  if (!found.data?.items.length) {
    return <Text>Nothing matches "{q}". Try other words, or browse the topics.</Text>;
  }
  return (
    <View style={styles.list}>
      {found.data.items.map((hit: SearchHit) => (
        <Pressable
          key={`${hit.id}:${hit.section.anchor ?? ""}`}
          accessibilityRole="button"
          onPress={() => onOpen(hit.slug, hit.section.anchor ?? undefined)}
          style={styles.row}
        >
          <Text style={styles.rowTitle}>{hit.title ?? "Untitled"}</Text>
          {hit.section.heading ? (
            <Text tone="muted">{segmentsText(hit.section.headingHighlight)}</Text>
          ) : null}
          {hit.snippet ? <Text>{segmentsText(hit.snippet)}</Text> : null}
        </Pressable>
      ))}
    </View>
  );
}

/** The help centre's home: search, then every topic with its pages. */
export function HelpCentreScreen({
  knowledge,
  onOpenPage,
  title = "Help",
}: {
  knowledge: Pick<NativeHelpHooks, "useHelpTopics" | "useHelpPages" | "useSearchHelp">;
  /** Opens a help page (the app's navigation to `HelpPageScreen`), at a section when given. */
  onOpenPage: OpenHelpPage;
  title?: string;
}) {
  const topics = knowledge.useHelpTopics();
  const [q, setQ] = useState("");
  const settled = useSettled(q.trim());
  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      <Field
        label="Search help"
        value={q}
        onChangeText={setQ}
        placeholder="How do I…"
        autoCorrect={false}
        maxLength={200}
      />
      {settled ? (
        <Results knowledge={knowledge} q={settled} onOpen={onOpenPage} />
      ) : (
        <View style={styles.gapLg}>
          {topics.isPending ? <Text tone="muted">Loading the topics…</Text> : null}
          {topics.error ? (
            <Text tone="danger" accessibilityRole="alert">
              We could not load the help topics. Try again in a moment.
            </Text>
          ) : null}
          {topics.data && !topics.data.topics.length ? (
            <Text>There is no help here yet.</Text>
          ) : null}
          {topics.data?.topics.map((topic) => (
            <TopicPages key={topic.id} knowledge={knowledge} topic={topic} onOpen={onOpenPage} />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function Related({
  knowledge,
  ids,
  onOpen,
}: {
  knowledge: Pick<NativeHelpHooks, "useHelpPages">;
  ids: string[];
  onOpen: OpenHelpPage;
}) {
  const pages = knowledge.useHelpPages({
    filter: { field: "id", op: "in", value: ids },
    sort: { field: "order", direction: "asc" },
    limit: 20,
  });
  const items = pages.data?.items ?? [];
  if (!items.length) return null;
  return (
    <View style={styles.gap}>
      <Text style={styles.groupTitle} accessibilityRole="header">
        Related
      </Text>
      <View style={styles.list}>
        {items.map((page) => (
          <PageRow key={page.id} page={page} onOpen={onOpen} />
        ))}
      </View>
    </View>
  );
}

/** One help page as published, with its related pages; an old address goes to its address now. */
export function HelpPageScreen({
  knowledge,
  slug,
  anchor,
  onOpenPage,
  onRedirect,
  openUrl,
  mediaUrl,
  width,
}: {
  knowledge: Pick<NativeHelpHooks, "useHelpPage" | "useHelpPages">;
  slug: string;
  /** The section to open at (a search result's). */
  anchor?: string;
  onOpenPage: OpenHelpPage;
  onRedirect: (slug: string) => void;
  openUrl: (url: string) => void;
  /** Absolute: the host's `/api/v1/media/<id>?w=<width>` (`hostMediaUrl(hostUrl)`). */
  mediaUrl: (id: string, width: number) => string;
  width?: number;
}) {
  const { data, isPending, error } = knowledge.useHelpPage(slug);
  const scroll = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const bodyY = useRef(0);
  if (isPending) return <Text tone="muted">Loading…</Text>;
  if (error || !data) {
    return (
      <Text tone="danger" accessibilityRole="alert">
        This help page is not here. It may have moved or been taken down.
      </Text>
    );
  }
  if (data.kind === "redirect") {
    onRedirect(data.slug);
    return <Text tone="muted">This help page has moved.</Text>;
  }
  const related = Array.isArray(data.values.related)
    ? data.values.related.filter((id): id is string => typeof id === "string").slice(0, 20)
    : [];
  const summary = typeof data.values.summary === "string" ? data.values.summary : null;
  return (
    <ScrollView ref={scroll} contentContainerStyle={styles.page} testID={`help-page-${data.id}`}>
      <View style={styles.header}>
        <Text style={styles.title} accessibilityRole="header">
          {titleOf(data)}
        </Text>
        {summary ? <Text tone="muted">{summary}</Text> : null}
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
          {...(width ? { width } : {})}
          onAnchorLayout={(at, y) => {
            if (at === anchor) scroll.current?.scrollTo({ y: bodyY.current + y, animated: false });
          }}
        />
      </View>
      {related.length ? <Related knowledge={knowledge} ids={related} onOpen={onOpenPage} /> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: theme.space.md, gap: theme.space.md },
  header: { gap: theme.space.xs },
  title: { fontSize: theme.font.title, fontWeight: "700", color: theme.color.text },
  groupTitle: { fontSize: theme.font.body, fontWeight: "700", color: theme.color.text },
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
});
