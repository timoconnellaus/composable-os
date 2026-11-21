// Rich text for the mobile app (stage 28, ADR 0440): a post's body drawn block by block with React
// Native's own components, from the same structured data the web block draws. Every block type and
// mark has its element here; its look is the native base layer's theme. Pass `components` to use
// the app's own for a block type, and `openUrl` (React Native's `Linking.openURL`, or the app's
// in-app browser) for links, buttons and videos.
//
// No web view: an embed is a tappable card that opens the video (or the link) outside the app.
import {
  type Block,
  embedKind,
  type Inline,
  type ListBody,
  mediaPath,
  type RichText as RichTextValue,
} from "@composable-os/pack-content/client";
import type { ReactNode } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "../native-base/theme.ts";

export type NativeBlockRenderer<T extends Block["type"]> = (props: {
  block: Extract<Block, { type: T }>;
}) => ReactNode;

export interface RichTextViewProps {
  value: RichTextValue | null | undefined;
  /** Opens an address: a link, a button's, a video's. */
  openUrl: (url: string) => void;
  /**
   * Where a picture is served, absolute: the app's host and the media route
   * (`https://<host>/api/media/<id>?w=<width>`).
   */
  mediaUrl: (id: string, width: number) => string;
  /** The width the pictures are shown at, in device pixels (the screen's). */
  width?: number;
  components?: { [T in Block["type"]]?: NativeBlockRenderer<T> };
}

function Runs({
  content,
  openUrl,
  style,
}: {
  content: readonly Inline[] | undefined;
  openUrl: (url: string) => void;
  style?: object;
}) {
  return (
    <Text style={[styles.body, style]}>
      {(content ?? []).map((run, i) => {
        if (run.type === "break") {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional.
            <Text key={i} testID="rt-mark-break">
              {"\n"}
            </Text>
          );
        }
        const marks = [
          run.bold ? styles.bold : null,
          run.italic ? styles.italic : null,
          run.code ? styles.code : null,
          run.href ? styles.link : null,
        ];
        const ids = [
          run.bold ? "bold" : "",
          run.italic ? "italic" : "",
          run.code ? "code" : "",
          run.href ? "link" : "",
        ].filter(Boolean);
        const href = run.href;
        return (
          <Text
            // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional.
            key={i}
            style={marks}
            {...(ids.length ? { testID: `rt-mark-${ids.join("-")}` } : {})}
            {...(href ? { onPress: () => openUrl(href), accessibilityRole: "link" as const } : {})}
          >
            {run.text}
          </Text>
        );
      })}
    </Text>
  );
}

function ListView({
  body,
  openUrl,
  depth,
}: {
  body: ListBody;
  openUrl: (url: string) => void;
  depth: number;
}) {
  return (
    <View testID={`rt-block-list-${body.style}`} style={{ paddingLeft: depth * theme.space.md }}>
      {body.items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: list items are positional.
        <View key={i}>
          <View style={styles.listRow}>
            <Text style={styles.body}>{body.style === "ordered" ? `${i + 1}.` : "•"}</Text>
            <Runs content={item.content} openUrl={openUrl} style={styles.listText} />
          </View>
          {item.list ? <ListView body={item.list} openUrl={openUrl} depth={depth + 1} /> : null}
        </View>
      ))}
    </View>
  );
}

const TONE_COLOR = {
  info: "#0ea5e9",
  note: theme.color.muted,
  success: "#10b981",
  warning: "#f59e0b",
} as const;

function DefaultBlock({
  block,
  openUrl,
  mediaUrl,
  width,
}: {
  block: Block;
  openUrl: (url: string) => void;
  mediaUrl: (id: string, width: number) => string;
  width: number;
}): ReactNode {
  switch (block.type) {
    case "paragraph":
      return (
        <View testID="rt-block-paragraph">
          <Runs content={block.content} openUrl={openUrl} />
        </View>
      );
    case "heading":
      return (
        <View testID="rt-block-heading" accessibilityRole="header">
          <Runs
            content={block.content}
            openUrl={openUrl}
            style={{
              fontSize: Math.max(theme.font.title - (block.level - 1) * 2, theme.font.body),
              fontWeight: "700",
            }}
          />
        </View>
      );
    case "list":
      return <ListView body={block} openUrl={openUrl} depth={0} />;
    case "quote":
      return (
        <View testID="rt-block-quote" style={styles.quote}>
          <Runs content={block.content} openUrl={openUrl} style={styles.italic} />
          {block.attribution ? <Text style={styles.muted}>{block.attribution}</Text> : null}
        </View>
      );
    case "image":
      return (
        <View testID="rt-block-image">
          <Image
            source={{ uri: mediaUrl(block.media, width) }}
            accessibilityLabel={block.alt}
            style={styles.picture}
            resizeMode="cover"
          />
          {block.caption?.length ? (
            <Runs content={block.caption} openUrl={openUrl} style={styles.muted} />
          ) : null}
        </View>
      );
    case "divider":
      return <View testID="rt-block-divider" style={styles.divider} />;
    case "embed": {
      const kind = embedKind(block.url);
      return (
        <Pressable
          testID={`rt-block-embed-${kind.kind}`}
          accessibilityRole="link"
          onPress={() => openUrl(block.url)}
          style={styles.embed}
        >
          <Text style={styles.bold}>
            {kind.kind === "link"
              ? "Open link"
              : `Play the ${kind.kind === "youtube" ? "YouTube" : "Vimeo"} video`}
          </Text>
          {block.caption ? <Text style={styles.muted}>{block.caption}</Text> : null}
        </Pressable>
      );
    }
    case "callout":
      return (
        <View
          testID={`rt-block-callout-${block.tone}`}
          style={[styles.callout, { borderLeftColor: TONE_COLOR[block.tone] }]}
        >
          <Runs content={block.content} openUrl={openUrl} />
        </View>
      );
    case "button":
      return (
        <Pressable
          testID="rt-block-button"
          accessibilityRole="button"
          onPress={() => openUrl(block.href)}
          style={styles.button}
        >
          <Text style={styles.buttonText}>{block.label}</Text>
        </Pressable>
      );
  }
}

/** A rich text document. An empty or missing one draws nothing. */
export function RichTextView({
  value,
  openUrl,
  mediaUrl = (id, w) => mediaPath(id, w),
  width = 960,
  components = {},
}: RichTextViewProps) {
  const blocks = value?.blocks ?? [];
  if (!blocks.length) return null;
  return (
    <View style={styles.document} testID="rt-document">
      {blocks.map((block, i) => {
        const custom = components[block.type] as NativeBlockRenderer<typeof block.type> | undefined;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional in a document.
          <View key={i}>
            {custom ? (
              custom({ block } as never)
            ) : (
              <DefaultBlock block={block} openUrl={openUrl} mediaUrl={mediaUrl} width={width} />
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  document: { gap: theme.space.md },
  body: { fontSize: theme.font.body, color: theme.color.text, lineHeight: theme.font.body * 1.5 },
  bold: { fontWeight: "700" },
  italic: { fontStyle: "italic" },
  code: { fontFamily: "Courier", backgroundColor: theme.color.surface },
  link: { textDecorationLine: "underline", color: theme.color.primary },
  muted: { color: theme.color.muted, fontSize: theme.font.small },
  listRow: { flexDirection: "row", gap: theme.space.sm },
  listText: { flex: 1 },
  quote: {
    borderLeftWidth: 4,
    borderLeftColor: theme.color.border,
    paddingLeft: theme.space.md,
    gap: theme.space.xs,
  },
  picture: { width: "100%", aspectRatio: 16 / 9, borderRadius: theme.radius },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: theme.color.border },
  embed: {
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius,
    padding: theme.space.md,
    gap: theme.space.xs,
  },
  callout: {
    borderLeftWidth: 4,
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius,
    padding: theme.space.md,
  },
  button: {
    backgroundColor: theme.color.primary,
    borderRadius: theme.radius,
    paddingVertical: theme.space.sm,
    paddingHorizontal: theme.space.md,
    alignSelf: "flex-start",
  },
  buttonText: { color: theme.color.onPrimary, fontSize: theme.font.body, fontWeight: "600" },
});
